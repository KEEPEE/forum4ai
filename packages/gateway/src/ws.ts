/**
 * WebSocket /ws (S5, F4AI-11) — a NIP-01 style protocol over the pool:
 *
 *   client → server   ["REQ", <sub_id>, <filter>, …]  |  ["CLOSE", <sub_id>]
 *   server → client   ["EVENT", <sub_id>, <event>]    |  ["EOSE", <sub_id>]
 *                     ["NOTICE", <text>]              (anytime, unbound)
 *
 * There are two transport layers, both aware of the limits:
 *  - `parseClientMessage` + `WsSession` — a pure protocol layer without the
 *    network (testable with a mock pool),
 *  - `attachWebSocket` — the hookup to Hono: a `ws` `WebSocketServer`
 *    ({ noServer: true, maxPayload }) + `upgradeWebSocket` from
 *    `@hono/node-server` 2.x; `serve()` gets `{ websocket: { server } }`
 *    and the upgrade of the `/ws` path is driven by the hono route (the
 *    cleanest way with hono 4.13).
 *
 * Limits per connection: max 5 active subscriptions (the 6th REQ → NOTICE and
 * it is ignored), message size 64 kB (above → `ws` closes the connection with
 * code 1009). `sub_id` must be a non-empty string of at most 64 characters; a
 * duplicate sub_id → NOTICE and the REQ is ignored (the client should send
 * CLOSE first).
 */
import { WebSocketServer } from 'ws';
import { upgradeWebSocket } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

import { clientRateLimitKey } from './rate-limit.js';
import type { Cidr } from './rate-limit.js';

export const WS_MAX_SUBSCRIPTIONS = 5;
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
export const WS_MAX_SUB_ID_LENGTH = 64;
/** C3: strop `limit`u jedného filtra (relay max_limit) — bez neho `limit: 1e9` */
export const WS_MAX_FILTER_LIMIT = 500;
/** C3: max filtrov v jednom REQ */
export const WS_MAX_FILTERS = 8;
/**
 * A3 (P0): max OTVORENÝCH WS spojení na jednu IP. Dôvod: gateway drží na
 * každý relay JEDNO zdieľané spojenie a každý REQ klienta sa prenesie na
 * relaye (relay max_subscriptions 16/500). Bez stropu na IP stačia 4
 * spájané klienti × 5 REQ a rozpočet subsidií je preč — `/topics` potom
 * vráti PRÁZDNE dáta, ktoré vyzerajú platne.
 */
export const WS_MAX_CONNECTIONS_PER_IP_DEFAULT = 4;
/** LRU strop počtu IP kľúčov (predídene rastu mapy pri rotujúcom IPv6) */
const WS_IP_KEYS_MAX = 10_000;

/**
 * A3 (P0): rozpočet otvorených WS spojení — globálny (C3) a per-IP (A3).
 * Vyčlenené ako samostatná trieda, lebo `attachWebSocket` potrebuje
 * skutočný WS server (test by musel otvárať sokety), kým rozpočet je
 * čistá logika testovateľná bez siete.
 *
 * `Map` drží poradie vkladania → kľúč sa pri trepe presunie na koniec a
 * evikcia nad `maxKeys` siahne na najstaršiu IP (inak by mapa rástla s
 * každou IPv6 adresou, ktorú server kedy videl).
 */
export class ConnectionBudget {
  private readonly perIp = new Map<string, number>();
  private totalConnections = 0;
  private readonly maxPerIp: number;
  private readonly maxTotal: number;
  private readonly maxKeys: number;

  constructor(options: { maxPerIp?: number; maxTotal?: number; maxKeys?: number } = {}) {
    this.maxPerIp = options.maxPerIp ?? WS_MAX_CONNECTIONS_PER_IP_DEFAULT;
    this.maxTotal = options.maxTotal ?? 0;
    this.maxKeys = options.maxKeys ?? WS_IP_KEYS_MAX;
  }

  /** koľko spojení práve drží táto IP (0 = žiadne) */
  countFor(ip: string): number {
    return this.perIp.get(ip) ?? 0;
  }

  get total(): number {
    return this.totalConnections;
  }

  /**
   * Pokús sa otvoriť spojenie pre `ip`. Pri zamietnutí NIČ nezvýši
   * (volajúci nemusí uvoľňovať to, čo nedostal).
   */
  acquire(ip: string): { ok: true } | { ok: false; reason: string } {
    if (this.maxTotal > 0 && this.totalConnections >= this.maxTotal) {
      return { ok: false, reason: `max_connections ${String(this.maxTotal)} reached` };
    }
    if (this.maxPerIp > 0) {
      const live = this.countFor(ip);
      if (live >= this.maxPerIp) {
        return {
          ok: false,
          reason: `max_connections_per_ip ${String(this.maxPerIp)} reached (${ip})`,
        };
      }
      this.perIp.delete(ip);
      this.perIp.set(ip, live + 1);
      if (this.perIp.size > this.maxKeys) {
        const oldest = this.perIp.keys().next();
        if (!oldest.done) this.perIp.delete(oldest.value);
      }
    }
    this.totalConnections += 1;
    return { ok: true };
  }

  /** Uvoľni spojenie, ktoré `acquire` povolil. Idempotentné zhora nadol. */
  release(ip: string): void {
    this.totalConnections = Math.max(0, this.totalConnections - 1);
    if (this.maxPerIp <= 0) return;
    const live = this.countFor(ip);
    this.perIp.delete(ip);
    if (live > 1) this.perIp.set(ip, live - 1);
  }
}

/** správa, ktorú server posiela klientovi */
export type WsServerMessage =
  | ['EVENT', string, Event]
  | ['EOSE', string]
  | ['NOTICE', string];

export type ParsedClientMessage =
  | { type: 'req'; subId: string; filters: Filter[] }
  | { type: 'close'; subId: string }
  | { type: 'invalid'; reason: string };

// ── validácia filterov ────────────────────────────────────────────────────

const FILTER_TOP_KEYS = new Set(['ids', 'kinds', 'authors', 'since', 'until', 'limit']);
const TAG_QUERY_RE = /^#[a-z]$/;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Jemná štrukturálna validácia NIP-01 filtra (relay rovnako odmietne
 * nezmysly; tu len chránime pool pred rozbitými REQ). Vráti reťazec s
 * dôvodom, alebo null ak je filter v poriadku.
 */
export function validateFilter(
  filter: unknown,
  label: string,
): string | null {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    return `${label}: filter must be a JSON object`;
  }
  const record = filter as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (FILTER_TOP_KEYS.has(key)) {
      if (key === 'ids' || key === 'authors') {
        if (!isStringArray(value)) return `${label}: ${key} must be an array of strings`;
      } else if (key === 'kinds') {
        if (!Array.isArray(value) || !value.every((v) => Number.isInteger(v))) {
          return `${label}: kinds must be an array of integers`;
        }
      } else if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${label}: ${key} must be a number`;
      }
    } else if (TAG_QUERY_RE.test(key) || key === '#tag') {
      if (!isStringArray(value)) return `${label}: ${key} must be an array of strings`;
    } else {
      return `${label}: unknown filter key '${key}'`;
    }
  }
  return null;
}

// ── parser správ ──────────────────────────────────────────────────────────

export function parseClientMessage(
  raw: string,
  limits?: { maxFilters?: number },
): ParsedClientMessage {
  const maxFilters = limits?.maxFilters ?? WS_MAX_FILTERS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { type: 'invalid', reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || typeof parsed[0] !== 'string') {
    return { type: 'invalid', reason: 'message must be an array ["REQ", sub_id, filter…] or ["CLOSE", sub_id]' };
  }
  const verb = parsed[0];
  const subId = parsed[1];
  if (typeof subId !== 'string' || subId.length === 0 || subId.length > WS_MAX_SUB_ID_LENGTH) {
    return { type: 'invalid', reason: `sub_id must be a string of 1..${String(WS_MAX_SUB_ID_LENGTH)} characters` };
  }

  if (verb === 'CLOSE') {
    return { type: 'close', subId };
  }
  if (verb !== 'REQ') {
    return { type: 'invalid', reason: `unexpected verb '${verb}' (expected REQ/CLOSE)` };
  }
  const rest = parsed.slice(2);
  if (rest.length === 0) {
    return { type: 'invalid', reason: 'REQ requires at least one filter' };
  }
  // C3: viac filtrov v jednom REQ = nasobny scan na relayi — viažeme
  if (rest.length > maxFilters) {
    return {
      type: 'invalid',
      reason: `REQ contains ${String(rest.length)} filters, the maximum is ${String(maxFilters)}`,
    };
  }
  const filters: Filter[] = [];
  for (const [index, candidate] of rest.entries()) {
    const error = validateFilter(candidate, `filter[${String(index)}]`);
    if (error !== null) return { type: 'invalid', reason: error };
    filters.push(candidate as Filter);
  }
  return { type: 'req', subId, filters };
}

// ── session ───────────────────────────────────────────────────────────────

/** TVár poolu, ktorú WS potrebuje — `RelayPool.subscribe(..., { onEose })`. */
export interface WsPool {
  subscribe(
    filters: Filter[],
    callback: (event: Event, relayUrl: string) => void,
    opts?: { onEose?: () => void },
  ): () => void;
}

export interface WsSessionLimits {
  maxSubscriptions: number;
  /** C3: max filtrov per REQ (parse stage) */
  maxFilters?: number;
  /** C3: strop `limit`u jedného filtra; 0/undefined = WS_MAX_FILTER_LIMIT */
  maxFilterLimit?: number;
}

/**
 * Protokolová vrstva jedného WS spojenia. `send` je injectnutý dopravný
 * kanál; `pool` je injectnutý — unit testy majú mock pool bez siete.
 */
export class WsSession {
  private readonly subs = new Map<string, () => void>();
  private closed = false;

  constructor(
    private readonly send: (message: WsServerMessage) => void,
    private readonly pool: WsPool,
    private readonly limits: WsSessionLimits = { maxSubscriptions: WS_MAX_SUBSCRIPTIONS },
  ) {}

  get subscriptionCount(): number {
    return this.subs.size;
  }

  handleMessage(raw: string): void {
    if (this.closed) return;
    const message = parseClientMessage(raw, { maxFilters: this.limits.maxFilters });

    if (message.type === 'invalid') {
      this.send(['NOTICE', message.reason]);
      return;
    }
    if (message.type === 'close') {
      const unsubscribe = this.subs.get(message.subId);
      if (unsubscribe !== undefined) {
        this.subs.delete(message.subId);
        unsubscribe();
      }
      // neznamy sub_id: CLOSE je idempotentný, žiadna odpoveď
      return;
    }

    const { subId, filters } = message;
    if (this.subs.has(subId)) {
      this.send(['NOTICE', `sub_id '${subId}' already exists — send CLOSE before a new REQ`]);
      return;
    }
    if (this.subs.size >= this.limits.maxSubscriptions) {
      this.send(['NOTICE', `subscription limit ${String(this.limits.maxSubscriptions)} reached`]);
      return;
    }

    // C3 + A3 (P0): `limit` filtra sa crpi na relay max_limit a pri CHÝBAJÚCEM
    // `limit`e sa nastaví explicitne. Dôvod: relaye (strfry `maxFilterLimit`
    // 500) ticho orežú filter bez `limit`u na svoj strop, takže match-all
    // filter `{}` vráti neuplný pohľad, ktorý vyzerá ako úplný. Explicitný
    // limit aspoň povie, koľko eventov sme skutočne chceli.
    const maxFilterLimit = this.limits.maxFilterLimit ?? WS_MAX_FILTER_LIMIT;
    const clamped = filters.map((filter) => {
      const requested = filter.limit;
      const limit =
        typeof requested === 'number' && requested > 0 && requested <= maxFilterLimit
          ? requested
          : maxFilterLimit;
      return requested === limit ? filter : { ...filter, limit };
    });

    // sub zaregistrujeme PRED `pool.subscribe()` — pool vie emitoval EOSE
    // synchronne (napr. žiadny pripojený relay) a inak by sme o správu prišli
    const holder: { unsubscribe: (() => void) | null } = { unsubscribe: null };
    this.subs.set(subId, () => {
      holder.unsubscribe?.();
    });
    holder.unsubscribe = this.pool.subscribe(
      clamped,
      (event) => {
        if (this.subs.has(subId)) this.send(['EVENT', subId, event]);
      },
      {
        onEose: () => {
          if (this.subs.has(subId)) this.send(['EOSE', subId]);
        },
      },
    );
    // session sa mohol zatvoriť v synchronnom callback — doručníme unsubscribe
    if (this.closed) {
      const unsub = this.subs.get(subId);
      if (unsub !== undefined) {
        this.subs.delete(subId);
        unsub();
      }
    }
  }

  /** zavrie všetky subs (disconnect spojenia) */
  closeAll(): void {
    this.closed = true;
    for (const [, unsubscribe] of this.subs) {
      try {
        unsubscribe();
      } catch {
        /* už zavreté */
      }
    }
    this.subs.clear();
  }
}

// ── Hono wiring ───────────────────────────────────────────────────────────

export interface WebSocketSetup {
  /** `ws` server pre `serve({ websocket: { server } })` (noServer: true) */
  server: WebSocketServer;
}

/**
 * Zaregistruje `GET /ws` upgrade route a vráti `ws` `WebSocketServer`
 * ({ noServer: true }), ktorý `startGatewayServer` predá `serve()` —
 * adapter `@hono/node-server` 2.x potom sparuje HTTP upgrade s route.
 */
export function attachWebSocket(
  app: Hono,
  pool: WsPool,
  options?: {
    maxSubscriptions?: number;
    maxPayloadBytes?: number;
    /** C3: max otvorených WS spojení (0 = neobmedzene) */
    maxConnections?: number;
    /** A3 (P0): max otvorených WS spojení na IP (0 = neobmedzene) */
    maxConnectionsPerIp?: number;
    /** C3: max filtrov per REQ */
    maxFilters?: number;
    /** C3: strop limitu jedného filtra */
    maxFilterLimit?: number;
    /** A3/A6 (P0): zdroj IP — XFF len za dôveryhodnou proxy / CIDR */
    trustProxyHeader?: boolean;
    trustedProxies?: readonly Cidr[];
  },
): WebSocketSetup {
  const maxSubscriptions = options?.maxSubscriptions ?? WS_MAX_SUBSCRIPTIONS;
  const maxPayloadBytes = options?.maxPayloadBytes ?? WS_MAX_PAYLOAD_BYTES;
  const maxConnections = options?.maxConnections ?? 0;
  const maxConnectionsPerIp = options?.maxConnectionsPerIp ?? WS_MAX_CONNECTIONS_PER_IP_DEFAULT;
  const maxFilters = options?.maxFilters ?? WS_MAX_FILTERS;
  const maxFilterLimit = options?.maxFilterLimit ?? WS_MAX_FILTER_LIMIT;
  const trustProxyHeader = options?.trustProxyHeader === true;
  const trustedProxies = options?.trustedProxies ?? [];

  const server = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });

  // C3 + A3 (P0): rozpočet otvorených spojení (globálny a per-IP). Bez
  // stropu každé nové spojenie zdražuje pool (subscribe fan-out) aj pamäť
  // a 4 klienti × 5 REQ vyčerpajú subs rozpočet zdieľaného relay spojenia.
  const budget = new ConnectionBudget({
    maxPerIp: maxConnectionsPerIp,
    maxTotal: maxConnections,
  });

  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      let session: WsSession | null = null;
      // spojenie sa smie uvoľniť len ak bolo skutočne započítané
      let counted = false;
      // A3 (P0): IP klienta — rovnaká logika ako rate-limit (XFF len pri
      // dôvere, a len ak socket prišiel z nastaveného CIDR; IPv6 kľúčované /64)
      const ipKey = clientRateLimitKey(c, trustProxyHeader, trustedProxies);
      const release = (): void => {
        session?.closeAll();
        session = null;
        if (counted) {
          budget.release(ipKey);
          counted = false;
        }
      };
      return {
        onOpen: (_event, ws) => {
          const permit = budget.acquire(ipKey);
          if (!permit.ok) {
            if (ws.readyState === 1) ws.send(JSON.stringify(['NOTICE', permit.reason]));
            try {
              ws.close(1013, permit.reason.slice(0, 120));
            } catch {
              /* už zavreté */
            }
            return;
          }
          counted = true;
          session = new WsSession(
            (message) => {
              if (ws.readyState === 1) ws.send(JSON.stringify(message));
            },
            pool,
            { maxSubscriptions, maxFilters, maxFilterLimit },
          );
        },
        onMessage: (event) => {
          if (session === null) return;
          const data: unknown = event.data;
          let text: string;
          if (typeof data === 'string') text = data;
          else if (data instanceof Uint8Array) text = Buffer.from(data).toString('utf8');
          else if (data instanceof ArrayBuffer) text = Buffer.from(new Uint8Array(data)).toString('utf8');
          else return; // Blob a i. — ws ich neprodukuje; ticho preskočíme
          session.handleMessage(text);
        },
        onClose: release,
        onError: release,
      };
    }),
  );

  return { server };
}
