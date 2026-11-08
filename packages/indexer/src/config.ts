/**
 * Indexer env configuration (F4AI-13, S7) — single source of truth for both
 * the CLI and the tests, same pattern as `packages/gateway/src/config.ts`.
 *
 * Variables (defaults are the dev values from the task brief):
 *   INDEXER_DB                        path to the SQLite database, default 'indexer.db'
 *                                     (':memory:' = in-memory, tests only)
 *   INDEXER_RELAY_URLS                relay list (comma/space), default
 *                                     dev relays ws://127.0.0.1:18080 and :18008
 *   INDEXER_KINDS                     csv of kinds for subscribe/backfill,
 *                                     default DEFAULT_INDEXER_KINDS
 *   INDEXER_BACKFILL_BATCH            limit of one REQ side, default 500
 *   INDEXER_BACKFILL_WINDOW_S         initial backfill window width, default 0 =
 *                                     whole timeline (a saturated window is adaptively split)
 *   INDEXER_BACKFILL_MAX_WINDOWS      insurance against infinity, default 2 000
 *   INDEXER_ANTI_ENTROPY_INTERVAL_S   anti-entropy period, default 300 (0 = timer off)
 *   INDEXER_ANTI_ENTROPY_IDS          M most recent ids verified by the wheel, default 500
 *   INDEXER_ANTI_ENTROPY_LOOKBACK_S   since-sweep lookback range, default 300 (5 min)
 *   INDEXER_LIVE_OVERLAP_S            live subscription overlap into the past, default 300
 *   INDEXER_QUERY_TIMEOUT_MS          timeout of one REQ (EOSE), default 10 000
 *   INDEXER_CONNECT_TIMEOUT_MS        WS connect timeout, default 5 000
 *   INDEXER_CACHE_CAPACITY            S3-FIFO cache capacity for anti-entropy, default 4 096
 *   INDEXER_REQUIRE_REGISTRY          '1' = strict L2 policy (rejects anything
 *                                     outside the shared registry — since F4AI-14 (S8) the
 *                                     registry also contains the NIP-01 core kinds 0 and 3,
 *                                     so strict mode accepts them);
 *                                     default '0' = structure + kind rules,
 *                                     kinds outside the registry are accepted if they
 *                                     are explicitly in INDEXER_KINDS
 *   INDEXER_VERBOSE_INVALID           '1' = log EVERY invalid event (default
 *                                     we log the first occurrence per reason + every 1000th)
 *   INDEXER_WRITE_ALLOW               P1 (design B9): csv of 64-hex pubkeys that
 *                                     MAY be indexed — the same as
 *                                     `GATEWAY_WRITE_ALLOW`. Empty +
 *                                     INDEXER_OPERATORS_DB null = filter
 *                                     EVERYTHING (dev instance)
 *   INDEXER_OPERATORS_DB              P1: read-only path to the gateway
 *                                     `operators.db` (registered operators
 *                                     thus get into the index without a restart)
 *   INDEXER_QUIET                     '1' = no logs
 *
 * Phase 6a (design Q5 — federation):
 *   INDEXER_TRUST_DIRECTORIES         comma-separated foreign-instance directories,
 *                               entry `<A owner hex>` or
 *                               `<id>=<A owner hex>`. The indexer pulls the
 *                               A-owner-signed 30028
 *                               `d=forum4ai-writers` and the operator's `d=agents`
 *                               from its local relays and ADDS their pubkeys to
 *                               the index allowlist.
 *                               Never a write-gate (Q5 forbids that).
 *                               Directory pubkeys are indexed with
 *                               `origin = <instance id>` and `trusted = 0`.
 *                               EMPTY (default) = no trust in foreign
 *                               directories, behavior exactly as before 6a.
 *   INDEXER_TRUST_REFRESH_S   how often directories are refreshed from relays,
 *                               default 300 (5 min)
 *   INDEXER_FED_DB            read-only path to the gateway `fed.db`
 *                               (`GATEWAY_FED_DB`). If it exists, the sweep
 *                               copies `remote_events` (PULL from upstream)
 *                               into indexer.db with the upstream `origin` and
 *                               `trusted = 0`. Reason: remote events never
 *                               reach the local relays (that is the strfry
 *                               router's job), so without the sweep they would
 *                               never appear in `/search`. Default null =
 *                               sweep disabled.
 *   INDEXER_FED_INTERVAL_S    sweep period, default 15 (0 = only at startup
 *                               and on an explicit call)
 *   INDEXER_FED_BATCH         max remote events of one sweep, default 500
 */
import { DEFAULT_DEV_RELAY_URLS, RelayPool, parseRelayUrls } from '@forum4ai/gateway';

import { IndexerDb, openIndexerDb } from './db.js';
import { IndexerIngestor, type IngestPool } from './ingest.js';
import { parseWriteAllow } from './operators.js';
import { TRUST_REFRESH_MS_DEFAULT, parseTrustDirectories, type TrustDirectory } from './trust.js';

function kindRange(from: number, to: number): number[] {
  const kinds: number[] = [];
  for (let kind = from; kind <= to; kind += 1) kinds.push(kind);
  return kinds;
}

/**
 * Default kindy podľa zadania F4AI-13: forum kindy 1020–1059, replaceable
 * 10030/10031, addressable 30020–30029, 30400/30401 a NIP-01 replaceable
 * 0 (set-metadata) a 3 (contacts).
 *
 * Pozn.: range 1020–1059 je nadmnožina shared registry (rovnako ako
 * `DEFAULT_ALLOWED_KINDS` nášho relaya) — kindy mimo registry indexujeme
 * len ak to dovoľuje `INDEXER_REQUIRE_REGISTRY=0` (default), inak padajú
 * na L2 validácii. 27235 (NIP-98 auth) a 10002 (relay info) zámerne nie sú:
 * ephemeral, respektíve informačný document.
 */
export const DEFAULT_INDEXER_KINDS: readonly number[] = [
  0,
  3,
  ...kindRange(1020, 1059),
  10030,
  10031,
  ...kindRange(30020, 30029),
  30400,
  30401,
];

export interface IndexerConfig {
  dbPath: string;
  relayUrls: string[];
  kinds: number[];
  backfillBatch: number;
  backfillWindowS: number;
  backfillMaxWindows: number;
  antiEntropyIntervalMs: number;
  antiEntropyIds: number;
  antiEntropyLookbackS: number;
  liveOverlapS: number;
  queryTimeoutMs: number;
  connectTimeoutMs: number;
  cacheCapacity: number;
  requireRegistry: boolean;
  verboseInvalid: boolean;
  /**
   * P1 (dizajn B9): allowlist pisúcich pre INGEST. Prázdne + `operatorsDb`
   * null = filter vypnutý (indexujeme všetko — dev inštancia). Na verejnej
   * inštancii tie isté pubkey ako `GATEWAY_WRITE_ALLOW`, lebo strfry vie
   * event dostať aj peer synchronizáciou a gateway by ho síce zamietol,
   * ale indexer by ho indexoval.
   */
  writeAllow: string[];
  /** P1: read-only cesta k gateway `operators.db` (null = nepoužiť) */
  operatorsDb: string | null;
  /**
   * Phase 6a (dizajn Q5): adresáre cudzích inštancií
   * (`INDEXER_TRUST_DIRECTORIES`). Pubkeyy z nich sa sčítavajú do
   * INDEXOVÉHO allowlistu a ich obsah sa indexuje s `origin` = id inštancie
   * a `trusted = 0`. Prázdne = správanie pred 6a.
   */
  trustDirectories: TrustDirectory[];
  /** Phase 6a: čo sme z `INDEXER_TRUST_DIRECTORIES` zahodili a prečo */
  trustWarnings: string[];
  /** Phase 6a: perioda obnovy adresárov (ms) */
  trustRefreshMs: number;
  /**
   * Phase 6a: read-only cesta k gateway `fed.db` (null = sweep remote
   * eventov vypnutý). Indexer je JEDINÝ writer do indexer.db, preto sweep
   * beží tu a nie v gatewayi — rovnaké pravidlo ako pri FTS5 triggeroch.
   */
  fedDb: string | null;
  /** Phase 6a: perioda sweepu `remote_events` → indexer.db (ms, 0 = bez timeru) */
  fedIntervalMs: number;
  /** Phase 6a: dávka jedného sweepu */
  fedBatch: number;
  quiet: boolean;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Kladné celé číslo; neplatná hodnota → fallback (rovnaká tolerancia ako gateway). */
function int(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const value = num(env, key, fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Nezáporné celé číslo (0 je platná hodnota = vypnutý timer / adaptívne okno). */
function nonNeg(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const value = num(env, key, fallback);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function parseKinds(value: string | undefined, fallback: readonly number[]): number[] {
  const raw = (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const source = raw.length > 0 ? raw : [...fallback];
  const out: number[] = [];
  for (const item of source) {
    const kind = Number(item);
    if (Number.isInteger(kind) && kind >= 0 && kind <= 4_294_967_295 && !out.includes(kind)) {
      out.push(kind);
    }
  }
  return out.length > 0 ? out : [...fallback];
}

export function resolveIndexerConfig(
  env: Record<string, string | undefined> = process.env,
): IndexerConfig {  const queryTimeoutMs = int(env, 'INDEXER_QUERY_TIMEOUT_MS', 10_000);
  // Phase 6a: adresáre parsované JEDNOKRÁTTE — `warnings` aj `directories`
  // musia pochádzať z toho istého výpočtu, inak by sa mohli líšiť
  const trust = parseTrustDirectories(env['INDEXER_TRUST_DIRECTORIES']);
  return {
    dbPath: env['INDEXER_DB'] !== undefined && env['INDEXER_DB'].trim() !== ''
      ? env['INDEXER_DB'].trim()
      : 'indexer.db',
    relayUrls: parseRelayUrls(env['INDEXER_RELAY_URLS'], [...DEFAULT_DEV_RELAY_URLS]),
    kinds: parseKinds(env['INDEXER_KINDS'], DEFAULT_INDEXER_KINDS),
    backfillBatch: int(env, 'INDEXER_BACKFILL_BATCH', 500),
    backfillWindowS: nonNeg(env, 'INDEXER_BACKFILL_WINDOW_S', 0),
    backfillMaxWindows: int(env, 'INDEXER_BACKFILL_MAX_WINDOWS', 2_000),
    antiEntropyIntervalMs: nonNeg(env, 'INDEXER_ANTI_ENTROPY_INTERVAL_S', 300) * 1_000,
    antiEntropyIds: int(env, 'INDEXER_ANTI_ENTROPY_IDS', 500),
    antiEntropyLookbackS: int(env, 'INDEXER_ANTI_ENTROPY_LOOKBACK_S', 300),
    liveOverlapS: int(env, 'INDEXER_LIVE_OVERLAP_S', 300),
    queryTimeoutMs,
    connectTimeoutMs: int(env, 'INDEXER_CONNECT_TIMEOUT_MS', 5_000),
    cacheCapacity: int(env, 'INDEXER_CACHE_CAPACITY', 4_096),
    requireRegistry: env['INDEXER_REQUIRE_REGISTRY'] === '1',
    verboseInvalid: env['INDEXER_VERBOSE_INVALID'] === '1',
    writeAllow: [...parseWriteAllow(env['INDEXER_WRITE_ALLOW'])],
    operatorsDb: env['INDEXER_OPERATORS_DB']?.trim() || null,
    // Phase 6a: dôvera cudzím adresárom a sweep remote eventov. Oboje má
    // PRÁZDNY default, takže single-instance inštancia (a 86 testov) sa
    // nezmení — adresáre ani fed.db sa vôbec neotvárajú.
    trustDirectories: trust.directories,
    trustWarnings: trust.warnings,
    trustRefreshMs: nonNeg(env, 'INDEXER_TRUST_REFRESH_S', Math.round(TRUST_REFRESH_MS_DEFAULT / 1000)) * 1_000,
    fedDb: env['INDEXER_FED_DB']?.trim() || null,
    fedIntervalMs: nonNeg(env, 'INDEXER_FED_INTERVAL_S', 15) * 1_000,
    fedBatch: int(env, 'INDEXER_FED_BATCH', 500),
    quiet: env['INDEXER_QUIET'] === '1',
  };
}

// ── runtime (indexer node) ───────────────────────────────────────────────

/** Zložený bežiaci runtime: DB + pool + ingestor z jednej konfigurácie. */
export interface IndexerRuntime {
  db: IndexerDb;
  pool: IngestPool;
  ingestor: IndexerIngestor;
  config: IndexerConfig;
}

/**
 * Postaví DB + `RelayPool` + ingestor. `overrides` používajú testy
 * (vlastný pool s fake relaymi, vlastná logger, :memory: DB).
 */
export function buildIndexerRuntime(
  env: Record<string, string | undefined> = process.env,
  overrides?: {
    db?: IndexerDb;
    pool?: IngestPool;
    logger?: (line: string) => void;
    now?: () => number;
  },
): IndexerRuntime {
  const config = resolveIndexerConfig(env);
  const logger =
    overrides?.logger ?? (config.quiet ? () => undefined : (line: string) => console.log(line));
  const db = overrides?.db ?? openIndexerDb(config.dbPath);
  const pool: IngestPool =
    overrides?.pool ??
    new RelayPool({
      urls: config.relayUrls,
      connectTimeoutMs: config.connectTimeoutMs,
      // REQ (backfill/anti-entropia) čaká na EOSE tento timeout
      eoseTimeoutMs: config.queryTimeoutMs,
    });
  const ingestor = new IndexerIngestor({ db, pool, config, logger, now: overrides?.now });
  return { db, pool, ingestor, config };
}
