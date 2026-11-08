/**
 * Unit testy MCP nástrojov pre idea_call (F4AI-16, S10) — bez siete:
 * reálny `McpServer` + `Client` cez `InMemoryTransport`, `GatewayClient`
 * s FAKE fetchom (rovnaký harness ako `mcp-tools.test.ts`).
 *
 * Cvičené správanie:
 *  - `forum_list_ideas` volá GET /ideas s query parametrami a označí untrusted
 *  - `forum_claim_idea` draft: kind 10030, `d` tag = id idea, pri `claimed`
 *    `a` tag = claimujúci pubkey
 *  - kontrola legality prechodu cez GET /ideas/:id: nelegálny → isError s
 *    dôvodom; gateway nedostupný/404/503 → draft BEZ kontroly s warningom
 *  - claim cudzieho 1021 → warning, že ide len o suggestion (rozhodnutie S10)
 *  - `forum_update_idea_status` rovnaký draft pattern
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { KINDS } from '@forum4ai/shared';

import { GatewayClient, type FetchLike } from '../src/mcp/gateway-client.js';
import { createForumMcpServer } from '../src/mcp/server.js';

const PK_A = 'a'.repeat(64); // autor 1021
const PK_B = 'b'.repeat(64); // cudzí pubkey
const IDEA = 'f'.repeat(64);

/**
 * F4AI-2b2: NIP-32 jazykový label draftu (default `en`). Draft je
 * nezapodpísaný, takže práve tu gateway/writer pripája tag — klient ho
 * podpíše presne tak, ako ho dostal.
 */
const EN_LABEL: string[][] = [
  ['L', 'ISO-639-1'],
  ['l', 'en', 'ISO-639-1'],
];

interface RecordedCall {
  url: string;
  method: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function makeHarness(
  handler: (url: URL) => Response | Promise<Response>,
): Promise<{ client: Client; server: McpServer; calls: RecordedCall[] }> {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: `${url.pathname}${url.search}`, method: init?.method ?? 'GET' });
    return handler(url);
  };
  const gateway = new GatewayClient({ baseUrl: 'http://gw.test/', fetchImpl });
  const server = createForumMcpServer({
    client: gateway,
    name: 'forum4ai-test',
    version: '0.0.0-test',
  });
  const client = new Client({ name: 'unit-client', version: '0.0.0' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server, calls };
}

interface Payload {
  ok?: boolean;
  status?: string;
  error?: string;
  reasons?: string[];
  reason?: string;
  warning?: string;
  legality?: string;
  current_status?: string;
  requested_status?: string;
  untrusted?: string;
  draft?: { kind: number; tags: string[][]; content: string; pubkey: string | null };
  [key: string]: unknown;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; payload: Payload }> {
  const result = await client.callTool({ name, arguments: args });
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const text = blocks.find((b) => b.type === 'text')?.text ?? '';
  return { isError: result.isError === true, payload: JSON.parse(text) as Payload };
}

/** gateway, ktorý na GET /ideas/:id vrámi tento detail (board vracia []) */
function gatewayWithIdea(detail: unknown, detailStatus = 200) {
  return (url: URL): Response => {
    if (url.pathname === `/ideas/${IDEA}`) return jsonResponse(detailStatus, detail);
    return jsonResponse(200, { phase: 'S10', count: 0, limit: 20, items: [] });
  };
}

describe('forum_list_ideas', () => {
  it('volá GET /ideas so status/topic/limit a označí dáta untrusted', async () => {
    const board = {
      phase: 'S10',
      count: 1,
      limit: 5,
      filters: { status: 'open', topic: 'ai/agents' },
      items: [{ id: IDEA, title: 'X', status: 'open', suggestions_count: 0 }],
    };
    const { client, server, calls } = await makeHarness((url) => {
      if (url.pathname === '/ideas') return jsonResponse(200, board);
      return jsonResponse(404, { error: 'not found' });
    });
    const res = await call(client, 'forum_list_ideas', {
      status: 'open',
      topic: 'ai/agents',
      limit: 5,
    });
    expect(res.isError).toBe(false);
    expect(res.payload.ok).toBe(true);
    expect(res.payload.untrusted).toContain('untrusted');
    expect((res.payload as Record<string, unknown>).items).toEqual(board.items);
    const ideasCall = calls.find((c) => c.url.startsWith('/ideas?'));
    expect(ideasCall?.url).toContain('status=open');
    expect(ideasCall?.url).toContain('topic=ai%2Fagents');
    expect(ideasCall?.url).toContain('limit=5');
    await client.close();
    await server.close();
  });

  it('503 index unavailable → isError s dôvodom', async () => {
    const { client, server } = await makeHarness(() =>
      jsonResponse(503, { ok: false, error: 'index unavailable', reason: 'DB neexistuje' }),
    );
    const res = await call(client, 'forum_list_ideas', {});
    expect(res.isError).toBe(true);
    expect(res.payload.http_status).toBe(503);
    expect(res.payload.reasons?.join(' ')).toContain('index unavailable');
    await client.close();
    await server.close();
  });
});

describe('forum_claim_idea — draft + kontrola legality', () => {
  it('legálny open→claimed s pubkey: d tag + a tag = claimant', async () => {
    const { client, server } = await makeHarness(
      gatewayWithIdea({ phase: 'S10', id: IDEA, author: PK_A, status: 'open' }),
    );
    const res = await call(client, 'forum_claim_idea', {
      idea_event_id: IDEA,
      status: 'claimed',
      note: 'beriem',
      pubkey: PK_A,
    });
    expect(res.isError).toBe(false);
    expect(res.payload.status).toBe('unsigned_draft');
    expect(res.payload.legality).toContain('ok');
    expect(res.payload.draft?.kind).toBe(KINDS.IDEA_CALL_STATUS);
    expect(res.payload.draft?.tags).toEqual([['d', IDEA], ['a', PK_A], ...EN_LABEL]);
    expect(JSON.parse(res.payload.draft?.content ?? '{}')).toEqual({ status: 'claimed', note: 'beriem' });
    await client.close();
    await server.close();
  });

  it('nelegálny prechod z done → isError s dôvodom a hintom automatu', async () => {
    const { client, server } = await makeHarness(
      gatewayWithIdea({ phase: 'S10', id: IDEA, author: PK_A, status: 'done' }),
    );
    const res = await call(client, 'forum_claim_idea', {
      idea_event_id: IDEA,
      status: 'claimed',
      pubkey: PK_A,
    });
    expect(res.isError).toBe(true);
    expect(res.payload.error).toContain('illegal');
    expect(res.payload.current_status).toBe('done');
    expect(res.payload.requested_status).toBe('claimed');
    expect(res.payload.reason).toContain('final state');
    expect(res.payload.hint).toContain('open→claimed→in_progress→review→done');
    await client.close();
    await server.close();
  });

  it('gateway nedostupný → draft BEZ kontroly s warningom', async () => {
    const { client, server } = await makeHarness(() => {
      throw new Error('ECONNREFUSED');
    });
    const res = await call(client, 'forum_claim_idea', {
      idea_event_id: IDEA,
      status: 'in_progress',
      pubkey: PK_A,
    });
    expect(res.isError).toBe(false);
    expect(res.payload.status).toBe('unsigned_draft');
    expect(res.payload.legality).toBe('skipped');
    expect(res.payload.warning).toContain('was not verified');
    expect(res.payload.draft?.tags).toEqual([['d', IDEA], ...EN_LABEL]);
    await client.close();
    await server.close();
  });

  it('503 gateway → draft s warningom (rozhodnutie: neblokovať offline)', async () => {
    const { client, server } = await makeHarness(() =>
      jsonResponse(503, { ok: false, error: 'index unavailable' }),
    );
    const res = await call(client, 'forum_claim_idea', { idea_event_id: IDEA, status: 'open' });
    expect(res.isError).toBe(false);
    expect(res.payload.legality).toBe('skipped');
    expect(res.payload.warning).toContain('503');
    await client.close();
    await server.close();
  });

  // regression C5: 404 NIE je offline — idea v indexe nie je, status
  // nemožno meniť na duchovi; draft sa nesme pustiť so warningom
  it('404 gateway → nelegálny prechod (idea neexistuje), nie skipped', async () => {
    const { client, server } = await makeHarness(() =>
      jsonResponse(404, { ok: false, error: 'idea not found' }),
    );
    const res = await call(client, 'forum_claim_idea', { idea_event_id: IDEA, status: 'claimed' });
    expect(res.isError).toBe(true);
    expect(res.payload.error).toContain('illegal idea_call status transition');
    expect(res.payload.current_status).toBeNull();
    expect(String(res.payload.reason)).toContain('404');
    await client.close();
    await server.close();
  });

  it('claim cudzieho 1021 → warning o suggestion (kanonický status má len autor)', async () => {
    const { client, server } = await makeHarness(
      gatewayWithIdea({ phase: 'S10', id: IDEA, author: PK_A, status: 'open' }),
    );
    const res = await call(client, 'forum_claim_idea', {
      idea_event_id: IDEA,
      status: 'claimed',
      pubkey: PK_B,
    });
    expect(res.isError).toBe(false);
    expect(res.payload.warning).toContain('suggestion');
    expect(res.payload.draft?.tags).toEqual([['d', IDEA], ['a', PK_B], ...EN_LABEL]);
    await client.close();
    await server.close();
  });

  it('claimed bez pubkey → draft s warningom o povinnom a-tagu', async () => {
    const { client, server } = await makeHarness(
      gatewayWithIdea({ phase: 'S10', id: IDEA, author: PK_A, status: 'open' }),
    );
    const res = await call(client, 'forum_claim_idea', { idea_event_id: IDEA, status: 'claimed' });
    expect(res.isError).toBe(false);
    expect(res.payload.warning).toContain('a-tag');
    expect(res.payload.draft?.tags).toEqual([['d', IDEA], ...EN_LABEL]);
    await client.close();
    await server.close();
  });

  it('odpoveď bez čitateľného statusu (starý gateway) → skipped s warningom', async () => {
    const { client, server } = await makeHarness(
      gatewayWithIdea({ phase: 'S5', root: { id: IDEA } }),
    );
    const res = await call(client, 'forum_claim_idea', { idea_event_id: IDEA, status: 'cancelled' });
    expect(res.isError).toBe(false);
    expect(res.payload.legality).toBe('skipped');
    expect(res.payload.warning).toContain('no readable status');
    await client.close();
    await server.close();
  });
});

describe('forum_update_idea_status', () => {
  it('legálny in_progress→review: draft 10030 s d tagom', async () => {
    const { client, server } = await makeHarness(
      gatewayWithIdea({ phase: 'S10', id: IDEA, author: PK_A, status: 'in_progress' }),
    );
    const res = await call(client, 'forum_update_idea_status', {
      idea_event_id: IDEA,
      status: 'review',
      note: 'prace hotove, cakaju review',
      pubkey: PK_A,
    });
    expect(res.isError).toBe(false);
    expect(res.payload.legality).toContain('ok');
    expect(res.payload.draft?.kind).toBe(KINDS.IDEA_CALL_STATUS);
    expect(res.payload.draft?.tags).toEqual([['d', IDEA], ...EN_LABEL]);
    expect(JSON.parse(res.payload.draft?.content ?? '{}')).toEqual({
      status: 'review',
      note: 'prace hotove, cakaju review',
    });
    await client.close();
    await server.close();
  });

  it('claimed s claimant_pubkey → a tag; bez neho warning', async () => {
    const withClaimant = await makeHarness(
      gatewayWithIdea({ phase: 'S10', id: IDEA, author: PK_A, status: 'open' }),
    );
    const ok = await call(withClaimant.client, 'forum_update_idea_status', {
      idea_event_id: IDEA,
      status: 'claimed',
      claimant_pubkey: PK_B,
      pubkey: PK_A,
    });
    expect(ok.payload.draft?.tags).toEqual([['d', IDEA], ['a', PK_B], ...EN_LABEL]);
    await withClaimant.client.close();
    await withClaimant.server.close();

    const bare = await makeHarness(
      gatewayWithIdea({ phase: 'S10', id: IDEA, author: PK_A, status: 'open' }),
    );
    const warn = await call(bare.client, 'forum_update_idea_status', {
      idea_event_id: IDEA,
      status: 'claimed',
    });
    expect(warn.payload.warning).toContain('claimant_pubkey');
    await bare.client.close();
    await bare.server.close();
  });

  it('nelegálny review→claimed → isError', async () => {
    const { client, server } = await makeHarness(
      gatewayWithIdea({ phase: 'S10', id: IDEA, author: PK_A, status: 'review' }),
    );
    const res = await call(client, 'forum_update_idea_status', {
      idea_event_id: IDEA,
      status: 'claimed',
    });
    expect(res.isError).toBe(true);
    expect(res.payload.reason).toContain('review');
    await client.close();
    await server.close();
  });

  it('uvolenie claimu claimed→open je legálne', async () => {
    const { client, server } = await makeHarness(
      gatewayWithIdea({ phase: 'S10', id: IDEA, author: PK_A, status: 'claimed' }),
    );
    const res = await call(client, 'forum_update_idea_status', {
      idea_event_id: IDEA,
      status: 'open',
    });
    expect(res.isError).toBe(false);
    expect(res.payload.legality).toContain('ok');
    await client.close();
    await server.close();
  });
});
