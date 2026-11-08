/**
 * The node directory and `GET /nodes` (F4AI-37, epic F4AI-35).
 *
 * A directory is only as good as its refusals, so most of this file is about
 * what must NOT be listed: a bad signature, a `d` tag that belongs to another
 * key, a node whose only relay is private, a deletion signed by a stranger, an
 * upstream that overreaches its byte cap. The happy path is checked once, in
 * full, because that is the contract F4AI-37 promises to callers.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event, Filter } from 'nostr-tools';

import {
  NODE_ANNOUNCE_STALE_AFTER_S,
  NODE_ANNOUNCE_TTL_S,
  NODE_ROLE_NAMESPACE,
  nodeIdFromPubkey,
  type NostrEvent,
} from '@forum4ai/shared';

import { NodeDirectory, type DirectoryUpstream } from '../src/node-directory.js';
import { registerNodeRoutes } from '../src/node-routes.js';

const NOW_MS = 1_780_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

const hubSk = generateSecretKey();
const hubPk = getPublicKey(hubSk).toLowerCase();
const seedSk = generateSecretKey();
const seedPk = getPublicKey(seedSk).toLowerCase();

function announce(
  sk: Uint8Array,
  opts: {
    role?: 'client' | 'writer' | 'seed' | 'hub';
    relays?: string[];
    createdAt?: number;
    d?: string;
    topics?: string[];
    webUrl?: string;
    checkpoint?: number;
  } = {},
): Event {
  const pk = getPublicKey(sk).toLowerCase();
  const createdAt = opts.createdAt ?? NOW_S;
  const tags: string[][] = [
    ['d', opts.d ?? nodeIdFromPubkey(pk)],
    ['L', NODE_ROLE_NAMESPACE],
    ['l', opts.role ?? 'hub', NODE_ROLE_NAMESPACE],
    ['expiration', String(createdAt + NODE_ANNOUNCE_TTL_S)],
  ];
  for (const url of opts.relays ?? ['wss://relay.example.com']) tags.push(['r', url]);
  for (const slug of opts.topics ?? ['ai-agents']) tags.push(['t', slug]);
  const content = JSON.stringify({
    v: 1,
    software: 'forum4ai/test',
    ...(opts.webUrl !== undefined ? { web_url: opts.webUrl } : {}),
    ...(opts.checkpoint !== undefined ? { checkpoint: opts.checkpoint } : {}),
  });
  return finalizeEvent({ kind: 30026, created_at: createdAt, tags, content }, sk);
}

function deletion(sk: Uint8Array, address: string, createdAt: number = NOW_S): Event {
  return finalizeEvent({ kind: 5, created_at: createdAt, tags: [['a', address]], content: '' }, sk);
}

class FakeRelays {
  events: Event[] = [];
  queries: Filter[][] = [];

  async query(filters: Filter[]): Promise<Event[]> {
    this.queries.push(filters);
    return this.events;
  }
}

function makeDirectory(
  relays: FakeRelays,
  overrides?: Partial<ConstructorParameters<typeof NodeDirectory>[0]>,
): NodeDirectory {
  return new NodeDirectory({
    relays,
    upstreams: () => [],
    ...overrides,
    now: overrides?.now ?? (() => NOW_MS),
    logger: () => undefined,
  });
}

function appFor(directory: NodeDirectory): Hono {
  const app = new Hono();
  registerNodeRoutes(app, { directory, logger: () => undefined });
  return app;
}

describe('NodeDirectory', () => {
  it('lists a fresh hub with the documented fields', async () => {
    const relays = new FakeRelays();
    relays.events = [announce(hubSk, { role: 'hub', relays: ['wss://relay.example.com', 'wss://backup.example.com'], webUrl: 'https://forum.example.com', checkpoint: NOW_S - 60 })];
    const directory = makeDirectory(relays);
    const list = await directory.list();
    expect(list.nodes).toHaveLength(1);
    const node = list.nodes[0]!;
    expect(node).toMatchObject({
      node_id: nodeIdFromPubkey(hubPk),
      pubkey: hubPk,
      role: 'hub',
      relay_urls: ['wss://relay.example.com', 'wss://backup.example.com'],
      web_url: 'https://forum.example.com',
      topics: ['ai-agents'],
      checkpoint: NOW_S - 60,
      software: 'forum4ai/test',
      seen_at: NOW_S,
      age_s: 0,
      stale: false,
      via: [],
      verified: false,
    });
    expect(list.ttl).toBe(NODE_ANNOUNCE_TTL_S);
  });

  it('flags a node stale past the stale window and drops it past the TTL', async () => {
    const relays = new FakeRelays();
    relays.events = [announce(hubSk)];
    const staleAt = NOW_MS + (NODE_ANNOUNCE_STALE_AFTER_S + 30) * 1000;
    const stale = await makeDirectory(relays, { now: () => staleAt }).list();
    expect(stale.nodes).toHaveLength(1);
    expect(stale.nodes[0]).toMatchObject({ stale: true, age_s: NODE_ANNOUNCE_STALE_AFTER_S + 30 });

    const deadAt = NOW_MS + (NODE_ANNOUNCE_TTL_S + 5) * 1000;
    const dead = await makeDirectory(relays, { now: () => deadAt }).list();
    expect(dead.nodes).toHaveLength(0);
  });

  it('sorts by freshness, newest first', async () => {
    const relays = new FakeRelays();
    relays.events = [
      announce(hubSk, { createdAt: NOW_S - 120 }),
      announce(seedSk, { role: 'seed', createdAt: NOW_S - 10 }),
    ];
    const list = await makeDirectory(relays).list();
    expect(list.nodes.map((n) => n.pubkey)).toEqual([seedPk, hubPk]);
  });

  it('drops a bad signature and a d tag that belongs to another key', async () => {
    const relays = new FakeRelays();
    const signed = announce(hubSk);
    const tampered = { ...signed, content: JSON.stringify({ v: 1, software: 'evil' }) } as Event;
    const stolen = announce(hubSk, { d: nodeIdFromPubkey(seedPk) });
    relays.events = [tampered, stolen, announce(seedSk, { role: 'seed' })];
    const directory = makeDirectory(relays);
    const list = await directory.list();
    expect(list.nodes.map((n) => n.pubkey)).toEqual([seedPk]);
  });

  it('refuses a node whose only relay is private, unless the operator opted in', async () => {
    const relays = new FakeRelays();
    relays.events = [announce(hubSk, { relays: ['ws://127.0.0.1:18080'] })];
    expect((await makeDirectory(relays).list()).nodes).toHaveLength(0);
    const dev = makeDirectory(relays, { allowPrivateHosts: true });
    expect((await dev.list()).nodes[0]?.relay_urls).toEqual(['ws://127.0.0.1:18080']);
  });

  it('honours a NIP-09 deletion signed by the node, and only that one', async () => {
    const relays = new FakeRelays();
    const address = `30026:${hubPk}:${nodeIdFromPubkey(hubPk)}`;
    relays.events = [announce(hubSk), announce(seedSk, { role: 'seed' })];
    expect((await makeDirectory(relays).list()).nodes).toHaveLength(2);

    relays.events = [...relays.events, deletion(seedSk, address)];
    expect((await makeDirectory(relays).list()).nodes).toHaveLength(2);

    relays.events = [...relays.events, deletion(hubSk, address)];
    const remaining = await makeDirectory(relays).list();
    expect(remaining.nodes.map((n) => n.pubkey)).toEqual([seedPk]);
  });

  it('keeps the newest announcement per address (LWW)', async () => {
    const relays = new FakeRelays();
    relays.events = [
      announce(hubSk, { role: 'hub', createdAt: NOW_S - 30 }),
      announce(hubSk, { role: 'seed', createdAt: NOW_S }),
    ];
    const list = await makeDirectory(relays).list();
    expect(list.nodes).toHaveLength(1);
    expect(list.nodes[0]?.role).toBe('seed');
  });

  it('fans out one hop and marks where a node came from', async () => {
    const relays = new FakeRelays();
    relays.events = [announce(hubSk)];
    const upstreamEvents = [announce(seedSk, { role: 'seed' })];
    const upstream: DirectoryUpstream = { id: 'upstream.test', baseUrl: 'http://upstream.test:3001' };
    const calls: string[] = [];
    const directory = makeDirectory(relays, {
      fanOut: true,
      upstreams: () => [upstream],
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ events: upstreamEvents }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const list = await directory.list();
    expect(list.nodes).toHaveLength(2);
    const learned = list.nodes.find((n) => n.pubkey === seedPk)!;
    expect(learned.via).toEqual(['upstream.test']);
    expect(calls).toEqual(['http://upstream.test:3001/nodes?local=1&raw=1']);

    // one hop: a peer asking us for `local=1` gets only what we saw directly
    expect(directory.rawEvents({ localOnly: true })).toHaveLength(1);
    expect(directory.rawEvents()).toHaveLength(2);
  });

  it('never dials an upstream in legacy mode', async () => {
    const relays = new FakeRelays();
    relays.events = [announce(hubSk)];
    let calls = 0;
    const directory = makeDirectory(relays, {
      upstreams: () => [{ id: 'upstream.test', baseUrl: 'http://upstream.test:3001' }],
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: 200 });
      },
    });
    await directory.list();
    expect(calls).toBe(0);
    expect(directory.fanOut).toBe(false);
  });

  it('survives an upstream that lies, hangs, 404s or overflows', async () => {
    const relays = new FakeRelays();
    relays.events = [announce(hubSk)];
    const upstream: DirectoryUpstream = { id: 'bad.test', baseUrl: 'http://bad.test:3001' };

    const lying = makeDirectory(relays, {
      fanOut: true,
      upstreams: () => [upstream],
      fetchImpl: async () =>
        new Response(JSON.stringify({ events: [{ ...announce(seedSk), sig: '0'.repeat(128) }] }), { status: 200 }),
    });
    expect((await lying.list()).nodes).toHaveLength(1);

    const oversized = makeDirectory(relays, {
      fanOut: true,
      upstreams: () => [upstream],
      maxBytes: 16,
      fetchImpl: async () => new Response(JSON.stringify({ events: [announce(seedSk)] }), { status: 200 }),
    });
    expect((await oversized.list()).nodes).toHaveLength(1);

    const missing = makeDirectory(relays, {
      fanOut: true,
      upstreams: () => [upstream],
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    expect((await missing.list()).nodes).toHaveLength(1);

    const hanging = makeDirectory(relays, {
      fanOut: true,
      upstreams: () => [upstream],
      httpTimeoutMs: 50,
      fetchImpl: async () => new Promise<Response>(() => undefined),
    });
    expect((await hanging.list()).nodes).toHaveLength(1);
  });

  it('serves an empty directory when the relay query fails', async () => {
    const directory = new NodeDirectory({
      relays: {
        async query(): Promise<Event[]> {
          throw new Error('all relays are offline');
        },
      },
      now: () => NOW_MS,
      logger: () => undefined,
    });
    const list = await directory.list();
    expect(list.nodes).toEqual([]);
    expect(directory.status().last_error).toContain('offline');
  });
});

describe('GET /nodes', () => {
  function ready(): { app: Hono; relays: FakeRelays } {
    const relays = new FakeRelays();
    relays.events = [announce(hubSk, { role: 'hub' }), announce(seedSk, { role: 'seed' })];
    return { app: appFor(makeDirectory(relays)), relays };
  }

  it('answers with the directory contract', async () => {
    const { app } = ready();
    const res = await app.request('/nodes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      count: number;
      ttl: number;
      generated_at: number;
      stale_after_s: number;
      nodes: { node_id: string; pubkey: string; role: string; relay_urls: string[]; web_url: string | null; topics: string[]; checkpoint: number | null; seen_at: number; stale: boolean }[];
    };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.ttl).toBe(NODE_ANNOUNCE_TTL_S);
    expect(body.stale_after_s).toBe(Math.round(NODE_ANNOUNCE_TTL_S / 2));
    expect(Object.keys(body.nodes[0]!).sort()).toEqual(
      ['age_s', 'checkpoint', 'node_id', 'pubkey', 'relay_urls', 'role', 'seen_at', 'software', 'stale', 'topics', 'topic_count', 'verified', 'via', 'web_url'].sort(),
    );
  });

  it('filters by role and rejects an unknown one loudly', async () => {
    const { app } = ready();
    const seeds = await app.request('/nodes?role=seed');
    const seedBody = (await seeds.json()) as { count: number; nodes: { role: string }[] };
    expect(seeds.status).toBe(200);
    expect(seedBody.count).toBe(1);
    expect(seedBody.nodes[0]?.role).toBe('seed');

    const bogus = await app.request('/nodes?role=supernode');
    expect(bogus.status).toBe(400);
    const error = (await bogus.json()) as { reasons: string[] };
    expect(error.reasons[0]).toContain('client, writer, seed, hub');
  });

  it('validates limit', async () => {
    const { app } = ready();
    expect((await app.request('/nodes?limit=0')).status).toBe(400);
    expect((await app.request('/nodes?limit=201')).status).toBe(400);
    expect((await app.request('/nodes?limit=abc')).status).toBe(400);
    const ok = await app.request('/nodes?limit=1');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { count: number }).count).toBe(1);
  });

  it('serves raw signed events to peers, local-only on request', async () => {
    const { app } = ready();
    const raw = await app.request('/nodes?raw=1');
    const body = (await raw.json()) as { count: number; events: NostrEvent[]; local: boolean };
    expect(raw.status).toBe(200);
    expect(body.local).toBe(false);
    expect(body.count).toBe(2);
    expect(body.events[0]?.kind).toBe(30026);

    const local = await app.request('/nodes?raw=1&local=1');
    expect(((await local.json()) as { local: boolean }).local).toBe(true);
  });

  it('reports what the directory saw', async () => {
    const { app } = ready();
    const res = await app.request('/nodes/status');
    const body = (await res.json()) as { ok: boolean; nodes: number; fan_out: boolean };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.nodes).toBe(2);
    expect(body.fan_out).toBe(false);
  });
});
