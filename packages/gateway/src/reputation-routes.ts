/**
 * `GET /reputation/:pubkey` — the REST reputation view (F4AI-15, S9), the IO layer.
 *
 * Data source: the indexer SQLite DB opened **read-only** — the same pattern as
 * `search-routes.ts`/`search.ts` (F4AI-14): the indexer is the only writer,
 * the gateway reads the same WAL file without blocking and copies nothing itself.
 *
 * Decision (same as S8): index not available → **503
 * `{ error: 'index unavailable' }`**, no silent fallback.
 *
 * Parameters:
 *   :pubkey          required 64-hex pubkey
 *   ?domain=…        optional filter: `voter` | `author` | `helper`
 *                    (the response then contains only that domain)
 *
 * 200 response:
 *   { phase, pubkey, epoch, domains: { voter|author|helper →
 *       { score, n_eff, positive, total } }, counts, untrusted,
 *     params: { z, agent_cap, cluster_cap, op_cap },
 *     ...(domain ? { domain } : {}) }
 *   `score` is a Wilson lower bound (not an average), `n_eff` the Kish effective
 *   sample size, `positive`/`total` raw evidence counts, `epoch` the current
 *   watermark of the dataset.
 *
 * Errors:
 *   400 `invalid pubkey`  — the pubkey is not 64 hex
 *   400 `invalid domain`  — domain outside {voter, author, helper}
 *   404 `pubkey not found`— the pubkey has not even ONE event in the index (no
 *                           authored nor vote trace) — the reputation view
 *                           cannot be computed from an empty log
 *   503 `index unavailable` — GATEWAY_INDEX_DB unset / the DB cannot be opened
 *
 * Scaling (F1, documented): reputation is computed by replaying all events of
 * kinds 1020/1021/1023/1030/1031/1032 at once (a hard cap of
 * `REPUTATION_SCAN_LIMIT` rows, ordered newest-first so the watermark and the
 * current votes are always inside the window). The epochal snapshot 30401 and
 * an incremental recompute are S10+, not part of S9.
 */
import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { Context } from 'hono';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

import { IndexUnavailableError } from './search.js';
import {
  AGENT_CAP_DEFAULT,
  CLUSTER_CAP_DEFAULT,
  OP_CAP_DEFAULT,
  REPUTATION_PHASE,
  WILSON_Z_DEFAULT,
  computeReputation,
  isReputationDomain,
  type ReputationParams,
} from './reputation.js';

type SqliteDb = Database.Database;

const PUBKEY_RE = /^[0-9a-f]{64}$/;

/** hard-strop replay okna (riadky) — newest-first, aby watermark platil */
export const REPUTATION_SCAN_LIMIT = 200_000;

/** kindy, ktoré agregátor potrebuje na derivovanie reputácie */
export const REPUTATION_KINDS: readonly number[] = [
  KINDS.QUESTION, // 1020 — author doména
  KINDS.IDEA_CALL, // 1021 — author doména
  KINDS.POST, // 1023 — helper doména
  KINDS.VOTE, // 1030
  KINDS.SOLUTION_RATING, // 1031
  KINDS.ACCEPTED_SOLUTION, // 1032
];

export interface ReputationRouteOptions {
  /** cesta k indexer DB (GATEWAY_INDEX_DB); null = reputácia vypnutá → 503 */
  path: string | null;
  /**
   * Voliteľný injectnutý zdroj eventov (buildGateway mu drží životnosť a
   * privolá `close()`). Ak chýba, route si postaví vlastný z `path`.
   */
  source?: ReputationIndexSource;
  /** prepísanie parametrov pravidla (testy; default hodnoty modelu) */
  params?: ReputationParams;
  /** injectnable otvárač DB (testy s :memory: / dočasnou DB) */
  open?: (path: string) => SqliteDb;
  logger?: (line: string) => void;
}

/**
 * Read-only zdroj eventov reputácie. Spojenie sa drží perzistentné a
 * otvára sa lazily (gateway štartuje skôr, než indexer vytvorí DB);
 * pri zlyhaní sa skúsi znova pri ďalšom dopyte.
 */
export class ReputationIndexSource {
  readonly path: string;

  private readonly openDb: (path: string) => SqliteDb;
  private readonly checksFile: boolean;
  private readonly log: (line: string) => void;
  private db: SqliteDb | null = null;
  private lastOpenError: string | null = null;

  constructor(options: { path: string; open?: (path: string) => SqliteDb; logger?: (line: string) => void }) {
    this.path = options.path;
    this.openDb =
      options.open ?? ((path) => new Database(path, { readonly: true, fileMustExist: true }));
    this.checksFile = options.open === undefined;
    this.log = options.logger ?? ((line: string) => console.error(line));
  }

  get unavailableReason(): string | null {
    if (this.db !== null) return null;
    return this.lastOpenError ?? 'the index connection has not been opened yet';
  }

  /** diagnostika pre /health (rovnaký tvar ako search index) */
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
    if (this.checksFile) {
      // readonly + fileMustExist by na chýbajúci súbor hodilo nešpecifickú
      // SQLite chybu — rozlíšime ju explicitne pre jasný 503 dôvod
      if (!existsSync(this.path)) {
        this.lastOpenError = `index DB does not exist: ${this.path}`;
        throw new IndexUnavailableError(this.path, this.lastOpenError);
      }
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
   * Replay okna: všetky eventy reputačných kindov ( newest-first, strop
   * `limit` ), zoradené deterministicky (created_at ASC, id ASC) pre
   * agregátor. Konektívne čítanie v jednom read-only transactione.
   */
  loadEvents(limit: number = REPUTATION_SCAN_LIMIT): NostrEvent[] {
    const db = this.ensureOpen();
    const placeholders = REPUTATION_KINDS.map(() => '?').join(', ');
    const sql = `
      SELECT id, pubkey, kind, created_at, content, tags_json
      FROM (
        SELECT id, pubkey, kind, created_at, content, tags_json
        FROM events
        WHERE kind IN (${placeholders})
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
      ORDER BY created_at ASC, id ASC
    `;
    const rows = db.prepare(sql).all(...REPUTATION_KINDS, limit) as Array<{
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
        continue; // poškodený JSON v riadku — signál sa nedá použiť
      }
      events.push({
        id: row.id,
        pubkey: row.pubkey,
        created_at: row.created_at,
        kind: row.kind,
        tags,
        content: row.content,
        sig: '', // podpis pri čítaní nepotrebujeme (validoval writer pri zápise)
      });
    }
    return events;
  }

  /** existuje v indexe čo i len jeden event tohto pubkey (ľubovoľný kind)? */
  hasPubkey(pubkey: string): boolean {
    const db = this.ensureOpen();
    const row = db
      .prepare('SELECT 1 AS hit FROM events WHERE pubkey = ? LIMIT 1')
      .get(pubkey) as { hit: number } | undefined;
    return row !== undefined;
  }

  close(): void {
    if (this.db !== null && this.db.open) this.db.close();
    this.db = null;
  }
}

function badRequest(c: Context, error: string, reason: string) {
  return c.json({ ok: false, error, reasons: [reason] }, 400);
}

export function registerReputationRoutes(app: Hono, options: ReputationRouteOptions): void {
  const logger = options.logger ?? ((line: string) => console.log(line));
  const params = options.params;
  const resolved = {
    z: params?.z ?? WILSON_Z_DEFAULT,
    agentCap: params?.agentCap ?? AGENT_CAP_DEFAULT,
    clusterCap: params?.clusterCap ?? CLUSTER_CAP_DEFAULT,
    opCap: params?.opCap ?? OP_CAP_DEFAULT,
  };

  const source =
    options.source ??
    (options.path !== null
      ? new ReputationIndexSource({
          path: options.path,
          logger,
          ...(options.open !== undefined ? { open: options.open } : {}),
        })
      : null);

  app.get('/reputation/:pubkey', (c) => {
    const pubkey = c.req.param('pubkey');
    if (!PUBKEY_RE.test(pubkey)) {
      return badRequest(c, 'invalid pubkey', 'pubkey must be 64 hex characters');
    }

    const domain = c.req.query('domain');
    if (domain !== undefined && domain.trim() !== '') {
      if (!isReputationDomain(domain.trim())) {
        return badRequest(
          c,
          'invalid domain',
          `domain must be one of: voter, author, helper (got '${domain}')`,
        );
      }
    }

    if (source === null) {
      return c.json(
        {
          ok: false,
          error: 'index unavailable',
          reason: 'GATEWAY_INDEX_DB is not set — the reputation view requires the indexer DB',
          path: '(GATEWAY_INDEX_DB not set)',
        },
        503,
      );
    }

    let events: NostrEvent[];
    let known: boolean;
    try {
      events = source.loadEvents();
      known = source.hasPubkey(pubkey);
    } catch (err) {
      if (err instanceof IndexUnavailableError) {
        logger(`[gateway reputation] 503 index unavailable path=${err.path} reason=${err.reason}`);
        return c.json(
          { ok: false, error: 'index unavailable', reason: err.reason, path: err.path },
          503,
        );
      }
      throw err;
    }

    if (!known) {
      return c.json(
        {
          ok: false,
          error: 'pubkey not found',
          pubkey,
          reason: 'the pubkey has no events in the index — the reputation view cannot be computed',
        },
        404,
      );
    }

    const card = computeReputation(pubkey, events, params);
    if (domain !== undefined && domain.trim() !== '') {
      const name = domain.trim();
      // isReputationDomain bola overená vyššie — filter na jednu doménu
      const domains: Record<string, unknown> = {};
      domains[name] = card.domains[name as keyof typeof card.domains];
      return c.json({
        phase: REPUTATION_PHASE,
        pubkey: card.pubkey,
        epoch: card.epoch,
        domain: name,
        domains,
        counts: card.counts,
        params: {
          z: resolved.z,
          agent_cap: resolved.agentCap,
          cluster_cap: resolved.clusterCap,
          op_cap: resolved.opCap,
        },
        untrusted: card.untrusted,
      });
    }

    return c.json({
      phase: REPUTATION_PHASE,
      pubkey: card.pubkey,
      epoch: card.epoch,
      domains: card.domains,
      counts: card.counts,
      params: {
        z: resolved.z,
        agent_cap: resolved.agentCap,
        cluster_cap: resolved.clusterCap,
        op_cap: resolved.opCap,
      },
      untrusted: card.untrusted,
    });
  });
}
