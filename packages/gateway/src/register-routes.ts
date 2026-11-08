/**
 * Write-gate registration routes (design B2–B7, P1).
 *
 *   GET  /register/challenge?pubkey=  → {nonce, exp}   (HMAC, 10 min, 5/hour/IP)
 *   POST /register                    → kind 1055 claim + proof of replication
 *   GET  /register/status?pubkey=     → operator state (for their CLI)
 *   GET  /register/operators          → public list of operators (audit)
 *   POST /register/approve            → NIP-98 (owner): pending → active (F4AI-23)
 *   POST /register/revoke             → NIP-98 (owner): → revoked + 1040 LABEL
 *   GET  /register/pending            → NIP-98 (owner): all operators + agents (F4AI-24)
 *   GET  /register/owner              → public: {owner: hex|null} (F4AI-24)
 *   GET  /write-status?pubkey=        → {allowed, code, reason} for UI/MCP (B10)
 *
 * Caddy matches `handle_path /api/*` and strips `/api`, which is why the routes
 * live on root paths (like `/events`, `/topics`, `/me`).
 *
 * Important rules:
 *  - a foreign error text is NOT shown to the client (codes → Slovak sentences),
 *  - `pending` is the default (`GATEWAY_REGISTER_MODE=approve`) — the owner
 *    approves with `operator approve`,
 *  - the writers list is the owner-signed 30028; the SQLite table is a cache,
 *    hence `syncWriters()` (rebuild from the relay) and `republishWriters()`
 *    (change => republish, so other instances see the same policy).
 */
import { getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { validateEventStructure, verifyFull, KINDS } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import { SlidingWindowRateLimiter, clientRateLimitKey, type Cidr } from './rate-limit.js';
import { connectOneShotRelay, type PublishResult, type RelayStatus } from './relay-pool.js';
import { ownerAuthBody, verifyOwnerAuthorization } from './owner-auth.js';

// `nip98UrlCandidates` presídlilo do `owner-auth.ts` (F4AI-24, Phase 1b —
// potrebuje ho aj `GET /register/pending`). Re-export drží verejné API
// `register-routes.ts` nezmenené (testy a `operator-cli` ho importujú odtiaľ).
export { nip98UrlCandidates } from './owner-auth.js';
import {
  approveOperator,
  revokeOperator,
  normalizeOperatorPubkey,
  type OperatorActionDeps,
  type OperatorActionResult,
} from './operator-actions.js';
import {
  CHALLENGE_TTL_S,
  PROBE_MAX_IN_FLIGHT,
  PROBE_TIMEOUT_MS,
  ProbeBudget,
  REPLICATION_SAMPLE_SIZE,
  UsedNonces,
  createChallenge,
  defaultResolver,
  fetchNip11Info,
  probeOperatorRelay,
  sampleIds,
  verifyChallenge,
  type ProbeDeps,
  type ProbeReason,
  type Resolver,
} from './registration.js';
import {
  REGISTRATION_TTL_S,
  WRITERS_D_TAG,
  AGENTS_D_TAG,
  buildWritersContent,
  buildWritersTags,
  isWritersEvent,
  parseAgentsEvent,
  parseWritersEvent,
} from './writers.js';
import type { OperatorRow, OperatorsDb } from './operators-db.js';
import type { WriteGate } from './write-gate.js';
import { signWithPow } from './pow.js';

/** pool potrebný registráciou (publish + query + status) */
export interface RegisterPool {
  publish(event: Event, relays?: string[]): Promise<PublishResult[]>;
  query(filters: Filter[], opts?: { timeoutMs?: number }): Promise<Event[]>;
  status(): RelayStatus[];
}

/** max veľkosť tela claimu — claim je malý event, 16 KB je štedrá poistka */
export const MAX_CLAIM_BODY_BYTES = 16 * 1024;
/** max veľkosť tela owner akcie (`{pubkey, note?}`) — stačí 4 KB */
export const MAX_OWNER_BODY_BYTES = 4 * 1024;
/** max dĺžka poznámky pri revoku (rovnaká ako v 1040 LABEL) */
export const REVOKE_NOTE_MAX_CHARS = 120;
/** challenge limit: 5 za hodinu na IP (dizajn B2) */
export const CHALLENGE_RATE_MAX_DEFAULT = 5;
export const CHALLENGE_RATE_WINDOW_MS = 60 * 60 * 1000;
/** okno samplingu replikácie: posledných 7 dní (dizajn B4) */
export const REPLICATION_WINDOW_S = 7 * 24 * 60 * 60;

/** probe codes → English sentences for the client (no foreign detail) */
export const PROBE_MESSAGES: Record<ProbeReason, string> = {
  busy: 'registration verification is busy right now — please try again in a moment',
  unsafe_url:
    'the relay must be wss:// on port 443 and its DNS must resolve to a public IP (internal addresses are not accepted)',
  unreachable: 'the relay is unreachable — the WSS connection could not be established',
  nip11_unreachable:
    'the relay does not serve a NIP-11 information document (GET / with the Accept: application/nostr+json header)',
  nip11_no_pubkey: 'the NIP-11 document has no `pubkey` field — set it to the operator key',
  nip11_pubkey_mismatch:
    'the `pubkey` field in NIP-11 does not match the claim pubkey — the relay must belong to this operator',
  claim_not_served:
    'your claim event (kind 1055) is not available on the relay — publish it to your own relay first',
  replication_insufficient:
    'the relay does not replicate the forum: random ids from the last week are not available with a valid signature',
  timeout: 'replication verification timed out — please try again',
};

function probeStatus(reason: ProbeReason): 422 | 429 | 504 {
  if (reason === 'busy') return 429;
  if (reason === 'timeout') return 504;
  return 422;
}

function tagValue(tags: readonly (readonly string[])[], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === 'string' && tag[1] !== '') return tag[1];
  }
  return undefined;
}

/**
 * nostr-tools `Event` a shared `NostrEvent` sú štrukturálne takmer totožné
 * (líšia sa len tuple typom `tags`) — ten istý kánonický záznam, iný
 * typový zápis. Cast (nie konverzia dát), rovnaký vzor ako `read-routes.ts`.
 */
function asSharedEvent(event: Event): NostrEvent {
  return event as unknown as NostrEvent;
}

/**
 * `OperatorRow` → JSON záznam operátora pre HTTP. Mená sú snake_case a
 * ZHODNÉ s `GET /register/status` (`expires_at`, `last_check`, …), aby UI
 * nepotrebovalo dva rôzne typy na ten istý záznam.
 */
export function serializeOperator(row: OperatorRow | null): Record<string, unknown> | null {
  if (row === null) return null;
  return {
    pubkey: row.pubkey,
    relay: row.relay,
    status: row.status,
    registered_at: row.registeredAt,
    expires_at: row.expiresAt,
    last_check: row.lastCheck,
    fail_count: row.failCount,
    claim_id: row.claimId,
    note: row.note,
    agents: row.agents,
  };
}

export interface RegisterRoutesOptions {
  db: OperatorsDb;
  pool: RegisterPool;
  writeGate: WriteGate;
  regSecret: string;
  registerMode: 'approve' | 'auto';
  /** 64-hex skala vlastníka inštancie (author 30028); prázdna = bez republishu */
  ownerSkHex: string;
  /** NIP-13 obtiažnosť pre eventy, ktoré produkuje gateway (VPS: 18) */
  publishPowMin?: number;
  trustProxyHeader?: boolean;
  trustedProxies?: readonly Cidr[];
  logger?: (line: string) => void;
  now?: () => number;
  /** injectable dependencies pre probe (testy bez siete) */
  probeDeps?: Pick<ProbeDeps, 'connect' | 'fetchInfo' | 'resolve' | 'timeoutMs'>;
  /** doménové meno tejto inštancie (porovnáva sa s `["gateway", …]` tagom) */
  instanceHost?: string;
  challengeRateMax?: number;
}

export interface RegisterRoutes {
  app: Hono;
  /** republish 30028 `d=forum4ai-writers` z aktuálneho stavu tabuľky */
  republishWriters(): Promise<{ ok: boolean; reason?: string; event?: Event }>;
  /** rebuild tabuľky z owner-signed 30028 na relayoch */
  syncWriters(): Promise<{ ok: boolean; applied: number; reason?: string }>;
  /** obnova agentov z 30028 `d=agents` aktívnych operátorov */
  syncAgents(): Promise<{ operators: number; agents: number }>;
  /** náhodná vzorka id za posledných 7 dní (dôkaz replikácie) */
  recentSampleIds(count: number): Promise<string[]>;
  /**
   * B7: týždenné preverenie replikácie pre operátorov, ktorých posledná
   * kontrola je staršia ako `RESAMPLE_INTERVAL_S`. 3 zlyhania → `lapsed`
   * (počítadlo drží `OperatorsDb.recordCheck`) a republish 30028.
   */
  resampleDue(): Promise<{ checked: number; lapsed: string[] }>;
  /** údržba v jednom kolečku: sync 30028 → sync agentov → re-sampling */
  runMaintenance(): Promise<{
    writers: { ok: boolean; applied: number; reason?: string };
    agents: { operators: number; agents: number };
    resample: { checked: number; lapsed: string[] };
  }>;
  /** id vlastníka (prázdny reťazec bez GATEWAY_OWNER_SK_HEX) */
  ownerPubkey: string;
}

export function createRegisterRoutes(options: RegisterRoutesOptions): RegisterRoutes {
  const log = options.logger ?? (() => undefined);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const publishPowMin = options.publishPowMin ?? 0;
  const trustProxyHeader = options.trustProxyHeader === true;
  const trustedProxies = options.trustedProxies ?? [];
  const usedNonces = new UsedNonces(now);
  const budget = new ProbeBudget(PROBE_MAX_IN_FLIGHT);
  const challengeLimiter = new SlidingWindowRateLimiter({
    maxPerWindow: options.challengeRateMax ?? CHALLENGE_RATE_MAX_DEFAULT,
    windowMs: CHALLENGE_RATE_WINDOW_MS,
  });

  const ownerSk =
    /^[0-9a-f]{64}$/.test(options.ownerSkHex.trim()) ? Uint8Array.from(Buffer.from(options.ownerSkHex.trim(), 'hex')) : null;
  const ownerPubkey = ownerSk === null ? '' : getPublicKey(ownerSk).toLowerCase();

  // ── probe dependencies ───────────────────────────────────────────────────
  // Produkčné defaulty (jeden-shot WSS spojenie s timeoutom, NIP-11 fetch,
  // OS resolver). Testy a integrácia injectnú `probeDeps` — vtedy sa na
  // sieť vôbec nesiahne, čo je jediný spôsob, ako otestovať happy path
  // bez externého relaya.
  const probeTimeoutMs = options.probeDeps?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const probeConnect =
    options.probeDeps?.connect ?? ((url: string) => connectOneShotRelay(url, probeTimeoutMs));
  const probeFetchInfo =
    options.probeDeps?.fetchInfo ?? ((httpsUrl: string) => fetchNip11Info(httpsUrl, probeTimeoutMs));
  const probeResolve: Resolver = options.probeDeps?.resolve ?? defaultResolver;

  const app = new Hono();

  const badRequest = (c: { json: (body: unknown, status?: number) => Response }, reasons: string[]) =>
    c.json({ ok: false, error: 'invalid registration', reasons }, 400);

  // ── GET /register/challenge ───────────────────────────────────────────────
  app.get('/register/challenge', (c) => {
    if (options.regSecret === '') {
      return c.json(
        {
          ok: false,
          error: 'registration disabled',
          reasons: ['registration is not enabled on this instance (GATEWAY_REG_SECRET missing)'],
        },
        503,
      );
    }
    const raw = c.req.query('pubkey') ?? '';
    const pubkey = raw.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      return badRequest(c, ['pubkey must be 64 hex characters (the operator public key)']);
    }
    const ipKey = clientRateLimitKey(c, trustProxyHeader, trustedProxies);
    const decision = challengeLimiter.check(ipKey);
    if (!decision.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((decision.retryAfterMs ?? 1000) / 1000))));
      return c.json(
        {
          ok: false,
          error: 'rate limited',
          reasons: [
            `the challenge can be requested at most ${String(options.challengeRateMax ?? CHALLENGE_RATE_MAX_DEFAULT)} times per hour per IP`,
          ],
        },
        429,
      );
    }
    const challenge = createChallenge(options.regSecret, pubkey, now());
    log(`register challenge ${pubkey.slice(0, 8)}… exp ${String(challenge.exp)}`);
    return c.json({
      ok: true,
      nonce: challenge.nonce,
      exp: challenge.exp,
      ttl_s: CHALLENGE_TTL_S,
      kind: KINDS.OPERATOR_CLAIM,
      gateway: options.instanceHost ?? new URL(c.req.url).host,
    });
  });

  // ── POST /register ────────────────────────────────────────────────────────
  app.post('/register', async (c) => {
    if (options.regSecret === '') {
      return c.json(
        { ok: false, error: 'registration disabled', reasons: ['registration is not enabled (GATEWAY_REG_SECRET missing)'] },
        503,
      );
    }
    const text = await c.req.raw.text();
    if (text.length > MAX_CLAIM_BODY_BYTES) {
      return badRequest(c, [`the claim is too large (max ${String(MAX_CLAIM_BODY_BYTES)} bytes)`]);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return badRequest(c, ['the body is not valid JSON']);
    }
    const event = Array.isArray(parsed) ? parsed[0] : parsed;
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      return badRequest(c, ['expected ONE event (kind 1055), not an array']);
    }
    const claim = event as NostrEvent;

    const structure = validateEventStructure(claim);
    if (!structure.valid) return badRequest(c, structure.errors);
    if (claim.kind !== KINDS.OPERATOR_CLAIM) {
      return badRequest(c, [
        `kind must be ${String(KINDS.OPERATOR_CLAIM)} (OPERATOR_CLAIM), got ${String(claim.kind)}`,
      ]);
    }
    if (!verifyFull(claim)) {
      return badRequest(c, ['the signature is not valid or the id does not match the hash (verifyFull)']);
    }

    const nonce = tagValue(claim.tags, 'challenge');
    const expRaw = tagValue(claim.tags, 'exp');
    const relay = tagValue(claim.tags, 'relay');
    const gateway = tagValue(claim.tags, 'gateway');
    const missing: string[] = [];
    if (nonce === undefined) missing.push('["challenge",<nonce>]');
    if (expRaw === undefined) missing.push('["exp",<exp>]');
    if (relay === undefined) missing.push('["relay","wss://…"]');
    if (gateway === undefined) missing.push('["gateway","<host>"]');
    if (missing.length > 0) {
      return badRequest(c, [`the claim is missing tags: ${missing.join(', ')} (see GET /register/challenge)`]);
    }
    const host = options.instanceHost ?? new URL(c.req.url).host;
    if (gateway !== undefined && gateway.replace(/^https?:\/\//, '').replace(/\/.*$/, '') !== host) {
      return badRequest(c, [`the ["gateway",…] tag does not point at this instance (expected "${host}")`]);
    }
    const exp = Number.parseInt(expRaw ?? '', 10);
    const verdict = verifyChallenge(options.regSecret, claim.pubkey, nonce ?? '', exp, now());
    if (!verdict.ok) {
      log(`register claim ${claim.pubkey.slice(0, 8)}… rejected: challenge ${verdict.reason}`);
      return badRequest(c, ['the challenge is invalid, expired, or does not belong to this pubkey']);
    }
    if (!usedNonces.consume(nonce ?? '', exp)) {
      return badRequest(c, ['the challenge has already been used — request a new nonce']);
    }

    if (!budget.tryAcquire()) {
      return c.json({ ok: false, error: 'busy', reasons: [PROBE_MESSAGES.busy] }, 429);
    }
    let verdictProbe: Awaited<ReturnType<typeof probeOperatorRelay>>;
    try {
      const samples = await recentSampleIds(5);
      verdictProbe = await probeOperatorRelay(relay ?? '', { claimant: claim.pubkey.toLowerCase(), claimId: claim.id }, {
        connect: probeConnect,
        fetchInfo: probeFetchInfo,
        resolve: probeResolve,
        timeoutMs: probeTimeoutMs,
        sampleIds: samples,
      });
    } finally {
      budget.release();
    }
    if (!verdictProbe.ok) {
      log(`register claim ${claim.pubkey.slice(0, 8)}… rejected: probe ${verdictProbe.reason}`);
      return c.json(
        { ok: false, error: 'proof failed', reasons: [PROBE_MESSAGES[verdictProbe.reason]] },
        probeStatus(verdictProbe.reason),
      );
    }

    const status = options.registerMode === 'auto' ? 'active' : 'pending';
    const row = options.db.upsertClaim({
      pubkey: claim.pubkey,
      relay: relay ?? '',
      claimId: claim.id,
      status,
      registeredAt: now(),
      expiresAt: now() + REGISTRATION_TTL_S,
    });
    log(`register claim ${claim.pubkey.slice(0, 8)}… → ${status} (relay ${relay ?? ''})`);
    if (status === 'active') {
      await republishWriters();
    }
    return c.json({
      ok: true,
      status,
      pubkey: claim.pubkey,
      relay: relay ?? '',
      expires_at: row.expiresAt,
      replicated: verdictProbe.replicated,
      next:
        status === 'active'
          ? 'registration is active — you can write'
          : 'wait for the instance owner to approve (`operator approve`)',
    });
  });

  // ── GET /register/status ──────────────────────────────────────────────────
  app.get('/register/status', (c) => {
    const pubkey = (c.req.query('pubkey') ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      return badRequest(c, ['pubkey must be 64 hex characters']);
    }
    const row = options.db.get(pubkey);
    if (row === null) {
      return c.json({ ok: true, status: 'unregistered', pubkey, expires_at: 0, agents: 0 });
    }
    return c.json({
      ok: true,
      status: options.db.operatorStatus(pubkey) ?? row.status,
      pubkey,
      relay: row.relay,
      expires_at: row.expiresAt,
      last_check: row.lastCheck,
      fail_count: row.failCount,
      agents: row.agents.length,
    });
  });

  // ── GET /register/operators (verejný audit) ───────────────────────────────
  app.get('/register/operators', (c) => {
    const rows = options.db.list();
    return c.json({
      ok: true,
      owner: ownerPubkey,
      counts: options.db.countByStatus(),
      operators: rows.map((row) => ({
        pubkey: row.pubkey,
        relay: row.relay,
        status: options.db.operatorStatus(row.pubkey) ?? row.status,
        expires_at: row.expiresAt,
        last_check: row.lastCheck,
        agents: row.agents.length,
      })),
    });
  });

  // ── GET /register/owner (verejné, F4AI-24 Phase 1b) ──────────────────────
  //
  // UI potrebuje vedieť, KTO je vlastník inštancie, aby vedel, komu ukázať
  // stránku `Správa → Operátori`. Pubkey vlastníka je verejná informácia
  // (píše sa do 30028 `d=forum4ai-writers`, ktorý čítajú aj cudzie inštancie),
  // takže odpoveď nepridáva žiadne tajomstvo. `null` = vlastník nenastavený
  // → admin stránka sa vôbec neobjaví.
  app.get('/register/owner', (c) =>
    c.json({ ok: true, owner: ownerPubkey === '' ? null : ownerPubkey }),
  );

  // ── GET /write-status (dizajn B10 — UI a MCP sa pýtajú pred písaním) ──────
  app.get('/write-status', (c) => {
    const pubkey = (c.req.query('pubkey') ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      return badRequest(c, ['pubkey must be 64 hex characters']);
    }
    return c.json({ ok: true, pubkey, ...options.writeGate.status(pubkey) });
  });

  // ── POST /register/approve · POST /register/revoke (F4AI-23, Phase 1a) ───
  //
  // Vlastník inštancie schváli/vyradí operátora z prehliadača (Stránka
  // Správa → Operátori) bez SSH. Autorizácia = NIP-98 kind 27235 v
  // `Authorization: Nostr <base64 event>` — TEN ISTÝ validátor ako `GET /me`
  // (`nip98.ts`), len s kontrolou, že podpisujúci kľúč sa rovná kľúču
  // vlastníka. 27235 je tu AUTH, nie event: na `POST /events` sa naďalej
  // odmieta (A7 zo security reviewu), aby sa auth event nedal replaynúť
  // do úložiska.
  //
  // Samotná akcia je zdieľaná s CLI (`operator approve|revoke`) cez
  // `operator-actions.ts` — status change + republish 30028
  // `d=forum4ai-writers` + pri revoku auditný 1040 LABEL.

  const ownerActionDeps = (): OperatorActionDeps => ({
    db: options.db,
    pool: options.pool,
    republishWriters,
    ownerSkHex: options.ownerSkHex.trim(),
    ownerPubkey,
    publishPowMin,
    logger: log,
    now,
  });

  const ownerBadRequest = (c: Context, reasons: string[]): Response =>
    c.json({ ok: false, error: 'invalid request', code: 'BAD_REQUEST', reasons }, 400);

  async function handleOwnerAction(c: Context, action: 'approve' | 'revoke'): Promise<Response> {
    // 503 skôr, než niečo podpíšeme: bez owner škály nie je proti čomu
    // overovať podpis ani kto má republishnúť 30028
    if (ownerSk === null) {
      return c.json(
        {
          ok: false,
          error: 'owner not configured',
          code: 'OWNER_NOT_CONFIGURED',
          reasons: [
            'the instance has no owner configured (GATEWAY_OWNER_SK_HEX) — approval over HTTP is not available',
          ],
        },
        503,
      );
    }
    // telo čítame raz a posielame ho validátorovi (payload tag sa hashuje
    // z presne týchto bajtov, ktoré klient podpísal)
    const rawBody = await c.req.text();
    if (rawBody.length > MAX_OWNER_BODY_BYTES) {
      return c.json(
        {
          ok: false,
          error: 'payload too large',
          code: 'BODY_TOO_LARGE',
          reasons: [`body exceeds ${String(MAX_OWNER_BODY_BYTES)} bytes`],
        },
        413,
      );
    }
    // Caddy strháva `/api` a končí TLS — povolené sú len varianty tej istej
    // cesty (tolerancia je v `owner-auth.ts`, rovnaká pre GET aj POST)
    const auth = await verifyOwnerAuthorization({
      header: c.req.header('authorization'),
      url: c.req.url,
      method: 'POST',
      rawBody,
      ownerSkHex: options.ownerSkHex.trim(),
      ownerPubkey,
    });
    if (!auth.ok) {
      return c.json(ownerAuthBody(auth.failure), auth.failure.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return ownerBadRequest(c, ['the body is not valid JSON']);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ownerBadRequest(c, ['the body must be an object {pubkey, note?}']);
    }
    const record = parsed as Record<string, unknown>;
    const rawPubkey = record['pubkey'];
    if (typeof rawPubkey !== 'string') {
      return ownerBadRequest(c, ['the "pubkey" field is missing (64-hex operator pubkey)']);
    }
    const pubkey = normalizeOperatorPubkey(rawPubkey);
    if (pubkey === null) {
      return ownerBadRequest(c, ['pubkey must be 64 hex characters (npub… is not accepted — send hex)']);
    }
    let note = '';
    if (record['note'] !== undefined && record['note'] !== null) {
      if (typeof record['note'] !== 'string') return ownerBadRequest(c, ['"note" must be a string']);
      note = record['note'].trim().slice(0, REVOKE_NOTE_MAX_CHARS);
    }

    const result: OperatorActionResult =
      action === 'approve'
        ? await approveOperator(ownerActionDeps(), pubkey)
        : await revokeOperator(ownerActionDeps(), pubkey, note);
    if (!result.ok) {
      if (result.reason === 'not_found') {
        return c.json(
          {
            ok: false,
            error: 'operator not found',
            code: 'OPERATOR_NOT_FOUND',
            reasons: [
              `${pubkey.slice(0, 16)}… is not in the operator table — have it request a registration first (POST /api/register)`,
            ],
          },
          404,
        );
      }
      return ownerBadRequest(c, result.warnings.length > 0 ? result.warnings : ['the action failed']);
    }
    log(
      `register ${action}: ${pubkey.slice(0, 8)}… → ${String(result.operator?.status ?? '?')} ` +
        `(owner ${auth.pubkey.toLowerCase().slice(0, 8)}…, 30028 ${result.writers.ok ? 'republished' : 'FAILED'})`,
    );
    return c.json({
      ok: true,
      action: action === 'approve' ? 'approved' : 'revoked',
      owner: ownerPubkey,
      operator: serializeOperator(result.operator),
      writers: result.writers,
      label: result.label,
      warnings: result.warnings,
    });
  }

  app.post('/register/approve', (c) => handleOwnerAction(c, 'approve'));
  app.post('/register/revoke', (c) => handleOwnerAction(c, 'revoke'));

  // ── GET /register/pending (F4AI-24, Phase 1b) ─────────────────────────────
  //
  // Administrátorská stránka potrebuje VNÚTORNÝ stav operátorov — nie
  // verejný audit z `GET /register/operators` (ten zámierne netvrdí nič o
  // `claim_id`, `note` ani o poli `agents`). Menovka route je historická:
  // vracia VŠETKÝCH operátorov (pending|lapsed|revoked|active), lebo UI má
  // pri jednom zázname vedieť aj vyradiť.
  //
  // Autorizácia: TEN ISTÝ NIP-98 owner validátor ako approve/revoke
  // (`owner-auth.ts`), len s `method: GET` a bez tela — `payload` tag pri
  // GET nečakáme (prázdne telo).
  app.get('/register/pending', async (c) => {
    const auth = await verifyOwnerAuthorization({
      header: c.req.header('authorization'),
      url: c.req.url,
      method: 'GET',
      ownerSkHex: options.ownerSkHex.trim(),
      ownerPubkey,
    });
    if (!auth.ok) {
      return c.json(ownerAuthBody(auth.failure), auth.failure.status);
    }
    // efektívny status (`operatorStatus`) a nie surový `row.status` —
    // `active` s prečítanou expiráciou je `lapsed` a UI musí ukázať pravdu
    const rows = options.db.list();
    return c.json({
      ok: true,
      owner: ownerPubkey,
      counts: options.db.countByStatus(),
      operators: rows.map((row) =>
        serializeOperator({ ...row, status: options.db.operatorStatus(row.pubkey) ?? row.status }),
      ),
    });
  });

  // ── materializácia / republish zoznamu pisúcich ───────────────────────────

  async function republishWriters(): Promise<{ ok: boolean; reason?: string; event?: Event }> {
    if (ownerSk === null) {
      log('republish 30028 skipped: GATEWAY_OWNER_SK_HEX is not set');
      return { ok: false, reason: 'no_owner_key' };
    }
    const operators = options.db.activeWriters();
    const createdAt = now();
    const event = signWithPow(
      {
        kind: KINDS.NODE_DIRECTORY,
        created_at: createdAt,
        tags: buildWritersTags(operators),
        content: buildWritersContent(operators, createdAt),
      },
      ownerSk,
      publishPowMin,
      ownerPubkey,
    );
    const results = await options.pool.publish(event);
    const ok = results.some((result) => result.ok);
    options.db.setMeta('writers_event_id', event.id);
    log(
      `republish 30028 d=${WRITERS_D_TAG}: ${String(operators.length)} operators, ` +
        `id ${event.id.slice(0, 12)}…, delivered ${String(results.filter((r) => r.ok).length)}/${String(results.length)}`,
    );
    return ok ? { ok: true, event } : { ok: false, reason: 'publish_failed', event };
  }

  async function syncWriters(): Promise<{ ok: boolean; applied: number; reason?: string }> {
    if (ownerPubkey === '') return { ok: false, applied: 0, reason: 'no_owner_key' };
    const filter: Filter = { kinds: [KINDS.NODE_DIRECTORY], authors: [ownerPubkey], '#d': [WRITERS_D_TAG], limit: 4 };
    let events: Event[];
    try {
      events = await options.pool.query([filter], { timeoutMs: 5_000 });
    } catch (err) {
      return { ok: false, applied: 0, reason: err instanceof Error ? err.message : 'query_failed' };
    }
    const fresh = events
      .filter((event) => isWritersEvent(asSharedEvent(event)) && verifyFull(asSharedEvent(event)))
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (fresh === undefined) return { ok: true, applied: 0, reason: 'no_writers_event' };
    const lastId = options.db.getMeta('writers_event_id');
    if (lastId === fresh.id) return { ok: true, applied: 0 };
    const parsed = parseWritersEvent(asSharedEvent(fresh));
    for (const warning of parsed.warnings) log(`30028 warning: ${warning}`);
    const applied = options.db.applyWriters(parsed.operators);
    options.db.setMeta('writers_event_id', fresh.id);
    log(
      `sync 30028 d=${WRITERS_D_TAG}: id ${fresh.id.slice(0, 12)}…, ` +
        `activated ${String(applied.activated)}, deactivated ${String(applied.deactivated)}`,
    );
    return { ok: true, applied: applied.activated + applied.deactivated };
  }

  async function syncAgents(): Promise<{ operators: number; agents: number }> {
    const active = options.db.list('active');
    let agentTotal = 0;
    for (const row of active) {
      const filter: Filter = { kinds: [KINDS.NODE_DIRECTORY], authors: [row.pubkey], '#d': [AGENTS_D_TAG], limit: 1 };
      let events: Event[];
      try {
        events = await options.pool.query([filter], { timeoutMs: 5_000 });
      } catch {
        continue;
      }
      const fresh = events
        .filter((event) => verifyFull(asSharedEvent(event)))
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (fresh === undefined) {
        options.db.setAgents(row.pubkey, []);
        continue;
      }
      const parsed = parseAgentsEvent(asSharedEvent(fresh));
      options.db.setAgents(row.pubkey, parsed.agents);
      agentTotal += parsed.agents.length;
    }
    return { operators: active.length, agents: agentTotal };
  }

  async function recentSampleIds(count: number): Promise<string[]> {
    const since = now() - REPLICATION_WINDOW_S;
    const filter: Filter = { kinds: [KINDS.QUESTION, KINDS.POST, KINDS.TOPIC], since, limit: 500 };
    try {
      const events = await options.pool.query([filter], { timeoutMs: 5_000 });
      return sampleIds(events.map((event) => event.id), count);
    } catch (err) {
      log(`register sampling failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * B7: preverie replikáciu operátorov, ktorých kontrola je stará (default
   * > 7 dní). Používa TEN ISTÝ probe ako registrácia — operátor, ktorému
   * relay prestane replikovať (alebo zmizne NIP-11 `pubkey`), preto
   * postupne vypadne z 30028 a jeho eventy už neprejdú write-gatom.
   */
  async function resampleDue(): Promise<{ checked: number; lapsed: string[] }> {
    const due = options.db.dueForResample();
    if (due.length === 0) return { checked: 0, lapsed: [] };
    const samples = await recentSampleIds(REPLICATION_SAMPLE_SIZE);
    const lapsed: string[] = [];
    for (const row of due) {
      if (!budget.tryAcquire()) {
        log(`re-sampling: budget exhausted, ${String(due.length - lapsed.length)} operators wait for the next round`);
        break;
      }
      let ok = false;
      let reason = '';
      try {
        const verdict = await probeOperatorRelay(
          row.relay,
          { claimant: row.pubkey, claimId: row.claimId },
          {
            connect: probeConnect,
            fetchInfo: probeFetchInfo,
            resolve: probeResolve,
            timeoutMs: probeTimeoutMs,
            sampleIds: samples,
          },
        );
        // bez `ok` by TS nezužilo diskriminovanú zväzok (verdict.reason
        // existuje len vo variante `ok: false`)
        if (verdict.ok) ok = true;
        else {
          ok = false;
          reason = verdict.reason;
        }
      } catch (err) {
        reason = err instanceof Error ? err.message : 'probe failed';
      } finally {
        budget.release();
      }
      const status = options.db.recordCheck(row.pubkey, ok);
      log(
        `re-sampling ${row.pubkey.slice(0, 8)}…: ${ok ? 'ok' : `failure (${reason})`} → status ${String(status)}`,
      );
      if (status === 'lapsed') lapsed.push(row.pubkey);
    }
    // lapsed operátor MUSÍ ísť zo zoznamu pisúcich von — inak by cudzie
    // inštancie (ktoré čítajú 30028, nie našu tabuľku) nechávali prístup
    if (lapsed.length > 0) await republishWriters();
    return { checked: due.length, lapsed };
  }

  async function runMaintenance(): Promise<{
    writers: { ok: boolean; applied: number; reason?: string };
    agents: { operators: number; agents: number };
    resample: { checked: number; lapsed: string[] };
  }> {
    const writers = await syncWriters();
    const agents = await syncAgents();
    const resample = await resampleDue();
    return { writers, agents, resample };
  }

  return {
    app,
    republishWriters,
    syncWriters,
    syncAgents,
    recentSampleIds,
    resampleDue,
    runMaintenance,
    ownerPubkey,
  };
}
