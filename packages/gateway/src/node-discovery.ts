/**
 * F4AI-38 — automatic relay discovery.
 *
 * A node with `NODE_UPSTREAMS=auto` learns which relays the rest of the mesh
 * actually serves by asking its configured upstreams for their `GET /nodes`
 * directory (through `NodeDirectory`, which already speaks that protocol). The
 * relays announced by reachable `seed`/`hub` nodes are added to the pool as
 * READ-ONLY entries: we never publish through a relay we did not configure,
 * but we can read from one when our own relays fall over.
 *
 * Two rules make this safe to turn on:
 *
 * 1. **Nothing happens unless auto mode is on.** The timer is created only
 *    when `upstreamsMode === 'auto'`, so a legacy deployment opens zero new
 *    connections and publishes zero extra events.
 * 2. **A discovered relay is never trusted with an address we cannot verify.**
 *    The announcement is signed, but the *relay URL inside it* is free text.
 *    We therefore re-check the host (public hostname or public literal IP) and
 *    resolve DNS BEFORE the pool connects, rejecting any name that resolves to
 *    a private/loopback/link-local range. Without that check a hostile seed
 *    could announce `ws://169.254.169.254/` and turn our gateway into an SSRF
 *    probe against its own metadata service.
 *
 * Retraction matters as much as discovery: a seed that disappears must be
 * dropped, otherwise the pool grows forever and keeps retrying dead peers.
 */
import { isPublicHost, sanitizeRelayUrl } from '@forum4ai/shared';

import type { NodeList, NodeEntry } from './node-directory.js';
import { normalizeRelayUrl } from './relay-pool.js';

/** Pool surface we need (kept narrow so unit tests can fake it). */
export interface DiscoveryPool {
  add(url: string, opts?: { write?: boolean; discovered?: boolean }): string | null;
  remove(url: string): boolean;
  /** every managed url, configured and discovered */
  readonly urls: string[];
  discoveredUrls(): string[];
  status(): { url: string; connected: boolean; attempts: number }[];
}

/** Directory surface we need — `NodeDirectory` satisfies it. */
export interface DiscoveryDirectory {
  list(opts?: { role?: string | null; limit?: number }): Promise<NodeList>;
}

export interface NodeDiscoveryOptions {
  pool: DiscoveryPool;
  directory: DiscoveryDirectory;
  /** our own relay urls — never discovered back into ourselves */
  ownRelays?: () => readonly string[];
  /** our own node id / pubkey, to skip our own announcement */
  selfNodeId?: string | null;
  selfPubkey?: string | null;
  /** hostname → addresses (injectable; default `dns.lookup({ all: true })`) */
  resolve?: (host: string) => Promise<string[]>;
  /** refresh window (default 120 s — deliberately slower than the heartbeat) */
  refreshMs?: number;
  /** hard cap on discovered relays in the pool (default 8) */
  maxTotal?: number;
  /** cap per upstream gateway, so one peer cannot fill the pool (default 3) */
  maxPerUpstream?: number;
  /** consecutive refreshes a relay may be missed before we drop it (default 2) */
  maxMisses?: number;
  /** drop a discovered relay that never connected after this long (default 15 min) */
  connectGraceMs?: number;
  /** dev/LAN escape hatch, mirrors `NODE_ALLOW_PRIVATE` */
  allowPrivateHosts?: boolean;
  logger?: (line: string) => void;
  now?: () => number;
}

export interface DiscoveredRelay {
  url: string;
  /** upstream gateway ids that told us about it */
  via: string[];
  added_at: number;
  last_seen_at: number;
  misses: number;
  connected: boolean;
  attempts: number;
}

export interface DiscoveryStatus {
  running: boolean;
  refreshed_at: number;
  relays: DiscoveredRelay[];
  last_error: string | null;
  warnings: string[];
  added: number;
  removed: number;
}

export const DISCOVERY_DEFAULTS = {
  refreshMs: 120_000,
  maxTotal: 8,
  maxPerUpstream: 3,
  maxMisses: 2,
  connectGraceMs: 15 * 60_000,
  /** DNS must answer fast; a slow resolver skips this round, it does not hang */
  resolveTimeoutMs: 5_000,
  /** how many directory entries one round inspects */
  listLimit: 100,
} as const;

/** Roles worth connecting to. `writer`/`client` announce nothing and have no relays to offer. */
const DISCOVERABLE_ROLES: ReadonlySet<string> = new Set(['seed', 'hub']);

/**
 * Resolve a hostname to addresses. Default implementation uses `dns.lookup`
 * with `all: true` so we see every A and AAAA record — accepting a name
 * because ONE of its records is public would let DNS round-robin smuggle a
 * private address in on the next connection.
 */
async function defaultResolve(host: string): Promise<string[]> {
  const { promises: dns } = await import('node:dns');
  const rows = await dns.lookup(host, { all: true });
  return rows.map((row) => row.address);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`resolve timeout after ${String(timeoutMs)}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Hostname of a relay url, without the brackets IPv6 hosts carry. */
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === '') return null;
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  } catch {
    return null;
  }
}

/**
 * SSRF gate for one candidate url. Returns `null` when the url is acceptable,
 * otherwise the reason it was rejected. Literal IPs are checked inline (no
 * lookup needed); names are resolved first and EVERY record must be public.
 */
async function checkAddress(
  url: string,
  allowPrivateHosts: boolean,
  resolve: (host: string) => Promise<string[]>,
): Promise<string | null> {
  const host = hostOf(url);
  if (host === null) return 'unparsable host';
  if (allowPrivateHosts) return null;
  if (!isPublicHost(host)) return 'private or non-FQDN host';
  let addresses: string[];
  try {
    addresses = await withTimeout(resolve(host), DISCOVERY_DEFAULTS.resolveTimeoutMs);
  } catch (error) {
    return `dns: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (addresses.length === 0) return 'dns: no addresses';
  for (const address of addresses) {
    if (!isPublicHost(address)) return `dns: ${address} is not a public address`;
  }
  return null;
}

/**
 * Auto-discovery engine. `tick()` is public and synchronous-to-await so unit
 * tests can drive it without any timer at all.
 */
export class NodeDiscovery {
  private readonly options: {
    pool: DiscoveryPool;
    directory: DiscoveryDirectory;
    ownRelays: () => readonly string[];
    selfNodeId: string | null;
    selfPubkey: string | null;
    resolve: (host: string) => Promise<string[]>;
    refreshMs: number;
    maxTotal: number;
    maxPerUpstream: number;
    maxMisses: number;
    connectGraceMs: number;
    allowPrivateHosts: boolean;
    logger: (line: string) => void;
    now: () => number;
  };

  /** url → what we know about a relay WE added (foreign entries are ignored) */
  private readonly known = new Map<string, DiscoveredRelay>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private refreshedAt = 0;
  private lastError: string | null = null;
  private warnings: string[] = [];
  private addedTotal = 0;
  private removedTotal = 0;

  constructor(options: NodeDiscoveryOptions) {
    this.options = {
      pool: options.pool,
      directory: options.directory,
      ownRelays: options.ownRelays ?? (() => []),
      selfNodeId: options.selfNodeId ?? null,
      selfPubkey: options.selfPubkey ?? null,
      resolve: options.resolve ?? defaultResolve,
      refreshMs: options.refreshMs ?? DISCOVERY_DEFAULTS.refreshMs,
      maxTotal: Math.max(1, options.maxTotal ?? DISCOVERY_DEFAULTS.maxTotal),
      maxPerUpstream: Math.max(1, options.maxPerUpstream ?? DISCOVERY_DEFAULTS.maxPerUpstream),
      maxMisses: Math.max(1, options.maxMisses ?? DISCOVERY_DEFAULTS.maxMisses),
      connectGraceMs: options.connectGraceMs ?? DISCOVERY_DEFAULTS.connectGraceMs,
      allowPrivateHosts: options.allowPrivateHosts ?? false,
      logger: options.logger ?? (() => undefined),
      now: options.now ?? (() => Date.now()),
    };
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    const timer = setInterval(() => {
      void this.tick();
    }, this.options.refreshMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * One discovery round: read the directory, keep only relays that pass the
   * address gate, add what fits, retract what vanished.
   */
  async tick(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.doTick();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  status(): DiscoveryStatus {
    const live = new Map(this.options.pool.status().map((s) => [s.url, s]));
    const relays = [...this.known.values()].map((relay) => {
      const state = live.get(relay.url);
      return {
        ...relay,
        connected: state?.connected ?? false,
        attempts: state?.attempts ?? 0,
      };
    });
    return {
      running: this.running,
      refreshed_at: this.refreshedAt,
      relays,
      last_error: this.lastError,
      warnings: [...this.warnings],
      added: this.addedTotal,
      removed: this.removedTotal,
    };
  }

  /** urls currently eligible to be added (diagnostics + tests) */
  async candidates(): Promise<string[]> {
    const list = await this.options.directory.list({ limit: DISCOVERY_DEFAULTS.listLimit });
    return this.collect(list.nodes).map((candidate) => candidate.url);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async doTick(): Promise<void> {
    const warnings: string[] = [];
    let nodes: NodeEntry[];
    try {
      const list = await this.options.directory.list({ limit: DISCOVERY_DEFAULTS.listLimit });
      nodes = list.nodes;
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.warnings = [`directory: ${this.lastError}`];
      this.options.logger(`[discovery] directory failed: ${this.lastError}`);
      return;
    }

    const { candidates, rejected } = this.collectWithRejections(nodes);
    for (const url of rejected) warnings.push(`rejected ${url}: not a public relay url`);
    const accepted: Candidate[] = [];
    for (const candidate of candidates) {
      const reason = await checkAddress(
        candidate.url,
        this.options.allowPrivateHosts,
        this.options.resolve,
      );
      if (reason !== null) {
        warnings.push(`rejected ${candidate.url}: ${reason}`);
        continue;
      }
      accepted.push(candidate);
    }

    // Cap per upstream first, then globally, so one chatty peer cannot take
    // every slot. `via` is empty for relays seen directly on our own relays.
    // P1 (dizajn review): kvóty sú KUMULATÍVNE naprieč kolami. Započítava sa
    // aj relay, ktorého sme už pridali v predchádzajúcom kole — inak by
    // `maxPerUpstream` platilo len per tick a štvrtý upstream by sa dostal
    // dnu, hoci strop hovorí inak. A známé URL preskakujeme PRED počítaním,
    // inak by vlastné relaye spotrebúvali kvótu a nové by sa nikdy nedostali.
    const perUpstream = new Map<string, number>();
    for (const relay of this.known.values()) {
      const key = relay.via[0] ?? 'direct';
      perUpstream.set(key, (perUpstream.get(key) ?? 0) + 1);
    }
    const held = Math.max(this.known.size, this.options.pool.discoveredUrls().length);
    const room = Math.max(0, this.options.maxTotal - held);
    const toAdd: Candidate[] = [];
    let used = 0;
    for (const candidate of accepted) {
      if (used >= room) break;
      if (this.known.has(candidate.url)) continue;
      const key = candidate.via[0] ?? 'direct';
      const count = perUpstream.get(key) ?? 0;
      if (count >= this.options.maxPerUpstream) {
        warnings.push(`skipped ${candidate.url}: upstream ${key} quota reached`);
        continue;
      }
      perUpstream.set(key, count + 1);
      used += 1;
      toAdd.push(candidate);
    }

    const nowMs = this.options.now();
    const seenUrls = new Set<string>();
    for (const candidate of accepted) seenUrls.add(candidate.url);

    for (const candidate of toAdd) {
      if (this.known.has(candidate.url)) continue;
      const added = this.options.pool.add(candidate.url, { write: false, discovered: true });
      if (added === null) continue;
      this.known.set(added, {
        url: added,
        via: candidate.via,
        added_at: nowMs,
        last_seen_at: nowMs,
        misses: 0,
        connected: false,
        attempts: 0,
      });
      this.addedTotal += 1;
      this.options.logger(`[discovery] added ${added} (via ${candidate.via.join(',') || 'direct'})`);
    }

    // Retract: a relay we added that stopped being announced, or that never
    // managed to connect within the grace window.
    for (const [url, relay] of [...this.known]) {
      if (seenUrls.has(url)) {
        // P0 (dizajn review): DNS odpoveď z času pridania nie je sľub do
        // budúcna — meno s krátkym TTL sa môže viazať na súkromnú adresu až
        // neskôr (rebinding). Preto overíme známy relay KAŽDÉ kolo a pri
        // prvej chybe ho vyhodíme hneď: adresu, ktorú by sme dnes nepridali,
        // nesmie držať v poolu to, že bola akceptovateľná pred hodinou.
        const reason = await checkAddress(url, this.options.allowPrivateHosts, this.options.resolve);
        if (reason !== null) {
          warnings.push(`re-check dropped ${url}: ${reason}`);
          if (this.options.pool.remove(url)) {
            this.removedTotal += 1;
            this.options.logger(`[discovery] removed ${url} (address check: ${reason})`);
          }
          this.known.delete(url);
          continue;
        }
        relay.misses = 0;
        relay.last_seen_at = nowMs;
      } else {
        relay.misses += 1;
      }
      const graceOver =
        nowMs - relay.added_at > this.options.connectGraceMs &&
        this.options.pool.status().find((s) => s.url === url)?.connected !== true;
      if (relay.misses > this.options.maxMisses || graceOver) {
        if (this.options.pool.remove(url)) {
          this.removedTotal += 1;
          this.options.logger(`[discovery] removed ${url} (misses=${String(relay.misses)})`);
        }
        this.known.delete(url);
      }
    }

    // A discovered relay can also vanish by someone else removing it from the
    // pool; forget it so we do not report a ghost forever.
    const managed = new Set(this.options.pool.urls);
    for (const url of [...this.known.keys()]) {
      if (!managed.has(url)) this.known.delete(url);
    }

    this.warnings = warnings;
    this.refreshedAt = nowMs;
  }

  /**
   * Directory entries → candidate relay urls, deduped and stripped of ours.
   * `rejected` carries what the sanitizer dropped (a seed announcing
   * `ws://127.0.0.1` is worth a line in `/nodes/status`, not silence).
   */
  private collectWithRejections(
    nodes: readonly NodeEntry[],
  ): { candidates: Candidate[]; rejected: string[] } {
    const rejected: string[] = [];
    const candidates = this.collect(nodes, (url) => rejected.push(url));
    return { candidates, rejected };
  }

  private collect(nodes: readonly NodeEntry[], onReject?: (url: string) => void): Candidate[] {
    const own = new Set<string>();
    for (const url of this.options.ownRelays()) {
      const canonical = normalizeRelayUrl(url);
      if (canonical !== null) own.add(canonical);
    }
    const discovered = new Set(this.options.pool.discoveredUrls());
    for (const url of this.options.pool.urls) {
      // configured pool relays are ours; already-discovered ones are ours too
      // (we keep them, we just do not re-add them)
      if (!discovered.has(url)) own.add(url);
    }
    const out: Candidate[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      if (!DISCOVERABLE_ROLES.has(node.role)) continue;
      if (this.options.selfNodeId !== null && node.node_id === this.options.selfNodeId) continue;
      if (this.options.selfPubkey !== null && node.pubkey === this.options.selfPubkey) continue;
      const via = node.via.length > 0 ? node.via : ['direct'];
      for (const raw of node.relay_urls) {
        // shared sanitizer = scheme/host policy (wss-only unless private is
        // allowed); pool normalizer = the exact key the pool stores, so our
        // dedupe against configured relays actually matches.
        const safe = sanitizeRelayUrl(raw, { allowPrivateHosts: this.options.allowPrivateHosts });
        if (safe === null) {
          onReject?.(raw);
          continue;
        }
        const canonical = normalizeRelayUrl(safe);
        if (canonical === null) continue;
        if (own.has(canonical) || seen.has(canonical)) continue;
        seen.add(canonical);
        out.push({
          url: canonical,
          via,
          role: node.role,
          node_id: node.node_id,
          seen_at: node.seen_at,
          pubkey: node.pubkey,
        });
      }
    }
    // P1 (dizajn review): poradie MUSÍ byť freshest-first, inak komentár
    // klame a útočník si vyberá hostiteľské mená, ktoré sa radia na začiatok
    // abecedy, a obsadí všetky sloty. `pubkey` je finálny tie-break, aby
    // výber nezávisel od poradia, v akom nám upstreamy odpovedali.
    out.sort(
      (a, b) =>
        b.seen_at - a.seen_at ||
        a.pubkey.localeCompare(b.pubkey) ||
        a.url.localeCompare(b.url),
    );
    return out;
  }
}

interface Candidate {
  url: string;
  via: string[];
  role: string;
  node_id: string;
  /** `created_at` of the newest announcement that named this relay */
  seen_at: number;
  pubkey: string;
}

