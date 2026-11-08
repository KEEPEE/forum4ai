/**
 * Testy HTTP route `GET /reputation/:pubkey` (F4AI-15, S9) — IO vrstva nad
 * dočasnou indexer DB (kópia DDL, pravdivosť schémy strážia indexer testy).
 * Bez siete: unit coverage validácie, 503/404 rozhodnutí a tvaru odpovede.
 * Proti reálnym relayom+indexeru ide `packages/indexer/test/reputation-
 * integration.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ReputationIndexSource,
  registerReputationRoutes,
} from '../src/reputation-routes.js';
import { wilsonLowerBound } from '../src/reputation.js';

const PK_Q = '1'.repeat(64); // autor otázky + accept
const PK_A = '2'.repeat(64); // autor odpovede
const PK_V = '3'.repeat(64); // volič +1 (platná epocha)
const PK_V2 = '4'.repeat(64); // volič -1 (stará epocha → váha 0)
const PK_R = '5'.repeat(64); // ratingovateľ
const PK_PROFILE_ONLY = '6'.repeat(64); // má len kind 0 — 200 s nulami
const PK_UNKNOWN = '9'.repeat(64);

const THREAD_ID = 'a1'.padEnd(64, '0');
const REPLY_ID = 'b1'.padEnd(64, '0');

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
     VALUES (?, ?, ?, ?, ?, ?, '', '', NULL, 0)`,
  );
  const j = (tags: unknown[]) => JSON.stringify(tags);
  insert.run(THREAD_ID, PK_Q, 1020, 1_000, 'ako na tokio drain?', j([['t', 'lang/rust']]));
  insert.run(REPLY_ID, PK_A, 1023, 1_001, 'timeout na drain', j([['e', THREAD_ID, 'root']]));
  insert.run('c'.repeat(64), PK_V, 1030, 1_002, '+1', j([
    ['e', REPLY_ID, ''],
    ['e', THREAD_ID, 'root'],
    ['op', 'oper-a'],
    ['epoch', '2'],
  ]));
  insert.run('d'.repeat(64), PK_V2, 1030, 1_003, '-1', j([
    ['e', REPLY_ID, ''],
    ['e', THREAD_ID, 'root'],
    ['epoch', '1'], // stará epocha → váha 0
  ]));
  insert.run('e'.repeat(64), PK_R, 1031, 1_004, '{"score":4}', j([
    ['e', REPLY_ID, ''],
    ['e', THREAD_ID, 'root'],
    ['epoch', '2'],
  ]));
  insert.run('f'.repeat(64), PK_Q, 1032, 1_005, '', j([
    ['e', REPLY_ID, ''],
    ['e', THREAD_ID, 'root'],
  ]));
  insert.run('0'.repeat(64), PK_PROFILE_ONLY, 0, 1_006, '{"name":"len profil"}', j([]));
  writer.close();
}

const dir = mkdtempSync(join(tmpdir(), 'f4ai-gw-reputation-'));
const dbPath = join(dir, 'index.db');
const missingPath = join(dir, 'nope.db');

function buildApp(path: string | null): Hono {
  const app = new Hono();
  registerReputationRoutes(app, { path, logger: () => undefined });
  return app;
}

let app: Hono;

beforeAll(() => {
  seed(dbPath);
  app = buildApp(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface DomainBody {
  score: number;
  n_eff: number;
  positive: number;
  total: number;
}

interface ReputationBody {
  phase?: string;
  pubkey?: string;
  epoch?: number | null;
  domain?: string;
  domains?: Record<string, DomainBody>;
  counts?: Record<string, number>;
  params?: Record<string, number>;
  untrusted?: string;
  error?: string;
  reason?: string;
}

describe('GET /reputation/:pubkey — validácia a chybové kódy', () => {
  it('400 pre pubkey mimo 64-hex', async () => {
    const res = await app.request('/reputation/zzz');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid pubkey');
  });

  it('400 pre neznámy domain filter', async () => {
    const res = await app.request(`/reputation/${PK_Q}?domain=bogus`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid domain');
  });

  it('503 keď GATEWAY_INDEX_DB chýba (rozhodnutie: žiadny tichý fallback)', async () => {
    const res = await buildApp(null).request(`/reputation/${PK_Q}`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('index unavailable');
  });

  it('503 keď DB súbor neexistuje', async () => {
    const res = await buildApp(missingPath).request(`/reputation/${PK_Q}`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe('index unavailable');
    expect(body.reason).toContain('does not exist');
  });

  it('404 pre pubkey bez jedinej stopy v indexe', async () => {
    const res = await app.request(`/reputation/${PK_UNKNOWN}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('pubkey not found');
  });
});

describe('GET /reputation/:pubkey — kartička', () => {
  it('200 plná karta: epoch watermark, domény, counts, params, untrusted', async () => {
    const res = await app.request(`/reputation/${PK_V}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReputationBody;
    expect(body.phase).toBe('S9');
    expect(body.pubkey).toBe(PK_V);
    expect(body.epoch).toBe(2); // max viditeľná epoch v datasete
    expect(Object.keys(body.domains ?? {}).sort()).toEqual(['author', 'helper', 'voter']);
    // V: 1 hlas (+1 na akceptovanú odpoveď) → správny, total 1
    expect(body.domains?.voter).toEqual({
      score: wilsonLowerBound(1, 1),
      n_eff: 1,
      positive: 1,
      total: 1,
    });
    expect(body.domains?.author.total).toBe(0);
    expect(body.domains?.helper.total).toBe(0);
    expect(body.counts?.votes_cast).toBe(1);
    expect(body.params).toEqual({ z: 1.96, agent_cap: 0.5, cluster_cap: 0.15, op_cap: 0.25 });
    expect(body.untrusted).toContain('untrusted');
  });

  it('stará epocha: V2 má votes_cast 1 ale voter total 0 (váha 0 = žiadny dôkaz)', async () => {
    const res = await app.request(`/reputation/${PK_V2}`);
    const body = (await res.json()) as ReputationBody;
    expect(body.counts?.votes_cast).toBe(1);
    expect(body.domains?.voter.total).toBe(0);
    expect(body.domains?.voter.score).toBe(0);
  });

  it('author doména: Q s akceptovanou otázkou → positive 1/1', async () => {
    const res = await app.request(`/reputation/${PK_Q}`);
    const body = (await res.json()) as ReputationBody;
    expect(body.domains?.author).toEqual({
      score: wilsonLowerBound(1, 1),
      n_eff: 1,
      positive: 1,
      total: 1,
    });
    expect(body.counts?.accepted_solutions).toBe(1);
  });

  it('helper doména: A s +1 a acceptom → positive 1/1', async () => {
    const res = await app.request(`/reputation/${PK_A}`);
    const body = (await res.json()) as ReputationBody;
    expect(body.domains?.helper.total).toBe(1);
    expect(body.domains?.helper.positive).toBe(1);
  });

  it('pubkey s len kind 0 profilom → 200 s nulovými doménami (nie 404)', async () => {
    const res = await app.request(`/reputation/${PK_PROFILE_ONLY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReputationBody;
    for (const domain of Object.values(body.domains ?? {})) {
      expect(domain.total).toBe(0);
      expect(domain.score).toBe(0);
    }
  });

  it('?domain=voter vráti len doménu voter a označí ju', async () => {
    const res = await app.request(`/reputation/${PK_V}?domain=voter`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReputationBody;
    expect(body.domain).toBe('voter');
    expect(Object.keys(body.domains ?? {})).toEqual(['voter']);
    expect(body.domains?.voter.positive).toBe(1);
  });

  it('?domain=author na čistom voličovi → nulová doména, nie chyba', async () => {
    const res = await app.request(`/reputation/${PK_V}?domain=author`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReputationBody;
    expect(body.domains?.author.total).toBe(0);
  });

  it('prepísané parametre sa premietnu do odpovede', async () => {
    const tuned = new Hono();
    registerReputationRoutes(tuned, {
      path: dbPath,
      params: { clusterCap: 0.5, opCap: 0.4 },
      logger: () => undefined,
    });
    const res = await tuned.request(`/reputation/${PK_V}`);
    const body = (await res.json()) as ReputationBody;
    expect(body.params).toEqual({ z: 1.96, agent_cap: 0.5, cluster_cap: 0.5, op_cap: 0.4 });
  });
});

describe('ReputationIndexSource', () => {
  it('availability() je available po úspešnom otvorení a false pre chýbajúcu DB', () => {
    const good = new ReputationIndexSource({ path: dbPath, logger: () => undefined });
    expect(good.availability().available).toBe(true);
    good.close();
    const bad = new ReputationIndexSource({ path: missingPath, logger: () => undefined });
    const status = bad.availability();
    expect(status.available).toBe(false);
    expect(status.path).toBe(missingPath);
    bad.close();
  });

  it('loadEvents vráti len reputačné kindy, deterministicky zoradené', () => {
    const source = new ReputationIndexSource({ path: dbPath, logger: () => undefined });
    const events = source.loadEvents();
    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds.has(0)).toBe(false); // kind 0 nepatrí do replay okna
    expect(kinds).toEqual(new Set([1020, 1023, 1030, 1031, 1032]));
    const ids = events.map((event) => event.id);
    expect([...ids].sort()).toEqual(ids); // created_at ASC → tu aj id ASC
    source.close();
  });
});
