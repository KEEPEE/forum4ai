/**
 * Testy parsovania listov členov (F4AI-24, Phase 1b — panel „Členovia a
 * agenti“ v nastaveniach).
 *
 * Zdroj pravdy je kind 30028 od MAJITEĽA zápisov:
 *  - `d=forum4ai-writers`: `["p", pubkey, relay, expires_at]`
 *  - `d=agents`:           `["p", pubkey, "", "member"|"agent"]`
 *
 * UI nesmie nič domýšľať: neplatný pubkey sa vynechá s varovaním,
 * neznámy role marker sa berie ako `agent` (rovnaké pravidlo ako
 * `parseAgentsEvent` v gatewayi — inak by sa panel a write-gate nezhodovali),
 * a z dvoch verzií toho istého listu sa ukáže NAJNOVŠIA.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENTS_D_TAG,
  WRITERS_D_TAG,
  dTagOf,
  latestByD,
  parseAgentsEvent,
  parseMemberLists,
  parseWritersEvent,
} from '../src/lib/members.js';
import type { EventSummary } from '../src/api/types.js';
import { hexId } from './fixtures.js';

function summary(kind: number, tags: string[][], created_at = 1_700_000_000): EventSummary {
  return {
    id: hexId('e'),
    pubkey: hexId('a1'),
    created_at,
    kind,
    tags,
    content: '',
    sig: hexId('f'),
  };
}

const MEMBER_A = hexId('b1');
const MEMBER_B = hexId('b2');
const AGENT_C = hexId('c3');

describe('dTagOf / latestByD', () => {
  it('prečíta `d` tag a ignoruje eventy bez neho', () => {
    expect(dTagOf(summary(30028, [['d', WRITERS_D_TAG]]))).toBe(WRITERS_D_TAG);
    expect(dTagOf(summary(30028, []))).toBeNull();
  });

  it('z dvoch verzií listu vyberie najnovšiu (podľa `created_at`)', () => {
    const older = summary(30028, [['d', WRITERS_D_TAG], ['p', MEMBER_A]], 100);
    const newer = summary(30028, [['d', WRITERS_D_TAG], ['p', MEMBER_B]], 200);
    const picked = latestByD([older, newer], WRITERS_D_TAG);
    expect(picked?.created_at).toBe(200);
    expect(latestByD([older], AGENTS_D_TAG)).toBeNull();
  });
});

describe('parseWritersEvent (d=forum4ai-writers)', () => {
  it('prečíta pubkey + relay + expiráciu', () => {
    const list = parseWritersEvent(
      summary(30028, [
        ['d', WRITERS_D_TAG],
        ['p', MEMBER_A, 'wss://relay.example', '1800000000'],
        ['p', MEMBER_B],
      ]),
    );
    expect(list.entries).toHaveLength(2);
    expect(list.entries[0]).toMatchObject({
      pubkey: MEMBER_A,
      role: 'member',
      relay: 'wss://relay.example',
      expiresAt: 1_800_000_000,
    });
    // bez relay/expirácie je člen stále platný, len bez údajov
    expect(list.entries[1]).toMatchObject({ pubkey: MEMBER_B, role: 'member', expiresAt: 0 });
    expect(list.warnings).toEqual([]);
  });

  it('neplatný pubkey vynechá a povie prečo (nezobrazíme „“)', () => {
    const list = parseWritersEvent(summary(30028, [['d', WRITERS_D_TAG], ['p', 'zz'], ['p', MEMBER_A]]));
    expect(list.entries.map((entry) => entry.pubkey)).toEqual([MEMBER_A]);
    expect(list.warnings[0]).toContain('neplatným pubkey');
  });

  it('nečitateľná expirácia → 0 + varovanie (žiadne NaN v UI)', () => {
    const list = parseWritersEvent(summary(30028, [['d', WRITERS_D_TAG], ['p', MEMBER_A, '', 'o-my-lom']]));
    expect(list.entries[0]?.expiresAt).toBe(0);
    expect(list.warnings[0]).toContain('expirácia');
  });

  it('duplicitný pubkey sa nesčíta (posledný platí)', () => {
    const list = parseWritersEvent(
      summary(30028, [
        ['d', WRITERS_D_TAG],
        ['p', MEMBER_A, '', '100'],
        ['p', MEMBER_A, 'wss://druhy.example', '200'],
      ]),
    );
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({ relay: 'wss://druhy.example', expiresAt: 200 });
  });

  it('null event = prázdny list, nie chyba', () => {
    expect(parseWritersEvent(null)).toEqual({ entries: [], warnings: [], event: null });
  });
});

describe('parseAgentsEvent (d=agents)', () => {
  it('rozlíši `member` a `agent` podľa role markeru', () => {
    const list = parseAgentsEvent(
      summary(30028, [
        ['d', AGENTS_D_TAG],
        ['p', MEMBER_A, '', 'member'],
        ['p', AGENT_C, '', 'agent'],
      ]),
    );
    expect(list.entries.map((entry) => entry.role)).toEqual(['member', 'agent']);
    expect(list.warnings).toEqual([]);
  });

  it('prázdny marker = agent (konvencia gatewayu)', () => {
    const list = parseAgentsEvent(summary(30028, [['d', AGENTS_D_TAG], ['p', AGENT_C, '', '']]));
    expect(list.entries[0]?.role).toBe('agent');
    expect(list.warnings).toEqual([]);
  });

  it('neznámy marker → agent + varovanie (zhodné s gateway `parseAgentsEvent`)', () => {
    const list = parseAgentsEvent(summary(30028, [['d', AGENTS_D_TAG], ['p', AGENT_C, '', 'moderator']]));
    expect(list.entries[0]?.role).toBe('agent');
    expect(list.warnings[0]).toContain('neznámy role marker');
  });
});

describe('parseMemberLists (jeden fetch, obe listy)', () => {
  it('roztriedi zmiešaný `kinds=[30028]` result podľa `d`', () => {
    const parsed = parseMemberLists([
      summary(30028, [['d', WRITERS_D_TAG], ['p', MEMBER_A, 'wss://relay.example', '1800000000']]),
      summary(30028, [['d', AGENTS_D_TAG], ['p', AGENT_C, '', 'agent']]),
      summary(30028, [['d', 'ine-pouzitie'], ['p', MEMBER_B]]),
    ]);
    expect(parsed.writers.entries.map((entry) => entry.pubkey)).toEqual([MEMBER_A]);
    expect(parsed.agents.entries.map((entry) => entry.pubkey)).toEqual([AGENT_C]);
    expect(parsed.agents.entries[0]?.role).toBe('agent');
  });

  it('prázdny result = dva prázdne listy (panel povie „ešte nič“, nie chybu)', () => {
    const parsed = parseMemberLists([]);
    expect(parsed.writers.entries).toEqual([]);
    expect(parsed.agents.entries).toEqual([]);
    expect(parsed.writers.event).toBeNull();
  });
});
