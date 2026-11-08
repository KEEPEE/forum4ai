/**
 * Integračný test S10 (F4AI-16) — idea_call lifecycle nad **reálnym** logom
 * relayov.
 *
 * Režij:
 *   publish 1021 (author) → 10030 open→claimed AUTORA (LWW, `a` tag =
 *   claimant) → 10030 od CUDZIEHO pubkey (suggestion) → druhá 1021 bez
 *   statusu (pre MCP claim draft)
 *     → indexer na dočasnej DB (prísny registry režim)
 *       → gateway s `GATEWAY_INDEX_DB` = tá istá DB (read-only)
 *         → GET /ideas (row so status claimed + claimant + suggestions_count 1)
 *         → GET /ideas/:id (status_history + suggestions)
 *         → filtre status/topic, 404/400, 503 bez indexu
 *         → MCP `forum_list_ideas` + `forum_claim_idea` (draft s d-tagom aj
 *           a-tagom; nelegálny prechod → isError s dôvodom)
 *
 * PIT (známy zo S7/S9): relaye odpovedia OK skôr, než je zápis viditeľný
 * pre REQ (strfry write race) → čítania idú cez retry helper. Historické
 * 1021/10030 na relayi (iné testy) odlišujeme **per-beh unikátnym
 * tokenom** v topic tagu — filter `?topic=` vráti len naše riadky.
 *
 * Suite sa preskočí, ak sú relaye nedosiahnuteľné — unit testy
 * (`packages/gateway/test/ideas*.test.ts`, `mcp-ideas.test.ts`) pokrývajú
 * tú istú logiku bez siete.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  GatewayClient,
  buildGateway,
  createForumMcpServer,
  startGatewayServer,
  type GatewayRuntime,
  type RunningGateway,
} from '@forum4ai/gateway';
import { KINDS } from '@forum4ai/shared';

import { buildIndexerRuntime, type IndexerRuntime } from '../src/config.js';
import { DEV_RELAY_URLS } from './dev-relays.js';

const RELAYS = [...DEV_RELAY_URLS];
const NET_TIMEOUT = 30_000;
const S10_TIMEOUT = 180_000;

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

interface IdeaRowBody {
  id: string;
  title?: string;
  description?: string;
  topics?: string[];
  author?: string;
  status?: string;
  claimant?: string | null;
  status_history?: Array<{ status: string; publisher: string; note?: string | null }>;
  suggestions_count?: number;
  rating?: { count: number; accepted: boolean } | null;
}

interface BoardBody {
  phase?: string;
  count?: number;
  items?: IdeaRowBody[];
  error?: string;
  reasons?: string[];
  untrusted?: string;
}

interface DetailBody extends IdeaRowBody {
  phase?: string;
  suggestions?: Array<{ status: string; publisher: string }>;
}

describe.skipIf(!relaysOnline)('idea_call — integrácia relay → indexer → gateway (127.0.0.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f4ai-s10-ideas-'));
  const dbPath = join(dir, 'ideas.db');
  const token = Math.random().toString(36).slice(2, 10);
  const topic = `f4ai16-${token}`;
  const topicB = `f4ai16-${token}-b`;

  const skAuthor = generateSecretKey();
  const skClaimant = generateSecretKey();
  const skSuggester = generateSecretKey();
  const pkAuthor = getPublicKey(skAuthor);
  const pkClaimant = getPublicKey(skClaimant);
  const pkSuggester = getPublicKey(skSuggester);

  const envFor = (path: string): Record<string, string> => ({
    INDEXER_DB: path,
    INDEXER_RELAY_URLS: RELAYS.join(' '),
    INDEXER_KINDS: '1021,10030,1031,1032',
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

  let idea: Event; // claimnutá myšlienka (author → open → claimed)
  let ideaB: Event; // druhá 1021 bez statusu — cieľ MCP claim draftu
  let statusOpen: Event;
  let statusClaimed: Event;
  let suggestion: Event;

  beforeAll(async () => {
    const now = Math.floor(Date.now() / 1000);
    const sign = (sk: Uint8Array, kind: number, tags: string[][], content: string, age: number) =>
      finalizeEvent({ kind, created_at: now - age, tags, content }, sk);

    idea = sign(
      skAuthor,
      KINDS.IDEA_CALL,
      [['t', topic]],
      `Idea call F4AI-16 token ${token}\nDruhy riadok — popis myslienky`,
      120,
    );
    ideaB = sign(skAuthor, KINDS.IDEA_CALL, [['t', topicB]], `Idea B F4AI-16 token ${token}`, 118);
    statusOpen = sign(
      skAuthor,
      KINDS.IDEA_CALL_STATUS,
      [['d', idea.id]],
      JSON.stringify({ status: 'open' }),
      100,
    );
    statusClaimed = sign(
      skAuthor,
      KINDS.IDEA_CALL_STATUS,
      [['d', idea.id], ['a', pkClaimant]],
      JSON.stringify({ status: 'claimed', note: 'claim confirmed by the agent' }),
      60,
    );
    suggestion = sign(
      skSuggester,
      KINDS.IDEA_CALL_STATUS,
      [['d', idea.id]],
      JSON.stringify({ status: 'in_progress' }),
      50,
    );

    runtime = buildIndexerRuntime(envFor(dbPath));
    await runtime.ingestor.start();

    for (const event of [idea, ideaB, statusOpen, statusClaimed, suggestion]) {
      await publishToAll(event);
    }

    // indexer musí mať všetky eventy v DB skôr, než začneme čítať board
    // (statusOpen sa na relayi LWW nahradil statusClaimed — ten MUSÍ byť
    // v DB, open môže, ale nemusí prežiť)
    const ids = [idea.id, ideaB.id, statusClaimed.id, suggestion.id];
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
  }, S10_TIMEOUT);

  afterAll(async () => {
    try {
      await server?.close();
      gateway?.search?.close();
      gateway?.reputation?.close();
      gateway?.ideas?.close();
      gateway?.pool.close();
      runtime?.ingestor.stop();
      (runtime?.pool as { close?: () => void } | undefined)?.close?.();
      runtime?.db.close();
    } catch {
      /* úklid nesmie hodiť */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (path: string): Promise<{ status: number; body: BoardBody | DetailBody }> => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as BoardBody | DetailBody };
  };

  it(
    'GET /ideas?topic: row so status claimed + claimant + suggestions_count 1',
    async () => {
      const row = await eventually(async () => {
        const { status, body } = await get(`/ideas?topic=${topic}`);
        if (status !== 200) return false;
        const items = (body as BoardBody).items ?? [];
        return items.find((r) => r.id === idea.id) ?? false;
      });
      expect(row.status).toBe('claimed'); // kanonický = 10030 autora (LWW: claimed vyhral nad open)
      expect(row.claimant).toBe(pkClaimant); // a-tag potvrdeneho claimu
      expect(row.suggestions_count).toBe(1); // 10030 od cudzieho pubkey
      expect(row.title).toBe(`Idea call F4AI-16 token ${token}`);
      expect(row.description).toBe('Druhy riadok — popis myslienky');
      expect(row.topics).toEqual([topic]);
      expect(row.author).toBe(pkAuthor);
      const board = await get(`/ideas?topic=${topic}`);
      expect((board.body as BoardBody).phase).toBe('S10');
      expect((board.body as BoardBody).count).toBe(1); // per-beh token izoluje od histórie
      expect((board.body as BoardBody).untrusted).toContain('untrusted');
    },
    NET_TIMEOUT,
  );

  it(
    'GET /ideas/:id — status_history (LWW claimed) + suggestions od cudzieho',
    async () => {
      const detail = await eventually(async () => {
        const { status, body } = await get(`/ideas/${idea.id}`);
        if (status !== 200) return false;
        const d = body as DetailBody;
        return d.status === 'claimed' ? d : false;
      });
      expect(detail.status).toBe('claimed');
      expect(detail.claimant).toBe(pkClaimant);
      // DB drží per (autor, d) len LWW víťaza → história = claimed event
      expect(detail.status_history?.length).toBeGreaterThanOrEqual(1);
      const latest = detail.status_history?.at(-1);
      expect(latest?.status).toBe('claimed');
      expect(latest?.publisher).toBe(pkAuthor);
      expect(latest?.note).toBe('claim confirmed by the agent');
      // suggestion = názor cudzieho pubkey, NIE kanonický status
      expect(detail.suggestions).toHaveLength(1);
      expect(detail.suggestions[0]?.publisher).toBe(pkSuggester);
      expect(detail.suggestions[0]?.status).toBe('in_progress');
      expect(detail.suggestions_count).toBe(1);
    },
    NET_TIMEOUT,
  );

  it(
    'druhá idea bez 10030 → status open; filter status=open/claimed',
    async () => {
      const open = await eventually(async () => {
        const { body } = await get(`/ideas?status=open&topic=${topicB}`);
        const items = (body as BoardBody).items ?? [];
        return items.find((r) => r.id === ideaB.id) ?? false;
      });
      expect(open.status).toBe('open');
      expect(open.suggestions_count).toBe(0);

      const claimed = await get(`/ideas?status=claimed&topic=${topic}`);
      expect((claimed.body as BoardBody).items?.map((r) => r.id)).toEqual([idea.id]);

      const noneClaimed = await get(`/ideas?status=claimed&topic=${topicB}`);
      expect((noneClaimed.body as BoardBody).count).toBe(0);
    },
    NET_TIMEOUT,
  );

  it('404 neznáma idea, 400 zlý status', async () => {
    const missing = await get(`/ideas/${'77'.padEnd(64, '0')}`);
    expect(missing.status).toBe(404);
    expect((missing.body as BoardBody).error).toBe('idea not found');

    const bad = await get('/ideas?status=delivered');
    expect(bad.status).toBe(400);
    expect((bad.body as BoardBody).error).toBe('invalid status');
  });

  it('503 bez GATEWAY_INDEX_DB — žiadny tichý fallback', async () => {
    const bare = buildGateway(
      { GATEWAY_QUIET: '1', GATEWAY_RELAY_URLS: RELAYS.join(' ') },
      { disableWebsocket: true },
    );
    const bareServer = await startGatewayServer(bare.app, { port: 0, hostname: '127.0.0.1' });
    try {
      const res = await fetch(`${bareServer.url}/ideas`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as BoardBody;
      expect(body.error).toBe('index unavailable');
    } finally {
      await bareServer.close();
      bare?.ideas?.close();
      bare?.pool.close();
    }
  });

  it(
    'MCP forum_list_ideas + forum_claim_idea: draft s d-tagom aj a-tagom, nelegálny prechod → isError',
    async () => {
      const mcpServer = createForumMcpServer({
        client: new GatewayClient({ baseUrl: base }),
        name: 'forum4ai-s10-test',
        version: '0.0.0-test',
      });
      const mcpClient = new Client({ name: 's10-client', version: '0.0.0' });
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcpServer.connect(serverSide), mcpClient.connect(clientSide)]);

      try {
        // board cez MCP (realny fetch na realny gateway)
        const listed = await mcpClient.callTool({
          name: 'forum_list_ideas',
          arguments: { topic, limit: 10 },
        });
        const listText = (listed.content as Array<{ text?: string }>)[0]?.text ?? '';
        const listPayload = JSON.parse(listText) as {
          ok: boolean;
          items?: Array<{ id: string; status: string; claimant: string | null }>;
        };
        expect(listPayload.ok).toBe(true);
        const row = listPayload.items?.find((r) => r.id === idea.id);
        expect(row?.status).toBe('claimed');
        expect(row?.claimant).toBe(pkClaimant);

        // claim druhej (open) idea → draft kind 10030 s d-tagom aj a-tagom
        const draftCall = await mcpClient.callTool({
          name: 'forum_claim_idea',
          arguments: {
            idea_event_id: ideaB.id,
            status: 'claimed',
            note: 'agent prebera',
            pubkey: pkClaimant,
          },
        });
        const draftText = (draftCall.content as Array<{ text?: string }>)[0]?.text ?? '';
        const draftPayload = JSON.parse(draftText) as {
          ok: boolean;
          status: string;
          draft: { kind: number; tags: string[][]; content: string };
        };
        expect(draftPayload.ok).toBe(true);
        expect(draftPayload.status).toBe('unsigned_draft');
        expect(draftPayload.draft.kind).toBe(KINDS.IDEA_CALL_STATUS);
        // F4AI-2b2: draft nesie NIP-32 jazykový label (default `en`)
        expect(draftPayload.draft.tags).toEqual([
          ['d', ideaB.id],
          ['a', pkClaimant],
          ['L', 'ISO-639-1'],
          ['l', 'en', 'ISO-639-1'],
        ]);
        expect(JSON.parse(draftPayload.draft.content)).toEqual({
          status: 'claimed',
          note: 'agent prebera',
        });

        // nelegálny prechod na realnom stave (claimed → review) → isError s dôvodom
        const illegal = await mcpClient.callTool({
          name: 'forum_claim_idea',
          arguments: { idea_event_id: idea.id, status: 'review', pubkey: pkClaimant },
        });
        const illegalText = (illegal.content as Array<{ text?: string }>)[0]?.text ?? '';
        const illegalPayload = JSON.parse(illegalText) as {
          ok: boolean;
          error?: string;
          reason?: string;
          current_status?: string;
        };
        expect(illegal.isError).toBe(true);
        expect(illegalPayload.error).toContain('illegal');
        expect(illegalPayload.current_status).toBe('claimed');
        expect(illegalPayload.reason).toContain('claimed');
      } finally {
        await mcpClient.close();
        await mcpServer.close();
      }
    },
    NET_TIMEOUT,
  );
});
