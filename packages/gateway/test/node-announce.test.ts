/**
 * Node announcement heartbeat (F4AI-36) and the topic projection it advertises.
 *
 * The heartbeat is the liveness protocol of the mesh, so these tests pin the
 * exact shape a stranger will parse, plus the compatibility promise: an
 * instance that sets no new environment variable must not publish a single
 * extra event, and must not open a single extra connection.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';

import {
  NODE_ANNOUNCE_TTL_S,
  NODE_ROLE_NAMESPACE,
  countLeadingZeroBits,
  deletionRemovesNode,
  nodeIdFromPubkey,
  parseNodeAnnounce,
  parseNodeDeletion,
  verifyFull,
  type NostrEvent,
} from '@forum4ai/shared';

import { buildGateway } from '../src/config.js';
import { NodeAnnouncer, type AnnouncePool, type NodeAnnouncerOptions } from '../src/node-announce.js';
import { createIndexTopicProvider, slugFromTopicAddress } from '../src/node-topics.js';
import type { PublishResult, RelayConnector, RelayLike } from '../src/relay-pool.js';

const sk = generateSecretKey();
const PUBKEY = getPublicKey(sk).toLowerCase();
const SK_HEX = Buffer.from(sk).toString('hex');

class RecordingPool implements AnnouncePool {
  events: Event[] = [];
  results: PublishResult[] = [{ url: 'wss://relay.example.com', ok: true, message: 'stored' }];

  async publish(event: Event): Promise<PublishResult[]> {
    this.events.push(event);
    return this.results;
  }
}

function makeAnnouncer(pool: AnnouncePool, overrides?: Partial<NodeAnnouncerOptions>): NodeAnnouncer {
  return new NodeAnnouncer({
    skHex: SK_HEX,
    role: 'hub',
    pool,
    relays: () => ['wss://relay.example.com', 'wss://backup.example.com'],
    software: 'forum4ai/test',
    webUrl: 'https://forum.example.com',
    ttlS: NODE_ANNOUNCE_TTL_S,
    heartbeatMs: 60_000,
    topics: () => ['ai-agents', 'nostr'],
    topicCount: () => 42,
    checkpoint: () => 1_780_000_000,
    logger: () => undefined,
    ...overrides,
  });
}

describe('NodeAnnouncer', () => {
  it('derives the node id from the node key, not from the host', () => {
    const announcer = makeAnnouncer(new RecordingPool());
    expect(announcer.pubkey).toBe(PUBKEY);
    expect(announcer.nodeId).toBe(nodeIdFromPubkey(PUBKEY));
    expect(announcer.enabled).toBe(true);
  });

  it('publishes a signed announcement a stranger can parse', async () => {
    const pool = new RecordingPool();
    const announcer = makeAnnouncer(pool);
    const outcome = await announcer.announceOnce();
    expect(outcome).not.toBeNull();
    expect(pool.events).toHaveLength(1);
    const event = pool.events[0]!;
    expect(event.kind).toBe(30026);
    expect(event.pubkey).toBe(PUBKEY);
    expect(verifyFull(event as unknown as NostrEvent)).toBe(true);

    const parsed = parseNodeAnnounce(event as unknown as NostrEvent, { now: event.created_at });
    expect(parsed.reason).toBeUndefined();
    expect(parsed.node).toMatchObject({
      node_id: nodeIdFromPubkey(PUBKEY),
      pubkey: PUBKEY,
      role: 'hub',
      relay_urls: ['wss://relay.example.com', 'wss://backup.example.com'],
      web_url: 'https://forum.example.com',
      topics: ['ai-agents', 'nostr'],
      topic_count: 42,
      checkpoint: 1_780_000_000,
      software: 'forum4ai/test',
      offline: false,
    });
    expect(parsed.node!.expires_at).toBe(event.created_at + NODE_ANNOUNCE_TTL_S);
    // the role label is in its own NIP-32 namespace
    expect(event.tags).toContainEqual(['l', 'hub', NODE_ROLE_NAMESPACE]);
  });

  it('mines PoW when the relay demands it', async () => {
    const pool = new RecordingPool();
    const announcer = makeAnnouncer(pool, { powMin: 3 });
    const outcome = await announcer.announceOnce();
    const event = pool.events[0]!;
    expect(outcome).not.toBeNull();
    expect(countLeadingZeroBits(event.id)).toBeGreaterThanOrEqual(3);
    expect(event.tags.some((tag) => tag[0] === 'nonce')).toBe(true);
  });

  it('survives relays that refuse it and reports the failure', async () => {
    const pool = new RecordingPool();
    pool.results = [{ url: 'wss://relay.example.com', ok: false, message: 'pow: difficulty 18' }];
    const announcer = makeAnnouncer(pool);
    const outcome = await announcer.announceOnce();
    expect(outcome?.delivered).toBe(0);
    const status = announcer.getStatus();
    expect(status.failures).toBe(1);
    expect(status.publishes).toBe(0);
    expect(status.last_error).toContain('difficulty');
  });

  it('does not publish at all when the instance has no relay', async () => {
    const pool = new RecordingPool();
    const announcer = makeAnnouncer(pool, { relays: () => [] });
    expect(await announcer.announceOnce()).toBeNull();
    expect(pool.events).toHaveLength(0);
  });

  /**
   * The reference compose connects to container addresses (`ws://relay:8080`),
   * which the sanitizer drops: no `ws://` scheme, no single-label host. The
   * heartbeat would still be mined and published, and the log would say
   * `delivered 1/1` — while every directory rejects it with `no_public_relays`.
   * A node that cannot be listed must not claim to be in the mesh.
   */
  it('does not publish a heartbeat that has no public relay to advertise', async () => {
    const pool = new RecordingPool();
    const logs: string[] = [];
    const announcer = makeAnnouncer(pool, {
      relays: () => ['ws://relay:8080', 'ws://strfry:7777'],
      logger: (line) => logs.push(line),
    });
    expect(await announcer.announceOnce()).toBeNull();
    expect(pool.events).toHaveLength(0);
    expect(announcer.getStatus().last_error).toContain('no public relay url');
    expect(logs.join('\n')).toContain('announce skipped');

    // the escape hatch is the operator saying "this is a LAN mesh"
    const lan = makeAnnouncer(pool, {
      relays: () => ['ws://relay:8080'],
      allowPrivateHosts: true,
    });
    expect(await lan.announceOnce()).not.toBeNull();
    const event = pool.events.at(-1)!;
    expect(event.tags.some((tag) => tag[0] === 'r' && tag[1].includes('relay:8080'))).toBe(true);
  });

  it('without a node key it is disabled instead of throwing', async () => {
    const pool = new RecordingPool();
    const announcer = makeAnnouncer(pool, { skHex: '' });
    expect(announcer.enabled).toBe(false);
    expect(await announcer.announceOnce()).toBeNull();
    expect(pool.events).toHaveLength(0);
  });

  it('a graceful stop publishes the offline tombstone on the same address', async () => {
    const pool = new RecordingPool();
    const announcer = makeAnnouncer(pool);
    await announcer.announceOnce();
    await announcer.stop();
    expect(pool.events).toHaveLength(2);
    const tombstone = pool.events[1]!;
    expect(tombstone.kind).toBe(30026);
    expect(tombstone.tags).toContainEqual(['d', nodeIdFromPubkey(PUBKEY)]);
    expect(tombstone.tags).toContainEqual(['l', 'offline', NODE_ROLE_NAMESPACE]);
    expect(tombstone.tags.some((tag) => tag[0] === 'r')).toBe(false);
    expect(tombstone.tags).toContainEqual(['expiration', String(tombstone.created_at)]);
    const parsed = parseNodeAnnounce(tombstone as unknown as NostrEvent, { now: tombstone.created_at });
    expect(parsed.node?.offline).toBe(true);
  });

  it('a NIP-09 deletion only removes the announcement its signer owns', () => {
    const address = `30026:${PUBKEY}:${nodeIdFromPubkey(PUBKEY)}`;
    const own = finalizeEvent(
      { kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['a', address]], content: '' },
      sk,
    ) as unknown as NostrEvent;
    const foreign = finalizeEvent(
      { kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['a', address]], content: '' },
      generateSecretKey(),
    ) as unknown as NostrEvent;
    const record = parseNodeAnnounce(
      finalizeEvent(
        {
          kind: 30026,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', nodeIdFromPubkey(PUBKEY)],
            ['L', NODE_ROLE_NAMESPACE],
            ['l', 'hub', NODE_ROLE_NAMESPACE],
            ['r', 'wss://relay.example.com'],
          ],
          content: '',
        },
        sk,
      ) as unknown as NostrEvent,
    ).node!;
    expect(deletionRemovesNode(parseNodeDeletion(own)!, record)).toBe(true);
    // the address matches but the signer does not — so nothing is removed
    expect(deletionRemovesNode(parseNodeDeletion(foreign)!, record)).toBe(false);
  });
});

describe('legacy compatibility', () => {
  class FakeRelay implements RelayLike {
    readonly connected = true;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {}
    async publish(): Promise<string> {
      return 'OK';
    }
    subscribe(): { close(): void } {
      return { close: () => undefined };
    }
    close(): void {
      return undefined;
    }
  }

  function buildWithCounter(env: Record<string, string | undefined>) {
    const connects: string[] = [];
    const publishes: string[] = [];
    const connector: RelayConnector = async (url) => {
      connects.push(url);
      const relay = new FakeRelay(url);
      const original = relay.publish.bind(relay);
      relay.publish = async (): Promise<string> => {
        publishes.push(url);
        return original();
      };
      return relay;
    };
    const runtime = buildGateway(
      { GATEWAY_QUIET: '1', GATEWAY_RELAY_URLS: 'ws://relay.test:1', ...env },
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
    return { runtime, connects, publishes };
  }

  it('an instance with no new env has no announcer at all', () => {
    const { runtime } = buildWithCounter({});
    try {
      expect(runtime.node.announcer).toBeNull();
      expect(runtime.node.config.role).toBe('hub');
      expect(runtime.node.config.announce).toBe(false);
    } finally {
      runtime.fed.close();
      runtime.pool.close();
    }
  });

  it('a named hub role turns the announcer on', () => {
    const { runtime } = buildWithCounter({ NODE_ROLE: 'hub', NODE_SK: SK_HEX });
    try {
      expect(runtime.node.announcer).not.toBeNull();
      expect(runtime.node.announcer?.pubkey).toBe(PUBKEY);
    } finally {
      runtime.fed.close();
      runtime.pool.close();
    }
  });

  it('GET /health reports the effective role', async () => {
    const { runtime } = buildWithCounter({ NODE_ROLE: 'seed', NODE_SK: SK_HEX });
    try {
      const res = await runtime.app.request('/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { node?: { role: string; announce: boolean; pubkey: string | null } };
      expect(body.node?.role).toBe('seed');
      expect(body.node?.announce).toBe(true);
      expect(body.node?.pubkey).toBe(PUBKEY);
    } finally {
      runtime.fed.close();
      runtime.pool.close();
    }
  });

  /**
   * The mirror of the test above, and the one that actually protects the
   * compatibility promise: `node` is a NEW key in `/health`, so an instance
   * that sets none of the mesh variables must not grow it. A response shape
   * change with no new environment variable is still a breaking change for a
   * client that walks the object.
   */
  it('GET /health carries no node key for an instance with no new env', async () => {
    const { runtime } = buildWithCounter({});
    try {
      const res = await runtime.app.request('/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.node).toBeUndefined();
      // the keys a pre-mesh client saw are all still there
      expect(body.status).toBe('ok');
      expect(typeof (body.relays as { connected?: unknown }).connected).toBe('string');
    } finally {
      runtime.fed.close();
      runtime.pool.close();
    }
  });

  /**
   * `NODE_UPSTREAMS=auto` changes behaviour without naming a role, so the
   * operator still needs to see the effective configuration — the gate is
   * "the mesh was switched on", not "a role was named".
   */
  it('GET /health reports the node key when only NODE_UPSTREAMS is set', async () => {
    const { runtime } = buildWithCounter({ NODE_UPSTREAMS: 'auto' });
    try {
      const res = await runtime.app.request('/health');
      const body = (await res.json()) as { node?: { role: string; announce: boolean; upstreams: string } };
      expect(body.node?.role).toBe('hub');
      expect(body.node?.announce).toBe(false);
      expect(body.node?.upstreams).toBe('auto');
    } finally {
      runtime.fed.close();
      runtime.pool.close();
    }
  });
});

describe('topic projection for the announcement', () => {
  it('parses the slug out of a topic address', () => {
    expect(slugFromTopicAddress(`30020:${'a'.repeat(64)}:ai-agents`)).toBe('ai-agents');
    expect(slugFromTopicAddress('nonsense')).toBeNull();
    expect(slugFromTopicAddress(':x')).toBeNull();
  });

  it('reads newest slugs and the distinct count from the index', async () => {
    const queries: string[] = [];
    const provider = createIndexTopicProvider({
      path: '/tmp/index.test.db',
      open: () =>
        ({
          prepare: (sql: string) => {
            queries.push(sql);
            if (sql.includes('COUNT')) return { get: () => ({ n: 137 }) };
            return {
              all: () => [
                { addr: `30020:${'a'.repeat(64)}:ai-agents` },
                { addr: `30020:${'b'.repeat(64)}:nostr` },
                { addr: `30020:${'a'.repeat(64)}:ai-agents` },
                { addr: null },
              ],
            };
          },
          close: () => undefined,
        }) as never,
    });
    const snapshot = await provider.snapshot();
    expect(snapshot.slugs).toEqual(['ai-agents', 'nostr']);
    expect(snapshot.count).toBe(137);
    expect(queries).toHaveLength(2);
    expect(await provider.topics()).toEqual(['ai-agents', 'nostr']);
  });

  it('degrades to no topics when the index is missing or broken', async () => {
    const noPath = createIndexTopicProvider({ path: null });
    expect(await noPath.topics()).toEqual([]);
    expect(await noPath.count()).toBeNull();

    const broken = createIndexTopicProvider({
      path: '/tmp/does-not-exist.db',
      open: () => {
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      },
      logger: () => undefined,
    });
    expect(await broken.topics()).toEqual([]);
    expect(await broken.count()).toBeNull();
  });
});
