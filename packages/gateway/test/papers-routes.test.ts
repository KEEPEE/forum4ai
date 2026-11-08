/**
 * Testy HTTP route papiera (Phase 4a, dizajn Q4): `GET /papers`,
 * `GET /papers/:id`, `GET /papers/:pubkey/:d` a `POST /lint`.
 *
 * IO vrstva nad dočasnou SQLite DB s KÓPIOU DDL indexera (rovnaký vzor ako
 * `ideas-routes.test.ts` / `reputation-routes.test.ts` — pravdivosť schémy
 * strážia indexer testy). Bez siete.
 *
 * Strážia sa tri veci, ktoré sa ľahko pokazia:
 *   1. 503 `{error:'index unavailable'}` bez tichého fallbacku (S8/S9/S10),
 *   2. FEATURE-DETECTION stĺpcov `lang` (2b2) a `paper_*` (4a) — gateway
 *      musí fungovať aj proti indexu zo starej migrácie,
 *   3. `POST /lint` má rovnaké kódy ako validátor pri `POST /events`,
 *      inak agentovi sľubujeme cyklus, ktorý neplatí.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import { PapersIndexSource, registerPapersRoutes } from '../src/paper-routes.js';
import { PAPERS_DEFAULT_LIMIT, PAPERS_MAX_LIMIT, PAPERS_PHASE } from '../src/papers.js';
import type { PaperDetail, PaperRow } from '../src/papers.js';

const PK_A = 'a'.repeat(64); // autor PAPER_1 (sk) a PAPER_3
const PK_B = 'b'.repeat(64); // autor PAPER_2 (en)
const PK_C = 'c'.repeat(64); // spoluautor v `author` tagu PAPER_1

const PAPER_1 = '11'.padEnd(64, '0'); // sk, topic distributed-systems, @fig:arch + [@novak2026]
const PAPER_2 = '22'.padEnd(64, '0'); // en, topic ai/agents, cituje [@chrobak2024]
const PAPER_3 = '33'.padEnd(64, '0'); // bez `d` tagu → addr null, neplatný JSON v references
const UNKNOWN = '99'.padEnd(64, '0');

/** kópia DDL z `packages/indexer/src/db.ts` (vrátane 4a stĺpcov) */
const INDEXER_SCHEMA = `
CREATE TABLE events (
  id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL,
  tags_text TEXT NOT NULL DEFAULT '', sig TEXT NOT NULL, addr TEXT NULL,
  inserted_at INTEGER NOT NULL, lang TEXT NULL,
  paper_title TEXT NULL, paper_authors TEXT NULL, paper_abstract TEXT NULL, paper_doi TEXT NULL
);
CREATE UNIQUE INDEX events_addr ON events (addr);
CREATE INDEX events_kind ON events (kind);
CREATE VIRTUAL TABLE events_fts USING fts5(
  content, tags_text, content = 'events', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/** schéma PRED 4a (2b2): `lang` áno, `paper_*` nie */
const INDEXER_SCHEMA_PRE_4A = INDEXER_SCHEMA.replace(
  /lang TEXT NULL,\s*\n\s*paper_title TEXT NULL, paper_authors TEXT NULL, paper_abstract TEXT NULL, paper_doi TEXT NULL/,
  'lang TEXT NULL',
);

const j = (tags: unknown[]) => JSON.stringify(tags);
const addr = (kind: number, pubkey: string, d: string) => `${String(kind)}:${pubkey}:${d}`;

const PAPER_1_BODY = [
  '## Introduction',
  '',
  'The architecture is in @fig:arch and we cite [@novak2026].',
  '',
  '```mermaid fig=arch caption="Replication stack"',
  'flowchart LR; a-->b',
  '```',
  '',
  '## Results',
  '',
  'See @tbl:results and @eq:latency.',
  '',
  'Table: Latency per hop {#tbl:results}',
  '',
  '$$ L = \\sum_i d_i $$ {#eq:latency}',
  '',
  '```references',
  '[',
  '  {"id":"novak2026","type":"article-journal","title":"Negentropy sets",' +
    '"author":[{"family":"Novakova","given":"Jana"}],"issued":{"date-parts":[[2026]]},' +
    '"container-title":"PMLR","DOI":"10.5281/zenodo.1234567"},',
  '  {"id":"chrobak2024","type":"paper-conference","title":"Gossip and sets",' +
    '"author":[{"family":"Chrobak","given":"Adam"}],"issued":{"date-parts":[[2024]]}}',
  ']',
  '```',
].join('\n');

const PAPER_2_BODY = [
  '## Intro',
  '',
  'Builds on [@chrobak2024].',
  '',
  '```references',
  '[{"id":"chrobak2024","type":"paper-conference","title":"Gossip and sets",' +
    '"author":[{"family":"Chrobak","given":"Adam"}],"issued":{"date-parts":[[2024]]}}]',
  '```',
].join('\n');

function seed(path: string, schema: string = INDEXER_SCHEMA): void {
  const writer = new Database(path);
  writer.pragma('journal_mode = WAL');
  writer.exec(schema);
  const insert = writer.prepare(
    `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang)
     VALUES (?, ?, ?, ?, ?, ?, '', 'sig', ?, ?, ?)`,
  );

  insert.run(
    PAPER_1,
    PK_A,
    KINDS.PUBLICATION,
    1_000,
    PAPER_1_BODY,
    j([
      ['d', 'negentropy-replication'],
      ['title', 'Negentropy Replication of Gated Nostr Forums'],
      ['summary', 'We replicate gated nostr forums with negentropy sets and measure hop latency.'],
      ['published_at', '1793836800'],
      ['t', 'distributed-systems'],
      ['t', 'nostr'],
      ['author', 'Jana Novakova', 'Comenius University', PK_A, '0000-0002-1825-0097'],
      ['author', 'Peter Coauthor', 'TU Wien', PK_C, ''],
      ['p', PK_A, '', 'author'],
      ['p', PK_C, '', 'author'],
      ['a', `30020:${PK_B}:nostr`, 'wss://relay.example'],
      ['license', 'CC-BY-4.0'],
      ['version', '2'],
      ['doi', '10.5281/zenodo.1234567'],
      ['L', 'ISO-639-1'],
      ['l', 'sk', 'ISO-639-1'],
    ]),
    addr(KINDS.PUBLICATION, PK_A, 'negentropy-replication'),
    1_000,
    'sk',
  );

  insert.run(
    PAPER_2,
    PK_B,
    KINDS.PUBLICATION,
    2_000,
    PAPER_2_BODY,
    j([
      ['d', 'gossip-sets'],
      ['title', 'Reklamačná smernica v distribúcii'],
      ['summary', 'Slovensky pisaný abstrakt s diakritikou: reklamacna smernica.'],
      ['t', 'ai/agents'],
      ['author', 'Adam Chrobak', '', PK_B, ''],
      ['p', PK_B, '', 'author'],
      ['license', 'CC-BY-4.0'],
      ['L', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ]),
    addr(KINDS.PUBLICATION, PK_B, 'gossip-sets'),
    2_000,
    'en',
  );

  // 30023 bez `d` tagu → addr NULL; references fence je neplatný JSON
  insert.run(
    PAPER_3,
    PK_A,
    KINDS.PUBLICATION,
    3_000,
    '## Intro\n\nprose with [@ghost2020] citation\n\n```references\n{not json}\n```',
    j([
      ['title', 'Bez adresy a s rozbitymi referenciami'],
      ['t', 'pub/eval'],
      ['author', 'Solo Author'],
    ]),
    null,
    3_000,
    null,
  );

  // nerovnaký kind, ktorý sa NESMIE objaviť na boarde
  insert.run(
    'aa'.padEnd(64, '0'),
    PK_A,
    KINDS.POST,
    4_000,
    '# A post that is not a paper',
    j([['e', 'a'.repeat(64), 'root']]),
    null,
    4_000,
    'sk',
  );

  writer.close();
}

const dir = mkdtempSync(join(tmpdir(), 'f4ai-gw-papers-'));
const dbPath = join(dir, 'index.db');
const pre4aPath = join(dir, 'pre4a.db');
const missingPath = join(dir, 'nope.db');

function buildApp(path: string | null, options: { cacheMs?: number } = {}): Hono {
  const app = new Hono();
  registerPapersRoutes(app, { path, logger: () => undefined, ...options });
  return app;
}

let app: Hono;
let pre4aApp: Hono;
let missingApp: Hono;

const request = async (applicationApp: Hono, path: string, init?: RequestInit) => {
  const res = await applicationApp.request(`http://gw.test${path}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const get = (path: string, applicationApp: Hono = app) => request(applicationApp, path);
const post = (applicationApp: Hono, path: string, body: unknown) =>
  request(applicationApp, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeAll(() => {
  seed(dbPath);
  seed(pre4aPath, INDEXER_SCHEMA_PRE_4A);
  app = buildApp(dbPath, { cacheMs: 0 });
  pre4aApp = buildApp(pre4aPath, { cacheMs: 0 });
  missingApp = buildApp(missingPath, { cacheMs: 0 });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /papers — board', () => {
  it('vráti papiere newest-first so správnym počtom a fazou', async () => {
    const { status, body } = await get('/papers');
    expect(status).toBe(200);
    expect(body.phase).toBe(PAPERS_PHASE);
    expect(body.count).toBe(3);
    expect(body.limit).toBe(PAPERS_DEFAULT_LIMIT);
    const items = body.items as PaperRow[];
    expect(items.map((item) => item.id)).toEqual([PAPER_3, PAPER_2, PAPER_1]);
    expect(typeof body.untrusted).toBe('string');
    // 1023 post na boarde nie je
    expect(items.some((item) => item.id === 'aa'.repeat(64))).toBe(false);
  });

  it('radu nesie normalizovanych autorov, topics, lang a body_bytes', async () => {
    const { body } = await get('/papers');
    const items = body.items as PaperRow[];
    const first = items.find((item) => item.id === PAPER_1);
    expect(first?.title).toBe('Negentropy Replication of Gated Nostr Forums');
    expect(first?.addr).toBe(`${String(KINDS.PUBLICATION)}:${PK_A}:negentropy-replication`);
    expect(first?.slug).toBe('negentropy-replication');
    expect(first?.lang).toBe('sk');
    expect(first?.doi).toBe('10.5281/zenodo.1234567');
    expect(first?.license).toBe('CC-BY-4.0');
    expect(first?.version).toBe('2');
    expect(first?.published_at).toBe(1_793_836_800);
    expect(first?.topics).toEqual(['distributed-systems', 'nostr']);
    expect(first?.body_bytes).toBe(Buffer.byteLength(PAPER_1_BODY, 'utf8'));
    expect(first?.authors).toEqual([
      { name: 'Jana Novakova', affiliation: 'Comenius University', pubkey: PK_A, orcid: '0000-0002-1825-0097' },
      { name: 'Peter Coauthor', affiliation: 'TU Wien', pubkey: PK_C },
    ]);
    // list NEspúšťa lint — reference nie sú súčasťou radu
    expect(first).not.toHaveProperty('references');
    expect(first).not.toHaveProperty('lint');
  });

  it('papier bez d tagu ma addr null a title sa dostane aj tak', async () => {
    const { body } = await get('/papers');
    const third = (body.items as PaperRow[]).find((item) => item.id === PAPER_3);
    expect(third?.addr).toBeNull();
    expect(third?.slug).toBeUndefined();
    expect(third?.title).toBe('Bez adresy a s rozbitymi referenciami');
    expect(third?.lang).toBeNull();
    expect(third?.authors).toEqual([{ name: 'Solo Author' }]);
  });

  it('topic filter je presny na t-tag a diakritiku-zrazkovy', async () => {
    expect((await get('/papers?topic=nostr')).body.count).toBe(1);
    expect((await get('/papers?topic=NOSTR')).body.count).toBe(1);
    expect((await get('/papers?topic=distributed-systems')).body.count).toBe(1);
    expect((await get('/papers?topic=nostr;')).body.count).toBe(0);
    expect((await get('/papers?topic=ai')).body.count).toBe(0); // nie substring
  });

  it('lang filter (2b2) + any = bez filtra', async () => {
    expect((await get('/papers?lang=sk')).body.count).toBe(1);
    expect((await get('/papers?lang=en')).body.count).toBe(1);
    expect((await get('/papers?lang=de')).body.count).toBe(0);
    expect((await get('/papers?lang=any')).body.count).toBe(3);
    expect((await get('/papers?lang=any')).body.filters).toBeUndefined();
  });

  it('author filter puka aj na pubkey `author` tagu, nie len na pubkey eventu', async () => {
    expect((await get(`/papers?author=${PK_A}`)).body.count).toBe(2); // autor PAPER_1 a PAPER_3
    expect((await get(`/papers?author=${PK_C}`)).body.count).toBe(1); // spoluautor v tagu
    expect((await get(`/papers?author=${'d'.repeat(64)}`)).body.count).toBe(0);
  });

  it('q je substring cez nadpis a abstrakt, case/diacritics-insensitive', async () => {
    expect((await get('/papers?q=negentropy')).body.count).toBe(1);
    expect((await get('/papers?q=NEGENTROPY')).body.count).toBe(1);
    expect((await get('/papers?q=reklamacna')).body.count).toBe(1); // nájde "Reklamačná"
    expect((await get('/papers?q=reklamacna%20smernica')).body.count).toBe(1);
    expect((await get('/papers?q=negentropy%20sets')).body.count).toBe(1); // abstrakt
    expect((await get('/papers?q=chrobak')).body.count).toBe(0); // autor nie je v q
    expect((await get('/papers?q=zzz')).body.count).toBe(0);
  });

  it('since/until a limit (default, strop, 1..100)', async () => {
    expect((await get('/papers?since=2000')).body.count).toBe(2);
    expect((await get('/papers?until=2000')).body.count).toBe(2);
    expect((await get('/papers?since=2000&until=2000')).body.count).toBe(1);
    const limited = await get('/papers?limit=2');
    expect(limited.body.limit).toBe(2);
    expect(limited.body.count).toBe(2);
    expect((limited.body.items as PaperRow[]).map((item) => item.id)).toEqual([PAPER_3, PAPER_2]);
    expect((await get(`/papers?limit=${String(PAPERS_MAX_LIMIT)}`)).status).toBe(200);
  });

  it('filtre sa v odpovedi vracaju (echo)', async () => {
    const { body } = await get('/papers?topic=nostr&lang=sk');
    expect(body.filters).toEqual({ topic: 'nostr', lang: 'sk' });
  });

  it('400 na neplatne parametre (druhy chyby je v reason)', async () => {
    const cases: Array<[string, string]> = [
      ['?lang=xx', 'ISO-639-1'],
      ['?lang=eng', 'ISO-639-1'],
      ['?author=zz', '64 hex'],
      ['?limit=0', '1..100'],
      ['?limit=101', '1..100'],
      ['?limit=abc', '1..100'],
      ['?since=-1', 'non-negative'],
      ['?until=1.5', 'non-negative'],
      [`?topic=${'t'.repeat(201)}`, '200 characters'],
      [`?q=${'q'.repeat(201)}`, '200 characters'],
    ];
    for (const [query, needle] of cases) {
      const { status, body } = await get(`/papers${query}`);
      expect(status, query).toBe(400);
      expect(body.ok).toBe(false);
      expect(String((body.reasons as string[])[0]), query).toContain(needle);
    }
  });

  it('prazdny parameter sa sprava ako keby nebol', async () => {
    expect((await get('/papers?topic=&lang=&q=&author=')).body.count).toBe(3);
  });

  it('503 index unavailable bez GATEWAY_INDEX_DB (ziadny tichy fallback)', async () => {
    const noIndex = buildApp(null);
    const { status, body } = await get('/papers', noIndex);
    expect(status).toBe(503);
    expect(body.error).toBe('index unavailable');
    expect(body.reason).toContain('GATEWAY_INDEX_DB');
    expect(body.items).toBeUndefined();
  });

  it('503 ked index DB neexistuje', async () => {
    const { status, body } = await get('/papers', missingApp);
    expect(status).toBe(503);
    expect(body.error).toBe('index unavailable');
    expect(String(body.path)).toContain('nope.db');
  });

  it('503 aj na detail a adresu (nie len board)', async () => {
    expect((await get(`/papers/${PAPER_1}`, missingApp)).status).toBe(503);
    expect((await get(`/papers/${PK_A}/negentropy-replication`, missingApp)).status).toBe(503);
  });

  it('index bez 4a stlpcov (2b2 DB) funguje — q filter then len z JS', async () => {
    const { status, body } = await get('/papers', pre4aApp);
    expect(status).toBe(200);
    expect(body.count).toBe(3);
    // `paper_title` stlpec neexistuje → SQL predfilter sa nepoužije, ale
    // JS filter musí nájsť to isté (inak by migrácia ticho zmenila výsledky)
    expect((await get('/papers?q=reklamacna', pre4aApp)).body.count).toBe(1);
    expect((await get('/papers?lang=sk', pre4aApp)).body.count).toBe(1);
  });

  it('cache scanu respektuje cacheMs=0 (novy ingest je ihneď vidiet)', async () => {
    const cached = buildApp(dbPath, { cacheMs: 60_000 });
    const before = (await get('/papers', cached)).body.count;
    const writer = new Database(dbPath);
    writer
      .prepare(
        `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang)
         VALUES (?, ?, ?, ?, ?, ?, '', 'sig', NULL, ?, NULL)`,
      )
      .run('bb'.padEnd(64, '0'), PK_C, KINDS.PUBLICATION, 5_000, 'body', j([['title', 'Cached?'], ['t', 'nostr']]), 5_000);
    writer.close();
    expect((await get('/papers', cached)).body.count).toBe(before); // z cachu
    expect((await get('/papers', app)).body.count).toBe(before + 1); // bez cachu ihneď
  });
});

describe('GET /papers/:id a GET /papers/:pubkey/:d — detail', () => {
  it('detail nesie event, parsovany papier a lint s varovaniami', async () => {
    const { status, body } = await get(`/papers/${PAPER_1}`);
    expect(status).toBe(200);
    const detail = body as unknown as PaperDetail;
    expect(detail.phase).toBe(PAPERS_PHASE);
    expect(detail.id).toBe(PAPER_1);
    expect(detail.kind).toBe(KINDS.PUBLICATION);
    expect(detail.addr).toBe(`${String(KINDS.PUBLICATION)}:${PK_A}:negentropy-replication`);
    expect(detail.event.content).toBe(PAPER_1_BODY);
    expect(detail.event.tags).toEqual(expect.arrayContaining([['doi', '10.5281/zenodo.1234567']]));
    expect(detail.lint.ok).toBe(true);
    expect(detail.lint.errors).toEqual([]);
    // chýbajúci @tbl:results by bol XREF_UNKNOWN — tu je deklarovaný, takže
    // jediné varovanie je nekonzistentná citácia (ghost2020 nie je v refs)
    expect(detail.lint.warning_codes).toEqual(expect.arrayContaining(['REF_UNCITED']));
    expect(detail.paper.references).toHaveLength(2);
    expect(detail.paper.declaredRefs).toEqual({
      fig: ['arch'],
      tbl: ['results'],
      eq: ['latency'],
    });
    expect(detail.paper.citedKeys).toEqual(['novak2026']);
    expect(detail.paper.crossRefs).toEqual([
      { kind: 'fig', id: 'arch' },
      { kind: 'tbl', id: 'results' },
      { kind: 'eq', id: 'latency' },
    ]);
    expect(detail.paper.richBlocks).toBe(1);
    expect(detail.paper.bodyBytes).toBe(Buffer.byteLength(PAPER_1_BODY, 'utf8'));
    expect(detail.paper.coauthorPubkeys).toEqual([PK_A, PK_C]);
    expect(detail.paper.lang).toBe('sk');
  });

  it('detail s rozbitym references fence = REFS_INVALID chyba (nie 500)', async () => {
    const { status, body } = await get(`/papers/${PAPER_3}`);
    expect(status).toBe(200);
    const detail = body as unknown as PaperDetail;
    expect(detail.lint.ok).toBe(false);
    expect(detail.lint.codes).toContain('REFS_INVALID');
    // references fence EXISTUJE, len sa nedá prečítať → REFS_INVALID (chyba).
    // CITE_UNKNOWN vtedy NIE JE: id referencií nepoznáme, takže
    // "[@ghost2020] nie je v zozname" by bol šum navrch už povedanej chyby
    expect(detail.lint.warning_codes).not.toContain('CITE_UNKNOWN');
    expect(detail.lint.errors.join(' ')).toContain('references');
    expect(detail.paper.references).toBeNull();
  });

  it('404 na neznáme id, 400 na ne-hex id', async () => {
    const notFound = await get(`/papers/${UNKNOWN}`);
    expect(notFound.status).toBe(404);
    expect(notFound.body.error).toBe('paper not found');
    expect(notFound.body.reason).toContain('30023');
    expect((await get('/papers/nothex')).status).toBe(400);
    expect((await get(`/papers/${'a'.repeat(63)}`)).status).toBe(400);
    expect((await get(`/papers/${'A'.repeat(64)}`)).status).toBe(400); // veľké hex NE
  });

  it('detail podľa adresy vráti `address` a tú istú revíziu', async () => {
    const { status, body } = await get(`/papers/${PK_A}/negentropy-replication`);
    expect(status).toBe(200);
    expect(body.address).toBe(`${String(KINDS.PUBLICATION)}:${PK_A}:negentropy-replication`);
    expect(body.id).toBe(PAPER_1);
    expect((body as unknown as PaperDetail).lint.ok).toBe(true);
  });

  it('404 na neznámu adresu, 400 na zlý tvar pubkey/slug', async () => {
    expect((await get(`/papers/${PK_A}/no-such-paper`)).status).toBe(404);
    expect((await get(`/papers/${'a'.repeat(63)}/x`)).status).toBe(400);
    expect((await get(`/papers/${PK_A}/Bad-Slug`)).status).toBe(400); // veľké písmeno
    expect((await get(`/papers/${PK_A}/-bad`)).status).toBe(400);
    expect((await get(`/papers/${PK_A}/bad_slug`)).status).toBe(400); // podčiarknik
  });

  it('detail cudzieho 30023 s neplatnym eventom sa stále vráti (200 + lint)', async () => {
    const writer = new Database(dbPath);
    writer
      .prepare(
        `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang)
         VALUES (?, ?, ?, ?, ?, ?, '', 'sig', NULL, ?, NULL)`,
      )
      .run('cc'.padEnd(64, '0'), PK_C, KINDS.PUBLICATION, 6_000, 'body', j([['t', 'nostr']]), 6_000);
    writer.close();
    const { status, body } = await get(`/papers/${'cc'.padEnd(64, '0')}`);
    expect(status).toBe(200);
    const detail = body as unknown as PaperDetail;
    expect(detail.lint.codes).toContain('PAPER_TITLE_REQUIRED');
    expect(detail.lint.codes).toContain('PAPER_AUTHORS_INVALID');
    expect(detail.paper.title).toBe('');
  });
});

describe('POST /lint — predpublish bez podpisu', () => {
  const good = {
    title: 'Negentropy Replication',
    authors: [{ name: 'Jana Novakova', affiliation: 'Comenius University', pubkey: PK_A }],
    topics: ['distributed-systems'],
    abstract: 'Short abstract.',
    body: '## Intro\n\nSee @fig:arch.\n\n```mermaid fig=arch\nflowchart LR; a-->b\n```\n\n[@novak2026]',
    references: [
      {
        id: 'novak2026',
        type: 'article-journal',
        title: 'Negentropy sets',
        author: [{ family: 'Novakova', given: 'Jana' }],
        issued: { 'date-parts': [[2026]] },
      },
    ],
  };

  it('platny papier → ok:true s paper metadatami a hintom', async () => {
    const { status, body } = await post(app, '/lint', good);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.phase).toBe(PAPERS_PHASE);
    expect(body.errors).toEqual([]);
    expect(body.codes).toEqual([]);
    expect(body.warning_codes).toEqual([]);
    expect(body.hint).toContain('POST /events');
    const paperMeta = body.paper as { bodyBytes: number; references: unknown[] };
    expect(paperMeta.references).toHaveLength(1);
    expect(paperMeta.bodyBytes).toBeGreaterThan(Buffer.byteLength(good.body, 'utf8'));
    expect(body.paper).toMatchObject({
      title: 'Negentropy Replication',
      // `references` vo vstupe sa APPENDUJE ako fence → bodyBytes počíta
      // finálne telo, nie len to, čo poslal klient (dizajn Q4: jeden fence)
      bodyBytes: expect.any(Number),
      citedKeys: ['novak2026'],
      declaredRefs: { fig: ['arch'], tbl: [], eq: [] },
    });
  });

  it('kody su indexovo zsene s errors (stabilna kontracta)', async () => {
    const { status, body } = await post(app, '/lint', {
      ...good,
      title: '',
      topics: [],
      authors: [],
    });
    expect(status).toBe(200); // lint verdict NIE je HTTP chyba
    expect(body.ok).toBe(false);
    const errors = body.errors as string[];
    const codes = body.codes as string[];
    expect(codes).toContain('PAPER_TITLE_REQUIRED');
    expect(codes).toContain('PAPER_TOPIC_MISSING');
    expect(codes).toContain('PAPER_AUTHORS_INVALID');
    expect(errors).toHaveLength(codes.length);
    expect(errors[codes.indexOf('PAPER_TITLE_REQUIRED')]).toContain('title');
  });

  it('varovania nerusia ok a maju vlastne kody', async () => {
    const { body } = await post(app, '/lint', {
      ...good,
      body: '## Intro\n\n@fig:missing and [@ghost2020]\n\n```references\n[{"id":"novak2026","type":"article-journal","title":"X","author":[{"family":"N","given":"J"}],"issued":{"date-parts":[[2026]]}}]\n```',
    });
    expect(body.ok).toBe(true);
    const codes = body.warning_codes as string[];
    expect(codes).toContain('XREF_UNKNOWN');
    expect(codes).toContain('CITE_UNKNOWN');
    expect(codes).toContain('REF_UNCITED');
    expect((body.warnings as string[])[codes.indexOf('CITE_UNKNOWN')]).toContain('ghost2020');
  });

  it('akceptuje aj {event: NIP-01} tvar (UI editor)', async () => {
    const event: NostrEvent = {
      id: 'dd'.padEnd(64, '0'),
      pubkey: PK_A,
      created_at: 1_000,
      kind: KINDS.PUBLICATION,
      tags: [
        ['d', 'from-event'],
        ['title', 'From an event'],
        ['t', 'nostr'],
        ['author', 'Solo', '', PK_A],
      ],
      content: '## Intro\n\nprose',
      sig: 'x'.repeat(128),
    };
    const { status, body } = await post(app, '/lint', { event });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.paper).toMatchObject({ title: 'From an event', slug: 'from-event' });
  });

  it('400 na iny kind v evente, na pole, na neplatny JSON a na prazdne telo', async () => {
    const wrongKind = await post(app, '/lint', {
      event: { id: 'ee'.padEnd(64, '0'), pubkey: PK_A, created_at: 1, kind: KINDS.POST, tags: [], content: 'x', sig: 's' },
    });
    expect(wrongKind.status).toBe(400);
    expect(String(wrongKind.body.reasons)).toContain('30023');

    expect((await post(app, '/lint', [1, 2, 3])).status).toBe(400); // pole nie objekt
    expect((await post(app, '/lint', { event: 'nope' })).status).toBe(400);
    expect((await post(app, '/lint', 'not json')).status).toBe(400);
    expect((await post(app, '/lint', '   ')).status).toBe(400);
  });

  it('prazdny objekt je validovatelny vstup → lint odpovie chyby (nie 400)', async () => {
    const { status, body } = await post(app, '/lint', {});
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.codes).toContain('PAPER_TITLE_REQUIRED');
  });

  it('413 na telo vacsi ako 512 KiB (rozhoduju UTF-8 bajty)', async () => {
    const huge = JSON.stringify({ ...good, body: 'ä'.repeat(300 * 1024) });
    expect(Buffer.byteLength(huge, 'utf8')).toBeGreaterThan(512 * 1024);
    const { status, body } = await post(app, '/lint', huge);
    expect(status).toBe(413);
    expect(body.error).toBe('payload too large');
  });

  it('lint je dostupny aj bez indexu (503 na board, 200 na lint)', async () => {
    expect((await get('/papers', missingApp)).status).toBe(503);
    expect((await post(missingApp, '/lint', good)).status).toBe(200);
  });
});

describe('PapersIndexSource — zdroj', () => {
  it('availability() povie dovod, nie len ze nie', () => {
    const missing = new PapersIndexSource({ path: missingPath });
    const gone = missing.availability();
    expect(gone.available).toBe(false);
    expect(String(gone.reason)).toContain('does not exist');
    missing.close();

    const ok = new PapersIndexSource({ path: dbPath });
    expect(ok.availability()).toEqual({ available: true, path: dbPath });
    ok.close();
  });

  it('close() je idempotentny a znova otvorí', () => {
    const source = new PapersIndexSource({ path: dbPath });
    expect(source.loadPapers({}).length).toBeGreaterThan(0);
    source.close();
    source.close();
    expect(source.loadPapers({}).length).toBeGreaterThan(0);
    source.close();
  });

  it('riadok s poskodenym tags_json preskoci (500 z jedneho riadku je spatne)', () => {
    const brokenPath = join(dir, 'broken.db');
    const writer = new Database(brokenPath);
    writer.exec(INDEXER_SCHEMA);
    const insert = writer.prepare(
      `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang)
       VALUES (?, ?, ?, ?, ?, ?, '', 'sig', NULL, ?, NULL)`,
    );
    insert.run('f1'.padEnd(64, '0'), PK_A, KINDS.PUBLICATION, 1, 'body', '{oops', 1);
    insert.run('f2'.padEnd(64, '0'), PK_A, KINDS.PUBLICATION, 2, 'body', j([['title', 'OK'], ['t', 'nostr']]), 2);
    writer.close();
    const source = new PapersIndexSource({ path: brokenPath });
    const events = source.loadPapers({});
    expect(events.map((event) => event.id)).toEqual(['f2'.padEnd(64, '0')]);
    source.close();
  });
});
