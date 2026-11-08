import { describe, expect, it } from 'vitest';

import {
  KINDS,
  isAddressableKind,
  isAllowedKind,
  validateEvent,
  validateEventStructure,
  validateKind,
  validatePostRootMarker,
  validateTopic,
  CREATED_AT_MAX_FUTURE_S,
  CREATED_AT_MIN_S,
  MAX_CONTENT_BYTES,
  MAX_TAGS,
  MAX_TAG_ELEMENT_BYTES,
} from '../src/index.js';
import type { NostrEvent, NostrTag } from '../src/index.js';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const SIG = 'c'.repeat(128);

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: HEX_A,
    pubkey: HEX_B,
    created_at: 1_793_174_400,
    kind: KINDS.QUESTION,
    tags: [],
    content: 'test',
    sig: SIG,
    ...overrides,
  };
}

describe('validácia kindov', () => {
  it('prijme každý kind našej registry', () => {
    for (const kind of Object.values(KINDS)) {
      const result = validateKind(kind);
      expect(result.valid, `kind ${kind} by mal byť povolený`).toBe(true);
    }
    expect(isAllowedKind(KINDS.TOPIC)).toBe(true);
    expect(isAllowedKind(KINDS.AUTH_NIP98)).toBe(true);
  });

  it('odmietne kind mimo registry (cudzie range, ephemeral, negatívne)', () => {
    for (const kind of [1, 9, 9999, 10000, 10001, 20001, 29999, 30000, 30021, -5, 10.5]) {
      expect(validateKind(kind).valid, `kind ${kind} by mal byť zamietnutý`).toBe(false);
    }
    expect(isAllowedKind(1)).toBe(false);
    expect(isAddressableKind(KINDS.TOPIC)).toBe(true);
    expect(isAddressableKind(KINDS.POST)).toBe(false);
  });
});

describe('pravidlo root markeru pre post (1023)', () => {
  it('prijme post s práve jedným e tagom s markerom root', () => {
    const tags: NostrTag[] = [
      ['e', HEX_B, 'root', 'wss://relay.example', HEX_A],
      ['p', HEX_A],
    ];
    expect(validatePostRootMarker(tags).valid).toBe(true);
  });

  it('odmietne post bez root markeru', () => {
    const tags: NostrTag[] = [['e', HEX_B, 'mention']];
    const result = validatePostRootMarker(tags);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('root');
  });

  it('odmietne post s dvoma root markermi', () => {
    const tags: NostrTag[] = [
      ['e', HEX_B, 'root'],
      ['e', 'd'.repeat(64), 'root'],
    ];
    expect(validatePostRootMarker(tags).valid).toBe(false);
  });

  it('neráta e tag bez markeru ako root a vyžaduje 64-hex id', () => {
    expect(validatePostRootMarker([['e', HEX_B]]).valid).toBe(false);
    expect(validatePostRootMarker([['e', 'nesmysel', 'root']]).valid).toBe(false);
  });

  it('validateEvent aplikuje pravidlo len na kind 1023', () => {
    const noRoot = makeEvent({ kind: KINDS.POST, tags: [] });
    expect(validateEvent(noRoot).valid).toBe(false);
    const withRoot = makeEvent({
      kind: KINDS.POST,
      tags: [['e', HEX_B, 'root']],
    });
    expect(validateEvent(withRoot).valid).toBe(true);
    // root marker nie je požadovaný pre iné kindy (napr. vote 1030)
    const vote = makeEvent({ kind: KINDS.VOTE, tags: [['e', HEX_B]] });
    expect(validateEvent(vote).valid).toBe(true);
  });
});

describe('topic 30020 — slug a parent tag', () => {
  it('prijme topic s d tagom (slug) bez parenta', () => {
    const tags: NostrTag[] = [['d', 'ai-agents'], ['t', 'ai/agents']];
    expect(validateTopic(tags).valid).toBe(true);
  });

  it('prijme topic s validným parent a tagom (PODtopic)', () => {
    const tags: NostrTag[] = [
      ['d', 'mcp'],
      ['a', `30020:${HEX_B}:ai-agents`, 'root'],
    ];
    expect(validateTopic(tags).valid).toBe(true);
  });

  it('odmietne topic bez d tagu', () => {
    const result = validateTopic([['t', 'ai/agents']]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('d tag');
  });

  it('odmietne topic s nevalidným slugom', () => {
    expect(validateTopic([['d', 'AI Agents']]).valid).toBe(false);
    expect(validateTopic([['d', '-mcp-']]).valid).toBe(false);
    expect(validateTopic([['d', '']]).valid).toBe(false);
  });

  it('odmietne parent a tag v nesprávnej forme a viac parentov', () => {
    expect(validateTopic([['d', 'mcp'], ['a', '30021:abc:xyz']]).valid).toBe(false);
    expect(
      validateTopic([
        ['d', 'mcp'],
        ['a', `30020:${HEX_B}:a`],
        ['a', `30020:${HEX_A}:b`],
      ]).valid,
    ).toBe(false);
  });

  it('validateEvent vyžaduje d tag pre addressable kindy a odmietne neplatný kind', () => {
    const topicNoD = makeEvent({ kind: KINDS.TOPIC, tags: [['t', 'x'] ] });
    const result = validateEvent(topicNoD);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    const unknownKind = makeEvent({ kind: 9999 });
    expect(validateEvent(unknownKind).valid).toBe(false);
  });
});

describe('štrukturálna validácia a odmietnutie neplatného eventu', () => {
  it('odmietne ms created_at (NIP-01 vyžaduje sekundy)', () => {
    const result = validateEventStructure(
      makeEvent({ created_at: 1_793_174_400_000 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('NIP-01 requires seconds');
  });

  // regression A9/B1: bez hornej hranice jeden event s created_at ďaleko v
  // budúcnosti (napr. 2^32) rozhádže backfill aj anti-entropický sweep
  it('odmietne created_at ďaleko v budúcnosti (max +900 s)', () => {
    const now = 1_793_174_400;
    const atLimit = validateEventStructure(
      makeEvent({ created_at: now + CREATED_AT_MAX_FUTURE_S }),
      { nowSeconds: now },
    );
    expect(atLimit.valid).toBe(true); // tolerancia hodín predbiehajúcich o 15 min
    const tooFar = validateEventStructure(makeEvent({ created_at: 4_294_967_295 }), {
      nowSeconds: now,
    });
    expect(tooFar.valid).toBe(false);
    expect(tooFar.errors.join(' ')).toContain('in the future');
    // rovnaká hranica platí aj pre kompletnú L2 validáciu
    expect(
      validateEvent(makeEvent({ created_at: 4_294_967_295 }), { nowSeconds: now }).valid,
    ).toBe(false);
  });

  it('odmietne neplatné hex id/pubkey/sig', () => {
    expect(validateEventStructure(makeEvent({ id: 'zz' })).valid).toBe(false);
    expect(validateEventStructure(makeEvent({ pubkey: 'x'.repeat(64) })).valid).toBe(false);
    expect(validateEventStructure(makeEvent({ sig: 'c'.repeat(127) })).valid).toBe(false);
  });

  it('prijme kánonický well-formed event', () => {
    const event = makeEvent({
      kind: KINDS.IDEA_CALL,
      tags: [['d', 'reproducible-rag-eval'], ['bounty', '40']],
    });
    expect(validateEvent(event).valid).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* F4AI-14 (S8), rozhodnutie (a): NIP-01 core kindy 0 a 3 v registry   */
/* ------------------------------------------------------------------ */

describe('core kindy 0 (set-metadata) a 3 (contacts) — F4AI-14', () => {
  it('KINDS ich obsahuje a ALLOWED_KINDS ich pripúšťa', () => {
    expect(KINDS.PROFILE).toBe(0);
    expect(KINDS.CONTACTS).toBe(3);
    expect(isAllowedKind(0)).toBe(true);
    expect(isAllowedKind(3)).toBe(true);
    expect(validateKind(0).valid).toBe(true);
    expect(validateKind(3).valid).toBe(true);
  });

  it('nie sú addressable → nevyžadujú d tag', () => {
    expect(isAddressableKind(KINDS.PROFILE)).toBe(false);
    expect(isAddressableKind(KINDS.CONTACTS)).toBe(false);
    // profile bez akýchkoľvek tagov musí prejsť celou L2 validáciou
    expect(validateEvent(makeEvent({ kind: KINDS.PROFILE, tags: [], content: '{"name":"jano"}' })).valid).toBe(true);
    // contacts s `p` tagmi taktiež
    const contacts = makeEvent({
      kind: KINDS.CONTACTS,
      tags: [[ 'p', HEX_A, 'wss://relay.example', 'follows'], ['p', HEX_B]],
      content: JSON.stringify([[HEX_A, 'wss://relay.example', 'follows']]),
    });
    expect(validateEvent(contacts).valid).toBe(true);
  });

  it('neplatná štruktúra ich stále zamietne (registry nie je voľná jízda)', () => {
    const badMs = makeEvent({ kind: KINDS.PROFILE, created_at: 1_793_174_400_000 });
    expect(validateEvent(badMs).valid).toBe(false);
    const badSig = makeEvent({ kind: KINDS.CONTACTS, sig: 'c'.repeat(127) });
    expect(validateEvent(badSig).valid).toBe(false);
  });

  it('susedné kindy mimo registry (1, 2, 4, 10000) zostávajú zamietnuté', () => {
    for (const kind of [1, 2, 4, 10000, 10001]) {
      expect(validateEvent(makeEvent({ kind })).valid, `kind ${kind}`).toBe(false);
    }
  });
});

// ── A7 (P0, security review): veľkostné stropy a spodná hranica created_at ──

describe('A7: zdieľané stropy obsahu a tagov (P0)', () => {
  it('obsah do 32 KB prejde, o bajt viac sa odmietne', () => {
    const atLimit = makeEvent({ content: 'x'.repeat(MAX_CONTENT_BYTES) });
    expect(validateEvent(atLimit).valid).toBe(true);

    const over = makeEvent({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) });
    const result = validateEvent(over);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/32768/);
  });

  it('32 KB meria UTF-8 bajty, nie znaky (4bajtové emoji)', () => {
    // 8 192 emoji = 32 768 bajtov (prejde), +1 emoji už je nad strop
    const atLimit = makeEvent({ content: '🎉'.repeat(8_192) });
    expect(validateEvent(atLimit).valid).toBe(true);
    const over = makeEvent({ content: '🎉'.repeat(8_193) });
    expect(validateEvent(over).valid).toBe(false);
  });

  it('viac než 64 tagov sa odmietne (64 still prejde)', () => {
    const tag = (i: number): NostrTag => ['e', i.toString(16).padStart(64, '0')];
    const atLimit = makeEvent({ tags: Array.from({ length: MAX_TAGS }, (_, i) => tag(i)) });
    expect(validateEvent(atLimit).valid).toBe(true);

    const over = makeEvent({ tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => tag(i)) });
    const result = validateEvent(over);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/64/);
  });

  it('tag s prvkom dlhším než 1 KB sa odmietne', () => {
    const ok = makeEvent({ tags: [['d', 'x'.repeat(MAX_TAG_ELEMENT_BYTES)]] });
    expect(validateEvent(ok).valid).toBe(true);

    const over = makeEvent({ tags: [['d', 'y'.repeat(MAX_TAG_ELEMENT_BYTES + 1)]] });
    const result = validateEvent(over);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/1024/);
  });

  it('drahý event (veľký obsah + veľa tagov) odmietne aj štrukturálna validácia', () => {
    const result = validateEventStructure(
      makeEvent({
        content: 'a'.repeat(MAX_CONTENT_BYTES * 2),
        tags: Array.from({ length: MAX_TAGS + 10 }, (_, i) => ['t', 'z'.repeat(2048), String(i)] as NostrTag),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it('created_at z roku 2023 sa odmietne (spodná hranica 2024-01-01)', () => {
    const old = makeEvent({ created_at: 1_700_000_000 }); // 2023-11-14
    const result = validateEvent(old);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/2024-01-01/);

    const epochJunk = makeEvent({ created_at: 1 });
    expect(validateEvent(epochJunk).valid).toBe(false);
  });

  it('created_at tesne pod hranicou zamietnutý, presne na hranici prejde', () => {
    expect(validateEvent(makeEvent({ created_at: CREATED_AT_MIN_S - 1 })).valid).toBe(false);
    expect(validateEvent(makeEvent({ created_at: CREATED_AT_MIN_S })).valid).toBe(true);
  });

  it('stropy sú exportované konštanty (gateway aj relay zdieľajú jeden zdroj)', () => {
    expect(MAX_CONTENT_BYTES).toBe(32 * 1024);
    expect(MAX_TAGS).toBe(64);
    expect(MAX_TAG_ELEMENT_BYTES).toBe(1024);
    // 2024-01-01T00:00:00Z
    expect(new Date(CREATED_AT_MIN_S * 1000).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });
});

/**
 * F4AI-2b2: `codes[]` je strojový kontrakt, na ktorom visuje cross-package
 * logika (indexer toleruje kind mimo registry podľa kódu, nie podľa vety).
 * Testy dokladujú (a) indexovú 1:1 väzbu code ↔ error, (b) stabilné kódy
 * pre každú vetu, (c) že text vety sa môže meniť bez zmeny kódu.
 */
describe('stabilné kódy chýb (F4AI-2b2)', () => {
  it('kódy sú indexovo 1:1 s errors a validný výsledok má prázdne kódy', () => {
    const result = validateEvent(makeEvent({ id: 'nothex', content: 42 as unknown as string }));
    expect(result.valid).toBe(false);
    expect(result.codes.length).toBe(result.errors.length);
    expect(result.codes.length).toBeGreaterThan(1);
    expect(result.codes).toEqual(['EVENT_ID_INVALID', 'CONTENT_NOT_STRING']);
    expect(validateEvent(makeEvent()).codes).toEqual([]);
  });

  it('kind mimo registry má kód KIND_NOT_REGISTERED (kontrakt pre indexer)', () => {
    const result = validateKind(20001);
    expect(result.codes).toEqual(['KIND_NOT_REGISTERED']);
    expect(result.errors[0]).toContain('is not in the forum4ai kind registry');
    expect(validateKind(-3).codes).toEqual(['KIND_INVALID']);
  });

  it('each structural rule has its own code', () => {
    const cases: Array<[Partial<NostrEvent>, string]> = [
      [{ pubkey: 'zz' }, 'EVENT_PUBKEY_INVALID'],
      [{ sig: 'z' }, 'EVENT_SIG_INVALID'],
      [{ created_at: 1_793_174_400_000 }, 'CREATED_AT_MILLISECONDS'],
      [{ created_at: 1_700_000_000 }, 'CREATED_AT_TOO_OLD'],
      [{ created_at: Math.floor(Date.now() / 1000) + CREATED_AT_MAX_FUTURE_S + 10 }, 'CREATED_AT_TOO_NEW'],
      [{ tags: 'x' as unknown as NostrTag[] }, 'TAGS_NOT_ARRAY'],
      [{ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) }, 'CONTENT_TOO_LARGE'],
    ];
    for (const [overrides, code] of cases) {
      const result = validateEvent(makeEvent(overrides));
      expect(result.valid, JSON.stringify(Object.keys(overrides))).toBe(false);
      expect(result.codes, code).toContain(code);
    }
  });

  it('kind-specific rules have their codes', () => {
    expect(validatePostRootMarker([['e', HEX_B, 'mention']]).codes).toEqual([
      'POST_ROOT_MARKER_MISSING',
    ]);
    expect(validateTopic([]).codes).toEqual(['TOPIC_D_TAG_MISSING']);
    expect(validateTopic([['d', 'Bad Slug!']]).codes).toEqual(['TOPIC_SLUG_INVALID']);
    expect(validateTopic([['d', 'ok'], ['a', '30020:zz:slug'], ['a', '30020:zz:slug2']]).codes).toEqual(
      ['TOPIC_PARENT_MULTIPLE'],
    );
    expect(validateTopic([['d', 'ok'], ['a', '30021:' + HEX_A + ':slug']]).codes).toEqual([
      'TOPIC_PARENT_ADDRESS_INVALID',
    ]);
    // addressable kind bez d tagu (30020 má own code skôr, než doplníme d)
    const topicNoD = makeEvent({ kind: KINDS.TOPIC, tags: [] });
    expect(validateEvent(topicNoD).codes).toContain('ADDRESSABLE_D_TAG_MISSING');
  });

  it('tag element errors carry TAG_* codes with aligned messages', () => {
    const result = validateEvent(
      makeEvent({ tags: [['t', 'y'.repeat(MAX_TAG_ELEMENT_BYTES + 1)]] }),
    );
    expect(result.codes).toContain('TAG_ELEMENT_TOO_LONG');
    const index = result.codes.indexOf('TAG_ELEMENT_TOO_LONG');
    expect(result.errors[index]).toContain(String(MAX_TAG_ELEMENT_BYTES));
  });
});
