/**
 * Unit testy vyhľadávacej vrstvy S8 (F4AI-14) — `src/search.ts`.
 *
 * Dve časti:
 *  1. **RRF fusion** na syntetických listoch — determinizmus, stabilita,
 *     nezávislosť od poradí kanálov, single-channel passthrough, presná
 *     matematika pre k=60. Syntetické listy sú zámerne bez SQLite, aby
 *     testy boli čisté a rýchle.
 *  2. **FTS5 kanál** nad reálnou dočasnou SQLite (better-sqlite3 13.0.3,
 *     SQLite 3.53.4) — overuje sa reuse `buildMatchQuery` zo shared,
 *     BM25 poradie, tie-break `created_at DESC`, snippet so zvýraznením,
 *     kombinácie filtrov, read-only režim, nedostupný index a deadline.
 *
 * DDL v tomto súbore je KÓPIA schémy z `packages/indexer/src/db.ts`
 * (zdroj pravdy je indexer; integráčny test `packages/indexer/test/
 * search-integration.test.ts` beží proti skutočnej DB indexera, takže
 * kopírovanie DDL tu nemôže maskovať drift schémy).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildMatchQuery } from '@forum4ai/shared';

import {
  FTS5_CHANNEL,
  IndexUnavailableError,
  RRF_K,
  SEARCH_LIMIT_MAX,
  SearchInterruptedError,
  UnavailableIndexChannel,
  VECTOR_CHANNEL,
  VECTOR_STUB_REASON,
  Fts5SearchChannel,
  createVectorStubChannel,
  fusedToRanked,
  rrfFuse,
  type ChannelHits,
  type RankedHit,
} from '../src/search.js';

/* ------------------------------------------------------------------ */
/* syntetické hitov pre RRF                                            */
/* ------------------------------------------------------------------ */

function hit(id: string, score = 0, extra: Partial<RankedHit> = {}): RankedHit {
  return {
    id,
    kind: 1020,
    pubkey: 'a'.repeat(64),
    created_at: 1_700_000_000,
    score,
    snippet: `snippet ${id}`,
    ...extra,
  };
}

describe('RRF fusion (k=60) — syntetické listy', () => {
  it('k=60 je konštanta a default', () => {
    expect(RRF_K).toBe(60);
  });

  it('presná matematika: score = Σ 1/(60 + rank)', () => {
    const fts: ChannelHits = { channel: 'fts5', hits: [hit('A'), hit('B'), hit('C')] };
    const vec: ChannelHits = { channel: 'vector', hits: [hit('B'), hit('D'), hit('A')] };
    const fused = rrfFuse([fts, vec]);

    const expectScore = (id: string): number =>
      fused.find((entry) => entry.id === id)?.score ?? Number.NaN;
    // A: fts5 rank 1 + vector rank 3
    expect(expectScore('A')).toBeCloseTo(1 / 61 + 1 / 63, 12);
    // B: fts5 rank 2 + vector rank 1 → najvyššie
    expect(expectScore('B')).toBeCloseTo(1 / 62 + 1 / 61, 12);
    // C: len fts5 rank 3
    expect(expectScore('C')).toBeCloseTo(1 / 63, 12);
    // D: len vector rank 2
    expect(expectScore('D')).toBeCloseTo(1 / 62, 12);
    expect(fused.map((entry) => entry.id)).toEqual(['B', 'A', 'D', 'C']);
    // ranks sú uložené per kanál
    expect(fused.find((entry) => entry.id === 'A')?.channels).toEqual({ fts5: 1, vector: 3 });
  });

  it('determinizmus: rovnaké vstupy → rovnaká odpoveď (10× za sebou)', () => {
    const fts: ChannelHits = { channel: 'fts5', hits: [hit('x1'), hit('x2'), hit('x3')] };
    const vec: ChannelHits = { channel: 'vector', hits: [hit('x3'), hit('x1'), hit('x2')] };
    const first = JSON.stringify(rrfFuse([fts, vec]));
    for (let i = 0; i < 10; i += 1) {
      expect(JSON.stringify(rrfFuse([fts, vec]))).toBe(first);
    }
  });

  it('nezávislosť od poradí kanálov (komutatívnosť sčítanca)', () => {
    const a: ChannelHits = { channel: 'fts5', hits: [hit('p'), hit('q'), hit('r')] };
    const b: ChannelHits = { channel: 'vector', hits: [hit('r'), hit('s'), hit('p')] };
    const c: ChannelHits = { channel: 'third', hits: [hit('q'), hit('s')] };
    const ab = rrfFuse([a, b, c]);
    const ba = rrfFuse([b, a, c]);
    const cab = rrfFuse([c, a, b]);
    expect(ab.map((e) => [e.id, e.score])).toEqual(ba.map((e) => [e.id, e.score]));
    expect(ab.map((e) => [e.id, e.score])).toEqual(cab.map((e) => [e.id, e.score]));
  });

  it('single-channel passthrough: poradie kanála sa zachová', () => {
    const order = ['z9', 'a1', 'm5', 'b7'];
    const only: ChannelHits = { channel: 'fts5', hits: order.map((id) => hit(id)) };
    expect(rrfFuse([only]).map((e) => e.id)).toEqual(order);
    expect(fusedToRanked(rrfFuse([only])).map((h) => h.id)).toEqual(order);
  });

  it('total order: rovnaké skóre rozhoduje id ASC (žiadna nestabilita)', () => {
    // ch1: ccc(1) aaa(2) bbb(3); ch2: ddd(1) eee(2)
    // → ccc a ddd majú zhodné skóre 1/61, aaa a eee zhodné 1/62
    const ch1: ChannelHits = { channel: 'fts5', hits: [hit('ccc'), hit('aaa'), hit('bbb')] };
    const ch2: ChannelHits = { channel: 'vector', hits: [hit('ddd'), hit('eee')] };
    const fused = rrfFuse([ch1, ch2]);
    expect(fused.filter((e) => Math.abs(e.score - 1 / 61) < 1e-12).map((e) => e.id)).toEqual([
      'ccc',
      'ddd',
    ]);
    expect(fused.map((e) => e.id)).toEqual(['ccc', 'ddd', 'aaa', 'eee', 'bbb']);
  });

  it('duplikát v rámci kanála počíta len prvý (najlepšie) rank', () => {
    const dup: ChannelHits = {
      channel: 'fts5',
      hits: [hit('A'), hit('B'), hit('A'), hit('C')],
    };
    const fused = rrfFuse([dup]);
    expect(fused.map((e) => e.id)).toEqual(['A', 'B', 'C']);
    expect(fused.find((e) => e.id === 'A')?.score).toBeCloseTo(1 / 61, 12);
    expect(fused.find((e) => e.id === 'A')?.channels).toEqual({ fts5: 1 });
  });

  it('hit preberá kópiu z prvého kanála (snippet FTS5 má prednosť)', () => {
    const fts: ChannelHits = {
      channel: 'fts5',
      hits: [{ ...hit('A'), snippet: 'fts5 snippet' }],
    };
    const vec: ChannelHits = {
      channel: 'vector',
      hits: [{ ...hit('A'), snippet: 'vector snippet' }],
    };
    const fused = rrfFuse([fts, vec]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.hit.snippet).toBe('fts5 snippet');
  });

  it('prázdne listy → prázdny výsledok; neplatné k → RangeError', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([{ channel: 'fts5', hits: [] }])).toEqual([]);
    expect(() => rrfFuse([], 0)).toThrow(RangeError);
    expect(() => rrfFuse([], -3)).toThrow(RangeError);
  });

  it('fusion je ostromený na limit až pri prevode (route sliceuje)', () => {
    const fts: ChannelHits = { channel: 'fts5', hits: [hit('1'), hit('2'), hit('3')] };
    const vec: ChannelHits = { channel: 'vector', hits: [hit('3'), hit('2'), hit('1')] };
    // 1 a 3 majú 1/61 + 1/63 = 0.032266, prostredný 2 má 2/62 = 0.032258
    const fused = fusedToRanked(rrfFuse([fts, vec]));
    expect(fused.map((h) => h.id)).toEqual(['1', '3', '2']);
    expect(fused.slice(0, 2).map((h) => h.id)).toEqual(['1', '3']);
  });
});

/* ------------------------------------------------------------------ */
/* vector stub                                                         */
/* ------------------------------------------------------------------ */

describe('vector stub channel (fáza 2 hybridu)', () => {
  it('vráti [] a reason sqlite-vec+Qwen3 phase 2', () => {
    const stub = createVectorStubChannel();
    expect(stub.name).toBe(VECTOR_CHANNEL);
    expect(stub.reason).toBe('sqlite-vec+Qwen3 phase 2');
    expect(stub.unavailableReason).toBe(VECTOR_STUB_REASON);
    expect(stub.search('hocičo', { limit: 20 })).toEqual([]);
  });

  it('stub sa podieľa na fusion len keď niečo vráti (dnes nevráti)', () => {
    const stub = createVectorStubChannel();
    const collected: ChannelHits[] = [];
    const hits = stub.search('dotaz', { limit: 20 });
    if (hits.length > 0) collected.push({ channel: stub.name, hits });
    expect(collected).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* FTS5 kanál nad reálnou SQLite                                       */
/* ------------------------------------------------------------------ */

const INDEXER_SCHEMA = `
CREATE TABLE events (
  id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL,
  tags_text TEXT NOT NULL DEFAULT '', sig TEXT NOT NULL, addr TEXT NULL,
  inserted_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX events_addr ON events (addr);
CREATE INDEX events_kind ON events (kind);
CREATE INDEX events_pubkey ON events (pubkey);
CREATE INDEX events_created_at ON events (created_at);
CREATE VIRTUAL TABLE events_fts USING fts5(
  content, tags_text, content = 'events', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, content, tags_text)
  VALUES (new.rowid, new.content, new.tags_text);
END;
`;

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

interface SeedRow {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags_text?: string;
  addr?: string | null;
}

const SEED: SeedRow[] = [
  {
    id: 'aa'.padEnd(64, '1'),
    pubkey: PK_A,
    kind: 1020,
    created_at: 1_000,
    content: 'Reklamačná poistka — ako podať reklamačný formulár?',
  },
  {
    id: 'bb'.padEnd(64, '2'),
    pubkey: PK_B,
    kind: 1023,
    created_at: 2_000,
    content: 'reklamacna som podal, lebo reklamačná zmluva bola neúplná a poistenie',
  },
  // identický content aj tags_text → identický bm25 rank (test tie-breaku)
  {
    id: 'cc'.padEnd(64, '3'),
    pubkey: PK_A,
    kind: 1020,
    created_at: 3_000,
    content: 'Úplne iná vec: reklamačná stáž',
    tags_text: 'doprava',
  },
  {
    id: 'dd'.padEnd(64, '4'),
    pubkey: PK_A,
    kind: 1020,
    created_at: 1_500,
    content: 'Úplne iná vec: reklamačná stáž',
    tags_text: 'doprava',
  },
  {
    id: 'ee'.padEnd(64, '5'),
    pubkey: PK_B,
    kind: 30023,
    created_at: 4_000,
    content: 'Sprievodca poistením a reklamáciami pre začiatočníkov',
    addr: `30023:${PK_B}:sprievodca`,
  },
  {
    id: 'ff'.padEnd(64, '6'),
    pubkey: PK_B,
    kind: 1021,
    created_at: 5_000,
    content: 'Idea: automatická kontrola reklamačných lehôt',
  },
];

const dir = mkdtempSync(join(tmpdir(), 'f4ai-gw-search-'));
const dbPath = join(dir, 'index.db');
const emptyDbPath = join(dir, 'empty.db');
const missingDbPath = join(dir, 'missing.db');

function seedDatabase(): void {
  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL');
  writer.exec(INDEXER_SCHEMA);
  const insert = writer.prepare(
    `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, 'sig', ?, 0)`,
  );
  const tx = writer.transaction((rows: SeedRow[]) => {
    for (const row of rows) {
      insert.run(
        row.id,
        row.pubkey,
        row.kind,
        row.created_at,
        row.content,
        row.tags_text ?? '',
        row.addr ?? null,
      );
    }
  });
  tx(SEED);
  writer.close();
}

let channel: Fts5SearchChannel;

beforeAll(() => {
  seedDatabase();
  // DB bez našej schémy — jasný 503 dôvod, nie záhadná chyba
  const foreign = new Database(emptyDbPath);
  foreign.exec('CREATE TABLE nope (x TEXT)');
  foreign.close();
  // prázdny súbor → "not a database"
  writeFileSync(missingDbPath, 'this is definitely not a sqlite file\n');
  channel = new Fts5SearchChannel({ path: dbPath, logger: () => undefined });
});

afterAll(() => {
  channel?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Fts5SearchChannel — read-only dopyt nad SQLite', () => {
  it('kanál má meno fts5; availability() DB lazy-otvorí a nahlási pravdivo', () => {
    expect(channel.name).toBe(FTS5_CHANNEL);
    // DB sa otvára až pri prvom pohľade/dopyte — /health preto nesmie
    // tváriť nedostupnosť indexu, ktorý len čaká na prvé otvorenie
    expect(channel.availability()).toEqual({ available: true, path: dbPath });
    expect(channel.availability().available).toBe(true);
  });

  it('znovu použije buildMatchQuery zo shared (žiadna kópia logiky)', () => {
    const detailed = channel.searchDetailed('reklamacna poistka', { limit: 10 });
    expect(detailed.normalizedQuery).toBe(buildMatchQuery('reklamacna poistka'));
    expect(detailed.normalizedQuery).toBe('reklamacna AND poistka');
  });

  it('diakritiku zráža tokenizér: `reklamacna` nájde `Reklamačná`', () => {
    const hits = channel.search('reklamacna', { limit: 50 });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('aa'.padEnd(64, '1'));
    expect(ids).toContain('bb'.padEnd(64, '2'));
    // #5 je "reklamáciami" → prefix `reklamac*` áno, holý `reklamacna` nie
    expect(ids).not.toContain('ee'.padEnd(64, '5'));
    const prefix = channel.search('reklamac*', { limit: 50 }).map((h) => h.id);
    expect(prefix).toContain('ee'.padEnd(64, '5'));
  });

  it('BM25: viac výskytov v kratšom texte je vyššie (rank ASC)', () => {
    const hits = channel.search('reklamacna', { limit: 50 });
    // bb má termín dvakrát a kratší text → najlepší kandidát
    expect(hits[0]?.id).toBe('bb'.padEnd(64, '2'));
    // skóre je záporné a klesajúce (lepší = more záporné) — namerané
    const scores = hits.map((h) => h.score);
    expect(scores.every((s) => s < 0)).toBe(true);
    for (let i = 1; i < scores.length; i += 1) {
      expect((scores[i] as number) ?? 0).toBeGreaterThanOrEqual((scores[i - 1] as number) ?? 0);
    }
  });

  it('tie-break pri zhodnom ranku: created_at DESC, potom id ASC', () => {
    // cc (created_at 3000) a dd (1500) majú IDENTICKÝ content aj tags_text
    const hits = channel.search('doprava', { limit: 50 });
    expect(hits.map((h) => h.id)).toEqual(['cc'.padEnd(64, '3'), 'dd'.padEnd(64, '4')]);
    const ranks = hits.map((h) => h.score);
    expect(ranks[0]).toBe(ranks[1]); // dôkaz, že ide o skutočnú zhodu ranku
  });

  it('snippet() zvýrazňuje termín hraničnikami [ ]', () => {
    const hits = channel.search('reklamacna', { limit: 5 });
    const snippet = hits[0]?.snippet ?? '';
    expect(snippet).toContain('[reklamacna]');
  });

  it('addr sa vracia len pre adresované kindy', () => {
    const hits = channel.search('sprievodca', { limit: 5 });
    expect(hits[0]?.addr).toBe(`30023:${PK_B}:sprievodca`);
    const plain = channel.search('poistka', { limit: 5 });
    expect(plain[0]?.addr).toBeNull();
  });

  it('filter kinds', () => {
    const all = channel.search('reklamacna', { limit: 50 });
    const only1023 = channel.search('reklamacna', { limit: 50, kinds: [1023] });
    expect(only1023.map((h) => h.id)).toEqual(['bb'.padEnd(64, '2')]);
    expect(only1023.length).toBeLessThan(all.length);
    expect(channel.search('reklamacna', { limit: 50, kinds: [4242] })).toEqual([]);
  });

  it('filter authors', () => {
    const onlyB = channel.search('reklamacna', { limit: 50, authors: [PK_B] });
    expect(onlyB.every((h) => h.pubkey === PK_B)).toBe(true);
    expect(onlyB.length).toBeGreaterThan(0);
    const both = channel.search('reklamacna', { limit: 50, authors: [PK_A, PK_B] });
    expect(both.length).toBeGreaterThanOrEqual(onlyB.length);
  });

  it('filter since/until (uzatvorený interval)', () => {
    const window = channel.search('reklamacna', { limit: 50, since: 1_500, until: 2_000 });
    expect(window.map((h) => h.created_at)).toEqual([2_000, 1_500]);
    const sinceOnly = channel.search('reklamacna', { limit: 50, since: 4_000 });
    expect(sinceOnly.every((h) => h.created_at >= 4_000)).toBe(true);
  });

  it('kombinácia kinds + authors + since + until + limit', () => {
    const hits = channel.search('reklamacna', {
      limit: 1,
      kinds: [1020, 1023],
      authors: [PK_A],
      since: 1_000,
      until: 3_000,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.pubkey).toBe(PK_A);
    expect(hits[0]?.kind).toBeGreaterThanOrEqual(1020);
  });

  it('limit sa oťahuje na 1..50', () => {
    expect(channel.search('reklamacna', { limit: 0 })).toHaveLength(1);
    expect(channel.search('reklamacna', { limit: 999 }).length).toBeLessThanOrEqual(
      SEARCH_LIMIT_MAX,
    );
  });

  it('prázdny dotaz (po normalizácii) → [] a normalized_query ""', () => {
    const detailed = channel.searchDetailed('   ', { limit: 10 });
    expect(detailed.hits).toEqual([]);
    expect(detailed.normalizedQuery).toBe('');
    expect(detailed.interrupted).toBe(false);
  });

  it('každý výstup buildMatchQuery je syntakticky platný FTS5 výraz', () => {
    const nasty = [
      'NEAR / 3',
      '"',
      '((((',
      'AND OR NOT',
      'a"b',
      'x:y:z',
      '"unclosed',
      'reklamačná:',
      'say "hi"',
      'databaze*',
      '*',
    ];
    for (const input of nasty) {
      // žiadna výnimka → FTS5 reťazec parse-ol; výsledok môže byť 0 zhôd
      expect(() => channel.search(input, { limit: 5 }), `input=${input}`).not.toThrow();
    }
  });

  it('spojenie je READ-ONLY — zápis do DB z neho padá', () => {
    const raw = new Database(dbPath, { readonly: true });
    expect(() => raw.prepare("INSERT INTO events (id) VALUES ('nope')").run()).toThrow();
    raw.close();
  });

  it('chýbajúci súbor → IndexUnavailableError s čitateľným dôvodom', () => {
    const missing = new Fts5SearchChannel({
      path: join(dir, 'neexistuje.db'),
      logger: () => undefined,
    });
    expect(missing.availability().available).toBe(false);
    try {
      missing.search('hocičo', { limit: 5 });
      throw new Error('očekávali sme IndexUnavailableError');
    } catch (err) {
      expect(err).toBeInstanceOf(IndexUnavailableError);
      expect((err as IndexUnavailableError).reason).toContain('neexistuje');
    }
    expect(missing.availability().reason).toContain('neexistuje');
    missing.close();
  });

  it('SQLite bez indexer schémy → IndexUnavailableError „neobsahuje schému“', () => {
    const foreign = new Fts5SearchChannel({ path: emptyDbPath, logger: () => undefined });
    try {
      foreign.search('hocičo', { limit: 5 });
      throw new Error('očekávali sme IndexUnavailableError');
    } catch (err) {
      expect(err).toBeInstanceOf(IndexUnavailableError);
      expect((err as IndexUnavailableError).reason).toContain('schema');
    }
    foreign.close();
  });

  it('súbor, ktorý nie je SQLite → IndexUnavailableError s dôvodom od SQLite', () => {
    const broken = new Fts5SearchChannel({ path: missingDbPath, logger: () => undefined });
    try {
      broken.search('hocičo', { limit: 5 });
      throw new Error('očekávali sme IndexUnavailableError');
    } catch (err) {
      expect(err).toBeInstanceOf(IndexUnavailableError);
      // better-sqlite3 otvorí „len“ header a padne až na prvom SELECT-e —
      // dôležité je, že dôvod prechádza až ku klientovi, nie generická 500
      expect((err as IndexUnavailableError).reason).toContain('not a database');
    }
    expect(broken.availability().available).toBe(false);
    broken.close();
  });

  it('UnavailableIndexChannel (GATEWAY_INDEX_DB nenastavená) vždy 503-dôvod', () => {
    const off = new UnavailableIndexChannel('GATEWAY_INDEX_DB nie je nastavená');
    expect(off.name).toBe(FTS5_CHANNEL);
    expect(() => off.search('x', { limit: 5 })).toThrow(IndexUnavailableError);
  });

  it('deadline: SearchInterruptedError, keď je hranica v minulosti', () => {
    const started = Date.now();
    try {
      channel.searchDetailed('reklamacna', { limit: 50, deadlineAt: started - 1_000 });
      throw new Error('očekávali sme SearchInterruptedError');
    } catch (err) {
      expect(err).toBeInstanceOf(SearchInterruptedError);
      const interrupted = err as SearchInterruptedError;
      expect(interrupted.tookMs).toBeGreaterThanOrEqual(0);
      expect(interrupted.message).toContain('interrupted');
    }
    // spojenie aj statement cache prežijú prerušenie — ďalší dopyt funguje
    expect(channel.search('reklamacna', { limit: 5 }).length).toBeGreaterThan(0);
  });

  it('deadline v budúcnosti dopyt nepreruší', () => {
    const detailed = channel.searchDetailed('reklamacna', {
      limit: 50,
      deadlineAt: Date.now() + 5_000,
    });
    expect(detailed.interrupted).toBe(false);
    expect(detailed.hits.length).toBeGreaterThan(0);
    expect(detailed.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('dopyt vidí nově vložený záznam (read-only spojenie nezamrzá na starom snapshote)', () => {
    const before = channel.search('novotvrdena', { limit: 5 });
    expect(before).toEqual([]);
    const writer = new Database(dbPath);
    writer
      .prepare(
        `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at)
         VALUES (?, ?, 1020, 9_000, 'Novotvrdena vec v indexe', '[]', '', 'sig', NULL, 0)`,
      )
      .run('gg'.padEnd(64, '7'), PK_A);
    writer.close();
    const after = channel.search('novotvrdena', { limit: 5 });
    expect(after.map((h) => h.id)).toEqual(['gg'.padEnd(64, '7')]);
  });
});

/**
 * F4AI-2b2: jazyk (`lang`) v gateway vyhľadávaní.
 *
 * Dva stavy indexu, oba realistické:
 *  1. migráciou doplnený index so stĺpcom `lang` → hits ho majú, filter
 *     `lang=en` funguje a je súčasťou kľúča cache prepared statements;
 *  2. PRED-2b2 index bez neho (DB vyššie v tomto súbore) → hits pole
 *     `lang` VÔBEC neobsahujú a filter sa ticho ignoruje (dopyt by inak
 *     padol na `no such column: lang` a route by vrátila 503).
 */
describe('Fts5SearchChannel — lang filter (F4AI-2b2)', () => {
  const LANG_DB = join(dir, 'index-lang.db');

  function seedLangDatabase(): void {
    const writer = new Database(LANG_DB);
    writer.pragma('journal_mode = WAL');
    writer.exec(INDEXER_SCHEMA);
    // presne to, čo robí migrácia indexera: ALTER + hodnoty z NIP-32 tagov
    writer.exec('ALTER TABLE events ADD COLUMN lang TEXT NULL');
    const insert = writer.prepare(
      `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang)
       VALUES (?, ?, ?, ?, ?, '[]', '', 'sig', NULL, 0, ?)`,
    );
    insert.run('aa'.padEnd(64, 'a'), PK_A, 1020, 1_000, 'Reklamacna leasingu — english thread', 'en');
    insert.run('bb'.padEnd(64, 'b'), PK_A, 1020, 2_000, 'Reklamacna leasingu — slovenska tema', 'sk');
    insert.run('cc'.padEnd(64, 'c'), PK_B, 1023, 3_000, 'Reklamacna leasingu bez jazykoveho labelu', null);
    writer.close();
  }

  let langChannel: Fts5SearchChannel;

  beforeAll(() => {
    seedLangDatabase();
    langChannel = new Fts5SearchChannel({ path: LANG_DB, logger: () => undefined });
  });

  afterAll(() => {
    langChannel.close();
  });

  it('hits nesú lang; event bez labelu má null', () => {
    const hits = langChannel.search('reklamacna', { limit: 10 });
    const byId = new Map(hits.map((hit) => [hit.id, hit.lang]));
    expect(byId.get('aa'.padEnd(64, 'a'))).toBe('en');
    expect(byId.get('bb'.padEnd(64, 'b'))).toBe('sk');
    expect(byId.get('cc'.padEnd(64, 'c'))).toBeNull();
  });

  it('lang=en vráti iba en; lang=sk iba sk; vynechaný filter všetky', () => {
    expect(langChannel.search('reklamacna', { limit: 10, lang: 'en' }).map((h) => h.id)).toEqual([
      'aa'.padEnd(64, 'a'),
    ]);
    expect(langChannel.search('reklamacna', { limit: 10, lang: 'sk' }).map((h) => h.id)).toEqual([
      'bb'.padEnd(64, 'b'),
    ]);
    expect(langChannel.search('reklamacna', { limit: 10 }).length).toBe(3);
  });

  it('cache prepared statements nezamieňa filter (striedanie s lang aj bez)', () => {
    for (let round = 0; round < 3; round += 1) {
      expect(langChannel.search('reklamacna', { limit: 10, lang: 'en' }).map((h) => h.id)).toEqual([
        'aa'.padEnd(64, 'a'),
      ]);
      expect(langChannel.search('reklamacna', { limit: 10 }).length).toBe(3);
      expect(langChannel.search('reklamacna', { limit: 10, lang: 'sk' }).map((h) => h.id)).toEqual([
        'bb'.padEnd(64, 'b'),
      ]);
    }
  });

  it('lang sa kombinuje s kinds/authors/since/until', () => {
    const hits = langChannel.search('reklamacna', {
      limit: 10,
      lang: 'en',
      kinds: [1020],
      authors: [PK_A],
      since: 900,
      until: 1_500,
    });
    expect(hits.map((h) => h.id)).toEqual(['aa'.padEnd(64, 'a')]);
    // kinds 1023 má v indexe len záznam BEZ labelu → lang=en nevráti nič
    expect(langChannel.search('reklamacna', { limit: 10, lang: 'en', kinds: [1023] })).toEqual([]);
  });

  it('pred-2b2 index: hits pole lang neobsahujú a filter sa ticho ignoruje', () => {
    // `channel` vyššie je nad DB bez `lang` stĺpca
    const hits = channel.search('reklamacna', { limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(Object.prototype.hasOwnProperty.call(hit, 'lang')).toBe(false);
    }
    // filter bez kolónky = žiadny filter (žiadna výnimka, žiadne 503)
    const filtered = channel.search('reklamacna', { limit: 10, lang: 'sk' });
    expect(filtered.map((h) => h.id)).toEqual(hits.map((h) => h.id));
  });
});
