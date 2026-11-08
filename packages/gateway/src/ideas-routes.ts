/**
 * `GET /ideas` and `GET /ideas/:id` — the idea_call board (F4AI-16, S10),
 * the IO layer over the read-only indexer DB (the same lazy pattern as
 * `search-routes.ts` and `reputation-routes.ts`: the indexer is the writer,
 * the gateway reads the same WAL file and copies nothing for itself).
 *
 * Decision (same as S8/S9): index not available → **503
 * `{ error: 'index unavailable' }`**, no silent fallback.
 *
 * `GET /ideas` parameters:
 *   ?status=open|claimed|in_progress|review|done|cancelled
 *   ?topic=<t-tag>            (exact, case-insensitive)
 *   ?since=<unix seconds>     (idea created_at >= since)
 *   ?limit=1..100             (default 20)
 *
 * Board row (plain object from `ideas.ts`, MANAGER DECISION S10):
 *   { id, title, description, topics, author, created_at,
 *     status            — the AUTHOR's canonical 10030, otherwise 'open'
 *     claimant          — claimant of the canonical status (claimed)
 *     status_history    — all readable 10030 of the author, created_at ASC
 *     suggestions_count — LWW 10030 from other pubkeys (suggestions, not status)
 *     rating            — 1031/1032 aggregate bound to the idea id
 *                         (`accepted` flag from 1032); null when no rating kinds
 *                         are inside the scan window }
 *
 * `GET /ideas/:id` adds `suggestions[]` (LWW winners of foreign pubkeys,
 * chronologically). 404 = the 1021 with this id is not in the index; 400 = the id
 * is not 64-hex.
 *
 * Scaling (documented, F1): the board is built by scanning kinds
 * 1021/10030/1031/1032 at once with a cap of `IDEAS_SCAN_LIMIT` rows per
 * kind (newest-first, so the current status lines are always inside the window).
 * The materialized `idea_calls` view from the data model (ch. 8) is S11+.
 */
import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { Context } from 'hono';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

import { IndexUnavailableError, UNTRUSTED_NOTE } from './search.js';
import {
  filterIdeaRows,
  assembleIdeaBoard,
  assembleIdeaDetail,
  isIdeaStatus,
  IDEA_STATUSES,
  IDEAS_PHASE,
  type IdeaBoardFilters,
  type IdeaRow,
} from './ideas.js';

type SqliteDb = Database.Database;

const ID_RE = /^[0-9a-f]{64}$/;

/** hard-strop scanu per kind (riadky) — newest-first, aby LWW línie platili */
export const IDEAS_SCAN_LIMIT = 100_000;
export const IDEAS_DEFAULT_LIMIT = 20;
export const IDEAS_MAX_LIMIT = 100;
export const IDEAS_TOPIC_MAX_LENGTH = 200;

/** kindy, ktoré board potrebuje (1021 rooty, 10030 stavy, 1031/1032 rating) */
export const IDEAS_KINDS: readonly number[] = [
  KINDS.IDEA_CALL, // 1021
  KINDS.IDEA_CALL_STATUS, // 10030
  KINDS.SOLUTION_RATING, // 1031
  KINDS.ACCEPTED_SOLUTION, // 1032
];

export interface IdeasRouteOptions {
  /** cesta k indexer DB (GATEWAY_INDEX_DB); null = board vypnutý → 503 */
  path: string | null;
  /** injectnutý zdroj (buildGateway drží životnosť a privolá `close()`) */
  source?: IdeasIndexSource;
  /** injectnable otvárač DB (testy s dočasnou DB) */
  open?: (path: string) => SqliteDb;
  logger?: (line: string) => void;
  /**
   * B3: TTL cache scanu (ms). Scan číta až `IDEAS_SCAN_LIMIT` riadkov na
   * request; bez cache každy refresh UI znova scannuje celú DB. Default
   * 1500 ms — indexer pise priebežne, poldruha sekundy stale je pre board
   * akceptovatelna davka (`GATEWAY_IDEAS_CACHE_MS=0` vypne).
   */
  cacheMs?: number;
}

/**
 * Read-only zdroj eventov idea_call boardu — lazy otváranie a obnova pri
 * ďalšom dopyte (rovnaké pravidlo ako `ReputationIndexSource`).
 */
export class IdeasIndexSource {
  readonly path: string;

  private readonly openDb: (path: string) => SqliteDb;
  private readonly checksFile: boolean;
  private db: SqliteDb | null = null;
  private lastOpenError: string | null = null;

  constructor(options: { path: string; open?: (path: string) => SqliteDb }) {
    this.path = options.path;
    this.openDb =
      options.open ?? ((path) => new Database(path, { readonly: true, fileMustExist: true }));
    this.checksFile = options.open === undefined;
  }

  /** diagnostika pre /health (rovnaký tvar ako search/reputation index) */
  availability(): { available: boolean; path: string; reason?: string } {
    if (this.db !== null) return { available: true, path: this.path };
    try {
      this.ensureOpen();
      return { available: true, path: this.path };
    } catch (err) {
      return {
        available: false,
        path: this.path,
        reason: err instanceof IndexUnavailableError ? err.reason : String(err),
      };
    }
  }

  private ensureOpen(): SqliteDb {
    if (this.db !== null) return this.db;
    if (this.checksFile && !existsSync(this.path)) {
      this.lastOpenError = `index DB does not exist: ${this.path}`;
      throw new IndexUnavailableError(this.path, this.lastOpenError);
    }
    try {
      this.db = this.openDb(this.path);
      this.lastOpenError = null;
      return this.db;
    } catch (err) {
      this.lastOpenError = err instanceof Error ? err.message : String(err);
      throw new IndexUnavailableError(this.path, this.lastOpenError);
    }
  }

  /**
   * Načítaj eventy kindov `kinds` ( newest-first, strop `limit` ),
   * deterministicky zoradené `created_at DESC, id DESC` — board aj detail
   * si vlastné triedenie robia v čistých funkciách.
   */
  loadByKinds(kinds: readonly number[], limit: number = IDEAS_SCAN_LIMIT): NostrEvent[] {
    const db = this.ensureOpen();
    const placeholders = kinds.map(() => '?').join(', ');
    const sql = `
      SELECT id, pubkey, kind, created_at, content, tags_json
      FROM events
      WHERE kind IN (${placeholders})
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...kinds, limit) as Array<{
      id: string;
      pubkey: string;
      kind: number;
      created_at: number;
      content: string;
      tags_json: string;
    }>;
    const events: NostrEvent[] = [];
    for (const row of rows) {
      let tags: NostrTag[];
      try {
        const parsed = JSON.parse(row.tags_json) as unknown;
        tags = Array.isArray(parsed) ? (parsed as NostrTag[]) : [];
      } catch {
        continue; // poškodený JSON v riadku — event sa nedá použiť
      }
      events.push({
        id: row.id,
        pubkey: row.pubkey,
        created_at: row.created_at,
        kind: row.kind,
        tags,
        content: row.content,
        sig: '', // podpis čítaniu nepotrebujeme (writer validoval pri zápise)
      });
    }
    return events;
  }

  close(): void {
    if (this.db !== null && this.db.open) this.db.close();
    this.db = null;
  }
}

function badRequest(c: Context, error: string, reason: string) {
  return c.json({ ok: false, error, reasons: [reason] }, 400);
}

function indexGone(c: Context, reason: string, path: string) {
  return c.json({ ok: false, error: 'index unavailable', reason, path }, 503);
}

function noIndex(c: Context) {
  return c.json(
    {
      ok: false,
      error: 'index unavailable',
      reason: 'GATEWAY_INDEX_DB is not set — the idea_call board requires the indexer DB',
      path: '(GATEWAY_INDEX_DB not set)',
    },
    503,
  );
}

interface IdeaScan {
  ideas: NostrEvent[];
  statuses: NostrEvent[];
  ratings: NostrEvent[];
  accepted: NostrEvent[];
}

function scan(source: IdeasIndexSource): IdeaScan {
  return {
    ideas: source.loadByKinds([KINDS.IDEA_CALL]),
    statuses: source.loadByKinds([KINDS.IDEA_CALL_STATUS]),
    ratings: source.loadByKinds([KINDS.SOLUTION_RATING]),
    accepted: source.loadByKinds([KINDS.ACCEPTED_SOLUTION]),
  };
}

/** validácia query parametrov boardu; error = hotová 400 odpoveď */
function parseBoardParams(
  c: Context,
): { filters: IdeaBoardFilters; limit: number } | { error: Response } {
  const filters: IdeaBoardFilters = {};

  const status = c.req.query('status');
  if (status !== undefined && status.trim() !== '') {
    const value = status.trim();
    if (!isIdeaStatus(value)) {
      return {
        error: badRequest(
          c,
          'invalid status',
          `status must be one of: ${IDEA_STATUSES.join(', ')} (got '${value}')`,
        ),
      };
    }
    filters.status = value;
  }

  const topic = c.req.query('topic');
  if (topic !== undefined && topic.trim() !== '') {
    const value = topic.trim();
    if (value.length > IDEAS_TOPIC_MAX_LENGTH) {
      return {
        error: badRequest(
          c,
          'invalid topic',
          `topic may have at most ${String(IDEAS_TOPIC_MAX_LENGTH)} characters`,
        ),
      };
    }
    filters.topic = value;
  }

  const since = c.req.query('since');
  if (since !== undefined && since.trim() !== '') {
    const value = Number(since);
    if (!Number.isInteger(value) || value < 0) {
      return { error: badRequest(c, 'invalid since', 'since must be a non-negative integer (unix seconds)') };
    }
    filters.since = value;
  }

  // B2: filter na autora — server-side, aby UI nemuselo fetchovať 100
  // idea_clov a triediť lokálne (obmedzenie by ticho mizalo)
  const author = c.req.query('author');
  if (author !== undefined && author.trim() !== '') {
    const value = author.trim().toLowerCase();
    if (!ID_RE.test(value)) {
      return { error: badRequest(c, 'invalid author', 'author must be 64 hex characters (pubkey)') };
    }
    filters.author = value;
  }

  const rawLimit = c.req.query('limit');
  let limit = IDEAS_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit.trim() !== '') {
    const value = Number(rawLimit);
    if (!Number.isInteger(value) || value < 1 || value > IDEAS_MAX_LIMIT) {
      return {
        error: badRequest(c, 'invalid limit', `limit must be an integer 1..${String(IDEAS_MAX_LIMIT)}`),
      };
    }
    limit = value;
  }

  return { filters, limit };
}

function boardBody(rows: IdeaRow[], filters: IdeaBoardFilters, limit: number) {
  return {
    phase: IDEAS_PHASE,
    count: rows.length,
    limit,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    items: rows,
    untrusted: UNTRUSTED_NOTE,
  };
}

export function registerIdeasRoutes(app: Hono, options: IdeasRouteOptions): void {
  const logger = options.logger ?? ((line: string) => console.log(line));
  const cacheMs = options.cacheMs ?? 1_500;
  const source =
    options.source ??
    (options.path !== null
      ? new IdeasIndexSource({
          path: options.path,
          ...(options.open !== undefined ? { open: options.open } : {}),
        })
      : null);

  // B3: scan zdieľajú obe route; cache drží len USPEŠNÝ scan (chyba sa
  // necache — ďalší dopyt skúsi znova a 503 sa nevystopuje do TTL)
  let scanCache: { at: number; data: IdeaScan } | null = null;
  function cachedScan(): IdeaScan {
    if (source === null) throw new Error('source is null');
    const now = Date.now();
    if (scanCache !== null && now - scanCache.at < cacheMs) return scanCache.data;
    const data = scan(source);
    scanCache = { at: now, data };
    return data;
  }

  app.get('/ideas', (c) => {
    const params = parseBoardParams(c);
    if ('error' in params) return params.error;

    if (source === null) return noIndex(c);

    let board: IdeaRow[];
    try {
      const data = cachedScan();
      const all = assembleIdeaBoard({
        ideas: data.ideas,
        statuses: data.statuses,
        ratings: data.ratings,
        accepted: data.accepted,
      });
      board = filterIdeaRows(all, params.filters).slice(0, params.limit);
    } catch (err) {
      if (err instanceof IndexUnavailableError) {
        logger(`[gateway ideas] 503 index unavailable path=${err.path} reason=${err.reason}`);
        return indexGone(c, err.reason, err.path);
      }
      throw err;
    }

    return c.json(boardBody(board, params.filters, params.limit));
  });

  app.get('/ideas/:id', (c) => {
    const id = c.req.param('id');
    if (!ID_RE.test(id)) {
      return badRequest(c, 'invalid idea id', 'id must be 64 hex characters (the 1021 event id)');
    }

    if (source === null) return noIndex(c);

    let detail: ReturnType<typeof assembleIdeaDetail>;
    try {
      const data = cachedScan();
      const ideaEvent = data.ideas.find((event) => event.id === id);
      if (ideaEvent === undefined) {
        return c.json(
          {
            ok: false,
            error: 'idea not found',
            id,
            reason: 'the index has no kind 1021 event with this id',
          },
          404,
        );
      }
      detail = assembleIdeaDetail(ideaEvent, data.statuses, data.ratings, data.accepted);
    } catch (err) {
      if (err instanceof IndexUnavailableError) {
        logger(`[gateway ideas] 503 index unavailable path=${err.path} reason=${err.reason}`);
        return indexGone(c, err.reason, err.path);
      }
      throw err;
    }

    if (detail === null) {
      return c.json({ ok: false, error: 'idea not found', id, reason: 'the event is not a readable 1021' }, 404);
    }

    return c.json({ phase: IDEAS_PHASE, ...detail, untrusted: UNTRUSTED_NOTE });
  });
}
