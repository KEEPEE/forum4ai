/**
 * Unit test `MemoryStore` — LWW semantika replaceable/addressable kindov.
 *
 * Regression A1: `add()` pred fixom zahadzoval NOVŠÍ event ako `duplicate`
 * a nechával uložený ten STARŠÍ (LWW obrátene). Test publikuje starší →
 * novší a vyžaduje `replaced` + ponechanie novšieho.
 */
import { describe, expect, it } from 'vitest';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import { MemoryStore, STORE_MAX_LIMIT } from '../src/store.js';

const PK = 'a'.repeat(64);

function ev(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'f'.repeat(64),
    pubkey: PK,
    created_at: 1_700_000_000,
    kind: KINDS.TOPIC,
    tags: [['d', 'slug-a']],
    content: 'obsah',
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

describe('MemoryStore LWW (regression A1)', () => {
  it('addressable 30020: novší created_at nahrádza starší (replaced), nie duplicate', () => {
    const store = new MemoryStore();
    const older = ev({ id: '1'.repeat(64), created_at: 1_000, content: 'starý' });
    const newer = ev({ id: '2'.repeat(64), created_at: 2_000, content: 'novší' });

    expect(store.add(older)).toBe('stored');
    expect(store.add(newer)).toBe('replaced');

    const current = store.query([{ kinds: [KINDS.TOPIC], authors: [PK] }]);
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe('2'.repeat(64));
    expect(current[0]?.content).toBe('novší');
  });

  it('addressable: starší event po novšom je duplicate (nevráti stav späť)', () => {
    const store = new MemoryStore();
    store.add(ev({ id: '2'.repeat(64), created_at: 2_000, content: 'novší' }));
    const stale = ev({ id: '1'.repeat(64), created_at: 1_000, content: 'starý' });

    expect(store.add(stale)).toBe('duplicate');
    expect(store.has('1'.repeat(64))).toBe(false);
    expect(store.query([{ ids: ['2'.repeat(64)] }])[0]?.content).toBe('novší');
  });

  it('LWW tie-break: pri rovnakom created_at vyhráva lexikograficky nižšie id', () => {
    const store = new MemoryStore();
    const higher = ev({ id: '9'.repeat(64), created_at: 1_000, content: 'vyššie id' });
    const lower = ev({ id: '1'.repeat(64), created_at: 1_000, content: 'nižšie id' });

    expect(store.add(higher)).toBe('stored');
    expect(store.add(lower)).toBe('replaced');
    expect(store.query([{ kinds: [KINDS.TOPIC] }])[0]?.id).toBe('1'.repeat(64));
  });

  it('replaceable 10030: LWW per (pubkey, kind) — novší vyhráva', () => {
    const store = new MemoryStore();
    const first = ev({ id: '3'.repeat(64), kind: KINDS.IDEA_CALL_STATUS, tags: [], created_at: 10 });
    const second = ev({ id: '4'.repeat(64), kind: KINDS.IDEA_CALL_STATUS, tags: [], created_at: 20 });
    expect(store.add(first)).toBe('stored');
    expect(store.add(second)).toBe('replaced');
    expect(store.query([{ kinds: [KINDS.IDEA_CALL_STATUS] }])[0]?.id).toBe('4'.repeat(64));
  });

  // regression A3: relay pred fixom ignoroval `d` tag replaceable kindov →
  // status jednej myšlienky zahodil status inej (indexer/read-model počítajú
  // LWW per (autor, kind, d=idea))
  it('replaceable 10030 s d tagom: LWW per (pubkey, kind, d) — iná myšlienka sa nenahradzuje', () => {
    const store = new MemoryStore();
    const ideaA = 'a1'.padEnd(64, '0');
    const ideaB = 'b1'.padEnd(64, '0');
    const statusA = ev({
      id: '5'.repeat(64),
      kind: KINDS.IDEA_CALL_STATUS,
      tags: [['d', ideaA]],
      created_at: 10,
    });
    const statusB = ev({
      id: '6'.repeat(64),
      kind: KINDS.IDEA_CALL_STATUS,
      tags: [['d', ideaB]],
      created_at: 20,
    });
    expect(store.add(statusA)).toBe('stored');
    expect(store.add(statusB)).toBe('stored'); // pred fixom: 'replaced' a strata A
    const both = store.query([{ kinds: [KINDS.IDEA_CALL_STATUS], authors: [PK] }]);
    expect(both.map((e) => e.id).sort()).toEqual(['5'.repeat(64), '6'.repeat(64)]);

    // rovnaká myšlienka (rovnaké d) sa nahradzuje klasicky LWW
    const statusA2 = ev({
      id: '7'.repeat(64),
      kind: KINDS.IDEA_CALL_STATUS,
      tags: [['d', ideaA]],
      created_at: 30,
    });
    expect(store.add(statusA2)).toBe('replaced');
    expect(store.has('5'.repeat(64))).toBe(false);
  });

  it('regular 1020: dedup podľa id, žiadne LWW (oba idia koexistujú)', () => {
    const store = new MemoryStore();
    const a = ev({ id: '5'.repeat(64), kind: KINDS.QUESTION, created_at: 10 });
    const b = ev({ id: '6'.repeat(64), kind: KINDS.QUESTION, created_at: 20 });
    expect(store.add(a)).toBe('stored');
    expect(store.add(b)).toBe('stored');
    expect(store.add(a)).toBe('duplicate');
    expect(store.size).toBe(2);
  });

  it('query bez limitu clampa na max_limit (A13) — filter s limitom > stropu tiež', () => {
    const store = new MemoryStore(3);
    for (let i = 0; i < 10; i += 1) {
      const id = i.toString(16).padStart(64, '0');
      store.add(ev({ id, kind: KINDS.QUESTION, created_at: 100 + i }));
    }
    expect(store.query([{ kinds: [KINDS.QUESTION] }])).toHaveLength(3);
    expect(store.query([{ kinds: [KINDS.QUESTION], limit: 999_999 }])).toHaveLength(3);
    // explicitný nižší limit rešpektujeme
    expect(store.query([{ kinds: [KINDS.QUESTION], limit: 2 }])).toHaveLength(2);
    // default constructor = NIP-11 max_limit
    expect(STORE_MAX_LIMIT).toBe(1000);
  });
});
