/**
 * The SQLite federation state (Phase 6a, design Q5) — `fed.db`, which the
 * GATEWAY owns and nobody else writes into.
 *
 * Why a separate DB file (not tables in `operators.db` / `indexer.db`):
 *  - `indexer.db` is mounted `:ro` for the gateway and the writer is the indexer —
 *    writing into it would mean two writers across two containers
 *    (the same reason that stands behind `operators.db`),
 *  - `operators.db` is the cache of the writing policy and its schema is bound to
 *    registrations; federation state (cursors, queues, dead letters) has a
 *    different lifetime and a different severity when lost,
 *  - the default `:memory:` = a federation without configuration overwrites
 *    nothing anywhere.
 *
 * What it holds:
 *   upstreams      — a per-upstream cursor (checkpoint) + operational state
 *                    (last error, last success),
 *   remote_events  — events fetched from an upstream with ORIGIN=upstream id;
 *                    the CANONICAL copy without rewriting (no rewriting of the
 *                    signature nor of `created_at` — a remote event is data to
 *                    which we do not give more trust than its author does),
 *   push_queue     — the queue of local events for each upstream with
 *                    exponential backoff and a dead-letter list,
 *   fed_meta       — cursors and switches (key/value).
 *
 * Time units (careful, they are mixed deliberately):
 *   `checkpoint` and `created_at` are SECONDS (NIP-01 `created_at`),
 *   `next_attempt_at`, `queued_at`, `last_*_at` are MILLISECONDS (ms epoch),
 *   because we schedule the backoff in ms. Where that is confusing, the columns
 *   carry it in their name.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { ORIGIN_SELF } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

export type PushStatus = 'pending' | 'done' | 'dead';

export interface FedUpstreamRow {
  id: string;
  baseUrl: string;
  /** sekundy — najvyšší `created_at`, ktorý sme od tohto upstreamu videli */
  checkpoint: number;
  /** ms epoch */
  addedAt: number;
  lastPullAt: number;
  lastSuccessAt: number;
  pulledEvents: number;
  lastError: string;
}

export interface FedQueueRow {
  upstreamId: string;
  eventId: string;
  kind: number;
  status: PushStatus;
  attempts: number;
  lastError: string;
  /** ms epoch — kedy smie ďalší pokus prebehnúť (backoff) */
  nextAttemptAt: number;
  queuedAt: number;
  sentAt: number;
  /** kánonický JSON eventu (7 polí) */
  payload: string;
}

export interface FedQueueStats {
  pending: number;
  /** pending, ktorým už vypršal backoff (dnes odosielateľné) */
  due: number;
  dead: number;
  done: number;
  total: number;
}

export interface RemoteTopicRow {
  id: string;
  origin: string;
  pubkey: string;
  kind: number;
  created_at: number;
  addr: string | null;
  slug: string | null;
  parent_addr: string | null;
  content: string;
}

export interface FedDbOptions {
  path: string;
  /** injectable hodiny (ms epoch) — testy s backoffom */
  now?: () => number;
  logger?: (line: string) => void;
}

interface UpstreamDbRow {
  id: string;
  base_url: string;
  checkpoint: number | null;
  added_at: number | null;
  last_pull_at: number | null;
  last_success_at: number | null;
  pulled_events: number | null;
  last_error: string | null;
}

interface QueueDbRow {
  upstream_id: string;
  event_id: string;
  kind: number | null;
  status: string;
  attempts: number | null;
  last_error: string | null;
  next_attempt_at: number | null;
  queued_at: number | null;
  sent_at: number | null;
  payload: string | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS upstreams (
  id              TEXT PRIMARY KEY,
  base_url        TEXT NOT NULL,
  -- sekundy (NIP-01 created_at); 0 = od začiatku časovej osi
  checkpoint      INTEGER NOT NULL DEFAULT 0,
  added_at        INTEGER NOT NULL DEFAULT 0,
  last_pull_at    INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER NOT NULL DEFAULT 0,
  pulled_events   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT    NOT NULL DEFAULT ''
);

-- vzdialené eventy: kánonická kópia, origin = id upstream inštancie
CREATE TABLE IF NOT EXISTS remote_events (
  id          TEXT PRIMARY KEY,
  origin      TEXT NOT NULL,
  pubkey      TEXT NOT NULL,
  kind        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  addr        TEXT NULL,
  slug        TEXT NULL,
  parent_addr TEXT NULL,
  content     TEXT NOT NULL,
  tags_json   TEXT NOT NULL,
  sig         TEXT NOT NULL,
  event_json  TEXT NOT NULL,
  pulled_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS remote_events_origin ON remote_events (origin, created_at);
CREATE INDEX IF NOT EXISTS remote_events_kind   ON remote_events (kind, created_at);

-- push fronta per upstream + exponential backoff + dead-letter
CREATE TABLE IF NOT EXISTS push_queue (
  upstream_id     TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  kind            INTEGER NOT NULL DEFAULT 0,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','done','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  queued_at       INTEGER NOT NULL DEFAULT 0,
  sent_at         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (upstream_id, event_id)
);
CREATE INDEX IF NOT EXISTS push_queue_due
  ON push_queue (upstream_id, status, next_attempt_at, event_id);

CREATE TABLE IF NOT EXISTS fed_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function toUpstream(row: UpstreamDbRow): FedUpstreamRow {
  return {
    id: row.id,
    baseUrl: row.base_url,
    checkpoint: row.checkpoint ?? 0,
    addedAt: row.added_at ?? 0,
    lastPullAt: row.last_pull_at ?? 0,
    lastSuccessAt: row.last_success_at ?? 0,
    pulledEvents: row.pulled_events ?? 0,
    lastError: row.last_error ?? '',
  };
}

function toQueueRow(row: QueueDbRow): FedQueueRow {
  return {
    upstreamId: row.upstream_id,
    eventId: row.event_id,
    kind: row.kind ?? 0,
    status: (row.status ?? 'pending') as PushStatus,
    attempts: row.attempts ?? 0,
    lastError: row.last_error ?? '',
    nextAttemptAt: row.next_attempt_at ?? 0,
    queuedAt: row.queued_at ?? 0,
    sentAt: row.sent_at ?? 0,
    payload: row.payload ?? '',
  };
}

/** adresa `kind:pubkey:d` z `d` tagu (replaceable/addressable kindy) */
function addrOf(event: NostrEvent): string | null {
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
  if (typeof d !== 'string') return null;
  return `${String(event.kind)}:${event.pubkey}:${d}`;
}

/** slug topiku z `d` tagu (len pre 30020, inak null) */
function slugOf(event: NostrEvent): string | null {
  if (event.kind !== 30020) return null;
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
  return typeof d === 'string' && d !== '' ? d : null;
}

/** adresa rodičovského topicu z `a` tagu (koreň = null) */
function parentAddrOf(event: NostrEvent): string | null {
  const a = event.tags.find((tag) => tag[0] === 'a')?.[1];
  return typeof a === 'string' && a.includes(':') ? a : null;
}

export class FedDb {
  readonly db: Database.Database;
  readonly path: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: FedDbOptions) {
    this.path = options.path;
    if (options.path !== ':memory:' && options.path !== '') {
      const dir = dirname(options.path);
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA_SQL);
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? (() => undefined);
  }

  close(): void {
    if (!this.db.open) return;
    this.db.close();
  }

  // ── upstreams ────────────────────────────────────────────────────────────

  listUpstreams(): FedUpstreamRow[] {
    const rows = this.db
      .prepare('SELECT * FROM upstreams ORDER BY id ASC')
      .all() as UpstreamDbRow[];
    return rows.map(toUpstream);
  }

  getUpstream(id: string): FedUpstreamRow | null {
    const row = this.db.prepare('SELECT * FROM upstreams WHERE id = ?').get(id) as
      | UpstreamDbRow
      | undefined;
    return row === undefined ? null : toUpstream(row);
  }

  /**
   * Zrovná tabuľku s konfiguráciou. Nový upstream začína na checkpointe 0
   * (celá história), zmena `base_url` kurzor NEVYNULUJE (id je stabilné),
   * upstream ktorý v konfigurácii už nie je sa maže aj s jeho frontou —
   * inak by mŕtve listy rastú donekonečna a `GET /fed/state` by klamal.
   */
  syncUpstreams(list: readonly { id: string; baseUrl: string }[]): {
    added: string[];
    updated: string[];
    removed: string[];
  } {
    const wanted = new Map<string, string>();
    for (const entry of list) {
      if (entry.id !== '') wanted.set(entry.id, entry.baseUrl);
    }
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const tx = this.db.transaction(() => {
      for (const [id, baseUrl] of wanted) {
        const existing = this.getUpstream(id);
        if (existing === null) {
          this.db
            .prepare(
              `INSERT INTO upstreams (id, base_url, checkpoint, added_at)
               VALUES (?, ?, 0, ?)`,
            )
            .run(id, baseUrl, this.now());
          added.push(id);
          continue;
        }
        if (existing.baseUrl === baseUrl) continue;
        this.db.prepare('UPDATE upstreams SET base_url = ? WHERE id = ?').run(baseUrl, id);
        updated.push(id);
      }
      for (const existing of this.listUpstreams()) {
        if (wanted.has(existing.id)) continue;
        this.removeUpstream(existing.id);
        removed.push(existing.id);
      }
    });
    tx();
    if (added.length > 0 || removed.length > 0) {
      this.log(
        `[fed] upstreams: pridane=[${added.join(', ')}] odstranene=[${removed.join(', ')}]`,
      );
    }
    return { added, updated, removed };
  }

  removeUpstream(id: string): void {
    this.db.prepare('DELETE FROM push_queue WHERE upstream_id = ?').run(id);
    this.db.prepare('DELETE FROM upstreams WHERE id = ?').run(id);
  }

  /** kurzor je monotónny — nikdy sa neposunie dozadu (mimo explicitného resyncu) */
  bumpCheckpoint(id: string, checkpoint: number): void {
    this.db
      .prepare('UPDATE upstreams SET checkpoint = MAX(checkpoint, ?) WHERE id = ?')
      .run(Math.max(0, Math.floor(checkpoint)), id);
  }

  resetCheckpoint(id: string): boolean {
    const info = this.db
      .prepare("UPDATE upstreams SET checkpoint = 0, last_error = '' WHERE id = ?")
      .run(id);
    return info.changes > 0;
  }

  recordPullAttempt(id: string, ok: boolean, pulled: number, error: string): void {
    const nowMs = this.now();
    if (ok) {
      this.db
        .prepare(
          `UPDATE upstreams
              SET last_pull_at = ?, last_success_at = ?, last_error = '', pulled_events = pulled_events + ?
            WHERE id = ?`,
        )
        .run(nowMs, nowMs, pulled, id);
      return;
    }
    this.db
      .prepare('UPDATE upstreams SET last_pull_at = ?, last_error = ? WHERE id = ?')
      .run(nowMs, error.slice(0, 500), id);
  }

  recordPushSuccess(id: string): void {
    const nowMs = this.now();
    this.db
      .prepare("UPDATE upstreams SET last_success_at = ?, last_error = '' WHERE id = ?")
      .run(nowMs, id);
  }

  recordPushError(id: string, error: string): void {
    this.db.prepare('UPDATE upstreams SET last_error = ? WHERE id = ?').run(error.slice(0, 500), id);
  }

  // ── remote events ────────────────────────────────────────────────────────

  hasEvent(id: string): boolean {
    const inRemote = this.db.prepare('SELECT 1 AS x FROM remote_events WHERE id = ?').get(id);
    if (inRemote !== undefined) return true;
    // lokálne eventy v frontu nikdy netlačíme späť (split-horizon) — stačí
    // vedieť, že id už poznáme z ktoréhokoľvek zdroja
    const inQueue = this.db.prepare('SELECT 1 AS x FROM push_queue WHERE event_id = ? LIMIT 1').get(id);
    return inQueue !== undefined;
  }

  hasRemoteEvent(id: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM remote_events WHERE id = ?').get(id) !== undefined;
  }

  /**
   * Uloží vzdialený event. `false` = už sme ho videli (dedup per id).
   * Event sa NEMENÍ: `created_at`, `pubkey` ani podpis sa neprepisujú —
   * origin sa ukladá VEDĽA neho ako metadata našej inštancie.
   */
  insertRemoteEvent(origin: string, event: NostrEvent, pulledAt?: number): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO remote_events
           (id, origin, pubkey, kind, created_at, addr, slug, parent_addr, content,
            tags_json, sig, event_json, pulled_at)
         VALUES (@id, @origin, @pubkey, @kind, @created_at, @addr, @slug, @parent_addr, @content,
                 @tags_json, @sig, @event_json, @pulled_at)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        id: event.id,
        origin: origin === '' ? ORIGIN_SELF : origin,
        pubkey: event.pubkey,
        kind: event.kind,
        created_at: event.created_at,
        addr: addrOf(event),
        slug: slugOf(event),
        parent_addr: parentAddrOf(event),
        content: event.content,
        tags_json: JSON.stringify(event.tags ?? []),
        sig: event.sig,
        event_json: JSON.stringify(event),
        pulled_at: pulledAt ?? this.now(),
      });
    return info.changes > 0;
  }

  remoteCount(origin?: string): number {
    const row =
      origin === undefined
        ? (this.db.prepare('SELECT count(*) AS n FROM remote_events').get() as { n: number })
        : (this.db.prepare('SELECT count(*) AS n FROM remote_events WHERE origin = ?').get(origin) as {
            n: number;
          });
    return row?.n ?? 0;
  }

  /** eventy z upstreamu `origin` od `since` (sekundy, INKLUZÍVNE) po `limit` */
  remoteEvents(origin: string, opts?: { since?: number; limit?: number }): NostrEvent[] {
    const since = opts?.since ?? 0;
    const limit = Math.max(1, Math.min(1000, opts?.limit ?? 200));
    const rows = this.db
      .prepare(
        `SELECT event_json FROM remote_events
          WHERE origin = ? AND created_at >= ?
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(origin, since, limit) as Array<{ event_json: string }>;
    const out: NostrEvent[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.event_json) as NostrEvent);
      } catch {
        /* poškodená kópia — preskočíme, index ju aj tak nezapisuje */
      }
    }
    return out;
  }

  /**
   * Koreňové addressable topiky (30020 bez `a` tagu) videné od upstreamu
   * `origin` — podklad pre sekciu „Network". Vzdialené korene sa NIKDY
   * neprepájajú do domáceho stromu (Q5).
   */
  remoteRootTopics(origin: string, limit = 50): RemoteTopicRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, origin, pubkey, kind, created_at, addr, slug, parent_addr, content
           FROM remote_events
          WHERE origin = ? AND kind = 30020 AND parent_addr IS NULL
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(origin, Math.max(1, Math.min(200, limit))) as RemoteTopicRow[];
    return rows;
  }

  /** počet všetkých vzdialených topikov per upstream (diag. stromu) */
  remoteTopicCount(origin: string): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM remote_events WHERE origin = ? AND kind = 30020')
      .get(origin) as { n: number };
    return row?.n ?? 0;
  }

  // ── push queue ───────────────────────────────────────────────────────────

  /**
   * Zaradí lokálny event do fronty jedného upstreamu.
   *
   * `skipped-remote` = split-horizon: event sme stiahli od NIEKOD (alebo ho
   * už tlačíme inam), takže ho späť do upstreamu neposielame — inak by sa
   * kópioval donekonečna (A→B→A).
   * `skipped-known`   = ten istý id sme tomuto upstreamu už poslali
   *                     (dedup per id, PK `(upstream_id, event_id)`).
   */
  enqueuePush(upstreamId: string, event: NostrEvent): 'queued' | 'skipped-remote' | 'skipped-known' {
    if (this.hasRemoteEvent(event.id)) return 'skipped-remote';
    const existing = this.db
      .prepare('SELECT status FROM push_queue WHERE upstream_id = ? AND event_id = ?')
      .get(upstreamId, event.id) as { status: string } | undefined;
    if (existing !== undefined) return 'skipped-known';
    const nowMs = this.now();
    this.db
      .prepare(
        `INSERT INTO push_queue (upstream_id, event_id, kind, payload, status, attempts, next_attempt_at, queued_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(upstreamId, event.id, event.kind, JSON.stringify(event), nowMs, nowMs);
    return 'queued';
  }

  /** jedna položka fronty (diag. a výpočet backoffu pred zápisom zlyhania) */
  getQueueRow(upstreamId: string, eventId: string): FedQueueRow | null {
    const row = this.db
      .prepare('SELECT * FROM push_queue WHERE upstream_id = ? AND event_id = ?')
      .get(upstreamId, eventId) as QueueDbRow | undefined;
    return row === undefined ? null : toQueueRow(row);
  }

  /** fronta per upstream: len `pending` s already-elapsed backoffom */
  duePushes(upstreamId: string, limit: number, nowMs?: number): FedQueueRow[] {
    const at = nowMs ?? this.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM push_queue
          WHERE upstream_id = ? AND status = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, queued_at ASC, event_id ASC
          LIMIT ?`,
      )
      .all(upstreamId, at, Math.max(1, Math.min(500, limit))) as QueueDbRow[];
    return rows.map(toQueueRow);
  }

  markPushSent(upstreamId: string, eventId: string): void {
    this.db
      .prepare(
        `UPDATE push_queue
            SET status = 'done', sent_at = ?, last_error = '', next_attempt_at = 0
          WHERE upstream_id = ? AND event_id = ?`,
      )
      .run(this.now(), upstreamId, eventId);
  }

  /**
   * Zlyhanie → buď `retry` s nastaveným backoffom, alebo `dead`
   * (dead-letter po `maxAttempts`). Volajúci (engine) počíta dĺžku
   * backoffu, DB len uloží verdikt — testy tak dokážu overiť, že
   * `next_attempt_at` je v budúcnosti a rastie exponenciálne.
   */
  markPushFailure(
    upstreamId: string,
    eventId: string,
    error: string,
    nextAttemptAt: number,
    maxAttempts: number,
  ): 'retry' | 'dead' {
    const attempts =
      ((this.db
        .prepare('SELECT attempts FROM push_queue WHERE upstream_id = ? AND event_id = ?')
        .get(upstreamId, eventId) as { attempts: number } | undefined)?.attempts ?? 0) + 1;
    const status: PushStatus = attempts >= maxAttempts ? 'dead' : 'pending';
    this.db
      .prepare(
        `UPDATE push_queue
            SET attempts = ?, status = ?, last_error = ?, next_attempt_at = ?
          WHERE upstream_id = ? AND event_id = ?`,
      )
      .run(attempts, status, error.slice(0, 500), status === 'dead' ? 0 : nextAttemptAt, upstreamId, eventId);
    return status === 'dead' ? 'dead' : 'retry';
  }

  queueStats(upstreamId: string, nowMs?: number): FedQueueStats {
    const at = nowMs ?? this.now();
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'pending' AND next_attempt_at <= ? THEN 1 ELSE 0 END) AS due,
           SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
           COUNT(*) AS total
         FROM push_queue WHERE upstream_id = ?`,
      )
      .get(at, upstreamId) as {
      pending: number | null;
      due: number | null;
      dead: number | null;
      done: number | null;
      total: number | null;
    };
    return {
      pending: row?.pending ?? 0,
      due: row?.due ?? 0,
      dead: row?.dead ?? 0,
      done: row?.done ?? 0,
      total: row?.total ?? 0,
    };
  }

  /**
   * Vymaže dokončené položky staršie ako `keepMs` (default 24 h). Fronta by
   * inak rástla donekonečna a každé `GET /fed/state` by scanovalo milióny
   * riadok. Mŕtve listy mažu RUČNE (sú to dôkaz o strate, nie šum).
   */
  pruneDone(keepMs = 24 * 60 * 60 * 1000): number {
    const cutoff = this.now() - keepMs;
    return this.db
      .prepare("DELETE FROM push_queue WHERE status = 'done' AND sent_at < ?")
      .run(cutoff).changes;
  }

  /** mŕtve listy (audit) — posledných `limit` */
  deadLetters(upstreamId: string, limit = 20): FedQueueRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM push_queue WHERE upstream_id = ? AND status = 'dead'
          ORDER BY queued_at DESC, event_id ASC LIMIT ?`,
      )
      .all(upstreamId, Math.max(1, Math.min(200, limit))) as QueueDbRow[];
    return rows.map(toQueueRow);
  }

  // ── meta kurzory ─────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM fed_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO fed_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}

export function openFedDb(path: string, opts?: Omit<FedDbOptions, 'path'>): FedDb {
  return new FedDb({ path, ...opts });
}
