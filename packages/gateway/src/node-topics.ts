/**
 * Topic slugs advertised by a node announcement (F4AI-36).
 *
 * The announcement carries up to five topic slugs and a topic count so a
 * directory reader can decide *which* node to talk to without asking it first
 * ("who carries ai-agents?"). The gateway already has the answer in the
 * indexer database: topics are kind 30020 events and their `addr` column is
 * exactly `30020:<pubkey>:<slug>`.
 *
 * This is a query-time projection, not a new table: it opens the read-only
 * index, runs two cheap queries, closes the handle, and caches the answer for
 * `refreshMs`. The indexer may be missing, mid-rebuild or on a slower disk —
 * every failure degrades to "no topics advertised", never to a broken
 * heartbeat.
 */
import Database from 'better-sqlite3';

import { KINDS, NODE_ANNOUNCE_MAX_TOPICS } from '@forum4ai/shared';

type SqliteDb = Database.Database;

export interface TopicSnapshot {
  /** slugs advertised in `t` tags, newest first */
  slugs: string[];
  /** distinct topics this instance indexes, or null when the index is dark */
  count: number | null;
  /** ms epoch of the refresh (0 = never succeeded) */
  refreshed_at: number;
}

export interface IndexTopicProviderOptions {
  /** `GATEWAY_INDEX_DB` (null = no index, provider always returns empty) */
  path: string | null;
  /** how many slugs to advertise (default `NODE_ANNOUNCE_MAX_TOPICS`) */
  limit?: number;
  /** cache window in ms (default 15 min — the heartbeat does not need more) */
  refreshMs?: number;
  logger?: (line: string) => void;
  open?: (path: string) => SqliteDb;
  /** ms epoch */
  now?: () => number;
}

export interface IndexTopicProvider {
  snapshot(): Promise<TopicSnapshot>;
  topics(): Promise<string[]>;
  count(): Promise<number | null>;
}

const EMPTY: TopicSnapshot = { slugs: [], count: null, refreshed_at: 0 };

/** `30020:<pubkey>:<slug>` → `<slug>` (null when the address is malformed). */
export function slugFromTopicAddress(addr: string): string | null {
  const first = addr.indexOf(':');
  if (first <= 0) return null;
  const slug = addr.slice(addr.lastIndexOf(':') + 1);
  return slug.length > 0 && slug !== addr ? slug : null;
}

export function createIndexTopicProvider(options: IndexTopicProviderOptions): IndexTopicProvider {
  const log = options.logger ?? (() => undefined);
  const limit = Math.max(1, options.limit ?? NODE_ANNOUNCE_MAX_TOPICS);
  const refreshMs = options.refreshMs ?? 15 * 60 * 1000;
  const open =
    options.open ?? ((path: string) => new Database(path, { readonly: true, fileMustExist: true }));
  const now = options.now ?? (() => Date.now());

  let cached: TopicSnapshot = EMPTY;
  let inFlight: Promise<TopicSnapshot> | null = null;

  function read(): TopicSnapshot {
    if (options.path === null || options.path === '') return EMPTY;
    let db: SqliteDb | null = null;
    try {
      db = open(options.path);
      const rows = db
        .prepare('SELECT addr FROM events WHERE kind = ? AND addr IS NOT NULL ORDER BY created_at DESC LIMIT ?')
        .all(KINDS.TOPIC, limit * 20) as { addr: string | null }[];
      const slugs: string[] = [];
      for (const row of rows) {
        if (typeof row.addr !== 'string') continue;
        const slug = slugFromTopicAddress(row.addr);
        if (slug === null || slugs.includes(slug)) continue;
        slugs.push(slug);
        if (slugs.length >= limit) break;
      }
      const total = db
        .prepare('SELECT COUNT(DISTINCT addr) AS n FROM events WHERE kind = ? AND addr IS NOT NULL')
        .get(KINDS.TOPIC) as { n: number } | undefined;
      return { slugs, count: typeof total?.n === 'number' ? total.n : null, refreshed_at: now() };
    } catch (err) {
      // A missing index is normal (the indexer is a separate container).
      log(`node topics: index read failed (${err instanceof Error ? err.message : String(err)})`);
      return { ...cached, refreshed_at: now() };
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  }

  async function snapshot(): Promise<TopicSnapshot> {
    const fresh = cached.refreshed_at !== 0 && now() - cached.refreshed_at < refreshMs;
    if (fresh) return cached;
    if (inFlight !== null) return inFlight;
    const run = Promise.resolve().then(() => {
      cached = read();
      return cached;
    });
    inFlight = run;
    try {
      return await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  }

  return {
    snapshot,
    topics: async () => (await snapshot()).slugs,
    count: async () => (await snapshot()).count,
  };
}
