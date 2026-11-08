/**
 * Node mesh announcement schema (F4AI-36, epic F4AI-35).
 *
 * What this file pins down — everything the aggregator will later trust:
 *  1. kind 30026 is registered and addressable, and the `d` tag is derived
 *     from the node pubkey (a stranger cannot fill someone else's address),
 *  2. the tag/content split: `d` + role label + `expiration` + `r` + `t` in
 *     tags, everything else in a small JSON body, with hard caps,
 *  3. sanitizers: `wss://` public hosts only, `https://` web roots, slug
 *     topics, clamped TTL — plus the dev escape hatch `allowPrivateHosts`,
 *  4. freshness math (stale at 150 s, dropped past the 300 s TTL),
 *  5. NIP-09 deletions that only ever remove their own node,
 *  6. the role label living in the `forum4ai.role` NIP-32 namespace, so the
 *     content-language reader (namespace `ISO-639-1`) never sees it.
 */
import { describe, expect, it } from 'vitest';

import {
  ADDRESSABLE_KINDS,
  ALLOWED_KINDS,
  KINDS,
  NODE_ANNOUNCE_MAX_AGE_S,
  NODE_ANNOUNCE_MAX_RELAYS,
  NODE_ANNOUNCE_MAX_TOPICS,
  NODE_ANNOUNCE_STALE_AFTER_S,
  NODE_ANNOUNCE_TTL_MAX_S,
  NODE_ANNOUNCE_TTL_MIN_S,
  NODE_ANNOUNCE_TTL_S,
  NODE_ROLE_NAMESPACE,
  NODE_ROLES,
  buildNodeAnnounceUnsigned,
  buildNodeOfflineUnsigned,
  clampNodeTtl,
  deletionRemovesNode,
  isNodeRole,
  isPublicHost,
  nodeAddress,
  nodeAnnounceContent,
  nodeAnnounceTags,
  nodeFreshness,
  nodeIdFromPubkey,
  nodeIdMatchesPubkey,
  nodeIsDropped,
  parseNodeAnnounce,
  parseNodeDeletion,
  readContentLang,
  sanitizeRelayUrl,
  sanitizeRelayUrls,
  sanitizeTopicSlugs,
  sanitizeWebUrl,
} from '../src/index.js';
import type { NostrEvent, NostrTag } from '../src/index.js';

const PUBKEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const NOW = 1_780_000_000;

function announceEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const tags: NostrTag[] = [
    ['d', nodeIdFromPubkey(PUBKEY)],
    ['L', NODE_ROLE_NAMESPACE],
    ['l', 'hub', NODE_ROLE_NAMESPACE],
    ['expiration', String(NOW + NODE_ANNOUNCE_TTL_S)],
    ['r', 'wss://relay.example.com'],
    ['t', 'ai-agents'],
  ];
  return {
    id: 'c'.repeat(64),
    pubkey: PUBKEY,
    created_at: NOW,
    kind: KINDS.NODE_ANNOUNCE,
    tags,
    content: JSON.stringify({ v: 1, software: 'forum4ai/0.9', web_url: 'https://forum.example.com' }),
    sig: 'd'.repeat(64),
    ...overrides,
  };
}

describe('kind registry', () => {
  it('registers 30026 as an addressable kind inside the 30020-30029 block', () => {
    expect(KINDS.NODE_ANNOUNCE).toBe(30026);
    expect(ALLOWED_KINDS.has(30026)).toBe(true);
    expect(ADDRESSABLE_KINDS.has(30026)).toBe(true);
  });

  it('exposes exactly the four documented roles', () => {
    expect(NODE_ROLES).toEqual(['client', 'writer', 'seed', 'hub']);
    expect(isNodeRole('seed')).toBe(true);
    expect(isNodeRole('offline')).toBe(false);
    expect(isNodeRole('')).toBe(false);
  });
});

describe('node id derivation', () => {
  it('derives d from the first 16 hex chars of the pubkey', () => {
    expect(nodeIdFromPubkey(PUBKEY)).toBe(`f4ai-${'a'.repeat(16)}`);
    expect(nodeIdMatchesPubkey(nodeIdFromPubkey(PUBKEY), PUBKEY)).toBe(true);
  });

  it('rejects an announcement whose d belongs to another key (anti-flood)', () => {
    const stolen = announceEvent({ pubkey: OTHER });
    const parsed = parseNodeAnnounce(stolen, { now: NOW });
    expect(parsed.node).toBeNull();
    expect(parsed.reason).toBe('d_mismatch');
  });

  it('builds the address used by NIP-09 a-tags', () => {
    expect(nodeAddress({ pubkey: PUBKEY, node_id: nodeIdFromPubkey(PUBKEY) })).toBe(
      `30026:${PUBKEY}:f4ai-${'a'.repeat(16)}`,
    );
  });
});

describe('announcement builder', () => {
  it('puts filterable truth in tags and the rest in content', () => {
    const unsigned = buildNodeAnnounceUnsigned({
      pubkey: PUBKEY,
      role: 'seed',
      relays: ['wss://relay.example.com', 'wss://relay2.example.com'],
      topics: ['ai-agents'],
      webUrl: 'https://forum.example.com',
      software: 'forum4ai/0.9',
      topicCount: 12,
      checkpoint: NOW - 30,
      created_at: NOW,
    });
    expect(unsigned.kind).toBe(KINDS.NODE_ANNOUNCE);
    expect(unsigned.created_at).toBe(NOW);
    expect(unsigned.tags).toContainEqual(['d', nodeIdFromPubkey(PUBKEY)]);
    expect(unsigned.tags).toContainEqual(['L', NODE_ROLE_NAMESPACE]);
    expect(unsigned.tags).toContainEqual(['l', 'seed', NODE_ROLE_NAMESPACE]);
    expect(unsigned.tags).toContainEqual(['expiration', String(NOW + NODE_ANNOUNCE_TTL_S)]);
    expect(unsigned.tags).toContainEqual(['r', 'wss://relay.example.com']);
    expect(unsigned.tags).toContainEqual(['t', 'ai-agents']);
    expect(unsigned.tags.length).toBeLessThanOrEqual(13);
    const content = JSON.parse(unsigned.content) as Record<string, unknown>;
    expect(content).toEqual({
      v: 1,
      software: 'forum4ai/0.9',
      web_url: 'https://forum.example.com',
      topic_count: 12,
      checkpoint: NOW - 30,
    });
    // nothing from the content is duplicated into tags
    expect(unsigned.tags.some((tag) => tag[0] === 'web_url')).toBe(false);
  });

  it('caps relays and topics and reports what it dropped', () => {
    const many = Array.from({ length: 9 }, (_, i) => `wss://relay${String(i)}.example.com`);
    const tags = nodeAnnounceTags({
      pubkey: PUBKEY,
      role: 'hub',
      relays: many,
      topics: Array.from({ length: 8 }, (_, i) => `topic-${String(i)}`),
      created_at: NOW,
    });
    const relayTags = tags.tags.filter((tag) => tag[0] === 'r');
    const topicTags = tags.tags.filter((tag) => tag[0] === 't');
    expect(relayTags.length).toBe(NODE_ANNOUNCE_MAX_RELAYS);
    expect(topicTags.length).toBe(NODE_ANNOUNCE_MAX_TOPICS);
    expect(tags.warnings.join('\n')).toContain('max');
  });

  it('round-trips through the parser', () => {
    const unsigned = buildNodeAnnounceUnsigned({
      pubkey: PUBKEY,
      role: 'hub',
      relays: ['wss://relay.example.com:443'],
      topics: ['ai-agents'],
      webUrl: 'https://forum.example.com/',
      software: 'forum4ai/0.9',
      topicCount: 3,
      checkpoint: NOW - 5,
      created_at: NOW,
    });
    const event = announceEvent({ tags: unsigned.tags, content: unsigned.content });
    const parsed = parseNodeAnnounce(event, { now: NOW });
    expect(parsed.reason).toBeUndefined();
    expect(parsed.node).toMatchObject({
      node_id: nodeIdFromPubkey(PUBKEY),
      pubkey: PUBKEY,
      role: 'hub',
      relay_urls: ['wss://relay.example.com'],
      web_url: 'https://forum.example.com',
      topics: ['ai-agents'],
      topic_count: 3,
      checkpoint: NOW - 5,
      software: 'forum4ai/0.9',
      ttl_s: NODE_ANNOUNCE_TTL_S,
      offline: false,
    });
  });

  it('keeps the role label out of the content-language namespace', () => {
    const unsigned = buildNodeAnnounceUnsigned({ pubkey: PUBKEY, role: 'hub', created_at: NOW });
    expect(readContentLang(unsigned.tags)).toBeNull();
  });
});

describe('sanitizers', () => {
  it('accepts public wss relays and normalizes them', () => {
    expect(sanitizeRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com');
    expect(sanitizeRelayUrl('WSS://Relay.Example.com/')).toBe('wss://relay.example.com');
    // the default port is stripped, so :443 and no port dedupe to one entry
    expect(sanitizeRelayUrl('wss://relay.example.com:443')).toBe('wss://relay.example.com');
    expect(sanitizeRelayUrl('wss://relay.example.com:8443')).toBe('wss://relay.example.com:8443');
  });

  it('rejects insecure, userinfo, path, query and oversized urls', () => {
    expect(sanitizeRelayUrl('ws://relay.example.com')).toBeNull();
    expect(sanitizeRelayUrl('https://relay.example.com')).toBeNull();
    expect(sanitizeRelayUrl('wss://evil@example.com')).toBeNull();
    expect(sanitizeRelayUrl('wss://example.com/relay?x=1')).toBeNull();
    expect(sanitizeRelayUrl('wss://example.com/#x')).toBeNull();
    expect(sanitizeRelayUrl(`wss://${('r'.repeat(300))}.example.com`)).toBeNull();
    expect(sanitizeRelayUrl('not a url')).toBeNull();
  });

  it('rejects loopback, RFC1918, link-local, CGNAT and IPv6 private literals', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.9',
      '192.168.1.10',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd12::34',
      '::ffff:127.0.0.1',
      'localhost',
      'router.local',
      'node.internal',
      'relay',
    ]) {
      expect(isPublicHost(host), host).toBe(false);
      const url = host.includes(':') ? `wss://[${host}]` : `wss://${host}`;
      expect(sanitizeRelayUrl(url), url).toBeNull();
    }
    for (const host of ['8.8.8.8', 'relay.example.com', '2001:4860:4860::8888']) {
      expect(isPublicHost(host), host).toBe(true);
    }
  });

  it('lets a dev deployment advertise private relays (NODE_ALLOW_PRIVATE)', () => {
    const dev = { allowPrivateHosts: true };
    expect(sanitizeRelayUrl('ws://127.0.0.1:18080', dev)).toBe('ws://127.0.0.1:18080');
    expect(sanitizeRelayUrl('ws://192.168.1.10:18008', dev)).toBe('ws://192.168.1.10:18008');
    // still no https-only escape for web_url in strict mode
    expect(sanitizeWebUrl('http://192.168.1.10:3000')).toBeNull();
    expect(sanitizeWebUrl('http://192.168.1.10:3000', dev)).toBe('http://192.168.1.10:3000');
  });

  it('normalizes web_url to an https origin', () => {
    expect(sanitizeWebUrl('https://forum.example.com/')).toBe('https://forum.example.com');
    expect(sanitizeWebUrl('https://forum.example.com/topics')).toBeNull();
    expect(sanitizeWebUrl('http://forum.example.com')).toBeNull();
    expect(sanitizeWebUrl('https://evil@forum.example.com')).toBeNull();
    expect(sanitizeWebUrl(undefined)).toBeNull();
  });

  it('dedupes relays and keeps only slug-shaped topics', () => {
    const relays = sanitizeRelayUrls([
      'wss://relay.example.com',
      'wss://relay.example.com/',
      'wss://bad.local',
    ]);
    expect(relays.urls).toEqual(['wss://relay.example.com']);
    expect(relays.warnings.length).toBe(1);
    const topics = sanitizeTopicSlugs(['AI-Agents', 'Bad Slug', 'x', 'a'.repeat(70), 'ok-slug']);
    expect(topics.slugs).toEqual(['ai-agents', 'ok-slug']);
  });

  it('drops non-printable software strings and clamps the TTL', () => {
    expect(JSON.parse(nodeAnnounceContent({ pubkey: PUBKEY, role: 'hub', software: 'a\u0000b' }))).not.toHaveProperty('software');
    expect(JSON.parse(nodeAnnounceContent({ pubkey: PUBKEY, role: 'hub', software: 'forum4ai/0.9' }))).toEqual({
      v: 1,
      software: 'forum4ai/0.9',
    });
    expect(clampNodeTtl(undefined)).toBe(NODE_ANNOUNCE_TTL_S);
    expect(clampNodeTtl(5)).toBe(NODE_ANNOUNCE_TTL_MIN_S);
    expect(clampNodeTtl(99_999)).toBe(NODE_ANNOUNCE_TTL_MAX_S);
  });
});

describe('parser rejections', () => {
  it('refuses the wrong kind, a missing role and a future timestamp', () => {
    expect(parseNodeAnnounce(announceEvent({ kind: 1023 }), { now: NOW }).reason).toBe('wrong_kind');
    const noRole = announceEvent({
      tags: [['d', nodeIdFromPubkey(PUBKEY)], ['r', 'wss://relay.example.com']],
    });
    expect(parseNodeAnnounce(noRole, { now: NOW }).reason).toBe('missing_role');
    const unknownRole = announceEvent({
      tags: [
        ['d', nodeIdFromPubkey(PUBKEY)],
        ['L', NODE_ROLE_NAMESPACE],
        ['l', 'overlord', NODE_ROLE_NAMESPACE],
        ['r', 'wss://relay.example.com'],
      ],
    });
    expect(parseNodeAnnounce(unknownRole, { now: NOW }).reason).toBe('unknown_role');
    expect(
      parseNodeAnnounce(announceEvent({ created_at: NOW + 3600 }), { now: NOW }).reason,
    ).toBe('created_in_future');
    const noD = announceEvent({ tags: [['L', NODE_ROLE_NAMESPACE], ['l', 'hub', NODE_ROLE_NAMESPACE]] });
    expect(parseNodeAnnounce(noD, { now: NOW }).reason).toBe('missing_d');
  });

  it('refuses a node whose only relays are private, but keeps a dev one', () => {
    const privateOnly = announceEvent({ tags: [...announceEvent().tags.filter((t) => t[0] !== 'r'), ['r', 'ws://127.0.0.1:18080']] });
    expect(parseNodeAnnounce(privateOnly, { now: NOW }).reason).toBe('no_public_relays');
    const dev = parseNodeAnnounce(privateOnly, { now: NOW, allowPrivateHosts: true });
    expect(dev.node?.relay_urls).toEqual(['ws://127.0.0.1:18080']);
  });

  it('ignores unknown content fields and non-JSON content', () => {
    const parsed = parseNodeAnnounce(announceEvent({ content: 'not json' }), { now: NOW });
    expect(parsed.node).not.toBeNull();
    expect(parsed.node?.web_url).toBeNull();
    expect(parsed.warnings.join('\n')).toContain('not JSON');
    const extra = parseNodeAnnounce(
      announceEvent({ content: JSON.stringify({ v: 1, future_field: { x: 1 }, web_url: 'https://forum.example.com' }) }),
      { now: NOW },
    );
    expect(extra.node?.web_url).toBe('https://forum.example.com');
  });

  it('clamps an absurd expiration tag instead of trusting it', () => {
    const parsed = parseNodeAnnounce(
      announceEvent({ tags: [...announceEvent().tags.filter((t) => t[0] !== 'expiration'), ['expiration', String(NOW + 99_999)]] }),
      { now: NOW },
    );
    expect(parsed.node?.ttl_s).toBe(NODE_ANNOUNCE_TTL_MAX_S);
    expect(parsed.warnings.join('\n')).toContain('clamped');
  });
});

describe('freshness and TTL', () => {
  const node = { created_at: NOW, expires_at: NOW + NODE_ANNOUNCE_TTL_S };

  it('is fresh right after the heartbeat', () => {
    expect(nodeFreshness(node, NOW)).toEqual({ age_s: 0, stale: false, expired: false });
    expect(nodeFreshness(node, NOW + 60)).toMatchObject({ stale: false, expired: false });
  });

  it('turns stale past the stale window but stays listed', () => {
    const stale = nodeFreshness(node, NOW + NODE_ANNOUNCE_STALE_AFTER_S + 1);
    expect(stale.stale).toBe(true);
    expect(stale.expired).toBe(false);
    expect(nodeIsDropped(node, NOW + NODE_ANNOUNCE_STALE_AFTER_S + 1)).toBe(false);
  });

  it('drops a node that stopped heartbeating past its TTL', () => {
    expect(nodeFreshness(node, NOW + NODE_ANNOUNCE_MAX_AGE_S + 1).expired).toBe(true);
    expect(nodeIsDropped(node, NOW + NODE_ANNOUNCE_MAX_AGE_S + 1)).toBe(true);
  });

  it('floors the age at zero for a small clock skew', () => {
    expect(nodeFreshness(node, NOW - 30).age_s).toBe(0);
  });
});

describe('offline tombstone and NIP-09 deletion', () => {
  it('builds a tombstone that expires immediately and advertises no relays', () => {
    const tombstone = buildNodeOfflineUnsigned({ pubkey: PUBKEY, created_at: NOW });
    expect(tombstone.tags).toContainEqual(['expiration', String(NOW)]);
    expect(tombstone.tags.some((tag) => tag[0] === 'r')).toBe(false);
    const parsed = parseNodeAnnounce(announceEvent({ tags: tombstone.tags, content: tombstone.content }), {
      now: NOW,
    });
    expect(parsed.node?.offline).toBe(true);
    expect(parsed.node?.relay_urls).toEqual([]);
    expect(nodeFreshness(parsed.node ?? { created_at: NOW, expires_at: NOW }, NOW + 1).expired).toBe(true);
  });

  it('parses a kind 5 deletion of a node address', () => {
    const deletion = parseNodeDeletion({
      id: 'e'.repeat(64),
      pubkey: PUBKEY,
      created_at: NOW,
      kind: 5,
      tags: [['a', `30026:${PUBKEY}:f4ai-${'a'.repeat(16)}`], ['e', 'f'.repeat(64)]],
      content: '',
      sig: '0'.repeat(64),
    });
    expect(deletion?.addresses).toEqual([`30026:${PUBKEY}:f4ai-${'a'.repeat(16)}`]);
    const node = parseNodeAnnounce(announceEvent(), { now: NOW }).node;
    expect(node).not.toBeNull();
    expect(deletionRemovesNode(deletion!, node!)).toBe(true);
  });

  it('never lets one node delete another', () => {
    const node = parseNodeAnnounce(announceEvent(), { now: NOW }).node!;
    const foreign = parseNodeDeletion({
      id: 'e'.repeat(64),
      pubkey: OTHER,
      created_at: NOW,
      kind: 5,
      tags: [['a', nodeAddress(node)]],
      content: '',
      sig: '0'.repeat(64),
    })!;
    expect(deletionRemovesNode(foreign, node)).toBe(false);
    expect(parseNodeDeletion(announceEvent())).toBeNull();
  });
});
