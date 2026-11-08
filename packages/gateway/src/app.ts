/**
 * Gateway Hono application (F4AI-10, S5 read/WS F4AI-11).
 *
 * Routes (this file — write + health):
 *  - GET  /health   → gateway status + per-relay pool health
 *  - POST /events   → pre-signed NostrEvent JSON; validated through
 *                     shared (`validateEvent` = structure + kind registry
 *                     + kind-specific rules) and `verifyFull` (signature
 *                     + recomputed NIP-01 hash), then published to the
 *                     author's write relays from the NIP-65 outbox with a
 *                     quorum
 *  - GET  /me       → NIP-98 (kind 27235) auth; returns the pubkey
 *                     verified by signature (S6 reuses the middleware for
 *                     further routes)
 *
 * The read routes (`/topics`, `/topics/:slug`, `/threads/:id`, `/feed`) are
 * registered by `read-routes.ts` and the WS `/ws` by `ws.ts` — both
 * `buildGateway()` and the tests run against the same Hono app.
 *
 * Middleware: CORS (the UI calls from a browser → dev default origin '*'),
 * per-IP limit on `POST /events` (F4AI-24 — 20 requests/min, XFF is
 * trusted only with `GATEWAY_TRUST_XFF=1`) and request logging.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { Event } from 'nostr-tools';

import { KINDS, validateEvent, validatePaperEvent, verifyFull } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import { nip98Auth } from './nip98.js';
import { evaluateQuorum } from './quorum.js';
import {
  CONTENT_LANG_POLICY_DEFAULT,
  checkContentLang,
  type ContentLangPolicy,
} from './content-lang.js';
import { ipRateLimit, eventRateLimit } from './rate-limit.js';
import type { Cidr } from './rate-limit.js';
import { responseCache } from './response-cache.js';
import type { WriteGate } from './write-gate.js';
import { writeGateReason } from './write-gate.js';
import type { PublishResult, RelayStatus } from './relay-pool.js';

export const GATEWAY_PHASE = 'S8';

/** defaulty per-IP limitu POST /events (F4AI-24) — verejná inštancia ich mení env */
export const EVENT_RATE_MAX_DEFAULT = 20;
export const EVENT_RATE_WINDOW_MS_DEFAULT = 60_000;

/**
 * Phase 4a (dizajn Q4): defaultný strop tela `POST /events` = 262 144 B
 * (`GATEWAY_MAX_EVENT_BYTES`). Dôvod: paper (kind 30023) smie mať 160 KiB
 * `content` (`MAX_CONTENT_BYTES_BY_KIND`), a k tomu tagy + JSON réžia —
 * 256 000 B starý default síce 160 KiB ešte prepustil, ale bez rezervy.
 * 262 144 = 256 KiB je hodnota, ktorú zdieľa aj `maxEventSize` v strfry
 * (`docker/strfry.vps.conf`) a Caddy `request_body` limit.
 *
 * Pozor na poradie efektivity: toto je strop TELE, nie obsahu. Obsahové
 * stropy drží shared (`MAX_CONTENT_BYTES` 32 KiB, pre 30023 160 KiB), takže
 * zvýšenie tohto čísla NEZVÄTŠUJE, čo smie byť v `content` — iné kindy
 * ostávajú pri 32 KiB.
 */
export const MAX_EVENT_BYTES_DEFAULT = 262_144;
/** @deprecated Phase 4a: staré meno `maxEventBytes` (env `GATEWAY_MAX_BODY_BYTES`) */
export const MAX_BODY_BYTES_DEFAULT = MAX_EVENT_BYTES_DEFAULT;

/**
 * A4 (P0): defaulty per-IP limitu ťažkých GETov. 60 requestov/min na IP
 * zodpovedá bežnému prehliadaniu (UI urobí pri otvorení strany 2–4 dopyty),
 * ale bráni skriptu, ktorý točí `/topics` v smyčke.
 */
export const GET_RATE_MAX_DEFAULT = 60;
export const GET_RATE_WINDOW_MS_DEFAULT = 60_000;

/**
 * A4 (P0): cesty, ktoré stoja veľa (viacnásobný scan relayov + Schnorr
 * overovanie, resp. replay 200k riadkov SQLite). Limiter sa registruje na
 * `*` a tieto cesty si vyberá — hono `use('/topics')` by otherwise
 * nepral pod `/topics/:slug`.
 */
export function isHeavyReadPath(pathname: string): boolean {
  return (
    pathname === '/topics' ||
    pathname.startsWith('/topics/') ||
    pathname.startsWith('/threads/') ||
    pathname.startsWith('/reputation/') ||
    pathname === '/search' ||
    // Phase 4a (dizajn Q4): `GET /papers` scanuje index (až 5 000 riadkov
    // po 160 KiB) a `GET /papers/:pubkey/:d` je 2-segmentová adresa — obe
    // sú ťažké čítania, nie lacný read z relayu
    pathname === '/papers' ||
    pathname.startsWith('/papers/') ||
    // Phase 6a (dizajn Q5): `GET /fed/events` je REQ nad relaymi (celý
    // obsahový overlay od kurzora) a `GET /fed/topics` scanuje fed.db —
    // obe čítajú pre peers, takže ich limitujeme rovnako ako /topics.
    // `/fed/state` a `/fed/resync/*` tu nie sú: owner route s lacným
    // SQLite čítaním, ktoré si operátor nevyberá v smyčke.
    pathname === '/fed/events' ||
    pathname === '/fed/topics' ||
    // F4AI-37: `GET /nodes` dopytuje relaye (REQ nad kind 30026 + 5), nie je
    // to lacný read z cache — a je to verejná cesta, ktorú si môže vyberať
    // hocikto v smyčke.
    pathname === '/nodes' ||
    pathname === '/nodes/status'
  );
}

/** kánonické polí NIP-01 eventu — nič navyše (žiadne funkcie, JSON dáta) */
const CANONICAL_FIELDS = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'] as const;

/** TVár poolu, ktorú route potrebuje — `RelayPool` ju spĺňa, testy mocknú. */
export interface GatewayPool {
  publish(event: Event, relays?: string[]): Promise<PublishResult[]>;
  status(): RelayStatus[];
}

/** TVár outboxu — `OutboxWriter` ju spĺňa. */
export interface GatewayOutbox {
  writeRelaysFor(pubkey: string): Promise<string[]>;
}

/** diagnostika search indexu pre GET /health (F4AI-14, S8) */
export interface IndexStatus {
  available: boolean;
  path: string;
  reason?: string;
}

export interface GatewayOptions {
  pool: GatewayPool;
  outbox: GatewayOutbox;
  /** default '*' (dev); produkcia nastaví konkrétny origin UI */
  corsOrigin?: string;
  /** koľko write relayov musí dať OK, default 1 */
  quorumMinOk?: number;
  /**
   * F4AI-39: stav uzla pre `GET /health` (efektívna rola + node pubkey).
   * Voliteľné — bez neho /health neobsahuje pole `node` vôbec.
   */
  nodeStatus?: () => {
    role: string;
    announce: boolean;
    upstreams: string;
    node_id: string | null;
    pubkey: string | null;
  };
  /**
   * Node role gating (F4AI-39): `false` = táto inštancia neprijíma zápisy,
   * `POST /events` odpovie 405. Default true — výhradne to vypína
   * `NODE_ROLE=seed` (verejný read-only uzol). Inštancia bez nových env sa
   * správa presne ako pred týmto feature.
   */
  acceptWrites?: boolean;
  /** default console.log; testy dajú tichý logger */
  logger?: (line: string) => void;
  /** NIP-98 tolerancia created_at, default ±300 s */
  nip98MaxSkewSeconds?: number;
  /**
   * A17: max veľkosť tela POST /events (bajtov). Bez stropu by jeden
   * klient s viacbajtovým telom zaplavil JSON parser. NIP-01 event má
   * reálne ~1 KB; Phase 4a zdvihol default na `MAX_EVENT_BYTES_DEFAULT`
   * (262 144 B), aby sa 160 KiB paper (kind 30023) zmestil aj s réžiou.
   *
   * Phase 4a: nové meno options pola je `maxEventBytes` (env
   * `GATEWAY_MAX_EVENT_BYTES`); `maxBodyBytes` (env `GATEWAY_MAX_BODY_BYTES`)
   * zostáva ako back-compat alias — ak je zadaný, rešpektujeme ho, ale
   * `maxEventBytes` má prednosť.
   */
  maxEventBytes?: number;
  /** @deprecated alias na `maxEventBytes` (Phase 4a) */
  maxBodyBytes?: number;
  /**
   * F4AI-24: per-IP limit `POST /events` (requesty za okno). Default
   * `EVENT_RATE_MAX_DEFAULT` (20/min); `0` = vypnuté (dev/test). Dôvod
   * limitu a semantika kľúča sú v `rate-limit.ts`.
   */
  eventRateMax?: number;
  /** F4AI-24: dĺžka okna v ms, default `EVENT_RATE_WINDOW_MS_DEFAULT` */
  eventRateWindowMs?: number;
  /**
   * F4AI-24: dôverovať `X-Forwarded-For` pri určovaní IP. Default
   * `false` = nedôverovať (bez dôveryhodnej reverznej proxy vpredu je XFF
   * klientom klamaný header). Na verejnej inštalácii za Caddy nastaviť
   * `GATEWAY_TRUST_XFF=1`.
   */
  trustProxyHeader?: boolean;
  /**
   * Stav read-only indexer DB (F4AI-14). /health ho zverejňuje, aby bolo
   * zvonka jasné, ČO práve beží — decision zo zadania zakazuje tichý
   * fallback, takže aj "index nie je zapnutý" musí byť viditeľný.
   */
  indexStatus?: () => IndexStatus;
  /**
   * A1 + dizajn B9: write-gate. `undefined` = žiadny gate (rovnaké
   * správanie ako pred zavedením); inak sa `POST /events` pýta pred
   * publikovaním, či je pubkey operátor/agent (alebo v bootstrap
   * allowliste). Režim `log` len loguje, `enforce` vracia 403.
   */
  writeGate?: WriteGate;
  /**
   * A4 (P0): per-IP limit ťažkých GET ciest (`/topics`, `/threads/*`,
   * `/reputation/*`, `/search`). Default `GET_RATE_MAX_DEFAULT`; `0` =
   * vypnutý (dev).
   */
  getRateMax?: number;
  /** A4 (P0): dĺžka okna GET limitu v ms */
  getRateWindowMs?: number;
  /**
   * A6 (P0): siete, ktorých socket IP smie poslať `X-Forwarded-For`
   * (`GATEWAY_TRUSTED_PROXIES`). Prázdne = dôverovať komukoľvek pri
   * `trustProxyHeader` (staré správanie).
   */
  trustedProxies?: readonly Cidr[];
  /**
   * A4 (P0): TTL cache odpovedí pre `/topics` a `/reputation/*`;
   * `0`/undefined = vypnuté.
   */
  readCacheMs?: number;
  /** A4 (P0): LRU strop cache odpovedí */
  readCacheMaxEntries?: number;
  /**
   * F4AI-2b2: jazyková politika obsahu (NIP-32 `L`/`l`). Default
   * `CONTENT_LANG_POLICY_DEFAULT` = default `en`, žiadne vynucovanie —
   * testy a dev stack sa správajú presne ako pred 2b2.
   */
  contentLang?: ContentLangPolicy;
  /**
   * Phase 6a (dizajn Q5): hook na AKCEPTOVANÝ event (po kvóre, tesne pred
   * 200 odpoveďou). Federácia do neho radí lokálny obsah do push fronty.
   *
   * Kľúčové pravidlá:
   *  - volá sa LEN pri ceste, ktorá končí 200 — 400/403/424 nič nedostávajú,
   *  - výnimka v hooku NESMIE zmeniť odpoveď klientovi (dizajn Q5: „A
   *    failed upstream post goes into a retry queue in SQLite. It doesn't
   *    affect B's quorum."), preto je obalená try/catch,
   *  - `undefined` = žiadny hook → správanie `POST /events` je byte shodné
   *    so stavom pred 6a (federačne vypnutá inštancia).
   */
  onEventAccepted?: (event: NostrEvent) => void;
}

interface PublishResponse {
  ok: boolean;
  event_id?: string;
  quorum_met: boolean;
  results: PublishResult[];
  error?: string;
  /**
   * F4AI-2b2: efektívny jazyk obsahu (deklaroovaný klientom, inak default
   * inštancie) — len pre obsahové kindy. `lang_declared: false` znamená,
   * že event na sebe NIEŽIADNY label neniesol a inštancia ho len
   * vyhlásila; do podpísaného eventu sa tag pridať nedá (porušil by
   * `id`/`sig`), takže na relayi ostáva bez neho a indexer má `lang: null`.
   */
  lang?: string;
  lang_declared?: boolean;
  /**
   * Phase 4a (dizajn Q4): varovania z lintu papiera (kind 30023). Papier
   * sa PUBLIKOVAL — varovania nič neblokujú, len hovoria, čo UI (Phase 4b)
   * nedokáže vykresliť: `REFS_MISSING`, `REFS_ITEM_INCOMPLETE`,
   * `CITE_UNKNOWN`, `REF_UNCITED`, `XREF_UNKNOWN`. `paper_warnings[i]` je
   * človečiteľná veta (English, 2b1) a `paper_warning_codes[i]` jej
   * stabilný kód. Pre iné kindy sa polia v odpovedi neobjavia.
   */
  paper_warnings?: string[];
  paper_warning_codes?: string[];
}

/**
 * Phase 4a: 400 odpoveď s lint kódy. `reasons[]` je konvencia `POST /events`
 * (UI na nej visuje), `errors[]` je alias na tie isté vety (kontrakt dizajnu
 * Q4 pre agentov) a `codes[]` sú stabilné kódy, na ktorých visuje MCP vrstva.
 */
function lintBadRequest(
  c: Context,
  payload: { error: string; reasons: string[]; codes: string[]; warnings: string[]; warning_codes: string[] },
): Response {
  return c.json(
    {
      ok: false,
      error: payload.error,
      reasons: payload.reasons,
      errors: payload.reasons,
      codes: payload.codes,
      warnings: payload.warnings,
      warning_codes: payload.warning_codes,
    },
    400,
  );
}

function badRequest(c: Context, reasons: string[]): Response {
  return c.json({ ok: false, error: 'invalid event', reasons }, 400);
}

export function createGatewayApp(options: GatewayOptions): Hono {
  const { pool, outbox } = options;
  const corsOrigin = options.corsOrigin ?? '*';
  const quorumMinOk = options.quorumMinOk ?? 1;
  // Phase 4a: `maxEventBytes` je nové meno, `maxBodyBytes` ostáva alias
  // (env `GATEWAY_MAX_EVENT_BYTES` > `GATEWAY_MAX_BODY_BYTES` > default)
  const maxEventBytes = options.maxEventBytes ?? options.maxBodyBytes ?? MAX_EVENT_BYTES_DEFAULT;
  const eventRateMax = options.eventRateMax ?? EVENT_RATE_MAX_DEFAULT;
  const eventRateWindowMs = options.eventRateWindowMs ?? EVENT_RATE_WINDOW_MS_DEFAULT;
  const trustProxyHeader = options.trustProxyHeader === true;
  const trustedProxies = options.trustedProxies ?? [];
  const getRateMax = options.getRateMax ?? GET_RATE_MAX_DEFAULT;
  const getRateWindowMs = options.getRateWindowMs ?? GET_RATE_WINDOW_MS_DEFAULT;
  const writeGate = options.writeGate;
  const acceptWrites = options.acceptWrites !== false;
  // Phase 6a: federačný hook (undefined = federácia vypnutá)
  const onEventAccepted = options.onEventAccepted;
  const contentLangPolicy = options.contentLang ?? CONTENT_LANG_POLICY_DEFAULT;
  const logger = options.logger ?? ((line: string) => console.log(line));

  const app = new Hono();

  // request logging — metod, cesta, status, trvanie
  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    try {
      await next();
    } finally {
      const path = new URL(c.req.url).pathname;
      logger(
        `${new Date().toISOString()} ${c.req.method} ${path} ${String(c.res.status)} ${String(
          Date.now() - startedAt,
        )}ms`,
      );
    }
  });

  // CORS — UI beží v prehliadači na inom origini
  app.use(
    '*',
    cors({
      origin: corsOrigin,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86_400,
    }),
  );

  // F4AI-24: per-IP limit write endpointu. Registrujeme ho ZA CORS
  // middleware, aby 429 odpoveď niesla CORS hlavičky (cors() ich dáva na
  // c.res PRED next(), hono ich pri vytváraní nášho Response skopíruje —
  // bez toho by prehliadač chybu nevidel a UI by len ticho zlyhalo).
  // OPTIONS preflight sa nepočíta (limiter počíta iba POST).
  //
  // Phase 4a: rovnaký limiter (rovnaký rozpočet, nie druhý) kryje aj
  // `POST /lint` — lint papiera je regex sken až 160 KiB tela, takže bez
  // limitu by bol lacnou CPU DoS aj bez podpisu a bez relayu.
  const writeLimiter = eventRateLimit({
    maxPerWindow: eventRateMax,
    windowMs: eventRateWindowMs,
    trustXff: trustProxyHeader,
    trustedProxies,
    logger,
  });
  app.use('/events', writeLimiter);
  app.use('/lint', writeLimiter);

  // A4 (P0): per-IP limit ťažkých čítacích route. Registrujeme ho na `*`
  // a cesty si vyberáme sami, lebo `use('/topics')` by k `/topics/:slug`
  // neprepustil. Tiež ZA cors() — 429 musí niesť CORS hlavičky, inak
  // prehliadač chybu skryje a UI len ticho zlyhá.
  const getLimiter = ipRateLimit({
    maxPerWindow: getRateMax,
    windowMs: getRateWindowMs,
    trustXff: trustProxyHeader,
    trustedProxies,
    methods: ['GET'],
    label: 'GET (heavy read routes)',
    logger,
  });
  app.use('*', async (c, next) => {
    if (!isHeavyReadPath(new URL(c.req.url).pathname)) return await next();
    return getLimiter(c, next);
  });

  // A4 (P0): 5 s cache odpovedí pre `/topics*` a `/reputation/*` —
  // ZA limiterom, aby každé volanie bolo započítané (cache zlacňuje
  // odpoveď, nie rozpočet).
  app.use(
    '*',
    responseCache({
      ttlMs: options.readCacheMs ?? 0,
      ...(options.readCacheMaxEntries !== undefined
        ? { maxEntries: options.readCacheMaxEntries }
        : {}),
    }),
  );

  // A9 (P1): /health zverejňoval URL relayov a `lastError` — internal
  // hostnames (`ws://relay:8080`, `ws://strfry:7777`) a kúsky chýb, ktoré
  // volajúci nepotrebuje. Verejný inštancii stačí agregát `connected`,
  // detaily (URL, attemps, lastError) ukazuje `docker logs` a interný
  // status poolu. `index` ostáva: nie je to hostname, ale cesta v kontajneri,
  // a 503 na /search bez neho je prekvapenie.
  app.get('/health', (c) => {
    const relays = pool.status();
    const connected = relays.filter((relay) => relay.connected).length;
    return c.json({
      status: 'ok',
      phase: GATEWAY_PHASE,
      relays: { connected: `${String(connected)}/${String(relays.length)}` },
      // F4AI-14: jasne viditeľný stav search indexu (503 na /search nie je
      // prekvapenie, keď toto hovorí, že index nie je zapnutý)
      ...(options.indexStatus !== undefined ? { index: options.indexStatus() } : {}),
      // F4AI-39: rola uzla (client|writer|seed|hub) a jeho verejný kľúč.
      ...(options.nodeStatus !== undefined ? { node: options.nodeStatus() } : {}),
    });
  });

  app.post('/events', async (c) => {
    // F4AI-39: seed je read-only inštancia — zapisuje sa u iných uzlov.
    if (!acceptWrites) {
      return c.json(
        {
          ok: false,
          error: 'read-only instance',
          reasons: ['this node role does not accept writes (NODE_ROLE=seed) — publish through a hub or a writer'],
        },
        405,
      );
    }
    // A17: strop tela — Content-Length ak existuje (lacná cesta), inak
    // dĺžka prečítaného textu (chunked transfer)
    const declared = Number(c.req.header('content-length') ?? 'NaN');
    if (Number.isFinite(declared) && declared > maxEventBytes) {
      return c.json(
        { ok: false, error: 'payload too large', reasons: [`body exceeds ${String(maxEventBytes)} bytes`] },
        413,
      );
    }
    const raw = await c.req.text();
    if (raw.length > maxEventBytes) {
      return c.json(
        { ok: false, error: 'payload too large', reasons: [`body exceeds ${String(maxEventBytes)} bytes`] },
        413,
      );
    }
    if (raw.trim().length === 0) {
      return badRequest(c, ['the body is empty — expected a pre-signed NostrEvent JSON']);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return badRequest(c, [`the body is not valid JSON: ${reason}`]);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return badRequest(c, ['the body must be a JSON object with the canonical NIP-01 event fields']);
    }

    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    const missing = CANONICAL_FIELDS.filter((field) => !(field in record));
    const extra = keys.filter((field) => !(CANONICAL_FIELDS as readonly string[]).includes(field));
    if (missing.length > 0 || extra.length > 0) {
      const reasons: string[] = [];
      if (missing.length > 0) reasons.push(`missing fields: ${missing.join(', ')}`);
      if (extra.length > 0) reasons.push(`unexpected fields: ${extra.join(', ')}`);
      return badRequest(c, reasons);
    }

    const event = record as unknown as NostrEvent;

    // shared validátory: štruktúra + kind registry + kind-špecifické pravidlá
    const validation = validateEvent(event);
    if (!validation.valid) {
      return badRequest(c, validation.errors);
    }

    // F4AI-2b2: jazyk obsahu (NIP-32 `L`/`l`). Deje sa hneď po štrukturálnej
    // validácii — obe sú 400 o samotnom evente, žiadna informácia o autorovi
    // (na rozdiel od write-gate, ktorý musí počkať na podpis; A1).
    const langVerdict = checkContentLang(event, contentLangPolicy);
    if (!langVerdict.ok) {
      return c.json(
        {
          ok: false,
          error: 'invalid content language',
          code: langVerdict.code,
          reasons: [langVerdict.reason],
        },
        400,
      );
    }

    // A7 (P0): kind 27235 (NIP-98 signed HTTP auth) je v registry, lebo ho
    // vyžaduje `GET /me` — ale cez `POST /events` by sa uložil ako bežný
    // event a dal by sa replaynúť v okne ±300 s. Auth event patrí do
    // `Authorization` hlavičky, nie do úložiska.
    if (event.kind === KINDS.AUTH_NIP98) {
      return badRequest(c, [
        `kind ${String(KINDS.AUTH_NIP98)} (NIP-98 auth) is not sent to POST /events — ` +
          'it belongs in the Authorization header (GET /me), otherwise it could be replayed',
      ]);
    }

    // podpis + prepočet NIP-01 hashu (shared verifyFull)
    if (!verifyFull(event)) {
      return badRequest(c, ['the signature is not valid or the id does not match the content hash (verifyFull)']);
    }

    // A1 + dizajn B9: write-gate AŽ po overení podpisu — inak by útočník
    // dostal 403 na ľubovoľný (neoverený) pubkey a mohol by skúmať, kto
    // je registrovaný, bez akejkoľvek práce na strane servera.
    if (writeGate !== undefined && writeGate.enabled) {
      const gate = writeGate.check(event.pubkey);
      if (!gate.ok) {
        if (writeGate.loggingOnly) {
          // `log` režim: rovnaké rozhodnutie ako `enforce`, len nezablokuje —
          // logujeme ho loggerom aplikácie, aby bol vidno v `docker logs`
          logger(
            `write-gate[log]: POST /events pubkey ${event.pubkey.slice(0, 8)}… would have been ` +
              `rejected — ${gate.reason}`,
          );
        } else {
          return c.json(
            {
              ok: false,
              error: 'write not allowed',
              // F4AI-23: stabilný strojový kód (WG_*), na ktorom visuje UI —
              // `reasons[]` zostáva človečiteľný text (Phase 2 pre jazyk UI)
              code: gate.code,
              reasons: [writeGateReason(event.pubkey, gate)],
            },
            403,
          );
        }
      }
    }

    // ── Phase 4a (dizajn Q4): lint papiera PRED publishom ────────────────
    // 30023 je NIP-23 long-form a forum z neho robí vedlecké papiera
    // (`paper.ts` v shared). Gateway LEN LINTUJE štruktúru — veľkosť,
    // chart DSL, mermaid stropy, čitateľnosť ` ```references `, krížové
    // odkazy a citácie. Nič sa nerenderuje: číslovanie sekcií/obrázkov,
    // číslovaný zoznam citácií a BibTeX export sú UI (Phase 4b).
    // Chyba → 400 s `codes[]`; varovania → `paper_warnings[]` v 200.
    // Poradie: až po podpise a write-gate, aby 401/403 informovalo skôr,
    // než klient dostane detaily o obsahu (a aby lint nemohol byť lacný
    // DoS proti neovereným eventom).
    let paperWarnings: string[] = [];
    let paperWarningCodes: string[] = [];
    if (event.kind === KINDS.PUBLICATION) {
      const paper = validatePaperEvent(event);
      paperWarnings = paper.warnings;
      paperWarningCodes = paper.warning_codes;
      if (!paper.ok) {
        logger(
          `paper lint 400: id=${event.id.slice(0, 8)}… codes=${paper.codes.join(',')}`,
        );
        return lintBadRequest(c, {
          error: 'paper lint failed',
          reasons: paper.errors,
          codes: paper.codes,
          warnings: paperWarnings,
          warning_codes: paperWarningCodes,
        });
      }
    }

    const writeRelays = await outbox.writeRelaysFor(event.pubkey);
    const results = await pool.publish(event as unknown as Event, writeRelays);
    const quorum = evaluateQuorum(results, quorumMinOk);

    const body: PublishResponse = {
      ok: quorum.quorum_met,
      event_id: event.id,
      quorum_met: quorum.quorum_met,
      results,
      // F4AI-2b2: efektívny jazyk obsahu (len pre obsahové kindy) —
      // writer of record hlási, čomu ten-ktorý event verí
      ...(langVerdict.applies
        ? { lang: langVerdict.lang, lang_declared: langVerdict.declared }
        : {}),
      // Phase 4a: varovania z lintu papiera (200, nie chyba)
      ...(event.kind === KINDS.PUBLICATION
        ? { paper_warnings: paperWarnings, paper_warning_codes: paperWarningCodes }
        : {}),
    };

    if (!quorum.quorum_met) {
      return c.json({ ...body, error: 'quorum not met' }, 424);
    }

    // Phase 6a (dizajn Q5): federovaný push sa radi AŽ po kvóre. Hook je
    // obalený try/catch — fronta je vedľajší efekt a jej zlyhanie nesmie
    // klientovi vrátiť inú než 200 (ani 500, ani oneskorenie).
    if (onEventAccepted !== undefined) {
      try {
        onEventAccepted(event);
      } catch (error) {
        logger(`fed hook failed for ${event.id.slice(0, 8)}…: ${String(error)}`);
      }
    }
    return c.json(body, 200);
  });

  // NIP-98 chránená route — S5/S6 použije `nip98Auth()` na ďalších route
  app.get('/me', nip98Auth({ maxSkewSeconds: options.nip98MaxSkewSeconds }), (c) =>
    c.json({ pubkey: c.get('pubkey') }),
  );

  app.onError((err, c) => {
    // A17: interná chyba sa loguje celá, klientovi dáme VŠEOBECMNÝ
    // dôvod — String(err) vie uniesť cesty, SQL fragmenty aj kúsky dát
    logger(`gateway error at ${c.req.method} ${new URL(c.req.url).pathname}: ${String(err)}`);
    return c.json(
      { ok: false, error: 'internal error', reason: 'unexpected server error — try again later' },
      500,
    );
  });

  app.notFound((c) => c.json({ ok: false, error: 'not found' }, 404));

  return app;
}
