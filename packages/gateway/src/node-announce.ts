/**
 * Node announcement heartbeat (F4AI-36, epic F4AI-35).
 *
 * A node that agrees to be part of the mesh signs one addressable kind 30026
 * event and refreshes it every ~60 s. The heartbeat *is* the liveness
 * protocol: nobody has to poll a health endpoint, and a node that disappears
 * (crash, network, machine off) simply stops refreshing and falls out of every
 * directory when its NIP-40 `expiration` passes. No cleanup job, no lease.
 *
 * Two rules matter here:
 *
 *  - **The node key is not the owner key.** Rate limits and abuse control are
 *    per pubkey, and the owner key signs the writers directory. Sharing them
 *    would let announcement spam cost the instance its writers list, so the
 *    fallback to `GATEWAY_OWNER_SK_HEX` exists only to make a first
 *    announcement work out of the box — and it is logged.
 *  - **PoW is not exempted.** The relay's `RELAY_POW_MIN` applies to our own
 *    announcements like to any other event, so mining happens here — but
 *    asynchronously (`signWithPowAsync`), because a few hundred milliseconds
 *    of hashing on the event loop would stall every request in flight.
 *
 * A graceful shutdown republishes the same address as an `offline` tombstone
 * with `expiration = created_at`, so peers drop it on their next read instead
 * of waiting out the TTL. A crash never gets that chance — which is exactly
 * why the TTL has to be short.
 */
import { getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';

import {
  NODE_ANNOUNCE_HEARTBEAT_JITTER_MS,
  buildNodeAnnounceUnsigned,
  buildNodeOfflineUnsigned,
  nodeIdFromPubkey,
  signWithPowAsync,
  type NodeRole,
} from '@forum4ai/shared';

import type { PublishResult } from './relay-pool.js';

/** The slice of `RelayPool` the announcer needs (easy to fake in tests). */
export interface AnnouncePool {
  publish(event: Event, relays?: string[]): Promise<PublishResult[]>;
  /** relays with a live connection — used to decide whether to try at all */
  readyRelays?(): string[];
}

export interface NodeAnnouncerOptions {
  /** 64-hex node secret (see `node-config.ts`) */
  skHex: string;
  role: NodeRole;
  pool: AnnouncePool;
  /** relays this node advertises (its own, reachable ones) */
  relays: () => readonly string[];
  /** extra relays to publish to (learned from peers, F4AI-38) */
  extraRelays?: () => readonly string[];
  software: string;
  webUrl?: string | null;
  ttlS: number;
  heartbeatMs: number;
  /** NIP-13 difficulty of our own events (the relay's `RELAY_POW_MIN`) */
  powMin?: number;
  allowPrivateHosts?: boolean;
  /** topic slugs advertised in `t` tags (max 5 after sanitizing) */
  topics?: () => Promise<readonly string[]> | readonly string[];
  /** total topic count advertised in content */
  topicCount?: () => Promise<number | null> | number | null;
  /** federation checkpoint (seconds) advertised in content */
  checkpoint?: () => number | null;
  logger?: (line: string) => void;
  /** seconds epoch (injectable for tests) */
  now?: () => number;
  random?: () => number;
}

export interface NodeAnnounceStatus {
  enabled: boolean;
  role: NodeRole;
  node_id: string;
  pubkey: string;
  running: boolean;
  /** last heartbeat we attempted (seconds epoch) */
  last_attempt_at: number | null;
  /** last heartbeat at least one relay accepted */
  last_ok_at: number | null;
  publishes: number;
  failures: number;
  last_error: string | null;
  /** relays the last heartbeat reached */
  last_delivered: number;
  last_targets: number;
}

export interface AnnounceOutcome {
  event: Event;
  delivered: number;
  targets: number;
  results: PublishResult[];
}

const HEX64 = /^[0-9a-f]{64}$/i;

export class NodeAnnouncer {
  readonly pubkey: string;
  readonly nodeId: string;
  private readonly sk: Uint8Array | null;
  private readonly options: Required<Pick<NodeAnnouncerOptions, 'software' | 'ttlS' | 'heartbeatMs' | 'powMin'>> &
    NodeAnnouncerOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<AnnounceOutcome | null> | null = null;
  private stopping = false;
  private status: NodeAnnounceStatus;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: NodeAnnouncerOptions) {
    this.options = {
      ...options,
      software: options.software,
      ttlS: options.ttlS,
      heartbeatMs: options.heartbeatMs,
      powMin: options.powMin ?? 0,
    };
    const trimmed = options.skHex.trim();
    this.sk = HEX64.test(trimmed) ? Uint8Array.from(Buffer.from(trimmed.toLowerCase(), 'hex')) : null;
    this.pubkey = this.sk === null ? '' : getPublicKey(this.sk).toLowerCase();
    this.nodeId = this.pubkey === '' ? '' : nodeIdFromPubkey(this.pubkey);
    this.log = options.logger ?? (() => undefined);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.random = options.random ?? (() => Math.random());
    this.status = {
      enabled: this.sk !== null,
      role: options.role,
      node_id: this.nodeId,
      pubkey: this.pubkey,
      running: false,
      last_attempt_at: null,
      last_ok_at: null,
      publishes: 0,
      failures: 0,
      last_error: null,
      last_delivered: 0,
      last_targets: 0,
    };
  }

  get enabled(): boolean {
    return this.sk !== null;
  }

  getStatus(): NodeAnnounceStatus {
    return { ...this.status };
  }

  /**
   * Build and publish one heartbeat. Never throws: a node whose relays are
   * down must keep serving its own users, and the next heartbeat will simply
   * find the relays back.
   */
  async announceOnce(): Promise<AnnounceOutcome | null> {
    if (this.sk === null) return null;
    if (this.inFlight !== null) return this.inFlight;
    const run = this.runAnnounce();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  private async runAnnounce(): Promise<AnnounceOutcome | null> {
    const sk = this.sk;
    if (sk === null) return null;
    const createdAt = this.now();
    const own = this.options.relays();
    const extra = this.options.extraRelays?.() ?? [];
    const targets = [...own, ...extra].filter((url) => url.length > 0);
    if (targets.length === 0) {
      this.status.last_error = 'no relays to announce to';
      this.log('announce skipped: this instance has no relay configured');
      return null;
    }

    const topics = await Promise.resolve(this.options.topics?.() ?? []);
    const topicCount = (await Promise.resolve(this.options.topicCount?.() ?? null)) ?? null;
    const checkpoint = this.options.checkpoint?.() ?? null;

    const unsigned = buildNodeAnnounceUnsigned({
      pubkey: this.pubkey,
      role: this.options.role,
      relays: own,
      topics,
      webUrl: this.options.webUrl ?? undefined,
      software: this.options.software,
      topicCount: topicCount ?? undefined,
      checkpoint: checkpoint ?? undefined,
      ttlS: this.options.ttlS,
      created_at: createdAt,
      allowPrivateHosts: this.options.allowPrivateHosts === true,
    });
    for (const warning of unsigned.warnings) this.log(`announce: ${warning}`);

    // P0 (dizajn review): every sanitizer dropped our relay and we still
    // publish. A heartbeat with no `r` tag is rejected by every directory with
    // `no_public_relays`, so the node pays PoW and a publish for an event
    // nobody can list — and the log says `delivered 1/1`, which is a lie about
    // being in the mesh. In the reference compose the connection relays are
    // container addresses (`ws://relay:8080`), so this is the DEFAULT case, not
    // an edge one. Better silent than wrong: skip, and name the fix.
    if (!unsigned.tags.some((tag) => tag[0] === 'r')) {
      this.status.last_error = 'no public relay url to announce';
      this.log(
        'announce skipped: no relay url survives sanitization — a node announces the relays it SERVES, and those must be public wss (NODE_ALLOW_PRIVATE=1 for a LAN/dev mesh)',
      );
      return null;
    }

    let event: Event;
    try {
      event = await signWithPowAsync(
        { kind: unsigned.kind, created_at: unsigned.created_at, tags: unsigned.tags, content: unsigned.content },
        sk,
        this.options.powMin,
        this.pubkey,
      );
    } catch (err) {
      this.status.failures += 1;
      this.status.last_error = err instanceof Error ? err.message : String(err);
      this.log(`announce failed to mine/sign: ${this.status.last_error}`);
      return null;
    }

    this.status.last_attempt_at = createdAt;
    let results: PublishResult[] = [];
    try {
      results = await this.options.pool.publish(event);
    } catch (err) {
      this.status.failures += 1;
      this.status.last_error = err instanceof Error ? err.message : String(err);
      this.log(`announce publish threw: ${this.status.last_error}`);
      return { event, delivered: 0, targets: targets.length, results };
    }
    const delivered = results.filter((result) => result.ok).length;
    this.status.last_targets = results.length;
    this.status.last_delivered = delivered;
    if (delivered > 0) {
      this.status.publishes += 1;
      this.status.last_ok_at = createdAt;
      this.status.last_error = null;
    } else {
      this.status.failures += 1;
      this.status.last_error = results[0]?.message ?? 'no relay accepted the announcement';
    }
    this.log(
      `announce ${this.status.role} ${this.nodeId}: id ${event.id.slice(0, 12)}…, ` +
        `delivered ${String(delivered)}/${String(results.length)}`,
    );
    return { event, delivered, targets: results.length, results };
  }

  /**
   * Start the heartbeat. The first announcement goes out immediately (a node
   * that waits 60 s to introduce itself looks offline to its peers for a
   * minute), then every `heartbeatMs` with ± jitter so a fleet of nodes does
   * not synchronize and stampede the same relays.
   */
  start(): void {
    if (this.sk === null || this.stopping || this.timer !== null) return;
    this.status.running = true;
    void this.announceOnce();
    this.scheduleNext(0);
  }

  private scheduleNext(afterMs: number): void {
    if (this.stopping || this.timer !== null) return;
    const jitter = this.random() * 2 * NODE_ANNOUNCE_HEARTBEAT_JITTER_MS - NODE_ANNOUNCE_HEARTBEAT_JITTER_MS;
    const delay = Math.max(1_000, afterMs + this.options.heartbeatMs + jitter);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.announceOnce().finally(() => {
        if (!this.stopping) this.scheduleNext(0);
      });
    }, delay);
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  /**
   * Graceful shutdown: stop the timer and, if we still have a relay, publish
   * the `offline` tombstone. Best effort with a hard deadline — a shutdown
   * must not hang because a relay is gone.
   */
  async stop(timeoutMs: number = 3_000): Promise<void> {
    this.stopping = true;
    this.status.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.sk === null) return;
    try {
      const tombstone = await this.publishOffline(timeoutMs);
      if (tombstone !== null) {
        this.log(`announce offline ${this.nodeId}: id ${tombstone.event.id.slice(0, 12)}…`);
      }
    } catch (err) {
      this.log(`announce offline failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Publish the offline tombstone (same address, no relays, expired now). */
  async publishOffline(timeoutMs: number = 3_000): Promise<AnnounceOutcome | null> {
    const sk = this.sk;
    if (sk === null) return null;
    const createdAt = this.now();
    const unsigned = buildNodeOfflineUnsigned({
      pubkey: this.pubkey,
      created_at: createdAt,
      software: this.options.software,
    });
    let event: Event;
    try {
      event = await withTimeout(
        signWithPowAsync(
          { kind: unsigned.kind, created_at: unsigned.created_at, tags: unsigned.tags, content: unsigned.content },
          sk,
          this.options.powMin,
          this.pubkey,
        ),
        timeoutMs,
      );
    } catch {
      return null;
    }
    try {
      const results = await withTimeout(this.options.pool.publish(event), timeoutMs);
      const delivered = results.filter((result) => result.ok).length;
      return { event, delivered, targets: results.length, results };
    } catch {
      return { event, delivered: 0, targets: 0, results: [] };
    }
  }
}

/** Reject after `ms`; used so a dead relay cannot hold up a shutdown. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms`)), ms);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
