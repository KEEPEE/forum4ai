/**
 * F4AI-40 — end-to-end node mesh (epic F4AI-35).
 *
 * Four real gateway instances built by `buildGateway` (the same function the
 * CLI uses), each with its OWN in-process relay, plus one real HTTP hop: the
 * seed is served on an ephemeral port so the hub's directory fetches
 * `GET <seed>/nodes?local=1&raw=1` over an actual socket. Relays are in-process
 * on purpose — the dev relays on 127.0.0.1 are shared and this test writes
 * mesh events into them; a shared relay would also make "who announced what"
 * unobservable, because every node would see every other node's announcement.
 *
 * What this file is the evidence for:
 *
 * 1. **Roles.** `hub` and `seed` announce themselves and show up in `/nodes`;
 *    `writer` and `client` do not announce at all — their relays hold no kind
 *    30026 event, and they never open the fan-out.
 * 2. **Freshness.** An announcement older than its TTL leaves the directory
 *    without anyone pruning it (NIP-40 `expiration` + TTL arithmetic).
 * 3. **Deletion.** A NIP-09 (kind 5) event naming the announcement's address
 *    removes the node — but only when its signer IS the node.
 * 4. **Auto-discovery.** `NODE_UPSTREAMS=auto` adds the seed's relay to the
 *    pool as read-only; `manual` (the default) leaves the pool exactly as
 *    configured.
 * 5. **Backward compatibility, the law.** An instance with no new env
 *    variable makes ZERO new outbound connections, publishes ZERO events and
 *    issues ZERO upstream HTTP requests — measured, not asserted by reading
 *    the code.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  KINDS,
  buildNodeAnnounceUnsigned,
  nodeAddress,
  nodeIdFromPubkey,
} from '@forum4ai/shared';

import { buildGateway, type GatewayRuntime } from '../src/config.js';
import { startGatewayServer, type RunningGateway } from '../src/server.js';
import {
  normalizeRelayUrl,
  type RelayConnector,
  type RelayLike,
  type SubscribeHandlers,
  type SubscriptionLike,
} from '../src/relay-pool.js';

// ── in-process relay ───────────────────────────────────────────────────────

class MemRelay implements RelayLike {
  readonly url: string;
  connected = true;
  onclose: (() => void) | null = null;
  readonly store = new Map<string, Event>();
  /** every accepted publish — the counter the back-compat assertions read */
  publishes = 0;
  /** how many times ANY gateway subscribed (read fan-out evidence) */
  queries = 0;

  constructor(url: string) {
    this.url = url;
  }

  async publish(event: Event): Promise<string> {
    if (!this.connected) throw new Error('Tried to send message on a closed connection');
    this.publishes += 1;
    this.store.set(event.id, event);
    return `OK ${event.id.slice(0, 8)}`;
  }

  subscribe(filters: Filter[], params: SubscribeHandlers): SubscriptionLike {
    this.queries += 1;
    const matches: Event[] = [];
    for (const event of this.store.values()) {
      if (filters.some((filter) => matchesFilter(event, filter))) matches.push(event);
    }
    matches.sort((a, b) => a.created_at - b.created_at);
    for (const event of matches) params.onevent?.(event);
    setTimeout(() => params.oneose?.(), 0);
    return { close: () => undefined };
  }

  close(): void {
    this.connected = false;
    this.onclose?.();
  }

  kinds(kind: number): Event[] {
    return [...this.store.values()].filter((event) => event.kind === kind);
  }
}

function matchesFilter(event: Event, filter: Filter): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  return true;
}

/** one relay per URL, shared by every gateway that dials that URL */
const relayRegistry = new Map<string, MemRelay>();
const connectLog: string[] = [];

/** keyed by the pool's own canonical form, so a configured relay and the
 * same URL discovered later resolve to ONE relay instance */
function relayFor(raw: string): MemRelay {
  const url = normalizeRelayUrl(raw) ?? raw;
  let relay = relayRegistry.get(url);
  if (relay === undefined) {
    relay = new MemRelay(url);
    relayRegistry.set(url, relay);
  }
  return relay;
}

const connector: RelayConnector = async (url) => {
  connectLog.push(url);
  return relayFor(url);
};

// ── counting upstream (proves "no new outbound request") ───────────────────

interface CountingUpstream {
  base: string;
  /** requests per path, so `/nodes` fan-out is distinguishable from anything else */
  hits: Map<string, number>;
  close(): Promise<void>;
}

let upstream: CountingUpstream | null = null;

async function startCountingUpstream(): Promise<CountingUpstream> {
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    res.writeHead(200, { 'content-type': 'application/json' });
    // a valid but empty peer answer — the point is the HIT, not the payload
    res.end(JSON.stringify({ ok: true, generated_at: Math.floor(Date.now() / 1000), count: 0, events: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// ── gateway instances ──────────────────────────────────────────────────────

interface MeshNode {
  name: string;
  rt: GatewayRuntime;
  app: Hono;
  relay: MemRelay;
  gateway: RunningGateway | null;
  base: string;
}

const SK = {
  hub: '11'.repeat(32),
  seed: '22'.repeat(32),
  writer: '33'.repeat(32),
  client: '34'.repeat(32),
  auto: '35'.repeat(32),
  legacy: '36'.repeat(32),
};

function pubkeyOf(skHex: string): string {
  return getPublicKey(Uint8Array.from(Buffer.from(skHex, 'hex'))).toLowerCase();
}

const nodes: MeshNode[] = [];
const servers: RunningGateway[] = [];

async function spawn(
  name: string,
  env: Record<string, string | undefined>,
  relayUrl: string,
  serve = false,
): Promise<MeshNode> {
  const rt = buildGateway(
    {
      GATEWAY_QUIET: '1',
      GATEWAY_RELAY_URLS: relayUrl,
      // The mesh is a state machine: every test mutates a relay and reads the
      // directory again within milliseconds. `/nodes` is cached for 5 s in
      // production (that is the point of it), so a test that reads twice would
      // otherwise assert against the previous snapshot.
      GATEWAY_READ_CACHE_MS: '0',
      ...env,
    },
    {
      connector,
      logger: () => undefined,
      disableWebsocket: true,
      disableReadRoutes: true,
      disableSearchRoutes: true,
      disableReputationRoutes: true,
      disableIdeasRoutes: true,
      disablePapersRoutes: true,
      indexDb: null,
    },
  );
  let gateway: RunningGateway | null = null;
  if (serve) {
    gateway = await startGatewayServer(rt.app, { port: 0, hostname: '127.0.0.1' });
    servers.push(gateway);
  }
  const node: MeshNode = {
    name,
    rt,
    app: rt.app,
    relay: relayFor(relayUrl),
    gateway,
    base: gateway?.url ?? '',
  };
  nodes.push(node);
  return node;
}

function teardown(node: MeshNode): void {
  node.rt.node.discovery?.stop();
  node.rt.node.directory.stop();
  node.rt.fed.close();
  node.rt.pool.close();
}

let hub: MeshNode;
let seed: MeshNode;
let writer: MeshNode;
let client: MeshNode;
let auto: MeshNode;
let legacy: MeshNode;

beforeAll(async () => {
  upstream = await startCountingUpstream();

  // the seed is the only node served over a real socket: the hub and the auto
  // node must reach it through HTTP, exactly like a peer would
  seed = await spawn(
    'seed',
    { NODE_ROLE: 'seed', NODE_SK: SK.seed, NODE_ALLOW_PRIVATE: 'on' },
    'ws://seed-relay.test:1',
    true,
  );
  hub = await spawn(
    'hub',
    {
      NODE_ROLE: 'hub',
      NODE_SK: SK.hub,
      NODE_ALLOW_PRIVATE: 'on',
      GATEWAY_UPSTREAM_GATEWAYS: seed.base,
    },
    'ws://hub-relay.test:1',
  );
  writer = await spawn(
    'writer',
    { NODE_ROLE: 'writer', NODE_SK: SK.writer, GATEWAY_UPSTREAM_GATEWAYS: seed.base },
    'ws://writer-relay.test:1',
  );
  client = await spawn(
    'client',
    { NODE_ROLE: 'client', NODE_SK: SK.client, GATEWAY_UPSTREAM_GATEWAYS: seed.base },
    'ws://client-relay.test:1',
  );
  auto = await spawn(
    'auto',
    {
      NODE_ROLE: 'hub',
      NODE_SK: SK.auto,
      NODE_ALLOW_PRIVATE: 'on',
      NODE_UPSTREAMS: 'auto',
      GATEWAY_UPSTREAM_GATEWAYS: seed.base,
    },
    'ws://auto-relay.test:1',
  );
  // the law: no new env at all, but an upstream IS configured, so a fan-out
  // would be visible in `upstream.hits`
  legacy = await spawn(
    'legacy',
    { GATEWAY_UPSTREAM_GATEWAYS: upstream.base },
    'ws://legacy-relay.test:1',
  );

  // one heartbeat each, deterministic (no timers involved)
  await hub.rt.node.announcer?.announceOnce();
  await seed.rt.node.announcer?.announceOnce();
});

afterAll(async () => {
  for (const node of nodes) teardown(node);
  for (const server of servers) await server.close();
  await upstream?.close();
  upstream = null;
});

type NodesBody = {
  ok: boolean;
  count: number;
  ttl?: number;
  stale_after_s?: number;
  nodes?: Array<Record<string, unknown>>;
  discovery?: Record<string, unknown>;
  error?: string;
  reasons?: string[];
};

async function nodesOf(node: MeshNode, query = ''): Promise<NodesBody> {
  const res = await node.app.request(`/nodes${query}`);
  expect(res.status, `${node.name} /nodes${query}`).toBe(200);
  return (await res.json()) as NodesBody;
}

// ── 1. roles ───────────────────────────────────────────────────────────────

describe('mesh roles decide who is in /nodes', () => {
  it('hub and seed announce themselves; writer and client publish nothing', async () => {
    expect(hub.rt.node.announcer).not.toBeNull();
    expect(seed.rt.node.announcer).not.toBeNull();
    expect(writer.rt.node.announcer).toBeNull();
    expect(client.rt.node.announcer).toBeNull();

    // the announcement really is on the wire, signed by the node key
    const hubEvents = hub.relay.kinds(KINDS.NODE_ANNOUNCE);
    expect(hubEvents).toHaveLength(1);
    expect(hubEvents[0]?.pubkey).toBe(pubkeyOf(SK.hub));
    const seedEvents = seed.relay.kinds(KINDS.NODE_ANNOUNCE);
    expect(seedEvents).toHaveLength(1);

    // writer/client: not one byte of mesh traffic on their relays
    expect(writer.relay.kinds(KINDS.NODE_ANNOUNCE)).toEqual([]);
    expect(client.relay.kinds(KINDS.NODE_ANNOUNCE)).toEqual([]);
  });

  it('the hub directory lists the hub and the seed, and nobody else', async () => {
    await hub.rt.node.directory.refresh();
    const body = await nodesOf(hub);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    const byRole = new Map((body.nodes ?? []).map((n) => [String(n['role']), n]));
    expect([...byRole.keys()].sort()).toEqual(['hub', 'seed']);
    expect(String(byRole.get('hub')?.['pubkey'])).toBe(pubkeyOf(SK.hub));
    expect(String(byRole.get('seed')?.['pubkey'])).toBe(pubkeyOf(SK.seed));
    // the seed was learned through the upstream hop, not from our own relay
    const seedVia = byRole.get('seed')?.['via'];
    expect(Array.isArray(seedVia)).toBe(true);
    expect((seedVia as unknown[]).length).toBe(1);
    expect(byRole.get('hub')?.['via']).toEqual([]);
    // relay urls survive the round trip (they are what discovery consumes)
    expect(byRole.get('seed')?.['relay_urls']).toEqual(['ws://seed-relay.test:1']);
    expect(typeof byRole.get('seed')?.['seen_at']).toBe('number');
    expect(typeof byRole.get('seed')?.['age_s']).toBe('number');
    expect(byRole.get('seed')?.['stale']).toBe(false);
  });

  it('?role= filters server-side and a bad role is a loud 400', async () => {
    const seeds = await nodesOf(hub, '?role=seed');
    expect(seeds.count).toBe(1);
    expect(String(seeds.nodes?.[0]?.['role'])).toBe('seed');

    const writers = await nodesOf(hub, '?role=writer');
    expect(writers.count).toBe(0);

    const bad = await hub.app.request('/nodes?role=supernode');
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; reasons: string[] };
    expect(body.error).toBe('invalid role');
    expect(body.reasons?.[0]).toContain('client, writer, seed, hub');

    const badLimit = await hub.app.request('/nodes?limit=0');
    expect(badLimit.status).toBe(400);
  });

  it('writer and client serve an empty directory and never fan out', async () => {
    const writerBody = await nodesOf(writer);
    expect(writerBody.count).toBe(0);
    expect(writerBody.nodes).toEqual([]);
    expect(writer.rt.node.directory.fanOut).toBe(false);
    expect(writer.rt.node.discovery).toBeNull();
    // the counting upstream never heard from them
    expect(upstream?.hits.size ?? 0).toBe(0);
  });

  it('the peer view (?local=1&raw=1) returns signed events, not our parsing', async () => {
    const res = await seed.app.request('/nodes?local=1&raw=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; local: boolean; events: Event[] };
    expect(body.local).toBe(true);
    expect(body.count).toBe(1);
    expect(body.events[0]?.kind).toBe(KINDS.NODE_ANNOUNCE);
    expect(typeof body.events[0]?.sig).toBe('string');
    expect((body.events[0]?.sig ?? '').length).toBe(128);
  });
});

// ── 2. TTL and deletion ────────────────────────────────────────────────────

describe('the directory ages out and deletes announcements', () => {
  const ghostSk = generateSecretKey();
  const ghostPubkey = getPublicKey(ghostSk);

  function signAnnounce(createdAt: number, ttlS = 300): Event {
    const built = buildNodeAnnounceUnsigned({
      pubkey: ghostPubkey,
      role: 'hub',
      relays: ['ws://ghost-relay.test:1'],
      created_at: createdAt,
      ttlS,
      allowPrivateHosts: true,
    });
    return finalizeEvent(
      { kind: built.kind, created_at: built.created_at, tags: built.tags, content: built.content },
      ghostSk,
    );
  }

  it('an announcement older than its TTL drops out without anyone pruning it', async () => {
    const ghostId = nodeIdFromPubkey(ghostPubkey);
    const stale = signAnnounce(Math.floor(Date.now() / 1000) - 400); // TTL 300 → expired
    hub.relay.store.set(stale.id, stale);

    await hub.rt.node.directory.refresh();
    const body = await nodesOf(hub);
    const ids = (body.nodes ?? []).map((n) => String(n['node_id']));
    expect(ids).not.toContain(ghostId);

    // the same node with a fresh heartbeat is back — TTL is arithmetic, not a
    // prune job, so it recovers on its own
    const fresh = signAnnounce(Math.floor(Date.now() / 1000));
    hub.relay.store.set(fresh.id, fresh);
    await hub.rt.node.directory.refresh();
    const again = await nodesOf(hub);
    expect((again.nodes ?? []).map((n) => String(n['node_id']))).toContain(ghostId);
    hub.relay.store.delete(stale.id);
    hub.relay.store.delete(fresh.id);
  });

  it('a NIP-09 deletion naming the address removes the node', async () => {
    const victimSk = generateSecretKey();
    const victimPubkey = getPublicKey(victimSk);
    const announce = finalizeEvent(
      (() => {
        const built = buildNodeAnnounceUnsigned({
          pubkey: victimPubkey,
          role: 'seed',
          relays: ['ws://victim-relay.test:1'],
          allowPrivateHosts: true,
        });
        return { kind: built.kind, created_at: built.created_at, tags: built.tags, content: built.content };
      })(),
      victimSk,
    );
    hub.relay.store.set(announce.id, announce);
    await hub.rt.node.directory.refresh();
    const victimId = nodeIdFromPubkey(victimPubkey);
    expect((await nodesOf(hub)).nodes?.map((n) => String(n['node_id']))).toContain(victimId);

    // a stranger may name the address, but only the signer may delete it
    const strangerDeletion = finalizeEvent(
      {
        kind: 5,
        created_at: Math.floor(Date.now() / 1000) + 1,
        tags: [['a', nodeAddress({ pubkey: victimPubkey, node_id: victimId })]],
        content: '',
      },
      generateSecretKey(),
    );
    hub.relay.store.set(strangerDeletion.id, strangerDeletion);
    await hub.rt.node.directory.refresh();
    expect((await nodesOf(hub)).nodes?.map((n) => String(n['node_id']))).toContain(victimId);
    hub.relay.store.delete(strangerDeletion.id);

    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: Math.floor(Date.now() / 1000) + 2,
        tags: [['a', nodeAddress({ pubkey: victimPubkey, node_id: victimId })]],
        content: '',
      },
      victimSk,
    );
    hub.relay.store.set(deletion.id, deletion);
    await hub.rt.node.directory.refresh();
    const after = await nodesOf(hub);
    expect(after.nodes?.map((n) => String(n['node_id']))).not.toContain(victimId);
    // and the rest of the mesh is untouched
    expect(after.count).toBe(2);
    // leave the hub relay exactly as we found it — later tests read the same
    // directory and assert an exact count
    hub.relay.store.delete(deletion.id);
    hub.relay.store.delete(announce.id);
  });
});

// ── 3. auto-discovery ──────────────────────────────────────────────────────

describe('NODE_UPSTREAMS=auto borrows the seed relay', () => {
  it('adds the announced seed relay to the pool as read-only', async () => {
    expect(auto.rt.node.discovery).not.toBeNull();
    expect(auto.rt.pool.urls).toEqual(['ws://auto-relay.test:1/']);

    await auto.rt.node.discovery?.tick();

    const discovered = auto.rt.pool.discoveredUrls();
    expect(discovered).toEqual(['ws://seed-relay.test:1/']);
    const status = auto.rt.pool.status();
    const seedEntry = status.find((entry) => entry.url === 'ws://seed-relay.test:1/');
    expect(seedEntry?.discovered).toBe(true);
    expect(seedEntry?.write).toBe(false);
    // writes stay inside our own relay — a stranger never gets our events
    expect(auto.rt.pool.writeUrls()).toEqual(['ws://auto-relay.test:1/']);

    const statusRes = await auto.app.request('/nodes/status');
    expect(statusRes.status).toBe(200);
    const body = (await statusRes.json()) as NodesBody;
    expect(body.discovery).toBeDefined();
    const relays = (body.discovery?.['relays'] ?? []) as Array<Record<string, unknown>>;
    expect(relays.map((r) => String(r['url']))).toContain('ws://seed-relay.test:1/');
  });

  it('manual mode (the default) leaves the pool exactly as configured', async () => {
    expect(hub.rt.node.discovery).toBeNull();
    expect(hub.rt.pool.urls).toEqual(['ws://hub-relay.test:1/']);
    expect(hub.rt.pool.discoveredUrls()).toEqual([]);
    // the hub knows the seed from /nodes but did NOT dial its relay
    await hub.rt.node.directory.refresh();
    expect((await nodesOf(hub)).count).toBe(2);
    expect(hub.rt.pool.urls).toEqual(['ws://hub-relay.test:1/']);
  });

  it('a seed that stops announcing is dropped from the pool again', async () => {
    const discovery = auto.rt.node.discovery;
    expect(discovery).not.toBeNull();
    if (discovery === null) return;

    // the seed's relay keeps its announcement, so hide it the way a dead seed
    // would: the upstream stops answering with the node
    const seedEvent = seed.relay.kinds(KINDS.NODE_ANNOUNCE)[0];
    expect(seedEvent).toBeDefined();
    seed.relay.store.delete(seedEvent?.id ?? '');
    // the seed's own directory must forget it too, otherwise its peer answer
    // still carries the announcement and nothing changed for the auto node
    await seed.rt.node.directory.refresh();
    // 3 misses (maxMisses = 2) then retract; the auto node's directory is
    // refreshed each round so the cache cannot hide the disappearance
    for (let i = 0; i < 4; i += 1) {
      await auto.rt.node.directory.refresh();
      await discovery.tick();
    }
    expect(auto.rt.pool.discoveredUrls()).toEqual([]);
    expect(auto.rt.pool.urls).toEqual(['ws://auto-relay.test:1/']);

    // restore for any later assertion
    if (seedEvent !== undefined) seed.relay.store.set(seedEvent.id, seedEvent);
    await seed.rt.node.directory.refresh();
  });
});

// ── 4. backward compatibility, measured ────────────────────────────────────

describe('an instance with no new env changes nothing', () => {
  it('zero new connections, zero publishes, zero upstream requests', async () => {
    expect(legacy.rt.node.config.role).toBe('hub');
    expect(legacy.rt.node.config.announce).toBe(false);
    expect(legacy.rt.node.config.upstreamsMode).toBe('manual');
    expect(legacy.rt.node.announcer).toBeNull();
    expect(legacy.rt.node.discovery).toBeNull();
    expect(legacy.rt.node.directory.fanOut).toBe(false);

    // the pool holds exactly the configured relay, and the connector was
    // asked for nothing else
    await legacy.rt.pool.connectAll();
    expect(legacy.rt.pool.urls).toEqual(['ws://legacy-relay.test:1/']);
    expect(connectLog.filter((url) => url === 'ws://legacy-relay.test:1/')).toHaveLength(1);
    expect(connectLog.filter((url) => url.startsWith('ws://legacy'))).toHaveLength(1);

    // a directory refresh + a /nodes read: reads on an existing connection,
    // no announcement, no fan-out
    const before = legacy.relay.publishes;
    await legacy.rt.node.directory.refresh();
    const body = await nodesOf(legacy);
    expect(body.count).toBe(0);
    expect(legacy.relay.publishes).toBe(before);
    // the whole point: the counting upstream was never dialed
    expect(upstream?.hits.get('/nodes') ?? 0).toBe(0);
    expect(upstream?.hits.size ?? 0).toBe(0);

    // and the response shape is the old one — no `discovery` key appears
    expect(body.discovery).toBeUndefined();
    const statusRes = await legacy.app.request('/nodes/status');
    const statusBody = (await statusRes.json()) as NodesBody;
    expect(statusBody.discovery).toBeUndefined();
    expect(statusBody.fan_out).toBe(false);
  });

  it('writes are still accepted and /register is still mounted', async () => {
    const res = await legacy.app.request('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(['NOT-EVENT', 'nope']),
    });
    // 400 from the parser, NOT 405 — a legacy instance is not read-only
    expect(res.status).toBe(400);
    // mounted (NOT 404/405). Without GATEWAY_OWNER_SK_HEX the challenge has no
    // scope to sign, which is a 503 — the same answer a legacy instance gave
    // before the mesh existed.
    const register = await legacy.app.request('/register/challenge?pubkey=' + 'a'.repeat(64));
    expect(register.status).not.toBe(404);
    expect(register.status).not.toBe(405);
    expect([200, 503]).toContain(register.status);
  });
});
