/**
 * Integračný test indexera proti dev relayom na 127.0.0.1
 * (náš relay :18080 + strfry 1.1.3 :18008) — F4AI-13, S7.
 *
 * Scenár zo zadania: indexer beží na dočasnej DB v /tmp, priamo cez
 * nostr-tools vyšleme 3 eventy (2x ten istý kind 1020 = duplikát, 10030
 * v dvoch verziách = LWW), indexer ich naženie, FTS5 ich nájdi, reštart
 * indexera urobí backfill bez duplicít a anti-entropia reálne prebehne.
 *
 * Suite sa preskočí, ak sú relaye nedosiahnuteľné (unit testy zostávajú
 * deterministické). Retry helper `eventually` zohľadňuje, že relay odpovie
 * OK skôr, než je zápis viditeľný pre concurrent REQ (strfry write race).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

import { DEV_RELAY_URLS } from './dev-relays.js';

import { buildIndexerRuntime, type IndexerRuntime } from '../src/config.js';

const RELAYS = [...DEV_RELAY_URLS];
const NET_TIMEOUT = 30_000;
const S7_TIMEOUT = 120_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function reachable(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const relay = await Relay.connect(url, { timeout: timeoutMs });
    relay.close();
    return true;
  } catch {
    return false;
  }
}

const probes = await Promise.all(RELAYS.map((url) => reachable(url)));
const relaysOnline = probes.every(Boolean);

/** Relay potvrdí OK pred zapísaním do indexu → s retrymi, nie hneď. */
async function eventually<T>(attempt: () => T | null | undefined | false, attempts = 10): Promise<T> {
  let last: unknown = new Error('eventually: žiadny pokus');
  for (let i = 0; i < attempts; i += 1) {
    try {
      const value = attempt();
      if (value) return value;
      last = new Error('eventually: hodnota sa nepodarilo získať');
    } catch (error) {
      last = error;
    }
    await sleep(400 * (i + 1));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function publishToAll(event: Event): Promise<void> {
  for (const url of RELAYS) {
    const relay = await Relay.connect(url, { timeout: NET_TIMEOUT });
    try {
      await relay.publish(event);
    } finally {
      relay.close();
    }
  }
}

describe.skipIf(!relaysOnline)('indexer — integrácia proti dev relayom (127.0.0.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f4ai-indexer-'));
  const dbPath = join(dir, 'indexer.db');
  const author = generateSecretKey();
  const other = generateSecretKey();

  // narrow kinds → rýchly a predvídateľný backfill (relays majú históriu)
  const envFor = (path: string, intervalS: string): Record<string, string> => ({
    INDEXER_DB: path,
    INDEXER_RELAY_URLS: RELAYS.join(' '),
    INDEXER_KINDS: '1020,1021,10030',
    INDEXER_BACKFILL_BATCH: '100',
    INDEXER_ANTI_ENTROPY_INTERVAL_S: intervalS,
    INDEXER_ANTI_ENTROPY_IDS: '50',
    INDEXER_ANTI_ENTROPY_LOOKBACK_S: '600',
    INDEXER_LIVE_OVERLAP_S: '600',
    INDEXER_QUERY_TIMEOUT_MS: '15000',
  });

  let runtime: IndexerRuntime;
  let dup: Event;
  let v1: Event;
  let v2: Event;

  const sign = (secret: Uint8Array, kind: number, content: string, createdAt: number): Event =>
    finalizeEvent({ kind, created_at: createdAt, tags: [['t', `f4ai13${uniq}`]], content }, secret);

  // unikátne tokeny pre FTS5 dopyty — relay má históriu z predchádzajúcich
  // behov testu (29+ zápasov 'reklamacna' pri default limite 25 → nový event
  // by sa do top-25 nedostal); BM25 pri zhodnom texte nerozlíši, preto musí
  // byť vyhľadávaný token per-beh unikátny, nie len 'token <rand>' navyše
  const uniq = Math.random().toString(36).slice(2, 10);
  const diacritickyToken = `reklamačná${uniq}`;
  const lwwNovsiToken = `dvojity2${uniq}`;
  const lwwStarsiToken = `jedinecny1${uniq}`;

  beforeAll(async () => {
    const now = Math.floor(Date.now() / 1000);
    dup = sign(author, 1020, `F4AI-13 duplikovany prispevok token ${uniq} ${diacritickyToken} poistná zmluva`, now - 60);
    v1 = sign(other, 10030, `LWWTOKEN verzia jedna povodny text ${lwwStarsiToken}`, now - 40);
    v2 = sign(other, 10030, `LWWTOKEN verzia dva novejsi text ${lwwNovsiToken}`, now - 20);

    runtime = buildIndexerRuntime(envFor(dbPath, '2'));
    await runtime.ingestor.start();

    // 2x ten istý event (dedup per id) + dve verzie replaceable 10030
    await publishToAll(dup);
    await publishToAll(dup);
    await publishToAll(v1);
    await publishToAll(v2);
  }, S7_TIMEOUT);

  afterAll(async () => {
    try {
      runtime?.ingestor.stop();
      (runtime?.pool as { close?: () => void })?.close?.();
      runtime?.db.close();
    } catch {
      /* úklid nesmie hodiť */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('ingestne duplikát aj LWW verzie a FTS5 ich nájde (diakritika sedí)', { timeout: S7_TIMEOUT }, async () => {
    const db = runtime.db;

    // live doručenie: duplikovaný event musí byť v DB práve raz
    await eventually(() => db.getEvent(dup.id));
    expect(db.getEvent(dup.id)).not.toBeNull();

    // FTS5: vyhľadávanie BEZ diakritiky nájde text S diakritikou (unicode61
    // remove_diacritics 2), aj hashtag z tagu 't' — per-beh unikátne tokeny
    // (história na relai by pri BM25 limite 25 rozhodovala o výsledku)
    const foundDup = await eventually(() =>
      db.search(`reklamacna${uniq}`).find((hit) => hit.id === dup.id),
    );
    expect(foundDup?.id).toBe(dup.id);
    const byTag = await eventually(() => db.search(`f4ai13${uniq}`).find((hit) => hit.id === dup.id));
    expect(byTag?.id).toBe(dup.id);

    // LWW: v DB je len novšia verzia, staršia je prečítaná (a zmizla z FTS)
    await eventually(() => db.getEvent(v2.id));
    expect(db.getEvent(v1.id)).toBeNull();
    expect(db.getEvent(v2.id)?.content).toContain(lwwNovsiToken);

    const foundNew = await eventually(() => db.search(lwwNovsiToken).find((hit) => hit.id === v2.id));
    expect(foundNew?.id).toBe(v2.id);
    expect(db.search(lwwStarsiToken).some((hit) => hit.id === v1.id)).toBe(false);

    // FTS index je konzistentný s tabuľkou (triggery neodpadli)
    expect(() => db.ftsIntegrityCheck()).not.toThrow();
    const stats = db.stats();
    expect(stats.events).toBe(stats.fts_rows);
    expect(stats.by_kind.some((row) => row.kind === 10030)).toBe(true);
  });

  it('anti-entropia reálne beží (rýchly interval) a hlási počítadlá', { timeout: S7_TIMEOUT }, async () => {
    await eventually(() => runtime.ingestor.snapshot().aeCycles >= 1, 8);
    const counters = runtime.ingestor.snapshot();
    expect(counters.aeIdsChecked).toBeGreaterThanOrEqual(1);
    expect(counters.aeCycles).toBeGreaterThanOrEqual(1);
    expect(runtime.ingestor.cacheStats().insertions).toBeGreaterThanOrEqual(1);
  });

  it('reštart urobí backfill bez duplicít (počty sedia, FTS pretrvá)', { timeout: S7_TIMEOUT }, async () => {
    const before = runtime.db.stats();
    const idsBefore = new Set(runtime.db.recentIds(500));
    runtime.ingestor.stop();
    (runtime.pool as { close?: () => void })?.close?.();
    runtime.db.close();

    // druhý beh na tom istom súbore = restart procesu
    const restarted = buildIndexerRuntime(envFor(dbPath, '0'));
    try {
      await restarted.ingestor.start();
      await eventually(() => restarted.db.getEvent(v2.id));
      expect(restarted.db.getEvent(dup.id)).not.toBeNull();
      expect(restarted.db.getEvent(v1.id)).toBeNull();

      const after = restarted.db.stats();
      expect(after.events).toBe(before.events); // žiadne duplikáty
      expect(after.fts_rows).toBe(after.events);
      const idsAfter = new Set(restarted.db.recentIds(500));
      for (const id of idsBefore) expect(idsAfter.has(id)).toBe(true);
      expect(restarted.db.search(lwwNovsiToken).some((hit) => hit.id === v2.id)).toBe(true);
      expect(() => restarted.db.ftsIntegrityCheck()).not.toThrow();

      // tretí beh: počty opäť nesmú narásť
      const third = restarted.db.count();
      restarted.ingestor.stop();
      (restarted.pool as { close?: () => void })?.close?.();
      restarted.db.close();
      const again = buildIndexerRuntime(envFor(dbPath, '0'));
      try {
        await again.ingestor.start();
        expect(again.db.count()).toBe(third);
      } finally {
        again.ingestor.stop();
        (again.pool as { close?: () => void })?.close?.();
        again.db.close();
      }
    } catch (error) {
      restarted.ingestor.stop();
      (restarted.pool as { close?: () => void })?.close?.();
      restarted.db.close();
      throw error;
    }
    runtime = restarted;
  });
});
