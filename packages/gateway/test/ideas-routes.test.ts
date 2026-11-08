/**
 * Testy HTTP route `GET /ideas` a `GET /ideas/:id` (F4AI-16, S10) — IO
 * vrstva nad dočasnou SQLite DB s KÓPIOU DDL indexera (pravdivosť schémy
 * strážia indexer testy — rovnaký vzor ako `reputation-routes.test.ts`).
 * Bez siete: unit coverage validácie, 503/404 rozhodnutí, filtrovania a
 * tvaru rowu (kanonický status autora vs suggestions cudzích pubkey).
 * Proti reálnym relayom+indexeru ide `packages/indexer/test/ideas-
 * integration.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdeasIndexSource, registerIdeasRoutes } from '../src/ideas-routes.js';
import type { IdeaDetail, IdeaRow } from '../src/ideas.js';

const PK_A = 'a'.repeat(64); // autor IDEA_1/IDEA_2/IDEA_5
const PK_B = 'b'.repeat(64); // autor IDEA_3/IDEA_4; aj cudzí suggestion pri IDEA_1
const PK_C = 'c'.repeat(64); // claimujúci agent
const PK_D = 'd'.repeat(64); // cudzí suggestion pri IDEA_2
const PK_E = 'e'.repeat(64); // hodnotiteľ 1031

const IDEA_1 = '11'.padEnd(64, '0'); // bez statusu → open
const IDEA_2 = '22'.padEnd(64, '0'); // claimed autorom + suggestion + rating/accept
const IDEA_3 = '33'.padEnd(64, '0'); // done (finálny)
const IDEA_4 = '44'.padEnd(64, '0'); // cancelled
const IDEA_5 = '55'.padEnd(64, '0'); // title z `title` tagu
const SOL_1 = 'aa'.padEnd(64, '0'); // riešenie pod IDEA_2
const UNKNOWN = '99'.padEnd(64, '0');

/** kópia DDL z `packages/indexer/src/db.ts` (indexer testy strážia pravdu) */
const INDEXER_SCHEMA = `
CREATE TABLE events (
  id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL,
  tags_text TEXT NOT NULL DEFAULT '', sig TEXT NOT NULL, addr TEXT NULL,
  inserted_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX events_addr ON events (addr);
CREATE VIRTUAL TABLE events_fts USING fts5(
  content, tags_text, content = 'events', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

function seed(path: string): void {
  const writer = new Database(path);
  writer.pragma('journal_mode = WAL');
  writer.exec(INDEXER_SCHEMA);
  const insert = writer.prepare(
    `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at)
     VALUES (?, ?, ?, ?, ?, ?, '', '', ?, 0)`,
  );
  const j = (tags: unknown[]) => JSON.stringify(tags);
  // addr pre replaceable = kind:pubkey:d (LWW línia per publikujúci)
  const addr = (kind: number, pubkey: string, d: string) => `${String(kind)}:${pubkey}:${d}`;

  // 1021 idea_cally
  insert.run(IDEA_1, PK_A, 1021, 1_000, 'Prva idea bez statusu\ndescription zostatok', j([['t', 'ai/agents']]), null);
  insert.run(IDEA_2, PK_A, 1021, 1_001, 'Druha idea claimnuta', j([['t', 'lang/rust'], ['t', 'ai/agents']]), null);
  insert.run(IDEA_3, PK_B, 1021, 1_002, 'Tretia hotova', j([['t', 'pub/eval']]), null);
  insert.run(IDEA_4, PK_B, 1021, 1_003, 'Stvrta zrusena', j([]), null);
  insert.run(IDEA_5, PK_A, 1021, 1_004, 'telo publikacie\nlen pre description', j([['title', 'Nadpis z title tagu'], ['t', 'misc']]), null);

  // 10030 — IDEA_2: kanonický claimed od AUTORA (a-tag = claimant)
  insert.run('c1'.padEnd(64, '0'), PK_A, 10030, 1_010, JSON.stringify({ status: 'claimed', note: 'beriem, dokončím do piatka' }), j([['d', IDEA_2], ['a', PK_C]]), addr(10030, PK_A, IDEA_2));
  // 10030 — IDEA_2: suggestion od cudzieho pubkey (iná LWW línia, iná addr)
  insert.run('c2'.padEnd(64, '0'), PK_D, 10030, 1_020, JSON.stringify({ status: 'in_progress' }), j([['d', IDEA_2]]), addr(10030, PK_D, IDEA_2));
  // 10030 — IDEA_1: suggestion od cudzieho pubkey (autor nič → status ostáva open)
  insert.run('c3'.padEnd(64, '0'), PK_B, 10030, 1_021, JSON.stringify({ status: 'done' }), j([['d', IDEA_1]]), addr(10030, PK_B, IDEA_1));
  // 10030 — IDEA_3 done, IDEA_4 cancelled (finálne stavy)
  insert.run('c4'.padEnd(64, '0'), PK_B, 10030, 1_030, JSON.stringify({ status: 'done', note: 'vydané' }), j([['d', IDEA_3]]), addr(10030, PK_B, IDEA_3));
  insert.run('c5'.padEnd(64, '0'), PK_B, 10030, 1_031, JSON.stringify({ status: 'cancelled' }), j([['d', IDEA_4]]), addr(10030, PK_B, IDEA_4));

  // 1031 rating + 1032 accept viazané na IDEA_2 (rating agregát v row)
  insert.run('r1'.padEnd(64, '0'), PK_E, 1031, 1_040, '{"score":4}', j([['e', SOL_1, ''], ['e', IDEA_2, 'root']]), null);
  insert.run('x1'.padEnd(64, '0'), PK_A, 1032, 1_041, '', j([['e', SOL_1, ''], ['e', IDEA_2, 'root']]), null);

  writer.close();
}

const dir = mkdtempSync(join(tmpdir(), 'f4ai-gw-ideas-'));
const dbPath = join(dir, 'index.db');
const emptyPath = join(dir, 'empty.db');
const missingPath = join(dir, 'nope.db');

function buildApp(path: string | null): Hono {
  const app = new Hono();
  registerIdeasRoutes(app, { path, logger: () => undefined });
  return app;
}

let app: Hono;

beforeAll(() => {
  seed(dbPath);
  const empty = new Database(emptyPath);
  empty.exec(INDEXER_SCHEMA);
  empty.close();
  app = buildApp(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string, applicationApp: Hono = app) => {
  const res = await applicationApp.request(`http://gw.test${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

interface BoardBody {
  phase?: string;
  count?: number;
  limit?: number;
  filters?: Record<string, unknown>;
  items?: IdeaRow[];
  untrusted?: string;
  error?: string;
  reasons?: string[];
  reason?: string;
}

describe('GET /ideas — board', () => {
  it('bez filtrov: všetky idea_cally triedené created_at DESC', async () => {
    const { status, body } = await get('/ideas');
    expect(status).toBe(200);
    const board = body as BoardBody;
    expect(board.phase).toBe('S10');
    expect(board.count).toBe(5);
    expect(board.items?.map((r) => r.id)).toEqual([IDEA_5, IDEA_4, IDEA_3, IDEA_2, IDEA_1]);
    expect(board.untrusted).toContain('untrusted');
  });

  it('idea bez 10030 → status open; cudzí 10030 je suggestion nie status', async () => {
    const { body } = await get(`/ideas`);
    const row = (body as BoardBody).items?.find((r) => r.id === IDEA_1);
    expect(row?.status).toBe('open');
    expect(row?.suggestions_count).toBe(1); // PK_B tvrdí done, ale autor neurčil
    expect(row?.title).toBe('Prva idea bez statusu');
    expect(row?.description).toBe('description zostatok');
    expect(row?.topics).toEqual(['ai/agents']);
    expect(row?.author).toBe(PK_A);
  });

  it('claimed s claimantom: kanonický status od autora + status_history', async () => {
    const { body } = await get('/ideas');
    const row = (body as BoardBody).items?.find((r) => r.id === IDEA_2);
    expect(row?.status).toBe('claimed');
    expect(row?.claimant).toBe(PK_C);
    expect(row?.status_history).toHaveLength(1);
    expect(row?.status_history[0]?.status).toBe('claimed');
    expect(row?.status_history[0]?.publisher).toBe(PK_A);
    expect(row?.status_history[0]?.note).toBe('beriem, dokončím do piatka');
    expect(row?.suggestions_count).toBe(1); // PK_D in_progress
  });

  it('rating agregát z reputation: 1031+1032 na IDEA_2 → accepted flag', async () => {
    const { body } = await get('/ideas');
    const row = (body as BoardBody).items?.find((r) => r.id === IDEA_2);
    expect(row?.rating).not.toBeNull();
    expect(row?.rating?.count).toBe(1);
    expect(row?.rating?.accepted).toBe(true);
    expect(row?.rating?.accepted_count).toBe(1);
    const open = (body as BoardBody).items?.find((r) => r.id === IDEA_1);
    expect(open?.rating?.count).toBe(0);
    expect(open?.rating?.accepted).toBe(false);
  });

  it('finálne stavy: done/cancelled sa zobrazia ako status', async () => {
    const { body } = await get('/ideas');
    const items = (body as BoardBody).items ?? [];
    expect(items.find((r) => r.id === IDEA_3)?.status).toBe('done');
    expect(items.find((r) => r.id === IDEA_4)?.status).toBe('cancelled');
  });

  it('title z title tagu', async () => {
    const { body } = await get('/ideas');
    const row = (body as BoardBody).items?.find((r) => r.id === IDEA_5);
    expect(row?.title).toBe('Nadpis z title tagu');
    expect(row?.description).toBe('telo publikacie\nlen pre description');
  });

  it('filter status=claimed / status=open', async () => {
    const claimed = await get('/ideas?status=claimed');
    expect(claimed.status).toBe(200);
    expect((claimed.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_2]);

    const open = await get('/ideas?status=open');
    // IDEA_5 (title tag) ani IDEA_1 nemajú 10030 autora → implicitne open
    expect((open.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_5, IDEA_1]);
  });

  it('filter topic (case-insensitive) + kombinácia so status', async () => {
    const rust = await get('/ideas?topic=lang/rust');
    expect((rust.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_2]);

    const upper = await get('/ideas?topic=AI/AGENTS');
    expect((upper.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_2, IDEA_1]);

    const combo = await get('/ideas?topic=ai/agents&status=open');
    expect((combo.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_1]);
    expect((combo.body as BoardBody).filters).toEqual({ status: 'open', topic: 'ai/agents' });
  });

  it('filter since + limit', async () => {
    const since = await get('/ideas?since=1003');
    expect((since.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_5, IDEA_4]);

    const limited = await get('/ideas?limit=2');
    expect((limited.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_5, IDEA_4]);
    expect((limited.body as BoardBody).limit).toBe(2);
  });

  // regression B2: ?author= server-side filter (predtým len lokálne v UI
  // po limit=100 fetchi, čo ticho mizalo pri plnom boardi)
  it('filter author (pubkey autora) + 400 pri zlom tvare', async () => {
    const byA = await get(`/ideas?author=${PK_A}`);
    expect((byA.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_5, IDEA_2, IDEA_1]);
    expect((byA.body as BoardBody).filters).toEqual({ author: PK_A });

    const byBUpper = await get(`/ideas?author=${PK_B.toUpperCase()}`);
    expect((byBUpper.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_4, IDEA_3]);

    const combo = await get(`/ideas?author=${PK_A}&status=claimed`);
    expect((combo.body as BoardBody).items?.map((r) => r.id)).toEqual([IDEA_2]);

    expect((await get('/ideas?author=zz')).status).toBe(400);
    expect((await get('/ideas?author=abc')).status).toBe(400);
  });

  it('prázdny board → 200 s count 0', async () => {
    const { status, body } = await get('/ideas', buildApp(emptyPath));
    expect(status).toBe(200);
    expect((body as BoardBody).count).toBe(0);
    expect((body as BoardBody).items).toEqual([]);
  });

  it('400: zlý status / limit / since / topic', async () => {
    const badStatus = await get('/ideas?status=delivered');
    expect(badStatus.status).toBe(400);
    expect((badStatus.body as BoardBody).error).toBe('invalid status');
    expect((badStatus.body as BoardBody).reasons?.[0]).toContain('delivered');

    expect((await get('/ideas?limit=0')).status).toBe(400);
    expect((await get('/ideas?limit=101')).status).toBe(400);
    expect((await get('/ideas?limit=abc')).status).toBe(400);
    expect((await get('/ideas?since=-5')).status).toBe(400);
    expect((await get(`/ideas?topic=${'x'.repeat(201)}`)).status).toBe(400);
  });

  it('503 bez GATEWAY_INDEX_DB a pri chýbajúcom súbore — žiadny tichý fallback', async () => {
    const noDb = await get('/ideas', buildApp(null));
    expect(noDb.status).toBe(503);
    expect((noDb.body as BoardBody).error).toBe('index unavailable');

    const missing = await get('/ideas', buildApp(missingPath));
    expect(missing.status).toBe(503);
    expect((missing.body as BoardBody).error).toBe('index unavailable');
  });
});

describe('GET /ideas/:id — detail', () => {
  it('detail claimnutej idea: status_history + suggestions[]', async () => {
    const { status, body } = await get(`/ideas/${IDEA_2}`);
    expect(status).toBe(200);
    const detail = body as unknown as IdeaDetail & { phase?: string };
    expect(detail.phase).toBe('S10');
    expect(detail.id).toBe(IDEA_2);
    expect(detail.status).toBe('claimed');
    expect(detail.claimant).toBe(PK_C);
    expect(detail.status_history.map((h) => h.publisher)).toEqual([PK_A]);
    expect(detail.suggestions).toHaveLength(1);
    expect(detail.suggestions[0]?.publisher).toBe(PK_D);
    expect(detail.suggestions[0]?.status).toBe('in_progress');
    expect(detail.suggestions_count).toBe(1);
    expect(detail.rating?.accepted).toBe(true);
  });

  it('detail open idea s cudzím 10030: status ostáva open', async () => {
    const { body } = await get(`/ideas/${IDEA_1}`);
    const detail = body as unknown as IdeaDetail;
    expect(detail.status).toBe('open');
    expect(detail.suggestions).toHaveLength(1);
    expect(detail.suggestions[0]?.status).toBe('done'); // názor cudzieho, nie status
  });

  it('404: neznáma idea (64-hex id mimo indexu)', async () => {
    const { status, body } = await get(`/ideas/${UNKNOWN}`);
    expect(status).toBe(404);
    expect((body as BoardBody).error).toBe('idea not found');
  });

  it('400: id nie je 64-hex', async () => {
    const { status, body } = await get('/ideas/shortid');
    expect(status).toBe(400);
    expect((body as BoardBody).error).toBe('invalid idea id');
  });

  it('503 bez indexu', async () => {
    const { status } = await get(`/ideas/${IDEA_2}`, buildApp(null));
    expect(status).toBe(503);
  });
});

describe('IdeasIndexSource', () => {
  it('availability() hlási cestu a dôvod nedostupnosti', () => {
    const ok = new IdeasIndexSource({ path: dbPath });
    expect(ok.availability()).toEqual({ available: true, path: dbPath });
    ok.close();

    const gone = new IdeasIndexSource({ path: missingPath });
    const status = gone.availability();
    expect(status.available).toBe(false);
    expect(status.reason).toContain('does not exist');
  });

  it('loadByKinds vráti eventy newest-first so stropom', () => {
    const source = new IdeasIndexSource({ path: dbPath });
    const rows = source.loadByKinds([1021], 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe(1021);
    expect(rows[0]?.created_at).toBeGreaterThanOrEqual(rows[1]?.created_at ?? 0);
    source.close();
  });
});
