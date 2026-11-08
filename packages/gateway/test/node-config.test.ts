/**
 * Node role configuration and the gating it drives (F4AI-39, epic F4AI-35).
 *
 * Two things are pinned here, and the second one is the whole point of the
 * epic's compatibility promise:
 *
 *  1. `resolveNodeConfig` is total — every role/announce/upstreams value
 *     either parses or falls back to the legacy default with a warning, and
 *     the capability matrix per role is exactly what the docs promise;
 *  2. **an instance that sets none of the new variables behaves exactly as
 *     before**: role `hub`, announcements off (no new published events),
 *     federation over `GATEWAY_UPSTREAM_GATEWAYS` in both directions, writes
 *     and registrations accepted.
 */
import { describe, expect, it } from 'vitest';

import { buildGateway, resolveGatewayConfig } from '../src/config.js';
import {
  DEFAULT_NODE_SOFTWARE,
  NODE_PASSPHRASE_DOMAIN,
  nodeCapabilities,
  nodeSkFromSecret,
  resolveNodeConfig,
} from '../src/node-config.js';
import type { RelayConnector, RelayLike } from '../src/relay-pool.js';

const OWNER_SK = '1'.repeat(64);
const NODE_SK = '2'.repeat(64);

/** A relay that is always connected, so `buildGateway` needs no network. */
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

const fakeConnector: RelayConnector = async (url) => new FakeRelay(url);

function build(env: Record<string, string | undefined>) {
  return buildGateway(
    { GATEWAY_QUIET: '1', GATEWAY_RELAY_URLS: 'ws://relay.test:1', ...env },
    {
      connector: fakeConnector,
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
}

describe('resolveNodeConfig — legacy default', () => {
  it('is a silent hub when no new variable is set', () => {
    const node = resolveNodeConfig({});
    expect(node.role).toBe('hub');
    expect(node.roleExplicit).toBe(false);
    expect(node.announce).toBe(false);
    expect(node.upstreamsMode).toBe('manual');
    expect(node.allowPrivateHosts).toBe(false);
    expect(node.software).toBe(DEFAULT_NODE_SOFTWARE);
    expect(node.warnings).toEqual([]);
    // hub keeps every capability the previous release had
    expect(node.capabilities).toEqual({
      write: true,
      register: true,
      fedPull: true,
      fedPush: true,
      announce: false,
      directory: true,
    });
  });

  it('keeps the gateway config compatible: federation still follows GATEWAY_UPSTREAM_GATEWAYS', () => {
    const config = resolveGatewayConfig({
      GATEWAY_UPSTREAM_GATEWAYS: 'http://upstream.test:3001',
    });
    expect(config.node.role).toBe('hub');
    expect(config.upstreamGateways.map((u) => u.baseUrl)).toEqual(['http://upstream.test:3001']);
  });

  it('NODE_UPSTREAMS=off disables federation even with a configured upstream', () => {
    const config = resolveGatewayConfig({
      GATEWAY_UPSTREAM_GATEWAYS: 'http://upstream.test:3001',
      NODE_UPSTREAMS: 'off',
    });
    expect(config.upstreamGateways).toEqual([]);
    expect(config.node.upstreamsMode).toBe('off');
  });
});

describe('resolveNodeConfig — roles', () => {
  it('names a mesh role explicitly and that turns announcing on', () => {
    for (const role of ['seed', 'hub'] as const) {
      const node = resolveNodeConfig({ NODE_ROLE: role, NODE_SK: NODE_SK });
      expect(node.role).toBe(role);
      expect(node.roleExplicit).toBe(true);
      expect(node.announce).toBe(true);
    }
  });

  it('client and writer never announce and never federate', () => {
    for (const role of ['client', 'writer'] as const) {
      const node = resolveNodeConfig({ NODE_ROLE: role, NODE_SK: NODE_SK });
      expect(node.announce).toBe(false);
      expect(node.capabilities.fedPull).toBe(false);
      expect(node.capabilities.fedPush).toBe(false);
      expect(node.capabilities.write).toBe(true);
    }
  });

  it('a seed is read-only: no writes, no registrations, pull but no push', () => {
    const node = resolveNodeConfig({ NODE_ROLE: 'seed', NODE_SK: NODE_SK });
    expect(node.capabilities.write).toBe(false);
    expect(node.capabilities.register).toBe(false);
    expect(node.capabilities.fedPull).toBe(true);
    expect(node.capabilities.fedPush).toBe(false);
    expect(nodeCapabilities('seed', true).announce).toBe(true);
  });

  it('NODE_ANNOUNCE wins over the role default in both directions', () => {
    expect(resolveNodeConfig({ NODE_ROLE: 'hub', NODE_ANNOUNCE: 'off', NODE_SK: NODE_SK }).announce).toBe(false);
    // no NODE_ROLE at all, but the operator asked for announcements
    expect(resolveNodeConfig({ NODE_ANNOUNCE: 'on', NODE_SK: NODE_SK }).announce).toBe(true);
    // a client cannot announce whatever it sets
    const client = resolveNodeConfig({ NODE_ROLE: 'client', NODE_ANNOUNCE: 'on', NODE_SK: NODE_SK });
    expect(client.announce).toBe(false);
    expect(client.warnings.join('\n')).toContain('does not announce');
  });

  it('falls back to the legacy default on a typo instead of throwing', () => {
    const node = resolveNodeConfig({ NODE_ROLE: 'supernode', NODE_ANNOUNCE: 'maybe', NODE_UPSTREAMS: 'yes' });
    expect(node.role).toBe('hub');
    expect(node.announce).toBe(false);
    expect(node.upstreamsMode).toBe('manual');
    expect(node.warnings.length).toBe(3);
  });
});

describe('resolveNodeConfig — node key', () => {
  it('accepts a hex key and derives a stable one from a passphrase', () => {
    expect(nodeSkFromSecret(NODE_SK)).toBe(NODE_SK);
    const derived = nodeSkFromSecret('correct horse battery staple');
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).toBe(nodeSkFromSecret('correct horse battery staple'));
    expect(derived).not.toBe(nodeSkFromSecret('correct horse battery stapl3'));
    // domain separation: the raw passphrase is not the hash input
    expect(derived).not.toBe(nodeSkFromSecret(`${NODE_PASSPHRASE_DOMAIN}correct horse battery staple`));
  });

  it('prefers NODE_SK, then NODE_PASSPHRASE, then the owner key with a warning', () => {
    expect(resolveNodeConfig({ NODE_SK: NODE_SK, NODE_PASSPHRASE: 'x', GATEWAY_OWNER_SK_HEX: OWNER_SK }).nodeSkSource).toBe('NODE_SK');
    expect(resolveNodeConfig({ NODE_PASSPHRASE: 'x', GATEWAY_OWNER_SK_HEX: OWNER_SK }).nodeSkSource).toBe('NODE_PASSPHRASE');
    const fallback = resolveNodeConfig({ NODE_ROLE: 'hub', GATEWAY_OWNER_SK_HEX: OWNER_SK });
    expect(fallback.nodeSkHex).toBe(OWNER_SK);
    expect(fallback.nodeSkSource).toBe('GATEWAY_OWNER_SK_HEX');
    expect(fallback.warnings.join('\n')).toContain('separate');
    // a non-hex NODE_SK is a passphrase
    const phrase = resolveNodeConfig({ NODE_SK: 'let me in' });
    expect(phrase.nodeSkSource).toBe('NODE_PASSPHRASE');
    expect(phrase.nodeSkHex).toBe(nodeSkFromSecret('let me in'));
  });

  it('announcing without any key is disabled, not crashed', () => {
    const node = resolveNodeConfig({ NODE_ROLE: 'seed' });
    expect(node.announce).toBe(false);
    expect(node.nodeSkSource).toBe('none');
    expect(node.warnings.join('\n')).toContain('no node key');
  });
});

describe('resolveNodeConfig — announcement knobs', () => {
  it('clamps the TTL and warns when the heartbeat cannot keep up', () => {
    const short = resolveNodeConfig({ NODE_SK: NODE_SK, NODE_ANNOUNCE_TTL_S: '10' });
    expect(short.announceTtlS).toBe(120);
    expect(short.warnings.join('\n')).toContain('clamped');
    const slow = resolveNodeConfig({ NODE_SK: NODE_SK, NODE_ANNOUNCE_TTL_S: '120', NODE_ANNOUNCE_INTERVAL_S: '600' });
    expect(slow.heartbeatMs).toBe(600_000);
    expect(slow.warnings.join('\n')).toContain('drop out between heartbeats');
  });

  it('only advertises a public https web root', () => {
    expect(resolveNodeConfig({ NODE_WEB_URL: 'https://forum.example.com/' }).webUrl).toBe('https://forum.example.com');
    const bad = resolveNodeConfig({ NODE_WEB_URL: 'http://forum.example.com' });
    expect(bad.webUrl).toBeNull();
    expect(bad.warnings.join('\n')).toContain('NODE_WEB_URL');
    const dev = resolveNodeConfig({ NODE_WEB_URL: 'http://localhost:3000', NODE_ALLOW_PRIVATE: '1' });
    expect(dev.webUrl).toBe('http://localhost:3000');
  });
});

describe('role gating in the built gateway', () => {
  const body = JSON.stringify({ id: 'x'.repeat(64) });

  it('a seed answers 405 on POST /events and has no /register routes', async () => {
    const runtime = build({ NODE_ROLE: 'seed', NODE_SK: NODE_SK });
    try {
      const res = await runtime.app.request('/events', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
      expect(res.status).toBe(405);
      const pending = await runtime.app.request('/register/pending');
      expect(pending.status).toBe(404);
      // federation: pull allowed, push queue never fed
      expect(runtime.fed.engine.enabled).toBe(false); // no upstreams configured here
    } finally {
      runtime.fed.close();
      runtime.pool.close();
    }
  });

  it('a legacy instance still accepts writes and registers operators', async () => {
    const runtime = build({ GATEWAY_OWNER_SK_HEX: OWNER_SK });
    try {
      const res = await runtime.app.request('/events', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
      // 400 (malformed event) proves the handler ran — it is not the 405 gate
      expect(res.status).toBe(400);
      const pending = await runtime.app.request('/register/pending');
      expect(pending.status).not.toBe(404);
    } finally {
      runtime.fed.close();
      runtime.pool.close();
    }
  });

  it('a seed with an upstream pulls but never pushes', async () => {
    const runtime = build({
      NODE_ROLE: 'seed',
      NODE_SK: NODE_SK,
      GATEWAY_UPSTREAM_GATEWAYS: 'http://upstream.test:3001',
    });
    try {
      expect(runtime.fed.engine.enabled).toBe(true);
      const summary = await runtime.fed.engine.tick();
      // the seed pulls (1 attempt) but the push half of the tick never runs
      expect(summary.pulled).toHaveLength(1);
      expect(summary.pushed).toHaveLength(0);
    } finally {
      runtime.fed.close();
      runtime.pool.close();
    }
  });

  it('client and writer do not federate at all', () => {
    for (const role of ['client', 'writer'] as const) {
      const config = resolveGatewayConfig({
        NODE_ROLE: role,
        GATEWAY_UPSTREAM_GATEWAYS: 'http://upstream.test:3001',
      });
      expect(config.upstreamGateways).toHaveLength(1); // manual list is still parsed
      expect(config.node.capabilities.fedPull).toBe(false);
      expect(config.node.capabilities.fedPush).toBe(false);
    }
  });
});
