/**
 * Unit testy HTTP route `register-routes.ts` (F4AI-23/24, Phase 1a).
 *
 * Challenge/probe majú svoje testy v `registration.test.ts`, route vrstva
 * ich dosiaľ nemala. Tento súbor cvičí práve to nové, čo priniesla Phase 1a:
 *
 *  1. `POST /register/approve` a `POST /register/revoke` — NIP-98 (kind
 *     27235) AUTHORIZÁCIA VLASTNÍKA: správny podpis + zhoda s owner pubkey,
 *     cudzí podpis = 403, neplatný/chýbajúci token = 401, owner nenastavený
 *     = 503 `OWNER_NOT_CONFIGURED`. 27235 je tu AUTH, NIE event — na
 *     `POST /events` sa naďalej odmieta (A7).
 *  2. tolerance URL: Caddy strháva `/api` prefix a končí TLS, takže klient
 *     podpisuje `https://host/api/register/approve` a gateway vidí
 *     `http://host/register/approve`. Musí to prejsť (inak by UI nemohol
 *     nikdy podpísať platný token), ale INÁ CESTA prejsť nesmie.
 *  3. identická semantika s CLI: status change + republish 30028
 *     `d=forum4ai-writers` + pri revoku auditný 1040 LABEL.
 *  4. `GET /write-status` vracia stabilný `code` (WG_*), text `reason`
 *     zostáva slovenský (UI testy počítajú s textom — Phase 2 prepne jazyk).
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';

import { KINDS, verifyFull } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import {
  MAX_OWNER_BODY_BYTES,
  createRegisterRoutes,
  nip98UrlCandidates,
  type RegisterPool,
} from '../src/register-routes.js';
import { openOperatorsDb } from '../src/operators-db.js';
import { WriteGate } from '../src/write-gate.js';
import { REGISTRATION_TTL_S, WRITERS_D_TAG } from '../src/writers.js';
import type { PublishResult, RelayStatus } from '../src/relay-pool.js';

const T0 = 1_730_000_000;
const RELAY_URL = 'ws://relay.test:7777';

/** 64-hex pubkey z dvojznakového prefixu (`hexId('a9')` → 'a9a9…a9') */
function hexId(pair: string): string {
  return pair.repeat(32);
}

const OWNER_SK = generateSecretKey();
const OWNER_PK = getPublicKey(OWNER_SK).toLowerCase();
const OWNER_SK_HEX = Buffer.from(OWNER_SK).toString('hex');
const OPERATOR_SK = generateSecretKey();
const OPERATOR_PK = getPublicKey(OPERATOR_SK).toLowerCase();
const AGENT_PK = getPublicKey(generateSecretKey()).toLowerCase();
const OUTSIDER_SK = generateSecretKey();

/** pool bez siete — pamätá publikované eventy a voliteľne zlyháva */
class FakePool implements RegisterPool {
  readonly published: Event[] = [];
  ok = true;

  async publish(event: Event): Promise<PublishResult[]> {
    this.published.push(event);
    return [{ url: RELAY_URL, ok: this.ok, message: this.ok ? 'OK accepted' : 'OK rejected' }];
  }

  async query(): Promise<Event[]> {
    return [];
  }

  status(): RelayStatus[] {
    return [
      {
        url: RELAY_URL,
        connected: true,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        lastConnectedAt: 0,
      },
    ];
  }

  byKind(kind: number): Event[] {
    return this.published.filter((event) => event.kind === kind);
  }
}

interface HarnessOptions {
  ownerSkHex?: string;
  publishOk?: boolean;
  gateMode?: 'off' | 'log' | 'enforce';
}

function harness(options: HarnessOptions = {}) {
  const db = openOperatorsDb(':memory:', { now: () => T0 });
  const pool = new FakePool();
  if (options.publishOk === false) pool.ok = false;
  const writeGate = new WriteGate({
    mode: options.gateMode ?? 'enforce',
    source: db,
    logger: () => undefined,
  });
  const routes = createRegisterRoutes({
    db,
    pool,
    writeGate,
    regSecret: 'test-secret',
    registerMode: 'approve',
    ownerSkHex: options.ownerSkHex ?? OWNER_SK_HEX,
    publishPowMin: 0,
    trustProxyHeader: false,
    trustedProxies: [],
    logger: () => undefined,
    now: () => T0,
  });
  return { db, pool, routes };
}

/** pending claim (dizajn B5: registrácia vzniká ako `pending`) */
function seedPending(db: ReturnType<typeof harness>['db'], pubkey = OPERATOR_PK): void {
  db.upsertClaim({ pubkey, relay: 'wss://op.example/', claimId: 'c1' });
}

/** NIP-98 token: kind 27235 s tagmi `u`, `method`, `payload` (hash tela) */
function nip98Token(
  secretKey: Uint8Array,
  url: string,
  method: string,
  body?: string,
  kind: number = KINDS.AUTH_NIP98,
): string {
  const tags: string[][] = [['u', url], ['method', method]];
  if (body !== undefined) {
    tags.push(['payload', createHash('sha256').update(body, 'utf8').digest('hex')]);
  }
  const event = finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    secretKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

interface PostOptions {
  /** kľúč, ktorý request podpisuje (default vlastník) */
  secretKey?: Uint8Array;
  /** URL v `u` tagu — to, čo klient VOLÁ (default verejná adresa za Caddy) */
  signedUrl?: string;
  /** surové telo (default JSON.stringify(body)) — pre test tampernutého tela */
  rawBody?: string;
  /** bez Authorization hlavičky */
  noAuth?: boolean;
}

/**
 * POST na register app. Server vidí `http://127.0.0.1:3001<path>`, podpisuje
 * sa verejná URL za reverznou proxy (`https://127.0.0.1/api<path>`) —
 * HOSTITEĽ sa meniť nesmie (kandidáti menia len schému/port/prefix),
 * preto default podpisuje tú istú adresu, len v tvare, aký vidí prehliadač.
 */
async function postOwnerAction(
  routes: ReturnType<typeof createRegisterRoutes>,
  path: string,
  body: Record<string, unknown>,
  options: PostOptions = {},
): Promise<Response> {
  const rawBody = options.rawBody ?? JSON.stringify(body);
  const signedUrl = options.signedUrl ?? `https://127.0.0.1/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.noAuth !== true) {
    headers['authorization'] = nip98Token(
      options.secretKey ?? OWNER_SK,
      signedUrl,
      'POST',
      rawBody,
    );
  }
  return routes.app.request(`http://127.0.0.1:3001${path}`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ── POST /register/approve ────────────────────────────────────────────────

describe('POST /register/approve (NIP-98 vlastník, F4AI-23)', () => {
  it('schváli pending → active a republishne 30028 d=forum4ai-writers', async () => {
    const h = harness();
    seedPending(h.db);

    const res = await postOwnerAction(h.routes, '/register/approve', { pubkey: OPERATOR_PK });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['ok']).toBe(true);
    expect(body['action']).toBe('approved');
    expect(body['owner']).toBe(OWNER_PK);
    const operator = body['operator'] as Record<string, unknown>;
    expect(operator['pubkey']).toBe(OPERATOR_PK);
    expect(operator['status']).toBe('active');
    // snake_case zhodné s GET /register/status (UI nemá dva typy na ten
    // istý záznam)
    expect(operator['expires_at']).toBe(T0 + REGISTRATION_TTL_S);
    expect(operator['relay']).toBe('wss://op.example/');
    expect(body['writers']).toMatchObject({ ok: true });
    expect(body['warnings']).toEqual([]);

    // zdroj pravdy: owner-signed 30028 s týmto operátorom
    const writers = h.pool.byKind(KINDS.NODE_DIRECTORY);
    expect(writers).toHaveLength(1);
    const writersEvent = writers[0] as Event;
    expect(writersEvent.pubkey).toBe(OWNER_PK);
    expect(writersEvent.tags).toContainEqual(['d', WRITERS_D_TAG]);
    expect(writersEvent.tags).toContainEqual([
      'p',
      OPERATOR_PK,
      'wss://op.example/',
      String(T0 + REGISTRATION_TTL_S),
    ]);
    expect(verifyFull(writersEvent as unknown as NostrEvent)).toBe(true);

    // write-gate teraz pustí aj agentov tohto operátora
    h.db.setAgents(OPERATOR_PK, [AGENT_PK]);
    const status = await jsonOf(
      await h.routes.app.request(`/write-status?pubkey=${AGENT_PK}`),
    );
    expect(status['allowed']).toBe(true);
    expect(status['code']).toBe('WG_AGENT');
  });

  it('prejde aj presná adresa gatewaya bez proxy (priamy client — CLI/MCP)', async () => {
    const h = harness();
    seedPending(h.db);
    // klient, ktorý volá PRIAMO gateway (bez Caddy), podpisuje presne to,
    // čo server vidí — presná zhoda musí fungovať tiež
    const res = await postOwnerAction(h.routes, '/register/approve', { pubkey: OPERATOR_PK }, {
      signedUrl: 'http://127.0.0.1:3001/register/approve',
    });
    expect(res.status).toBe(200);
  });

  it('inaká HOSTITEĽSKÁ adresa v `u` tagu = 401 (kandidáti nemenia host)', async () => {
    const h = harness();
    seedPending(h.db);
    const res = await postOwnerAction(h.routes, '/register/approve', { pubkey: OPERATOR_PK }, {
      signedUrl: 'https://inej-instancie.example/api/register/approve',
    });
    expect(res.status).toBe(401);
  });

  it('cudzí podpis (platný NIP-98, nie vlastník) = 403 NOT_OWNER', async () => {
    const h = harness();
    seedPending(h.db);
    const res = await postOwnerAction(h.routes, '/register/approve', { pubkey: OPERATOR_PK }, {
      secretKey: OUTSIDER_SK,
    });
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(body['code']).toBe('NOT_OWNER');
    expect((body['reasons'] as string[]).join(' ')).toContain('only the instance owner');
    // stav sa NESMIE zmeniť
    expect(h.db.get(OPERATOR_PK)?.status).toBe('pending');
    expect(h.pool.published).toHaveLength(0);
  });

  it('bez Authorization hlavičky = 401 AUTH_NIP98_INVALID', async () => {
    const h = harness();
    seedPending(h.db);
    const res = await postOwnerAction(h.routes, '/register/approve', { pubkey: OPERATOR_PK }, {
      noAuth: true,
    });
    expect(res.status).toBe(401);
    expect((await jsonOf(res))['code']).toBe('AUTH_NIP98_INVALID');
  });

  it('tampernuté telo (token podpisuje iné pubkey) = 401', async () => {
    const h = harness();
    seedPending(h.db);
    const signed = JSON.stringify({ pubkey: OPERATOR_PK });
    const tampered = JSON.stringify({ pubkey: AGENT_PK });
    const url = 'https://127.0.0.1/api/register/approve';
    const token = nip98Token(OWNER_SK, url, 'POST', signed);
    const res = await h.routes.app.request('http://127.0.0.1:3001/register/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: token },
      body: tampered,
    });
    expect(res.status).toBe(401);
    expect((await jsonOf(res))['code']).toBe('AUTH_NIP98_INVALID');
    expect(h.db.get(OPERATOR_PK)?.status).toBe('pending');
  });

  it('u tag na INEJ ceste = 401 (replay approve→revoke nie je dovolený)', async () => {
    const h = harness();
    seedPending(h.db);
    const res = await postOwnerAction(h.routes, '/register/approve', { pubkey: OPERATOR_PK }, {
      signedUrl: 'https://127.0.0.1/api/register/revoke',
    });
    expect(res.status).toBe(401);
  });

  it('event iného kindu v Authorization = 401 (27235 je jediná AUTH)', async () => {
    const h = harness();
    seedPending(h.db);
    const body = JSON.stringify({ pubkey: OPERATOR_PK });
    const url = 'https://127.0.0.1/api/register/approve';
    const token = nip98Token(OWNER_SK, url, 'POST', body, KINDS.POST);
    const res = await h.routes.app.request('http://127.0.0.1:3001/register/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: token },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('owner nenastavený = 503 OWNER_NOT_CONFIGURED (aj so správnym tokenom)', async () => {
    const h = harness({ ownerSkHex: '' });
    seedPending(h.db);
    const res = await postOwnerAction(h.routes, '/register/approve', { pubkey: OPERATOR_PK });
    expect(res.status).toBe(503);
    const body = await jsonOf(res);
    expect(body['code']).toBe('OWNER_NOT_CONFIGURED');
    expect((body['reasons'] as string[]).join(' ')).toContain('GATEWAY_OWNER_SK_HEX');
    expect(h.db.get(OPERATOR_PK)?.status).toBe('pending');
  });

  it('neznámy pubkey = 404 OPERATOR_NOT_FOUND', async () => {
    const h = harness();
    const res = await postOwnerAction(h.routes, '/register/approve', { pubkey: AGENT_PK });
    expect(res.status).toBe(404);
    expect((await jsonOf(res))['code']).toBe('OPERATOR_NOT_FOUND');
  });

  it('nesprávny tvar pubkey (npub…) = 400 BAD_REQUEST', async () => {
    const h = harness();
    seedPending(h.db);
    const res = await postOwnerAction(h.routes, '/register/approve', {
      pubkey: 'npub1xy',
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res))['code']).toBe('BAD_REQUEST');
  });

  it('chýbajúce pubkey a zlý JSON = 400', async () => {
    const h = harness();
    seedPending(h.db);
    expect((await postOwnerAction(h.routes, '/register/approve', {})).status).toBe(400);
    const broken = await postOwnerAction(h.routes, '/register/approve', {}, {
      rawBody: '{nie je json',
    });
    expect(broken.status).toBe(400);
  });

  it('obrovské telo = 413 BODY_TOO_LARGE', async () => {
    const h = harness();
    seedPending(h.db);
    const huge = JSON.stringify({ pubkey: OPERATOR_PK, note: 'x'.repeat(MAX_OWNER_BODY_BYTES) });
    const res = await postOwnerAction(h.routes, '/register/approve', {}, { rawBody: huge });
    expect(res.status).toBe(413);
    expect((await jsonOf(res))['code']).toBe('BODY_TOO_LARGE');
  });

  it('republish 30028 zlyhá → 200 s varovaním (rovnako ako CLI)', async () => {
    const h = harness({ publishOk: false });
    seedPending(h.db);
    const res = await postOwnerAction(h.routes, '/register/approve', { pubkey: OPERATOR_PK });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['writers']).toMatchObject({ ok: false });
    expect((body['warnings'] as string[]).join(' ')).toContain('republish');
    // stav v tabuľke (cache) zmenený je — gateway píše z nej
    expect(h.db.get(OPERATOR_PK)?.status).toBe('active');
  });
});

// ── POST /register/revoke ─────────────────────────────────────────────────

describe('POST /register/revoke (NIP-98 vlastník, F4AI-23)', () => {
  it('zruší aktívneho operátora, republishne 30028 bez neho a pošle 1040 LABEL', async () => {
    const h = harness();
    seedPending(h.db);
    h.db.setStatus(OPERATOR_PK, 'active');
    h.db.setAgents(OPERATOR_PK, [AGENT_PK]);

    const res = await postOwnerAction(h.routes, '/register/revoke', {
      pubkey: OPERATOR_PK,
      note: 'relay prestal replikovať',
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['action']).toBe('revoked');
    expect((body['operator'] as Record<string, unknown>)['status']).toBe('revoked');
    expect((body['operator'] as Record<string, unknown>)['note']).toBe('relay prestal replikovať');
    expect(body['writers']).toMatchObject({ ok: true });
    expect(body['label']).toMatchObject({ ok: true });

    // 30028 už operátora neobsahuje — cudzie inštancie tým prístup zoberú
    const writers = h.pool.byKind(KINDS.NODE_DIRECTORY);
    expect(writers).toHaveLength(1);
    expect(writers[0]?.tags.filter((tag) => tag[0] === 'p')).toEqual([]);

    // auditný LABEL: L/l marker + p tag na vyradeného, podpis vlastníka
    const labels = h.pool.byKind(KINDS.LABEL);
    expect(labels).toHaveLength(1);
    const label = labels[0] as Event;
    expect(label.pubkey).toBe(OWNER_PK);
    expect(label.tags).toContainEqual(['L', OPERATOR_PK, 'forum4ai-writers']);
    expect(label.tags).toContainEqual(['p', OPERATOR_PK]);
    expect(label.content).toBe('relay prestal replikovať');
    expect(verifyFull(label as unknown as NostrEvent)).toBe(true);

    // agentovia vyradeného operátora okamžite strácajú právo písať
    const status = await jsonOf(await h.routes.app.request(`/write-status?pubkey=${AGENT_PK}`));
    expect(status['allowed']).toBe(false);
    expect(status['code']).toBe('WG_NOT_REGISTERED');
  });

  it('bez poznámky → LABEL content "revoked" a poznámka v zázname je prázdna', async () => {
    const h = harness();
    seedPending(h.db);
    h.db.setStatus(OPERATOR_PK, 'active');
    const res = await postOwnerAction(h.routes, '/register/revoke', { pubkey: OPERATOR_PK });
    expect(res.status).toBe(200);
    expect(h.pool.byKind(KINDS.LABEL)[0]?.content).toBe('revoked');
    expect(h.db.get(OPERATOR_PK)?.note).toBe('');
  });

  it('cudzí podpis = 403 a status ostáva active', async () => {
    const h = harness();
    seedPending(h.db);
    h.db.setStatus(OPERATOR_PK, 'active');
    const res = await postOwnerAction(h.routes, '/register/revoke', { pubkey: OPERATOR_PK }, {
      secretKey: OUTSIDER_SK,
    });
    expect(res.status).toBe(403);
    expect(h.db.get(OPERATOR_PK)?.status).toBe('active');
  });

  it('poznámku oreže na 120 znakov (rovnaké ako CLI a LABEL)', async () => {
    const h = harness();
    seedPending(h.db);
    h.db.setStatus(OPERATOR_PK, 'active');
    const res = await postOwnerAction(h.routes, '/register/revoke', {
      pubkey: OPERATOR_PK,
      note: 'y'.repeat(400),
    });
    expect(res.status).toBe(200);
    expect(h.db.get(OPERATOR_PK)?.note).toHaveLength(120);
  });
});

// ── GET /write-status: stabilné WG_* kódy ─────────────────────────────────

describe('GET /write-status — stabilný kód WG_* (F4AI-23)', () => {
  async function codeFor(
    setup: (db: ReturnType<typeof harness>['db']) => void,
    target: string,
    gateMode: 'off' | 'log' | 'enforce' = 'enforce',
  ): Promise<Record<string, unknown>> {
    const h = harness({ gateMode });
    setup(h.db);
    return jsonOf(await h.routes.app.request(`/write-status?pubkey=${target}`));
  }

  it('off = WG_GATE_OFF (povolené), bootstrap = WG_BOOTSTRAP', async () => {
    expect(await codeFor(() => undefined, OPERATOR_PK, 'off')).toMatchObject({
      allowed: true,
      code: 'WG_GATE_OFF',
    });
    const h = harness();
    h.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
    const gate = new WriteGate({ mode: 'enforce', allow: [OPERATOR_PK], source: h.db });
    expect(gate.check(OPERATOR_PK).code).toBe('WG_BOOTSTRAP');
  });

  it('active operátor = WG_OPERATOR', async () => {
    expect(
      await codeFor((db) => {
        db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
      }, OPERATOR_PK),
    ).toMatchObject({ allowed: true, code: 'WG_OPERATOR' });
  });

  it('pending / lapsed / revoked / neznámy = WG_PENDING / WG_LAPSED / WG_REVOKED / WG_NOT_REGISTERED', async () => {
    const pending = await codeFor((db) => seedPending(db), OPERATOR_PK);
    expect(pending).toMatchObject({ allowed: false, code: 'WG_PENDING' });
    // text DÔVODU sa nemmení — UI testy naň visia (Phase 2 prepne jazyk)
    expect(String(pending['reason'])).toContain('waiting for approval');

    expect(
      await codeFor((db) => {
        db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'lapsed' });
      }, OPERATOR_PK),
    ).toMatchObject({ allowed: false, code: 'WG_LAPSED' });

    expect(
      await codeFor((db) => {
        db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'revoked' });
      }, OPERATOR_PK),
    ).toMatchObject({ allowed: false, code: 'WG_REVOKED' });

    expect(await codeFor(() => undefined, AGENT_PK)).toMatchObject({
      allowed: false,
      code: 'WG_NOT_REGISTERED',
    });
  });

  it('agent aktívneho operátora = WG_AGENT s operator=', async () => {
    const body = await codeFor((db) => {
      db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
      db.setAgents(OPERATOR_PK, [AGENT_PK]);
    }, AGENT_PK);
    expect(body).toMatchObject({ allowed: true, code: 'WG_AGENT', via: 'agent', operator: OPERATOR_PK });
  });

  it('zlý pubkey = 400 a request nevyhodí error', async () => {
    const h = harness();
    const res = await h.routes.app.request('/write-status?pubkey=zz');
    expect(res.status).toBe(400);
  });
});

// ── kandidátske URL pre NIP-98 ────────────────────────────────────────────

describe('nip98UrlCandidates (Caddy strháva /api a končí TLS)', () => {  it('pridá https a /api varianty, ale NIKDY inú cestu', () => {
    const candidates = nip98UrlCandidates('http://forum.test:3001/register/approve');
    expect(candidates).toContain('http://forum.test:3001/register/approve');
    expect(candidates).toContain('https://forum.test/register/approve');
    expect(candidates).toContain('https://forum.test/api/register/approve');
    expect(candidates).toContain('http://forum.test:3001/api/register/approve');
    // replay na inú route nesmie prejsť ani cez kandidátov
    expect(candidates.some((url) => url.includes('/register/revoke'))).toBe(false);
    expect(candidates.some((url) => url.includes('/events'))).toBe(false);
  });

  it('/api už v ceste → pridá aj variant BEZ neho (rovnaká tolerancia obojsmerne)', () => {
    const candidates = nip98UrlCandidates('https://forum.test/api/register/revoke');
    expect(candidates).toContain('https://forum.test/register/revoke');
    expect(candidates).toContain('https://forum.test/api/register/revoke');
  });

  it('neplatná URL vráti len originál (žiadna výnimka z validátora)', () => {
    expect(nip98UrlCandidates('nie-url')).toEqual(['nie-url']);
  });
});

// ── GET /register/pending · GET /register/owner (F4AI-24, Phase 1b) ───────

interface GetOptions {
  secretKey?: Uint8Array;
  signedUrl?: string;
  noAuth?: boolean;
}

/**
 * GET na owner route. `u` tag podpisujeme verejnou adresou (`https://host/api/…`),
 * server vidí `http://127.0.0.1:3001/…` — rovnaká tolerancia ako pri POST,
 * len bez tela (pri GET nesmie byť `payload` tag vôbec).
 */
async function getOwnerRoute(
  routes: ReturnType<typeof createRegisterRoutes>,
  path: string,
  options: GetOptions = {},
): Promise<Response> {
  const signedUrl = options.signedUrl ?? `https://127.0.0.1/api${path}`;
  const headers: Record<string, string> = {};
  if (options.noAuth !== true) {
    headers['authorization'] = nip98Token(options.secretKey ?? OWNER_SK, signedUrl, 'GET');
  }
  return routes.app.request(`http://127.0.0.1:3001${path}`, { method: 'GET', headers });
}

describe('GET /register/pending (NIP-98 vlastník, F4AI-24)', () => {
  it('vráti všetkých operátorov (pending|lapsed|revoked|active) aj s agentmi', async () => {
    const h = harness();
    seedPending(h.db);
    h.db.upsertClaim({
      pubkey: AGENT_PK,
      relay: 'wss://other.example/',
      claimId: 'c2',
      status: 'active',
    });
    h.db.setAgents(OPERATOR_PK, [hexId('a9')]);
    h.db.upsertClaim({ pubkey: hexId('b3'), relay: 'wss://gone.example/', claimId: 'c3', status: 'revoked' });

    const res = await getOwnerRoute(h.routes, '/register/pending');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body['ok']).toBe(true);
    expect(body['owner']).toBe(OWNER_PK);
    expect(body['counts']).toMatchObject({ pending: 1, active: 1, revoked: 1 });

    // `list()` radí podľa pubkey (nie podľa vkladania) — testuje množinu,
    // nie poradie, lebo OPERATOR_PK/AGENT_PK sú generované kľúče
    const operators = body['operators'] as Record<string, unknown>[];
    expect(new Set(operators.map((row) => row['pubkey']))).toEqual(
      new Set([OPERATOR_PK, AGENT_PK, hexId('b3')]),
    );
    const pending = operators.find((row) => row['pubkey'] === OPERATOR_PK) as Record<string, unknown>;
    // snake_case zhodné s approve/revoke + `agents` pole (UI kreslí role)
    expect(pending).toMatchObject({
      status: 'pending',
      relay: 'wss://op.example/',
      claim_id: 'c1',
      expires_at: T0 + REGISTRATION_TTL_S,
      fail_count: 0,
      agents: [hexId('a9')],
    });
    expect(operators.find((row) => row['pubkey'] === AGENT_PK)).toMatchObject({ status: 'active' });
    expect(operators.find((row) => row['pubkey'] === hexId('b3'))).toMatchObject({ status: 'revoked' });
  });

  it('ektívny status: active s prečítanou expiráciou = lapsed (nie active)', async () => {
    const h = harness();
    h.db.upsertClaim({
      pubkey: OPERATOR_PK,
      relay: 'wss://op.example/',
      claimId: 'c1',
      status: 'active',
      expiresAt: T0 - 1,
    });
    const body = await jsonOf(await getOwnerRoute(h.routes, '/register/pending'));
    const operators = body['operators'] as Record<string, unknown>[];
    expect(operators[0]).toMatchObject({ pubkey: OPERATOR_PK, status: 'lapsed' });
  });

  it('prázdna tabuľka = 200 s prázdnym zoznamom (UI kreslí „nikto“)', async () => {
    const h = harness();
    const body = await jsonOf(await getOwnerRoute(h.routes, '/register/pending'));
    expect(body['operators']).toEqual([]);
  });

  it('bez Authorization hlavičky = 401 AUTH_NIP98_INVALID', async () => {
    const h = harness();
    seedPending(h.db);
    const res = await getOwnerRoute(h.routes, '/register/pending', { noAuth: true });
    expect(res.status).toBe(401);
    expect((await jsonOf(res))['code']).toBe('AUTH_NIP98_INVALID');
  });

  it('cudzí podpis (platný NIP-98, nie vlastník) = 403 NOT_OWNER', async () => {
    const h = harness();
    seedPending(h.db);
    const res = await getOwnerRoute(h.routes, '/register/pending', { secretKey: OUTSIDER_SK });
    expect(res.status).toBe(403);
    expect((await jsonOf(res))['code']).toBe('NOT_OWNER');
  });

  it('owner nenastavený = 503 OWNER_NOT_CONFIGURED (ani bez tokena)', async () => {
    const h = harness({ ownerSkHex: '' });
    seedPending(h.db);
    const res = await getOwnerRoute(h.routes, '/register/pending');
    expect(res.status).toBe(503);
    expect((await jsonOf(res))['code']).toBe('OWNER_NOT_CONFIGURED');
  });

  it('u tag na INEJ ceste = 401 (pending token nemožno replaynúť na approve)', async () => {
    const h = harness();
    seedPending(h.db);
    const res = await getOwnerRoute(h.routes, '/register/pending', {
      signedUrl: 'https://127.0.0.1/api/register/approve',
    });
    expect(res.status).toBe(401);
  });

  it('method tag GET nesmie pustiť POST token (rovnaká cesta, iná metóda)', async () => {
    const h = harness();
    seedPending(h.db);
    const url = 'https://127.0.0.1/api/register/pending';
    const token = nip98Token(OWNER_SK, url, 'POST');
    const res = await h.routes.app.request('http://127.0.0.1:3001/register/pending', {
      method: 'GET',
      headers: { authorization: token },
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /register/owner (verejné, F4AI-24)', () => {
  it('vráti owner hex BEZ auth hlavičky (UI potrebuje public informáciu)', async () => {
    const h = harness();
    const res = await h.routes.app.request('http://127.0.0.1:3001/register/owner');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, owner: OWNER_PK });
  });

  it('owner nenastavený = 200 s null (nie 503 — UI sa len neukáže)', async () => {
    const h = harness({ ownerSkHex: '' });
    const res = await h.routes.app.request('http://127.0.0.1:3001/register/owner');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, owner: null });
  });
});
