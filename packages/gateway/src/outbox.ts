/**
 * NIP-65 outbox writer — selecting the write relays for an author (F4AI-10).
 *
 * Procedure: fetch the author's kind 30002 (outbox markers) from the read-relay
 * pool, from the `r` tags pick those with a `w` marker (or `rw`/a repeated
 * marker), normalize the URL. If the author has no 30002 (or no relay knows it),
 * the fallback to the pool's default write relays MUST work — the gateway then
 * publishes also for authors without an outbox.
 *
 * The cache has a TTL and manual invalidation (`invalidate`). A negative result
 * (an author without 30002) is cached as well, so we do not flood the relays; a
 * transient state with no connected relay is deliberately not cached (otherwise a
 * network outage would freeze the fallback for the whole TTL).
 */
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

import { KINDS } from '@forum4ai/shared';

import { normalizeRelayUrl } from './relay-pool.js';

/** Minimálna tvár poolu, ktorú outbox potrebuje — mocknuteľná v unit testoch. */
export interface OutboxPool {
  query(filters: Filter[], opts?: { timeoutMs?: number }): Promise<Event[]>;
  readyRelays(): string[];
}

export type OutboxSource = 'outbox' | 'fallback';

export interface OutboxEntry {
  pubkey: string;
  relays: string[];
  source: OutboxSource;
  /** ms epoch, kedy sme výsledok zistili */
  fetchedAt: number;
  /** či bol výsledok zapísaný do cache (prechodný fallback nie je) */
  cached: boolean;
}

export interface OutboxOptions {
  /** pool defaulty, keď autor nemá 30002 alebo v ňom nie sú `w` markery */
  defaultWriteRelays: string[];
  /** default 15 min */
  ttlMs?: number;
  /** timeout na stiahnutie 30002, default 4 000 ms */
  fetchTimeoutMs?: number;
  /** strop počtu write relayov (author môže uviesť aj 50), default 10 */
  maxWriteRelays?: number;
  /** injectable hodiny pre testy TTL */
  now?: () => number;
}

const HEX_64 = /^[0-9a-f]{64}$/;

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_WRITE_RELAYS = 10;

/** `r` tag markery, ktoré znamenajú "sem sa dá písať" (NIP-65 `w`). */
const WRITE_MARKERS = new Set(['w', 'rw', 'write']);

/** Vyber write-relay URL z 30002 eventu (`r` tag s `w` markerom). */
export function writeRelaysFromOutboxEvent(event: Event): string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'r') continue;
    const url = tag[1];
    const marker = tag[2];
    if (typeof url !== 'string' || typeof marker !== 'string') continue;
    const markers = marker.split(/\s+/).filter((m) => m.length > 0);
    if (!markers.some((m) => WRITE_MARKERS.has(m))) continue;
    const normalized = normalizeRelayUrl(url);
    if (normalized !== null && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export class OutboxWriter {
  private readonly pool: OutboxPool;
  private readonly defaults: string[];
  private readonly ttlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxWriteRelays: number;
  private readonly now: () => number;

  private readonly cache = new Map<string, OutboxEntry>();
  private readonly inflight = new Map<string, Promise<OutboxEntry>>();

  constructor(pool: OutboxPool, options: OutboxOptions) {
    this.pool = pool;
    this.defaults = options.defaultWriteRelays
      .map((url) => normalizeRelayUrl(url))
      .filter((url): url is string => url !== null);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxWriteRelays = options.maxWriteRelays ?? DEFAULT_MAX_WRITE_RELAYS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Write relays pre autora — cache → fetch 30002 → fallback na defaults. */
  async writeRelaysFor(pubkey: string): Promise<string[]> {
    const entry = await this.lookup(pubkey);
    return entry.relays;
  }

  /**
   * Vráti entry s relays + zdrojom ('outbox' × 'fallback'). Concurrent
   * volania na rovnaký pubkey zdieľajú jeden fetch (single-flight).
   */
  async lookup(pubkey: string): Promise<OutboxEntry> {
    const key = typeof pubkey === 'string' ? pubkey.toLowerCase() : '';
    const cached = this.cache.get(key);
    if (cached !== undefined && this.now() - cached.fetchedAt < this.ttlMs) return cached;

    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;

    const promise = this.fetch(key).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Manual invalidácia: jeden pubkey, alebo všetky (bez argumentu). */
  invalidate(pubkey?: string): void {
    if (pubkey === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(pubkey.toLowerCase());
  }

  /** C7: vyhoď entries s expired TTL (volá sa pred každým fetchom). */
  private pruneExpired(): void {
    const now = this.now();
    for (const [pk, entry] of this.cache) {
      if (now - entry.fetchedAt >= this.ttlMs) this.cache.delete(pk);
    }
  }

  /** náhľad do cache (testy / debug) */
  cachedEntries(): OutboxEntry[] {
    return [...this.cache.values()];
  }

  private fallback(source: OutboxSource, cached: boolean): OutboxEntry {
    const entry: OutboxEntry = {
      pubkey: '',
      relays: [...this.defaults],
      source,
      fetchedAt: this.now(),
      cached,
    };
    return entry;
  }

  private async fetch(key: string): Promise<OutboxEntry> {
    // C7: cache rástla bez stropu — pri každom fetch zahoďí entries,
    // ktorým vypršal TTL (inak one-way pamäť s každým novým pubkey)
    this.pruneExpired();
    if (!HEX_64.test(key)) {
      // neplatný pubkey → fallback, ale necachujeme (je to chyba vstupu)
      return this.fallback('fallback', false);
    }

    // bez spojeného read relaya je výsledok nepovedomý — vráť defaulty,
    // ale NECACHUJ (inak by výpadok siete zmrazil fallback na celý TTL)
    if (this.pool.readyRelays().length === 0) {
      return this.fallback('fallback', false);
    }

    let events: Event[];
    try {
      events = await this.pool.query(
        [{ kinds: [KINDS.OUTBOX], authors: [key], limit: 8 }],
        { timeoutMs: this.fetchTimeoutMs },
      );
    } catch {
      return this.fallback('fallback', false);
    }

    // najnovší 30002 od autora (LWW); zhodný created_at → deterministicky
    // NIŽŠIE id (L2: predtým rozhodovalo vyššie id, čo bolo obrátene
    // oproti LWW pravidlu store.ts / db.ts / ideas.ts)
    const candidates = events
      .filter((event) => event.kind === KINDS.OUTBOX && event.pubkey === key)
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));

    const latest = candidates[0];
    const relays = latest !== undefined ? writeRelaysFromOutboxEvent(latest) : [];

    if (relays.length === 0) {
      const entry = this.fallback('fallback', true);
      entry.pubkey = key;
      this.cache.set(key, entry);
      return entry;
    }

    const entry: OutboxEntry = {
      pubkey: key,
      relays: relays.slice(0, this.maxWriteRelays),
      source: 'outbox',
      fetchedAt: this.now(),
      cached: true,
    };
    this.cache.set(key, entry);
    return entry;
  }
}
