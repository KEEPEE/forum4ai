/**
 * The node directory behind `GET /nodes` (F4AI-37, epic F4AI-35).
 *
 * A directory is a *derived view*, not a database: it is rebuilt from signed
 * announcements every refresh, so there is nothing to migrate, nothing to
 * drift and nothing to trust. Three rules keep it useful and cheap:
 *
 *  1. **Freshness is computed, never stored.** A node is listed while its
 *     announcement is inside its TTL, flagged `stale` past half of it, and
 *     dropped when the TTL passes. A node that dies mid-heartbeat disappears
 *     on its own — no cleanup job, no lease to expire.
 *  2. **Everything a peer told us is re-verified here.** Upstream `/nodes`
 *     answers are raw signed events; we check the signature, re-run the
 *     sanitizers and re-apply the `d`-belongs-to-its-pubkey rule locally.
 *     A lying upstream cannot inject a private relay URL or a fake role.
 *  3. **No recursion.** We fan out one hop (`?local=1&raw=1` asks a peer for
 *     what it saw *directly*), merge by address newest-wins, and mark where
 *     each entry came from. A directory is therefore bounded by the mesh we
 *     can see, not by the whole internet.
 *
 * In legacy mode (`fanOut: false`, which is what an instance gets when it
 * sets no new environment variable) the directory only reads the relays this
 * instance is already connected to: no timer, no HTTP, no new connections.
 */
import type { Event, Filter } from 'nostr-tools';

import {
  KINDS,
  NODE_ANNOUNCE_MAX_AGE_S,
  NODE_ANNOUNCE_TTL_MAX_S,
  NODE_ANNOUNCE_TTL_S,
  NODE_ROLE_NAMESPACE,
  deletionRemovesNode,
  nodeFreshness,
  parseNodeAnnounce,
  parseNodeDeletion,
  verifyFull,
  type NodeDeletion,
  type NodeRecord,
  type NodeRole,
  type NostrEvent,
} from '@forum4ai/shared';

import type { PublishResult } from './relay-pool.js';

/** The slice of `RelayPool` the directory reads from. */
export interface DirectoryRelays {
  query(filters: Filter[], opts?: { timeoutMs?: number }): Promise<Event[]>;
  publish?(event: Event, relays?: string[]): Promise<PublishResult[]>;
}

export interface DirectoryUpstream {
  id: string;
  baseUrl: string;
}

export interface NodeDirectoryOptions {
  relays: DirectoryRelays;
  /** configured upstream gateways (evaluated per refresh, so a config reload works) */
  upstreams?: () => readonly DirectoryUpstream[];
  /**
   * Ask upstreams for their raw announcements. `false` = legacy instance:
   * the directory never opens a connection it does not already have.
   */
  fanOut?: boolean;
  /** refresh window in ms (default 60 s — the heartbeat cadence) */
  refreshMs?: number;
  /** relay query timeout (default 3 s) */
  queryTimeoutMs?: number;
  /** upstream HTTP timeout (default 3 s) */
  httpTimeoutMs?: number;
  /** hard cap on one upstream response body (default 256 KiB) */
  maxBytes?: number;
  /** hard cap on events parsed per source (default 200) */
  maxEvents?: number;
  /** hard cap on entries served (default 200) */
  maxNodes?: number;
  /** dev escape hatch: accept `ws://` and private hosts */
  allowPrivateHosts?: boolean;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  logger?: (line: string) => void;
  /** ms epoch */
  now?: () => number;
}

/** One row of `GET /nodes`. Field names are the public contract (F4AI-37). */
export interface NodeEntry {
  node_id: string;
  pubkey: string;
  role: NodeRole;
  relay_urls: string[];
  web_url: string | null;
  topics: string[];
  topic_count: number | null;
  checkpoint: number | null;
  software: string | null;
  /** `created_at` of the newest announcement we accepted (seconds) */
  seen_at: number;
  age_s: number;
  stale: boolean;
  /** upstream ids this node was learned through; `[]` = seen directly */
  via: string[];
  /** true once `web_url`/health confirmed this pubkey (P1, optional) */
  verified: boolean;
}

export interface NodeList {
  generated_at: number;
  ttl: number;
  nodes: NodeEntry[];
  warnings: string[];
}

export interface DirectoryStatus {
  refreshed_at: number;
  nodes: number;
  events: number;
  deletions: number;
  upstreams: number;
  fan_out: boolean;
  last_error: string | null;
  running: boolean;
}

const ADDRESS_PREFIX = `${KINDS.NODE_ANNOUNCE}:`;

interface AddressedRecord extends NodeRecord {
  via: Set<string>;
  event: Event;
  verified: boolean;
}

export class NodeDirectory {
  private readonly options: Required<
    Pick<NodeDirectoryOptions, 'refreshMs' | 'queryTimeoutMs' | 'httpTimeoutMs' | 'maxBytes' | 'maxEvents' | 'maxNodes'>
  > &
    NodeDirectoryOptions;
  private records = new Map<string, AddressedRecord>();
  private deletions = new Map<string, NodeDeletion>();
  private events: Event[] = [];
  private refreshedAt = 0;
  private lastError: string | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGood: NodeList | null = null;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(options: NodeDirectoryOptions) {
    this.options = {
      ...options,
      refreshMs: options.refreshMs ?? 60_000,
      queryTimeoutMs: options.queryTimeoutMs ?? 3_000,
      httpTimeoutMs: options.httpTimeoutMs ?? 3_000,
      maxBytes: options.maxBytes ?? 256 * 1024,
      maxEvents: options.maxEvents ?? 200,
      maxNodes: options.maxNodes ?? 200,
    };
    this.log = options.logger ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
  }

  get fanOut(): boolean {
    return this.options.fanOut === true;
  }

  status(): DirectoryStatus {
    return {
      refreshed_at: this.refreshedAt,
      nodes: this.records.size,
      events: this.events.length,
      deletions: this.deletions.size,
      upstreams: this.fanOut ? (this.options.upstreams?.() ?? []).length : 0,
      fan_out: this.fanOut,
      last_error: this.lastError,
      running: this.timer !== null,
    };
  }

  /** Start the background refresh. Only called when there is something to fan out to. */
  start(): void {
    if (this.timer !== null) return;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.options.refreshMs);
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Refresh unless the cache is younger than `refreshMs`. Concurrent callers
   * share one refresh (a page load must not fan out twenty times).
   */
  async ensureFresh(): Promise<void> {
    const ageMs = this.now() - this.refreshedAt;
    if (this.refreshedAt !== 0 && ageMs < this.options.refreshMs) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.doRefresh();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async doRefresh(): Promise<void> {
    const warnings: string[] = [];
    const records = new Map<string, AddressedRecord>();
    const deletions = new Map<string, NodeDeletion>();
    const accepted: Event[] = [];

    const ingest = (event: Event, via: string[]): void => {
      if (event.kind === KINDS.NODE_ANNOUNCE) {
        const parsed = parseNodeAnnounce(asShared(event), {
          allowPrivateHosts: this.options.allowPrivateHosts,
          now: Math.floor(this.now() / 1000),
        });
        if (parsed.node === null) {
          warnings.push(`dropped ${event.id.slice(0, 12)}…: ${parsed.reason ?? 'invalid'}`);
          return;
        }
        const address = `${ADDRESS_PREFIX}${parsed.node.pubkey}:${parsed.node.node_id}`;
        const existing = records.get(address);
        // LWW per address; a tie keeps the entry we saw directly
        if (existing !== undefined && (existing.created_at > parsed.node.created_at || (existing.created_at === parsed.node.created_at && existing.via.size === 0))) {
          for (const source of via) existing.via.add(source);
          return;
        }
        records.set(address, {
          ...parsed.node,
          via: new Set(via),
          event,
          verified: false,
        });
        accepted.push(event);
        return;
      }
      if (event.kind === 5) {
        const deletion = parseNodeDeletion(asShared(event));
        if (deletion === null) return;
        // P1 (dizajn review): slot per address patrí deletionu, ktorý ho
        // SKUTOČNE môže spôsobiť. Kind 5 môže menovať ľubovoľnú adresu, takže
        // cudzí deletion by vytláčal ownerov (LWW per address) a node by ostal
        // v adresári navždy. Cudzie deletiony preto vôbec neingestujeme.
        // Pozor: filtrujeme ADRESY podľa vlastníka — nesmíme ich mapovať na
        // vlastníkov, lebo `deletionRemovesNode` porovnáva adresu.
        const named = deletion.addresses.filter((address) => {
          const owner = address.split(':')[1] ?? '';
          return owner !== '' && owner === deletion.pubkey;
        });
        if (named.length === 0) return;
        deletion.addresses = named;
        for (const address of deletion.addresses) {
          const owner = address.split(':')[1] ?? '';
          const seen = deletions.get(address);
          // One slot per address: the newest deletion wins, and on a tie the
          // one signed by the owner of the address — a stranger naming the
          // same address must not crowd out the node's own deletion.
          if (
            seen === undefined ||
            seen.created_at < deletion.created_at ||
            (seen.created_at === deletion.created_at && seen.pubkey !== owner && deletion.pubkey === owner)
          ) {
            deletions.set(address, deletion);
          }
        }
      }
    };

    // 1. our own relays — the relays this instance is already connected to
    // P1 (dizajn review): obe dopyty musia byť VIAZANÉ. Bez `since` by na
    // rušnom relayi stačilo 200 čerstvých cudzích eventov a adresár by nevidel
    // žiadny announcement; bez `#L` by sme stiahli aj to, čo namespace role
    // nemá. Deletiony pýtame s `#k` (NIP-09 odporúča `k` = kind mazaného eventu)
    // a okrem toho aj čerstvé nemarkované — istota, nie hádanka.
    const nowS = Math.floor(this.now() / 1000);
    const filters: Filter[] = [
      {
        kinds: [KINDS.NODE_ANNOUNCE],
        since: nowS - NODE_ANNOUNCE_MAX_AGE_S,
        '#L': [NODE_ROLE_NAMESPACE],
        limit: this.options.maxEvents,
      },
      { kinds: [5], '#k': [String(KINDS.NODE_ANNOUNCE)], limit: this.options.maxEvents },
      { kinds: [5], since: nowS - (NODE_ANNOUNCE_MAX_AGE_S + NODE_ANNOUNCE_TTL_MAX_S), limit: this.options.maxEvents },
    ];
    try {
      const events = await this.options.relays.query(filters, { timeoutMs: this.options.queryTimeoutMs });
      for (const event of events.slice(0, this.options.maxEvents * 2)) {
        if (!verifySignature(event)) {
          warnings.push(`dropped ${event.id.slice(0, 12)}…: bad signature`);
          continue;
        }
        ingest(event, []);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      warnings.push(`relay query failed: ${this.lastError}`);
    }

    // 2. one hop through each upstream (never recursively)
    if (this.fanOut) {
      const upstreams = this.options.upstreams?.() ?? [];
      // P1 (dizajn review): PARALELNE. Serialne by jedno verejné čítanie
      // čakalo N × httpTimeoutMs (6 s na upstream), čo je presne tvar
      // fronty, ktorú chce útočník spôsobiť.
      const fetched = await Promise.all(
        upstreams.map(async (upstream) => ({ upstream, events: await this.fetchUpstream(upstream) })),
      );
      for (const { upstream, events } of fetched) {
        for (const event of events) {
          if (!verifySignature(event)) {
            warnings.push(`dropped ${event.id.slice(0, 12)}… from ${upstream.id}: bad signature`);
            continue;
          }
          ingest(event, [upstream.id]);
        }
      }
    }

    // 3. NIP-09 deletions: only the node's own key may delete its address.
    // The address embeds the pubkey, but a kind 5 can *name* any address, so
    // the signer has to match too — otherwise one client could clear the
    // directory by guessing addresses.
    for (const [address, record] of [...records]) {
      const deletion = deletions.get(address);
      if (
        deletion !== undefined &&
        deletion.created_at >= record.created_at &&
        deletionRemovesNode(deletion, record)
      ) {
        records.delete(address);
        continue;
      }
    }

    this.records = records;
    this.deletions = deletions;
    this.events = accepted;
    this.refreshedAt = this.now();
    this.lastGood = null;
    if (warnings.length > 0) this.log(`nodes: ${warnings.slice(0, 5).join('; ')}${warnings.length > 5 ? ` (+${String(warnings.length - 5)} more)` : ''}`);
  }

  private async fetchUpstream(upstream: DirectoryUpstream): Promise<Event[]> {
    const fetchImpl = this.options.fetchImpl ?? ((url, init) => fetch(url, init));
    const url = `${upstream.baseUrl.replace(/\/$/, '')}/nodes?local=1&raw=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.httpTimeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    try {
      // A real `fetch` rejects when the signal aborts, but a peer behind a
      // proxy can accept the request and then never send a body — so the
      // timeout has to race the whole exchange, not only the connect.
      const response = await withTimeout(
        fetchImpl(url, { signal: controller.signal }),
        this.options.httpTimeoutMs,
        `${upstream.id}: fetch`,
      );
      if (!response.ok) {
        this.lastError = `${upstream.id}: HTTP ${String(response.status)}`;
        return [];
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > this.options.maxBytes) {
        // P1 (dizajn review): strop MUSÍ byť aj pred čítaním — inak si
        // jeden bláznivý upstream vyžiada 50 MB do našej heapu, kým zistíme,
        // že je nad limit. (`text.length` počíta znaky, nie bajty — to je
        // druhá, miernejšia diera; preto aj Buffer.byteLength.)
        this.lastError = `${upstream.id}: content-length ${String(declared)} over the ${String(this.options.maxBytes)} B cap`;
        return [];
      }
      const text = await withTimeout(response.text(), this.options.httpTimeoutMs, `${upstream.id}: body`);
      if (Buffer.byteLength(text, 'utf8') > this.options.maxBytes) {
        this.lastError = `${upstream.id}: body ${String(text.length)} B over the ${String(this.options.maxBytes)} B cap`;
        return [];
      }
      const parsed = JSON.parse(text) as { events?: unknown };
      const events = Array.isArray(parsed.events) ? (parsed.events as Event[]) : [];
      // P1 (dizajn review): odpoveď peeru je ÚPLNE cudzí JSON. `verifySignature`
      // a `ingest()` počítajú s tým, že `id`/`sig`/`pubkey` sú reťazce a `tags`
      // pole — jeden `{"id":1}` by hodil výnimku, `refreshedAt` by sa neposunul
      // a KAŽDÉ verejné `GET /nodes` by spustilo nový fan-out (500 + dav
      // odchozích spojení). Tvár overíme tu, na hranici, nie vnútri.
      return events
        .filter(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            (event.kind === KINDS.NODE_ANNOUNCE || event.kind === 5) &&
            typeof event.id === 'string' &&
            /^[0-9a-f]{64}$/i.test(event.id) &&
            typeof event.pubkey === 'string' &&
            /^[0-9a-f]{64}$/i.test(event.pubkey) &&
            typeof event.sig === 'string' &&
            /^[0-9a-f]{128}$/i.test(event.sig) &&
            typeof event.created_at === 'number' &&
            Number.isFinite(event.created_at) &&
            Array.isArray(event.tags),
        )
        .slice(0, this.options.maxEvents);
    } catch (err) {
      this.lastError = `${upstream.id}: ${err instanceof Error ? err.message : String(err)}`;
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The directory view. Entries are sorted by freshness (newest first),
   * filtered by role on request, and capped so one response stays small
   * enough to fetch from a constrained client.
   */
  async list(opts?: { role?: string | null; limit?: number }): Promise<NodeList> {
    await this.ensureFresh();
    const nowS = Math.floor(this.now() / 1000);
    const roleFilter = opts?.role ?? null;
    const limit = Math.min(Math.max(1, opts?.limit ?? this.options.maxNodes), this.options.maxNodes);

    const entries: NodeEntry[] = [];
    for (const record of this.records.values()) {
      const freshness = nodeFreshness(record, nowS);
      if (nowS - record.created_at > NODE_ANNOUNCE_MAX_AGE_S || freshness.expired) continue;
      if (record.offline) continue;
      if (roleFilter !== null && record.role !== roleFilter) continue;
      entries.push({
        node_id: record.node_id,
        pubkey: record.pubkey,
        role: record.role as NodeRole,
        relay_urls: record.relay_urls,
        web_url: record.web_url,
        topics: record.topics,
        topic_count: record.topic_count,
        checkpoint: record.checkpoint,
        software: record.software,
        seen_at: record.created_at,
        age_s: freshness.age_s,
        stale: freshness.stale,
        via: [...record.via],
        verified: record.verified,
      });
    }
    entries.sort((a, b) => b.seen_at - a.seen_at || a.pubkey.localeCompare(b.pubkey));
    const nodes = entries.slice(0, limit);
    const result: NodeList = {
      generated_at: nowS,
      ttl: NODE_ANNOUNCE_TTL_S,
      nodes,
      warnings: [],
    };
    this.lastGood = result;
    return result;
  }

  /**
   * Raw announcements for a peer (`?raw=1`). `localOnly` restricts the answer
   * to what this instance saw on its own relays — that is exactly what keeps
   * the fan-out one hop deep: a peer never receives nodes we only heard
   * about, so it does not forward them on either.
   */
  rawEvents(opts?: { localOnly?: boolean }): Event[] {
    const out: Event[] = [];
    for (const record of this.records.values()) {
      if (record.offline) continue;
      if (opts?.localOnly === true && record.via.size > 0) continue;
      out.push(record.event);
    }
    return out;
  }

  /** Last good snapshot, used while a refresh is failing (up to one TTL). */
  lastSnapshot(): NodeList | null {
    return this.lastGood;
  }
}

/**
 * Signature check on a stranger's event. `verifyFull` recomputes the NIP-01
 * id, so a peer cannot forward us an event whose payload was edited in flight.
 */
function verifySignature(event: Event): boolean {
  try {
    return verifyFull(asShared(event));
  } catch {
    return false;
  }
}

/** Reject after `ms` so one slow peer cannot stall a refresh indefinitely. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(ms)}ms`)), ms);
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

/**
 * nostr-tools `Event` and our `NostrEvent` carry the same seven fields; the
 * tag tuple type differs, so the cast is structural and total.
 */
function asShared(event: Event): NostrEvent {
  return event as unknown as NostrEvent;
}
