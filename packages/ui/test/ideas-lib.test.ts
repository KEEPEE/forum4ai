/**
 * Unit testy `src/lib/ideas.ts` (F4AI-19, S13) — client-side kópia
 * automatu z `gateway/src/ideas.ts`, F1 heuristika agent filtru,
 * URL sync parsovanie a draft stavby 1021/10030.
 *
 * Prechodový stôl testujeme EXHAUSTÍVNE (6×6 = 36 dvojíc + finály),
 * lebo kópia sa od gateway líši len textom dôvodov — pravidlá musia sedieť.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FILTERS,
  FINAL_IDEA_STATUSES,
  IDEA_STATUSES,
  buildClaimTemplate,
  buildNewIdeaTemplate,
  canTransition,
  filterIdeasClientSide,
  filtersFromParams,
  filtersToParams,
  ideaExcerpt,
  isAgentIdea,
  latestClaimSuggestion,
  ratingBadgeText,
} from '../src/lib/ideas.js';
import type { IdeaRow } from '../src/api/types.js';

/** legálne prechody podľa automatu (gateway `TRANSITIONS`) */
const LEGAL: [string, string][] = [
  ['open', 'claimed'],
  ['open', 'cancelled'],
  ['claimed', 'in_progress'],
  ['claimed', 'open'],
  ['claimed', 'cancelled'],
  ['in_progress', 'review'],
  ['in_progress', 'cancelled'],
  ['review', 'done'],
  ['review', 'cancelled'],
];

function row(overrides: Partial<IdeaRow> = {}): IdeaRow {
  return {
    id: 'a'.repeat(64),
    title: 't',
    description: '',
    topics: [],
    author: 'b'.repeat(64),
    created_at: 1,
    status: 'open',
    claimant: null,
    status_history: [],
    suggestions_count: 0,
    rating: null,
    ...overrides,
  };
}

describe('canTransition — kópia automatu z gateway ideas.ts', () => {
  it('povoľuje všetkých 9 legálnych prechodov', () => {
    for (const [from, to] of LEGAL) {
      const check = canTransition(from, to);
      expect(check.ok, `${from} → ${to}`).toBe(true);
      expect(check.reason).toBeNull();
    }
  });

  it('zakazuje prechody z finálnych stavov (done, cancelled)', () => {
    for (const from of FINAL_IDEA_STATUSES) {
      for (const to of IDEA_STATUSES) {
        const check = canTransition(from, to);
        expect(check.ok, `${from} → ${to}`).toBe(false);
        expect(check.reason).toContain('finálny stav');
      }
    }
  });

  it('zakazuje samoprechod (zhodný stav — LWW obnovu automat nerieši)', () => {
    for (const status of ['open', 'claimed', 'in_progress', 'review'] as const) {
      const check = canTransition(status, status);
      expect(check.ok, `${status} → ${status}`).toBe(false);
      expect(check.reason).toContain('zhodný stav');
    }
  });

  it('zakazuje nelegálne dvojice a vypíše legálne alternatívy v dôvode', () => {
    const check = canTransition('in_progress', 'claimed');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("prechod 'in_progress' → 'claimed' nie je v automate");
    expect(check.reason).toContain('review, cancelled');
  });

  it('exhaustívne: 36 dvojíc sedí presne na LEGAL množinu', () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}→${t}`));
    for (const from of IDEA_STATUSES) {
      for (const to of IDEA_STATUSES) {
        const expected = legalSet.has(`${from}→${to}`);
        expect(canTransition(from, to).ok, `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it('neznámy status (delivered z starej skice) → dôvod, nie crash', () => {
    expect(canTransition('delivered', 'claimed').ok).toBe(false);
    expect(canTransition('open', 'abandoned').ok).toBe(false);
    expect(canTransition('delivered', 'claimed').reason).toContain('neznámy počiatočný');
  });
});

describe('isAgentIdea — F1 heuristika (t-tag agent)', () => {
  it('row s `agent` t-tagom je agent', () => {
    expect(isAgentIdea(row({ topics: ['rust', 'agent'] }))).toBe(true);
  });

  it('veľkosť písmen nezávisí a trim sa strpí', () => {
    expect(isAgentIdea(row({ topics: ['Agent '] }))).toBe(true);
  });

  it('bez `agent` tagu je človek (aj keď topic obsahuje ' + "'agents')", () => {
    expect(isAgentIdea(row({ topics: ['agents', 'ai-agents'] }))).toBe(false);
    expect(isAgentIdea(row({ topics: [] }))).toBe(false);
  });
});

describe('filterIdeasClientSide — who + author', () => {
  const agentRow = row({ id: 'a'.repeat(64), topics: ['agent'] });
  const humanRow = row({ id: 'b'.repeat(64), topics: ['rust'] });
  const otherAuthor = row({ id: 'c'.repeat(64), author: 'd'.repeat(64) });

  it('who=all pustí všetko', () => {
    expect(filterIdeasClientSide([agentRow, humanRow], { who: 'all', author: '' })).toHaveLength(2);
  });

  it('who=agents ponechá len agent rows (client-side, F1)', () => {
    expect(filterIdeasClientSide([agentRow, humanRow], { who: 'agents', author: '' })).toEqual([agentRow]);
  });

  it('who=humans ponechá len rows bez agent tagu', () => {
    expect(filterIdeasClientSide([agentRow, humanRow], { who: 'humans', author: '' })).toEqual([humanRow]);
  });

  it('author filtruje presným pubkeyom', () => {
    expect(filterIdeasClientSide([agentRow, otherAuthor], { who: 'all', author: 'd'.repeat(64) })).toEqual([otherAuthor]);
  });

  it('who a author sa skladajú', () => {
    const agentOther = row({ id: 'e'.repeat(64), topics: ['agent'], author: 'd'.repeat(64) });
    expect(filterIdeasClientSide([agentRow, otherAuthor, agentOther], { who: 'agents', author: 'd'.repeat(64) })).toEqual([agentOther]);
  });
});

describe('URL sync filtrov (filtersFromParams / filtersToParams)', () => {
  it('defaulty: prázdny query → všetky filtre vypnuté', () => {
    expect(filtersFromParams(new URLSearchParams())).toEqual(DEFAULT_FILTERS);
  });

  it('roundtrip status+topic+who+author', () => {
    const state = {
      status: 'in_progress' as const,
      topic: 'rust/tantivy',
      who: 'agents' as const,
      author: 'a'.repeat(64),
    };
    expect(filtersFromParams(filtersToParams(state))).toEqual(state);
  });

  it('neznamy status/who padaju na default (odkaz sa nerozpadne)', () => {
    const parsed = filtersFromParams(new URLSearchParams('status=delivered&who=robots'));
    expect(parsed.status).toBe('all');
    expect(parsed.who).toBe('all');
  });

  it('author musí byť 64-hex, inak sa zahodí', () => {
    expect(filtersFromParams(new URLSearchParams('author=skratka')).author).toBe('');
    expect(filtersFromParams(new URLSearchParams(`author=${'A'.repeat(64)}`)).author).toBe('a'.repeat(64));
  });

  it('filtersToParams vynecháva defaulty (čistá URL)', () => {
    expect(filtersToParams(DEFAULT_FILTERS).toString()).toBe('');
  });
});

describe('zobrazovacie helpery', () => {
  it('ideaExcerpt: prázdny popis → fallback, dlhý sa strihne s …', () => {
    expect(ideaExcerpt('   ')).toBe('(bez popisu)');
    expect(ideaExcerpt('krátky popis')).toBe('krátky popis');
    const long = 'x'.repeat(300);
    const cut = ideaExcerpt(long, 50);
    expect(cut.length).toBe(50);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('ideaExcerpt zjednotí nové riadky a medzery', () => {
    expect(ideaExcerpt('riadok1\n\nriadok2   viac  medzier')).toBe('riadok1 riadok2 viac medzier');
  });

  it('ratingBadgeText: null bez dát, null pri count 0, inak ★ mean15 (count)', () => {
    expect(ratingBadgeText(null)).toBeNull();
    const noRatings = {
      count: 0,
      mean: 0,
      mean15: 0,
      n_eff: 0,
      wilson: 0,
      weightTotal: 0,
      weightRaw: 0,
      epoch: null,
      accepted: false,
      accepted_count: 0,
    };
    expect(ratingBadgeText(noRatings)).toBeNull();
    expect(ratingBadgeText({ ...noRatings, count: 3, mean15: 4.2 })).toBe('★ 4.20 (3)');
  });
});

describe('draft stavby 1021 / 10030', () => {
  it('buildNewIdeaTemplate: title tag + normalizované t tagy', () => {
    const t = buildNewIdeaTemplate({
      title: '  Moya idea  ',
      text: 'popis',
      topics: [' Rust ', 'Nostr Agents', ''],
      asAgent: false,
      createdAt: 1700,
    });
    expect(t.kind).toBe(1021);
    expect(t.content).toBe('popis');
    expect(t.created_at).toBe(1700);
    // F4AI-2b2: draft nesie NIP-32 label — bez `lang` je to default `en`
    expect(t.tags).toEqual([
      ['title', 'Moya idea'],
      ['t', 'rust'],
      ['t', 'nostr-agents'],
      ['L', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ]);
  });

  it('F4AI-2b2: draft 1021 s lang=sk nesie SK label, neznámy kód nepridá nič', () => {
    const sk = buildNewIdeaTemplate({
      title: 'x',
      text: '',
      topics: [],
      asAgent: false,
      createdAt: 1,
      lang: 'sk',
    });
    expect(sk.tags).toEqual([
      ['title', 'x'],
      ['L', 'ISO-639-1'],
      ['l', 'sk', 'ISO-639-1'],
    ]);
    const bogus = buildNewIdeaTemplate({
      title: 'x',
      text: '',
      topics: [],
      asAgent: false,
      createdAt: 1,
      lang: 'english',
    });
    expect(bogus.tags).toEqual([['title', 'x']]);
  });

  it('asAgent pridá t tag agent práve raz (aj keď je v topics)', () => {
    const withTag = buildNewIdeaTemplate({ title: 'x', text: '', topics: ['agent'], asAgent: true, createdAt: 1 });
    expect(withTag.tags.filter((tag) => tag[1] === 'agent')).toHaveLength(1);
    const plain = buildNewIdeaTemplate({ title: 'x', text: '', topics: [], asAgent: true, createdAt: 1 });
    expect(plain.tags).toContainEqual(['t', 'agent']);
    const human = buildNewIdeaTemplate({ title: 'x', text: '', topics: [], asAgent: false, createdAt: 1 });
    expect(human.tags.some((tag) => tag[1] === 'agent')).toBe(false);
  });

  it('buildClaimTemplate: d = id idey, a = claimant, JSON status claimed', () => {
    const t = buildClaimTemplate({ ideaId: 'a'.repeat(64), claimant: 'b'.repeat(64), note: '  claim  ', createdAt: 42 });
    expect(t.kind).toBe(10030);
    // F4AI-2b2: note je ľudský text → claim dostane NIP-32 label
    expect(t.tags).toEqual([
      ['d', 'a'.repeat(64)],
      ['a', 'b'.repeat(64)],
      ['L', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ]);
    expect(JSON.parse(t.content)).toEqual({ status: 'claimed', note: 'claim' });
    const bare = buildClaimTemplate({ ideaId: 'a'.repeat(64), claimant: 'b'.repeat(64), createdAt: 42 });
    expect(JSON.parse(bare.content)).toEqual({ status: 'claimed' });
    const sk = buildClaimTemplate({
      ideaId: 'a'.repeat(64),
      claimant: 'b'.repeat(64),
      createdAt: 42,
      lang: 'sk',
    });
    expect(sk.tags).toContainEqual(['l', 'sk', 'ISO-639-1']);
  });
});

describe('latestClaimSuggestion — výber claimanta na potvrdenie', () => {
  const s = (id: string, status: string, claimant: string | null, created_at: number) => ({
    id,
    status,
    claimant,
    created_at,
  });

  it('vyberie LWW víťaza claimed návrhov (najvyšší created_at)', () => {
    expect(
      latestClaimSuggestion([
        s('a1', 'claimed', 'p1', 10),
        s('b2', 'claimed', 'p2', 20),
        s('c3', 'in_progress', 'p3', 30),
      ]),
    ).toBe('p2');
  });

  it('pri rovnakom čase vyhráva lexikograficky nižšie id (LWW pravidlo gateway)', () => {
    expect(latestClaimSuggestion([s('b', 'claimed', 'pb', 10), s('a', 'claimed', 'pa', 10)])).toBe('pa');
  });

  it('ignoruje návrhy bez claimanta a iných statusov; prázdne → null', () => {
    expect(latestClaimSuggestion([s('a', 'claimed', null, 30), s('b', 'review', 'p', 20)])).toBeNull();
    expect(latestClaimSuggestion([])).toBeNull();
  });
});
