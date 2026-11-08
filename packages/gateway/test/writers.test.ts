/**
 * Unit testy `writers.ts` (dizajn B5/B6, P1) — čistý parse/build bez DB
 * a siete. Kľúčové pre bezpečnosť: zoznam pisúcich sa dá čítať aj z
 * KAZDÉHO 30028 (preklep v jednom p-tagu nesmie znehodnotiť celý zoznam),
 * ale strop tagov je daný L2 validátorom (64 tagov), inak by sa vlastník
 * nedostal k republishu vlastného zoznamu.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import {
  AGENTS_D_TAG,
  MAX_AGENT_TAGS,
  MAX_WRITER_TAGS,
  WRITERS_D_TAG,
  buildWritersContent,
  buildWritersTags,
  isAgentsEvent,
  isWritersEvent,
  parseAgentsEvent,
  parseWritersEvent,
  type WriterEntry,
} from '../src/writers.js';

const sk = generateSecretKey();

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function event(kind: number, tags: string[][], content: string): NostrEvent {
  return finalizeEvent({ kind, created_at: 1_730_000_000, tags, content }, sk) as unknown as NostrEvent;
}

describe('parseWritersEvent (30028 d=forum4ai-writers)', () => {
  it('prejde korektný zoznam a zachová relay + expires z p-tagov', () => {
    const tags = [
      ['d', WRITERS_D_TAG],
      ['p', A, 'wss://alpha.example/', '1740000000'],
      ['p', B, 'wss://beta.example/', '1750000000'],
    ];
    const parsed = parseWritersEvent(event(KINDS.NODE_DIRECTORY, tags, buildWritersContent([], 0)));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.operators).toEqual([
      { pubkey: A, relay: 'wss://alpha.example/', registeredAt: 0, expiresAt: 1_740_000_000 },
      { pubkey: B, relay: 'wss://beta.example/', registeredAt: 0, expiresAt: 1_750_000_000 },
    ]);
  });

  it('obsah obohatí registered_at a nechá expires z tagu (tag je silnejší)', () => {
    const content = JSON.stringify({
      version: 1,
      updated_at: 1_730_000_123,
      operators: [{ pubkey: A, registered_at: 1_700_000_000, expires_at: 1_600_000_000 }],
    });
    const parsed = parseWritersEvent(
      event(KINDS.NODE_DIRECTORY, [['d', WRITERS_D_TAG], ['p', A, 'wss://a.example/', '1740000000']], content),
    );
    expect(parsed.updatedAt).toBe(1_730_000_123);
    expect(parsed.operators[0]?.registeredAt).toBe(1_700_000_000);
    expect(parsed.operators[0]?.expiresAt).toBe(1_740_000_000);
  });

  it('neplatný hex, duplikát a prázdný relay neodhodia zvyšok zoznamu', () => {
    const parsed = parseWritersEvent(
      event(KINDS.NODE_DIRECTORY, [
        ['d', WRITERS_D_TAG],
        ['p', 'nope', 'wss://x/'],
        ['p', A],
        ['p', A, 'wss://dup.example/'],
        ['p', B, 'wss://b.example/', '1740000000'],
      ], 'not json'),
    );
    expect(parsed.operators.map((operator) => operator.pubkey)).toEqual([A, B]);
    expect(parsed.operators[0]?.relay).toBe('');
    expect(parsed.updatedAt).toBe(0);
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(3);
    expect(parsed.warnings.join(' ')).toContain('content is not valid JSON');
  });

  it('p-tag bez pubkey je ignorovaný (nevyhodí nás to)', () => {
    const parsed = parseWritersEvent(event(KINDS.NODE_DIRECTORY, [['d', WRITERS_D_TAG], ['p']], ''));
    expect(parsed.operators).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it(`strop ${String(MAX_WRITER_TAGS)} operátorov (L2 validátor má strop 64 tagov)`, () => {
    const many: string[][] = [['d', WRITERS_D_TAG]];
    for (let i = 0; i < MAX_WRITER_TAGS + 5; i += 1) {
      many.push(['p', i.toString(16).padStart(64, '0')]);
    }
    const parsed = parseWritersEvent(event(KINDS.NODE_DIRECTORY, many, ''));
    expect(parsed.operators).toHaveLength(MAX_WRITER_TAGS);
    expect(parsed.warnings.some((line) => line.includes('above the cap'))).toBe(true);
  });

  it('isWritersEvent rozlíši d-tag a kind', () => {
    expect(isWritersEvent(event(KINDS.NODE_DIRECTORY, [['d', WRITERS_D_TAG]], ''))).toBe(true);
    expect(isWritersEvent(event(KINDS.NODE_DIRECTORY, [['d', 'inej-zoznam']], ''))).toBe(false);
    expect(isWritersEvent(event(KINDS.TOPIC, [['d', WRITERS_D_TAG]], ''))).toBe(false);
    expect(isAgentsEvent(event(KINDS.NODE_DIRECTORY, [['d', AGENTS_D_TAG]], ''))).toBe(true);
  });
});

describe('buildWritersTags / buildWritersContent', () => {
  const operators: WriterEntry[] = [
    { pubkey: C, relay: 'wss://c.example/', registeredAt: 1_700_000_000, expiresAt: 1_740_000_000 },
    { pubkey: A, relay: 'wss://a.example/', registeredAt: 1_700_000_001, expiresAt: 0 },
  ];

  it('triedi podľa pubkey (deterministické id republishu) a pridá d-tag', () => {
    const tags = buildWritersTags(operators);
    expect(tags[0]).toEqual(['d', WRITERS_D_TAG]);
    expect(tags[1]?.[1]).toBe(A);
    expect(tags[2]?.[1]).toBe(C);
    expect(tags[1]?.[3]).toBe('0');
  });

  it('obsahuje len platné hex a reži sa pod strop tagov', () => {
    const dirty: WriterEntry[] = [
      ...Array.from({ length: MAX_WRITER_TAGS + 3 }, (_, i) => ({
        pubkey: (i + 1).toString(16).padStart(64, '0'),
        relay: 'wss://x/',
        registeredAt: 0,
        expiresAt: 0,
      })),
      { pubkey: 'bad', relay: '', registeredAt: 0, expiresAt: 0 },
    ];
    expect(buildWritersTags(dirty)).toHaveLength(MAX_WRITER_TAGS + 1); // d-tag + MAX_WRITER_TAGS
    const content = JSON.parse(buildWritersContent(dirty, 1)) as { operators: unknown[] };
    expect(content.operators).toHaveLength(MAX_WRITER_TAGS);
  });

  it('roundtrip: build → parse vráti tú istú množinu operátorov', () => {
    const parsed = parseWritersEvent(
      event(KINDS.NODE_DIRECTORY, buildWritersTags(operators), buildWritersContent(operators, 1_730_000_000)),
    );
    expect(parsed.operators.map((operator) => operator.pubkey)).toEqual([A, C]);
    expect(parsed.operators[0]?.relay).toBe('wss://a.example/');
    expect(parsed.operators[0]?.registeredAt).toBe(1_700_000_001);
    expect(parsed.operators[1]?.expiresAt).toBe(1_740_000_000);
  });
});

describe('parseAgentsEvent (30028 d=agents, dizajn B6)', () => {
  it('strháva duplikáty, normalizuje hex a reži sa pod 20 agentov', () => {
    const many = Array.from({ length: MAX_AGENT_TAGS + 4 }, (_, i) => ['p', (i + 1).toString(16).padStart(64, '0')]);
    const parsed = parseAgentsEvent(
      event(KINDS.NODE_DIRECTORY, [['d', AGENTS_D_TAG], ['p', A.toUpperCase()], ['p', A], ['p', 'zz'], ...many], ''),
    );
    expect(parsed.agents).toHaveLength(MAX_AGENT_TAGS);
    expect(parsed.agents).not.toContain('zz');
    expect(new Set(parsed.agents).size).toBe(parsed.agents.length);
    expect(parsed.warnings.some((line) => line.includes('agents are above the cap'))).toBe(true);
  });
});

// ── role markery p-tagov (design Q1, Phase 1a) ────────────────────────────

describe('parseAgentsEvent — role marker "member"|"agent" (design Q1)', () => {
  it('4. prvok p-tagu je rola: ["p", <hex>, "", "member"]', () => {
    const parsed = parseAgentsEvent(
      event(KINDS.NODE_DIRECTORY, [
        ['d', AGENTS_D_TAG],
        ['p', A, '', 'member'],
        ['p', B, '', 'agent'],
      ], ''),
    );
    expect(parsed.agents).toEqual([A, B]);
    expect(parsed.entries).toEqual([
      { pubkey: A, role: 'member' },
      { pubkey: B, role: 'agent' },
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it('bez markeru = "agent" — presne dnešná semantika starých eventov', () => {
    const parsed = parseAgentsEvent(
      event(KINDS.NODE_DIRECTORY, [['d', AGENTS_D_TAG], ['p', A], ['p', B, 'wss://relay.example/']], ''),
    );
    expect(parsed.entries).toEqual([
      { pubkey: A, role: 'agent' },
      { pubkey: B, role: 'agent' },
    ]);
    // `agents: string[]` sa nemení — write-gate a OperatorsDb ho čítajú ďalej
    expect(parsed.agents).toEqual([A, B]);
    expect(parsed.warnings).toEqual([]);
  });

  it('marker je case-insensitive a toleruje aj ["p", <hex>, "member"]', () => {
    const parsed = parseAgentsEvent(
      event(KINDS.NODE_DIRECTORY, [['d', AGENTS_D_TAG], ['p', A, '', 'MEMBER'], ['p', B, 'agent']], ''),
    );
    expect(parsed.entries.map((entry) => entry.role)).toEqual(['member', 'agent']);
    expect(parsed.warnings).toEqual([]);
  });

  it('neznámy marker → "agent" + varovanie (položku NEzahodíme)', () => {
    const parsed = parseAgentsEvent(
      event(KINDS.NODE_DIRECTORY, [['d', AGENTS_D_TAG], ['p', A, '', 'robot'], ['p', B]], ''),
    );
    expect(parsed.entries).toEqual([
      { pubkey: A, role: 'agent' },
      { pubkey: B, role: 'agent' },
    ]);
    expect(parsed.agents).toEqual([A, B]);
    expect(parsed.warnings.join(' ')).toContain('unknown role marker');
  });

  it('relay URL na indexe 2 NIE je marker (žiadne plané varovanie)', () => {
    const parsed = parseAgentsEvent(
      event(KINDS.NODE_DIRECTORY, [['d', AGENTS_D_TAG], ['p', A, 'wss://relay.example/']], ''),
    );
    expect(parsed.entries).toEqual([{ pubkey: A, role: 'agent' }]);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('parseWritersEvent — voliteľný role marker (30028 d=forum4ai-writers)', () => {
  it('starý zoznam sa parsuje IDENTICKY: pole role v zázname vôbec nie je', () => {
    const parsed = parseWritersEvent(
      event(KINDS.NODE_DIRECTORY, [['d', WRITERS_D_TAG], ['p', A, 'wss://alpha.example/', '1740000000']], ''),
    );
    expect(parsed.operators).toStrictEqual([
      { pubkey: A, relay: 'wss://alpha.example/', registeredAt: 0, expiresAt: 1_740_000_000 },
    ]);
    expect(Object.hasOwn(parsed.operators[0] as object, 'role')).toBe(false);
    expect(parsed.warnings).toEqual([]);
  });

  it('marker za expires_at: ["p", hex, relay, expires, "member"]', () => {
    const parsed = parseWritersEvent(
      event(KINDS.NODE_DIRECTORY, [['d', WRITERS_D_TAG], ['p', A, 'wss://a/', '1740000000', 'member']], ''),
    );
    expect(parsed.operators[0]).toMatchObject({ expiresAt: 1_740_000_000, role: 'member' });
    expect(parsed.warnings).toEqual([]);
  });

  it('marker bez expires_at: ["p", hex, relay, "member"] (expires 0, rola platí)', () => {
    const parsed = parseWritersEvent(
      event(KINDS.NODE_DIRECTORY, [['d', WRITERS_D_TAG], ['p', A, 'wss://a/', 'agent']], ''),
    );
    expect(parsed.operators[0]).toMatchObject({ expiresAt: 0, role: 'agent' });
  });

  it('neznámy marker → "agent" + varovanie, zoznam ostáva platný', () => {
    const parsed = parseWritersEvent(
      event(KINDS.NODE_DIRECTORY, [['d', WRITERS_D_TAG], ['p', A, 'wss://a/', '1740000000', 'admin']], ''),
    );
    expect(parsed.operators[0]).toMatchObject({ pubkey: A, expiresAt: 1_740_000_000, role: 'agent' });
    expect(parsed.warnings.join(' ')).toContain('unknown role marker');
  });

  it('roundtrip build → parse nezanechá rolu, ktorú build nevysielal', () => {
    const operators: WriterEntry[] = [
      { pubkey: A, relay: 'wss://a/', registeredAt: 0, expiresAt: 0 },
    ];
    const parsed = parseWritersEvent(
      event(KINDS.NODE_DIRECTORY, buildWritersTags(operators), buildWritersContent(operators, 1)),
    );
    expect(Object.hasOwn(parsed.operators[0] as object, 'role')).toBe(false);
  });
});
