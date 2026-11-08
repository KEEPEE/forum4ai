/**
 * F4AI-38 unit tests — auto-discovery without a network.
 *
 * `NodeDiscovery` gets a fake pool (records every `add`/`remove` with its
 * flags) and a fake directory (returns the nodes we want it to see), so the
 * interesting behaviour — who is eligible, who is rejected and why, who gets
 * retracted — is asserted directly instead of being inferred from sockets.
 */
import { describe, expect, it } from 'vitest';

import {
  NodeDiscovery,
  type DiscoveryDirectory,
  type DiscoveryPool,
} from '../src/node-discovery.js';
import type { NodeEntry, NodeList } from '../src/node-directory.js';
import { normalizeRelayUrl } from '../src/relay-pool.js';

interface PoolEntry {
  url: string;
  write: boolean;
  discovered: boolean;
  connected: boolean;
  attempts: number;
}

class FakePool implements DiscoveryPool {
  private readonly entries: PoolEntry[] = [];
  /** every `add()` call, so the flags can be asserted */
  readonly adds: { url: string; write: boolean; discovered: boolean }[] = [];
  readonly removes: string[] = [];

  get urls(): string[] {
    return this.entries.map((e) => e.url);
  }

  add(raw: string, opts?: { write?: boolean; discovered?: boolean }): string | null {
    // the real pool stores the NORMALIZED url; do the same so dedupe
    // assertions test the real key
    const url = normalizeRelayUrl(raw) ?? raw;
    if (this.entries.some((e) => e.url === url)) return url;
    this.entries.push({
      url,
      write: opts?.write ?? true,
      discovered: opts?.discovered ?? false,
      connected: false,
      attempts: 0,
    });
    this.adds.push({ url, write: opts?.write ?? true, discovered: opts?.discovered ?? false });
    return url;
  }

  remove(url: string): boolean {
    const i = this.entries.findIndex((e) => e.url === url);
    if (i < 0) return false;
    this.entries.splice(i, 1);
    this.removes.push(url);
    return true;
  }

  discoveredUrls(): string[] {
    return this.entries.filter((e) => e.discovered).map((e) => e.url);
  }

  writeUrls(): string[] {
    return this.entries.filter((e) => e.write).map((e) => e.url);
  }

  status(): { url: string; connected: boolean; attempts: number }[] {
    return this.entries.map((e) => ({ url: e.url, connected: e.connected, attempts: e.attempts }));
  }

  setConnected(url: string, connected: boolean): void {
    const entry = this.entries.find((e) => e.url === url);
    if (entry !== undefined) entry.connected = connected;
  }
}

function node(overrides: Partial<NodeEntry> & { node_id: string; pubkey: string }): NodeEntry {
  return {
    role: 'seed',
    relay_urls: [],
    web_url: null,
    topics: [],
    topic_count: null,
    checkpoint: null,
    software: null,
    seen_at: 1_700_000_000,
    age_s: 10,
    stale: false,
    via: [],
    verified: false,
    ...overrides,
  };
}

function directory(nodes: NodeEntry[], warnings: string[] = []): DiscoveryDirectory {
  return {
    async list() {
      const list: NodeList = { generated_at: 1_700_000_000, ttl: 300, nodes, warnings };
      return list;
    },
  };
}

/** public host by default; `privateHosts` resolve into the RFC1918 range */
function resolver(privateHosts: ReadonlySet<string> = new Set()) {
  return async (host: string): Promise<string[]> =>
    privateHosts.has(host) ? ['10.0.0.5'] : ['93.184.216.34'];
}

function make(options: {
  nodes: NodeEntry[];
  pool?: FakePool;
  ownRelays?: string[];
  privateHosts?: Set<string>;
  resolve?: (host: string) => Promise<string[]>;
  now?: () => number;
  [key: string]: unknown;
}): { discovery: NodeDiscovery; pool: FakePool } {
  const pool = options.pool ?? new FakePool();
  // pass through only the extra knobs (maxTotal, maxPerUpstreams, …) — the
  // typed ones above must not be overwritten by the loose options bag
  const rest: Record<string, unknown> = { ...options };
  for (const key of ['nodes', 'pool', 'ownRelays', 'resolve', 'now']) delete rest[key];
  const discovery = new NodeDiscovery({
    pool,
    directory: directory(options.nodes),
    ownRelays: () => options.ownRelays ?? [],
    resolve: options.resolve ?? resolver(options.privateHosts ?? new Set()),
    now: options.now ?? (() => Date.now()),
    ...rest,
  });
  return { discovery, pool };
}

describe('NodeDiscovery — what becomes a relay', () => {
  it('adds seed and hub relays as read-only discovered entries', async () => {
    const { discovery, pool } = make({
      nodes: [
        node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['wss://seed.example'] }),
        node({
          node_id: 'f4ai-hub',
          pubkey: 'b'.repeat(64),
          role: 'hub',
          relay_urls: ['wss://hub.example'],
          // fresher than the seed — the pool takes the live one first
          seen_at: 1_700_000_100,
        }),
      ],
    });
    await discovery.tick();

    expect(pool.adds).toEqual([
      { url: 'wss://hub.example/', write: false, discovered: true },
      { url: 'wss://seed.example/', write: false, discovered: true },
    ]);
    // nothing may be written through a stranger relay
    expect(pool.writeUrls()).toEqual([]);
    expect(pool.discoveredUrls()).toEqual(['wss://hub.example/', 'wss://seed.example/']);
  });

  /**
   * The cap has to spend the slots on the relays most likely to answer, not on
   * whoever registered a hostname early in the alphabet. Sorted by url this
   * test fails: `a.example` wins the single slot and the live relay never
   * gets dialed.
   */
  it('spends a scarce slot on the freshest relay, not the alphabetically first', async () => {
    const { discovery, pool } = make({
      maxTotal: 1,
      nodes: [
        node({
          node_id: 'f4ai-old',
          pubkey: 'a'.repeat(64),
          relay_urls: ['wss://a.example'],
          seen_at: 1_700_000_000,
        }),
        node({
          node_id: 'f4ai-new',
          pubkey: 'z'.repeat(64),
          relay_urls: ['wss://z.example'],
          seen_at: 1_700_000_500,
        }),
      ],
    });
    await discovery.tick();
    expect(pool.adds).toEqual([{ url: 'wss://z.example/', write: false, discovered: true }]);
  });

  it('ignores writer/client nodes and our own announcement', async () => {
    const { discovery, pool } = make({
      nodes: [
        node({ node_id: 'f4ai-w', pubkey: 'c'.repeat(64), role: 'writer', relay_urls: ['wss://w.example'] }),
        node({ node_id: 'f4ai-c', pubkey: 'd'.repeat(64), role: 'client', relay_urls: ['wss://c.example'] }),
        node({ node_id: 'f4ai-me', pubkey: 'e'.repeat(64), relay_urls: ['wss://me.example'] }),
      ],
      ownRelays: [],
      selfNodeId: 'f4ai-me',
    } as never);
    await discovery.tick();
    expect(pool.adds).toEqual([]);
  });

  it('never discovers a relay we already configured', async () => {
    const pool = new FakePool();
    pool.add('wss://ours.example'); // configured, write-allowed
    pool.adds.length = 0; // only discovery additions matter below
    const { discovery } = make({
      pool,
      nodes: [
        node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['wss://ours.example', 'wss://new.example'] }),
      ],
    });
    await discovery.tick();
    expect(pool.adds.map((a) => a.url)).toEqual(['wss://new.example/']);
    expect(pool.writeUrls()).toEqual(['wss://ours.example/']);
  });

  it('dedupes the same relay announced by several nodes', async () => {
    const { discovery, pool } = make({
      nodes: [
        node({ node_id: 'f4ai-a', pubkey: 'a'.repeat(64), relay_urls: ['wss://shared.example'] }),
        node({ node_id: 'f4ai-b', pubkey: 'b'.repeat(64), relay_urls: ['wss://shared.example/'] }),
      ],
    });
    await discovery.tick();
    await discovery.tick();
    expect(pool.adds).toHaveLength(1);
  });

  it('caps the pool globally and per upstream', async () => {
    const nodes = Array.from({ length: 6 }, (_, i) =>
      node({
        node_id: `f4ai-n${String(i)}`,
        pubkey: String(i + 1).padStart(64, '0'),
        relay_urls: [`wss://relay${String(i)}.example`],
        via: ['up-1'],
      }),
    );
    const { discovery, pool } = make({ nodes, maxPerUpstream: 2 });
    await discovery.tick();
    expect(pool.discoveredUrls()).toHaveLength(2);
    const warnings = discovery.status().warnings;
    expect(warnings.some((w) => w.includes('quota reached'))).toBe(true);
  });

  it('global cap counts relays already discovered, not just this round', async () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      node({
        node_id: `f4ai-n${String(i)}`,
        pubkey: String(i + 1).padStart(64, '0'),
        relay_urls: [`wss://relay${String(i)}.example`],
        via: [`up-${String(i % 2)}`],
      }),
    );
    const { discovery, pool } = make({ nodes, maxTotal: 3 });
    await discovery.tick();
    expect(pool.discoveredUrls()).toHaveLength(3);
  });
});

describe('NodeDiscovery — SSRF gate on announced relay urls', () => {
  it('rejects a private literal host and reports why', async () => {
    const { discovery, pool } = make({
      nodes: [
        node({
          node_id: 'f4ai-seed',
          pubkey: 'a'.repeat(64),
          relay_urls: ['ws://127.0.0.1:18080', 'ws://192.168.1.9:18080'],
        }),
      ],
    });
    await discovery.tick();
    expect(pool.adds).toEqual([]);
    const warnings = discovery.status().warnings;
    // the shared sanitizer already refuses `ws://` on a private host, so the
    // reason surfaces as a rejection, not as a silent skip
    expect(
      warnings.some((w) => w.includes('ws://127.0.0.1:18080') && w.includes('not a public relay url')),
    ).toBe(true);
    expect(
      warnings.some((w) => w.includes('ws://192.168.1.9:18080') && w.includes('not a public relay url')),
    ).toBe(true);
  });

  it('rejects a name that resolves to a private address (DNS rebinding)', async () => {
    const { discovery, pool } = make({
      nodes: [
        node({
          node_id: 'f4ai-seed',
          pubkey: 'a'.repeat(64),
          relay_urls: ['wss://evil.example', 'wss://good.example'],
        }),
      ],
      privateHosts: new Set(['evil.example']),
    });
    await discovery.tick();
    expect(pool.adds.map((a) => a.url)).toEqual(['wss://good.example/']);
    expect(
      discovery.status().warnings.some((w) => w.includes('wss://evil.example/') && w.includes('10.0.0.5')),
    ).toBe(true);
  });

  it('a failing resolver skips the round instead of hanging', async () => {
    const { discovery, pool } = make({
      nodes: [
        node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['wss://slow.example'] }),
      ],
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await discovery.tick();
    expect(pool.adds).toEqual([]);
    expect(discovery.status().warnings.some((w) => w.includes('ENOTFOUND'))).toBe(true);
  });

  it('NODE_ALLOW_PRIVATE accepts ws:// hosts', async () => {
    const { discovery, pool } = make({
      nodes: [
        node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['ws://127.0.0.1:18080'] }),
      ],
      allowPrivateHosts: true,
    });
    await discovery.tick();
    expect(pool.adds.map((a) => a.url)).toEqual(['ws://127.0.0.1:18080/']);
  });
});

describe('NodeDiscovery — retraction', () => {
  it('drops a relay after it stops being announced (maxMisses)', async () => {
    // the fake directory reads a live array, so emptying it = the seed vanished
    const nodes: NodeEntry[] = [
      node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['wss://seed.example'] }),
    ];
    const { discovery, pool } = make({ nodes });
    await discovery.tick();
    expect(pool.discoveredUrls()).toEqual(['wss://seed.example/']);

    nodes.length = 0;
    // miss 1 and miss 2 are tolerated (maxMisses = 2) — a single flaky
    // upstream refresh must not tear the mesh down
    for (let i = 0; i < 2; i += 1) {
      await discovery.tick();
      expect(pool.discoveredUrls()).toEqual(['wss://seed.example/']);
    }
    await discovery.tick(); // miss 3 → retract
    expect(pool.removes).toEqual(['wss://seed.example/']);
    expect(pool.discoveredUrls()).toEqual([]);
  });

  it('a relay seen again resets its miss counter', async () => {
    const nodes: NodeEntry[] = [
      node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['wss://seed.example'] }),
    ];
    const { discovery, pool } = make({ nodes });
    await discovery.tick();
    nodes.length = 0;
    await discovery.tick();
    await discovery.tick();
    nodes.push(node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['wss://seed.example'] }));
    await discovery.tick(); // seen again → misses back to 0
    nodes.length = 0;
    await discovery.tick();
    await discovery.tick();
    expect(pool.discoveredUrls()).toEqual(['wss://seed.example/']);
  });

  it('drops a discovered relay that never connected once the grace window passes', async () => {
    let nowMs = 1_000_000;
    const { discovery, pool } = make({
      nodes: [
        node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['wss://dead.example'] }),
      ],
      connectGraceMs: 1_000,
      now: () => nowMs,
    });
    await discovery.tick();
    expect(pool.discoveredUrls()).toEqual(['wss://dead.example/']);

    nowMs += 5_000;
    await discovery.tick();
    expect(pool.removes).toEqual(['wss://dead.example/']);
  });

  it('keeps a discovered relay that is connected even after the grace window', async () => {
    let nowMs = 1_000_000;
    const { discovery, pool } = make({
      nodes: [
        node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['wss://seed.example'] }),
      ],
      connectGraceMs: 1_000,
      now: () => nowMs,
    });
    await discovery.tick();
    pool.setConnected('wss://seed.example/', true);
    nowMs += 60_000;
    await discovery.tick();
    expect(pool.removes).toEqual([]);
    expect(pool.discoveredUrls()).toEqual(['wss://seed.example/']);
  });

  it('status reports what it added, removed and why', async () => {
    const { discovery, pool } = make({
      nodes: [
        node({ node_id: 'f4ai-seed', pubkey: 'a'.repeat(64), relay_urls: ['wss://seed.example'] }),
      ],
    });
    await discovery.tick();
    const status = discovery.status();
    expect(status.added).toBe(1);
    expect(status.removed).toBe(0);
    expect(status.running).toBe(false);
    expect(status.relays).toHaveLength(1);
    expect(status.relays[0]?.via).toEqual(['direct']);
    expect(status.relays[0]?.connected).toBe(false);
    expect(pool.adds[0]?.discovered).toBe(true);
  });
});
