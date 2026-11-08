/**
 * Writer allowlist for INGEST (design B9 last sentence, P1).
 *
 * Why the indexer too, when the gateway holds the gate: strfry is a
 * persistent store that can also be fed by peer synchronization (negentropy)
 * — not only by our gateway. An event from a disallowed pubkey can thus
 * appear in a relay, the indexer will pull it, and it would hurt in /search,
 * /reputation and /ideas even after the gateway never accepted it. So we
 * filter the index with the SAME list.
 *
 * Two sources, summed:
 *   1. `INDEXER_WRITE_ALLOW` — bootstrap allowlist (the same pubkeys as
 *      `GATEWAY_WRITE_ALLOW`), deterministic seed keys and the owner's
 *      operator key.
 *   2. `INDEXER_OPERATORS_DB` — read-only path to the gateway-owned
 *      `operators.db` (caches owner-signed 30028). Precisely because the
 *      gateway maintains it, registered operators (approved via
 *      `operator approve`) appear in the index without restarting the indexer.
 *
 * Both empty = filter OFF (we index everything) — the 127.0.0.1 dev instance
 * must not change behavior when the write-gate is introduced.
 */
import Database from 'better-sqlite3';

const HEX64 = /^[0-9a-f]{64}$/;

/** ako často sa smie znova otvoriť zoznam operátorov z DB (ms) */
export const OPERATORS_REFRESH_MS_DEFAULT = 60_000;

export interface WriterAllowlistOptions {
  /** bootstrap pubkey (64-hex); neplatné položky zahadzujeme */
  allow?: Iterable<string>;
  /** read-only cesta k `operators.db` gatewaya (null = nepoužiť) */
  operatorsDbPath?: string | null;
  /**
   * Phase 6a (dizajn Q5): pubkeyy z dôveryhodných adresárov cudzích
   * inštancií (`INDEXER_TRUST_DIRECTORIES`). Sčítavajú sa LEN do tohto
   * indexového filtra — nikdy nie do gateway write-gate.
   *
   * Dôvod, prečo `enabled` od nich NEZÁVISÍ: filter zostáva zapnutý len vtedy,
   * keď inštancia sama niečo obmedzuje (`INDEXER_WRITE_ALLOW` alebo
   * `operators.db`). Nastaviť len adresáre by inak zaplo filter a zahodil
   * vlastný obsah inštancie — prekvapenie, ktoré dizajn nechce.
   */
  trust?: TrustPubkeySource | null;
  refreshMs?: number;
  now?: () => number;
  logger?: (line: string) => void;
}

/** minimálny tvar `TrustDirectories` pre zjednotenie allowlistu */
export interface TrustPubkeySource {
  enabled: boolean;
  has(pubkey: string): boolean;
}

/**
 * Parsuj allowlist z env (čiarka / medzera / newline). Rovnaká tolerancia
 * ako `parseWriteAllowlist` na gatewayi — jedna preklepnutá položka nesmie
 * znefunkčniť celý filter.
 */
export function parseWriteAllow(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(/[\s,]+/)) {
    const value = part.trim().toLowerCase();
    if (HEX64.test(value)) out.add(value);
  }
  return out;
}

export class WriterAllowlist {
  private readonly bootstrap: Set<string>;
  private readonly operatorsDbPath: string | null;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** aktívni operátori z DB (obnovuje sa `refreshMs`-po) */
  private operators = new Set<string>();
  private lastRefresh = 0;
  private db: Database.Database | null = null;
  private dbBroken = false;
  private skipped = 0;
  /** Phase 6a: cudzie adresáre (null = env nenastavený) */
  private readonly trust: TrustPubkeySource | null;
  /** spočítané zahodenia kvôli adresárom (diagnostika) */
  private trustHits = 0;

  constructor(options: WriterAllowlistOptions = {}) {
    const bootstrap = new Set<string>();
    for (const key of options.allow ?? []) {
      const value = key.trim().toLowerCase();
      if (HEX64.test(value)) bootstrap.add(value);
    }
    this.bootstrap = bootstrap;
    this.operatorsDbPath = options.operatorsDbPath ?? null;
    this.trust = options.trust ?? null;
    this.refreshMs = options.refreshMs ?? OPERATORS_REFRESH_MS_DEFAULT;
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? (() => undefined);
  }

  /** `false` = filter je vypnutý (indexujeme aj eventy neznámych pubkey) */
  get enabled(): boolean {
    return this.bootstrap.size > 0 || this.operatorsDbPath !== null;
  }

  get bootstrapCount(): number {
    return this.bootstrap.size;
  }

  get operatorCount(): number {
    return this.operators.size;
  }

  get skippedCount(): number {
    return this.skipped;
  }

  /** Phase 6a: koľkokrát povolil index len cudzí adresár (diagnostika) */
  get trustHitCount(): number {
    return this.trustHits;
  }

  /**
   * Smie sa tento event indexovať? `true` = áno (vrátane prípadu, keď je
   * filter vypnutý). Volá sa PRED overením podpisu — vylúčený pubkey je
   * lacnejší test ako Schnorr, a práve to je na filter účel (cudzí relay
   * nám môže poslať tisíce cudzích eventov).
   */
  isAllowed(pubkey: string): boolean {
    if (!this.enabled) return true;
    const normalized = pubkey.toLowerCase();
    if (this.bootstrap.has(normalized)) return true;
    this.maybeRefresh();
    if (this.operators.has(normalized)) return true;
    // Phase 6a (dizajn Q5): cudzí adresár povoluje INDEX, nie zápis.
    // Bez tohto riadku by B-ov indexer zahodil A-ke vlákna skôr, než by sa
    // vôbec dostali do /search — a to je presne ten bug, ktorý Q5 rieši.
    if (this.trust !== null && this.trust.enabled && this.trust.has(normalized)) {
      this.trustHits += 1;
      return true;
    }
    this.skipped += 1;
    return false;
  }

  private maybeRefresh(): void {
    if (this.operatorsDbPath === null || this.dbBroken) return;
    const nowMs = this.now();
    if (nowMs - this.lastRefresh < this.refreshMs) return;
    this.refresh();
  }

  /**
   * Obnoví zoznam aktívnych operátorov z gateway DB. Otvárame ju
   * `readonly + fileMustExist`: writerom je gateway (WAL), my sme len
   * čitateľ — rovnaký vzor, akým gateway číta indexer DB.
   */
  refresh(): number {
    this.lastRefresh = this.now();
    if (this.operatorsDbPath === null) return this.operators.size;
    try {
      if (this.db === null) {
        this.db = new Database(this.operatorsDbPath, { readonly: true, fileMustExist: true });
        this.db.pragma('busy_timeout = 3000');
      }
      const rows = this.db
        .prepare("SELECT pubkey FROM operators WHERE status = 'active'")
        .all() as { pubkey: string }[];
      const next = new Set<string>();
      for (const row of rows) {
        const normalized = String(row.pubkey).toLowerCase();
        if (HEX64.test(normalized)) next.add(normalized);
      }
      const changed = next.size !== this.operators.size;
      this.operators = next;
      if (changed) this.log(`[indexer] allowlist: ${String(next.size)} aktívnych operátorov z ${this.operatorsDbPath}`);
      return next.size;
    } catch (err) {
      // DB ešte neexistuje (gateway ešte nezapisoval) — filter beží len
      // z bootstrap allowlistu. Pri trvalej chybe už nezkúšame znova.
      this.dbBroken = true;
      this.db = null;
      this.log(
        `[indexer] operators.db (${this.operatorsDbPath}) nie je čitateľná: ${err instanceof Error ? err.message : String(err)} — filtrujem len z INDEXER_WRITE_ALLOW`,
      );
      return this.operators.size;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* už zavreté */
    }
    this.db = null;
  }
}
