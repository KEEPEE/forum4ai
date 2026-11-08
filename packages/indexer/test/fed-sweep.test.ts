/**
 * Testy sweepu gateway `fed.db` → `indexer.db` (Phase 6a, dizajn Q5).
 *
 * Prečo sweep vôbec existuje: PULL uloží cudzie eventy do `fed.db`, ale
 * NIE do lokálnych relays (to je práca `strfry router` stream-down).
 * Indexer sa živí z relays, takže bez tohto mosta by `GET /search` v A
 * nikdy nenašiel vlákno z B — čo je presne E2E krok dizajnu Q5
 * („`/search?q=<uuid>` nájde vlákno druhej inštancie").
 *
 * Schému `remote_events` tu vedome KOPÍRUJEME ako DDL (rovnaký prístup ako
 * `gateway/test/search-routes.test.ts` s `INDEXER_SCHEMA`): indexer je
 * cudzí čitateľ, ktorý sa viaže LEN na tvar tabuľky, nie na import z
 * gateway balíka. Ak gateway schému zmení, tento test padne a pripomenie,
 * že sa musí dohodnúť verzia.
 *
 * Strážia sa: `origin` + `trusted = 0`, perzistencia kurzora v
 * `indexer_meta` (indexer je JEDINÝ writer), davkovanie, dedup per id s
 * PREDNOSŤOU domáceho zdroja (`self`/`trusted = 1`), odmietnutý podpis,
 * filter kindov a to, že chýbajúca `fed.db` ROZBIJE sweep ale NIKDY ingest.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KINDS } from '@forum4ai/shared';

import { resolveIndexerConfig, type IndexerConfig } from '../src/config.js';
import { IndexerDb } from '../src/db.js';
import { FedSource, FED_SWEEP_BATCH_DEFAULT, FED_SWEEP_CURSOR_KEY } from '../src/fed.js';
import { IndexerIngestor, type IngestPool } from '../src/ingest.js';

const UP = 'aiforum.myhood.sk';
const T0 = 1_730_000_000;
const KEY = generateSecretKey();

/** DDL kopie tabuľky, ktorú vlastní gateway (čítame ju read-only) */
const REMOTE_EVENTS_DDL = `
CREATE TABLE remote_events (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  addr TEXT,
  slug TEXT,
  parent_addr TEXT,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  sig TEXT NOT NULL,
  event_json TEXT NOT NULL,
  pulled_at INTEGER NOT NULL
);
`;

function event(kind: number, content: string, created_at: number, tags: string[][] = []): Event {
  return finalizeEvent({ kind, created_at, tags, content }, KEY) as unknown as Event;
}

/** vložiť riadok do `remote_events` — presne ako to robí gateway pri PULLe */
function insertRemote(path: string, origin: string, ev: Event, eventJson?: string): void {
  const db = new Database(path);
  db.prepare(
    `INSERT INTO remote_events
       (id, origin, pubkey, kind, created_at, addr, slug, parent_addr, content, tags_json, sig, event_json, pulled_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    ev.id,
    origin,
    ev.pubkey,
    ev.kind,
    ev.created_at,
    ev.content,
    JSON.stringify(ev.tags),
    ev.sig,
    eventJson ?? JSON.stringify(ev),
    Date.now(),
  );
  db.close();
}

const dir = mkdtempSync(join(tmpdir(), 'f4ai-fed-sweep-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** vytvoriť prázdnu `fed.db` s kopiou schémy gatewaya */
function makeFedDb(name: string): string {
  const path = join(dir, `${name}.db`);
  const db = new Database(path);
  db.exec(REMOTE_EVENTS_DDL);
  db.close();
  return path;
}

describe('FedSource — sweep cudzieho obsahu do indexu', () => {
  let path: string;
  let db: IndexerDb;
  let source: FedSource;

  beforeAll(() => {
    path = makeFedDb('main');
    db = new IndexerDb(':memory:');
    source = new FedSource({ path, db, logger: () => undefined });
  });

  it('cudzí event skončí v indexe s `origin` upstreamu a `trusted = 0`', () => {
    const post = event(KINDS.QUESTION, 'vlakno z B s tokenom alpha', T0 + 10);
    insertRemote(path, UP, post);

    const summary = source.sweep();
    expect(summary).toMatchObject({ scanned: 1, inserted: 1, ignored: 0, invalid: 0, skipped: 0 });
    expect(summary.cursor).toBeGreaterThan(0);

    const row = db.getEvent(post.id);
    expect(row).not.toBeNull();
    expect(row?.origin).toBe(UP);
    expect(row?.trusted).toBe(0);

    // Q5 E2E: `GET /search?q=<uuid>` BEZ parametra nájde aj cudzie vlákno
    expect(db.search('alpha').map((hit) => hit.id)).toContain(post.id);
    // a filter pôvodu funguje obojsmerne
    expect(db.search('alpha', { origin: UP }).map((hit) => hit.id)).toContain(post.id);
    expect(db.search('alpha', { origin: 'self' })).toEqual([]);
    expect(db.search('alpha', { origin: 'cudzak.example' })).toEqual([]);

    const hits = db.search('alpha', { origin: UP });
    expect(hits[0]).toMatchObject({ origin: UP, trusted: false });
  });

  it('kurzor je perzistentný v `indexer_meta` a ďalší sweep skenuje len prírastok', () => {
    const cursor = source.cursor();
    expect(cursor).toBeGreaterThan(0);
    expect(db.getMeta(FED_SWEEP_CURSOR_KEY)).toBe(String(cursor));

    // žiadny prírastok = nulový sweep (kolečko nesmie znova indexovať všetko)
    expect(source.sweep()).toMatchObject({ scanned: 0, inserted: 0, cursor });

    const fresh = event(KINDS.POST, 'druhé vlakno z B tokenom bravo', T0 + 20, [
      ['e', 'c'.repeat(64), 'root'],
    ]);
    insertRemote(path, UP, fresh);
    const second = source.sweep();
    expect(second).toMatchObject({ scanned: 1, inserted: 1 });
    expect(second.cursor).toBeGreaterThan(cursor);
    expect(source.lastSweep()).toEqual(second);
  });

  it('davkuje podľa `batch` a kurzor rastie monotónne', () => {
    const batchPath = makeFedDb('batch');
    const batchDb = new IndexerDb(':memory:');
    const batched = new FedSource({ path: batchPath, db: batchDb, batch: 2, logger: () => undefined });
    for (let i = 0; i < 5; i += 1) {
      insertRemote(batchPath, UP, event(KINDS.QUESTION, `davkovana otazka ${String(i)}`, T0 + 100 + i));
    }

    expect(batched.sweep()).toMatchObject({ scanned: 2, inserted: 2 });
    const afterFirst = batched.cursor();
    expect(batched.sweep()).toMatchObject({ scanned: 2, inserted: 2 });
    expect(batched.cursor()).toBeGreaterThan(afterFirst);
    expect(batched.sweep()).toMatchObject({ scanned: 1, inserted: 1 });
    expect(batched.sweep()).toMatchObject({ scanned: 0 });
    expect(batchDb.count()).toBe(5);
    // default davky je 500 (remote_events môžu byť tisíce)
    expect(FED_SWEEP_BATCH_DEFAULT).toBe(500);
    batchDb.close();
  });

  it('dedup per id: domáci `self` má PREDNOSŤ pred cudzím kópiou', () => {
    const shared = event(KINDS.QUESTION, 'vlakno, ktore mame aj sami', T0 + 30);
    // najprv ako DOMÁCI obsah (ingest z relays)
    expect(db.upsertEvent(shared as never)).toBe('inserted');
    // potom ho upstream pošle späť (split-horizon zlyhal by u cudzieho peeru)
    insertRemote(path, UP, shared);

    const summary = source.sweep();
    expect(summary).toMatchObject({ scanned: 1, inserted: 0, ignored: 1 });
    const row = db.getEvent(shared.id);
    // lokálny zdroj vyhráva: origin ani trusted sa NESMÚ prepísať
    expect(row?.origin).toBe('self');
    expect(row?.trusted).toBe(1);
  });

  it('poškodený podpis aj neplatný JSON = `invalid` a nič v indexe', () => {
    const brokenSig = { ...event(KINDS.QUESTION, 'pozmeneny podpis', T0 + 40), sig: 'f'.repeat(128) };
    insertRemote(path, UP, brokenSig as never);
    const notJson = event(KINDS.QUESTION, 'neplatny json', T0 + 41);
    insertRemote(path, UP, notJson, '{this is not json');

    const summary = source.sweep();
    expect(summary).toMatchObject({ scanned: 2, inserted: 0, invalid: 2 });
    expect(db.getEvent(brokenSig.id)).toBeNull();
    expect(db.getEvent(notJson.id)).toBeNull();
  });

  it('kind mimo `INDEXER_KINDS` sa preskočí (`skipped`), nie indexuje', () => {
    const path2 = makeFedDb('kinds');
    const db2 = new IndexerDb(':memory:');
    const source2 = new FedSource({
      path: path2,
      db: db2,
      kinds: [KINDS.QUESTION, KINDS.POST],
      logger: () => undefined,
    });
    insertRemote(path2, UP, event(KINDS.QUESTION, 'povolena otazka', T0 + 50));
    insertRemote(path2, UP, event(KINDS.REACTION, 'reakcia mimo kindov', T0 + 51));

    const summary = source2.sweep();
    expect(summary).toMatchObject({ scanned: 2, inserted: 1, skipped: 1 });
    expect(db2.count()).toBe(1);
    db2.close();
  });

  it('prázdny `origin` v riadku = pubkey autora (nikdy prázdny reťazec v indexe)', () => {
    const path3 = makeFedDb('empty-origin');
    const db3 = new IndexerDb(':memory:');
    const source3 = new FedSource({ path: path3, db: db3, logger: () => undefined });
    const ev = event(KINDS.QUESTION, 'riadok bez originu', T0 + 60);
    insertRemote(path3, '', ev);
    expect(source3.sweep()).toMatchObject({ scanned: 1, inserted: 1 });
    expect(db3.getEvent(ev.id)?.origin).toBe(ev.pubkey);
    db3.close();
  });

  it('chýbajúca `fed.db` = `error`, `available = false` a ŽIADNE vyhnutie', () => {
    const missing = join(dir, 'neexistuje.db');
    const db4 = new IndexerDb(':memory:');
    const source4 = new FedSource({ path: missing, db: db4, logger: () => undefined });
    const summary = source4.sweep();
    expect(summary.error).toBe('fed.db unavailable');
    expect(summary.scanned).toBe(0);
    expect(source4.available).toBe(false);
    // druhý sweep už ani neskúša otvárať (trvalo broken)
    expect(source4.sweep().error).toBe('fed.db unavailable');
    // indexer NESMIE vytvoriť prázdnu fed.db — gateway by na nej padol
    // na inej schéme (`fileMustExist: true`)
    db4.close();
    expect(existsSync(missing)).toBe(false);
  });

  it('cudzía SQLite (nie fed.db) = `error` s hláškou schémy, ingest beží ďalej', () => {
    const foreign = join(dir, 'cudzia.db');
    const raw = new Database(foreign);
    raw.exec('CREATE TABLE nieco_inne (id TEXT);');
    raw.close();

    const db5 = new IndexerDb(':memory:');
    const source5 = new FedSource({ path: foreign, db: db5, logger: () => undefined });
    const summary = source5.sweep();
    expect(summary.error).toContain('remote_events');
    expect(summary.scanned).toBe(0);
    db5.close();
  });

  it('by_origin agreguje cudzí obsah (diagnostika `indexer status`)', () => {
    const rows = db.stats().by_origin ?? [];
    const remote = rows.find((row) => row.origin === UP);
    expect(remote).toBeDefined();
    expect(remote?.trusted).toBe(0);
    expect(remote?.count ?? 0).toBeGreaterThan(0);
    expect(rows.find((row) => row.origin === 'self')?.trusted).toBe(1);
  });

  afterAll(() => {
    source.close();
    db.close();
  });
});

// ── zapojenie do ingestora ─────────────────────────────────────────────────

describe('IndexerIngestor — sweep a počítadlo `remoteIndexed`', () => {
  class NullPool implements IngestPool {
    readonly urls = ['ws://fake-a'];
    connectAll(): Promise<unknown> {
      return Promise.resolve([]);
    }
    async query(): Promise<Event[]> {
      return [];
    }
    subscribe(): () => void {
      return () => undefined;
    }
  }

  function testConfig(overrides: Record<string, string> = {}): IndexerConfig {
    return resolveIndexerConfig({
      INDEXER_DB: ':memory:',
      INDEXER_RELAY_URLS: 'ws://fake-a',
      INDEXER_ANTI_ENTROPY_INTERVAL_S: '0',
      INDEXER_LIVE_OVERLAP_S: '7200',
      INDEXER_QUERY_TIMEOUT_MS: '500',
      INDEXER_QUIET: '1',
      ...overrides,
    });
  }

  it('`INDEXER_FED_DB` nastavený → `sweepFed()` indexuje a scíta `remoteIndexed`', () => {
    const path = makeFedDb('ingest');
    insertRemote(path, UP, event(KINDS.QUESTION, 'ingest sweep otazka', T0 + 70));

    const db = new IndexerDb(':memory:');
    const config = testConfig({ INDEXER_FED_DB: path });
    expect(config.fedDb).toBe(path);
    const ingestor = new IndexerIngestor({ db, pool: new NullPool(), config });
    expect(ingestor.fed).not.toBeNull();

    const summary = ingestor.sweepFed();
    expect(summary).toMatchObject({ scanned: 1, inserted: 1 });
    expect(ingestor.snapshot().remoteIndexed).toBe(1);
    // druhý sweep je lacný (kurzor) a počítadlo nerastie
    expect(ingestor.sweepFed()).toMatchObject({ scanned: 0 });
    expect(ingestor.snapshot().remoteIndexed).toBe(1);
    ingestor.stop();
    db.close();
  });

  it('bez `INDEXER_FED_DB` je sweep vypnutý a hlási dôvod (žiadne ticho)', () => {
    const db = new IndexerDb(':memory:');
    const config = testConfig();
    expect(config.fedDb).toBeNull();
    const ingestor = new IndexerIngestor({ db, pool: new NullPool(), config });
    expect(ingestor.fed).toBeNull();
    expect(ingestor.sweepFed()).toMatchObject({ scanned: 0, error: 'INDEXER_FED_DB not set' });
    expect(ingestor.snapshot().remoteIndexed).toBe(0);
    ingestor.stop();
    db.close();
  });

  it('interval sweepu sa nevytvorí bez `INDEXER_FED_DB` (pred 6a = bez novej záťaže)', () => {
    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool: new NullPool(), config: testConfig() });
    // `start()` by spustil backfill; tu len overíme, že fed timer nie je
    // nastavený ani po štarte bez konfigurácie
    void ingestor.start();
    expect(ingestor.fed).toBeNull();
    ingestor.stop();
    db.close();
  });
});
