/**
 * Short-TTL response cache for the heavy read routes (A4 from the security
 * review, P0).
 *
 * Why: `GET /topics` fetches 2 × 20 windows × 500 events and verifies each one
 * with a Schnorr signature; `GET /reputation/:pubkey` replays up to
 * 200 000 SQLite rows. Both are synchronous work on the event loop, so every
 * further client destroys the WS connections and the writes. The first query
 * pays for the scan, the rest of the window (5–10 s) only hits the cache — for
 * a forum with dozens of clients that is the difference between "works" and
 * "falls over".
 *
 * Design:
 *  - the cache is **per-process in-memory** with an LRU cap and a 5 s TTL
 *    (`GATEWAY_READ_CACHE_MS`, `0` = disabled — a dev instance may
 *    want a fresh view every time),
 *  - key = `pathname?search` (path + query), so `?limit=` and
 *    `/topics/:slug` have their own entries,
 *  - we store only `200` + `application/json` and bodies up to 512 KB,
 *  - cached responses carry `X-Cache: HIT` and `Age` — neither the UI nor the
 *    tests need to change behaviour, they only see where the data came from,
 *  - CORS headers do not get lost: the middleware returns the response through
 *    `c.body()`, which rewrites the headers from `c.res` (cors() sets them
 *    before `next()` — the same mechanism the 429 in `rate-limit.ts` relies on).
 */
import type { MiddlewareHandler } from 'hono';

/** default TTL čítacej cache (ms); `0` = vypnuté */
export const READ_CACHE_TTL_DEFAULT_MS = 5_000;
/** LRU strop počtu položiek (každá je JSON reťazec, desiatky KB) */
export const READ_CACHE_MAX_ENTRIES_DEFAULT = 100;
/** strop veľkosti telá, ktoré sa oplatí držať v pamäti */
export const READ_CACHE_MAX_BODY_BYTES = 512_000;

/**
 * Cesty, ktoré sa oplatí cache-ovať (A4): domovský strom topicov,
 * detail topicu a reputácia. `/threads/:id` zámernne NIE — ten má
 * neobmedzenú kľúčovú kartografiu (id) a jeho odpovede sa menia s každou
 * odpoveďou, ktorú UI aj tak chce vidieť ihneď.
 */
export function isCacheableReadPath(pathname: string): boolean {
  return (
    pathname === '/topics' ||
    pathname.startsWith('/topics/') ||
    pathname.startsWith('/reputation/') ||
    // F4AI-37: adresár uzlov je drahý (REQ nad relaymi) a mení sa raz za
    // heartbeat, takže krátky TTL je čisté víťazstvo. Sám adresár si drží
    // 60 s cache, toto je len ochrana pred davom na jednom procese.
    pathname === '/nodes'
  );
}

export interface ResponseCacheEntry {
  status: number;
  contentType: string;
  body: string;
  /** ms epoch, kedy položka prestane platit */
  expiresAt: number;
  /** ms epoch vytvorenia (pre `Age`) */
  storedAt: number;
}

export interface ResponseCache {
  get(key: string): ResponseCacheEntry | undefined;
  set(key: string, entry: ResponseCacheEntry): void;
  get size(): number;
  clear(): void;
}

/**
 * LRU + TTL cache. `Map` si pamätá poradie vkladania, preto presunutie
 * kľúča na koniec pri každom trepe znamená, že evikcia siahne na
 * najmenej nedávno používanú položku.
 */
export class TtlLruCache implements ResponseCache {
  private readonly entries = new Map<string, ResponseCacheEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(maxEntries: number = READ_CACHE_MAX_ENTRIES_DEFAULT, now?: () => number) {
    this.maxEntries = maxEntries > 0 ? maxEntries : READ_CACHE_MAX_ENTRIES_DEFAULT;
    this.now = now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): ResponseCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU trep
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: ResponseCacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface ResponseCacheOptions {
  /** TTL v ms; `0` alebo menej = middleware je passthrough (vypnuté) */
  ttlMs: number;
  /** LRU strop položiek, default `READ_CACHE_MAX_ENTRIES_DEFAULT` */
  maxEntries?: number;
  /** strop telá, default `READ_CACHE_MAX_BODY_BYTES` */
  maxBodyBytes?: number;
  /** výber ciest, default `isCacheableReadPath` */
  shouldCache?: (pathname: string) => boolean;
  /** injectable hodiny (testy) */
  now?: () => number;
  /** cache objekt — testy/injekcia; default vlastná `TtlLruCache` */
  cache?: ResponseCache;
}

/**
 * Middleware: GET na vybraných cestách obslúži z cache a miss uloží.
 * Vypnuté (`ttlMs <= 0`) je priepustka bez akejkoľvek práce.
 */
export function responseCache(options: ResponseCacheOptions): MiddlewareHandler {
  const ttlMs = options.ttlMs;
  if (!(ttlMs > 0)) return async (_c, next) => void (await next());

  const now = options.now ?? (() => Date.now());
  const shouldCache = options.shouldCache ?? isCacheableReadPath;
  const maxBodyBytes = options.maxBodyBytes ?? READ_CACHE_MAX_BODY_BYTES;
  const cache = options.cache ?? new TtlLruCache(options.maxEntries, now);

  return async (c, next) => {
    if (c.req.method !== 'GET') return await next();

    const url = new URL(c.req.url);
    if (!shouldCache(url.pathname)) return await next();

    const key = `${url.pathname}?${url.search}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      const ageSeconds = Math.max(0, Math.round((now() - hit.storedAt) / 1000));
      return c.body(hit.body, hit.status as 200, {
        'Content-Type': hit.contentType,
        'X-Cache': 'HIT',
        Age: String(ageSeconds),
      });
    }

    await next();

    const res = c.res;
    if (res.status !== 200) return;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return;

    // clone: originál musí ostať čitateľný pre node-server, ktorý
    // odpoveď práve odosiela klientovi
    let text: string;
    try {
      text = await res.clone().text();
    } catch {
      return; // stream už nie je k dispozícii (iný middleware ho spotreboval)
    }
    if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) return;

    const storedAt = now();
    cache.set(key, {
      status: res.status,
      contentType,
      body: text,
      storedAt,
      expiresAt: storedAt + ttlMs,
    });
    c.header('X-Cache', 'MISS');
  };
}
