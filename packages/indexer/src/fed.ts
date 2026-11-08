/**
 * Sweep of foreign events into the index (Phase 6a, design Q5).
 *
 * Why it exists at all: the engine's PULL stores upstream events in `fed.db`
 * (`remote_events`) but NOT in the local relays — that is `strfry router`
 * stream-down's job, which Q5 deliberately chooses (it reuses an image that
 * is already in the stack). The indexer feeds from relays, so it would never
 * see foreign content and `GET /search` would find nothing in the second
 * instance. This sweep therefore copies `remote_events` → `indexer.db` with
 * the upstream `origin`.
 *
 * Who owns what:
 *   - the GATEWAY writes `fed.db`; the indexer reads it **read-only** (the
 *     same pattern as `INDEXER_OPERATORS_DB` → gateway-owned `operators.db`),
 *   - ONLY the indexer writes `indexer.db` (FTS5 triggers), so we store the
 *     sweep cursor in `indexer_meta` in this DB — we could not write
 *     into `fed.db`.
 *
 * `origin` and `trusted`:
 *   - `origin` is the upstream id the gateway wrote at PULL time (the host of
 *     its gateway URL). It is the same value a trusted directory gives
 *     (`trust.ts`) — which is why `/search?origin=<host>` works for both paths,
 *   - `trusted = 0`: nobody from our own writers signed the content. An empty
 *     `INDEXER_TRUST_DIRECTORIES` does not change that — the sweep is an
 *     explicit upstream configuration, not trust.
 *
 * Dedup: `upsertEvent` has `ON CONFLICT(id) DO NOTHING`, so an event that is
 * already in the index as `self` (e.g. our own content that the upstream sent
 * back to us) keeps `origin = 'self'`. The local source wins over a foreign
 * one — which is also why split-horizon in the engine prevents sending
 * events back.
 */
import Database from 'better-sqlite3';

import { verifyFull } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import type { IndexerDb } from './db.js';

/** dávka jedného sweepu (remote_events môžu byť tisíce) */
export const FED_SWEEP_BATCH_DEFAULT = 500;
/** kľúč kurzora v `indexer_meta` — rowid posledného spracovaného riadku */
export const FED_SWEEP_CURSOR_KEY = 'fed_sweep_rowid';

export interface FedSweepSummary {
  /** riadkov `remote_events` prečítaných týmto sweepom */
  scanned: number;
  inserted: number;
  replaced: number;
  /** už indexované (dedup per id) — bežná hodnota pri prázdnom prírastku */
  ignored: number;
  /** preskočené, lebo kind nie je v `INDEXER_KINDS` */
  skipped: number;
  /** neplatný JSON alebo podpis */
  invalid: number;
  /** kurzor po sweepe (rowid) */
  cursor: number;
  /** prečo sa nesweepovalo (chýbajúca/cudzía DB) */
  error?: string;
}

export interface FedSourceOptions {
  /** cesta k gateway `fed.db` (`INDEXER_FED_DB`) */
  path: string;
  /** cieľová DB indexera (writer) */
  db: IndexerDb;
  batch?: number;
  /** ak je zadané, kindy mimo neho sa preskočia (rešpektuje `INDEXER_KINDS`) */
  kinds?: Iterable<number>;
  logger?: (line: string) => void;
}

export class FedSource {
  readonly path: string;
  private readonly target: IndexerDb;
  private readonly batch: number;
  private readonly kinds: Set<number> | null;
  private readonly log: (line: string) => void;
  private db: Database.Database | null = null;
  /** trvalo nedostupná DB (neexistuje, nie je to SQLite, je zamknutá) */
  private broken = false;
  private lastSummary: FedSweepSummary | null = null;

  constructor(options: FedSourceOptions) {
    this.path = options.path;
    this.target = options.db;
    this.batch = Math.max(1, Math.floor(options.batch ?? FED_SWEEP_BATCH_DEFAULT));
    this.kinds = options.kinds !== undefined ? new Set(options.kinds) : null;
    this.log = options.logger ?? (() => undefined);
  }

  /** `false` = sweep sa nedá použiť (chýbajúca DB); ingest beží ďalej */
  get available(): boolean {
    return !this.broken;
  }

  lastSweep(): FedSweepSummary | null {
    return this.lastSummary;
  }

  /**
   * Otvorí `fed.db` read-only. `fileMustExist: true` je zámerne: gateway
   * môže bežať o minútu neskôr ako indexer (compose start_sequence), a
   * vytvoriť PRÁZDNU fed.db indexero by znamenalo, že gateway potom padne
   * na inej schéme.
   */
  private open(): Database.Database | null {
    if (this.db !== null) return this.db;
    if (this.broken) return null;
    try {
      this.db = new Database(this.path, { readonly: true, fileMustExist: true });
      this.db.pragma('busy_timeout = 3000');
      return this.db;
    } catch (error) {
      this.broken = true;
      this.log(
        `[indexer] fed.db (${this.path}) nie je čitateľná: ${error instanceof Error ? error.message : String(error)} — ` +
          'cudzí obsah sa indexovať nebude (GATEWAY_FED_DB / INDEXER_FED_DB musia ukazovať na rovnaký súbor)',
      );
      return null;
    }
  }

  /** kurzor sweepu z `indexer_meta` (0 = od začiatku) */
  cursor(): number {
    const raw = this.target.getMeta(FED_SWEEP_CURSOR_KEY);
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  /**
   * Jeden sweep. Vracia súhrn (nikdy nehádže) — timer indexera nesmie
   * zlyhanie čítania cudzej DB premietnuť do ingestu.
   */
  sweep(): FedSweepSummary {
    const summary: FedSweepSummary = {
      scanned: 0,
      inserted: 0,
      replaced: 0,
      ignored: 0,
      skipped: 0,
      invalid: 0,
      cursor: this.cursor(),
    };
    const source = this.open();
    if (source === null) {
      summary.error = 'fed.db unavailable';
      this.lastSummary = summary;
      return summary;
    }

    let rows: Array<{ rowid: number; origin: string; event_json: string }>;
    try {
      rows = source
        .prepare(
          `SELECT rowid AS rowid, origin, event_json
           FROM remote_events
           WHERE rowid > ?
           ORDER BY rowid ASC
           LIMIT ?`,
        )
        .all(summary.cursor, this.batch) as Array<{ rowid: number; origin: string; event_json: string }>;
    } catch (error) {
      // tabuľka `remote_events` chýba = fed.db je od inej verzie gatewaya
      summary.error = error instanceof Error ? error.message : String(error);
      this.lastSummary = summary;
      return summary;
    }

    let maxRowid = summary.cursor;
    for (const row of rows) {
      summary.scanned += 1;
      maxRowid = Math.max(maxRowid, row.rowid);
      let event: NostrEvent;
      try {
        const parsed: unknown = JSON.parse(row.event_json);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        event = parsed as NostrEvent;
      } catch {
        summary.invalid += 1;
        continue;
      }
      if (this.kinds !== null && !this.kinds.has(event.kind)) {
        summary.skipped += 1;
        continue;
      }
      // podpis overujeme aj tu: `fed.db` je síce writes od nášho gatewaya,
      // ale indexer je ten, kto zaručuje, že v indexe je len overený obsah
      if (!verifyFull(event)) {
        summary.invalid += 1;
        continue;
      }
      const outcome = this.target.upsertEvent(event, {
        origin: typeof row.origin === 'string' && row.origin !== '' ? row.origin : event.pubkey,
        trusted: false,
      });
      summary[outcome] += 1;
    }

    if (maxRowid > summary.cursor) {
      this.target.setMeta(FED_SWEEP_CURSOR_KEY, String(maxRowid));
      summary.cursor = maxRowid;
    }
    if (summary.scanned > 0) {
      this.log(
        `[indexer] fed sweep: scanned=${String(summary.scanned)} inserted=${String(summary.inserted)} ` +
          `replaced=${String(summary.replaced)} ignored=${String(summary.ignored)} ` +
          `skipped=${String(summary.skipped)} invalid=${String(summary.invalid)} cursor=${String(summary.cursor)}`,
      );
    }
    this.lastSummary = summary;
    return summary;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // už zatvorené
    }
    this.db = null;
  }
}
