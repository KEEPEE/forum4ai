/**
 * Integrácia MCP servera (F4AI-12, S6): reálny gateway (dev relaye
 * 127.0.0.1) + MCP server spawnutý ako proces (`node dist/cli.js mcp`)
 * a komunikovaný cez stdio JSON-RPC — initialize, tools/list,
 * forum_publish reálne podpísaného 1020, forum_get_thread a forum_search
 * nájdu publikovaný obsah.
 *
 * Suite sa preskočí, ak relaye nie sú dosiahnuteľné (unit testy ostávajú).
 * Po publishi cvičíme retry (strfry OK-before-write race — známe PIT).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import { KINDS } from '@forum4ai/shared';

import { createGatewayApp } from '../src/app.js';
import { OutboxWriter } from '../src/outbox.js';
import { registerReadRoutes } from '../src/read-routes.js';
import { RelayPool } from '../src/relay-pool.js';
import { DEV_RELAY_URLS } from './dev-relays.js';
import { startGatewayServer, type RunningGateway } from '../src/server.js';

const RELAYS = [...DEV_RELAY_URLS];
const MCP_TIMEOUT = 60_000;

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

interface ToolPayload {
  ok?: boolean;
  status?: string;
  error?: string;
  reasons?: string[];
  root?: { id: string; content: string };
  matches?: { id: string; snippet: string }[];
  gateway_response?: { quorum_met?: boolean; event_id?: string };
  [key: string]: unknown;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; payload: ToolPayload }> {
  const result = await client.callTool({ name, arguments: args });
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const text = blocks.find((b) => b.type === 'text')?.text ?? '{}';
  return { isError: result.isError === true, payload: JSON.parse(text) as ToolPayload };
}

describe.skipIf(!relaysOnline)('MCP integrácia — gateway + stdio spawn cez dev relaye', () => {
  let pool: RelayPool;
  let gateway: RunningGateway;
  let mcpClient: Client;
  let transport: StdioClientTransport;
  let stderrTail = '';

  beforeAll(async () => {
    pool = new RelayPool({ urls: RELAYS, connectTimeoutMs: 5_000, publishTimeoutMs: 5_000 });
    const statuses = await pool.connectAll();
    expect(statuses.every((s) => s.connected)).toBe(true);

    const outbox = new OutboxWriter(pool, {
      defaultWriteRelays: RELAYS,
      ttlMs: 60_000,
      fetchTimeoutMs: 4_000,
    });
    const app = createGatewayApp({ pool, outbox, logger: () => undefined, corsOrigin: '*' });
    registerReadRoutes(app, { pool, queryTimeoutMs: 8_000, logger: () => undefined });
    gateway = await startGatewayServer(app, { port: 0, hostname: '127.0.0.1' });

    const cliPath = new URL('../dist/cli.js', import.meta.url);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath.pathname, 'mcp'],
      env: { ...getDefaultEnvironment(), MCP_GATEWAY_URL: gateway.url },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4_000);
    });
    mcpClient = new Client({ name: 'itest-mcp', version: '0.0.0' });
    await mcpClient.connect(transport);
  }, MCP_TIMEOUT);

  afterAll(async () => {
    await mcpClient?.close().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    pool?.close();
  });

  it('initialize + tools/list: 17 forum_* nástrojov a instructions', { timeout: MCP_TIMEOUT }, async () => {
    // SDK 1.32.2: `client.connect(transport)` v beforeAll už vykonal
    // JSON-RPC initialize handshake — výsledok čítame z getterov
    expect(mcpClient.getServerVersion()?.name).toBe('forum4ai');
    expect(mcpClient.getInstructions()).toContain('forum_search');

    const tools = await mcpClient.listTools();
    expect(tools.tools).toHaveLength(17);
    expect(tools.tools.map((t) => t.name)).toContain('forum_publish');
    expect(tools.tools.map((t) => t.name)).toContain('forum_list_ideas');
    expect(tools.tools.map((t) => t.name)).toContain('forum_update_idea_status');
    expect(tools.tools.map((t) => t.name)).toContain('forum_whoami');
    // Phase 4a (dizajn Q4): papiere — lint bez publishu je pre agenta
    // najlacnejšia cesta k verdiktu, musí byť viditeľný v tools/list
    expect(tools.tools.map((t) => t.name)).toContain('forum_lint_paper');
    expect(tools.tools.map((t) => t.name)).toContain('forum_publish_paper');
    expect(tools.tools.map((t) => t.name)).toContain('forum_list_papers');
    expect(tools.tools.map((t) => t.name)).toContain('forum_get_paper');
  });

  it(
    'forum_publish reálneho 1020 → forum_get_thread a forum_search ho nájdu',
    { timeout: MCP_TIMEOUT },
    async () => {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      const token = `mcpq${Date.now().toString(36)}x${Math.random().toString(36).slice(2, 8)}`;
      const event = finalizeEvent(
        {
          kind: KINDS.QUESTION,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: `Integracna MCP otazka ${token} — ako sa pise nostr outbox?`,
        },
        sk,
      );

      const published = await callTool(mcpClient, 'forum_publish', { event });
      expect(published.isError, `publish zlyhal: ${JSON.stringify(published.payload)} stderr=${stderrTail}`).toBe(false);
      expect(published.payload.gateway_response?.quorum_met).toBe(true);
      expect(published.payload.gateway_response?.event_id).toBe(event.id);

      // strfry OK-before-write race: čítanie môže potrebovať retry
      let thread = await callTool(mcpClient, 'forum_get_thread', { id: event.id });
      for (let attempt = 0; attempt < 8 && thread.payload.root?.id !== event.id; attempt += 1) {
        await sleep(500 * (attempt + 1));
        thread = await callTool(mcpClient, 'forum_get_thread', { id: event.id });
      }
      expect(thread.isError, `thread nenájdený: ${JSON.stringify(thread.payload)}`).toBe(false);
      expect(thread.payload.root?.id).toBe(event.id);
      expect(thread.payload.root?.pubkey).toBe(pk);

      let search = await callTool(mcpClient, 'forum_search', { query: token });
      for (
        let attempt = 0;
        attempt < 8 && !search.payload.matches?.some((m) => m.id === event.id);
        attempt += 1
      ) {
        await sleep(500 * (attempt + 1));
        search = await callTool(mcpClient, 'forum_search', { query: token });
      }
      expect(search.isError, `search zlyhal: ${JSON.stringify(search.payload)}`).toBe(false);
      const hit = search.payload.matches?.find((m) => m.id === event.id);
      expect(hit, `search nenašiel token ${token}`).toBeTruthy();
      expect(hit?.snippet).toContain(token);
    },
  );

  it('forum_vote draft vráti nezapodpísaný 1030 bez siete (draft+publish split)', async () => {
    const res = await callTool(mcpClient, 'forum_vote', {
      target_event_id: 'a'.repeat(64),
      direction: '+',
    });
    expect(res.isError).toBe(false);
    expect(res.payload.status).toBe('unsigned_draft');
    const draft = res.payload.draft as { kind: number; tags: string[][]; content: string; sig?: string };
    expect(draft.kind).toBe(KINDS.VOTE);
    // F4AI-2b2: draft nesie NIP-32 jazykový label (default `en`) — klient
    // ho podpisuje presne tak, ako ho dostal, gateway do neho nezasahuje
    expect(draft.tags).toEqual([
      ['e', 'a'.repeat(64)],
      ['L', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ]);
    expect(draft.content).toBe('+1');
    expect(draft.sig).toBeUndefined();
  });
});
