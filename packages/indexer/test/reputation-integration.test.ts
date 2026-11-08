/**
 * Integračný test S9 (F4AI-15) — reputácia nad **reálnym** logom relayov.
 *
 * Režij:
 *   publish 1020 + 2× 1023 + 1031 + 1032 + 4× 1030 (s `op`/`epoch` tagmi)
 *     → relaye 127.0.0.1 (náš :18080 + strfry :18008)
 *       → indexer na dočasnej DB (prísny registry režim)
 *         → gateway s `GATEWAY_INDEX_DB` = tá istá DB (read-only)
 *           → GET /reputation/:pubkey (domény, counts, epoch, 404/400)
 *           → GET /threads/:id (rating agregát + accepted flag)
 *
 * `epoch` tagy testov používajú hodnotu 999999 — watermark datasetu je
 * maximum viditeľnej epochy, preto MUSÍ byť nad všetkými historickými
 * epoch-tagovanými eventmi na relayi (iný test epoch tag na relaye
 * nepoužíva — overené grep-om 2026-10-29). Hlas v epoche 1 je záporný
 * príklad: staršia epocha → váha 0 → voter total 0 pri votes_cast 1.
 *
 * Suite sa preskočí, ak sú relaye nedosiahnuteľné — unit testy
 * (`packages/gateway/test/reputation*.test.ts`) pokrývajú tú istú logiku
 * bez siete. Relaye odpovedajú OK skôr, než je zápis viditeľný pre REQ
 * (strfry race, známy PIT), preto všetky dotazy bežia cez retry helper.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

import {
  buildGateway,
  startGatewayServer,
  type GatewayRuntime,
  type RunningGateway,
} from '@forum4ai/gateway';
import { KINDS } from '@forum4ai/shared';

import { buildIndexerRuntime, type IndexerRuntime } from '../src/config.js';
import { DEV_RELAY_URLS } from './dev-relays.js';

const RELAYS = [...DEV_RELAY_URLS];
const NET_TIMEOUT = 30_000;
const S9_TIMEOUT = 120_000;
const EPOCH = '999999';

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

async function eventually<T>(
  attempt: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  attempts = 12,
): Promise<T> {
  let last: unknown = new Error('eventually: žiadny pokus');
  for (let i = 0; i < attempts; i += 1) {
    try {
      const value = await attempt();
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
}

interface ThreadBody {
  root?: { id: string };
  reply_count?: number;
  rating?: {
    count: number;
    mean: number;
    mean15: number;
    n_eff: number;
    wilson: number;
    accepted: boolean;
    accepted_count: number;
  };
}

describe.skipIf(!relaysOnline)('reputácia — integrácia relay → indexer → gateway (127.0.0.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f4ai-s9-reputation-'));
  const dbPath = join(dir, 'reputation.db');
  const token = Math.random().toString(36).slice(2, 10);

  const skQ = generateSecretKey();
  const skA1 = generateSecretKey();
  const skA2 = generateSecretKey();
  const skV1 = generateSecretKey();
  const skV2 = generateSecretKey();
  const skV3 = generateSecretKey();
  const skV4 = generateSecretKey();
  const skR = generateSecretKey();
  const pkQ = getPublicKey(skQ);
  const pkA1 = getPublicKey(skA1);
  const pkV1 = getPublicKey(skV1);
  const pkV4 = getPublicKey(skV4);

  const envFor = (path: string): Record<string, string> => ({
    INDEXER_DB: path,
    INDEXER_RELAY_URLS: RELAYS.join(' '),
    INDEXER_KINDS: '1020,1023,1030,1031,1032',
    INDEXER_BACKFILL_BATCH: '100',
    INDEXER_BACKFILL_WINDOW_S: '3600',
    INDEXER_ANTI_ENTROPY_INTERVAL_S: '0',
    INDEXER_LIVE_OVERLAP_S: '900',
    INDEXER_QUERY_TIMEOUT_MS: '15000',
    INDEXER_REQUIRE_REGISTRY: '1',
    INDEXER_QUIET: '1',
  });

  let runtime: IndexerRuntime;
  let gateway: GatewayRuntime;
  let server: RunningGateway;
  let base: string;

  let question: Event;
  let reply1: Event;
  let reply2: Event;
  let rating: Event;
  let accept: Event;
  let vote1: Event;
  let vote2: Event;
  let vote3: Event;
  let voteOld: Event;

  beforeAll(async () => {
    const now = Math.floor(Date.now() / 1000);
    const sign = (sk: Uint8Array, kind: number, tags: string[][], content: string, age: number) =>
      finalizeEvent({ kind, created_at: now - age, tags, content }, sk);

    question = sign(skQ, KINDS.QUESTION, [['t', 'f4ai15']], `Reputacny test otazka token ${token}`, 120);
    reply1 = sign(skA1, KINDS.POST, [['e', question.id, 'root']], `Odpoved A1 token ${token}`, 110);
    reply2 = sign(skA2, KINDS.POST, [['e', question.id, 'root']], `Odpoved A2 token ${token}`, 105);
    rating = sign(
      skR,
      KINDS.SOLUTION_RATING,
      [['e', reply1.id, ''], ['e', question.id, 'root'], ['epoch', EPOCH]],
      '{"score":4}',
      90,
    );
    accept = sign(
      skQ,
      KINDS.ACCEPTED_SOLUTION,
      [['e', reply1.id, ''], ['e', question.id, 'root']],
      '',
      80,
    );
    vote1 = sign(
      skV1,
      KINDS.VOTE,
      [['e', reply1.id, ''], ['e', question.id, 'root'], ['op', 'op-alpha'], ['epoch', EPOCH]],
      '+1',
      70,
    );
    vote2 = sign(
      skV2,
      KINDS.VOTE,
      [['e', reply1.id, ''], ['e', question.id, 'root'], ['op', 'op-beta'], ['epoch', EPOCH]],
      '+1',
      60,
    );
    vote3 = sign(
      skV3,
      KINDS.VOTE,
      [['e', reply2.id, ''], ['e', question.id, 'root'], ['epoch', EPOCH]],
      '-1',
      50,
    );
    voteOld = sign(
      skV4,
      KINDS.VOTE,
      [['e', reply1.id, ''], ['e', question.id, 'root'], ['epoch', '1']],
      '+1',
      40,
    );

    runtime = buildIndexerRuntime(envFor(dbPath));
    await runtime.ingestor.start();

    for (const event of [question, reply1, reply2, rating, accept, vote1, vote2, vote3, voteOld]) {
      await publishToAll(event);
    }

    // indexer musí mať VŠETKY eventy v DB skôr, než začneme čítať reputáciu
    const ids = [question, reply1, reply2, rating, accept, vote1, vote2, vote3, voteOld].map(
      (event) => event.id,
    );
    await eventually(() => {
      const stmt = runtime.db.db.prepare('SELECT id FROM events WHERE id = ?');
      return ids.every((id) => stmt.get(id) !== undefined);
    }, 20);

    gateway = buildGateway(
      { GATEWAY_QUIET: '1', GATEWAY_INDEX_DB: dbPath, GATEWAY_RELAY_URLS: RELAYS.join(' ') },
      { disableWebsocket: true },
    );
    server = await startGatewayServer(gateway.app, { port: 0, hostname: '127.0.0.1' });
    base = server.url;
  }, S9_TIMEOUT);

  afterAll(async () => {
    try {
      await server?.close();
      gateway?.search?.close();
      gateway?.reputation?.close();
      gateway?.pool.close();
      runtime?.ingestor.stop();
      (runtime?.pool as { close?: () => void } | undefined)?.close?.();
      runtime?.db.close();
    } catch {
      /* úklid nesmie hodiť */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (path: string): Promise<{ status: number; body: ReputationBody | ThreadBody }> => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as ReputationBody | ThreadBody };
  };

  it(
    'GET /reputation/:volič — voter doména s očakávanými countmi a epoch watermarkom',
    async () => {
      const { status, body } = await get(`/reputation/${pkV1}`);
      expect(status).toBe(200);
      const card = body as ReputationBody;
      expect(card.phase).toBe('S9');
      expect(card.epoch).toBe(999999);
      // V1: +1 na reply1, ktorá dostala 1032 → správny hlas
      expect(card.domains?.voter.total).toBe(1);
      expect(card.domains?.voter.positive).toBe(1);
      expect(card.domains?.voter.score).toBeGreaterThan(0);
      expect(card.domains?.voter.n_eff).toBeCloseTo(1, 9);
      expect(card.counts?.votes_cast).toBe(1);
      expect(card.params).toEqual({ z: 1.96, agent_cap: 0.5, cluster_cap: 0.15, op_cap: 0.25 });
      expect(card.untrusted).toContain('untrusted');
    },
    NET_TIMEOUT,
  );

  it(
    'stará epocha: V4 hlas má váhu 0 → voter total 0, votes_cast 1',
    async () => {
      const { status, body } = await get(`/reputation/${pkV4}`);
      expect(status).toBe(200);
      const card = body as ReputationBody;
      expect(card.counts?.votes_cast).toBe(1);
      expect(card.domains?.voter.total).toBe(0);
      expect(card.domains?.voter.score).toBe(0);
    },
    NET_TIMEOUT,
  );

  it(
    'GET /reputation/:autor_otázky — author doména 1/1 s akceptovaným riešením',
    async () => {
      const { status, body } = await get(`/reputation/${pkQ}`);
      expect(status).toBe(200);
      const card = body as ReputationBody;
      expect(card.domains?.author.total).toBe(1);
      expect(card.domains?.author.positive).toBe(1);
      expect(card.counts?.accepted_solutions).toBe(1);
      expect(card.counts?.threads_authored).toBe(1);
    },
    NET_TIMEOUT,
  );

  it(
    'GET /reputation/:autor_odpovede — helper doména 1/1 (+1 hlas a accept)',
    async () => {
      const { status, body } = await get(`/reputation/${pkA1}`);
      expect(status).toBe(200);
      const card = body as ReputationBody;
      expect(card.domains?.helper.total).toBe(1);
      expect(card.domains?.helper.positive).toBe(1);
      expect(card.counts?.replies_authored).toBe(1);
    },
    NET_TIMEOUT,
  );

  it(
    '?domain=voter vráti len doménu voter',
    async () => {
      const { status, body } = await get(`/reputation/${pkV1}?domain=voter`);
      expect(status).toBe(200);
      const card = body as ReputationBody;
      expect(card.domain).toBe('voter');
      expect(Object.keys(card.domains ?? {})).toEqual(['voter']);
    },
    NET_TIMEOUT,
  );

  it(
    '404 pre neznámy pubkey a 400 pre zlý domain filter',
    async () => {
      const unknown = await get(`/reputation/${'7'.repeat(64)}`);
      expect(unknown.status).toBe(404);
      expect((unknown.body as ReputationBody).error).toBe('pubkey not found');

      const badDomain = await get(`/reputation/${pkV1}?domain=xx`);
      expect(badDomain.status).toBe(400);
      expect((badDomain.body as ReputationBody).error).toBe('invalid domain');
    },
    NET_TIMEOUT,
  );

  it(
    'GET /threads/:id — rating agregát (mean z 1031, accepted flag z 1032)',
    async () => {
      const thread = await eventually(async () => {
        const { status, body } = await get(`/threads/${question.id}`);
        if (status !== 200) return null;
        const t = body as ThreadBody;
        if (!t.rating || t.rating.count < 1 || !t.rating.accepted) return null;
        return t;
      }, 15);
      expect(thread.root?.id).toBe(question.id);
      expect(thread.reply_count).toBe(2);
      const ratingAgg = thread.rating as NonNullable<ThreadBody['rating']>;
      expect(ratingAgg.count).toBe(1);
      // score 4 → normalizované 0.75 (jeden rating, cluster strop nemení priemer)
      expect(ratingAgg.mean).toBeCloseTo(0.75, 9);
      expect(ratingAgg.mean15).toBeCloseTo(4, 9);
      expect(ratingAgg.n_eff).toBeCloseTo(1, 9);
      expect(ratingAgg.wilson).toBeGreaterThan(0);
      expect(ratingAgg.accepted).toBe(true);
      expect(ratingAgg.accepted_count).toBe(1);
    },
    S9_TIMEOUT,
  );
});
