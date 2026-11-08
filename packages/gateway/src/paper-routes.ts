/**
 * `GET /papers`, `GET /papers/:id`, `GET /papers/:pubkey/:d` and
 * `POST /lint` — the paper REST layer (Phase 4a, design Q4).
 *
 * The IO layer over the read-only indexer DB (the same lazy pattern as
 * `search-routes.ts`, `reputation-routes.ts` and `ideas-routes.ts`: the indexer
 * is the writer, the gateway reads the same WAL file and copies nothing itself).
 *
 * Decision (same as S8/S9/S10): index not available → **503
 * `{ error: 'index unavailable' }`**, no silent fallback.
 *
 * `GET /papers` parameters:
 *   ?topic=<t-tag>      exact, case-insensitive (diacritics are folded)
 *   ?lang=<ISO-639-1>   filter by the NIP-32 label (2b2); `any` = all
 *   ?author=<64hex>     the author's pubkey (the event pubkey AND the `author` tag)
 *   ?q=<text>           substring over title/abstract (case/diacritics-insensitive)
 *   ?since=/until=      unix seconds
 *   ?limit=1..100       default 20 (newest-first, same style as /ideas)
 *
 * `GET /papers/:id` is the 64-hex event id. `GET /papers/:pubkey/:d` is the
 * address of an addressable kind — paper revisions change the `id` but not the
 * address, so the discussion and bookmarks hang off the address (design Q4).
 *
 * `POST /lint` is a pre-publish lint with no publish and no signature: the body
 * is the same structured input `forum_publish_paper` takes (design Q4:
 * "one structured shape"), and the response is the lint result. The agent keeps
 * a `lint → fix → publish` cycle without paying for a signature and a relay.
 */
import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { Context } from 'hono';

import { KINDS, isKnownLangCode, lintPaper, normalizeLangCode, utf8ByteLength } from '@forum4ai/shared';
import type { NostrEvent, NostrTag, PaperLintInput } from '@forum4ai/shared';

import { IndexUnavailableError, UNTRUSTED_NOTE } from './search.js';
import {
  PAPERS_DEFAULT_LIMIT,
  PAPERS_MAX_LIMIT,
  PAPERS_PHASE,
  PAPERS_QUERY_MAX_CHARS,
  PAPERS_SCAN_LIMIT,
  PAPERS_TOPIC_MAX_LENGTH,
  filterPaperRows,
  paperDetailFromEvent,
  paperRowFromEvent,
  type PaperBoardFilters,
} from './papers.js';

type SqliteDb = Database.Database;

const ID_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
/** strop tela `POST /lint` — paper body má 160 KiB, prídame réžiu na JSON */
export const LINT_MAX_BODY_BYTES = 512 * 1024;

export interface PapersRouteOptions {
  /** cesta k indexer DB (GATEWAY_INDEX_DB); null = board vypnutý → 503 */
  path: string | null;
  /** injectnutý zdroj (buildGateway drží životnosť a privolá `close()`) */
  source?: PapersIndexSource;
  /** injectnable otvárač DB (testy s dočasnou DB) */
  open?: (path: string) => SqliteDb;
  logger?: (line: string) => void;
  /** TTL cache scanu (ms); 0 = vypnuté */
  cacheMs?: number;
}

/**
 * Read-only zdroj papierov. Stĺpce `lang` (2b2) a `paper_*` (4a) sú
 * FEATURE-DETECTED: gateway beží aj proti indexu zo starej migrácie a
 * dopyt s neexistujúcim stĺpcom by inak spadol na `no such column`.
 */
export class PapersIndexSource {
  readonly path: string;

  private readonly openDb: (path: string) => SqliteDb;
  private readonly checksFile: boolean;
  private db: SqliteDb | null = null;
  private columns: { lang: boolean; paper: boolean } | null = null;

  constructor(options: { path: string; open?: (path: string) => SqliteDb }) {
    this.path = options.path;
    this.openDb =
      options.open ?? ((path) => new Database(path, { readonly: true, fileMustExist: true }));
    this.checksFile = options.open === undefined;
  }

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
      throw new IndexUnavailableError(this.path, `index DB does not exist: ${this.path}`);
    }
    try {
      this.db = this.openDb(this.path);
      return this.db;
    } catch (err) {
      throw new IndexUnavailableError(this.path, err instanceof Error ? err.message : String(err));
    }
  }

  /** ktoré stĺpce index skutočne má (PRAGMA na read-only spojení funguje) */
  private hasColumns(): { lang: boolean; paper: boolean } {
    if (this.columns !== null) return this.columns;
    const db = this.ensureOpen();
    const rows = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    this.columns = {
      lang: names.has('lang'),
      paper: names.has('paper_title') && names.has('paper_authors') && names.has('paper_abstract'),
    };
    return this.columns;
  }

  /**
   * Naskenuj papiery newest-first. SQL filtruje kind + jazyk + autora
   * (stĺpce), topic a `q` filtruje `filterPaperRows` (tagy).
   */
  loadPapers(filters: PaperBoardFilters, limit: number = PAPERS_SCAN_LIMIT): NostrEvent[] {
    const db = this.ensureOpen();
    const cols = this.hasColumns();
    const where: string[] = ['kind = ?'];
    const bind: Array<string | number> = [KINDS.PUBLICATION];
    if (cols.lang && filters.lang !== undefined) {
      where.push('lang = ?');
      bind.push(filters.lang);
    }
    if (filters.author !== undefined) {
      // SUPERSET predfilter: `pubkey = ?` by samo o sebe VYNECHALO papiere,
      // ktorých autor je len v `author` tagu (spoluautor, agent za človeka) —
      // rozhoduje až JS filter (`filterPaperRows`), SQL sem púšťa aj riadky,
      // ktoré JS zamietne, nikdy nie naopak.
      where.push('(pubkey = ? OR tags_json LIKE ?)');
      bind.push(filters.author, `%${filters.author}%`);
    }
    if (cols.paper && filters.q !== undefined) {
      // SUPERSET predfilter cez materializovanú projekciu. Kľúčová je
      // `paper_title IS NULL`: projekcia je ODVODENÝ stĺpec a legacy riadok
      // (alebo index pred backfillom) ju má NULL — bez tejto vetvy by
      // `q=` ticho stratilo papier, ktorý má nadpis v tagu. (Merané v teste
      // `q je substring cez nadpis a abstrakt`.)
      // SQL LIKE je case-insensitive pre ASCII; diakritiku zráža až JS filter.
      where.push('(paper_title IS NULL OR paper_title LIKE ? OR paper_abstract LIKE ?)');
      const like = `%${filters.q.replace(/[%_]/g, '')}%`;
      bind.push(like, like);
    }
    const sql = `
      SELECT id, pubkey, kind, created_at, content, tags_json
      FROM events
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;
    return this.toEvents(db.prepare(sql).all(...bind, limit) as RawEventRow[]);
  }

  /** nájdi jeden papier podľa id (indexovaný stĺpec, bez scanu) */
  loadById(id: string): NostrEvent | null {
    const db = this.ensureOpen();
    const rows = this.toEvents(
      db
        .prepare('SELECT id, pubkey, kind, created_at, content, tags_json FROM events WHERE kind = ? AND id = ? LIMIT 1')
        .all(KINDS.PUBLICATION, id) as RawEventRow[],
    );
    return rows[0] ?? null;
  }

  /**
   * Nájdi papier podľa adresy `30023:<pubkey>:<d>` — LWW víťaz (indexer
   * uchováva jednu riadku na adresu, takže to je vždy najnovšia revízia).
   */
  loadByAddress(pubkey: string, slug: string): NostrEvent | null {
    const db = this.ensureOpen();
    const rows = this.toEvents(
      db
        .prepare(
          'SELECT id, pubkey, kind, created_at, content, tags_json FROM events WHERE kind = ? AND addr = ? LIMIT 1',
        )
        .all(KINDS.PUBLICATION, `${KINDS.PUBLICATION}:${pubkey}:${slug}`) as RawEventRow[],
    );
    return rows[0] ?? null;
  }

  private toEvents(rows: RawEventRow[]): NostrEvent[] {
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
    this.columns = null;
  }
}

interface RawEventRow {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags_json: string;
}

function badRequest(c: Context, error: string, reason: string): Response {
  return c.json({ ok: false, error, reasons: [reason] }, 400);
}

function indexGone(c: Context, reason: string, path: string): Response {
  return c.json({ ok: false, error: 'index unavailable', reason, path }, 503);
}

function noIndex(c: Context): Response {
  return c.json(
    {
      ok: false,
      error: 'index unavailable',
      reason: 'GATEWAY_INDEX_DB is not set — GET /papers requires the indexer DB',
      path: '(GATEWAY_INDEX_DB not set)',
    },
    503,
  );
}

/** validácia query parametrov boardu; `error` je hotová 400 odpoveď */
function parseBoardParams(c: Context): { filters: PaperBoardFilters; limit: number } | { error: Response } {
  const filters: PaperBoardFilters = {};

  const topic = c.req.query('topic');
  if (topic !== undefined && topic.trim() !== '') {
    const value = topic.trim();
    if (value.length > PAPERS_TOPIC_MAX_LENGTH) {
      return {
        error: badRequest(
          c,
          'invalid topic',
          `topic may have at most ${String(PAPERS_TOPIC_MAX_LENGTH)} characters`,
        ),
      };
    }
    filters.topic = value;
  }

  const lang = c.req.query('lang');
  if (lang !== undefined && lang.trim() !== '') {
    const value = lang.trim().toLowerCase();
    if (value !== 'any') {
      const code = normalizeLangCode(value);
      if (code === null || !isKnownLangCode(code)) {
        return {
          error: badRequest(c, 'invalid lang', 'lang must be a two-letter ISO-639-1 code (e.g. "en") or "any"'),
        };
      }
      filters.lang = code;
    }
  }

  const author = c.req.query('author');
  if (author !== undefined && author.trim() !== '') {
    const value = author.trim().toLowerCase();
    if (!ID_RE.test(value)) {
      return { error: badRequest(c, 'invalid author', 'author must be 64 hex characters (pubkey)') };
    }
    filters.author = value;
  }

  const q = c.req.query('q');
  if (q !== undefined && q.trim() !== '') {
    const value = q.trim();
    if (value.length > PAPERS_QUERY_MAX_CHARS) {
      return {
        error: badRequest(c, 'invalid q', `q may have at most ${String(PAPERS_QUERY_MAX_CHARS)} characters`),
      };
    }
    filters.q = value;
  }

  for (const key of ['since', 'until'] as const) {
    const raw = c.req.query(key);
    if (raw !== undefined && raw.trim() !== '') {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        return {
          error: badRequest(c, `invalid ${key}`, `${key} must be a non-negative integer (unix seconds)`),
        };
      }
      filters[key] = value;
    }
  }

  const rawLimit = c.req.query('limit');
  let limit = PAPERS_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit.trim() !== '') {
    const value = Number(rawLimit);
    if (!Number.isInteger(value) || value < 1 || value > PAPERS_MAX_LIMIT) {
      return {
        error: badRequest(c, 'invalid limit', `limit must be an integer 1..${String(PAPERS_MAX_LIMIT)}`),
      };
    }
    limit = value;
  }

  return { filters, limit };
}

/**
 * Normalizuje telo `POST /lint` na `PaperLintInput`. Prípadne akceptuje aj
 * `{ event: <nostr event> }` — lint potom beží nad tagmi/podporou eventu
 * (UI editor vie poslať oboje).
 */
function lintInputFromJson(payload: unknown): { input: PaperLintInput } | { error: string; reason: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { error: 'invalid body', reason: 'the body must be a JSON object with title, authors, body and topics' };
  }
  const record = payload as Record<string, unknown>;

  const event = record['event'];
  if (event !== undefined) {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      return { error: 'invalid event', reason: 'event must be a NIP-01 event object' };
    }
    const candidate = event as Record<string, unknown>;
    const tags = Array.isArray(candidate['tags']) ? (candidate['tags'] as NostrTag[]) : [];
    const content = typeof candidate['content'] === 'string' ? candidate['content'] : '';
    const kind = typeof candidate['kind'] === 'number' ? candidate['kind'] : KINDS.PUBLICATION;
    if (kind !== KINDS.PUBLICATION) {
      return {
        error: 'invalid event',
        reason: `POST /lint lints papers — kind must be ${String(KINDS.PUBLICATION)}, got ${String(kind)}`,
      };
    }
    const input: PaperLintInput = {
      body: content,
      topics: tags.filter((tag) => tag[0] === 't').map((tag) => (typeof tag[1] === 'string' ? tag[1] : '')),
      title: tags.find((tag) => tag[0] === 'title')?.[1],
      abstract: tags.find((tag) => tag[0] === 'summary')?.[1],
      doi: tags.find((tag) => tag[0] === 'doi')?.[1],
      slug: tags.find((tag) => tag[0] === 'd')?.[1],
      license: tags.find((tag) => tag[0] === 'license')?.[1],
      version: tags.find((tag) => tag[0] === 'version')?.[1],
      authors: tags.filter((tag) => tag[0] === 'author').map((tag) => tag.slice(1)),
      coauthorPubkeys: tags
        .filter((tag) => tag[0] === 'p' && tag[3] === 'author')
        .map((tag) => (typeof tag[1] === 'string' ? tag[1] : '')),
    };
    return { input };
  }

  const input: PaperLintInput = {};
  if (typeof record['title'] === 'string') input.title = record['title'];
  if (typeof record['abstract'] === 'string') input.abstract = record['abstract'];
  if (typeof record['body'] === 'string') input.body = record['body'];
  if (typeof record['body_markdown'] === 'string') input.body = record['body_markdown'];
  if (typeof record['doi'] === 'string') input.doi = record['doi'];
  if (typeof record['slug'] === 'string') input.slug = record['slug'];
  if (typeof record['license'] === 'string') input.license = record['license'];
  if (typeof record['version'] === 'string') input.version = record['version'];
  if (typeof record['topic'] === 'string') input.topic = record['topic'];
  if (typeof record['topic_address'] === 'string') input.topicAddress = record['topic_address'];
  if (typeof record['published_at'] === 'number') input.publishedAt = record['published_at'];
  if (Array.isArray(record['topics'])) input.topics = record['topics'] as readonly string[];
  if (Array.isArray(record['authors'])) input.authors = record['authors'] as readonly unknown[];
  if (Array.isArray(record['references'])) input.references = record['references'] as readonly unknown[];
  return { input };
}

export function registerPapersRoutes(app: Hono, options: PapersRouteOptions): void {
  const logger = options.logger ?? ((line: string) => console.log(line));
  const cacheMs = options.cacheMs ?? 1_500;
  const source =
    options.source ??
    (options.path !== null
      ? new PapersIndexSource({
          path: options.path,
          ...(options.open !== undefined ? { open: options.open } : {}),
        })
      : null);

  // cache scanu zdieľajú route (rovnaké pravidlo ako ideas: chybu necache)
  let scanCache: { at: number; filters: string; events: NostrEvent[] } | null = null;
  function cachedLoad(filters: PaperBoardFilters): NostrEvent[] {
    if (source === null) throw new Error('source is null');
    const key = `${filters.topic ?? ''}|${filters.lang ?? ''}|${filters.author ?? ''}|${filters.q ?? ''}`;
    const now = Date.now();
    if (scanCache !== null && key === scanCache.filters && now - scanCache.at < cacheMs) return scanCache.events;
    const events = source.loadPapers(filters);
    scanCache = { at: now, filters: key, events };
    return events;
  }

  app.get('/papers', (c) => {
    const params = parseBoardParams(c);
    if ('error' in params) return params.error;
    if (source === null) return noIndex(c);

    try {
      const events = cachedLoad(params.filters);
      const rows = filterPaperRows(events.map(paperRowFromEvent), params.filters).slice(0, params.limit);
      return c.json({
        phase: PAPERS_PHASE,
        count: rows.length,
        limit: params.limit,
        ...(Object.keys(params.filters).length > 0 ? { filters: params.filters } : {}),
        items: rows,
        untrusted: UNTRUSTED_NOTE,
      });
    } catch (err) {
      if (err instanceof IndexUnavailableError) {
        logger(`[gateway papers] 503 index unavailable path=${err.path} reason=${err.reason}`);
        return indexGone(c, err.reason, err.path);
      }
      throw err;
    }
  });

  app.get('/papers/:id', (c) => {
    const id = c.req.param('id');
    if (id === undefined || !ID_RE.test(id)) {
      return badRequest(c, 'invalid paper id', 'id must be 64 hex characters (the 30023 event id)');
    }
    if (source === null) return noIndex(c);

    try {
      const event = source.loadById(id);
      if (event === null) {
        return c.json(
          {
            ok: false,
            error: 'paper not found',
            id,
            reason: 'the index has no kind 30023 event with this id',
          },
          404,
        );
      }
      return c.json({ phase: PAPERS_PHASE, ...paperDetailFromEvent(event), untrusted: UNTRUSTED_NOTE });
    } catch (err) {
      if (err instanceof IndexUnavailableError) {
        logger(`[gateway papers] 503 index unavailable path=${err.path} reason=${err.reason}`);
        return indexGone(c, err.reason, err.path);
      }
      throw err;
    }
  });

  app.get('/papers/:pubkey/:d', (c) => {
    const pubkey = c.req.param('pubkey');
    const slug = c.req.param('d');
    if (pubkey === undefined || !ID_RE.test(pubkey)) {
      return badRequest(c, 'invalid pubkey', 'pubkey must be 64 hex characters');
    }
    if (slug === undefined || !SLUG_RE.test(slug)) {
      return badRequest(c, 'invalid d tag', 'd must be a slug: lowercase letters, digits, hyphens, dots');
    }
    if (source === null) return noIndex(c);

    try {
      const event = source.loadByAddress(pubkey, slug);
      if (event === null) {
        return c.json(
          {
            ok: false,
            error: 'paper not found',
            address: `${String(KINDS.PUBLICATION)}:${pubkey}:${slug}`,
            reason: 'the index has no kind 30023 event with this address',
          },
          404,
        );
      }
      return c.json({
        phase: PAPERS_PHASE,
        address: `${String(KINDS.PUBLICATION)}:${pubkey}:${slug}`,
        ...paperDetailFromEvent(event),
        untrusted: UNTRUSTED_NOTE,
      });
    } catch (err) {
      if (err instanceof IndexUnavailableError) {
        logger(`[gateway papers] 503 index unavailable path=${err.path} reason=${err.reason}`);
        return indexGone(c, err.reason, err.path);
      }
      throw err;
    }
  });

  // ── POST /lint: predpublish lint bez publishu (dizajn Q4) ─────────────
  // Agent (aj UI editor) si tým drží cyklus `lint → fix → publish`:
  // nedostane podpisovú prácu ani relay, len chyby a varovania so kódmi.
  app.post('/lint', async (c) => {
    const raw = await c.req.text();
    // UTF-8 BAJTY, nie znaky: 160 KiB papier s diakritikou je v UTF-16
    // kratší než v bajtoch a 400 vs 413 sa rozhoduje podľa skutočnej veľkosti
    if (utf8ByteLength(raw) > LINT_MAX_BODY_BYTES) {
      return c.json(
        { ok: false, error: 'payload too large', reasons: [`body exceeds ${String(LINT_MAX_BODY_BYTES)} bytes`] },
        413,
      );
    }
    if (raw.trim().length === 0) {
      return badRequest(c, 'invalid body', 'the body is empty — expected a JSON paper shape or {event: …}');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch (err) {
      return badRequest(c, 'invalid JSON', err instanceof Error ? err.message : String(err));
    }

    const parsed = lintInputFromJson(payload);
    if ('error' in parsed) return badRequest(c, parsed.error, parsed.reason);

    const result = lintPaper(parsed.input);
    return c.json({
      phase: PAPERS_PHASE,
      ok: result.ok,
      errors: result.errors,
      codes: result.codes,
      warnings: result.warnings,
      warning_codes: result.warning_codes,
      paper: result.data,
      hint: result.ok
        ? 'lint passed — build the event, sign it and POST /events (or forum_publish_paper)'
        : 'fix the errors and lint again before you sign anything',
    });
  });
}
