/**
 * Unit testy NIP-65 outbox writeru — výber write relayov z kind 30002,
 * fallback na pool defaulty, TTL cache, invalidácia, single-flight.
 * Pool je mocknutý cez minimálny tvár `OutboxPool` (query + readyRelays).
 */
import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

import {
  OutboxWriter,
  writeRelaysFromOutboxEvent,
  type OutboxPool,
} from '../src/outbox.js';

const PUBKEY = 'c'.repeat(64);
const DEFAULTS = ['ws://default-a.example', 'ws://default-b.example'];

class MockPool implements OutboxPool {
  queryCalls = 0;
  lastFilters: Filter[] | null = null;
  ready = true;
  /** keď true, query sa nezavrie — test single-flight */
  hold = false;
  pending: { resolve: (events: Event[]) => void } | null = null;
  responder: () => Event[] | Promise<Event[]> = () => [];

  async query(filters: Filter[]): Promise<Event[]> {
    this.queryCalls += 1;
    this.lastFilters = filters;
    if (this.hold) {
      return new Promise<Event[]>((resolve) => {
        this.pending = { resolve };
      });
    }
    return this.responder();
  }

  readyRelays(): string[] {
    return this.ready ? ['ws://read.example/'] : [];
  }
}

function outboxEvent(tags: string[][], created_at = 1_700_000_000, id = 'a'.repeat(64)): Event {
  return {
    id,
    pubkey: PUBKEY,
    created_at,
    kind: 30002,
    tags,
    content: '',
    sig: 'b'.repeat(128),
  };
}

function writerWith(
  pool: MockPool,
  overrides?: { ttlMs?: number; now?: () => number; maxWriteRelays?: number },
): OutboxWriter {
  return new OutboxWriter(pool, {
    defaultWriteRelays: DEFAULTS,
    ttlMs: overrides?.ttlMs ?? 60_000,
    maxWriteRelays: overrides?.maxWriteRelays,
    now: overrides?.now,
  });
}

describe('writeRelaysFromOutboxEvent — vyber `r` tagy s write markerom', () => {
  it('vezme len `w` (a `rw`/`write`) markery, normalizuje a deduplikuje', () => {
    const event = outboxEvent([
      ['d', ''],
      ['r', 'wss://w1.example', 'w'],
      ['r', 'wss://w1.example/', 'w'], // duplikát po normalizácii
      ['r', 'wss://rw.example', 'rw'],
      ['r', 'wss://write.example', 'write'],
      ['r', 'wss://multi.example', 'mention w'],
      ['r', 'wss://read-only.example'], // bez markeru = read
      ['r', 'wss://read.example', 'read'],
      ['r', 'not a url', 'w'], // neplatná URL sa prehliadne
      ['t', 'irrelevant'],
    ]);
    expect(writeRelaysFromOutboxEvent(event)).toEqual([
      'wss://w1.example/',
      'wss://rw.example/',
      'wss://write.example/',
      'wss://multi.example/',
    ]);
  });
});

describe('writeRelaysFor — fallback MUSÍ fungovať', () => {
  it('autor s 30002 → write relays z `w` markerov (source outbox)', async () => {
    const pool = new MockPool();
    pool.responder = () => [
      outboxEvent([
        ['d', ''],
        ['r', 'wss://w1.example', 'w'],
        ['r', 'wss://r1.example', 'read'],
      ]),
    ];
    const outbox = writerWith(pool);

    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual(['wss://w1.example/']);
    const entry = await outbox.lookup(PUBKEY);
    expect(entry.source).toBe('outbox');
    expect(pool.lastFilters?.[0]).toMatchObject({ kinds: [30002], authors: [PUBKEY] });
  });

  it('autor bez 30002 → default write relays poolu (source fallback)', async () => {
    const pool = new MockPool();
    pool.responder = () => [];
    const outbox = writerWith(pool);

    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual([
      'ws://default-a.example/',
      'ws://default-b.example/',
    ]);
    expect((await outbox.lookup(PUBKEY)).source).toBe('fallback');
  });

  it('30002 len s read markermi → fallback na defaulty', async () => {
    const pool = new MockPool();
    pool.responder = () => [outboxEvent([['r', 'wss://read.example', 'read']])];
    const outbox = writerWith(pool);

    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual([
      'ws://default-a.example/',
      'ws://default-b.example/',
    ]);
  });

  it('žiadny connected read relay → fallback bez dotazu a bez cache', async () => {
    const pool = new MockPool();
    pool.ready = false;
    const outbox = writerWith(pool);

    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual([
      'ws://default-a.example/',
      'ws://default-b.example/',
    ]);
    expect(pool.queryCalls).toBe(0);
    // prechodný stav sa necachuje — ďalší lookup skúsi znova
    expect(outbox.cachedEntries()).toEqual([]);
    pool.ready = true;
    pool.responder = () => [outboxEvent([['r', 'wss://w1.example', 'w']])];
    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual(['wss://w1.example/']);
    expect(pool.queryCalls).toBe(1);
  });

  it('neplatný pubkey → fallback, nič sa necachuje', async () => {
    const pool = new MockPool();
    const outbox = writerWith(pool);
    expect(await outbox.writeRelaysFor('hruba-nesmysl')).toEqual([
      'ws://default-a.example/',
      'ws://default-b.example/',
    ]);
    expect(pool.queryCalls).toBe(0);
    expect(outbox.cachedEntries()).toEqual([]);
  });

  it('viac verzií 30002 → rozhoduje najnovší created_at (LWW)', async () => {
    const pool = new MockPool();
    pool.responder = () => [
      outboxEvent([['r', 'wss://stary.example', 'w']], 1_600_000_000, '1'.repeat(64)),
      outboxEvent([['r', 'wss://novy.example', 'w']], 1_800_000_000, '2'.repeat(64)),
    ];
    const outbox = writerWith(pool);
    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual(['wss://novy.example/']);
  });

  it('cudzí pubkey v evente sa ignoruje', async () => {
    const pool = new MockPool();
    pool.responder = () => [
      { ...outboxEvent([['r', 'wss://cudzi.example', 'w']]), pubkey: 'd'.repeat(64) },
    ];
    const outbox = writerWith(pool);
    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual([
      'ws://default-a.example/',
      'ws://default-b.example/',
    ]);
  });

  it('maxWriteRelays oreže dlhý zoznam', async () => {
    const pool = new MockPool();
    pool.responder = () => [
      outboxEvent(
        Array.from({ length: 12 }, (_, i) => ['r', `wss://w${String(i)}.example`, 'w']),
      ),
    ];
    const outbox = writerWith(pool, { maxWriteRelays: 3 });
    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual([
      'wss://w0.example/',
      'wss://w1.example/',
      'wss://w2.example/',
    ]);
  });
});

describe('cache s TTL a manual invalidáciou', () => {
  it('druhý lookup v TTL nepoužije sieť; po TTL prebehne refetch', async () => {
    let nowMs = 1_000_000;
    const pool = new MockPool();
    pool.responder = () => [outboxEvent([['r', 'wss://w1.example', 'w']])];
    const outbox = writerWith(pool, { ttlMs: 1_000, now: () => nowMs });

    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual(['wss://w1.example/']);
    nowMs += 999;
    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual(['wss://w1.example/']);
    expect(pool.queryCalls).toBe(1);

    nowMs += 2; // za TTL
    expect(await outbox.writeRelaysFor(PUBKEY)).toEqual(['wss://w1.example/']);
    expect(pool.queryCalls).toBe(2);
  });

  it('invalidate(pubkey) vynúti refetch, invalidate() vymaže všetko', async () => {
    const pool = new MockPool();
    pool.responder = () => [outboxEvent([['r', 'wss://w1.example', 'w']])];
    const outbox = writerWith(pool);

    await outbox.writeRelaysFor(PUBKEY);
    await outbox.writeRelaysFor(PUBKEY);
    expect(pool.queryCalls).toBe(1);

    outbox.invalidate(PUBKEY);
    await outbox.writeRelaysFor(PUBKEY);
    expect(pool.queryCalls).toBe(2);

    outbox.invalidate();
    expect(outbox.cachedEntries()).toEqual([]);
  });

  it('konkurenčné lookupy na rovnaký pubkey zdieľajú jeden fetch', async () => {
    const pool = new MockPool();
    pool.hold = true;
    const outbox = writerWith(pool);

    const first = outbox.lookup(PUBKEY);
    const second = outbox.lookup(PUBKEY);
    // obidve volania čakajú na ten istý fetch → jeden dotaz na relaye
    await Promise.resolve();
    pool.pending?.resolve([outboxEvent([['r', 'wss://w1.example', 'w']])]);

    const [a, b] = await Promise.all([first, second]);
    expect(pool.queryCalls).toBe(1);
    expect(a.relays).toEqual(['wss://w1.example/']);
    expect(b.relays).toEqual(a.relays);
  });

  it('cache entry nesedí cez pubkey normalizáciu (veľké hex písmená)', async () => {
    const pool = new MockPool();
    pool.responder = () => [outboxEvent([['r', 'wss://w1.example', 'w']])];
    const outbox = writerWith(pool);
    expect(await outbox.writeRelaysFor(PUBKEY.toUpperCase())).toEqual(['wss://w1.example/']);
  });
});
