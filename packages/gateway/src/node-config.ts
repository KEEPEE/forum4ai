/**
 * Node role configuration — the ONE place that decides what this instance
 * does in the mesh (F4AI-39, epic F4AI-35).
 *
 * Three environment variables describe a deployment:
 *
 * | var              | values                              | default            |
 * |------------------|-------------------------------------|--------------------|
 * | `NODE_ROLE`      | `client` `writer` `seed` `hub`      | `hub`              |
 * | `NODE_ANNOUNCE`  | `on` `off`                          | see below          |
 * | `NODE_UPSTREAMS` | `off` `manual` `auto`               | `manual`           |
 *
 * **Backward compatibility is law.** A deployment that sets none of them gets
 * `role=hub`, `announce=off`, `upstreams=manual` — which is exactly the
 * behavior of the previous release: full instance, federation over
 * `GATEWAY_UPSTREAM_GATEWAYS`, and *zero* new outbound connections and zero
 * new published events. Announcing is opt-in: it turns on by itself only when
 * the operator names a mesh role explicitly (`NODE_ROLE=seed|hub`).
 *
 * The role is a statement about *this instance*, not a permission granted by
 * anybody else. What it changes in code is deliberately small:
 *
 *  - `client` / `writer` — no announcement, no federation (they consume the
 *    mesh, they do not host it),
 *  - `seed` — announces itself, may PULL from upstreams, never PUSHes, and
 *    does not accept writes (`POST /events` → 405) or registrations,
 *  - `hub` — full instance, as today.
 *
 * Whether a seed's relay is actually reachable from the public internet is
 * operator configuration (reverse proxy, `RELAY_READ_ONLY`), not something
 * this module can know.
 */
import { createHash } from 'node:crypto';

import {
  NODE_ANNOUNCE_HEARTBEAT_MS,
  NODE_ANNOUNCE_TTL_S,
  clampNodeTtl,
  isNodeRole,
  sanitizeWebUrl,
  type NodeRole,
} from '@forum4ai/shared';

/** How the gateway learns which upstream instances to talk to. */
export type UpstreamsMode = 'off' | 'manual' | 'auto';

/** What this instance does, derived from the role (never set directly). */
export interface NodeCapabilities {
  /** accepts `POST /events` (own-topic writes) */
  write: boolean;
  /** serves `/register/*` and `/write-status` */
  register: boolean;
  /** federation PULL from upstreams */
  fedPull: boolean;
  /** federation PUSH to upstreams */
  fedPush: boolean;
  /** publishes its own kind 30026 announcement */
  announce: boolean;
  /** serves `GET /nodes` */
  directory: boolean;
}

export interface NodeConfig {
  role: NodeRole;
  /** `NODE_ROLE` was set explicitly — this is what turns announcing on by default. */
  roleExplicit: boolean;
  /** effective announcement switch (role + `NODE_ANNOUNCE`) */
  announce: boolean;
  /** seconds an announcement stays valid (NIP-40 `expiration`) */
  announceTtlS: number;
  /** milliseconds between heartbeats */
  heartbeatMs: number;
  /** 64-hex node secret; `''` means this instance cannot announce */
  nodeSkHex: string;
  /** where the secret came from, for `GET /health` and logs */
  nodeSkSource: 'NODE_SK' | 'NODE_PASSPHRASE' | 'GATEWAY_OWNER_SK_HEX' | 'none';
  /** public web root advertised in the directory (`null` = not advertised) */
  webUrl: string | null;
  /** software string advertised in the announcement content */
  software: string;
  upstreamsMode: UpstreamsMode;
  /** dev escape hatch: advertise `ws://` and private hosts */
  allowPrivateHosts: boolean;
  capabilities: NodeCapabilities;
  /** what we discarded from the environment and why (surfaced in logs) */
  warnings: string[];
}

export const DEFAULT_NODE_SOFTWARE = 'forum4ai';

/** Domain separation for the passphrase → secret derivation. */
export const NODE_PASSPHRASE_DOMAIN = 'forum4ai-node-v1:';

function flag(env: Record<string, string | undefined>, key: string): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Turn whatever the operator put in `NODE_SK` into a 64-hex secret.
 *
 * A 64-hex value is the key itself. Anything else is a passphrase and is
 * hashed with a fixed domain tag, so the same passphrase on two machines
 * yields the same node id without storing a second secret.
 */
export function nodeSkFromSecret(secret: string): string {
  const trimmed = secret.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  return createHash('sha256').update(`${NODE_PASSPHRASE_DOMAIN}${trimmed}`, 'utf8').digest('hex');
}

/** Capability matrix. `hub` is today's instance, so it changes nothing. */
export function nodeCapabilities(role: NodeRole, announce: boolean): NodeCapabilities {
  switch (role) {
    case 'client':
      return { write: true, register: false, fedPull: false, fedPush: false, announce: false, directory: true };
    case 'writer':
      return { write: true, register: false, fedPull: false, fedPush: false, announce: false, directory: true };
    case 'seed':
      return { write: false, register: false, fedPull: true, fedPush: false, announce, directory: true };
    case 'hub':
    default:
      return { write: true, register: true, fedPull: true, fedPush: true, announce, directory: true };
  }
}

/**
 * Resolve the node configuration from the environment. Pure and total: every
 * invalid value falls back to the legacy default and is reported in
 * `warnings` instead of throwing, because a typo in a new variable must not
 * brick an existing deployment.
 */
export function resolveNodeConfig(
  env: Record<string, string | undefined> = process.env,
): NodeConfig {
  const warnings: string[] = [];

  const roleRaw = env['NODE_ROLE']?.trim().toLowerCase() ?? '';
  const roleExplicit = roleRaw !== '';
  let role: NodeRole = 'hub';
  // A typo is not a decision: `NODE_ROLE=supernode` must not switch on the
  // mesh defaults of a named role, it falls back to the legacy behavior.
  let roleNamed = false;
  if (roleExplicit) {
    if (isNodeRole(roleRaw)) {
      role = roleRaw;
      roleNamed = true;
    } else {
      warnings.push(`NODE_ROLE="${roleRaw}" is not one of client|writer|seed|hub, using hub`);
    }
  }

  const allowPrivateHosts = flag(env, 'NODE_ALLOW_PRIVATE');

  // Announce: explicit NODE_ANNOUNCE wins; otherwise a node that *named* a
  // mesh role announces itself, and a deployment that set nothing at all
  // stays exactly as silent as it was before this feature existed.
  const announceRaw = env['NODE_ANNOUNCE']?.trim().toLowerCase() ?? '';
  let announce: boolean;
  if (announceRaw === '') {
    announce = roleNamed && (role === 'seed' || role === 'hub');
  } else if (announceRaw === 'on' || announceRaw === '1' || announceRaw === 'true' || announceRaw === 'yes') {
    announce = true;
  } else if (announceRaw === 'off' || announceRaw === '0' || announceRaw === 'false' || announceRaw === 'no') {
    announce = false;
  } else {
    warnings.push(`NODE_ANNOUNCE="${announceRaw}" is not on|off, using the role default`);
    announce = roleNamed && (role === 'seed' || role === 'hub');
  }

  const upstreamsRaw = env['NODE_UPSTREAMS']?.trim().toLowerCase() ?? '';
  let upstreamsMode: UpstreamsMode = 'manual';
  if (upstreamsRaw === '') upstreamsMode = 'manual';
  else if (upstreamsRaw === 'off' || upstreamsRaw === 'manual' || upstreamsRaw === 'auto') {
    upstreamsMode = upstreamsRaw;
  } else {
    warnings.push(`NODE_UPSTREAMS="${upstreamsRaw}" is not off|manual|auto, using manual`);
  }

  // Node key: NODE_SK (hex or passphrase) → NODE_PASSPHRASE → owner key.
  // Falling back to the owner key keeps a first announcement working out of
  // the box, but it is worth a warning: the owner key is the writers-list
  // signer and rate limits are per pubkey, so a shared key couples the two.
  const skRaw = env['NODE_SK']?.trim() ?? '';
  const passphraseRaw = env['NODE_PASSPHRASE']?.trim() ?? '';
  const ownerRaw = env['GATEWAY_OWNER_SK_HEX']?.trim() ?? '';
  let nodeSkHex = '';
  let nodeSkSource: NodeConfig['nodeSkSource'] = 'none';
  if (skRaw !== '') {
    nodeSkHex = nodeSkFromSecret(skRaw);
    nodeSkSource = /^[0-9a-f]{64}$/i.test(skRaw) ? 'NODE_SK' : 'NODE_PASSPHRASE';
  } else if (passphraseRaw !== '') {
    nodeSkHex = nodeSkFromSecret(passphraseRaw);
    nodeSkSource = 'NODE_PASSPHRASE';
  } else if (ownerRaw !== '') {
    nodeSkHex = /^[0-9a-f]{64}$/i.test(ownerRaw) ? ownerRaw.toLowerCase() : nodeSkFromSecret(ownerRaw);
    nodeSkSource = 'GATEWAY_OWNER_SK_HEX';
    warnings.push('node key falls back to GATEWAY_OWNER_SK_HEX; set NODE_SK to keep the node key separate');
  }

  if (announce && nodeSkHex === '') {
    warnings.push('announce is on but no node key is available (NODE_SK / NODE_PASSPHRASE / GATEWAY_OWNER_SK_HEX), disabling announcements');
    announce = false;
  }
  if (announce && (role === 'client' || role === 'writer')) {
    warnings.push(`NODE_ROLE=${role} does not announce itself; NODE_ANNOUNCE=on has no effect`);
    announce = false;
  }

  const ttlRaw = env['NODE_ANNOUNCE_TTL_S']?.trim() ?? '';
  let announceTtlS = NODE_ANNOUNCE_TTL_S;
  if (ttlRaw !== '') {
    const parsed = Number(ttlRaw);
    announceTtlS = clampNodeTtl(Number.isFinite(parsed) ? parsed : undefined);
    if (Number.isFinite(parsed) && announceTtlS !== Math.round(parsed)) {
      warnings.push(`NODE_ANNOUNCE_TTL_S=${ttlRaw} clamped to ${String(announceTtlS)}s`);
    }
  }
  const heartbeatS = num(env, 'NODE_ANNOUNCE_INTERVAL_S', Math.round(NODE_ANNOUNCE_HEARTBEAT_MS / 1000));
  if (heartbeatS * 1000 > announceTtlS * 1000) {
    warnings.push(
      `NODE_ANNOUNCE_INTERVAL_S=${String(heartbeatS)} is longer than the TTL (${String(announceTtlS)}s); the node would drop out between heartbeats`,
    );
  }

  const webUrl = sanitizeWebUrl(env['NODE_WEB_URL'] ?? '', { allowPrivateHosts });
  if ((env['NODE_WEB_URL'] ?? '').trim() !== '' && webUrl === null) {
    warnings.push(`NODE_WEB_URL="${String(env['NODE_WEB_URL'])}" is not a public https origin, not advertised`);
  }

  const software = (env['NODE_SOFTWARE']?.trim() ?? '').slice(0, 64) || DEFAULT_NODE_SOFTWARE;

  return {
    role,
    roleExplicit,
    announce,
    announceTtlS,
    heartbeatMs: heartbeatS * 1000,
    nodeSkHex,
    nodeSkSource,
    webUrl,
    software,
    upstreamsMode,
    allowPrivateHosts,
    capabilities: nodeCapabilities(role, announce),
    warnings,
  };
}
