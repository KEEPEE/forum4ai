/**
 * Gateway env configuration (F4AI-10, S5 F4AI-11) — the single source of
 * truth for both the CLI and the tests.
 *
 * Variables (defaults are the dev values from the task):
 *   GATEWAY_RELAY_URLS          list of relays (comma); default dev relays
 *                               ws://127.0.0.1:18080,ws://127.0.0.1:18008
 *   GATEWAY_WRITE_RELAY_URLS    fallback write relays (default = GATEWAY_RELAY_URLS)
 *   GATEWAY_PORT                default 3001
 *   GATEWAY_HOST                default 0.0.0.0
 *   GATEWAY_CONNECT_TIMEOUT_MS  default 5000
 *   GATEWAY_PUBLISH_TIMEOUT_MS  default 5000
 *   GATEWAY_EOSE_TIMEOUT_MS     default 5000
 *   GATEWAY_READ_TIMEOUT_MS     pool.query() timeout of the read routes,
 *                               default = GATEWAY_EOSE_TIMEOUT_MS
 *   GATEWAY_BACKOFF_INITIAL_MS  default 500
 *   GATEWAY_BACKOFF_MAX_MS      default 60000
 *   GATEWAY_OUTBOX_TTL_MS       default 900000 (15 min)
 *   GATEWAY_OUTBOX_FETCH_MS     default 4000
 *   GATEWAY_QUORUM_MIN_OK       default 1
 *   GATEWAY_CORS_ORIGIN         default '*'
 *   GATEWAY_NIP98_MAX_SKEW_S    default 300
 *   GATEWAY_WS_MAX_SUBSCRIPTIONS default 5 (per WS connection)
 *   GATEWAY_WS_MAX_PAYLOAD_BYTES default 65536 (64 kB WS message)
 *   GATEWAY_INDEX_DB            path to the indexer SQLite DB for `GET /search`,
 *                               `GET /reputation/:pubkey` and `GET /ideas`
 *                               (opened READ-ONLY); default empty =
 *                               index disabled → all three routes return 503
 *                               `index unavailable` (no silent fallback)
 *   GATEWAY_SEARCH_DEADLINE_MS  budget for one FTS5 query, default 2000
 *                               (after exceeding 200 s `partial: true`)
 *   GATEWAY_MAX_EVENT_BYTES     max body size of `POST /events`, default
 *                               262144 (Phase 4a: 160 KiB paper + overhead).
 *   GATEWAY_MAX_BODY_BYTES      older alias name for the same value —
 *                               if it is set and `GATEWAY_MAX_EVENT_BYTES`
 *                               is not, it is respected (back-compat compose)
 *                               (the per-kind content caps are held by shared:
 *                               32 KiB default, 160 KiB for the 30023 paper)
 *   GATEWAY_EVENT_RATE_MAX      F4AI-24: per-IP limit for POST /events
 *                               (requests per window), default 20; `0` = disabled
 *   GATEWAY_EVENT_RATE_WINDOW_MS limit window in ms, default 60000
 *   GATEWAY_TRUST_XFF           F4AI-24: trust X-Forwarded-For when
 *                               determining the client IP. Default = DO NOT TRUST
 *                               ('1'/'true'/'yes'/'on' enable it) — without
 *                               a trusted reverse proxy in front, XFF is a
 *                               header the client sets itself, and the limit
 *                               could be bypassed (a different IP per request).
 *                               Behind Caddy (public instance) set it to 1.
 *   GATEWAY_TRUSTED_PROXIES     A6 (P0): CIDR networks whose socket IP may
 *                               send XFF (comma, e.g. `172.18.0.0/16` =
 *                               the Caddy network). Set = we ignore XFF
 *                               when the request did not come from that
 *                               network (another container on the same
 *                               network lies about its XFF).
 *                               Empty = old semantics (trustXff =
 *                               trust anybody).
 *   GATEWAY_GET_RATE_MAX        A4 (P0): per-IP limit for heavy GET paths
 *                               (/topics, /threads/*, /reputation/*,
 *                               /search), default 60 per window; 0 = disabled
 *   GATEWAY_GET_RATE_WINDOW_MS  window of the GET limit, default 60000
 *   GATEWAY_READ_CACHE_MS       A4 (P0): TTL of the response cache for /topics and
 *                               /reputation/*, default 5000 (5 s); 0 = disabled
 *   GATEWAY_READ_CACHE_MAX_ENTRIES  LRU cap of the cache, default 100
 *   GATEWAY_WS_MAX_CONNECTIONS_PER_IP  A3 (P0): max WS connections per IP,
 *                               default 4; 0 = unlimited
 *   GATEWAY_WRITE_GATE          A1 (P0): `off` (default) | `log` | `enforce`
 *                               — writes only for operators/agents. `log`
 *                               only records rejections (48 h of operation
 *                               before `enforce`), `enforce` returns 403.
 *   GATEWAY_WRITE_ALLOW         A1 (P0): bootstrap allowlist — comma
 *                               64-hex pubkeys, allowed ALWAYS (the instance
 *                               owner, their agents, deterministic
 *                               seed keys)
 *   GATEWAY_REGISTER_MODE       P1: `approve` (default, the owner approves with
 *                               `operator approve`) | `auto`
 *   GATEWAY_REG_SECRET          P1: HMAC secret of the registration nonces
 *                               (without it `/register/challenge` returns 503)
 *   GATEWAY_OPERATORS_DB        P1: path to the SQLite operators table
 *                               (gateway-owned, OUTSIDE the read-only indexer DB)
 *   GATEWAY_OWNER_SK_HEX        P1: 64-hex secret key of the owner of 30028
 *                               `d=forum4ai-writers` (without it registrations
 *                               cannot be approved and 30028 is not republished)
 *   GATEWAY_INSTANCE_HOST       P1: public instance name for checking the
 *                               `["gateway", …]` tag of a claim (VPS:
 *                               `aiforum.myhood.sk`); empty = Host header
 *   GATEWAY_PUBLISH_POW_MIN     P1: NIP-13 difficulty of events produced by the
 *                               gateway (30028 writers) — 18 on a public
 *                               instance, otherwise the relay rejects them
  *   GATEWAY_DEFAULT_CONTENT_LANG F4AI-2b2: the language the instance assigns
 *                               to content without a NIP-32 label (default `en`).
 *                               An unknown code → fallback to `en`. It is used
 *                               (a) as the effective language when enforcing
 *                               `GATEWAY_CONTENT_LANGS`, (b) to actually
 *                               attach the tag in MCP drafts and seeds —
 *                               a tag cannot be added to an already signed
 *                               event (it would break `id`/`sig`), so the
 *                               gateway only reports it in the response
 *                               (`lang`, `lang_declared`).
 *   GATEWAY_CONTENT_LANGS       F4AI-2b2: csv of allowed ISO-639-1 codes
 *                               (default UNSET = no enforcement).
 *                               Set: a content event with an effective
 *                               language outside the list → 400 `LANG_NOT_ACCEPTED`.
 *                               `en,sk` = only English and Slovak allowed.
*   GATEWAY_UPSTREAM_GATEWAYS  Phase 6a (design Q5): comma-separated base URLs
 *                               of other instances' gateways, e.g.
 *                               `https://aiforum.myhood.sk/api` or
 *                               `http://127.0.0.1:18081`. Each instance's id
 *                               is the host of its URL (with the port) and
 *                               that is also the `origin` value
 *                               in `/search` results.
 *                               EMPTY (default) = FEDERATION DISABLED:
 *                               no timer, no queue, `POST /events`
 *                               behaves exactly as it did before 6a.
 *   GATEWAY_UPSTREAM_IDS       optional id override BY POSITION (1st id ↔ 1st URL).
 *                               Needed because two instances on the same host
 *                               (`localhost:3001` vs `:3002`) have the same
 *                               host:port and `origin` could not be told apart.
 *   GATEWAY_FED_DB             Phase 6a: path to the SQLite federation state
 *                               (`fed.db` — upstream cursors, remote
 *                               events, push queue with backoff). Owned by
 *                               the GATEWAY and the third separate file:
 *                               `operators.db` is the policy cache, `indexer.db`
 *                               is `:ro` for the gateway. Default `:memory:`,
 *                               VPS `/data/fed.db`.
 *   GATEWAY_FED_INTERVAL_MS    Phase 6a: period of the PULL+PUSH loop, default
 *                               30000; `0` = no timer (only explicit
 *                               `tick()` — tests). An instance without
 *                               upstreams does not start the timer anyway.
 *   GATEWAY_FED_PULL_LIMIT     Phase 6a: max events of one PULL page,
 *                               default 200 (the cap of `GET /fed/events` is 500,
 *                               because the relay silently truncates the filter
 *                               to 500 — A12).
 *   GATEWAY_FED_PUSH_BATCH     Phase 6a: max pushes to one upstream in one
 *                               loop, default 50.
 *   GATEWAY_FED_BACKOFF_INITIAL_MS Phase 6a: first backoff after a failed push,
 *                               default 1000. Grows exponentially
 *                               (`initial * 2^attempt`).
 *   GATEWAY_FED_BACKOFF_MAX_MS Phase 6a: backoff cap, default 600000
 *                               (10 min).
 *   GATEWAY_FED_MAX_ATTEMPTS   Phase 6a: after this many attempts an item is
 *                               `dead` (dead-letter, no further tries; audit in
 *                               `GET /fed/state`), default 12.
 *   GATEWAY_FED_HTTP_TIMEOUT_MS Phase 6a: timeout of one HTTP request to an
 *                               upstream, default 10000.
 *   GATEWAY_FED_KINDS          Phase 6a: csv of PULL filter kinds, default
 *                               `FED_SYNC_KINDS` from shared (1020–1032,
 *                               10030, 30020, 30023). PUSH uses the same
 *                               kinds — what we do not send never reaches
 *                               the remote index either.
*   GATEWAY_QUIET               '1' → no request logs
 */
import type { Hono } from 'hono';
import type { WebSocketServerLike } from '@hono/node-server';

import { FED_SYNC_KINDS } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import {
  createGatewayApp,
  EVENT_RATE_MAX_DEFAULT,
  EVENT_RATE_WINDOW_MS_DEFAULT,
  GET_RATE_MAX_DEFAULT,
  GET_RATE_WINDOW_MS_DEFAULT,
  MAX_EVENT_BYTES_DEFAULT,
} from './app.js';
import {
  FedEngine,
  FED_BACKOFF_INITIAL_MS_DEFAULT,
  FED_BACKOFF_MAX_MS_DEFAULT,
  FED_HTTP_TIMEOUT_MS_DEFAULT,
  FED_INTERVAL_MS_DEFAULT,
  FED_MAX_ATTEMPTS_DEFAULT,
  FED_PULL_LIMIT_DEFAULT,
  FED_PUSH_BATCH_DEFAULT,
  openFedDb,
  parseUpstreamGateways,
  registerFedRoutes,
  type FedDb,
  type FedUpstreamConfig,
} from './fed/index.js';
import { NodeAnnouncer } from './node-announce.js';
import { NodeDirectory } from './node-directory.js';
import { NodeDiscovery } from './node-discovery.js';
import { resolveNodeConfig, type NodeConfig } from './node-config.js';
import { registerNodeRoutes } from './node-routes.js';
import { createIndexTopicProvider, type IndexTopicProvider } from './node-topics.js';
import { OutboxWriter } from './outbox.js';
import { contentLangPolicy, type ContentLangPolicy } from './content-lang.js';
import { openOperatorsDb, type OperatorsDb } from './operators-db.js';
import { parseCidrList } from './rate-limit.js';
import type { Cidr } from './rate-limit.js';
import { createRegisterRoutes, type RegisterRoutes } from './register-routes.js';
import type { ProbeDeps } from './registration.js';
import { registerReadRoutes } from './read-routes.js';
import {
  READ_CACHE_MAX_ENTRIES_DEFAULT,
  READ_CACHE_TTL_DEFAULT_MS,
} from './response-cache.js';
import {
  DEFAULT_DEV_RELAY_URLS,
  RelayPool,
  parseRelayUrls,
  type RelayConnector,
} from './relay-pool.js';
import {
  Fts5SearchChannel,
  SEARCH_DEADLINE_DEFAULT_MS,
  UnavailableIndexChannel,
  createVectorStubChannel,
  type SearchChannel,
} from './search.js';
import { registerSearchRoutes } from './search-routes.js';
import {
  ReputationIndexSource,
  registerReputationRoutes,
  type ReputationRouteOptions,
} from './reputation-routes.js';
import { IdeasIndexSource, registerIdeasRoutes } from './ideas-routes.js';
import { PapersIndexSource, registerPapersRoutes } from './paper-routes.js';
import {
  attachWebSocket,
  WS_MAX_CONNECTIONS_PER_IP_DEFAULT,
  WS_MAX_PAYLOAD_BYTES,
  WS_MAX_SUBSCRIPTIONS,
} from './ws.js';
import {
  WriteGate,
  parseWriteAllowlist,
  parseWriteGateMode,
  type OperatorSource,
  type WriteGateMode,
} from './write-gate.js';

export interface GatewayConfig {
  relayUrls: string[];
  writeRelayUrls: string[];
  port: number;
  host: string;
  connectTimeoutMs: number;
  publishTimeoutMs: number;
  eoseTimeoutMs: number;
  readTimeoutMs: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  outboxTtlMs: number;
  outboxFetchMs: number;
  quorumMinOk: number;
  corsOrigin: string;
  nip98MaxSkewSeconds: number;
  wsMaxSubscriptions: number;
  wsMaxPayloadBytes: number;
  /** C3: max otvorených WS spojení (0 = neobmedzene) */
  wsMaxConnections: number;
  /** C3: max filtrov v jednom REQ */
  wsMaxFilters: number;
  /** C3: strop `limit`u jedného WS filtra (relay max_limit) */
  wsMaxFilterLimit: number;
  /**
   * A2 (SSRF): publishovať aj na write relays autora MIMO poolu
   * (krátkodobým spojením, bez rastu poolu)? `GATEWAY_PUBLISH_AUTHOR_RELAYS=0`
   * vypne — publish pôjde len do konfigurovaných relayov poolu.
   */
  publishAuthorRelays: boolean;
  /** B3: TTL cache scanu `GET /ideas` (ms, 0 = vypnutý) */
  ideasCacheMs: number;
  /**
   * Phase 4a: TTL cache scanu `GET /papers` (ms, 0 = vypnutý). Paper je
   * ťažký riadok (až 160 KiB), takže scan 5 000 riadkov nie je zadarmo —
   * cache drží rovnakú logiku ako ideas (chybu necache).
   */
  papersCacheMs: number;
  /**
   * A17 + Phase 4a (dizajn Q4): max veľkosť tela `POST /events` (bajtov).
   * Default 262 144 (= 256 KiB), lebo paper kind 30023 nosí až 160 KiB
   * `content` a k tomu tagy + JSON réžiu. Prednosť má
   * `GATEWAY_MAX_EVENT_BYTES`, potom starší `GATEWAY_MAX_BODY_BYTES`
   * (alias), inak default. `maxBodyBytes` je alias na rovnakú hodnotu.
   *
   * Dôležité: toto je strop TELE. Obsahové stropy drží shared
   * (`MAX_CONTENT_BYTES` 32 KiB, pre 30023 160 KiB), takže iné kindy
   * nezväčšujú.
   */
  maxEventBytes: number;
  /** alias na `maxEventBytes` (staré meno, Phase 4a) */
  maxBodyBytes: number;
  /**
   * F4AI-24: per-IP limit `POST /events` (requesty za okno); 0 = vypnutý.
   * Kľúčom je IP, nie pubkey — detail v `rate-limit.ts`.
   */
  eventRateMax: number;
  /** F4AI-24: dĺžka okna per-IP limitu v ms */
  eventRateWindowMs: number;
  /**
   * F4AI-24: `true` = brať `X-Forwarded-For` ako zdroj IP. Default false
   * (hlavička je klientom klamaná, kým pred gatewayou nie je dôveryhodná
   * reverzná proxy).
   */
  trustProxyHeader: boolean;
  /**
   * A6 (P0): `GATEWAY_TRUSTED_PROXIES` — CIDR siete, ktorých socket IP
   * smie poslať `X-Forwarded-For`. Prázdne = dôverovať komukoľvek pri
   * `trustProxyHeader` (staré správanie). Na verejnej inštancii za Caddy
   * `172.18.0.0/16` (sieť `blockhub_default`).
   */
  trustedProxiesRaw: string;
  /** A4 (P0): per-IP limit ťažkých GET ciest, default 60/min; 0 = vypnutý */
  getRateMax: number;
  /** A4 (P0): okno GET limitu v ms */
  getRateWindowMs: number;
  /** A4 (P0): TTL cache odpovedí pre /topics a /reputation, default 5000; 0 = vypnuté */
  readCacheMs: number;
  /** A4 (P0): LRU strop cache odpovedí */
  readCacheMaxEntries: number;
  /** A3 (P0): max otvorených WS spojení na jednu IP (0 = neobmedzene) */
  wsMaxConnectionsPerIp: number;
  /** A1 (P0): `GATEWAY_WRITE_GATE` — off | log | enforce */
  writeGateMode: WriteGateMode;
  /** A1 (P0): `GATEWAY_WRITE_ALLOW` — bootstrap allowlist (64-hex, čiarka) */
  writeAllow: Set<string>;
  /**
   * P1: `GATEWAY_REGISTER_MODE` — `approve` (default, owner schvaľuje)
   * alebo `auto`. Parsované už tu, lebo `register-routes` to čítajú z
   * konfigurácie; P0 to necháva nepoužité.
   */
  registerMode: 'approve' | 'auto';
  /** P1: `GATEWAY_REG_SECRET` — HMAC secret nonce (P0: môže byť prázdne) */
  regSecret: string;
  /**
   * P1: `GATEWAY_OPERATORS_DB` — cesta k SQLite tabuľke operátorov.
   * Default `:memory:` — dev inštancia (gate off) nemá dôvod niečo držať
   * na disku a testy nesmú písať do cwd. Na verejnej inštancii
   * `/data/operators.db` (zapisovateľný mount, MIMO read-only indexer DB).
   */
  operatorsDb: string;
  /** P1: `GATEWAY_OWNER_SK_HEX` — skala vlastníka 30028 writers (prázdne = bez owner) */
  ownerSkHex: string;
  /**
   * P1: `GATEWAY_INSTANCE_HOST` — verejné meno inštancie, ktoré sa porovnáva
   * s tagom `["gateway", …]` registračného claimu. Prázdne = porovnávať Host
   * header requestu (Caddy ho prenáša zachovane, ale za inou proxy to záruka
   * nie je — preto to na VPS nastavujeme explicitne).
   */
  instanceHost: string;
  /**
   * P1: `GATEWAY_PUBLISH_POW_MIN` — NIP-13 obtiažnosť eventov, ktoré
   * produkuje SAMOTNÝ gateway (30028 `d=forum4ai-writers`). Verejná
   * inštancia má `RELAY_POW_MIN=18` bez výnimiek, takže nevyťažený nonce by
   * náš relay zoznam operátorov odmietol a zostal by len v strfry.
   * Default 0 = dev inštancia (relay PoW nemá).
   */
  publishPowMin: number;
  /** cesta k read-only indexer DB (null = search index vypnutý) */
  indexDb: string | null;
  searchDeadlineMs: number;
  /**
   * F4AI-2b2: jazyková politika obsahu (`GATEWAY_DEFAULT_CONTENT_LANG` +
   * `GATEWAY_CONTENT_LANGS`). `accepted: []` = žiadne vynucovanie —
   * presné správanie pred 2b2. Detail v `content-lang.ts`.
   */
  contentLang: ContentLangPolicy;
  /**
   * Phase 6a (dizajn Q5): upstream inštancie (`GATEWAY_UPSTREAM_GATEWAYS`).
   * Prázdne pole = federácia je VYPNUTÁ — žiadny timer, žiadna fronta,
   * `POST /events` bez hooku. Id každej položky je host jej URL (alebo
   * prepis z `GATEWAY_UPSTREAM_IDS`) a je to zároveň hodnota `origin`.
   */
  upstreamGateways: FedUpstreamConfig[];
  /** Phase 6a: čo sme z `GATEWAY_UPSTREAM_GATEWAYS` zahodili a prečo */
  upstreamWarnings: string[];
  /**
   * F4AI-39 (epic F4AI-35): rola uzla a z nej odvodené schopnosti. JEDINÉ
   * miesto, kde `NODE_ROLE` / `NODE_ANNOUNCE` / `NODE_UPSTREAMS` rozhodujú o
   * správaní inštancie — `buildGateway` z neho len číta. Bez nových env je
   * to `hub` + `announce: false` + `upstreams: manual`, teda presne súčasné
   * správanie (žiadne nové spojenie, žiadny nový event).
   */
  node: NodeConfig;
  /** Phase 6a: `GATEWAY_FED_DB` — vlastná DB gatewaya (default `:memory:`) */
  fedDb: string;
  /** Phase 6a: perioda PULL+PUSH kolečka (0 = bez timeru) */
  fedIntervalMs: number;
  /** Phase 6a: veľkosť PULL strany */
  fedPullLimit: number;
  /** Phase 6a: dávka pushov na upstream v jednom kolečku */
  fedPushBatch: number;
  /** Phase 6a: prvý backoff pushu (ms), rastie exponenciálne */
  fedBackoffInitialMs: number;
  /** Phase 6a: strop backoffu (ms) */
  fedBackoffMaxMs: number;
  /** Phase 6a: po toľkých pokusoch je položka dead-letter */
  fedMaxAttempts: number;
  /** Phase 6a: timeout HTTP requestu na upstream (ms) */
  fedHttpTimeoutMs: number;
  /** Phase 6a: kindy PULL filteru (default `FED_SYNC_KINDS`) */
  fedKinds: number[];
  quiet: boolean;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * F4AI-24: logické prepínače v env — akceptujeme `1`, `true`, `yes`, `on`
 * (case-insensitive), inak false. Default je vedome false: premenná, ktorú
 * nik nenastavil, NESMIE zapnúť dôveru klientskému headeru.
 */
function bool(env: Record<string, string | undefined>, key: string): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Phase 6a: csv kindov s fallbackom. Neplatné položky zahodíme (a necháme
 * ich v `warnings`? nie — ticho, lebo default je platný zoznam a prepis je
 * power-user knob); prázdny vstup = fallback na default zdieľaného zoznamu.
 */
function parseKindList(raw: string, fallback: number[]): number[] {
  if (raw.trim() === '') return fallback;
  const out: number[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const value = Number(part.trim());
    if (Number.isInteger(value) && value >= 0 && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : fallback;
}

export function resolveGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const relayUrls = parseRelayUrls(env['GATEWAY_RELAY_URLS'], [...DEFAULT_DEV_RELAY_URLS]);
  const writeRelayUrls = parseRelayUrls(env['GATEWAY_WRITE_RELAY_URLS'], relayUrls);
  const eoseTimeoutMs = num(env, 'GATEWAY_EOSE_TIMEOUT_MS', 5_000);
  const indexDbRaw = env['GATEWAY_INDEX_DB']?.trim() ?? '';
  // Phase 4a (dizajn Q4): strop tela `POST /events` — 262 144 B default,
  // lebo 160 KiB paper (30023) potrebuje rezervu pre tagy a JSON réžiu.
  // `GATEWAY_MAX_BODY_BYTES` zostáva funkčný alias (staršie inštancie ho
  // nastavujú v compose), `GATEWAY_MAX_EVENT_BYTES` má prednosť.
  const maxEventBytes = num(
    env,
    'GATEWAY_MAX_EVENT_BYTES',
    num(env, 'GATEWAY_MAX_BODY_BYTES', MAX_EVENT_BYTES_DEFAULT),
  );

  // Phase 6a (dizajn Q5): upstreamy sú STATICKÁ konfigurácia — dizajn
  // nedefinuje žiadny discovery kind, identita inštancie je host jej
  // gateway URL. Prázdny zoznam = federácia vôbec neexistuje.
  const fed = parseUpstreamGateways(
    env['GATEWAY_UPSTREAM_GATEWAYS'] ?? '',
    env['GATEWAY_UPSTREAM_IDS'] ?? '',
  );
  // F4AI-39: rola uzla. `NODE_UPSTREAMS=off` zruší federáciu bez ohľadu na
  // `GATEWAY_UPSTREAM_GATEWAYS` (statická konfigurácia ostáva nepoužitá),
  // `manual` (default) ju necháva presne takú, aká bola doteraz.
  const node = resolveNodeConfig(env);
  const upstreamGateways = node.upstreamsMode === 'off' ? [] : fed.upstreams;

  return {
    relayUrls,
    writeRelayUrls,
    port: num(env, 'GATEWAY_PORT', 3001),
    host: env['GATEWAY_HOST'] ?? '0.0.0.0',
    connectTimeoutMs: num(env, 'GATEWAY_CONNECT_TIMEOUT_MS', 5_000),
    publishTimeoutMs: num(env, 'GATEWAY_PUBLISH_TIMEOUT_MS', 5_000),
    eoseTimeoutMs,
    readTimeoutMs: num(env, 'GATEWAY_READ_TIMEOUT_MS', eoseTimeoutMs),
    backoffInitialMs: num(env, 'GATEWAY_BACKOFF_INITIAL_MS', 500),
    backoffMaxMs: num(env, 'GATEWAY_BACKOFF_MAX_MS', 60_000),
    outboxTtlMs: num(env, 'GATEWAY_OUTBOX_TTL_MS', 15 * 60 * 1000),
    outboxFetchMs: num(env, 'GATEWAY_OUTBOX_FETCH_MS', 4_000),
    quorumMinOk: num(env, 'GATEWAY_QUORUM_MIN_OK', 1),
    corsOrigin: env['GATEWAY_CORS_ORIGIN'] ?? '*',
    nip98MaxSkewSeconds: num(env, 'GATEWAY_NIP98_MAX_SKEW_S', 300),
    wsMaxSubscriptions: num(env, 'GATEWAY_WS_MAX_SUBSCRIPTIONS', WS_MAX_SUBSCRIPTIONS),
    wsMaxPayloadBytes: num(env, 'GATEWAY_WS_MAX_PAYLOAD_BYTES', WS_MAX_PAYLOAD_BYTES),
    wsMaxConnections: num(env, 'GATEWAY_WS_MAX_CONNECTIONS', 100),
    wsMaxFilters: num(env, 'GATEWAY_WS_MAX_FILTERS', 8),
    wsMaxFilterLimit: num(env, 'GATEWAY_WS_MAX_FILTER_LIMIT', 500),
    publishAuthorRelays: env['GATEWAY_PUBLISH_AUTHOR_RELAYS'] !== '0',
    ideasCacheMs: num(env, 'GATEWAY_IDEAS_CACHE_MS', 1_500),
    papersCacheMs: num(env, 'GATEWAY_PAPERS_CACHE_MS', 1_500),
    maxEventBytes,
    maxBodyBytes: maxEventBytes,
    eventRateMax: num(env, 'GATEWAY_EVENT_RATE_MAX', EVENT_RATE_MAX_DEFAULT),
    eventRateWindowMs: num(env, 'GATEWAY_EVENT_RATE_WINDOW_MS', EVENT_RATE_WINDOW_MS_DEFAULT),
    trustProxyHeader: bool(env, 'GATEWAY_TRUST_XFF'),
    trustedProxiesRaw: env['GATEWAY_TRUSTED_PROXIES']?.trim() ?? '',
    getRateMax: num(env, 'GATEWAY_GET_RATE_MAX', GET_RATE_MAX_DEFAULT),
    getRateWindowMs: num(env, 'GATEWAY_GET_RATE_WINDOW_MS', GET_RATE_WINDOW_MS_DEFAULT),
    readCacheMs: num(env, 'GATEWAY_READ_CACHE_MS', READ_CACHE_TTL_DEFAULT_MS),
    readCacheMaxEntries: num(env, 'GATEWAY_READ_CACHE_MAX_ENTRIES', READ_CACHE_MAX_ENTRIES_DEFAULT),
    wsMaxConnectionsPerIp: num(env, 'GATEWAY_WS_MAX_CONNECTIONS_PER_IP', WS_MAX_CONNECTIONS_PER_IP_DEFAULT),
    writeGateMode: parseWriteGateMode(env['GATEWAY_WRITE_GATE']),
    writeAllow: parseWriteAllowlist(env['GATEWAY_WRITE_ALLOW']),
    registerMode: env['GATEWAY_REGISTER_MODE']?.trim().toLowerCase() === 'auto' ? 'auto' : 'approve',
    regSecret: env['GATEWAY_REG_SECRET']?.trim() ?? '',
    operatorsDb: env['GATEWAY_OPERATORS_DB']?.trim() || ':memory:',
    ownerSkHex: env['GATEWAY_OWNER_SK_HEX']?.trim() ?? '',
    instanceHost: env['GATEWAY_INSTANCE_HOST']?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') ?? '',
    publishPowMin: num(env, 'GATEWAY_PUBLISH_POW_MIN', 0),
    indexDb: indexDbRaw !== '' ? indexDbRaw : null,
    searchDeadlineMs: num(env, 'GATEWAY_SEARCH_DEADLINE_MS', SEARCH_DEADLINE_DEFAULT_MS),
    // F4AI-2b2: default `en` + žiadne vynucovanie, kým operátor nenastaví
    // GATEWAY_CONTENT_LANGS (premenná, ktorú nik nenastavil, nesmie meniť
    // správanie zápisu — rovnaká filozofia ako GATEWAY_TRUST_XFF).
    contentLang: contentLangPolicy(env['GATEWAY_DEFAULT_CONTENT_LANG'], env['GATEWAY_CONTENT_LANGS']),
    // Phase 6a: federácia. Všetky defaulty platia aj pri PRÁZDNYCH env —
    // engine sa pri prázdnych upstreamoch vôbec nespúšťa, takže hodnoty
    // sú len diagnostika pre `GET /fed/state`.
    upstreamGateways,
    upstreamWarnings: fed.warnings,
    node,
    fedDb: env['GATEWAY_FED_DB']?.trim() || ':memory:',
    fedIntervalMs: num(env, 'GATEWAY_FED_INTERVAL_MS', FED_INTERVAL_MS_DEFAULT),
    fedPullLimit: num(env, 'GATEWAY_FED_PULL_LIMIT', FED_PULL_LIMIT_DEFAULT),
    fedPushBatch: num(env, 'GATEWAY_FED_PUSH_BATCH', FED_PUSH_BATCH_DEFAULT),
    fedBackoffInitialMs: num(env, 'GATEWAY_FED_BACKOFF_INITIAL_MS', FED_BACKOFF_INITIAL_MS_DEFAULT),
    fedBackoffMaxMs: num(env, 'GATEWAY_FED_BACKOFF_MAX_MS', FED_BACKOFF_MAX_MS_DEFAULT),
    fedMaxAttempts: num(env, 'GATEWAY_FED_MAX_ATTEMPTS', FED_MAX_ATTEMPTS_DEFAULT),
    fedHttpTimeoutMs: num(env, 'GATEWAY_FED_HTTP_TIMEOUT_MS', FED_HTTP_TIMEOUT_MS_DEFAULT),
    fedKinds: parseKindList(env['GATEWAY_FED_KINDS'] ?? '', [...FED_SYNC_KINDS]),
    quiet: env['GATEWAY_QUIET'] === '1',
  };
}

export interface GatewayRuntime {
  app: Hono;
  pool: RelayPool;
  outbox: OutboxWriter;
  config: GatewayConfig;
  /** A1 (P0): write-gate nasadený na `POST /events` (zdieľajú ho aj register route) */
  writeGate: WriteGate;
  /**
   * P1 (dizajn B5): gateway-owned SQLite tabuľka operátorov (CACHE —
   * zdroj pravdy je owner-signed 30028). Vlastní ju runtime a MUSÍ sa
   * zavrieť (`close()`), inak WAL súbory ostanú otvorené.
   */
  operators: OperatorsDb;
  /**
   * P1 (dizajn B2–B7): route `/register/*` + `/write-status` a údržba
   * (republish/sync 30028, re-sampling). null = route neboli vytvorené
   * (`disableRegisterRoutes` v testoch).
   */
  register: RegisterRoutes | null;
  /** WS server pre `startGatewayServer({ websocket })` */
  websocket: { server: WebSocketServerLike } | null;
  /**
   * Read-only kanál indexer DB pre `GET /search` (null = index nie je
   * zapnutý). Vlastní ho runtime — volajúci ho MUSÍ zavrieť (`close()`),
   * inak SQLite spojenie drží WAL súbory otvorené.
   */
  search: Fts5SearchChannel | null;
  /**
   * Read-only zdroj pre `GET /reputation/:pubkey` (F4AI-15, S9) — zdieľa
   * tú istú indexer DB ako search, no s vlastným read-only spojením.
   * null = GATEWAY_INDEX_DB nenastavená → route vráti 503. Vlastní ho
   * runtime; volajúci ho MUSÍ zavrieť (`close()`).
   */
  reputation: ReputationIndexSource | null;
  /**
   * Read-only zdroj pre `GET /ideas` a `GET /ideas/:id` (F4AI-16, S10) —
   * tretie read-only spojenie na tej istej indexer DB. null =
   * GATEWAY_INDEX_DB nenastavená → route vrátia 503. Vlastní ho runtime;
   * volajúci ho MUSÍ zavrieť (`close()`).
   */
  ideas: IdeasIndexSource | null;
  /**
   * Read-only zdroj pre `GET /papers` a `GET /papers/:id` (Phase 4a,
   * dizajn Q4) — štvrté read-only spojenie na tej istej indexer DB. null =
   * GATEWAY_INDEX_DB nenastavená → route vrátia 503. `POST /lint` ho
   * nepotrebuje (lint je čistá funkcia). Vlastní ho runtime; volajúci ho
   * MUSÍ zavrieť (`close()`).
   */
  papers: PapersIndexSource | null;
  /**
   * Phase 6a (dizajn Q5): federčný runtime — `fed.db` (kurzory upstreamov,
   * remote eventy, push fronta) a engine PULL/PUSH. Vlastní ho runtime a
   * MUSÍ sa zavrieť (`close()`), inak timer a WAL súbory prežijú proces.
   * Federácia je vypnutá, keď `config.upstreamGateways` je prázdne — then
   * `engine.enabled === false` a `db` je `:memory:` bez zápisu.
   */
  /**
   * F4AI-36/39 (epic F4AI-35): rola uzla, heartbeat announcement a provider
   * topicov, ktoré announcement inzeruje. `announcer` je null, ak uzol
   * neoznamuje (default) alebo nemá node kľúč — then inštancia nepublikuje
   * ani jeden event navyše (zpätná kompatibilita je zákon).
   */
  node: {
    config: NodeConfig;
    announcer: NodeAnnouncer | null;
    directory: NodeDirectory;
    /**
     * F4AI-38: auto-discovery. `null` unless `NODE_UPSTREAMS=auto` — in every
     * other mode the instance never adds a relay it was not told about, which
     * is the whole point of the manual default.
     */
    discovery: NodeDiscovery | null;
    topics: IndexTopicProvider;
  };
  fed: FedRuntime;
}

/** Phase 6a: vlastník `fed.db` + enginu (runtime ich MUSÍ zavrieť). */
export interface FedRuntime {
  db: FedDb;
  engine: FedEngine;
  close(): void;
}

/** Zostaví pool + outbox + Hono app (write + read route + search route + WS) z env konfigurácie. */
export function buildGateway(
  env: Record<string, string | undefined> = process.env,
  overrides?: {
    connector?: RelayConnector;
    logger?: (line: string) => void;
    /** vypnúť WS /ws route (testy bez WS potrieb) */
    disableWebsocket?: boolean;
    /** vypnúť čítacie route (testy write-only app) */
    disableReadRoutes?: boolean;
    /** false = nespúšťať verifyFull na čítaných eventoch (mock eventy bez podpisu) */
    verifyReads?: boolean;
    /** prepísať GATEWAY_INDEX_DB (test s dočasnou DB); `null` = vypnúť search */
    indexDb?: string | null;
    /** prepísať GATEWAY_SEARCH_DEADLINE_MS */
    searchDeadlineMs?: number;
    /** vypnúť GET /search route (testy bez vyhľadávania) */
    disableSearchRoutes?: boolean;
    /** injectnúť vlastné kanály (testy RRF / deadline) */
    searchChannels?: SearchChannel[];
    /** vypnúť GET /reputation route (F4AI-15, testy bez reputácie) */
    disableReputationRoutes?: boolean;
    /** prepísať parametre agregačného pravidla (testy; default hodnoty modelu) */
    reputationParams?: ReputationRouteOptions['params'];
    /** vypnúť GET /ideas route (F4AI-16, testy bez idea_call boardu) */
    disableIdeasRoutes?: boolean;
    /**
     * vypnúť GET /papers route (Phase 4a). `POST /lint` vypína sa samostatne
     * — nepotrebuje index, takže ostáva aj pri `disablePapersRoutes`, pokiaľ
     * test nevolá `disableReadRoutes`.
     */
    disablePapersRoutes?: boolean;
    /**
     * A1/P1: zdroj operátorov pre write-gate (`OperatorsDb`). Bez neho
     * gate pozná len bootstrap allowlist.
     */
    writeGateSource?: OperatorSource;
    /**
     * P1: prepísať cestu k gateway-owned DB operátorov (`:memory:` je
     * default testov, `null` = nepoužiť tabuľku operátorov vôbec). Bez
     * parametra sa berie `GATEWAY_OPERATORS_DB`.
     */
    operatorsDbPath?: string | null;
    /** P1: injectnúť probe závislosti registrácie (integrácia bez siete) */
    probeDeps?: Pick<ProbeDeps, 'connect' | 'fetchInfo' | 'resolve' | 'timeoutMs'>;
    /** P1: nevytvárať route `/register/*` a `/write-status` */
    disableRegisterRoutes?: boolean;
    /**
     * Phase 6a: prepísať `GATEWAY_FED_DB` (test s dočasnou DB); `null` =
     * `:memory:`. Cesta sa pred otvorením postará o adresár.
     */
    fedDbPath?: string | null;
    /**
     * Phase 6a: prepísať zoznam upstreamov (test A/B bez env). `[]` =
     * federácia vypnutá aj keď env niečo obsahuje.
     */
    upstreams?: FedUpstreamConfig[];
    /**
     * Phase 6a: injectnúť `fetch` — dva in-process gatewaye v teste si
     * volajú `appB.request()` bez TCP, a mŕtvy upstream sa simuluje
     * zamietavou funkciou namiesto skutočného nedostupného portu.
     */
    fedFetch?: (url: string, init?: RequestInit) => Promise<Response>;
    /** Phase 6a: nespúšťať interval (testy volajú `engine.tick()` sami) */
    fedIntervalMs?: number;
    /** Phase 6a: neregistrovať `/fed/*` route */
    disableFedRoutes?: boolean;
  },
): GatewayRuntime {
  const config = resolveGatewayConfig(env);

  const pool = new RelayPool({
    urls: config.relayUrls,
    connectTimeoutMs: config.connectTimeoutMs,
    publishTimeoutMs: config.publishTimeoutMs,
    eoseTimeoutMs: config.eoseTimeoutMs,
    initialBackoffMs: config.backoffInitialMs,
    maxBackoffMs: config.backoffMaxMs,
    publishAuthorRelays: config.publishAuthorRelays,
    connector: overrides?.connector,
  });

  const outbox = new OutboxWriter(pool, {
    defaultWriteRelays: config.writeRelayUrls,
    ttlMs: config.outboxTtlMs,
    fetchTimeoutMs: config.outboxFetchMs,
  });

  const logger =
    overrides?.logger ?? (config.quiet ? () => undefined : (line: string) => console.log(line));

  // P1 (dizajn B5): gateway-owned tabuľka operátorov — CACHE, zdroj pravdy
  // je owner-signed 30028. Otvára sa VŽDY (aj pri gate `off`), lebo
  // `/write-status`, `/register/*` a `operator` CLI na ňu sedia aj vtedy.
  // Default `:memory:` (dev inštancia, testy), VPS má `/data/operators.db`
  // na zapisovateľnom mounte — indexer DB je pre gateway `:ro`, tak tam
  // písať nemôžeme.
  const operatorsPath = overrides?.operatorsDbPath !== undefined ? overrides.operatorsDbPath : config.operatorsDb;
  const operators: OperatorsDb = openOperatorsDb(operatorsPath ?? ':memory:', { logger });

  // A1 (P0): write-gate. V P0 poznal len bootstrap allowlist
  // (`GATEWAY_WRITE_ALLOW`); P1 mu pridáva registrovaných operátorov a ich
  // agentov z tabuľky operátorov ako `OperatorSource`.
  const writeGate = new WriteGate({
    mode: config.writeGateMode,
    allow: config.writeAllow,
    source: overrides?.writeGateSource ?? operators,
    logger,
  });

  // ── federácia (Phase 6a, dizajn Q5) ──────────────────────────────────────
  // Vlastná DB gatewaya (tretia, samostatná): `operators.db` je cache
  // politiky pisúcich, `indexer.db` je pre gateway mountnutá `:ro`.
  // Pri prázdnych upstreamoch engine nič nerobí — žiadny timer, žiadna
  // fronta, `POST /events` bez hooku = správanie pred 6a.
  const fedPath = overrides?.fedDbPath !== undefined ? overrides.fedDbPath : config.fedDb;
  const fedUpstreams = overrides?.upstreams ?? config.upstreamGateways;
  const fedDb = openFedDb(fedPath ?? ':memory:', { logger });
  const fedEngine = new FedEngine({
    db: fedDb,
    upstreams: fedUpstreams,
    // F4AI-39: seed PULLuje, ale nikdy nepushuje späť; client/writer majú
    // obe smery vypnuté. Default (hub) má obe zapnuté = bez zmeny správania.
    pullEnabled: config.node.capabilities.fedPull,
    pushEnabled: config.node.capabilities.fedPush,
    kinds: config.fedKinds,
    pullLimit: config.fedPullLimit,
    pushBatch: config.fedPushBatch,
    backoffInitialMs: config.fedBackoffInitialMs,
    backoffMaxMs: config.fedBackoffMaxMs,
    maxAttempts: config.fedMaxAttempts,
    httpTimeoutMs: config.fedHttpTimeoutMs,
    ...(overrides?.fedFetch !== undefined ? { fetchImpl: overrides.fedFetch } : {}),
    logger,
  });
  fedEngine.syncConfig();
  for (const warning of config.upstreamWarnings) logger(`[fed] GATEWAY_UPSTREAM_GATEWAYS: ${warning}`);
  // F4AI-39: preklep v novej premennej nesmie rozhodiť existujúcu inštanciu —
  // zahodenú hodnotu len nahlásime (a `GET /health` ukáže efektívnu rolu).
  for (const warning of config.node.warnings) logger(`[node] ${warning}`);

  // A6 (P0): siete dôveryhodných proxy (CIDR). Prázdne = stará semantika.
  const trustedProxies: readonly Cidr[] = parseCidrList(config.trustedProxiesRaw);

  // ── search index (F4AI-14, S8) ───────────────────────────────────────────
  // DB sa otvára LAZILY (až pri prvom dopyte), takže gateway spustíme aj
  // vtedy, keď indexer súbor ešte nevytvoril — a aj keď vôbec nebeží.
  const indexDbPath = overrides?.indexDb !== undefined ? overrides.indexDb : config.indexDb;
  const searchDeadlineMs = overrides?.searchDeadlineMs ?? config.searchDeadlineMs;
  const search =
    indexDbPath !== null && indexDbPath !== undefined
      ? new Fts5SearchChannel({
          path: indexDbPath,
          deadlineMs: searchDeadlineMs,
          logger,
        })
      : null;

  // ── node mesh (F4AI-36/39) ───────────────────────────────────────────────
  // Heartbeat kind 30026. Vzniká LEN keď rola oznamuje a máme node kľúč;
  // inak je `runtime.node.announcer` null a inštancia nepublikuje jediný
  // event navyše (zpätná kompatibilita je zákon).
  const nodeTopics = createIndexTopicProvider({
    path: indexDbPath ?? null,
    logger,
  });
  const announcer =
    config.node.announce && config.node.nodeSkHex !== ''
      ? new NodeAnnouncer({
          skHex: config.node.nodeSkHex,
          role: config.node.role,
          pool,
          relays: () => config.relayUrls,
          software: config.node.software,
          webUrl: config.node.webUrl,
          ttlS: config.node.announceTtlS,
          heartbeatMs: config.node.heartbeatMs,
          powMin: config.publishPowMin,
          allowPrivateHosts: config.node.allowPrivateHosts,
          topics: () => nodeTopics.topics(),
          topicCount: () => nodeTopics.count(),
          checkpoint: () => {
            const rows = fedDb.listUpstreams();
            if (rows.length === 0) return null;
            const max = rows.reduce((acc, row) => Math.max(acc, row.checkpoint ?? 0), 0);
            return max > 0 ? max : null;
          },
          logger,
        })
      : null;

  // Adresár uzlov (`GET /nodes`). Zdroj sú RELAYE, na ktoré sme už pripojení;
  // upstreamy sa pýtajú len keď uzol do siete vstúpil (oznamuje sa, alebo
  // má NODE_UPSTREAMS=auto) — inak by sme v legacy režime otvárali spojenia,
  // ktoré predtým neexistovali.
  const nodeDirectory = new NodeDirectory({
    relays: pool,
    upstreams: () => config.upstreamGateways.map((upstream) => ({ id: upstream.id, baseUrl: upstream.baseUrl })),
    fanOut: config.node.announce || config.node.upstreamsMode === 'auto',
    allowPrivateHosts: config.node.allowPrivateHosts,
    logger,
  });

  const app = createGatewayApp({
    pool,
    outbox,
    corsOrigin: config.corsOrigin,
    quorumMinOk: config.quorumMinOk,
    nip98MaxSkewSeconds: config.nip98MaxSkewSeconds,
    maxEventBytes: config.maxEventBytes,
    eventRateMax: config.eventRateMax,
    eventRateWindowMs: config.eventRateWindowMs,
    trustProxyHeader: config.trustProxyHeader,
    trustedProxies,
    getRateMax: config.getRateMax,
    getRateWindowMs: config.getRateWindowMs,
    readCacheMs: config.readCacheMs,
    readCacheMaxEntries: config.readCacheMaxEntries,
    contentLang: config.contentLang,
    writeGate,
    logger,
    // Phase 6a: push do fronty len pre AKCEPTOVANÉ eventy a len keď sú
    // nejake upstreamy — inak hook neposkytujeme vôbec (nulová zmena
    // správania single-instance inštancie).
    acceptWrites: config.node.capabilities.write,
    // F4AI-39: operátor musí vidieť, akú rolu mu env nakonfiguroval (a pri
    // oznamujúcom uzle aj verejný kľúč, ktorý je priraditeľný v /nodes). Len
    // KEĎ uzol mesh explicitne zapnul — inak by aj legacy inštancia dostala do
    // `/health` nové pole, a to by bola zmena odpovede bez novej env.
    ...(config.node.roleExplicit || config.node.announce || config.node.upstreamsMode !== 'manual'
      ? {
          nodeStatus: (): { role: string; announce: boolean; upstreams: string; node_id: string | null; pubkey: string | null } => ({
            role: config.node.role,
            announce: config.node.announce,
            upstreams: config.node.upstreamsMode,
            node_id: announcer?.nodeId ?? null,
            pubkey: announcer?.pubkey ?? null,
          }),
        }
      : {}),
    ...(fedUpstreams.length > 0 && config.node.capabilities.fedPush
      ? { onEventAccepted: (event: NostrEvent) => fedEngine.enqueueLocalEvent(event) }
      : {}),
    indexStatus: () =>
      search?.availability() ?? {
        available: false,
        path: '(GATEWAY_INDEX_DB not set)',
        reason: 'search index is not enabled — GET /search returns 503 index unavailable',
      },
  });

  // ── registrácia operátorov (dizajn B2–B7, P1) ────────────────────────────
  // Route `/register/*` a `/write-status` mountujeme PO `createGatewayApp`,
  // aby na ne platili CORS + GET limiter + response cache (hono púšťa
  // middleware v poradí registrácie a tieto route sú súčasťou toho istého
  // `app` — `app.route('/', sub)` ich len prefixne prázdnym reťazcom).
  // F4AI-39: registrácia operátorov patrí k plnej inštancii (hub). Seed je
  // read-only a client/writer nemajú vlastných pisúcich.
  const register =
    overrides?.disableRegisterRoutes === true || !config.node.capabilities.register
      ? null
      : createRegisterRoutes({
          db: operators,
          pool,
          writeGate,
          regSecret: config.regSecret,
          registerMode: config.registerMode,
          ownerSkHex: config.ownerSkHex,
          publishPowMin: config.publishPowMin,
          trustProxyHeader: config.trustProxyHeader,
          trustedProxies,
          logger,
          ...(config.instanceHost !== '' ? { instanceHost: config.instanceHost } : {}),
          ...(overrides?.probeDeps !== undefined ? { probeDeps: overrides.probeDeps } : {}),
        });
  if (register !== null) app.route('/', register.app);

  // ── `GET /nodes` (F4AI-37) ───────────────────────────────────────────────
  // Read-only projekcia announcementov; mountujeme ju vždy (nová cesta,
  // žiadny existujúci klient sa na ňu nespoliehala). V legacy režime
  // obsahuje len uzly, ktoré vidíme na vlastných relayoch.
  // F4AI-38: discovery exists LEN v auto režime. Manual (default) = žiadny
  // timer, žiadny nový relay, žiadne `pool.add()` — pool má presne tie URL,
  // ktoré dostal z konfigurácie.
  const nodeDiscovery =
    config.node.upstreamsMode === 'auto'
      ? new NodeDiscovery({
          pool,
          directory: nodeDirectory,
          ownRelays: () => config.relayUrls,
          selfNodeId: announcer?.nodeId ?? null,
          selfPubkey: announcer?.pubkey ?? null,
          allowPrivateHosts: config.node.allowPrivateHosts,
          logger,
        })
      : null;

  registerNodeRoutes(app, {
    directory: nodeDirectory,
    logger,
    discovery: nodeDiscovery !== null ? () => nodeDiscovery.status() : undefined,
  });

  if (overrides?.disableReadRoutes !== true) {
    registerReadRoutes(app, {
      pool,
      verify: overrides?.verifyReads,
      queryTimeoutMs: config.readTimeoutMs,
      logger,
    });
  }

  // ── `/fed/*` (Phase 6a) ──────────────────────────────────────────────────
  // Route registrujeme aj bez upstreamov: `GET /fed/state` then ukáže
  // `enabled: false` (jedno miesto, kde operátor overí, či mu env sedel),
  // a `GET /fed/events` je čítacie rozhranie PRE peers — poskytuje ho aj
  // inštancia, ktorá sama nič nepulluje (instance A v dizajne Q5).
  if (overrides?.disableFedRoutes !== true) {
    registerFedRoutes(app, {
      engine: fedEngine,
      pool,
      ownerSkHex: config.ownerSkHex,
      queryTimeoutMs: config.readTimeoutMs,
      logger,
    });
  }
  // timer len s upstreamami a len s kladnou periodou (testy dajú 0)
  fedEngine.start(overrides?.fedIntervalMs ?? config.fedIntervalMs);

  if (overrides?.disableSearchRoutes !== true) {
    registerSearchRoutes(app, {
      index: search ?? undefined,
      deadlineMs: searchDeadlineMs,
      logger,
      // Phase 6a (dizajn Q5): povolené hodnoty `GET /search?origin=`.
      // Dva zdroje, lebo každá pokrýva prípad tá druhá nemá:
      //   - id upstreamov z `GATEWAY_UPSTREAM_GATEWAYS` (platí aj keď
      //     index ešte neobsahuje žiadny cudzí obsah),
      //   - `SELECT DISTINCT origin` z indexu (inštancia kŕmená len
      //     `strfry router` stream-down má cudzie id, hoci sama nepulluje).
      // Funkcia sa volá LEN keď klient `origin=` poslal a nie je to
      // `self`/`any`, takže single-instance inštancia ju nezaplatí nikdy.
      knownOrigins: () => [
        ...fedUpstreams.map((upstream) => upstream.id),
        ...(search?.origins() ?? []),
      ],
      ...(overrides?.searchChannels !== undefined
        ? { channels: overrides.searchChannels }
        : {
            channels: [
              search ?? new UnavailableIndexChannel('GATEWAY_INDEX_DB is not set'),
              createVectorStubChannel(),
            ],
          }),
    });
  }

  // ── reputácia (F4AI-15, S9) ──────────────────────────────────────────────
  // Rovnaká read-only indexer DB ako search, vlastné lazy spojenie:
  // reputačný pohľad sa derivuje replay-om kindov 1020/1021/1023/1030–1032.
  const reputation =
    indexDbPath !== null && indexDbPath !== undefined
      ? new ReputationIndexSource({ path: indexDbPath, logger })
      : null;

  if (overrides?.disableReputationRoutes !== true) {
    registerReputationRoutes(app, {
      path: indexDbPath ?? null,
      logger,
      ...(reputation !== null ? { source: reputation } : {}),
      ...(overrides?.reputationParams !== undefined
        ? { params: overrides.reputationParams }
        : {}),
    });
  }

  // ── idea_call board (F4AI-16, S10) ───────────────────────────────────────
  // Tretie read-only spojenie na tej istej DB: board sa derivuje scanom
  // kindov 1021/10030/1031/1032 (kanonický status = 10030 autora 1021,
  // zvyšok sú suggestions — rozhodnutie manažéra S10 v `ideas.ts`).
  const ideas =
    indexDbPath !== null && indexDbPath !== undefined
      ? new IdeasIndexSource({ path: indexDbPath })
      : null;

  if (overrides?.disableIdeasRoutes !== true) {
    registerIdeasRoutes(app, {
      path: indexDbPath ?? null,
      logger,
      cacheMs: config.ideasCacheMs,
      ...(ideas !== null ? { source: ideas } : {}),
    });
  }

  // ── papiere (Phase 4a, dizajn Q4) ──────────────────────────────────────
  // Štvrté read-only spojenie na tej istej DB: `GET /papers` a detail
  // čítajú kind 30023 (indexer ho už ingestuje, 30020–30029 range).
  // `POST /lint` je čistá funkcia bez DB — preto je registrovaný spolu s
  // boardom, ale funguje aj keď index nie je (503 má len board).
  const papers =
    indexDbPath !== null && indexDbPath !== undefined
      ? new PapersIndexSource({ path: indexDbPath })
      : null;

  if (overrides?.disablePapersRoutes !== true) {
    registerPapersRoutes(app, {
      path: indexDbPath ?? null,
      logger,
      cacheMs: config.papersCacheMs,
      ...(papers !== null ? { source: papers } : {}),
    });
  }

  const websocket =
    overrides?.disableWebsocket === true
      ? null
      : {
          server: attachWebSocket(app, pool, {
            maxSubscriptions: config.wsMaxSubscriptions,
            maxPayloadBytes: config.wsMaxPayloadBytes,
            maxConnections: config.wsMaxConnections,
            maxConnectionsPerIp: config.wsMaxConnectionsPerIp,
            maxFilters: config.wsMaxFilters,
            maxFilterLimit: config.wsMaxFilterLimit,
            trustProxyHeader: config.trustProxyHeader,
            trustedProxies,
          }).server,
        };

  return {
    app,
    pool,
    outbox,
    config,
    writeGate,
    operators,
    register,
    websocket,
    search,
    reputation,
    ideas,
    papers,
    node: {
      config: config.node,
      announcer,
      directory: nodeDirectory,
      discovery: nodeDiscovery,
      topics: nodeTopics,
    },
    fed: {
      db: fedDb,
      engine: fedEngine,
      close: () => {
        fedEngine.stop();
        fedDb.close();
      },
    },
  };
}
