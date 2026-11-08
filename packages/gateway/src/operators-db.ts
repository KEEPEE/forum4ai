/**
 * SQLite operators table — a CACHE owned by the gateway (design B5).
 *
 * Important: this is NOT the source of truth. The source of truth is the
 * owner-signed `kind 30028, d=forum4ai-writers` (see `writers.ts`); the table can
 * be rebuilt from it and the gateway updates it on every change. We also keep
 * states here that the event does not carry (`pending`, `lapsed`, `revoked`) —
 * those are operational audit, not policy.
 *
 * Why a separate DB: the indexer DB is mounted `:ro` for the gateway and the only
 * writer is the indexer. Writing into it would mean two writers on one file
 * across two containers.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type { OperatorSource, OperatorStatus as GateStatus } from './write-gate.js';
import {
  MAX_FAILED_CHECKS,
  REGISTRATION_TTL_S,
  RESAMPLE_INTERVAL_S,
  type WriterEntry,
} from './writers.js';

export type OperatorStatus = GateStatus;

export interface OperatorRow {
  pubkey: string;
  relay: string;
  status: OperatorStatus;
  registeredAt: number;
  expiresAt: number;
  lastCheck: number;
  failCount: number;
  claimId: string;
  note: string;
  agents: string[];
}

interface DbRow {
  pubkey: string;
  relay: string | null;
  status: string;
  registered_at: number | null;
  expires_at: number | null;
  last_check: number | null;
  fail_count: number | null;
  claim_id: string | null;
  note: string | null;
  agents_json: string | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operators (
  pubkey         TEXT PRIMARY KEY,
  relay          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','active','lapsed','revoked')),
  registered_at  INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL DEFAULT 0,
  last_check     INTEGER NOT NULL DEFAULT 0,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  claim_id       TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  agents_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS operators_status_idx ON operators(status);

-- prevádzkové kurzory (kedy sme naposledy preskúmali zoznam pisúcich)
CREATE TABLE IF NOT EXISTS registration_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function parseAgents(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item));
  } catch {
    return [];
  }
}

function toRow(row: DbRow): OperatorRow {
  return {
    pubkey: row.pubkey,
    relay: row.relay ?? '',
    status: (row.status ?? 'pending') as OperatorStatus,
    registeredAt: row.registered_at ?? 0,
    expiresAt: row.expires_at ?? 0,
    lastCheck: row.last_check ?? 0,
    failCount: row.fail_count ?? 0,
    claimId: row.claim_id ?? '',
    note: row.note ?? '',
    agents: parseAgents(row.agents_json),
  };
}

export interface OperatorsDbOptions {
  path: string;
  /** injectable hodiny (testy) */
  now?: () => number;
  /**
   * `:memory:` je implicitné pre testy; skutočná cesta sa pred otvorením
   * postarí o adresár (bind mount na VPS existuje, ale prvý štart pred
   * prvým zápisom súbor ešte neexistuje).
   */
  logger?: (line: string) => void;
}

export class OperatorsDb implements OperatorSource {
  readonly db: Database.Database;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: OperatorsDbOptions) {
    if (options.path !== ':memory:' && options.path !== '') {
      const dir = dirname(options.path);
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA_SQL);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = options.logger ?? (() => undefined);
  }

  close(): void {
    this.db.close();
  }

  // ── OperatorSource (spotrebuje to WriteGate) ──────────────────────────────

  /**
   * Stav operátora pre write-gate. `active` s prečítaným `expires_at` v
   * minulosti sa hlási ako `lapsed` a TRVALO sa prepíše — inak by expirácia
   * vyžadovala bežiaci časovač, aby vôbec vôšla v platnosť.
   */
  operatorStatus(pubkey: string): OperatorStatus | null {
    const normalized = pubkey.toLowerCase();
    const raw = this.db
      .prepare('SELECT status, expires_at FROM operators WHERE pubkey = ?')
      .get(normalized) as { status: string; expires_at: number } | undefined;
    if (raw === undefined) return null;
    if (raw.status === 'active' && raw.expires_at > 0 && raw.expires_at <= this.now()) {
      this.db.prepare("UPDATE operators SET status = 'lapsed', fail_count = 0 WHERE pubkey = ?").run(normalized);
      this.log(`operator ${normalized.slice(0, 8)}… expired (expires_at ${String(raw.expires_at)}) → lapsed`);
      return 'lapsed';
    }
    return raw.status as OperatorStatus;
  }

  /**
   * Agent → operátor, ktorého 30028 `d=agents` ho obsahuje. Zoznam agentov
   * držíme v `agents_json` (aktualizuje ho `syncAgents` z relaye), lebo
   * write-gate beží na každom evente a relay dotaz by bol príliš drahý.
   */
  agentOf(pubkey: string): { operator: string } | null {
    const normalized = pubkey.toLowerCase();
    const row = this.db
      .prepare("SELECT pubkey, status, agents_json FROM operators WHERE agents_json LIKE '%' || ? || '%'")
      .all(normalized) as DbRow[];
    for (const candidate of row) {
      const agents = parseAgents(candidate.agents_json);
      if (!agents.includes(normalized)) continue;
      const status = this.operatorStatus(candidate.pubkey);
      if (status !== 'active') return null;
      return { operator: candidate.pubkey };
    }
    return null;
  }

  // ── zápisy ────────────────────────────────────────────────────────────────

  /** nový claim → `pending` (ale hneď `active` pri `auto` móde) */
  upsertClaim(input: {
    pubkey: string;
    relay: string;
    claimId: string;
    status?: OperatorStatus;
    registeredAt?: number;
    expiresAt?: number;
  }): OperatorRow {
    const nowS = input.registeredAt ?? this.now();
    const expiresAt = input.expiresAt ?? nowS + REGISTRATION_TTL_S;
    const status = input.status ?? 'pending';
    this.db
      .prepare(
        `INSERT INTO operators (pubkey, relay, status, registered_at, expires_at, last_check, fail_count, claim_id)
         VALUES (@pubkey, @relay, @status, @registered_at, @expires_at, @last_check, 0, @claim_id)
         ON CONFLICT(pubkey) DO UPDATE SET
           relay = excluded.relay,
           status = excluded.status,
           registered_at = excluded.registered_at,
           expires_at = excluded.expires_at,
           last_check = excluded.last_check,
           fail_count = 0,
           claim_id = excluded.claim_id`,
      )
      .run({
        pubkey: input.pubkey.toLowerCase(),
        relay: input.relay,
        status,
        registered_at: nowS,
        expires_at: expiresAt,
        last_check: this.now(),
        claim_id: input.claimId,
      });
    return this.get(input.pubkey) as OperatorRow;
  }

  setStatus(pubkey: string, status: OperatorStatus, note?: string): OperatorRow | null {
    const normalized = pubkey.toLowerCase();
    const info = this.db
      .prepare('UPDATE operators SET status = ?, note = COALESCE(?, note), fail_count = 0 WHERE pubkey = ?')
      .run(status, note ?? null, normalized);
    if (info.changes === 0) return null;
    return this.get(normalized);
  }

  /**
   * Výsledok kontroly replikácie (dizajn B7): 3 zlyhania za sebou → `lapsed`,
   * úspech resetuje počítadlo a posunie `last_check`.
   */
  recordCheck(pubkey: string, ok: boolean): OperatorStatus | null {
    const normalized = pubkey.toLowerCase();
    const current = this.get(normalized);
    if (current === null) return null;
    if (ok) {
      this.db
        .prepare('UPDATE operators SET last_check = ?, fail_count = 0 WHERE pubkey = ?')
        .run(this.now(), normalized);
      return current.status;
    }
    const failCount = current.failCount + 1;
    const status: OperatorStatus = failCount >= MAX_FAILED_CHECKS ? 'lapsed' : current.status;
    this.db
      .prepare('UPDATE operators SET fail_count = ?, status = ? WHERE pubkey = ?')
      .run(failCount, status, normalized);
    return status;
  }

  setAgents(pubkey: string, agents: readonly string[]): void {
    const clean = [...new Set(agents.map((agent) => agent.toLowerCase()))].filter((agent) =>
      /^[0-9a-f]{64}$/.test(agent),
    );
    this.db
      .prepare('UPDATE operators SET agents_json = ? WHERE pubkey = ?')
      .run(JSON.stringify(clean), pubkey.toLowerCase());
  }

  // ── materializácia 30028 (dizajn B5: tabuľka je cache eventu) ─────────────

  /**
   * Aplikuje zoznam pisúcich z owner-signed 30028. Operátor v zozname =
   * `active`; operátor, ktorý v zozname nie je a bol `active`, sa stáva
   * `lapsed` (revoked nastavuje CLI explicitne, lebo k tomu patrí 1040
   * LABEL — ten v evente nie je).
   */
  applyWriters(operators: readonly WriterEntry[]): { activated: number; deactivated: number } {
    const nowS = this.now();
    const wanted = new Map<string, WriterEntry>();
    for (const operator of operators) wanted.set(operator.pubkey.toLowerCase(), operator);

    let activated = 0;
    let deactivated = 0;
    const tx = this.db.transaction(() => {
      for (const [pubkey, entry] of wanted) {
        const existing = this.get(pubkey);
        if (existing === null) {
          this.db
            .prepare(
              `INSERT INTO operators (pubkey, relay, status, registered_at, expires_at, last_check)
               VALUES (?, ?, 'active', ?, ?, ?)`,
            )
            .run(pubkey, entry.relay, entry.registeredAt || nowS, entry.expiresAt || nowS + REGISTRATION_TTL_S, nowS);
          activated += 1;
          continue;
        }
        this.db
          .prepare(
            `UPDATE operators
                SET relay = ?, status = 'active', expires_at = ?, last_check = ?, fail_count = 0
              WHERE pubkey = ?`,
          )
          .run(entry.relay, entry.expiresAt || existing.expiresAt, nowS, pubkey);
        if (existing.status !== 'active') activated += 1;
      }
      for (const row of this.list('active')) {
        if (wanted.has(row.pubkey)) continue;
        this.db.prepare("UPDATE operators SET status = 'lapsed' WHERE pubkey = ?").run(row.pubkey);
        deactivated += 1;
      }
    });
    tx();
    return { activated, deactivated };
  }

  /** aktívni operátori vo formáte pre republish 30028 */
  activeWriters(): WriterEntry[] {
    return this.list('active').map((row) => ({
      pubkey: row.pubkey,
      relay: row.relay,
      registeredAt: row.registeredAt,
      expiresAt: row.expiresAt,
    }));
  }

  /** operátori, ktorých treba znovu overiť (posledná kontrola nad týždňom) */
  dueForResample(): OperatorRow[] {
    const cutoff = this.now() - RESAMPLE_INTERVAL_S;
    const rows = this.db
      .prepare("SELECT * FROM operators WHERE status = 'active' AND last_check <= ?")
      .all(cutoff) as DbRow[];
    return rows.map(toRow);
  }

  // ── čítanie ───────────────────────────────────────────────────────────────

  get(pubkey: string): OperatorRow | null {
    const row = this.db.prepare('SELECT * FROM operators WHERE pubkey = ?').get(pubkey.toLowerCase()) as
      | DbRow
      | undefined;
    return row === undefined ? null : toRow(row);
  }

  list(status?: OperatorStatus): OperatorRow[] {
    const rows =
      status === undefined
        ? (this.db.prepare('SELECT * FROM operators ORDER BY pubkey').all() as DbRow[])
        : (this.db.prepare('SELECT * FROM operators WHERE status = ? ORDER BY pubkey').all(status) as DbRow[]);
    return rows.map(toRow);
  }

  countByStatus(): Record<OperatorStatus, number> {
    const counts: Record<OperatorStatus, number> = { pending: 0, active: 0, lapsed: 0, revoked: 0 };
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM operators GROUP BY status').all() as {
      status: OperatorStatus;
      n: number;
    }[]) {
      if (row.status in counts) counts[row.status] = row.n;
    }
    return counts;
  }

  // ── meta kurzory ──────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM registration_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO registration_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}

export function openOperatorsDb(path: string, opts?: { now?: () => number; logger?: (line: string) => void }): OperatorsDb {
  return new OperatorsDb({ path, ...opts });
}
