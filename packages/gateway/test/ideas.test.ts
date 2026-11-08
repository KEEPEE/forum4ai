/**
 * Unit testy ČISTÝCH funkcií idea_call lifecycle (F4AI-16, S10) —
 * `packages/gateway/src/ideas.ts`, bez siete a DB:
 *  - parse 1021 (title z prvého riadku aj z `title` tagu, topics, description)
 *  - parse 10030 (d tag, JSON content, `a` tag claimant, epoch, tolerancia)
 *  - canTransition — MATICA všetkých dvojíc statusov (finálne stavy,
 *    samoprechod, neznáme statusy)
 *  - validácia claimu (`claimed` bez `a` tagu = neúplný claim)
 *  - LWW kanonicita: status = 10030 AUTORA, cudzie = suggestions
 *  - zostavenie boardu + rating agregát (1031/1032) + filtre
 */
import { describe, expect, it } from 'vitest';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

import {
  IDEA_STATUSES,
  UNTITLED_IDEA,
  assembleIdeaBoard,
  assembleIdeaDetail,
  canTransition,
  filterIdeaRows,
  latestStatusPerPublisher,
  parseIdeaCall,
  parseIdeaStatus,
  sortStatusesChronologically,
  validateClaim,
  type IdeaStatus,
  type ParsedIdeaStatus,
} from '../src/ideas.js';

const PK_A = 'a'.repeat(64); // autor 1021
const PK_B = 'b'.repeat(64); // cudí publikujúci 10030 (suggestion)
const PK_C = 'c'.repeat(64); // claimujúci agent
const PK_E = 'e'.repeat(64); // hodnotiteľ 1031

function ev(
  id: string,
  pubkey: string,
  kind: number,
  created_at: number,
  tags: NostrTag[],
  content: string,
): NostrEvent {
  return { id, pubkey, kind, created_at, tags, content, sig: '' };
}

const IDEA_1 = '11'.padEnd(64, '0');
const IDEA_2 = '22'.padEnd(64, '0');
const IDEA_3 = '33'.padEnd(64, '0');
const IDEA_4 = '44'.padEnd(64, '0');
const IDEA_5 = '55'.padEnd(64, '0');
const SOL_1 = 'aa'.padEnd(64, '0');

// ── parseIdeaCall ──────────────────────────────────────────────────────────

describe('parseIdeaCall (1021)', () => {
  it('title = prvý riadok contentu, description = zvyšok', () => {
    const idea = parseIdeaCall(
      ev(IDEA_1, PK_A, KINDS.IDEA_CALL, 1_000, [['t', 'ai/agents']], 'Prvý riadok\nDruhý riadok\nTretí'),
    );
    expect(idea).not.toBeNull();
    expect(idea?.id).toBe(IDEA_1);
    expect(idea?.title).toBe('Prvý riadok');
    expect(idea?.description).toBe('Druhý riadok\nTretí');
    expect(idea?.author).toBe(PK_A);
    expect(idea?.created_at).toBe(1_000);
  });

  it('title tag má prednosť pred prvým riadkom; description = celý content', () => {
    const idea = parseIdeaCall(
      ev(IDEA_1, PK_A, KINDS.IDEA_CALL, 1_000, [['title', 'Nadpis z tagu'], ['t', 'x']], 'telo sem\na ďalšie'),
    );
    expect(idea?.title).toBe('Nadpis z tagu');
    expect(idea?.description).toBe('telo sem\na ďalšie');
  });

  it('prázdny content → fallback title', () => {
    const idea = parseIdeaCall(ev(IDEA_1, PK_A, KINDS.IDEA_CALL, 1_000, [], '   '));
    expect(idea?.title).toBe(UNTITLED_IDEA);
    expect(idea?.description).toBe('');
  });

  it('topics: t-tagy trim, dedup s zachovaním poradia', () => {
    const idea = parseIdeaCall(
      ev(IDEA_1, PK_A, KINDS.IDEA_CALL, 1_000, [
        ['t', 'ai/agents'],
        ['t', '  ai/agents  '],
        ['t', ''],
        ['t', 'lang/rust'],
      ], 'x'),
    );
    expect(idea?.topics).toEqual(['ai/agents', 'lang/rust']);
  });

  it('iný kind → null', () => {
    expect(parseIdeaCall(ev(IDEA_1, PK_A, KINDS.QUESTION, 1_000, [], 'x'))).toBeNull();
    expect(parseIdeaCall(ev(IDEA_1, PK_A, KINDS.POST, 1_000, [], 'x'))).toBeNull();
  });
});

// ── parseIdeaStatus ────────────────────────────────────────────────────────

describe('parseIdeaStatus (10030)', () => {
  it('korektný claim: d tag, JSON status, a tag = claimant, note, epoch', () => {
    const status = parseIdeaStatus(
      ev('s1', PK_A, KINDS.IDEA_CALL_STATUS, 1_010, [
        ['d', IDEA_1],
        ['a', PK_C],
        ['epoch', '42'],
      ], JSON.stringify({ status: 'claimed', note: '  beriem  ' })),
    );
    expect(status).toEqual({
      id: 's1',
      publisher: PK_A,
      idea_id: IDEA_1,
      status: 'claimed',
      claimant: PK_C,
      note: 'beriem',
      epoch: '42',
      created_at: 1_010,
    });
  });

  it('fallback claimant z JSON pola `by` (skica Datovy model kap. 11)', () => {
    const status = parseIdeaStatus(
      ev('s2', PK_A, KINDS.IDEA_CALL_STATUS, 1_010, [['d', IDEA_1]], JSON.stringify({ status: 'claimed', by: PK_C })),
    );
    expect(status?.claimant).toBe(PK_C);
  });

  it('a-tag s ADRESOU (30020:…) nie je claimant', () => {
    const status = parseIdeaStatus(
      ev('s3', PK_A, KINDS.IDEA_CALL_STATUS, 1_010, [
        ['d', IDEA_1],
        ['a', `30020:${PK_B}:ai-agents`],
      ], JSON.stringify({ status: 'in_progress' })),
    );
    expect(status?.claimant).toBeNull();
    expect(status?.status).toBe('in_progress');
  });

  it('chýbajúci/neplatný d tag → null (d viaže na id idea, nie na pubkey)', () => {
    expect(
      parseIdeaStatus(ev('s4', PK_A, KINDS.IDEA_CALL_STATUS, 1_010, [], '{"status":"open"}')),
    ).toBeNull();
    expect(
      parseIdeaStatus(ev('s5', PK_A, KINDS.IDEA_CALL_STATUS, 1_010, [['d', 'slug-penie']], '{"status":"open"}')),
    ).toBeNull();
  });

  it('ne-JSON content, neznámy status, iný kind → null', () => {
    expect(parseIdeaStatus(ev('s6', PK_A, KINDS.IDEA_CALL_STATUS, 1_010, [['d', IDEA_1]], 'claimed'))).toBeNull();
    expect(
      parseIdeaStatus(ev('s7', PK_A, KINDS.IDEA_CALL_STATUS, 1_010, [['d', IDEA_1]], '{"status":"delivered"}')),
    ).toBeNull();
    expect(parseIdeaStatus(ev('s8', PK_A, KINDS.VOTE, 1_010, [['d', IDEA_1]], '{"status":"open"}'))).toBeNull();
  });

  it('epoch z JSON pola, keď chýba tag', () => {
    const status = parseIdeaStatus(
      ev('s9', PK_A, KINDS.IDEA_CALL_STATUS, 1_010, [['d', IDEA_1]], JSON.stringify({ status: 'done', epoch: 7 })),
    );
    expect(status?.epoch).toBe('7');
  });
});

// ── canTransition: matica všetkých dvojíc ──────────────────────────────────

const LEGAL: ReadonlySet<string> = new Set([
  'open>claimed',
  'open>cancelled',
  'claimed>in_progress',
  'claimed>open',
  'claimed>cancelled',
  'in_progress>review',
  'in_progress>cancelled',
  'review>done',
  'review>cancelled',
]);

describe('canTransition — matica 6×6', () => {
  it.each(IDEA_STATUSES.flatMap((from) => IDEA_STATUSES.map((to) => [from, to] as const)))(
    '%s → %s',
    (from, to) => {
      const result = canTransition(from, to);
      expect(result.ok).toBe(LEGAL.has(`${from}>${to}`));
      if (result.ok) expect(result.reason).toBeNull();
      else expect(typeof result.reason).toBe('string');
    },
  );

  it('done a cancelled sú finálne — žiadny prechod okrem žiadneho', () => {
    for (const to of IDEA_STATUSES) {
      expect(canTransition('done', to).ok).toBe(false);
      expect(canTransition('cancelled', to).ok).toBe(false);
    }
    expect(canTransition('done', 'done').reason).toContain('final state');
    expect(canTransition('cancelled', 'open').reason).toContain('final state');
  });

  it('samoprechod nie je hran automatu (LWW obnova sa automatom neriadi)', () => {
    for (const s of IDEA_STATUSES) expect(canTransition(s, s).ok).toBe(false);
  });

  it('neznáme statusy → dôvod', () => {
    expect(canTransition('delivered', 'done').ok).toBe(false);
    expect(canTransition('delivered', 'done').reason).toContain('initial status');
    expect(canTransition('open', 'awarded').reason).toContain('target status');
  });

  it('dôvod nelegálneho prechodu vymenuje legálne susedov', () => {
    const r = canTransition('open', 'done');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('claimed');
    expect(r.reason).toContain('cancelled');
  });
});

// ── validácia claimu ───────────────────────────────────────────────────────

describe('validateClaim', () => {
  function status(over: Partial<ParsedIdeaStatus>): ParsedIdeaStatus {
    return {
      id: 'x',
      publisher: PK_A,
      idea_id: IDEA_1,
      status: 'claimed',
      claimant: null,
      note: null,
      epoch: null,
      created_at: 1,
      ...over,
    };
  }

  it('claimed bez claimanta → neplatný claim s dôvodom', () => {
    const r = validateClaim(status({ claimant: null }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('a tag');
  });

  it('claimed s claimantom → platný', () => {
    expect(validateClaim(status({ claimant: PK_C })).ok).toBe(true);
  });

  it('iné statusy a-tag nevyžadujú', () => {
    for (const s of IDEA_STATUSES.filter((x) => x !== 'claimed')) {
      expect(validateClaim(status({ status: s, claimant: null })).ok).toBe(true);
    }
  });
});

// ── LWW kanonicita ─────────────────────────────────────────────────────────

function parsedStatus(over: Partial<ParsedIdeaStatus>): ParsedIdeaStatus {
  return {
    id: 'x',
    publisher: PK_A,
    idea_id: IDEA_1,
    status: 'open',
    claimant: null,
    note: null,
    epoch: null,
    created_at: 1_000,
    ...over,
  };
}

describe('latestStatusPerPublisher — LWW per publikujúci', () => {
  it('novší created_at vyhráva per publisher', () => {
    const winners = latestStatusPerPublisher([
      parsedStatus({ id: 'old', publisher: PK_A, status: 'open', created_at: 1_000 }),
      parsedStatus({ id: 'new', publisher: PK_A, status: 'claimed', claimant: PK_C, created_at: 1_010 }),
    ]);
    expect(winners.size).toBe(1);
    expect(winners.get(PK_A)?.id).toBe('new');
  });

  it('pri rovnom created_at vyhráva lexikograficky NIŽŠIE id (zhoda s indexerom)', () => {
    const winners = latestStatusPerPublisher([
      parsedStatus({ id: 'ff', publisher: PK_A, status: 'done', created_at: 1_000 }),
      parsedStatus({ id: '00', publisher: PK_A, status: 'open', created_at: 1_000 }),
    ]);
    expect(winners.get(PK_A)?.status).toBe('open');
  });

  it('rôzne pubkey sú nezávislé LWW línie (addr kind:pubkey:d)', () => {
    const winners = latestStatusPerPublisher([
      parsedStatus({ id: 'a1', publisher: PK_A, status: 'claimed', created_at: 1_000 }),
      parsedStatus({ id: 'b1', publisher: PK_B, status: 'done', created_at: 1_001 }),
    ]);
    expect(winners.size).toBe(2);
  });

  it('chronologické triedenie: created_at ASC, id ASC', () => {
    const sorted = sortStatusesChronologically([
      parsedStatus({ id: 'b', created_at: 1_002 }),
      parsedStatus({ id: 'a', created_at: 1_002 }),
      parsedStatus({ id: 'c', created_at: 1_001 }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });
});

// ── board: kanonický status vs suggestions ─────────────────────────────────

describe('assembleIdeaBoard — ROZHODNUTIE MANAŽERA (kanonický = 10030 autora)', () => {
  const idea1 = ev(IDEA_1, PK_A, KINDS.IDEA_CALL, 1_000, [['t', 'ai/agents']], 'Prva idea\npopis');
  const idea2 = ev(IDEA_2, PK_B, KINDS.IDEA_CALL, 1_001, [['t', 'lang/rust']], 'Druha idea');
  const idea3 = ev(IDEA_3, PK_A, KINDS.IDEA_CALL, 1_002, [], 'Tretia idea');

  it('idea bez 10030 → status open, prázdna história', () => {
    const rows = assembleIdeaBoard({ ideas: [idea1], statuses: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('open');
    expect(rows[0]?.claimant).toBeNull();
    expect(rows[0]?.status_history).toEqual([]);
    expect(rows[0]?.suggestions_count).toBe(0);
    expect(rows[0]?.rating).toBeNull();
  });

  it('status publikuje autor → kanonický; cudzí 10030 je suggestion', () => {
    const rows = assembleIdeaBoard({
      ideas: [idea1],
      statuses: [
        // cudzí pubkey tvrdí done — NIE je to status
        ev('s-foreign', PK_B, KINDS.IDEA_CALL_STATUS, 1_020, [['d', IDEA_1]], '{"status":"done"}'),
        // autor tvrdí claimed s a-tagom → kanonický
        ev('s-own', PK_A, KINDS.IDEA_CALL_STATUS, 1_010, [['d', IDEA_1], ['a', PK_C]], '{"status":"claimed"}'),
      ],
    });
    expect(rows[0]?.status).toBe('claimed');
    expect(rows[0]?.claimant).toBe(PK_C);
    expect(rows[0]?.suggestions_count).toBe(1);
    expect(rows[0]?.status_history).toHaveLength(1);
    expect(rows[0]?.status_history[0]?.id).toBe('s-own');
  });

  it('LWW per autor: novší status autora vyhráva, história triedená created_at ASC', () => {
    const rows = assembleIdeaBoard({
      ideas: [idea1],
      statuses: [
        ev('s-old', PK_A, KINDS.IDEA_CALL_STATUS, 1_005, [['d', IDEA_1]], '{"status":"open"}'),
        ev('s-new', PK_A, KINDS.IDEA_CALL_STATUS, 1_015, [['d', IDEA_1], ['a', PK_C]], '{"status":"claimed"}'),
      ],
    });
    expect(rows[0]?.status).toBe('claimed');
    expect(rows[0]?.status_history.map((h) => h.id)).toEqual(['s-old', 's-new']);
  });

  it('cudzí LWW: dva 10030 toho istého cudzieho pubkey = 1 suggestion', () => {
    const rows = assembleIdeaBoard({
      ideas: [idea1],
      statuses: [
        ev('f1', PK_B, KINDS.IDEA_CALL_STATUS, 1_005, [['d', IDEA_1]], '{"status":"in_progress"}'),
        ev('f2', PK_B, KINDS.IDEA_CALL_STATUS, 1_015, [['d', IDEA_1]], '{"status":"done"}'),
      ],
    });
    expect(rows[0]?.suggestions_count).toBe(1);
  });

  it('10030 pre neznámy idea id sa ignoruje', () => {
    const rows = assembleIdeaBoard({
      ideas: [idea1],
      statuses: [ev('s-x', PK_B, KINDS.IDEA_CALL_STATUS, 1_005, [['d', IDEA_4]], '{"status":"done"}')],
    });
    expect(rows[0]?.suggestions_count).toBe(0);
  });

  it('rating agregát: 1031 s root na idea + 1032 → accepted flag', () => {
    const rows = assembleIdeaBoard({
      ideas: [idea1],
      statuses: [],
      ratings: [
        ev('r1', PK_E, KINDS.SOLUTION_RATING, 1_030, [
          ['e', SOL_1, ''],
          ['e', IDEA_1, 'root'],
        ], '{"score":4}'),
      ],
      accepted: [
        ev('acc1', PK_A, KINDS.ACCEPTED_SOLUTION, 1_040, [
          ['e', SOL_1, ''],
          ['e', IDEA_1, 'root'],
        ], ''),
      ],
    });
    expect(rows[0]?.rating).not.toBeNull();
    expect(rows[0]?.rating?.count).toBe(1);
    expect(rows[0]?.rating?.accepted).toBe(true);
    expect(rows[0]?.rating?.accepted_count).toBe(1);
  });

  it('board triedí created_at DESC, id ASC (total order)', () => {
    const rows = assembleIdeaBoard({ ideas: [idea1, idea3, idea2], statuses: [] });
    expect(rows.map((r) => r.id)).toEqual([IDEA_3, IDEA_2, IDEA_1]);
  });

  it('nečitateľný 10030 (neznámy status) kanonický stav nepreruší', () => {
    const rows = assembleIdeaBoard({
      ideas: [idea1],
      statuses: [
        ev('s-good', PK_A, KINDS.IDEA_CALL_STATUS, 1_005, [['d', IDEA_1]], '{"status":"claimed","by":"' + PK_C + '"}'),
        ev('s-bad', PK_A, KINDS.IDEA_CALL_STATUS, 1_015, [['d', IDEA_1]], '{"status":"delivered"}'),
      ],
    });
    // s-bad nie je čitateľný → LWW víťaz je s-good
    expect(rows[0]?.status).toBe('claimed');
  });

  // ── regression A10 ───────────────────────────────────────────────────────

  it('história …→done→open: finálny done pinuje, neskorší open sa preskočí', () => {
    const rows = assembleIdeaBoard({
      ideas: [idea1],
      statuses: [
        ev('h1', PK_A, KINDS.IDEA_CALL_STATUS, 1_005, [['d', IDEA_1], ['a', PK_C]], '{"status":"claimed"}'),
        ev('h2', PK_A, KINDS.IDEA_CALL_STATUS, 1_015, [['d', IDEA_1]], '{"status":"in_progress"}'),
        ev('h3', PK_A, KINDS.IDEA_CALL_STATUS, 1_025, [['d', IDEA_1]], '{"status":"review"}'),
        ev('h4', PK_A, KINDS.IDEA_CALL_STATUS, 1_035, [['d', IDEA_1]], '{"status":"done"}'),
        // junk s budúcim created_at: done → open nie je v automate
        ev('h5', PK_A, KINDS.IDEA_CALL_STATUS, 9_999, [['d', IDEA_1]], '{"status":"open"}'),
      ],
    });
    // surový LWW winner by bol h5 ('open'); replay drží finálny 'done'
    expect(rows[0]?.status).toBe('done');
    // história ostáva kompletná (raw záznam), mení sa len kanonický status
    expect(rows[0]?.status_history.map((h) => h.id)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
  });

  it('claimed bez a/by tagu sa do kanonickej línie nepočíta', () => {
    const rows = assembleIdeaBoard({
      ideas: [idea1],
      statuses: [
        // neuplny claim (zadanie vyzaduje a-tag/`by`) → preskoci
        ev('c-bad', PK_A, KINDS.IDEA_CALL_STATUS, 1_005, [['d', IDEA_1]], '{"status":"claimed"}'),
        ev('c-ok', PK_A, KINDS.IDEA_CALL_STATUS, 1_015, [['d', IDEA_1], ['a', PK_C]], '{"status":"claimed"}'),
      ],
    });
    expect(rows[0]?.status).toBe('claimed');
    expect(rows[0]?.claimant).toBe(PK_C);
  });

  it('súbor statusov bez a-tagu: claimed nefarmuje claimant z nicoty', () => {
    const rows = assembleIdeaBoard({
      ideas: [idea1],
      statuses: [
        ev('c-only', PK_A, KINDS.IDEA_CALL_STATUS, 1_005, [['d', IDEA_1]], '{"status":"claimed"}'),
      ],
    });
    // jediny neuplny claim → ziadny kanonicky status → implicitny open
    expect(rows[0]?.status).toBe('open');
    expect(rows[0]?.claimant).toBeNull();
  });
});

describe('assembleIdeaDetail', () => {
  it('suggestions sú LWW víťazi cudzích pubkey, chronologicky', () => {
    const idea = ev(IDEA_5, PK_A, KINDS.IDEA_CALL, 1_000, [], 'Detail idea');
    const detail = assembleIdeaDetail(idea, [
      ev('f-new', PK_B, KINDS.IDEA_CALL_STATUS, 1_020, [['d', IDEA_5]], '{"status":"done"}'),
      ev('f-old', PK_B, KINDS.IDEA_CALL_STATUS, 1_010, [['d', IDEA_5]], '{"status":"in_progress"}'),
      ev('f-c', PK_C, KINDS.IDEA_CALL_STATUS, 1_015, [['d', IDEA_5]], '{"status":"review"}'),
    ]);
    expect(detail).not.toBeNull();
    expect(detail?.status).toBe('open'); // autor nič nepublikoval
    expect(detail?.suggestions.map((s) => s.id)).toEqual(['f-c', 'f-new']); // LWW per PK_B + chrono
    expect(detail?.suggestions_count).toBe(2);
  });

  it('iný kind ako 1021 → null', () => {
    expect(assembleIdeaDetail(ev(IDEA_5, PK_A, KINDS.QUESTION, 1_000, [], 'x'), [])).toBeNull();
  });
});

// ── filtre ─────────────────────────────────────────────────────────────────

describe('filterIdeaRows', () => {
  const rows = assembleIdeaBoard({
    ideas: [
      ev(IDEA_1, PK_A, KINDS.IDEA_CALL, 1_000, [['t', 'AI/Agents']], 'A'),
      ev(IDEA_2, PK_B, KINDS.IDEA_CALL, 1_010, [['t', 'lang/rust']], 'B'),
      ev(IDEA_3, PK_A, KINDS.IDEA_CALL, 1_020, [], 'C'),
    ],
    statuses: [
      ev('s1', PK_B, KINDS.IDEA_CALL_STATUS, 1_030, [['d', IDEA_2], ['a', PK_C]], '{"status":"claimed"}'),
    ],
  });

  it('status=open chytí aj implicitne otvorené (bez 10030)', () => {
    const open = filterIdeaRows(rows, { status: 'open' });
    expect(open.map((r) => r.id)).toEqual([IDEA_3, IDEA_1]);
  });

  it('status=claimed → len kanonicky claimnutá', () => {
    expect(filterIdeaRows(rows, { status: 'claimed' }).map((r) => r.id)).toEqual([IDEA_2]);
  });

  it('topic je case-insensitive presná zhoda', () => {
    expect(filterIdeaRows(rows, { topic: 'ai/agents' }).map((r) => r.id)).toEqual([IDEA_1]);
    expect(filterIdeaRows(rows, { topic: 'lang/rust' }).map((r) => r.id)).toEqual([IDEA_2]);
    expect(filterIdeaRows(rows, { topic: 'ai' })).toHaveLength(0);
  });

  it('since filtruje created_at idea', () => {
    expect(filterIdeaRows(rows, { since: 1_010 }).map((r) => r.id)).toEqual([IDEA_3, IDEA_2]);
  });

  // regression B2: server-side author filter (UI ho predtým robilo lokálne
  // po limit=100, takže obmedzenie ticho mizalo)
  it('author filtruje podľa pubkey autora (case-insensitive)', () => {
    expect(filterIdeaRows(rows, { author: PK_A }).map((r) => r.id)).toEqual([IDEA_3, IDEA_1]);
    expect(filterIdeaRows(rows, { author: PK_A.toUpperCase() }).map((r) => r.id)).toEqual([
      IDEA_3,
      IDEA_1,
    ]);
    expect(filterIdeaRows(rows, { author: PK_B }).map((r) => r.id)).toEqual([IDEA_2]);
    expect(filterIdeaRows(rows, { author: 'f'.repeat(64) })).toHaveLength(0);
    // AND s ostatnými
    expect(filterIdeaRows(rows, { author: PK_A, topic: 'ai/agents' }).map((r) => r.id)).toEqual([
      IDEA_1,
    ]);
  });

  it('kombinácia filtrov (AND)', () => {
    expect(filterIdeaRows(rows, { status: 'open', topic: 'AI/AGENTS' }).map((r) => r.id)).toEqual([IDEA_1]);
  });

  it('matica statusov je presne automatových 6', () => {
    const expected: IdeaStatus[] = ['open', 'claimed', 'in_progress', 'review', 'done', 'cancelled'];
    expect([...IDEA_STATUSES]).toEqual(expected);
  });
});
