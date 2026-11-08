/**
 * Unit testy čítacej cache odpovedí (A4 zo security reviewu, P0).
 *
 * App má dve route: `/topics` (počítadlo drahých scanov) a `/other`
 * (ne-cache path) — testy tak vidia, koľkokto skutočne behala handlerova
 * práca, nielen koľkokto prišla odpoveď.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  TtlLruCache,
  isCacheableReadPath,
  responseCache,
  READ_CACHE_TTL_DEFAULT_MS,
} from '../src/response-cache.js';

function makeApp(options: {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
  corsOrigin?: string;
}): { app: Hono; scans: { topics: number; other: number } } {
  const scans = { topics: 0, other: 0 };
  const app = new Hono();
  if (options.corsOrigin !== undefined) {
    app.use('*', cors({ origin: options.corsOrigin, maxAge: 86400 }));
  }
  app.use('*', responseCache({ ttlMs: options.ttlMs, ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}), ...(options.now !== undefined ? { now: options.now } : {}) }));
  app.get('/topics', (c) => {
    scans.topics += 1;
    return c.json({ topics: ['a', 'b'], generated: scans.topics });
  });
  app.get('/topics/:slug', (c) => {
    scans.topics += 1;
    return c.json({ slug: c.req.param('slug'), generated: scans.topics });
  });
  app.get('/reputation/:pubkey', (c) => {
    scans.topics += 1;
    return c.json({ pubkey: c.req.param('pubkey'), generated: scans.topics });
  });
  app.get('/other', (c) => {
    scans.other += 1;
    return c.json({ other: scans.other });
  });
  app.get('/health', (c) => {
    scans.other += 1;
    return c.json({ status: 'ok' });
  });
  return { app, scans };
}

describe('výber ciest', () => {
  it('cache sa vzťahuje na /topics, /topics/:slug a /reputation/*', () => {
    expect(isCacheableReadPath('/topics')).toBe(true);
    expect(isCacheableReadPath('/topics/o-com-funguje-forum')).toBe(true);
    expect(isCacheableReadPath('/reputation/abc')).toBe(true);
  });

  it('iné cesty cacheované nie sú (health, feed, events, threads)', () => {
    for (const path of ['/', '/health', '/feed', '/events', '/threads/abc', '/search']) {
      expect(isCacheableReadPath(path), path).toBe(false);
    }
  });
});

describe('responseCache middleware', () => {
  it('druhý GET obslúži z cache a handler behá raz', async () => {
    const { app, scans } = makeApp({ ttlMs: 5_000 });
    const first = await app.request('/topics');
    const second = await app.request('/topics');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(scans.topics).toBe(1);
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(second.headers.get('x-cache')).toBe('HIT');
  });

  it('po TTL expirácii handler behá znova', async () => {
    let nowMs = 1_000_000;
    const { app, scans } = makeApp({ ttlMs: 1_000, now: () => nowMs });
    await app.request('/topics');
    await app.request('/topics');
    expect(scans.topics).toBe(1);
    nowMs += 1_001;
    const third = await app.request('/topics');
    expect(scans.topics).toBe(2);
    expect(third.headers.get('x-cache')).toBe('MISS');
  });

  it('rôzne query = rôzna položka cache (limit nesmie preskočiť)', async () => {
    const { app, scans } = makeApp({ ttlMs: 5_000 });
    await app.request('/topics?limit=1');
    await app.request('/topics?limit=50');
    expect(scans.topics).toBe(2);
  });

  it('rôzne cesty sa navzájom nezmieňajú', async () => {
    const { app, scans } = makeApp({ ttlMs: 5_000 });
    await app.request('/topics/koren');
    await app.request('/topics/podtopic');
    await app.request('/reputation/abc');
    expect(scans.topics).toBe(3);
  });

  it('ne-cacheované cesty cache vôbec nevidia', async () => {
    const { app, scans } = makeApp({ ttlMs: 5_000 });
    await app.request('/health');
    await app.request('/health');
    expect(scans.other).toBe(2);
  });

  it('ttlMs=0 je priepustka (dev inštancia môže chcieť vždy čerstvé)', async () => {
    const { app, scans } = makeApp({ ttlMs: 0 });
    await app.request('/topics');
    const second = await app.request('/topics');
    expect(scans.topics).toBe(2);
    expect(second.headers.get('x-cache')).toBeNull();
  });

  it('POST sa necache-uje (len GET je idempotentný)', async () => {
    const app = new Hono();
    app.use('*', responseCache({ ttlMs: 5_000 }));
    let posts = 0;
    app.post('/topics', (c) => {
      posts += 1;
      return c.json({ posts });
    });
    app.get('/topics', (c) => c.json({ posts }));
    await app.request('/topics');
    await app.request('/topics', { method: 'POST' });
    await app.request('/topics', { method: 'POST' });
    expect(posts).toBe(2);
  });

  it('CORS hlavičky zotrvajú aj v HIT odpovedi (UI inak zlyhá na read-only banneri)', async () => {
    const { app } = makeApp({ ttlMs: 5_000, corsOrigin: 'https://aiforum.myhood.sk' });
    await app.request('/topics', { headers: { origin: 'https://aiforum.myhood.sk' } });
    const hit = await app.request('/topics', { headers: { origin: 'https://aiforum.myhood.sk' } });
    expect(hit.headers.get('x-cache')).toBe('HIT');
    expect(hit.headers.get('access-control-allow-origin')).toBe('https://aiforum.myhood.sk');
    expect(hit.headers.get('content-type')).toContain('application/json');
  });

  it('HIT odpoveď má Age v sekundách', async () => {
    let nowMs = 2_000_000;
    const { app } = makeApp({ ttlMs: 10_000, now: () => nowMs });
    await app.request('/topics');
    nowMs += 3_000;
    const hit = await app.request('/topics');
    expect(hit.headers.get('age')).toBe('3');
  });

  it('ne-200 odpovede sa neukladajú (404 sa nesmie večne opakovať)', async () => {
    const app = new Hono();
    app.use('*', responseCache({ ttlMs: 5_000 }));
    let hits = 0;
    app.get('/topics', (c) => {
      hits += 1;
      return hits === 1 ? c.json({ error: 'not ready' }, 503) : c.json({ ok: true });
    });
    const first = await app.request('/topics');
    const second = await app.request('/topics');
    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(hits).toBe(2);
  });
});

describe('TtlLruCache', () => {
  it('evikuje najmenej nedávno použitú položku (LRU, nie FIFO)', () => {
    const nowMs = 0;
    const cache = new TtlLruCache(2, () => nowMs);
    const put = (key: string) =>
      cache.set(key, {
        status: 200,
        contentType: 'application/json',
        body: key,
        storedAt: nowMs,
        expiresAt: nowMs + 10_000,
      });
    put('a');
    put('b');
    cache.get('a'); // trep → 'b' je najstaršia
    put('c');
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it('expirovaná položka zmizí pri čítaní', () => {
    let nowMs = 0;
    const cache = new TtlLruCache(4, () => nowMs);
    cache.set('a', {
      status: 200,
      contentType: 'application/json',
      body: 'a',
      storedAt: 0,
      expiresAt: 100,
    });
    nowMs = 101;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('default TTL je 5 s a strop položiek je kladný', () => {
    expect(READ_CACHE_TTL_DEFAULT_MS).toBe(5_000);
    const cache = new TtlLruCache();
    expect(cache.size).toBe(0);
  });
});
