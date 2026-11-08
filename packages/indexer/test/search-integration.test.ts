/**
 * Integračný test S8 (F4AI-14) — `GET /search` nad **reálnym** indexom.
 *
 * Režij:
 *   relaye 127.0.0.1 (naše :18080 + strfry :18008)
 *     → indexer na dočasnej DB v /tmp (prísny registry režim)
 *       → gateway s `GATEWAY_INDEX_DB` = tá istá DB (read-only)
 *         → HTTP `GET /search` (BM25, snippet, filtre)
 *           → MCP nástroj `forum_search` (source `fts5`)
 *
 * Overuje sa aj rozhodnutie zo zadania: bez `GATEWAY_INDEX_DB` je odpoveď
 * **503 `index unavailable`** (žiadny tichý fallback) a MCP nástroj vtedy
 * výslovne prejde na `local_scan`.
 *
 * Suite sa preskočí, ak sú relaye nedosiahnuteľné — unit testy
 * (`packages/gateway/test/search*.test.ts`) pokrývajú tú istú logiku
 * bez siete. Relaye odpovedajú OK skôr, než je zápis viditeľný pre REQ,
 * preto všetky dotazy bežia cez retry helper.
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
import { KINDS, validateEvent, verifyFull } from '@forum4ai/shared';

import { buildIndexerRuntime, type IndexerRuntime } from '../src/config.js';
import { DEV_RELAY_URLS } from './dev-relays.js';

const RELAYS = [...DEV_RELAY_URLS];
const NET_TIMEOUT = 30_000;
const S8_TIMEOUT = 120_000;

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

/**
 * Retry helper. Relay potvrdí OK skôr, než je zápis viditeľný pre REQ, a
 * indexer potrebuje ďalšie kolo live subskripcie — preto retry, nie
 * okamžité čítanie.
 */
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

interface SearchHitBody {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  snippet: string;
  score: number;
  addr?: string;
}

interface SearchBody {
  phase?: string;
  query?: string;
  normalized_query?: string;
  took_ms?: number;
  count?: number;
  limit?: number;
  deadline_ms?: number;
  partial?: boolean;
  channels?: string[];
  results?: SearchHitBody[];
  untrusted?: string;
  note?: string;
  error?: string;
  reason?: string;
}

describe.skipIf(!relaysOnline)('search — integrácia indexer → gateway → MCP (127.0.0.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f4ai-s8-search-'));
  const dbPath = join(dir, 'search.db');
  const author = generateSecretKey();
  const solver = generateSecretKey();
  const authorPub = getPublicKey(author);
  const solverPub = getPublicKey(solver);
  const token = Math.random().toString(36).slice(2, 10);

  /**
   * `INDEXER_REQUIRE_REGISTRY=1` — prísny L2 režim. S pribudnutými kindmi
   * 0 a 3 do shared registry (rozhodnutie manažéra (a)) MUSÍ prejsť aj
   * kind 0 — skôr padal na „kind 0 nie je v registry“.
   */
  const envFor = (path: string): Record<string, string> => ({
    INDEXER_DB: path,
    INDEXER_RELAY_URLS: RELAYS.join(' '),
    INDEXER_KINDS: '1020,1023,0',
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
  let post: Event;
  let metadata: Event;

  beforeAll(async () => {
    const now = Math.floor(Date.now() / 1000);
    // unikatne tokeny — nech sa nechytame na historiu inych testov
    question = finalizeEvent(
      {
        kind: KINDS.QUESTION,
        created_at: now - 90,
        tags: [['t', 'f4ai14']],
        content: `Reklamačná poistná zmluva — ako podať reklamačný formulár? token ${token}`,
      },
      author,
    );
    post = finalizeEvent(
      {
        kind: KINDS.POST,
        created_at: now - 60,
        // L2 pravidlo: post (1023) nesie práve jeden `e` tag s markerom
        // `root` (konvencia tohto repo: marker na indexe 2, pozri
        // `rootMarkers` v shared/validators.ts) — bez neho relay odmietne
        tags: [
          ['t', 'f4ai14'],
          ['e', question.id, 'root'],
        ],
        content: `Objasnenie reklamácie u poisťovne token ${token} dve specifika`,
      },
      solver,
    );
    metadata = finalizeEvent(
      {
        kind: KINDS.PROFILE,
        created_at: now - 30,
        tags: [],
        content: JSON.stringify({ name: `f4ai14-${token}`, display_name: 'Reklamačný tester' }),
      },
      author,
    );

    runtime = buildIndexerRuntime(envFor(dbPath));
    await runtime.ingestor.start();

    await publishToAll(question);
    await publishToAll(post);
    await publishToAll(metadata);

    // gateway číta tú istú DB — GATEWAY_INDEX_DB je jediné, čo search zapína
    gateway = buildGateway(
      {
        GATEWAY_QUIET: '1',
        GATEWAY_INDEX_DB: dbPath,
        GATEWAY_SEARCH_DEADLINE_MS: '2000',
        GATEWAY_RELAY_URLS: RELAYS.join(' '),
      },
      { disableWebsocket: true, disableReadRoutes: true },
    );
    server = await startGatewayServer(gateway.app, { port: 0, hostname: '127.0.0.1' });
    base = server.url;
  }, S8_TIMEOUT);

  afterAll(async () => {
    try {
      await server?.close();
      gateway?.search?.close();
      gateway?.pool.close();
      runtime?.ingestor.stop();
      (runtime?.pool as { close?: () => void } | undefined)?.close?.();
      runtime?.db.close();
    } catch {
      /* úklid nesmie hodiť */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'indexer nažene eventy s diakritikou a gateway GET /search ich nájde (BM25 + snippet)',
    { timeout: S8_TIMEOUT },
    async () => {
      await eventually(() => runtime.db.getEvent(question.id));
      await eventually(() => runtime.db.getEvent(post.id));

      const body = await eventually(async () => {
        const res = await fetch(`${base}/search?q=reklamacna%20zmluva&limit=10`);
        if (res.status !== 200) return false;
        const json = (await res.json()) as SearchBody;
        return json.results?.some((hit) => hit.id === question.id) ? json : false;
      });

      expect(body.phase).toBe('S8');
      expect(body.query).toBe('reklamacna zmluva');
      // normalizovaný dotaz = výstup zdieľaného buildMatchQuery (AND tokenov)
      expect(body.normalized_query).toBe('reklamacna AND zmluva');
      expect(body.partial).toBe(false);
      expect(body.channels).toEqual(['fts5']);
      expect(body.deadline_ms).toBe(2000);
      expect(typeof body.took_ms).toBe('number');
      expect(body.count).toBe(body.results?.length);
      expect(body.untrusted).toContain('untrusted');

      const hit = body.results?.find((h) => h.id === question.id);
      expect(hit?.kind).toBe(KINDS.QUESTION);
      expect(hit?.pubkey).toBe(authorPub);
      // snippet zvýrazňuje termíny; diakritiku zráža tokenizér, nie gateway
      expect(hit?.snippet).toContain('[');
      expect((hit?.snippet ?? '').toLowerCase()).toContain('reklama');
      // bm25 rank: lepší kandidát je zápornejší
      expect(hit?.score ?? 0).toBeLessThan(0);
    },
  );

  it(
    'filtre kinds / authors / since a limit fungujú na reálnych dátach',
    { timeout: S8_TIMEOUT },
    async () => {
      const onlyPosts = await eventually(async () => {
        const json = (await (
          await fetch(`${base}/search?q=token%20${token}&kinds=${String(KINDS.POST)}`)
        ).json()) as SearchBody;
        return json.results?.some((h) => h.id === post.id) ? json : false;
      });
      expect((onlyPosts.results ?? []).every((h) => h.kind === KINDS.POST)).toBe(true);

      const byAuthor = await eventually(async () => {
        const json = (await (
          await fetch(`${base}/search?q=token%20${token}&authors=${authorPub}`)
        ).json()) as SearchBody;
        return json.results?.some((h) => h.id === question.id) ? json : false;
      });
      expect((byAuthor.results ?? []).every((h) => h.pubkey === authorPub)).toBe(true);
      expect(byAuthor.results?.some((h) => h.id === post.id)).toBe(false);

      const windowed = (await (
        await fetch(`${base}/search?q=token%20${token}&since=${String(Math.floor(Date.now() / 1000) + 60)}`)
      ).json()) as SearchBody;
      expect(windowed.results ?? []).toEqual([]);

      const limited = (await (
        await fetch(`${base}/search?q=token%20${token}&limit=1`)
      ).json()) as SearchBody;
      expect(limited.results ?? []).toHaveLength(1);

      const bad = await fetch(`${base}/search?q=x&limit=99`);
      expect(bad.status).toBe(400);
    },
  );

  it(
    'MCP forum_search siahá po FTS5 (source fts5), nie po lokálnom scane',
    { timeout: S8_TIMEOUT },
    async () => {
      const mcpClient = new Client({ name: 's8-integration-client', version: '0.0.0' });
      const gatewayClient = new GatewayClient({ baseUrl: base });
      const mcpServer = createForumMcpServer({
        client: gatewayClient,
        name: 'forum4ai-s8-test',
        version: '0.0.0-test',
      });
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcpServer.connect(serverSide), mcpClient.connect(clientSide)]);

      try {
        const result = await eventually(async () => {
          const call = await mcpClient.callTool({
            name: 'forum_search',
            arguments: { query: `reklamacna zmluva token ${token}`, limit: 10 },
          });
          const text =
            (call.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')
              ?.text ?? '';
          const payload = JSON.parse(text) as {
            ok?: boolean;
            source?: string;
            matches?: { id: string; snippet: string }[];
            normalized_query?: string;
            untrusted?: string;
          };
          return payload.matches?.some((m) => m.id === question.id) ? payload : false;
        });

        expect(result.ok).toBe(true);
        expect(result.source).toBe('fts5'); // primary cesta, nie local_scan
        expect(result.normalized_query).toContain('reklamacna');
        expect(result.untrusted).toContain('untrusted');
      } finally {
        await mcpClient.close();
        await mcpServer.close();
      }
    },
  );

  it(
    'kind 0 (set metadata) prešiel shared validátorom aj prísnym registry režimom indexera',
    { timeout: S8_TIMEOUT },
    async () => {
      // 1) shared validátor (L1 štruktúra + L2 pravidlá) — kind 0 je v
      //    registry a nemá žiadne extra L2 pravidlá
      const struct = validateEvent(metadata);
      expect(struct.valid, struct.errors.join('; ')).toBe(true);
      expect(await verifyFull(metadata)).toBe(true);

      const contacts = finalizeEvent(
        {
          kind: KINDS.CONTACTS,
          created_at: Math.floor(Date.now() / 1000) - 10,
          tags: [['p', solverPub, RELAYS[0] ?? '', 'prijaty kontakt']],
          content: '',
        },
        author,
      );
      expect(validateEvent(contacts).valid).toBe(true);
      expect(await verifyFull(contacts)).toBe(true);

      // 2) end-to-end: prísny režim indexera (INDEXER_REQUIRE_REGISTRY=1)
      //    nesmie kind 0 odmietnuť — to bol zmysel rozhodnutia (a).
      //    `outsideRegistry` počítame preto, lebo ten je o registry (naše
      //    kindy); `invalidEvent` by závisel od cudzích eventov na relayi.
      await publishToAll(metadata);
      await eventually(() => runtime.db.getEvent(metadata.id));
      const counters = runtime.ingestor.snapshot();
      expect(counters.outsideRegistry).toBe(0);
      expect(runtime.db.getEvent(metadata.id)?.kind).toBe(KINDS.PROFILE);

      // 3) search vidí aj metadata (index nie je len pre diskusné kindy)
      const found = await eventually(async () => {
        const json = (await (
          await fetch(`${base}/search?q=${encodeURIComponent(`f4ai14-${token}`)}`)
        ).json()) as SearchBody;
        return json.results?.some((h) => h.id === metadata.id) ? json : false;
      });
      expect(found.results?.find((h) => h.id === metadata.id)?.kind).toBe(KINDS.PROFILE);
    },
  );

  it(
    'bez GATEWAY_INDEX_DB → 503 index unavailable a MCP fallback na local_scan',
    { timeout: S8_TIMEOUT },
    async () => {
      const off = buildGateway(
        { GATEWAY_QUIET: '1', GATEWAY_RELAY_URLS: RELAYS.join(' ') },
        { disableWebsocket: true, indexDb: null },
      );
      const offServer = await startGatewayServer(off.app, { port: 0, hostname: '127.0.0.1' });
      const mcpClient = new Client({ name: 's8-fallback-client', version: '0.0.0' });
      const mcpServer = createForumMcpServer({
        client: new GatewayClient({ baseUrl: offServer.url }),
        name: 'forum4ai-s8-fallback',
        version: '0.0.0-test',
      });
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcpServer.connect(serverSide), mcpClient.connect(clientSide)]);

      try {
        const res = await fetch(`${offServer.url}/search?q=reklamacna`);
        expect(res.status).toBe(503);
        const body = (await res.json()) as SearchBody;
        expect(body.error).toBe('index unavailable');
        expect(body.reason).toContain('GATEWAY_INDEX_DB');

        const call = await mcpClient.callTool({
          name: 'forum_search',
          arguments: { query: `token ${token}`, fetch: 200, filters: { kinds: [KINDS.QUESTION] } },
        });
        const text =
          (call.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')
            ?.text ?? '';
        const payload = JSON.parse(text) as {
          source?: string;
          note?: string;
          matches?: { id: string }[];
        };
        // fallback je počuteľný: source local_scan + dôvod v note
        expect(payload.source).toBe('local_scan');
        expect(payload.note).toContain('503');
        expect((payload.matches ?? []).some((m) => m.id === question.id)).toBe(true);
      } finally {
        await mcpClient.close();
        await mcpServer.close();
        off.search?.close();
        off.pool.close();
        await offServer.close();
      }
    },
  );
});
