/**
 * Unit testy lokálneho vyhľadávania pre MCP `forum_search` (F4AI-12, S6) —
 * čisté funkcie bez siete: normalizácia diakritiky, AND sémantika,
 * ranking, snippet z originálneho contentu.
 */
import { describe, expect, it } from 'vitest';

import {
  normalizeForSearch,
  normalizeWithMap,
  searchEvents,
  type SearchableEvent,
} from '../src/mcp/search.js';

function ev(id: string, content: string, created_at = 1_000_000_000, kind = 1020): SearchableEvent {
  return { id, pubkey: 'a'.repeat(64), created_at, kind, tags: [], content };
}

describe('normalizeForSearch', () => {
  it('zhodí diakritiku na ASCII základ (slovenské háčiky a čárky)', () =>
    expect(normalizeForSearch('Príklad Klčová Ďumbier')).toBe('priklad klcova dumbier'));

  it('lowercase + zlúčenie bielych znakov + trim', () =>
    expect(normalizeForSearch('  ViAC   RIADKOV\t\n  ')).toBe('viac riadkov'));

  it('NFD→ASCII funguje aj na kombinované znaky a preklepy', () => {
    expect(normalizeForSearch('DUCHON')).toBe('duchon');
    expect(normalizeForSearch('vlhko')).toBe('vlhko');
    expect(normalizeForSearch('Vlhko')).toBe('vlhko');
  });
});

describe('normalizeWithMap', () => {
  it('mapuje pozície normalizovaného reťazca späť na originál', () => {
    const { normalized, rawIndex } = normalizeWithMap('Príklad');
    expect(normalized).toBe('priklad');
    // 'priklad'[0] → raw 0 ('P'), 'priklad'[1] → raw 1 ('í' → 'i')
    expect(rawIndex[0]).toBe(0);
    expect(rawIndex[1]).toBe(1);
    expect(rawIndex[6]).toBe(6);
  });
});

describe('searchEvents', () => {
  const events: SearchableEvent[] = [
    ev('e1', 'Ako na nostr outbox w-tagy?', 100),
    ev('e2', 'Príklad: nastavenie relaya pre agentov', 200),
    ev('e3', 'dumbé otázky o dumbých veciach o dumbých ľuďoch', 300),
    ev('e4', 'žiadna stopa', 400),
  ];

  it('diakritika: query bez mäkčeňov nájde text s mäkčeňmi (a opačne)', () => {
    const hits = searchEvents(events, 'priklad');
    expect(hits.map((h) => h.id)).toEqual(['e2']);
    const hits2 = searchEvents(events, 'PRÍKLAD');
    expect(hits2.map((h) => h.id)).toEqual(['e2']);
  });

  it('AND sémantika: všetky termíny musia byť prítomné', () => {
    expect(searchEvents(events, 'nostr w-tagy').map((h) => h.id)).toEqual(['e1']);
    expect(searchEvents(events, 'nostr outbox agentov')).toEqual([]);
  });

  it('ranking: viac výskytov > menej; full-phrase bonus; created_at ako tie-break', () => {
    const hits = searchEvents(events, 'dumb');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('e3');
    expect(hits[0]!.score).toBeGreaterThanOrEqual(3); // 3 výskyty + word bonusy

    const tie = searchEvents(
      [ev('starsi', 'stopa x', 100), ev('novsi', 'stopa x', 200)],
      'stopa',
    );
    expect(tie.map((h) => h.id)).toEqual(['novsi', 'starsi']);
  });

  it('snippet pochádza z ORIGINÁLneho contentu (diakritika zachovaná)', () => {
    const [hit] = searchEvents(events, 'nastavenie');
    expect(hit?.snippet).toContain('Príklad: nastavenie');
  });

  it('limit ostrihne výsledky', () => {
    const many = Array.from({ length: 10 }, (_, i) => ev(`id${String(i)}`, `zhoda ${String(i)}`));
    expect(searchEvents(many, 'zhoda', 3)).toHaveLength(3);
  });

  it('prázdny dotaz → žiadne výsledky; prázdny content sa preskočí', () => {
    expect(searchEvents(events, '   ')).toEqual([]);
    expect(searchEvents([ev('x', '')], 'hocičo')).toEqual([]);
  });
});
