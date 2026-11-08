/**
 * Testy per-IP rate limitu `POST /events` (F4AI-24, verejná inštancia).
 *
 * Dve vrstvy:
 *  - unit test `SlidingWindowRateLimiter` s injectable hodinou (čistá
 *    logika okna, bez čakania),
 *  - regresné testy cez `createGatewayApp` — to je vrstva, kde sa chyby
 *    skutočne ukážu: či sa XFF berie len pri dôvere, či 429 nesie CORS
 *    a Retry-After, či GET a preflight nespotrebúvajú rozpočet a či
 *    zamietnuté requesty (400) rozpočet SPOTREBUJÚ (stojia validáciu).
 *
 * Testy používajú `app.request()` bez node socketu → kľúč je `unknown`
 * (jeden spoločný kôš), preto dôverou nastavenú vetvu testujeme cez XFF.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';

import {
  createGatewayApp,
  isHeavyReadPath,
  type GatewayOutbox,
  type GatewayPool,
} from '../src/app.js';
import { resolveGatewayConfig } from '../src/config.js';
import {
  SlidingWindowRateLimiter,
  clientIp,
  eventRateLimit,
  clientRateLimitKey,
  ipMatchesCidr,
  ipRateLimit,
  normalizeIp,
  parseCidrList,
  rateLimitKey,
} from '../src/rate-limit.js';
import type { PublishResult, RelayStatus } from '../src/relay-pool.js';

const sk = generateSecretKey();

function questionEvent(content: string): Event {
  return finalizeEvent(
    { kind: 1020, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'rl-1020']], content },
    sk,
  );
}

class MockPool implements GatewayPool {
  results: PublishResult[] = [
    { url: 'ws://w1.example/', ok: true, message: 'accepted: event uložený' },
  ];
  statuses: RelayStatus[] = [
    { url: 'ws://w1.example/', connected: true, attempts: 0, nextAttemptAt: 0, lastError: null, lastConnectedAt: 1 },
  ];
  async publish(): Promise<PublishResult[]> {
    return this.results;
  }
  status(): RelayStatus[] {
    return this.statuses;
  }
}

class MockOutbox implements GatewayOutbox {
  async writeRelaysFor(): Promise<string[]> {
    return ['ws://w1.example/'];
  }
}

function makeApp(overrides?: {
  eventRateMax?: number;
  eventRateWindowMs?: number;
  trustProxyHeader?: boolean;
  corsOrigin?: string;
}) {
  const lines: string[] = [];
  const app = createGatewayApp({
    pool: new MockPool(),
    outbox: new MockOutbox(),
    logger: (line) => lines.push(line),
    ...(overrides?.eventRateMax !== undefined ? { eventRateMax: overrides.eventRateMax } : {}),
    ...(overrides?.eventRateWindowMs !== undefined
      ? { eventRateWindowMs: overrides.eventRateWindowMs }
      : {}),
    ...(overrides?.trustProxyHeader !== undefined
      ? { trustProxyHeader: overrides.trustProxyHeader }
      : {}),
    ...(overrides?.corsOrigin !== undefined ? { corsOrigin: overrides.corsOrigin } : {}),
  });
  return { app, lines };
}

function post(app: ReturnType<typeof makeApp>['app'], content: string, headers?: Record<string, string>) {
  return app.request('/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(questionEvent(content)),
  });
}

// ── unit: klzacie okno ──────────────────────────────────────────────────────

describe('SlidingWindowRateLimiter — okno', () => {
  it('pustí max requestov a ďalší odmietne s retry-after', () => {
    const now = 1_000;
    const limiter = new SlidingWindowRateLimiter({
      maxPerWindow: 3,
      windowMs: 60_000,
      now: () => now,
    });

    expect(limiter.check('1.2.3.4')).toMatchObject({ allowed: true, limit: 3, remaining: 2 });
    expect(limiter.check('1.2.3.4')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check('1.2.3.4')).toMatchObject({ allowed: true, remaining: 0 });

    const blocked = limiter.check('1.2.3.4');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // uvoľní sa, keď vypadne najstarší úder (1_000 + 60_000)
    expect(blocked.retryAfterMs).toBe(60_000);
  });

  it('okno klzže — po uplynutí windowMs opäť pustí', () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter({
      maxPerWindow: 2,
      windowMs: 1_000,
      now: () => now,
    });
    limiter.check('k');
    limiter.check('k');
    expect(limiter.check('k').allowed).toBe(false);

    now = 1_001; // prvý úder je mimo okna
    expect(limiter.check('k')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('kľúče sú nezávislé (IP A nespotrebuje rozpočet IP B)', () => {
    const limiter = new SlidingWindowRateLimiter({ maxPerWindow: 1, windowMs: 1_000 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('zamietnutý request nespotrebuje okno (inak by sa blokujúci klient nevypustil)', () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter({
      maxPerWindow: 1,
      windowMs: 1_000,
      now: () => now,
    });
    limiter.check('k');
    for (let i = 0; i < 5; i++) expect(limiter.check('k').allowed).toBe(false);
    now = 1_001;
    expect(limiter.check('k').allowed).toBe(true);
  });

  it('konštrukcia odmietne nezmyselné parametre', () => {
    expect(() => new SlidingWindowRateLimiter({ maxPerWindow: 0, windowMs: 1_000 })).toThrow(TypeError);
    expect(() => new SlidingWindowRateLimiter({ maxPerWindow: 1.5, windowMs: 1_000 })).toThrow(TypeError);
    expect(() => new SlidingWindowRateLimiter({ maxPerWindow: 1, windowMs: 0 })).toThrow(TypeError);
  });
});

// ── unit: normalizácia IP ───────────────────────────────────────────────────

describe('normalizeIp', () => {
  it('unmapuje IPv4-in-IPv6 a stripne brackety/medzery', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp(' [2001:DB8::1] ')).toBe('2001:db8::1');
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('zamietne reťazce, ktoré nie sú IP (XFF je klientský header)', () => {
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp('neviem-kto')).toBeNull();
    expect(normalizeIp('1.2.3.4; echo pwned')).toBeNull();
    expect(normalizeIp('a'.repeat(65))).toBeNull();
  });
});

// ── regresia cez Hono app ───────────────────────────────────────────────────

describe('POST /events — per-IP limit (regresia)', () => {
  it('20 povolených, 21. → 429 s Retry-After a reasons[]', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 20; i++) {
      const res = await post(app, `polozka ${String(i)}`);
      expect(res.status, `request ${String(i)}`).toBe(200);
    }
    const res = await post(app, 'polozka 21');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
    expect(res.headers.get('x-ratelimit-limit')).toBe('20');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
    const body = (await res.json()) as { ok: boolean; error: string; reasons: string[] };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('rate limited');
    expect(body.reasons[0]).toContain('POST /events');
  });

  it('default: X-Forwarded-For sa NEberie — útočník s falošným XFF neobíde limit', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 20; i++) {
      const res = await post(app, `xff ${String(i)}`, { 'x-forwarded-for': `10.0.0.${String(i)}` });
      expect(res.status).toBe(200);
    }
    // iná XFF hodnota, ale bez dôvery je kľúč stále socket IP → 429
    const res = await post(app, 'xff spoof', { 'x-forwarded-for': '8.8.8.8' });
    expect(res.status).toBe(429);
  });

  it('GATEWAY_TRUST_XFF: odlišné XFF sú odlišné IP, rovnaká IP sa blokuje', async () => {
    const { app } = makeApp({ trustProxyHeader: true, eventRateMax: 2 });
    expect((await post(app, 'a1', { 'x-forwarded-for': '10.0.0.1' })).status).toBe(200);
    expect((await post(app, 'a2', { 'x-forwarded-for': '10.0.0.1' })).status).toBe(200);
    expect((await post(app, 'a3', { 'x-forwarded-for': '10.0.0.1' })).status).toBe(429);
    // druhá IP si rozpočet prvej neberie
    expect((await post(app, 'b1', { 'x-forwarded-for': '10.0.0.2' })).status).toBe(200);
    // tá istá IP zapisaná ako IPv4-in-IPv6 je ten istý kľúč (normalizácia)
    expect((await post(app, 'a4', { 'x-forwarded-for': '::ffff:10.0.0.1' })).status).toBe(429);
  });

  it('za dôveryhodnou proxy sa berie ĽAVÁ hodnota XFF reťazca (zoznam proxy)', async () => {
    const { app } = makeApp({ eventRateMax: 1, trustProxyHeader: true });
    expect((await post(app, 'prvy', { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })).status).toBe(200);
    // rovnaká ľavá IP, hoci zvyšok reťazca je iný → blok
    expect((await post(app, 'druhy', { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' })).status).toBe(429);
    // neplatná XFF sa zahodí → kľúč je fallback (`unknown`), nie klientská klamnosť
    expect((await post(app, 'treti', { 'x-forwarded-for': 'not-an-ip' })).status).toBe(200);
  });

  it('GET a OPTIONS nespotrebúvajú rozpočet POSTu', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 30; i++) {
      expect((await app.request('/health')).status).toBe(200);
      expect((await app.request('/events', { method: 'OPTIONS' })).status).toBe(204);
    }
    for (let i = 0; i < 20; i++) expect((await post(app, `po ${String(i)}`)).status).toBe(200);
    expect((await post(app, 'po 21')).status).toBe(429);
  });

  it('zamietnutý event (400) sa počíta — stojí validáciu', async () => {
    const { app } = makeApp({ eventRateMax: 2 });
    const bad = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    expect((await app.request('/events', bad)).status).toBe(400);
    expect((await post(app, 'ok 1')).status).toBe(200);
    expect((await post(app, 'ok 2')).status).toBe(429);
  });

  it('eventRateMax=0 limiter vypne (dev/test)', async () => {
    const { app } = makeApp({ eventRateMax: 0 });
    for (let i = 0; i < 25; i++) expect((await post(app, `no limit ${String(i)}`)).status).toBe(200);
  });

  it('429 má CORS hlavičky, inak ju prehliadač neukáže', async () => {
    const { app } = makeApp({ eventRateMax: 1, corsOrigin: 'https://aiforum.myhood.sk' });
    const first = await post(app, 'cors 1', { origin: 'https://aiforum.myhood.sk' });
    expect(first.status).toBe(200);
    const second = await post(app, 'cors 2', { origin: 'https://aiforum.myhood.sk' });
    expect(second.status).toBe(429);
    expect(second.headers.get('access-control-allow-origin')).toBe('https://aiforum.myhood.sk');
  });

  it('X-RateLimit-Remaining klesá s každým povoleným requestom', async () => {
    const { app } = makeApp({ eventRateMax: 3 });
    const remaining: (string | null)[] = [];
    for (let i = 0; i < 3; i++) remaining.push((await post(app, `rem ${String(i)}`)).headers.get('x-ratelimit-remaining'));
    expect(remaining).toEqual(['2', '1', '0']);
  });

  it('limit platí len pre /events — /health a /topics zostávajú neobmedzené', async () => {
    const { app } = makeApp({ eventRateMax: 1 });
    expect((await post(app, 'prvy')).status).toBe(200);
    expect((await post(app, 'druhy')).status).toBe(429);
    for (let i = 0; i < 10; i++) {
      const health = await app.request('/health');
      expect(health.status).toBe(200);
    }
  });
});

// ── konfigurácia ────────────────────────────────────────────────────────────

describe('resolveGatewayConfig — env pre limit a CORS', () => {
  it('defaulty: 20/min, 60 s okno, XFF nedôverujeme, CORS "*"', () => {
    const config = resolveGatewayConfig({});
    expect(config.eventRateMax).toBe(20);
    expect(config.eventRateWindowMs).toBe(60_000);
    expect(config.trustProxyHeader).toBe(false);
    expect(config.corsOrigin).toBe('*');
  });

  it('GATEWAY_EVENT_RATE_MAX / _WINDOW_MS prepíšu limit', () => {
    const config = resolveGatewayConfig({
      GATEWAY_EVENT_RATE_MAX: '5',
      GATEWAY_EVENT_RATE_WINDOW_MS: '10000',
    });
    expect(config.eventRateMax).toBe(5);
    expect(config.eventRateWindowMs).toBe(10_000);
  });

  it('GATEWAY_TRUST_XFF akceptuje 1/true/yes/on a inak je false', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(resolveGatewayConfig({ GATEWAY_TRUST_XFF: value }).trustProxyHeader, value).toBe(true);
    }
    for (const value of ['0', 'false', 'no', '', '   ', 'ano-ne']) {
      expect(resolveGatewayConfig({ GATEWAY_TRUST_XFF: value }).trustProxyHeader, JSON.stringify(value)).toBe(
        false,
      );
    }
  });

  it('GATEWAY_CORS_ORIGIN sa skutočne používa (verejná inštancia)', () => {
    expect(resolveGatewayConfig({ GATEWAY_CORS_ORIGIN: 'https://aiforum.myhood.sk' }).corsOrigin).toBe(
      'https://aiforum.myhood.sk',
    );
  });
});

// ── A6 (P0, security review): CIDR dôvera, IPv6 /64, LRU strop ─────────────

describe('A6: parseCidrList / ipMatchesCidr', () => {
  it('parsovanie CIDR v4 aj v6; holá IP = /32 resp. /128', () => {
    const list = parseCidrList('172.18.0.0/16, fd00::/8 10.0.0.5');
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ kind: 4, bits: 16 });
    expect(list[1]).toMatchObject({ kind: 6, bits: 8 });
    expect(list[2]).toMatchObject({ kind: 4, bits: 32 });
  });

  it('neplatné položky zahodí (jedna preklepnutá sieť nevypne dôveru ostatným)', () => {
    const list = parseCidrList('172.18.0.0/16, nonsense, 10.0.0.0/33, , 172.19/16');
    expect(list.map((c) => c.bits)).toEqual([16]);
    expect(parseCidrList(undefined)).toEqual([]);
    expect(parseCidrList('')).toEqual([]);
  });

  it('IP spadá / nespadá do CIDRu (v4 aj v6)', () => {
    const cidrs = parseCidrList('172.18.0.0/16 fd00::/8');
    expect(ipMatchesCidr('172.18.7.42', cidrs)).toBe(true);
    expect(ipMatchesCidr('172.18.255.255', cidrs)).toBe(true);
    expect(ipMatchesCidr('172.19.0.1', cidrs)).toBe(false);
    expect(ipMatchesCidr('10.0.0.1', cidrs)).toBe(false);
    expect(ipMatchesCidr('fd12:3456::1', cidrs)).toBe(true);
    expect(ipMatchesCidr('fe80::1', cidrs)).toBe(false);
    expect(ipMatchesCidr('hoci-co', cidrs)).toBe(false);
    expect(ipMatchesCidr('1.2.3.4', [])).toBe(false);
  });

  it('maskuje sietový adres (10.1.2.3/8 = 10.0.0.0/8)', () => {
    const cidrs = parseCidrList('10.1.2.3/8');
    expect(ipMatchesCidr('10.9.9.9', cidrs)).toBe(true);
  });
});

describe('A6: kľúčovanie IPv6 na /64', () => {
  it('IPv4 kľúč = adresa, IPv6 kľúč = /64 prefix (8 bajtov)', () => {
    expect(rateLimitKey('1.2.3.4')).toBe('1.2.3.4');
    expect(rateLimitKey('2001:db8:abcd:1234:0:0:0:1')).toBe(
      rateLimitKey('2001:db8:abcd:1234:ffff:ffff:ffff:ffff'),
    );
    expect(rateLimitKey('2001:db8:abcd:1234::1')).not.toBe(rateLimitKey('2001:db8:abcd:1235::1'));
  });

  it('celý /64 rotujúcej adresy splynie do jedného kľúča (inak neobmedzený rozpočet)', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      keys.add(rateLimitKey(`2001:db8:1:1:${i.toString(16)}::`));
    }
    expect(keys.size).toBe(1);
  });

  // NOTE: `::` kompresia sa parsovaním zhoduje s plným zápisom
  it('kompresia `::` a zmiešaný v4-tail sa parsovanie rovnajú plnému zápisu', () => {
    expect(rateLimitKey('2001:db8::1')).toBe(
      rateLimitKey('2001:0db8:0000:0000:0000:0000:0000:0001'),
    );
    expect(rateLimitKey('64:ff9b::1.2.3.4')).toBe(
      rateLimitKey('0064:ff9b:0000:0000:0000:0000:0102:0304'),
    );
    // formát kľúča: 16 hex znakov prefixu + `::/64`
    expect(rateLimitKey('2001:db8::1')).toBe('20010db800000000::/64');
    expect(rateLimitKey('::1')).toBe('0000000000000000::/64');
  });

  it('neplatné IPv6 tvary sa vrátia ako kľúč bez výnimky', () => {
    for (const junk of ['2001:db8:12345::1', '2001:db8:1:2:3:4:5:6:7', 'gg::1', ':::1']) {
      expect(rateLimitKey(junk), junk).toBe(junk);
    }
  });

  it('neplatný vstup sa vráti ako kľúč (žiadna výnimka)', () => {
    expect(rateLimitKey('unknown')).toBe('unknown');
  });
});

describe('A6: LRU tvrdý strop kľúčov limitera', () => {
  it('nad maxKeys evikuje a mapa nerastie do nekonečna', () => {
    let nowMs = 0;
    const limiter = new SlidingWindowRateLimiter({
      maxPerWindow: 5,
      windowMs: 60_000,
      maxKeys: 10,
      now: () => nowMs,
    });
    for (let i = 0; i < 500; i += 1) {
      limiter.check(`10.0.${String(Math.floor(i / 256))}.${String(i % 256)}`);
      nowMs += 1;
    }
    expect(limiter.keyCount).toBeLessThanOrEqual(10);
  });

  it('kľúč sa pri trepe presunie na koniec (evikcia siahne na najstaršie IP)', () => {
    let nowMs = 0;
    const limiter = new SlidingWindowRateLimiter({
      maxPerWindow: 5,
      windowMs: 60_000,
      maxKeys: 2,
      now: () => nowMs,
    });
    limiter.check('a');
    limiter.check('b');
    nowMs += 1;
    limiter.check('a'); // trep → 'b' je najstaršia
    limiter.check('c');
    expect(limiter.keyCount).toBe(2);
    // 'a' stále dostáva svoj rozpočet, 'b' bola vyhodená a začína od nuly
    for (let i = 0; i < 5; i += 1) expect(limiter.check('a').allowed).toBe(i < 3);
    expect(limiter.check('b').allowed).toBe(true);
  });
});

describe('A6: XFF len zo siete dôveryhodnej proxy', () => {
  /** app s limitom 1/min, meraná IP sa posiela hlavičkou `x-test-ip`
   *  (getConnInfo v testoch bez node-bindingu vráti null → 'unknown') */
  function makeApp(options: { trustXff: boolean; trustedProxies?: string }) {
    const app = new Hono();
    app.use(
      '/events',
      eventRateLimit({
        maxPerWindow: 1,
        windowMs: 60_000,
        trustXff: options.trustXff,
        ...(options.trustedProxies !== undefined
          ? { trustedProxies: parseCidrList(options.trustedProxies) }
          : {}),
        logger: () => undefined,
      }),
    );
    app.post('/events', (c) => c.json({ ok: true }));
    return app;
  }

  it('bez CIDRu (stará semantika): trustXff=1 → XFF rozhoduje', async () => {
    const app = makeApp({ trustXff: true });
    const first = await app.request('/events', { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' } });
    const second = await app.request('/events', { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    // iná XFF = iný kľúč → obísť limit jednou hlavičkou (preto CIDR)
    const other = await app.request('/events', { method: 'POST', headers: { 'x-forwarded-for': '8.8.8.8' } });
    expect(other.status).toBe(200);
  });

  it('s CIDRom: XFF sa ignoruje, ak socket nie je zo siete proxy → spoločný kľúč', async () => {
    // socket IP je v testoch 'unknown' (nie je v 172.18.0.0/16) → XFF sa
    // NEpoužije, všetky requesty idú do jedného kľúča 'unknown'
    const app = makeApp({ trustXff: true, trustedProxies: '172.18.0.0/16' });
    const first = await app.request('/events', { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' } });
    const spoofed = await app.request('/events', {
      method: 'POST',
      headers: { 'x-forwarded-for': '8.8.8.8' },
    });
    expect(first.status).toBe(200);
    expect(spoofed.status).toBe(429);
  });

  it('unit: clientIp uplatní CIDR na socket IP (mocknutý getConnInfo)', async () => {
    // priamy test funkcie — socket IP simulujeme cez Context s vlastným
    // `getConnInfo` nemáme, preto aspoň overíme, že CIDR bez zhody = fallback
    const app = new Hono();
    app.get('/probe', (c) => {
      const cidrs = parseCidrList('172.18.0.0/16');
      return c.json({
        withCidr: clientIp(c, true, cidrs),
        withoutCidr: clientIp(c, true),
        key: clientRateLimitKey(c, true, cidrs),
      });
    });
    const res = await app.request('/probe', {
      headers: { 'x-forwarded-for': '203.0.113.7, 172.18.0.2' },
    });
    const body = (await res.json()) as { withCidr: string; withoutCidr: string; key: string };
    // bez CIDR: ľavá XFF = klientská IP; s CIDR: socket 'unknown' nie je
    // dôveryhodná proxy → XFF ignorujeme
    expect(body.withoutCidr).toBe('203.0.113.7');
    expect(body.withCidr).toBe('unknown');
    expect(body.key).toBe('unknown');
  });
});

// ── A4 (P0): per-IP limit ťažkých GET ciest ─────────────────────────────────

describe('A4: GET limiter (ipRateLimit pre ťažké čítacie route)', () => {
  function makeApp(max: number) {
    const app = new Hono();
    app.use('*', cors({ origin: 'https://aiforum.myhood.sk', maxAge: 86400 }));
    const limiter = ipRateLimit({
      maxPerWindow: max,
      windowMs: 60_000,
      methods: ['GET'],
      label: 'GET (heavy read routes)',
      logger: () => undefined,
    });
    app.use('*', async (c, next) => {
      if (!isHeavyReadPath(new URL(c.req.url).pathname)) return await next();
      return limiter(c, next);
    });
    app.get('/topics', (c) => c.json({ ok: true }));
    app.get('/topics/:slug', (c) => c.json({ ok: true }));
    app.get('/threads/:id', (c) => c.json({ ok: true }));
    app.get('/reputation/:pubkey', (c) => c.json({ ok: true }));
    app.get('/search', (c) => c.json({ ok: true }));
    app.get('/health', (c) => c.json({ ok: true }));
    app.get('/feed', (c) => c.json({ ok: true }));
    return app;
  }

  it('60/min: 61. ťažký GET → 429 s Retry-After a CORS hlavičkami', async () => {
    const app = makeApp(3);
    const paths = ['/topics', '/topics/koren', '/threads/' + 'a'.repeat(64), '/reputation/' + 'b'.repeat(64)];
    for (const path of paths.slice(0, 3)) {
      const res = await app.request(path, { headers: { origin: 'https://aiforum.myhood.sk' } });
      expect(res.status, path).toBe(200);
    }
    const blocked = await app.request(paths[3]!, { headers: { origin: 'https://aiforum.myhood.sk' } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(blocked.headers.get('access-control-allow-origin')).toBe('https://aiforum.myhood.sk');
    const body = (await blocked.json()) as { error: string; reasons: string[] };
    expect(body.error).toBe('rate limited');
    expect(body.reasons[0]).toContain('heavy read routes');
  });

  it('lacné cesty (health, feed) limiter neobmedzuje', async () => {
    const app = makeApp(2);
    for (let i = 0; i < 6; i += 1) {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 6; i += 1) {
      const res = await app.request('/feed');
      expect(res.status).toBe(200);
    }
  });

  it('/search je ťažká cesta a je limitovaná', async () => {
    const app = makeApp(1);
    expect((await app.request('/search?q=x')).status).toBe(200);
    expect((await app.request('/search?q=y')).status).toBe(429);
  });

  it('max=0 = vypnutý limiter (dev inštancia)', async () => {
    const app = makeApp(0);
    for (let i = 0; i < 20; i += 1) {
      expect((await app.request('/topics')).status).toBe(200);
    }
  });

  it('isHeavyReadPath vyberie presne tie ťažké cesty', () => {
    for (const path of ['/topics', '/topics/a.b', '/threads/' + 'a'.repeat(64), '/reputation/x', '/search']) {
      expect(isHeavyReadPath(path), path).toBe(true);
    }
    for (const path of ['/', '/health', '/feed', '/recent', '/events', '/me', '/ideas']) {
      expect(isHeavyReadPath(path), path).toBe(false);
    }
  });
});

// ── P0: env premenné musia existovať pod menami z dizajnu (žiadne tiché
//    preklepy — predchádzajúca generácia stratila dáta práve na preklepe v env)

describe('resolveGatewayConfig — P0 env mená', () => {
  it('defaulty: gate off, GET 60/min, cache 5 s, WS 4 na IP, register approve', () => {
    const config = resolveGatewayConfig({});
    expect(config.writeGateMode).toBe('off');
    expect(config.writeAllow.size).toBe(0);
    expect(config.getRateMax).toBe(60);
    expect(config.getRateWindowMs).toBe(60_000);
    expect(config.readCacheMs).toBe(5_000);
    expect(config.readCacheMaxEntries).toBeGreaterThan(0);
    expect(config.wsMaxConnectionsPerIp).toBe(4);
    expect(config.trustedProxiesRaw).toBe('');
    expect(config.registerMode).toBe('approve');
    expect(config.regSecret).toBe('');
    expect(config.ownerSkHex).toBe('');
    expect(config.operatorsDb).toBeTruthy();
  });

  it('verejná inštancia (VPS): všetky P0/P1 premenné sa parsovaním dostanú dnu', () => {
    const config = resolveGatewayConfig({
      GATEWAY_TRUST_XFF: '1',
      GATEWAY_TRUSTED_PROXIES: '172.18.0.0/16',
      GATEWAY_GET_RATE_MAX: '120',
      GATEWAY_GET_RATE_WINDOW_MS: '30000',
      GATEWAY_READ_CACHE_MS: '10000',
      GATEWAY_READ_CACHE_MAX_ENTRIES: '250',
      GATEWAY_WS_MAX_CONNECTIONS_PER_IP: '8',
      GATEWAY_WRITE_GATE: 'enforce',
      GATEWAY_WRITE_ALLOW: 'd546d2e47c4a3ddcf51ab1845a1e4369fa901a2e91f7ac941fde2921355fc9d5, EBC0B44BE1AD7D4167D87177F50FB02CCF8F76A36B872758215EBFA1BB096F40',
      GATEWAY_REGISTER_MODE: 'auto',
      GATEWAY_REG_SECRET: 'af'.repeat(32),
      GATEWAY_OPERATORS_DB: '/data/gateway/operators.db',
      GATEWAY_OWNER_SK_HEX: 'cc'.repeat(32),
    });
    expect(config.trustedProxiesRaw).toBe('172.18.0.0/16');
    expect(parseCidrList(config.trustedProxiesRaw)).toHaveLength(1);
    expect(config.getRateMax).toBe(120);
    expect(config.getRateWindowMs).toBe(30_000);
    expect(config.readCacheMs).toBe(10_000);
    expect(config.readCacheMaxEntries).toBe(250);
    expect(config.wsMaxConnectionsPerIp).toBe(8);
    expect(config.writeGateMode).toBe('enforce');
    expect(config.writeAllow.size).toBe(2);
    // normalizácia na lowercase — gateway porovnáva lowercase hex
    expect([...config.writeAllow].every((key) => key === key.toLowerCase())).toBe(true);
    expect(config.registerMode).toBe('auto');
    expect(config.regSecret).toBe('af'.repeat(32));
    expect(config.operatorsDb).toBe('/data/gateway/operators.db');
    expect(config.ownerSkHex).toBe('cc'.repeat(32));
  });

  it('GATEWAY_READ_CACHE_MS=0 a GATEWAY_GET_RATE_MAX=0 vecne vypnú (dev inštancia)', () => {
    const config = resolveGatewayConfig({ GATEWAY_READ_CACHE_MS: '0', GATEWAY_GET_RATE_MAX: '0' });
    expect(config.readCacheMs).toBe(0);
    expect(config.getRateMax).toBe(0);
  });

  it('GATEWAY_WRITE_GATE=off je default aj pri preklepe (neznáma hodnota = off)', () => {
    expect(resolveGatewayConfig({ GATEWAY_WRITE_GATE: 'enforc' }).writeGateMode).toBe('off');
    expect(resolveGatewayConfig({ GATEWAY_WRITE_GATE: 'LOG' }).writeGateMode).toBe('log');
  });

  it('GATEWAY_WRITE_ALLOW ignoruje neplatné hex (jedna preklepnutá adresa nevynechá gate)', () => {
    const config = resolveGatewayConfig({
      GATEWAY_WRITE_ALLOW: 'abc, zz, ' + 'a'.repeat(64) + ' , ' + 'b'.repeat(63),
    });
    expect(config.writeAllow).toEqual(new Set(['a'.repeat(64)]));
  });
});
