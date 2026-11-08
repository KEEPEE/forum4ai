/**
 * Node mesh — voluntary node roles and Nostr-native node announcements
 * (F4AI-36…F4AI-38, epic F4AI-35).
 *
 * A forum4Ai instance can run in one of four roles. Each node that is
 * willing to be part of the public mesh signs a **kind 30026** announcement
 * (`NODE_ANNOUNCE`): an addressable event whose `d` tag is derived from its
 * own node pubkey, so every node owns exactly one live announcement
 * (last-writer-wins per `30026:<pubkey>:<d>`).
 *
 * Design rules (agreed with the owner, refined by the Opus design review):
 *
 *  1. **`d` is derived, never invented.** `d = "f4ai-" + pubkey.slice(0, 16)`.
 *     A hostname would leak Docker container IDs and let one key spam the
 *     directory with unlimited addresses. The aggregator rejects any
 *     announcement whose `d` does not match its own pubkey (anti-flood, P0).
 *  2. **Tags are the filterable truth, content carries the rest.** Tags:
 *     `d`, `r` (relay URLs, max 4), `t` (topic slugs, max 5), the NIP-32
 *     role label (`L`/`l` in namespace `forum4ai.role`) and NIP-40
 *     `expiration`. Content is a small JSON object (`v`, `software`,
 *     `web_url`, `topic_count`, `checkpoint`). Nothing is duplicated.
 *  3. **TTL is math, not a relay feature.** No relay in our stack enforces
 *     NIP-40, so freshness is computed by the aggregator: `stale` after
 *     {@link NODE_ANNOUNCE_STALE_AFTER_S}, dropped after
 *     {@link NODE_ANNOUNCE_MAX_AGE_S}. A heartbeat every ~60 s keeps a live
 *     node inside the window; a node that disappears simply stops being
 *     refreshed and falls out.
 *  4. **Deletion is explicit and self-issued.** A graceful shutdown
 *     republishes the same address with the role label `offline`, no `r`
 *     tags and `expiration = created_at`; a hard delete is a NIP-09 (kind 5)
 *     event whose `a` tag points at `30026:<pubkey>:<d>` and which is signed
 *     by that same pubkey.
 *  5. **Stranger data is untrusted.** Every field read from another node is
 *     re-sanitized here: relay URLs must be `wss://` public hosts (loopback,
 *     RFC1918, link-local, CGNAT and ULA literals are rejected unless the
 *     operator opted into `allowPrivateHosts`), `web_url` must be `https://`,
 *     the role must be one of four values, topic tags must be slugs.
 *
 * This module is pure: no network, no clock of its own (`now` is injected),
 * no Node-only APIs. The gateway owns signing, PoW and publishing.
 */
import type { NostrEvent, NostrTag } from './types.js';

/** Voluntary node roles (F4AI-39). Order is the "how much do I serve" ladder. */
export const NODE_ROLES = ['client', 'writer', 'seed', 'hub'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

export function isNodeRole(value: unknown): value is NodeRole {
  return typeof value === 'string' && (NODE_ROLES as readonly string[]).includes(value);
}

/** NIP-32 label namespace carrying the role (third `l` element = label namespace). */
export const NODE_ROLE_NAMESPACE = 'forum4ai.role';
/** Role label used by the graceful-shutdown tombstone (F4AI-36, Q3 option d). */
export const NODE_ROLE_OFFLINE = 'offline';

/** `d` tag prefix; the rest is the first 16 hex chars of the node pubkey. */
export const NODE_ID_PREFIX = 'f4ai-';
/** `a` tag prefix of a node announcement, used by NIP-09 deletions. */
export const NODE_ADDRESS_PREFIX = `${30026}:`;

/** Heartbeat cadence of a live announcement (jitter is added by the gateway). */
export const NODE_ANNOUNCE_HEARTBEAT_MS = 60_000;
/** Jitter window on top of the heartbeat so a fleet does not sync up. */
export const NODE_ANNOUNCE_HEARTBEAT_JITTER_MS = 10_000;
/** Advertised TTL of one announcement. */
export const NODE_ANNOUNCE_TTL_S = 300;
export const NODE_ANNOUNCE_TTL_MIN_S = 120;
export const NODE_ANNOUNCE_TTL_MAX_S = 900;
/** Age at which a node is still listed but flagged `stale`. */
export const NODE_ANNOUNCE_STALE_AFTER_S = 150;
/** Age at which a node is dropped from the directory entirely. */
export const NODE_ANNOUNCE_MAX_AGE_S = NODE_ANNOUNCE_TTL_S;
/** Future `created_at` tolerance; anything further ahead is rejected. */
export const NODE_ANNOUNCE_MAX_CLOCK_SKEW_S = 60;

/** Hard caps on the announcement payload (also keeps the tag count ≤ 13). */
export const NODE_ANNOUNCE_MAX_RELAYS = 4;
export const NODE_ANNOUNCE_MAX_TOPICS = 5;
export const NODE_ANNOUNCE_MAX_URL_CHARS = 256;
export const NODE_ANNOUNCE_MAX_SOFTWARE_CHARS = 64;

/** Topic slug shape — same alphabet as topic `d` slugs. */
const TOPIC_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Hostname suffixes that are never publicly resolvable. */
const PRIVATE_HOST_SUFFIXES = [
  '.local',
  '.internal',
  '.localdomain',
  '.home',
  '.lan',
  '.home.arpa',
  '.test',
  '.invalid',
] as const;

/**
 * A parsed, sanitized node announcement. Field names are snake_case because
 * this object is serialized verbatim by `GET /nodes` (F4AI-37).
 */
export interface NodeRecord {
  node_id: string;
  pubkey: string;
  /** `offline` only on the shutdown tombstone; the directory hides those. */
  role: NodeRole | 'offline';
  relay_urls: string[];
  web_url: string | null;
  topics: string[];
  topic_count: number | null;
  checkpoint: number | null;
  software: string | null;
  created_at: number;
  expires_at: number;
  ttl_s: number;
  /** True for the graceful-shutdown tombstone (role label `offline`). */
  offline: boolean;
  event_id: string;
}

/** Result of {@link parseNodeAnnounce}: either a record, or a rejection reason. */
export interface NodeParseResult {
  node: NodeRecord | null;
  reason?: string;
  warnings: string[];
}

export interface NodeSanitizeOptions {
  /** Accept `ws://` and private hosts (dev/E2E deployments). */
  allowPrivateHosts?: boolean;
  /** Override the clock used for TTL and clock-skew checks. */
  now?: number;
}

/** `d` tag of the announcement owned by `pubkey`. */
export function nodeIdFromPubkey(pubkey: string): string {
  return `${NODE_ID_PREFIX}${pubkey.slice(0, 16).toLowerCase()}`;
}

/** True when `d` is exactly the address that `pubkey` is allowed to sign. */
export function nodeIdMatchesPubkey(d: string, pubkey: string): boolean {
  return d === nodeIdFromPubkey(pubkey);
}

/** Full Nostr address of a node announcement, for `a` tags and NIP-09. */
export function nodeAddress(node: Pick<NodeRecord, 'pubkey' | 'node_id'>): string {
  return `30026:${node.pubkey}:${node.node_id}`;
}

/** Clamp an operator-provided TTL into the supported window. */
export function clampNodeTtl(ttlS: number | undefined): number {
  if (typeof ttlS !== 'number' || !Number.isFinite(ttlS)) return NODE_ANNOUNCE_TTL_S;
  const rounded = Math.round(ttlS);
  if (rounded < NODE_ANNOUNCE_TTL_MIN_S) return NODE_ANNOUNCE_TTL_MIN_S;
  if (rounded > NODE_ANNOUNCE_TTL_MAX_S) return NODE_ANNOUNCE_TTL_MAX_S;
  return rounded;
}

/** Input for building (and letting the caller sign) an announcement. */
export interface NodeAnnounceInput {
  pubkey: string;
  role: NodeRole;
  relays?: readonly string[];
  topics?: readonly string[];
  webUrl?: string;
  software?: string;
  topicCount?: number;
  checkpoint?: number;
  ttlS?: number;
  created_at?: number;
  /** Explicit `d` override (tests); normally derived from `pubkey`. */
  d?: string;
  allowPrivateHosts?: boolean;
}

/**
 * Tags of an announcement, sanitized. Invalid relays/topics are dropped and
 * reported, never silently trusted.
 */
export function nodeAnnounceTags(
  input: NodeAnnounceInput,
): { tags: NostrTag[]; warnings: string[] } {
  const warnings: string[] = [];
  const createdAt = input.created_at ?? Math.floor(Date.now() / 1000);
  const ttl = clampNodeTtl(input.ttlS);
  const tags: NostrTag[] = [];

  tags.push(['d', input.d ?? nodeIdFromPubkey(input.pubkey)]);
  tags.push(['L', NODE_ROLE_NAMESPACE]);
  tags.push(['l', input.role, NODE_ROLE_NAMESPACE]);
  tags.push(['expiration', String(createdAt + ttl)]);

  const relays = sanitizeRelayUrls(input.relays ?? [], { allowPrivateHosts: input.allowPrivateHosts });
  for (const warning of relays.warnings) warnings.push(warning);
  for (const url of relays.urls) tags.push(['r', url]);

  const topics = sanitizeTopicSlugs(input.topics ?? []);
  for (const warning of topics.warnings) warnings.push(warning);
  for (const slug of topics.slugs) tags.push(['t', slug]);

  return { tags, warnings };
}

/** Content JSON of an announcement (unknown fields are ignored on read). */
export function nodeAnnounceContent(input: NodeAnnounceInput): string {
  const payload: Record<string, string | number> = { v: 1 };
  const software = sanitizeSoftware(input.software);
  if (software !== null) payload.software = software;
  const webUrl = sanitizeWebUrl(input.webUrl, { allowPrivateHosts: input.allowPrivateHosts });
  if (webUrl !== null) payload.web_url = webUrl;
  if (typeof input.topicCount === 'number' && Number.isFinite(input.topicCount) && input.topicCount >= 0) {
    payload.topic_count = Math.floor(input.topicCount);
  }
  if (typeof input.checkpoint === 'number' && Number.isFinite(input.checkpoint) && input.checkpoint >= 0) {
    payload.checkpoint = Math.floor(input.checkpoint);
  }
  return JSON.stringify(payload);
}

/**
 * Build the unsigned event the caller then signs (with `signWithPow` in the
 * gateway). Kept separate from signing so PoW mining can run off the loop.
 */
export function buildNodeAnnounceUnsigned(input: NodeAnnounceInput): {
  kind: number;
  created_at: number;
  tags: NostrTag[];
  content: string;
  warnings: string[];
} {
  const createdAt = input.created_at ?? Math.floor(Date.now() / 1000);
  const { tags, warnings } = nodeAnnounceTags(input);
  return {
    kind: 30026,
    created_at: createdAt,
    tags,
    content: nodeAnnounceContent(input),
    warnings,
  };
}

/**
 * Graceful-shutdown tombstone: same address, role label `offline`, no relay
 * tags, `expiration = created_at` so it expires immediately (Q3 option d).
 */
export function buildNodeOfflineUnsigned(input: {
  pubkey: string;
  created_at?: number;
  software?: string;
  d?: string;
}): { kind: number; created_at: number; tags: NostrTag[]; content: string } {
  const createdAt = input.created_at ?? Math.floor(Date.now() / 1000);
  const tags: NostrTag[] = [
    ['d', input.d ?? nodeIdFromPubkey(input.pubkey)],
    ['L', NODE_ROLE_NAMESPACE],
    ['l', NODE_ROLE_OFFLINE, NODE_ROLE_NAMESPACE],
    ['expiration', String(createdAt)],
  ];
  const payload: Record<string, string | number> = { v: 1, status: NODE_ROLE_OFFLINE };
  const software = sanitizeSoftware(input.software);
  if (software !== null) payload.software = software;
  return { kind: 30026, created_at: createdAt, tags, content: JSON.stringify(payload) };
}

/**
 * Parse and sanitize one announcement. Returns `node: null` with a reason
 * when the event must not enter the directory at all.
 */
export function parseNodeAnnounce(
  event: NostrEvent,
  options: NodeSanitizeOptions = {},
): NodeParseResult {
  const warnings: string[] = [];
  const now = options.now ?? Math.floor(Date.now() / 1000);

  if (event.kind !== 30026) return { node: null, reason: 'wrong_kind', warnings };
  if (event.created_at > now + NODE_ANNOUNCE_MAX_CLOCK_SKEW_S) {
    return { node: null, reason: 'created_in_future', warnings };
  }

  const d = findTagValue(event.tags, 'd');
  if (d === null || d.length === 0) return { node: null, reason: 'missing_d', warnings };
  // P0 anti-flood: only the owner of the node key may fill its address.
  if (!nodeIdMatchesPubkey(d, event.pubkey)) {
    return { node: null, reason: 'd_mismatch', warnings };
  }

  const role = readRoleLabel(event.tags);
  if (role === null) return { node: null, reason: 'missing_role', warnings };
  const offline = role === NODE_ROLE_OFFLINE;
  if (!offline && !isNodeRole(role)) return { node: null, reason: 'unknown_role', warnings };

  const relays = sanitizeRelayUrls(
    findAllTagValues(event.tags, 'r'),
    { allowPrivateHosts: options.allowPrivateHosts },
  );
  for (const warning of relays.warnings) warnings.push(warning);
  if (!offline && relays.urls.length === 0) {
    return { node: null, reason: 'no_public_relays', warnings };
  }

  const topics = sanitizeTopicSlugs(findAllTagValues(event.tags, 't'));
  for (const warning of topics.warnings) warnings.push(warning);
  const topicSlugs = topics.slugs;

  const content = parseAnnounceContent(event.content, warnings);
  const webUrl = sanitizeWebUrl(content.web_url, { allowPrivateHosts: options.allowPrivateHosts });
  const software = sanitizeSoftware(content.software);

  const ttl = readExpiration(event.tags, event.created_at, warnings);
  const checkpoint =
    typeof content.checkpoint === 'number' &&
    Number.isFinite(content.checkpoint) &&
    content.checkpoint >= 0 &&
    content.checkpoint <= now
      ? Math.floor(content.checkpoint)
      : null;
  const topicCount =
    typeof content.topic_count === 'number' &&
    Number.isFinite(content.topic_count) &&
    content.topic_count >= 0
      ? Math.floor(content.topic_count)
      : null;

  return {
    node: {
      node_id: d,
      pubkey: event.pubkey,
      role: offline ? NODE_ROLE_OFFLINE : (role as NodeRole),
      relay_urls: relays.urls,
      web_url: webUrl,
      topics: topicSlugs,
      topic_count: topicCount,
      checkpoint,
      software,
      created_at: event.created_at,
      expires_at: event.created_at + ttl,
      ttl_s: ttl,
      offline,
      event_id: event.id,
    },
    warnings,
  };
}

/** Freshness of a record at `nowS` (age is floored at 0 for clock skew). */
export interface NodeFreshness {
  age_s: number;
  stale: boolean;
  expired: boolean;
}

export function nodeFreshness(
  node: Pick<NodeRecord, 'created_at' | 'expires_at'>,
  nowS: number,
): NodeFreshness {
  const age = Math.max(0, nowS - node.created_at);
  const ttl = Math.max(0, node.expires_at - node.created_at);
  return {
    age_s: age,
    stale: age > NODE_ANNOUNCE_STALE_AFTER_S,
    expired: age > ttl,
  };
}

/** True when `node` is older than the drop window and must be hidden. */
export function nodeIsDropped(node: Pick<NodeRecord, 'created_at'>, nowS: number): boolean {
  return nowS - node.created_at > NODE_ANNOUNCE_MAX_AGE_S;
}

/** NIP-09 deletion of one or more node announcements. */
export interface NodeDeletion {
  pubkey: string;
  event_id: string;
  created_at: number;
  /** `a` tag values of the form `30026:<pubkey>:<d>`. */
  addresses: string[];
}

export function parseNodeDeletion(event: NostrEvent): NodeDeletion | null {
  if (event.kind !== 5) return null;
  const addresses = findAllTagValues(event.tags, 'a').filter(
    (value) => value.startsWith(NODE_ADDRESS_PREFIX),
  );
  if (addresses.length === 0) return null;
  return {
    pubkey: event.pubkey,
    event_id: event.id,
    created_at: event.created_at,
    addresses,
  };
}

/**
 * A deletion only removes an announcement that it addresses **and** that the
 * same pubkey signed — otherwise any client could delete any node by
 * guessing its address.
 */
export function deletionRemovesNode(deletion: NodeDeletion, node: NodeRecord): boolean {
  const address = nodeAddress(node);
  return deletion.addresses.includes(address) && deletion.pubkey === node.pubkey;
}

// ── sanitizers ─────────────────────────────────────────────────────────────

/**
 * Normalize one relay URL. Rules: `wss://` (or `ws://` with
 * `allowPrivateHosts`), no userinfo, no path/query/fragment, optional port,
 * and a **public** host unless the operator opted into private hosts.
 */
export function sanitizeRelayUrl(
  raw: string,
  options: NodeSanitizeOptions = {},
): string | null {
  return sanitizeEndpoint(raw, options, 'ws', 'wss');
}

/** Normalize a web URL: `https://host` origin only (http for private hosts). */
export function sanitizeWebUrl(
  raw: unknown,
  options: NodeSanitizeOptions = {},
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return sanitizeEndpoint(raw, options, 'http', 'https');
}

function sanitizeEndpoint(
  raw: string,
  options: NodeSanitizeOptions,
  insecureScheme: 'ws' | 'http',
  secureScheme: 'wss' | 'https',
): string | null {
  const allowPrivate = options.allowPrivateHosts === true;
  const value = raw.trim();
  if (value.length === 0 || value.length > NODE_ANNOUNCE_MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== secureScheme && !(allowPrivate && scheme === insecureScheme)) return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;
  const path = url.pathname;
  if (path !== '/' && path !== '') return null;

  let host = url.hostname.toLowerCase();
  if (host.length === 0) return null;
  const bracketed = host.startsWith('[') && host.endsWith(']');
  if (bracketed) host = host.slice(1, -1);
  if (!isPublicHost(host, allowPrivate)) return null;

  const port = url.port;
  if (port.length > 0) {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return null;
    return `${scheme}://${bracketed ? `[${host}]` : host}:${port}`;
  }
  return `${scheme}://${bracketed ? `[${host}]` : host}`;
}

export function sanitizeRelayUrls(
  values: readonly string[],
  options: NodeSanitizeOptions = {},
): { urls: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const urls: string[] = [];
  for (const value of values) {
    const normalized = sanitizeRelayUrl(value, options);
    if (normalized === null) {
      warnings.push(`relay url rejected: ${value.slice(0, 80)}`);
      continue;
    }
    if (urls.includes(normalized)) continue;
    if (urls.length >= NODE_ANNOUNCE_MAX_RELAYS) {
      warnings.push(`relay url dropped (max ${String(NODE_ANNOUNCE_MAX_RELAYS)}): ${normalized}`);
      continue;
    }
    urls.push(normalized);
  }
  return { urls, warnings };
}

export function sanitizeTopicSlugs(values: readonly string[]): { slugs: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const slugs: string[] = [];
  for (const value of values) {
    const slug = value.trim().toLowerCase();
    if (!TOPIC_SLUG_RE.test(slug)) {
      warnings.push(`topic tag rejected: ${value.slice(0, 80)}`);
      continue;
    }
    if (slugs.includes(slug)) continue;
    if (slugs.length >= NODE_ANNOUNCE_MAX_TOPICS) {
      warnings.push(`topic tag dropped (max ${String(NODE_ANNOUNCE_MAX_TOPICS)}): ${slug}`);
      continue;
    }
    slugs.push(slug);
  }
  return { slugs, warnings };
}

function sanitizeSoftware(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // printable ASCII only, no control characters (it ends up in JSON + HTML)
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) return null;
  }
  return trimmed.slice(0, NODE_ANNOUNCE_MAX_SOFTWARE_CHARS);
}

/** NIP-32 role label: `["l", <role>, "forum4ai.role"]` with the `L` marker. */
function readRoleLabel(tags: readonly NostrTag[]): string | null {
  let hasNamespace = false;
  let role: string | null = null;
  for (const tag of tags) {
    if (tag[0] === 'L' && tag[1] === NODE_ROLE_NAMESPACE) hasNamespace = true;
    if (tag[0] === 'l' && tag[2] === NODE_ROLE_NAMESPACE && typeof tag[1] === 'string') {
      role = tag[1].trim().toLowerCase();
    }
  }
  if (role === null || !hasNamespace) return null;
  return role;
}

/** NIP-40 `expiration`, clamped to what a heartbeat can actually deliver. */
function readExpiration(tags: readonly NostrTag[], createdAt: number, warnings: string[]): number {
  const raw = findTagValue(tags, 'expiration');
  if (raw === null) return NODE_ANNOUNCE_TTL_S;
  const parsed = Number(raw);
  // `expiration` in the past or at `created_at` is deliberate (the offline
  // tombstone) — only a non-number or a *negative* span is nonsense.
  if (!Number.isFinite(parsed) || parsed < createdAt) return NODE_ANNOUNCE_TTL_S;
  const ttl = Math.round(parsed - createdAt);
  // A zero span is deliberate: the offline tombstone says "already expired".
  if (ttl === 0) return 0;
  const clamped = clampNodeTtl(ttl);
  if (clamped !== ttl) warnings.push(`expiration clamped to ${String(clamped)}s`);
  return clamped;
}

function parseAnnounceContent(
  content: string,
  warnings: string[],
): { software?: unknown; web_url?: unknown; topic_count?: unknown; checkpoint?: unknown } {
  if (content.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    warnings.push('content is not JSON, ignored');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnings.push('content JSON is not an object, ignored');
    return {};
  }
  return parsed as Record<string, unknown>;
}

// ── host rules ─────────────────────────────────────────────────────────────

/** True when `host` may be dialed by a public mesh node. */
export function isPublicHost(host: string, allowPrivate = false): boolean {
  if (allowPrivate) return true;
  const normalized = host.toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '0.0.0.0' || normalized === '::') return false;
  for (const suffix of PRIVATE_HOST_SUFFIXES) {
    if (normalized === suffix.slice(1) || normalized.endsWith(suffix)) return false;
  }
  const v4 = parseIpv4(normalized);
  if (v4 !== null) return !isPrivateIpv4(v4);
  const v6 = parseIpv6(normalized);
  if (v6 !== null) return !isPrivateIpv6(v6);
  // A public hostname must be a dotted FQDN; single labels are LAN shortcuts.
  return normalized.includes('.') && normalized.length <= 253;
}

function parseIpv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return null;
  const parts = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part > 255)) return null;
  return parts;
}

function isPrivateIpv4(parts: readonly number[]): boolean {
  const [a = 0, b = 0] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 0) return true; // this network
  return false;
}

/** Expand an IPv6 literal into 8 groups of 16 bits, or null when invalid. */
function parseIpv6(host: string): number[] | null {
  if (!host.includes(':')) return null;
  let body = host;
  // IPv4-mapped tail (::ffff:127.0.0.1) becomes two 16-bit groups.
  const lastColon = body.lastIndexOf(':');
  const mappedTail = lastColon >= 0 ? body.slice(lastColon + 1) : '';
  if (mappedTail.includes('.')) {
    const v4 = parseIpv4(mappedTail);
    if (v4 === null) return null;
    const hi = (v4[0] ?? 0) * 256 + (v4[1] ?? 0);
    const lo = (v4[2] ?? 0) * 256 + (v4[3] ?? 0);
    // groups are hex, so the embedded v4 halves must be rendered as hex
    body = `${body.slice(0, lastColon)}:${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const tail = parseGroups(halves[1] ?? '');
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isPrivateIpv6(groups: readonly number[]): boolean {
  const first = groups[0] ?? 0;
  if (groups.every((group) => group === 0)) return true; // :: (unspecified)
  if (groups.length === 8 && groups.slice(0, 5).every((group) => group === 0)) {
    if (groups[5] === 0xffff) {
      // IPv4-mapped (::ffff:a.b.c.d): reuse the v4 rules on the embedded address
      const high = groups[6] ?? 0;
      const low = groups[7] ?? 0;
      return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    }
    if (groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true; // ::1
  }
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  return false;
}

// ── tag helpers (local, so this module has no import cycle) ────────────────

function findTagValue(tags: readonly NostrTag[], name: string): string | null {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === 'string') return tag[1];
  }
  return null;
}

function findAllTagValues(tags: readonly NostrTag[], name: string): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === 'string') out.push(tag[1]);
  }
  return out;
}
