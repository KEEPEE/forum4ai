/**
 * Indexer ingestor (F4AI-13, S7) — holds the subscription to the dev relays,
 * backfills into SQLite and runs the anti-entropy wheels.
 *
 * We take the pool from `@forum4ai/gateway` (`RelayPool`) — reconnect with
 * backoff, subscription fan-out and deduplication across relays are already
 * tested; duplicates between relays are solved by the DB anyway (dedup per
 * id / LWW per addr). The `IngestPool` interface is structural, so unit
 * tests can inject a fake pool without the network.
 *
 * Startup order (task brief: "backfill and live must meet without duplicates
 * and without losses"):
 *   1. LIVE subscribe with `since = now - INDEXER_LIVE_OVERLAP_S` — it starts
 *      BEFORE the backfill so an event published during the backfill cannot
 *      slip through (the relay no longer delivers it in a REQ into the past),
 *   2. BACKFILL — REQ in time windows from `created_at = 0`, paginated by
 *      sides with a `limit` batch,
 *   3. ANTI-ENTROPY — periodic wheel (ids sweep + since sweep).
 * The live/backfill meeting is inevitable (the live window overlaps into the
 * backfill) and is handled by dedup per id in the DB — no loss, no duplicate.
 *
 * The backfill does not use "since cursor asc" paging: relays do not return a
 * consistent order (our relay `created_at` ASC, strfry DESC — verified in the
 * code of `packages/relay/src/store.ts` and on 127.0.0.1), so we walk
 * WINDOWS `[since, until]` and recursively halve a saturated window (one that
 * returns >= batch). That makes progress independent of the order the relay
 * returns, and it is provably complete down to the boundary of `limit`
 * events in one second.
 */
import { ORIGIN_SELF, validateEvent, verifyFull } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

import type { IndexerConfig } from './config.js';
import { IndexerDb, type UpsertOutcome } from './db.js';
import { S3FifoCache } from './cache.js';
import { WriterAllowlist } from './operators.js';
import { FedSource, type FedSweepSummary } from './fed.js';
import { TrustDirectories } from './trust.js';

/** Minimálne rozhranie poolu, ktoré ingestor potrebuje (`RelayPool` ho spĺňa). */
export interface IngestPool {
  readonly urls: string[];
  connectAll(): Promise<unknown>;
  /** voliteľné — volá to majiteľ poolu (CLI) pri shutdown, nie ingestor */
  close?(): void;
  query(filters: Filter[], opts?: { timeoutMs?: number }): Promise<Event[]>;
  subscribe(
    filters: Filter[],
    callback: (event: Event, relayUrl: string) => void,
    opts?: { onEose?: () => void },
  ): () => void;
}

/** Kánonická 7-pole kópia — zbaví event nostr-tools Symbolov a extra polí. */
export function asCanonical(event: Event): NostrEvent {
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

export interface IngestCounters {
  received: number;
  inserted: number;
  replaced: number;
  ignored: number;
  invalidSignature: number;
  invalidEvent: number;
  outsideRegistry: number;
  /** P1 (B9): eventy od pubkey mimo allowlist — vôbec sme ich neoverovali */
  notAllowed: number;
  liveEvents: number;
  /**
   * Phase 6a: koľko cudzích eventov sa dostalo do indexu cez sweep
   * `fed.db` (inserted + replaced). Prázdny `INDEXER_FED_DB` = 0 navždy.
   */
  remoteIndexed: number;
  backfillWindows: number;
  backfillFetched: number;
  backfillSaturated: number;
  aeCycles: number;
  aeIdsChecked: number;
  aeIdsPresent: number;
  aeIdsAbsent: number;
  aeDisappeared: number;
  aeReappeared: number;
  aeLateFetched: number;
  aeLateAdded: number;
}

export interface BackfillSummary {
  windows: number;
  fetched: number;
  ingested: number;
  saturated: number;
  truncated: boolean;
}

export interface AntiEntropySummary {
  checked: number;
  present: number;
  absent: number;
  disappeared: number;
  reappeared: number;
  lateFetched: number;
  lateAdded: number;
}

export interface IndexerIngestorOptions {
  db: IndexerDb;
  pool: IngestPool;
  config: IndexerConfig;
  logger?: (line: string) => void;
  /** injectable hodiny (testy) */
  now?: () => number;
  /**
   * P1 (dizajn B9): allowlist pisúcich. Bez parametra sa postaví z
   * `config.writeAllow` + `config.operatorsDb` (prázdne oboje = filter
   * vypnutý, indexujeme všetko).
   */
  allowlist?: WriterAllowlist;
  /**
   * Phase 6a (dizajn Q5): dôveryhodné adresáre cudzích inštancií. Bez
   * parametra sa postavia z `config.trustDirectories` a čítajú cez ten istý
   * pool ako ingest (Q5: „reads A's owner-signed 30028 … from its local
   * relays"). Prázdny zoznam = `enabled === false` = správanie pred 6a.
   */
  trust?: TrustDirectories;
  /**
   * Phase 6a: sweep `remote_events` z gateway `fed.db`. Bez parametra sa
   * postaví z `config.fedDb`; `null` = vypnuté (default, lebo `INDEXER_FED_DB`
   * je nepovinný).
   */
  fed?: FedSource | null;
}

/**
 * Validácia pre ingest. Vždy `shared validateEvent`; pri default
 * (`requireRegistry: false`) tolerujeme IBA chybu "kind nie je v registry",
 * a len ak si kind vyžiadal operátor v `INDEXER_KINDS` — inak by defaultné
 * kindy 0 a 3 (ktoré náš relay pri zápise pripúšťa) padali na L2 politike.
 *
 * F4AI-2b2: rozhodujeme podľa stabilného kódu `KIND_NOT_REGISTERED`, nie
 * podľa človečiteľnej vety. Predtým sme sub-stringovali vetu validátora
 * (`'is not in the forum4ai kind registry'`) — preklep v texte by bol tichá
 * zmena správania indexera (každý kind mimo registry by zrazu padal). Kód
 * je kontrakt z `@forum4ai/shared`; veta sa voľne prepisuje.
 */
export function validateForIngest(
  event: NostrEvent,
  configuredKinds: ReadonlySet<number>,
  requireRegistry: boolean,
): { valid: boolean; outsideRegistry: boolean; reason: string | null } {
  const result = validateEvent(event);
  if (result.valid) return { valid: true, outsideRegistry: false, reason: null };
  if (!requireRegistry && configuredKinds.has(event.kind)) {
    const registryOnly =
      result.errors.length > 0 &&
      result.codes.length === result.errors.length &&
      result.codes.every((code) => code === 'KIND_NOT_REGISTERED');
    if (registryOnly) return { valid: true, outsideRegistry: true, reason: null };
  }
  return { valid: false, outsideRegistry: false, reason: result.errors.join('; ') };
}

export class IndexerIngestor {
  readonly db: IndexerDb;
  readonly pool: IngestPool;
  readonly config: IndexerConfig;

  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly kinds: Set<number>;
  private readonly kindList: number[];
  /** anti-entropia: posledný verdikt o id (prítomné/absentné na relayi) */
  private readonly idCache: S3FifoCache<string, 'present' | 'absent'>;
  /** logovanie neplatných eventov: prvý výskyt per dôvod + každých 1000 */
  private readonly invalidLogged = new Map<string, number>();
  /** P1 (dizajn B9): filter pubkey, ktoré vôbec smú skončiť v indexe */
  readonly allowlist: WriterAllowlist;
  /** Phase 6a (dizajn Q5): cudzie adresáre → index allowlist + `origin` */
  readonly trust: TrustDirectories;
  /** Phase 6a: sweep remote eventov z gateway `fed.db` (null = vypnuté) */
  readonly fed: FedSource | null;

  private readonly counters: IngestCounters = {
    received: 0,
    inserted: 0,
    replaced: 0,
    ignored: 0,
    invalidSignature: 0,
    invalidEvent: 0,
    outsideRegistry: 0,
    notAllowed: 0,
    liveEvents: 0,
    remoteIndexed: 0,
    backfillWindows: 0,
    backfillFetched: 0,
    backfillSaturated: 0,
    aeCycles: 0,
    aeIdsChecked: 0,
    aeIdsPresent: 0,
    aeIdsAbsent: 0,
    aeDisappeared: 0,
    aeReappeared: 0,
    aeLateFetched: 0,
    aeLateAdded: 0,
  };

  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Phase 6a: timer sweepu `fed.db` (samostatný, lebo jeho zlyhanie nesmie zastaviť anti-entropiu) */
  private fedTimer: ReturnType<typeof setInterval> | null = null;
  private aeRunning = false;
  private stopped = false;

  constructor(options: IndexerIngestorOptions) {
    this.db = options.db;
    this.pool = options.pool;
    this.config = options.config;
    this.now = options.now ?? (() => Date.now());
    this.log =
      options.logger ?? (options.config.quiet ? () => undefined : (line: string) => console.log(line));
    this.kindList = [...options.config.kinds];
    // Phase 6a (dizajn Q5): adresáre cudzích inštancií. Čítajú cez TEN ISTÝ
    // pool ako ingest — Q5 výslovne hovorí „from its local relays", lebo
    // strfry router už cudzí 30028 stiahol do našej strfry.
    this.trust =
      options.trust ??
      new TrustDirectories({
        directories: options.config.trustDirectories ?? [],
        query: (filters, queryOptions) => this.pool.query(filters, queryOptions),
        timeoutMs: options.config.queryTimeoutMs,
        refreshMs: options.config.trustRefreshMs,
        now: options.now,
        logger: this.log,
      });
    this.allowlist =
      options.allowlist ??
      new WriterAllowlist({
        allow: options.config.writeAllow ?? [],
        operatorsDbPath: options.config.operatorsDb ?? null,
        trust: this.trust,
        logger: this.log,
      });
    // Phase 6a: sweep `remote_events` → index (cudzí content, `trusted = 0`)
    this.fed =
      options.fed !== undefined
        ? options.fed
        : options.config.fedDb !== null
          ? new FedSource({
              path: options.config.fedDb,
              db: options.db,
              batch: options.config.fedBatch,
              kinds: options.config.kinds,
              logger: this.log,
            })
          : null;
    this.kinds = new Set(this.kindList);
    // S3-FIFO potrebuje, aby guest fronta pojala CELÝ sweep id (inak by sa
    // id z prvej časti sweepu stihlo vymazať skôr, ako ho ďalšie kolečko
    // prečíta — a drahé verdikty by sme nikdy nepoznali). Preto kapacitu
    // zdvíhame na 10x M (guest = 10 % = M) a nechávame ju len zväčšovať.
    const cacheCapacity = Math.max(
      options.config.cacheCapacity,
      options.config.antiEntropyIds * 10 + 16,
    );
    this.idCache = new S3FifoCache<string, 'present' | 'absent'>({ capacity: cacheCapacity });
  }

  /** snímka počítadiel (kópia, aby sa nedala meniť zvonku) */
  snapshot(): IngestCounters {
    return { ...this.counters };
  }

  stats() {
    return this.db.stats();
  }

  cacheStats() {
    return this.idCache.stats();
  }

  // ── ingest jedného eventu ──────────────────────────────────────────────

  /**
   * Overí a zapíše event. Neplatné hodia a lognú (per dôvod len prvý
   * výskyt + každých 1000, aby nás dávka rovnakého dôvodu nezaplavila).
   */
  ingestEvent(
    event: Event,
    source = 'live',
  ): UpsertOutcome | 'invalid-signature' | 'invalid-event' | 'not-allowed' {
    this.counters.received += 1;
    const canonical = asCanonical(event);

    // P1 (dizajn B9): strfry vie event dostať aj PEER synchronizáciou, nie
    // len našim gatewayom — bez tohto filtra by cudzí obsah bolil v
    // /search, /reputation a /ideas aj po zavedení write-gate. Testuje sa
    // PRED podpisom, lebo lookup v `Set` je lacnejší ako Schnorr a cudzích
    // eventov môžu byť tisíce.
    if (!this.allowlist.isAllowed(canonical.pubkey)) {
      this.counters.notAllowed += 1;
      this.logInvalid(
        `not-allowed kind=${canonical.kind} pubkey=${canonical.pubkey.slice(0, 8)}… id=${canonical.id.slice(0, 8)}`,
        source,
      );
      return 'not-allowed';
    }

    if (!verifyFull(canonical)) {
      this.counters.invalidSignature += 1;
      this.logInvalid(`signature kind=${canonical.kind} id=${canonical.id.slice(0, 8)}`, source);
      return 'invalid-signature';
    }
    const validation = validateForIngest(canonical, this.kinds, this.config.requireRegistry);
    if (!validation.valid) {
      this.counters.invalidEvent += 1;
      this.logInvalid(`invalid kind=${canonical.kind} id=${canonical.id.slice(0, 8)}: ${validation.reason ?? ''}`, source);
      return 'invalid-event';
    }
    if (validation.outsideRegistry) this.counters.outsideRegistry += 1;

    // Phase 6a (dizajn Q5): pôvod. Cudzí pubkey z dôveryhodného adresára
    // dostane id tej inštancie a `trusted = 0`; vlastný obsah ostáva
    // 'self'/1. Prázdny `INDEXER_TRUST_DIRECTORIES` = mapa je prázdna =
    // presne staré správanie (všetko 'self', všetko trusted).
    const remote = this.trust.enabled ? this.trust.lookup(canonical.pubkey) : null;
    const outcome = this.db.upsertEvent(canonical, {
      origin: remote?.origin ?? ORIGIN_SELF,
      trusted: remote === null,
    });
    this.counters[outcome] += 1;
    if (source === 'live') this.counters.liveEvents += 1;
    if (remote !== null && (outcome === 'inserted' || outcome === 'replaced')) this.counters.remoteIndexed += 1;
    return outcome;
  }

  /**
   * Phase 6a: jeden sweep gateway `fed.db` → index. Vystupuje aj z timeru
   * v `start()`; testy a CLI ho vôle volajú priamo. Bez `INDEXER_FED_DB`
   * vráti súhrn s `error: 'fed.db unavailable'` (alebo nulový sweep).
   */
  sweepFed(): FedSweepSummary {
    if (this.fed === null) {
      return {
        scanned: 0,
        inserted: 0,
        replaced: 0,
        ignored: 0,
        skipped: 0,
        invalid: 0,
        cursor: 0,
        error: 'INDEXER_FED_DB not set',
      };
    }
    const summary = this.fed.sweep();
    this.counters.remoteIndexed += summary.inserted + summary.replaced;
    return summary;
  }

  /** Phase 6a: diagnostika dôvery (adresáre, pubkeyy, varovania) */
  trustStatus(): { enabled: boolean; directories: number; pubkeys: number; warnings: string[] } {
    return {
      enabled: this.trust.enabled,
      directories: this.trust.directories.length,
      pubkeys: this.trust.snapshot().length,
      warnings: this.trust.currentWarnings(),
    };
  }

  private logInvalid(reason: string, source: string): void {
    const seen = (this.invalidLogged.get(reason) ?? 0) + 1;
    this.invalidLogged.set(reason, seen);
    if (this.config.verboseInvalid || seen === 1 || seen % 1000 === 0) {
      this.log(`[indexer] zahodeny event (${source}, ${reason}) celkom=${String(seen)}`);
    }
  }

  // ── backfill ───────────────────────────────────────────────────────────

  /**
   * Backfill od `created_at = 0` po stranách: chodíme po oknách
   * `[cursor, cursor + width - 1]` s `limit = backfillBatch`. Okno, ktoré
   * vráti >= batch (saturované), delíme na polovice a opakujeme — preto poradie, ktoré
   * relay vráti, nerozhoduje. Ukončíme na konci času, pri stropu okien,
   * alebo keď ani po zúžení na 1 s nevieme pokročiť.
   */
  async backfill(opts?: { fromS?: number }): Promise<BackfillSummary> {
    const nowS = Math.floor(this.now() / 1000);
    const slack = 60; // hodiny autorov môžu predbiehať
    const horizon = nowS + slack;
    // 0 (default) = začať CELÚ časovou osou ako jedným oknom: nenasýtené
    // okno je hotové v jednom REQ, saturované sa delí — prázdna história sa
    // teda prejde okamžite a plná adaptívne, bez 20 000 REQ po dňoch.
    const width = this.config.backfillWindowS > 0
      ? this.config.backfillWindowS
      : horizon + 1;
    const batch = this.config.backfillBatch;
    const maxWindows = this.config.backfillMaxWindows;

    let cursor = Math.max(0, opts?.fromS ?? 0);
    let currentWidth = width;
    let windows = 0;
    let fetched = 0;
    let ingested = 0;
    let saturated = 0;
    let truncated = false;
    const seen = new Set<string>();

    while (cursor <= horizon && windows < maxWindows && !this.stopped) {
      const until = Math.min(cursor + currentWidth - 1, horizon);
      const filter: Filter = { kinds: this.kindList, since: cursor, until, limit: batch };
      const events = await this.pool.query([filter], { timeoutMs: this.config.queryTimeoutMs });
      windows += 1;
      this.counters.backfillWindows = windows;
      fetched += events.length;
      this.counters.backfillFetched = this.counters.backfillFetched + events.length;

      // ingest v poradí created_at asc (zmysluplné inserted_at, lepšie logy)
      for (const event of [...events].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        if (seen.size > 200_000) seen.clear(); // strop pamäte, DB aj tak dedupuje
        const outcome = this.ingestEvent(event, 'backfill');
        if (outcome === 'inserted' || outcome === 'replaced') ingested += 1;
      }

      if (events.length >= batch && until - cursor + 1 > 1) {
        // saturované okno: zúžime na polovicu a skúsime ten istý úsek znova
        saturated += 1;
        this.counters.backfillSaturated = this.counters.backfillSaturated + 1;
        currentWidth = Math.max(1, Math.floor((until - cursor + 1) / 2));
        continue;
      }
      if (events.length >= batch) {
        this.log(
          `[indexer] backfill: okno ${String(cursor)}..${String(until)} saturované aj pri 1s (${String(events.length)} eventov) — posúvame`,
        );
      }
      cursor = until + 1;
      currentWidth = width;
    }
    if (cursor <= horizon) truncated = true;

    const summary: BackfillSummary = { windows, fetched, ingested, saturated, truncated };
    this.log(
      `[indexer] backfill hotovy: okien=${String(windows)} stiahnute=${String(fetched)} novych_update=${String(ingested)} saturacia=${String(saturated)}${truncated ? ' (skratene limitom okien)' : ''}`,
    );
    return summary;
  }

  // ── anti-entropia ──────────────────────────────────────────────────────

  /**
   * Jedno kolečko anti-entropie:
   *  1. **ids sweep** — vezme posledných M id z lokálnej tabuľky a pośle
   *     `REQ {ids:[…]}`; všetko, čo relaye vrátia, znova nahrajú do DB
   *     (chýbajúce doplnia, prítomné je no-op), a verdikt si pamätáme v
   *     S3-FIFO cache — v ďalšom kolečku tak rozlíšime `zmizol` / `obnovený`
   *     od "na relayi nikdy nebol".
   *  2. **since sweep** — `REQ {kinds, since: last_seen - lookback}` doplní
   *     meškajúce eventy (relay nám ich posunul neskoro, alebo sme boli
   *     odpojení).
   */
  async runAntiEntropyCycle(): Promise<AntiEntropySummary> {
    const summary: AntiEntropySummary = {
      checked: 0,
      present: 0,
      absent: 0,
      disappeared: 0,
      reappeared: 0,
      lateFetched: 0,
      lateAdded: 0,
    };
    this.counters.aeCycles += 1;

    const ids = this.db.recentIds(this.config.antiEntropyIds);
    if (ids.length > 0) {
      const found = await this.pool.query([{ ids }], { timeoutMs: this.config.queryTimeoutMs });
      const foundIds = new Set<string>(found.map((event) => event.id));
      for (const event of found) {
        const outcome = this.ingestEvent(event, 'anti-entropia/ids');
        if (outcome === 'inserted' || outcome === 'replaced') summary.lateAdded += 1;
      }
      for (const id of ids) {
        summary.checked += 1;
        const previous = this.idCache.get(id);
        const verdict: 'present' | 'absent' = foundIds.has(id) ? 'present' : 'absent';
        if (verdict === 'present') {
          summary.present += 1;
          if (previous === 'absent') summary.reappeared += 1;
        } else {
          summary.absent += 1;
          if (previous === 'present') summary.disappeared += 1;
        }
        this.idCache.set(id, verdict);
      }
      this.counters.aeIdsChecked += summary.checked;
      this.counters.aeIdsPresent += summary.present;
      this.counters.aeIdsAbsent += summary.absent;
      this.counters.aeDisappeared += summary.disappeared;
      this.counters.aeReappeared += summary.reappeared;
    }

    // B1: ukotvíme sweep na najnovšom SKUTOČNOM čase — ridky s
    // created_at ďaleko v budúcnosti (junk z relaya) by inak posunuli
    // `since` nad všetok obsah a oneskorené eventy by sa už nikdy
    // nenačítali. Slack 60 s = rovnaká tolerancia ako pri backfilli.
    const nowS = Math.floor(this.now() / 1000);
    const lastSeen = this.db.maxCreatedAt(nowS + 60);
    if (lastSeen > 0) {
      const since = Math.max(0, lastSeen - this.config.antiEntropyLookbackS);
      const late = await this.pool.query([{ kinds: this.kindList, since }], {
        timeoutMs: this.config.queryTimeoutMs,
      });
      summary.lateFetched = late.length;
      this.counters.aeLateFetched += late.length;
      for (const event of [...late].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))) {
        const outcome = this.ingestEvent(event, 'anti-entropia/since');
        if (outcome === 'inserted' || outcome === 'replaced') summary.lateAdded += 1;
      }
      this.counters.aeLateAdded += summary.lateAdded;
    }

    this.log(
      `[indexer] anti-entropia #${String(this.counters.aeCycles)}: overenych=${String(summary.checked)} pritomnych=${String(summary.present)} chybajucich=${String(summary.absent)} zmizol=${String(summary.disappeared)} obnovene=${String(summary.reappeared)} oneskorene_stiahnute=${String(summary.lateFetched)} doplnene=${String(summary.lateAdded)} cache=${JSON.stringify(this.idCache.stats())}`,
    );
    return summary;
  }

  // ── životný cyklus ─────────────────────────────────────────────────────

  /**
   * Štart: live subscribe → backfill → anti-entropické kolečko. Vráti
   * summary backfillu; ingestor potom beží ďalej, kým sa volá `stop()`.
   */
  async start(): Promise<{ backfill: BackfillSummary }> {
    await this.pool.connectAll();
    this.log(
      `[indexer] start: db=${this.db.path} relaye=${this.pool.urls.join(', ')} kindy=${String(this.kindList.length)}`,
    );
    this.log(
      this.allowlist.enabled
        ? `[indexer] write-allowlist: zapnuty (bootstrap ${String(this.allowlist.bootstrapCount)} pubkey, operators.db: ${this.config.operatorsDb ?? 'nenastavený'}) — eventy mimo zoznam sa NEindexujú`
        : '[indexer] write-allowlist: vypnuty (INDEXER_WRITE_ALLOW + INDEXER_OPERATORS_DB prázdne) — indexujem všetko',
    );

    // Phase 6a (dizajn Q5): adresáre MUSÍme stiahnuť PRED live subscribe a
    // backfillom. Inak by prvý sweep zahodil A-ke eventy (pubkey ešte nie je
    // v allowliste) a LWW by ich už nikdy nedostal späť — presne ten tichý
    // bug, ktorý Q5 rieši. Zlyhanie adresárov ingest nenahodí: mapu necháme
    // prázdnu a logujeme (index then obsahuje len vlastný obsah).
    if (this.trust.enabled) {
      try {
        const trust = await this.trust.refresh();
        this.log(
          `[indexer] trust directories: ${String(trust.directories)}/${String(this.trust.directories.length)} adresárov, ` +
            `${String(trust.pubkeys)} pubkey navyše v index allowliste (write-gate sa tymto NEMENI)`,
        );
      } catch (error) {
        this.log(`[indexer] trust refresh zlyhal: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 1) live FIRST — pred backfillom, aby nič nemohlo uniknúť
    const nowS = Math.floor(this.now() / 1000);
    const liveSince = Math.max(0, nowS - this.config.liveOverlapS);
    this.unsubscribe = this.pool.subscribe(
      [{ kinds: this.kindList, since: liveSince }],
      (event) => this.ingestEvent(event, 'live'),
      {
        onEose: () => this.log(`[indexer] live subscribe EOSE (since=${String(liveSince)})`),
      },
    );

    // 2) backfill
    const backfill = await this.backfill();

    // 2b) Phase 6a: prvý sweep `fed.db` a potom timer. Rádovo po backfilli,
    // aby cudzí obsah neduplikoval prácu (dedup per id by to síce vyriešil,
    // ale takto je log čitateľný).
    if (this.fed !== null) {
      this.sweepFed();
      if (this.config.fedIntervalMs > 0 && !this.stopped) {
        this.fedTimer = setInterval(() => {
          if (this.stopped) return;
          try {
            this.sweepFed();
          } catch (error) {
            this.log(`[indexer] fed sweep zlyhal: ${error instanceof Error ? error.message : String(error)}`);
          }
          // adresáre obnovíme v tom istom kolečku — je to lacné (dva REQ)
          // a timerov v indexeri chceme minimum
          void this.trust.maybeRefresh().catch((error: unknown) => {
            this.log(`[indexer] trust refresh zlyhal: ${error instanceof Error ? String(error) : 'unknown'}`);
          });
        }, this.config.fedIntervalMs);
        this.fedTimer.unref();
        this.log(
          `[indexer] fed sweep: ${this.config.fedDb} every ${String(Math.round(this.config.fedIntervalMs / 1000))}s (batch=${String(this.config.fedBatch)})`,
        );
      }
    }

    // 3) anti-entropia
    if (this.config.antiEntropyIntervalMs > 0 && !this.stopped) {
      this.timer = setInterval(() => {
        if (this.aeRunning || this.stopped) return;
        this.aeRunning = true;
        void this.runAntiEntropyCycle()
          .catch((err: unknown) => {
            this.log(`[indexer] anti-entropia zlyhala: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            this.aeRunning = false;
          });
      }, this.config.antiEntropyIntervalMs);
      this.log(
        `[indexer] anti-entropia every ${String(Math.round(this.config.antiEntropyIntervalMs / 1000))}s (ids=${String(this.config.antiEntropyIds)}, lookback=${String(this.config.antiEntropyLookbackS)}s)`,
      );
    }

    return { backfill };
  }

  /** Zastaví subscribe aj timer (DB nezaviera — to robí volajúci/CLI). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe();
      } catch {
        /* pool už mohol byť zavretý */
      }
      this.unsubscribe = null;
    }
    // P1: read-only spojenie na gateway operators.db (WAL — aj čitateľ
    // musí ísť dole korektne)
    this.allowlist.close();
    // Phase 6a: read-only spojenie na gateway fed.db — rovnaký dôvod
    if (this.fedTimer !== null) {
      clearInterval(this.fedTimer);
      this.fedTimer = null;
    }
    this.fed?.close();
    this.log(
      `[indexer] stop: ${JSON.stringify(this.snapshot())} db_stats=${JSON.stringify(this.db.stats())}`,
    );
  }
}
