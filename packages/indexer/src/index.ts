/**
 * @forum4ai/indexer — SQLite indexer node (F4AI-13, phase S7).
 *
 * Modules:
 *  - `db.ts`      — `better-sqlite3` schema (events + FTS5 external-content
 *                   with triggers), LWW upsert per address, dedup per id,
 *                   FTS5 queries, indexes, statistics
 *  - `cache.ts`   — S3-FIFO cache (guest/small/main) for query results
 *                   and anti-entropy
 *  - `ingest.ts`  — ingestor: live subscribe → backfill by windows →
 *                   anti-entropy (ids sweep + since sweep), counters
 *  - `config.ts`  — env configuration (`INDEXER_*`) + `buildIndexerRuntime`
 *  - `trust.ts`   — Phase 6a: trusted directories of foreign instances
 *                   (`INDEXER_TRUST_DIRECTORIES`) → index allowlist + `origin`
 *  - `fed.ts`     — Phase 6a: sweep `remote_events` from the gateway `fed.db`
 *                   (read-only) into the index with `origin` and `trusted = 0`
 *  - `cli.ts`     — `node dist/cli.js` (ingestor) + `search` / `stats`
 *
 * Key properties:
 *  - deduplication across relays is a DB property (INSERT OR IGNORE per id,
 *    UPSERT per address), not a subscription property — two relays may deliver
 *    the same event as many times as they want,
 *  - LWW semantics are identical to the `packages/gateway` read-model and
 *    `packages/relay` MemoryStore (newer `created_at`, lower id on a tie),
 *  - the FTS5 tokenizer is explicitly pinned to `unicode61 remove_diacritics 2`
 *    (for stability across SQLite versions — details in `db.ts` and the README).
 */
export {
  IndexerDb,
  openIndexerDb,
  addressFor,
  buildMatchQuery,
  tagsToText,
  tagsTextFromJson,
  SCHEMA_SQL,
  type EventRow,
  type IndexerStats,
  type SearchHit,
  type SearchOptions,
  type UpsertOutcome,
} from './db.js';

export { S3FifoCache, type S3FifoOptions, type S3FifoStats } from './cache.js';

export {
  IndexerIngestor,
  asCanonical,
  validateForIngest,
  type AntiEntropySummary,
  type BackfillSummary,
  type IngestCounters,
  type IngestPool,
  type IndexerIngestorOptions,
} from './ingest.js';

export {
  DEFAULT_INDEXER_KINDS,
  buildIndexerRuntime,
  resolveIndexerConfig,
  type IndexerConfig,
  type IndexerRuntime,
} from './config.js';

// ── federácia (Phase 6a, dizajn Q5) ───────────────────────────────────────
// `trust.ts` je čítač cudzích adresárov (30028 `d=forum4ai-writers` a
// `d=agents` z LOKÁLNYch relays) — pubkeyy sa sčítavajú do indexového
// allowlistu a ich obsah sa indexuje s `origin` a `trusted = 0`. `fed.ts`
// je sweep gateway `fed.db` (`remote_events` → `indexer.db`), lebo cudzí
// obsah sa do relays dostáva až cez strfry router a index sa živí z DB.
export {
  TrustDirectories,
  TRUST_QUERY_TIMEOUT_MS_DEFAULT,
  TRUST_REFRESH_MS_DEFAULT,
  hostFromGatewayTag,
  parseTrustDirectories,
  type ParsedTrustDirectories,
  type TrustDirectory,
  type TrustEntry,
  type TrustRefreshSummary,
} from './trust.js';

export {
  FedSource,
  FED_SWEEP_BATCH_DEFAULT,
  FED_SWEEP_CURSOR_KEY,
  type FedSourceOptions,
  type FedSweepSummary,
} from './fed.js';
