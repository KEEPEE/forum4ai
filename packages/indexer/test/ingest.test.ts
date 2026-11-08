/**
 * Unit testy ingestora (F4AI-13, S7) — bez siete, s fake `IngestPool`.
 *
 * Fake pool simuluje DVA relays s RODELIM poradim (`asc` = náš relay triedi
 * `created_at` asc, `desc` = strfry triedi desc). To je presne tá asymetria,
 * pre ktorú backfill nepoužíva `since` kurzor, ale časové okná s halvením
 * pri saturácii — testy dokladujú, že výsledok je na poradí nezávislý.
 */
import { randomBytes } from 'node:crypto';

import { finalizeEvent } from 'nostr-tools';
import type { Event, Filter } from 'nostr-tools/types';
import { describe, expect, it } from 'vitest';

import type { IndexerConfig } from '../src/config.js';
import { resolveIndexerConfig } from '../src/config.js';
import { IndexerDb } from '../src/db.js';
import { IndexerIngestor, type IngestPool } from '../src/ingest.js';

/* ------------------------------------------------------------------ */
/* fake pool                                                           */
/* ------------------------------------------------------------------ */

interface FakeRelay {
  url: string;
  events: Event[];
  order: 'asc' | 'desc';
}

class FakePool implements IngestPool {
  readonly relays: FakeRelay[];
  readonly urls: string[];
  readonly queries: Filter[][] = [];
  private readonly subs: Array<{
    filters: Filter[];
    callback: (event: Event, relayUrl: string) => void;
    onEose?: () => void;
  }> = [];

  constructor(relays: FakeRelay[]) {
    this.relays = relays;
    this.urls = relays.map((relay) => relay.url);
  }

  connectAll(): Promise<unknown> {
    return Promise.resolve([]);
  }

  close(): void {
    this.subs.length = 0;
  }

  private static matches(filter: Filter, event: Event): boolean {
    if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false;
    if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
    if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) return false;
    if (filter.since !== undefined && event.created_at < filter.since) return false;
    if (filter.until !== undefined && event.created_at > filter.until) return false;
    return true;
  }

  async query(filters: Filter[]): Promise<Event[]> {
    this.queries.push(filters);
    const out: Event[] = [];
    const seen = new Set<string>();
    for (const relay of this.relays) {
      const matched: Event[] = [];
      for (const filter of filters) {
        for (const event of relay.events) {
          if (FakePool.matches(filter, event)) matched.push(event);
        }
      }
      const unique: Event[] = [];
      const ids = new Set<string>();
      for (const event of matched) {
        if (ids.has(event.id)) continue;
        ids.add(event.id);
        unique.push(event);
      }
      unique.sort((a, b) =>
        relay.order === 'asc'
          ? a.created_at - b.created_at || (a.id < b.id ? -1 : 1)
          : b.created_at - a.created_at || (a.id < b.id ? -1 : 1),
      );
      const filterLimit = filters[0]?.limit;
      const page = typeof filterLimit === 'number' ? unique.slice(0, filterLimit) : unique;
      for (const event of page) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        out.push(event);
      }
    }
    return out;
  }

  subscribe(
    filters: Filter[],
    callback: (event: Event, relayUrl: string) => void,
    opts?: { onEose?: () => void },
  ): () => void {
    const sub = { filters, callback, onEose: opts?.onEose };
    this.subs.push(sub);
    opts?.onEose?.();
    return () => {
      const index = this.subs.indexOf(sub);
      if (index >= 0) this.subs.splice(index, 1);
    };
  }

  /** Pridá event na relays a doručí ho živým subscriberom (ako real relay). */
  publish(event: Event, relayUrls: string[] = this.urls): void {
    for (const relay of this.relays) {
      if (!relayUrls.includes(relay.url)) continue;
      if (!relay.events.some((existing) => existing.id === event.id)) relay.events.push(event);
    }
    for (const sub of [...this.subs]) {
      for (const relay of this.relays) {
        if (!relayUrls.includes(relay.url)) continue;
        if (sub.filters.some((filter) => FakePool.matches(filter, event))) {
          sub.callback(event, relay.url);
        }
      }
    }
  }

  /** Simuluje výmaz na relay (strfry purge / republish), anti-entropia to musí odhaliť. */
  remove(id: string): void {
    for (const relay of this.relays) {
      relay.events = relay.events.filter((event) => event.id !== id);
    }
  }

  get subscriptionCount(): number {
    return this.subs.length;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const NOW = Math.floor(Date.now() / 1000);
const SECRETS = new Map<string, Uint8Array>();

function secret(label: string): Uint8Array {
  let key = SECRETS.get(label);
  if (key === undefined) {
    key = randomBytes(32);
    SECRETS.set(label, key);
  }
  return key;
}

function sign(
  label: string,
  kind: number,
  created_at: number,
  content: string,
  tags: string[][] = [],
): Event {
  return finalizeEvent(
    { kind, created_at, tags, content },
    secret(label),
  ) as unknown as Event;
}

function testConfig(overrides: Record<string, string> = {}): IndexerConfig {
  return resolveIndexerConfig({
    INDEXER_DB: ':memory:',
    INDEXER_RELAY_URLS: 'ws://fake-a ws://fake-b',
    INDEXER_BACKFILL_BATCH: '5',
    INDEXER_ANTI_ENTROPY_INTERVAL_S: '0', // timer vypnuto, cyklovane manualne
    INDEXER_ANTI_ENTROPY_IDS: '10',
    INDEXER_ANTI_ENTROPY_LOOKBACK_S: '3600',
    INDEXER_LIVE_OVERLAP_S: '7200',
    INDEXER_QUERY_TIMEOUT_MS: '500',
    INDEXER_QUIET: '1',
    ...overrides,
  });
}

function makePair(): FakePool {
  return new FakePool([
    { url: 'ws://fake-a', events: [], order: 'asc' },
    { url: 'ws://fake-b', events: [], order: 'desc' },
  ]);
}

/* ------------------------------------------------------------------ */
/* backfill                                                            */
/* ------------------------------------------------------------------ */

describe('indexer ingest — backfill', () => {
  it('stiahne history z relays s rôznym poradím bez duplicít a s halvením okien', async () => {
    const pool = makePair();
    const history: Event[] = [];
    for (let i = 0; i < 12; i += 1) {
      history.push(sign(`author-${String(i % 3)}`, 1021, NOW - 3600 + i * 60, `historicky text ${String(i)}`));
    }
    // relay A má všetkých 12, relay B len polovicu (kríženie = dedup per id)
    pool.publish(history[0]!, ['ws://fake-a']);
    for (const event of history.slice(1)) pool.publish(event);

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();

    const counters = ingestor.snapshot();
    expect(db.count()).toBe(12);
    expect(counters.backfillWindows).toBeGreaterThan(1); // batch 5 → saturované delenie
    expect(counters.backfillSaturated).toBeGreaterThan(0);
    expect(counters.backfillFetched).toBeGreaterThanOrEqual(12);
    // žiadny id nesmie byť dvakrát
    const ids = db.recentIds(100);
    expect(new Set(ids).size).toBe(12);
    ingestor.stop();
    db.close();
  });

  it('dvojité zavolanie backfillu nepridá žiadny riadok (idempotentné)', async () => {
    const pool = makePair();
    const events = [1, 2, 3].map((i) => sign('author-x', 1020, NOW - 600 + i, `text ${String(i)}`));
    for (const event of events) pool.publish(event);

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    const first = db.count();
    await ingestor.backfill();
    const second = db.count();
    expect(first).toBe(3);
    expect(second).toBe(3);
    expect(ingestor.snapshot().backfillWindows).toBeGreaterThanOrEqual(0);
    ingestor.stop();
    db.close();
  });

  it('backfill rešpektuje kinds — cudzie kindy sa do DB nedostanú', async () => {
    const pool = makePair();
    const ours = sign('author-k', 1021, NOW - 100, 'nas prispevok');
    const foreign = sign('author-k', 1, NOW - 90, 'cudzii event (kind 1)');
    pool.publish(ours);
    pool.publish(foreign);

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    expect(db.count()).toBe(1);
    expect(db.getEvent(ours.id)).not.toBeNull();
    expect(db.getEvent(foreign.id)).toBeNull();
    ingestor.stop();
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* live + dedup                                                        */
/* ------------------------------------------------------------------ */

describe('indexer ingest — live a dedup', () => {
  it('live event sa ingestne ihneď a anti-entropia ho neduplikuje', async () => {
    const pool = makePair();
    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();

    const live = sign('author-live', 1020, NOW, 'zivy prispevok');
    pool.publish(live);
    expect(db.count()).toBe(1);
    expect(db.getEvent(live.id)?.content).toBe('zivy prispevok');

    // ten istý event príde druhýkrát (druhý relay, oneskorenie) → ignored
    pool.publish(live);
    expect(db.count()).toBe(1);
    expect(ingestor.snapshot().ignored).toBeGreaterThanOrEqual(1);

    await ingestor.runAntiEntropyCycle();
    expect(db.count()).toBe(1);
    expect(ingestor.snapshot().liveEvents).toBeGreaterThanOrEqual(1);
    ingestor.stop();
    db.close();
  });

  it('backfill a live sa stretnú bez straty aj bez duplicity', async () => {
    const pool = makePair();
    const before = sign('author-m', 1021, NOW - 300, 'pred startom');
    pool.publish(before);

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    // live subscribe je pred backfillom → event published uprostred backfillu
    // musi skoncit prave raz v DB
    const during = sign('author-m', 1021, NOW - 120, 'behom backfillu');
    let halfDone = false;
    const originalQuery = pool.query.bind(pool);
    pool.query = async (filters, opts) => {
      const result = await originalQuery(filters, opts);
      if (!halfDone) {
        halfDone = true;
        pool.publish(during);
      }
      return result;
    };

    await ingestor.start();
    expect(db.count()).toBe(2);
    expect(db.getEvent(before.id)).not.toBeNull();
    expect(db.getEvent(during.id)).not.toBeNull();
    const ids = db.recentIds(50);
    expect(new Set(ids).size).toBe(2);
    ingestor.stop();
    db.close();
  });

  it('LWW cez relays: novšia verzia na relay B vyhráva nad staršou na relay A', async () => {
    const pool = makePair();
    const v1 = sign('author-lww', 10030, NOW - 200, 'stara verzia');
    const v2 = sign('author-lww', 10030, NOW - 100, 'nova verzia');
    pool.publish(v1, ['ws://fake-a']);
    pool.publish(v2, ['ws://fake-b']);

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    expect(db.count()).toBe(1);
    expect(db.idsOfKind(10030)).toEqual([v2.id]);
    expect(db.getEvent(v2.id)?.content).toBe('nova verzia');

    // staršia verzia priletí neskoro (meškaný relay A) → nesmie prepísať
    pool.publish(v1);
    expect(db.getEvent(v2.id)?.content).toBe('nova verzia');
    expect(db.count()).toBe(1);
    ingestor.stop();
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* validácia                                                           */
/* ------------------------------------------------------------------ */

describe('indexer ingest — validácia pred zápisom', () => {
  it('poškodená signatúra sa zahodí a započíta', async () => {
    const pool = makePair();
    const good = sign('author-v', 1020, NOW - 50, 'fer event');
    const bad = { ...sign('author-v', 1020, NOW - 40, 'pokazeny event'), sig: 'f'.repeat(64) };
    pool.publish(good);

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    // jeden relay => jedno live dorucenie (dva relays by dorucili 2x, to
    // dedup rieši až na úrovni DB; tu testujeme samotné zamietnutie)
    pool.publish(bad as Event, ['ws://fake-a']);
    expect(db.count()).toBe(1);
    expect(db.getEvent(bad.id)).toBeNull();
    expect(ingestor.snapshot().invalidSignature).toBe(1);
    ingestor.stop();
    db.close();
  });

  it('nakonfigurovaný kind mimo shared registry (1057) prejde s počítadlom outsideRegistry', async () => {
    // F4AI-14 (S8): kind 0 je OD TERAZ v shared registry (KINDS.PROFILE),
    // takže na ukážku "nakonfigurovaný, ale mimo registry" berieme 1057 —
    // je v DEFAULT_INDEXER_KINDS (range 1020–1059), ale v registry nie je.
    const pool = makePair();
    const odd = sign('author-p', 1057, NOW - 10, 'kind mimo registry, ale nakonfigurovany');

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    // jeden relay → jedno live doručenie (počítadlo outsideRegistry by
    // in rástalo aj z ignorovaného duplikátu z druhého relayu)
    pool.publish(odd, ['ws://fake-a']);
    expect(db.count()).toBe(1);
    expect(ingestor.snapshot().outsideRegistry).toBe(1);
    ingestor.stop();
    db.close();

    // INDEXER_REQUIRE_REGISTRY=1 → prísny režim, kind 1057 odmietneme
    const strictPool = makePair();
    strictPool.publish(odd);
    const strictDb = new IndexerDb(':memory:');
    const strict = new IndexerIngestor({
      db: strictDb,
      pool: strictPool,
      config: testConfig({ INDEXER_REQUIRE_REGISTRY: '1' }),
    });
    await strict.start();
    expect(strictDb.count()).toBe(0);
    expect(strict.snapshot().invalidEvent).toBe(1);
    strict.stop();
    strictDb.close();
  });

  it('F4AI-14: kindy 0 a 3 sú v shared registry → prejdú aj prísnym režimom bez outsideRegistry', async () => {
    const pool = makePair();
    const profile = sign('author-core0', 0, NOW - 12, '{"name":"jano","display_name":"Jano"}');
    const contacts = sign('author-core3', 3, NOW - 11, JSON.stringify([['a'.repeat(64), 'wss://relay.example', 'follows']]));
    pool.publish(profile);
    pool.publish(contacts);

    const db = new IndexerDb(':memory:');
    const strict = new IndexerIngestor({
      db,
      pool,
      config: testConfig({ INDEXER_REQUIRE_REGISTRY: '1' }),
    });
    await strict.start();
    // oba kindy sa indexujú a NIE SU počítané ako "mimo registry"
    expect(db.count()).toBe(2);
    expect(strict.snapshot().invalidEvent).toBe(0);
    expect(strict.snapshot().outsideRegistry).toBe(0);
    expect(db.getEvent(profile.id)?.kind).toBe(0);
    expect(db.getEvent(contacts.id)?.kind).toBe(3);
    strict.stop();
    db.close();
  });

  it('nenakonfigurovaný kind (9999) sa odmietne ako neplatný event', async () => {
    const pool = makePair();
    const weird = sign('author-w', 9999, NOW - 10, 'nahodiny kind', [['d', 'x']]);

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    // live subscription posiela len nakonfigurované kindy, takže cudzí kind
    // sa k validácii dostane až keď ho relay predsa len pošle (alebo ho
    // zavolame priamo) — odmietnutie musí byť na úrovni validácie, nie filteru
    expect(ingestor.ingestEvent(weird)).toBe('invalid-event');
    expect(db.count()).toBe(0);
    expect(ingestor.snapshot().invalidEvent).toBe(1);
    // a live/dopytovacia cesta ho taktiež nevpustí
    pool.publish(weird);
    await ingestor.runAntiEntropyCycle();
    expect(db.count()).toBe(0);
    ingestor.stop();
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* anti-entropia                                                       */
/* ------------------------------------------------------------------ */

describe('indexer ingest — anti-entropia', () => {
  it('oneskorený prírastok (starší created_at) doplní since sweep', async () => {
    const pool = makePair();
    const fresh = sign('author-ae', 1021, NOW, 'cerstvy');
    pool.publish(fresh);

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    expect(db.count()).toBe(1);

    // relay neskoro doručí starší event (meškaný autor, purge+republish)
    const late = sign('author-ae', 1021, NOW - 60, 'oneskoreny');
    pool.publish(late, []); // len do store, bez live doručenia
    for (const relay of pool.relays) relay.events.push(late);

    await ingestor.runAntiEntropyCycle();
    expect(db.getEvent(late.id)).not.toBeNull();
    expect(ingestor.snapshot().aeLateAdded).toBeGreaterThanOrEqual(1);
    ingestor.stop();
    db.close();
  });

  it('zmiznutý event na relayoch odhalí a po obnove nahlási návrat', async () => {
    const pool = makePair();
    const kept = sign('author-x1', 1021, NOW - 30, 'ostava');
    const purged = sign('author-x2', 1021, NOW - 20, 'zmizol');
    pool.publish(kept);
    pool.publish(purged);

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    expect(db.count()).toBe(2);

    // 1. kolo: všetky id sú prítomné → cache dostane 'present' verdikty
    await ingestor.runAntiEntropyCycle();
    expect(ingestor.snapshot().aeDisappeared).toBe(0);

    pool.remove(purged.id);
    await ingestor.runAntiEntropyCycle();
    const afterLoss = ingestor.snapshot();
    expect(afterLoss.aeIdsChecked).toBeGreaterThanOrEqual(2);
    expect(afterLoss.aeIdsAbsent).toBeGreaterThanOrEqual(1);
    expect(afterLoss.aeDisappeared).toBe(1);

    // republish → ďalšie kolo musí nahlásiť návrat a event ostáva v DB
    pool.publish(purged);
    await ingestor.runAntiEntropyCycle();
    const afterRestore = ingestor.snapshot();
    expect(afterRestore.aeReappeared).toBeGreaterThanOrEqual(1);
    expect(afterRestore.aeCycles).toBe(3);
    expect(db.count()).toBe(2);
    ingestor.stop();
    db.close();
  });

  it('cyklus používa S3-FIFO cache a hlási jej štatistiky', async () => {
    const pool = makePair();
    for (let i = 0; i < 6; i += 1) {
      pool.publish(sign('author-c', 1021, NOW - i * 10, `event ${String(i)}`));
    }
    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    await ingestor.runAntiEntropyCycle();
    await ingestor.runAntiEntropyCycle();
    const cache = ingestor.cacheStats();
    expect(cache).not.toBeNull();
    expect(cache.insertions).toBeGreaterThanOrEqual(6);
    // druhé kolo už idá cez cache (druhe pristupy su hity)
    expect(cache.hits).toBeGreaterThanOrEqual(1);
    expect(cache.size).toBeLessThanOrEqual(cache.capacity);
    ingestor.stop();
    db.close();
  });

  it('interval 0 nespúšťa timer a stop odhlási subscription', async () => {
    const pool = makePair();
    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig() });
    await ingestor.start();
    expect(pool.subscriptionCount).toBe(1);
    ingestor.stop();
    expect(pool.subscriptionCount).toBe(0);
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* restart                                                             */
/* ------------------------------------------------------------------ */

describe('indexer ingest — restart', () => {
  it('druhý ingestor na tej istej DB nenavýša počty (restart bez duplicít)', async () => {
    const pool = makePair();
    const events = [
      sign('author-r', 1021, NOW - 500, 'prvy'),
      sign('author-r', 10030, NOW - 400, 'druhy'),
      sign('author-r2', 30023, NOW - 300, 'treti', [['d', 'clanok-1']]),
    ];
    for (const event of events) pool.publish(event);

    const db = new IndexerDb(':memory:');
    const first = new IndexerIngestor({ db, pool, config: testConfig() });
    await first.start();
    const firstCount = db.count();
    first.stop();
    expect(firstCount).toBe(3);

    const second = new IndexerIngestor({ db, pool, config: testConfig() });
    await second.start();
    expect(db.count()).toBe(3);
    expect(second.snapshot().inserted).toBe(0);
    expect(second.snapshot().ignored + second.snapshot().replaced).toBeGreaterThanOrEqual(3);
    second.stop();
    db.close();
  });
});
