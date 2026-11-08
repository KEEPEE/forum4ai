/**
 * Trusted directories of foreign instances (Phase 6a, design Q5).
 *
 * `INDEXER_TRUST_DIRECTORIES=<A owner hex>` tells the second instance's index:
 * „what A's owner signed, plus whoever A considers their writers and agents,
 * is foreign but INDEXABLE content". The indexer asks for it from its LOCAL
 * relays — not from A over HTTP: the strfry `router` stream-down (design Q5)
 * has already pulled A's events into B's strfry, so A's 30028 sits there.
 * That is exactly why Q5 says B's indexer „reads A's owner-signed 30028 …
 * from its local relays".
 *
 * Two purposes, STRICTLY separated (Q5 forbids conflating them):
 *   1. **index allowlist** — directory pubkeys are ADDED to the index
 *      allowlist (`WriterAllowlist`), so a foreign thread shows up in `/search`.
 *   2. **origin and trust** — each such pubkey maps to an `origin` (instance
 *      id) and gets `trusted = 0` when written into the index.
 *
 * What it is NOT: never a write-gate. Q5: „Those pubkeys are unioned into the
 * index allowlist only, never into B's write-gate." B's write-gate still knows
 * only B's operators and agents — which is why in E2E step 7 A's owner gets
 * a 403 on B.
 *
 * `origin` is resolved in three levels (highest wins):
 *   1. explicit entry id (`<id>=<owner hex>`) — the operator's intent,
 *   2. the `["gateway", <host>]` tag from the directory (Q5: „the host from the trusted
 *      directory's `["gateway",…]`"),
 *   3. `dir:<first 8 hex>` — a deterministic placeholder so even a directory
 *      without a gateway tag has a stable id (UI then shows a chip with this id).
 *
 * Default (env unset) = `enabled === false`, no mapping, `WriterAllowlist`
 * behaves exactly as before 6a.
 */
import {
  AGENTS_D_TAG,
  KINDS,
  WRITERS_D_TAG,
  isAgentsEvent,
  isWritersEvent,
  parseAgentsEvent,
  parseWritersEvent,
  verifyFull,
} from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

const HEX64 = /^[0-9a-f]{64}$/;

/** ako často sa smie adresár znova stiahnuť z relays (ms) */
export const TRUST_REFRESH_MS_DEFAULT = 5 * 60_000;
/** timeout jedného REQ na relay (ms) */
export const TRUST_QUERY_TIMEOUT_MS_DEFAULT = 5_000;

export interface TrustDirectory {
  /** id inštancie, ktoré končí v `origin`; prázdne = odvodí sa z adresára */
  id: string;
  /** true = id nastavil operátor explicitne (`<id>=<hex>`) */
  idExplicit: boolean;
  /** 64-hex pubkey vlastníka adresára (autora 30028 `d=forum4ai-writers`) */
  owner: string;
}

export interface ParsedTrustDirectories {
  directories: TrustDirectory[];
  /** čo sme zahodili a prečo — ide do logu, nie do ticha */
  warnings: string[];
}

/**
 * Parsovanie `INDEXER_TRUST_DIRECTORIES`. Tolerované tvary položky:
 *   `<64-hex owner>`               id sa odvodí z adresára (gateway tag)
 *   `<id>=<64-hex owner>`          explicitné id (napr. `aiforum.myhood.sk=…`)
 *
 * Neplatná položka sa zahodí s varovaním — jedna preklepnutá adresa nesmie
 * znefunkčniť dôveru k zvyšku (rovnaká filozofia ako `parseWriteAllow`).
 */
export function parseTrustDirectories(raw: string | undefined | null): ParsedTrustDirectories {
  const directories: TrustDirectory[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const part of (raw ?? '').split(/[\s,]+/)) {
    const item = part.trim();
    if (item === '') continue;
    const eq = item.indexOf('=');
    let id = '';
    let owner = item;
    if (eq >= 0) {
      id = item.slice(0, eq).trim().toLowerCase();
      owner = item.slice(eq + 1).trim().toLowerCase();
    }
    if (!HEX64.test(owner)) {
      warnings.push(
        `entry ${JSON.stringify(item)}: owner pubkey must be 64-hex (or <id>=<64-hex>) — ignored`,
      );
      continue;
    }
    if (seen.has(owner)) {
      warnings.push(`owner ${owner.slice(0, 8)}… is duplicated — keeping the first entry`);
      continue;
    }
    seen.add(owner);
    directories.push({ id, idExplicit: id !== '', owner });
  }

  return { directories, warnings };
}

/** normalizuj hodnotu `["gateway", …]` tagu na host (bez schémy, cesty, lomenítka) */
export function hostFromGatewayTag(value: string | undefined): string {
  if (value === undefined) return '';
  let raw = value.trim().toLowerCase();
  if (raw === '') return '';
  const scheme = raw.indexOf('://');
  if (scheme >= 0) raw = raw.slice(scheme + 3);
  const slash = raw.indexOf('/');
  if (slash >= 0) raw = raw.slice(0, slash);
  return raw;
}

/** kánonická 7-pole kópia nostr-tools Eventu (shared funkcie chcú plain dáta) */
function canonical(event: Event): NostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: (event.tags ?? []).map((tag) => [...tag]) as NostrEvent['tags'],
    content: event.content,
    sig: event.sig,
  };
}

/**
 * LWW výber addressable eventu: najnovší `created_at`, pri rovnosti
 * lexikograficky NIŽŠIE id — tá istá regularizácia ako v `read-model.ts`
 * a v `events_addr` upserte indexera. Bez nej by dva 30028 od toho istého
 * vlastníka dali neistý výsledok (relay vráti hocijaké poradie).
 */
function pickLatest(candidates: Event[], author: string, accept: (event: NostrEvent) => boolean): NostrEvent | null {
  let best: NostrEvent | null = null;
  for (const event of candidates) {
    if (event.pubkey !== author) continue;
    const plain = canonical(event);
    if (!accept(plain)) continue;
    if (!verifyFull(plain)) continue;
    if (
      best === null ||
      plain.created_at > best.created_at ||
      (plain.created_at === best.created_at && plain.id < best.id)
    ) {
      best = plain;
    }
  }
  return best;
}

export interface TrustEntry {
  pubkey: string;
  /** id inštancie, ktorá pisúceho uvádza vo svojom adresári */
  origin: string;
  /** owner / operator / agent — pre diagnostiku (`trust status`) */
  role: 'owner' | 'operator' | 'agent';
}

export interface TrustRefreshSummary {
  /** adresárov, z ktorých sme niečo dostali */
  directories: number;
  /** pubkeyov v mape po obnove */
  pubkeys: number;
  warnings: string[];
  /** prečo sa neobnovovalo (`disabled` | `no-query` | `throttled`) */
  skipped?: string;
}

export interface TrustDirectoriesOptions {
  directories?: TrustDirectory[];
  /**
   * Čítanie relays. Povinné pre produkciu (indexer ho dostáva z `RelayPool`);
   * testy injectnú funkciu nad `MemoryStore`/prazdnu sieť, takže bez nej
   * `refresh()` nič nesľubuje — vráti `skipped: 'no-query'`.
   */
  query?: (filters: Filter[], opts?: { timeoutMs?: number }) => Promise<Event[]>;
  timeoutMs?: number;
  refreshMs?: number;
  now?: () => number;
  logger?: (line: string) => void;
}

export class TrustDirectories {
  readonly directories: TrustDirectory[];
  private readonly query?: (filters: Filter[], opts?: { timeoutMs?: number }) => Promise<Event[]>;
  private readonly timeoutMs: number;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** pubkey → položka (posledné wins: ten istý pubkey v dvoch adresároch) */
  private map = new Map<string, TrustEntry>();
  private lastRefresh = 0;
  private warnings: string[] = [];

  constructor(options: TrustDirectoriesOptions = {}) {
    this.directories = [...(options.directories ?? [])];
    this.query = options.query;
    this.timeoutMs = options.timeoutMs ?? TRUST_QUERY_TIMEOUT_MS_DEFAULT;
    this.refreshMs = options.refreshMs ?? TRUST_REFRESH_MS_DEFAULT;
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? (() => undefined);
  }

  /** `false` = env nenastavený → indexer sa správa presne ako pred 6a */
  get enabled(): boolean {
    return this.directories.length > 0;
  }

  /** mapa pubkey → pôvod (kópia, aby volajúci nemohol meniť stav) */
  snapshot(): TrustEntry[] {
    return [...this.map.values()];
  }

  /** pubkeyy adresárov — pre zjednotenie s index allowlistom */
  pubkeys(): Set<string> {
    return new Set(this.map.keys());
  }

  lookup(pubkey: string): TrustEntry | null {
    return this.map.get(pubkey.trim().toLowerCase()) ?? null;
  }

  /**
   * Tepelná cesta: ingest sa pýta na KAŽDOM evente, preto priamo `has`
   * (žiadna kópia `Set`). `false` = pubkey nepoznáme → indexový filter
   * rozhodujú domáce zdroje (bootstrap + operators.db).
   */
  has(pubkey: string): boolean {
    return this.map.has(pubkey.trim().toLowerCase());
  }

  /** pôvod pre ingest: `null` = nie je cudzí obsah (→ `origin = 'self'`) */
  originOf(pubkey: string): string | null {
    return this.map.get(pubkey.trim().toLowerCase())?.origin ?? null;
  }

  currentWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * Stiahne adresáre z relays a prestaví mapu. Volá sa pri štarte a potom
   * `refreshMs`-po; zlyhanie NIKDY nenahodí ingest — necháme mapu z
   * predchádzajúcej obnovy a len logujeme.
   */
  async refresh(): Promise<TrustRefreshSummary> {
    if (!this.enabled) return { directories: 0, pubkeys: 0, warnings: [], skipped: 'disabled' };
    if (this.query === undefined) return { directories: 0, pubkeys: 0, warnings: [], skipped: 'no-query' };

    const warnings: string[] = [];
    const next = new Map<string, TrustEntry>();
    let loaded = 0;
    const nowS = Math.floor(this.now() / 1000);

    for (const dir of this.directories) {
      try {
        const filter: Filter = {
          kinds: [KINDS.NODE_DIRECTORY],
          authors: [dir.owner],
          '#d': [WRITERS_D_TAG],
          limit: 4,
        };
        const found = await this.query([filter], { timeoutMs: this.timeoutMs });
        const writers = pickLatest(found, dir.owner, isWritersEvent);
        if (writers === null) {
          warnings.push(
            `no valid 30028 d=${WRITERS_D_TAG} from ${dir.owner.slice(0, 8)}… in the local relays — ` +
              'is the strfry router streaming this instance down?',
          );
          continue;
        }
        loaded += 1;
        const origin = this.originFor(dir, writers);
        next.set(dir.owner, { pubkey: dir.owner, origin, role: 'owner' });

        const parsed = parseWritersEvent(writers);
        for (const warning of parsed.warnings) warnings.push(`${dir.owner.slice(0, 8)}…: ${warning}`);

        for (const operator of parsed.operators) {
          // expirovaná registrácia už nepíše — indexovať jej starý obsah
          // áno (je v adresári historicky), ale agentov z nej nedôverujeme
          const expired = operator.expiresAt > 0 && operator.expiresAt < nowS;
          next.set(operator.pubkey, { pubkey: operator.pubkey, origin, role: 'operator' });
          if (expired) continue;
          const agentFilter: Filter = {
            kinds: [KINDS.NODE_DIRECTORY],
            authors: [operator.pubkey],
            '#d': [AGENTS_D_TAG],
            limit: 4,
          };
          const agentEvents = await this.query([agentFilter], { timeoutMs: this.timeoutMs });
          const agentsEvent = pickLatest(agentEvents, operator.pubkey, isAgentsEvent);
          if (agentsEvent === null) continue;
          for (const agent of parseAgentsEvent(agentsEvent).agents) {
            next.set(agent, { pubkey: agent, origin, role: 'agent' });
          }
        }
      } catch (error) {
        warnings.push(`directory ${dir.owner.slice(0, 8)}…: ${String(error)}`);
      }
    }

    this.map = next;
    this.warnings = warnings;
    this.lastRefresh = this.now();
    const summary: TrustRefreshSummary = {
      directories: loaded,
      pubkeys: next.size,
      warnings,
    };
    for (const warning of warnings) this.log(`[indexer] trust: ${warning}`);
    if (warnings.length === 0) {
      this.log(
        `[indexer] trust: adresarov=${String(loaded)} pubkeyov=${String(next.size)} (povolia sa v indexe, nie vo write-gate)`,
      );
    }
    return summary;
  }

  /** obnova len ak uplynul `refreshMs` (volá sa z ingest kolečka) */
  async maybeRefresh(): Promise<TrustRefreshSummary | null> {
    if (!this.enabled || this.query === undefined) return null;
    if (this.now() - this.lastRefresh < this.refreshMs) return null;
    return this.refresh();
  }

  /** id pre adresár: explicitny config > gateway tag adresara > placeholder */
  private originFor(dir: TrustDirectory, writers: NostrEvent): string {
    // `parseTrustDirectories` id normalizuje, ALE `TrustDirectories` sa dá
    // postaviť aj priamo (testy, CLI) — invariant „`origin` je vždy
    // lowercase" MUSÍ držať bez ohľadu na cestu konstrukcie, inak by
    // `GET /search?origin=` nevrátil nič (filter sa porovnáva case-fold)
    if (dir.idExplicit) return dir.id.trim().toLowerCase();
    const tag = writers.tags.find((candidate) => candidate[0] === 'gateway');
    const host = hostFromGatewayTag(typeof tag?.[1] === 'string' ? tag[1] : undefined);
    return host !== '' ? host : `dir:${dir.owner.slice(0, 8)}`;
  }
}
