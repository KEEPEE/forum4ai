/**
 * Per-IP rate limit for `POST /events` and heavy GETs (F4AI-24 + A4/A6 from
 * the security review, P0).
 *
 * Why: the gateway is a public write endpoint. Without a limit, one client
 * (or a script on a rented IP) floods it with requests that require JSON
 * validation + BIP-340 cryptography and thus abuses the CPU of the whole stack.
 *
 * Two decisions you need to know, because they are easy to break:
 *
 *  1. **The key is the IP address, not the pubkey.** An attacker has endless
 *     keys (generated in nanoseconds), so a per-pubkey limit does not stand up
 *     to them. The per-pubkey limit lives in the second layer — the relay
 *     (`packages/relay/src/rate-limit.ts`, `RELAY_RATE_MAX`) — and that one is
 *     against decent authors, not against an IP attack.
 *
 *  2. **`X-Forwarded-For` is taken only when we explicitly trust it**
 *     (`GATEWAY_TRUST_XFF=1`, default = do not trust). Without a reverse proxy
 *     in front, XFF is ordinary client input — anybody sets it and the
 *     limit could be bypassed with a single header (a different IP per request).
 *     Behind Caddy/nginx on the same container network, XFF is on the contrary
 *     the only way to see the real client IP (the socket would be the proxy IP).
 *
 *  3. A6 (P0): trust in XFF is bound to the **source socket IP**
 *     (`GATEWAY_TRUSTED_PROXIES` = a CIDR list). Any container on the same
 *     network can send XFF; we trust it only when the socket the request came
 *     from is inside the configured CIDR (on the VPS
 *     `172.18.0.0/16` = the Caddy network). Without a CIDR the old semantics
 *     remain (trustXff = trust any peer), so dev stacks do not behave differently.
 *
 * The limiter counts **requests**, not successful publications — a bad request
 * (400/413) costs validation too, so it must be counted. Rejected
 * requests (429) are on the contrary not recorded, otherwise a blocking client
 * would never leave the window (the same semantics as the relay limiter).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

export interface RateLimitDecision {
  allowed: boolean;
  /** nastavený strop okna (pre `X-RateLimit-Limit`) */
  limit: number;
  /** koľko requestov ešte prejde v aktuálnom okne */
  remaining: number;
  /** za koľko ms sa uvoľní najstarší slot (0 pri povolení) */
  retryAfterMs: number;
}

export interface SlidingWindowOptions {
  maxPerWindow: number;
  windowMs: number;
  /** injectable hodiny v ms — unit testy bez reálneho čakania */
  now?: () => number;
  /**
   * A6 (P0): tvrdý strop počtu kľúčov s LRU evikciou. `0`/undefined =
   * `DEFAULT_MAX_KEYS`. Bez neho mapa rástla s každou IP, ktorú gateway
   * kedy videla (útočník s rotujúcou IPv6 /64 ju naplní za minúty) a
   * nad 10 000 kľúčov robil KAŽDÝ check O(n) sweep.
   */
  maxKeys?: number;
}

/** tvrdý strop kľúčov limitera (LRU evikcia) — A6 (P0) */
export const RATE_LIMIT_MAX_KEYS_DEFAULT = 20_000;

/**
 * Klzacie okno per kľúč. Implementačne zrkadlo `packages/relay/src/
 * rate-limit.ts` (ten modul je vnútornou vecou relay balíka a gateway na
 * neho nedepends, takže ho nemôžeme importovať — rovnaká semantika,
 * rovný sweep).
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  /**
   * Sweep prázdných kľúčov (code-review A5): bez neho by mapa rástla s
   * každou novou IP, ktorú gateway kedy videl. Prah je vysoko, bežný
   * prevádzkový deň ním neprejde.
   */
  private static readonly SWEEP_THRESHOLD = 10_000;

  constructor(opts: SlidingWindowOptions) {
    if (!Number.isInteger(opts.maxPerWindow) || opts.maxPerWindow <= 0) {
      throw new TypeError('maxPerWindow must be a positive integer');
    }
    if (!(opts.windowMs > 0)) {
      throw new TypeError('windowMs must be a positive number');
    }
    this.max = opts.maxPerWindow;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? RATE_LIMIT_MAX_KEYS_DEFAULT;
  }

  /** počet aktívnych kľúčov (testy LRU evikcie) */
  get keyCount(): number {
    return this.hits.size;
  }

  /** Skontroluje okno a pri povolení zaznamená jeden úder. */
  check(key: string): RateLimitDecision {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const seen = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);

    if (seen.length === 0) this.hits.delete(key);
    else this.hits.set(key, seen);

    if (this.hits.size > SlidingWindowRateLimiter.SWEEP_THRESHOLD) {
      for (const [k, ts] of this.hits) {
        const last = ts[ts.length - 1];
        if (last === undefined || last <= cutoff) this.hits.delete(k);
      }
    }

    if (seen.length >= this.max) {
      const oldest = seen[0] ?? now;
      return {
        allowed: false,
        limit: this.max,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + this.windowMs - now),
      };
    }

    seen.push(now);
    // A6 (P0): LRU — kľúč sa pri každom trepe presunie na koniec mapy,
    // takže evikcia vždy siahne na NAJMENEJ nedávno videne IP. Tvrdý
    // strop platí vždy (aj pod SWEEP_THRESHOLD), preto útočník nemôže
    // naplniť pamäť nekonečným zoznamom kľúčov.
    this.hits.delete(key);
    this.hits.set(key, seen);
    if (this.maxKeys > 0) {
      while (this.hits.size > this.maxKeys) {
        const oldestKey = this.hits.keys().next();
        if (oldestKey.done) break;
        this.hits.delete(oldestKey.value);
      }
    }
    return { allowed: true, limit: this.max, remaining: this.max - seen.length, retryAfterMs: 0 };
  }

  reset(): void {
    this.hits.clear();
  }
}

/** `::ffff:1.2.3.4` → `1.2.3.4`; odstráni hrany, brackety a medzery. */
export function normalizeIp(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end > 0) value = value.slice(1, end);
  }
  const mapped = /^::ffff:([0-9.]+)$/.exec(value);
  if (mapped?.[1] !== undefined) value = mapped[1];
  // povolené znaky IP (v4 aj v6) — všetko ostatné je klientom dodaná
  // reťazcová klamnosť a nepoužijeme ju ako kľúč
  if (!/^[0-9a-f:.]+$/.test(value) || value.length === 0 || value.length > 64) return null;
  return value;
}

// ── A6 (P0): parsovanie IP / CIDR a kľúčovanie IPv6 cez /64 ────────────────

export interface IpAddress {
  /** 4 = IPv4 (4 bajty), 6 = IPv6 (16 bajtov) */
  kind: 4 | 6;
  bytes: Uint8Array;
}

function parseIpv4Bytes(value: string): Uint8Array | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (const [i, part] of parts.entries()) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

/**
 * IPv6 → 16 bajtov. Podporuje kompresiu `::` a zmiešaný tvar
 * `64:ff9b::1.2.3.4` (4 bajty IPv4 na konci). Bez `inet-ip-address`
 * natívnej knižnice — need je len porovnanie prefixu, nie plná normalizácia.
 */
function parseIpv6Bytes(value: string): Uint8Array | null {
  if (!value.includes(':')) return null;
  const doubleSplit = value.split('::');
  if (doubleSplit.length > 2) return null;

  const parseGroups = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const parts = chunk.split(':');
    const out: number[] = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const v4 = parseIpv4Bytes(part);
        if (v4 === null) return null;
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        out.push(Number.parseInt(part, 16));
      }
    }
    return out;
  };

  const hasCompression = doubleSplit.length === 2;
  const head = parseGroups(doubleSplit[0] ?? '');
  // Pri ne-kompresnom zápise je `tail` PRÁZDNE pole — `null` znamená
  // výhradne "neplatný zápis". Keby sme sem dali null, zahodili by sme
  // všetky plné tvary `2001:db8:abcd:1234:0:0:0:1` (8 skupín, bez `::`).
  const tail = hasCompression ? parseGroups(doubleSplit[1] ?? '') : [];
  if (head === null || tail === null) return null;

  let groups: number[];
  if (hasCompression) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  const bytes = new Uint8Array(16);
  for (const [i, group] of groups.entries()) {
    bytes[i * 2] = (group >> 8) & 0xff;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/** Normalizovaný reťazec IP → binárna IP (null = nie je platná IP). */
export function parseIp(normalized: string): IpAddress | null {
  const v4 = parseIpv4Bytes(normalized);
  if (v4 !== null) return { kind: 4, bytes: v4 };
  const v6 = parseIpv6Bytes(normalized);
  if (v6 !== null) return { kind: 6, bytes: v6 };
  return null;
}

export interface Cidr {
  kind: 4 | 6;
  network: Uint8Array;
  bits: number;
}

/**
 * Jeden CIDR (`172.18.0.0/16`, `fd00::/8`) alebo holá IP (→ /32, resp.
 * /128). Neplatný záznam → null (volajúci ho zahodí).
 */
export function parseCidr(raw: string): Cidr | null {
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  const [ipPart, prefixPart] = value.split('/');
  if (ipPart === undefined) return null;
  const ip = parseIp(normalizeIp(ipPart) ?? '');
  if (ip === null) return null;
  const maxBits = ip.kind === 4 ? 32 : 128;
  let bits = maxBits;
  if (prefixPart !== undefined) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    bits = Number(prefixPart);
    if (bits > maxBits) return null;
  }
  // maskujeme sietový adres — `10.1.2.3/8` je to isté čo `10.0.0.0/8`
  const network = new Uint8Array(ip.bytes);
  for (let i = bits; i < network.length * 8; i += 1) {
    const byteIndex = Math.floor(i / 8);
    network[byteIndex] = (network[byteIndex] ?? 0) & ~(1 << (7 - (i % 8))) & 0xff;
  }
  return { kind: ip.kind, network, bits };
}

/**
 * CIDR list z env (`GATEWAY_TRUSTED_PROXIES`). Oddeľovače čiarka /
 * medzera / nový riadok; neplatné položky zahadzujeme — jedna preklepnutá
 * sieť nesmie vypnúť dôveru tým ostatným (a ticho by to znamenalo,
 * že per-IP limit počítá IP proxy pre VŠETKÝCH klientov).
 */
export function parseCidrList(raw: string | undefined): Cidr[] {
  const out: Cidr[] = [];
  for (const part of (raw ?? '').split(/[\s,]+/)) {
    const cidr = parseCidr(part);
    if (cidr !== null) out.push(cidr);
  }
  return out;
}

/** `ip` spadá do niektorého CIDRu? (rovnaké rodiny, porovnanie prefixu) */
export function ipMatchesCidr(normalizedIp: string, cidrs: readonly Cidr[]): boolean {
  if (cidrs.length === 0) return false;
  const ip = parseIp(normalizedIp);
  if (ip === null) return false;
  for (const cidr of cidrs) {
    if (cidr.kind !== ip.kind) continue;
    let matches = true;
    for (let i = 0; i < cidr.bits; i += 1) {
      const bit = (b: Uint8Array): number => ((b[Math.floor(i / 8)] ?? 0) >> (7 - (i % 8))) & 1;
      if (bit(ip.bytes) !== bit(cidr.network)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/**
 * A5/B4 (P1): verejná IP adresa. Registrácia operátora kontroluje DNS
 * odpoveď jeho relaya práve preto, že `wss://` + port 443 samo o sebe
 * nezabrání SSRF — `wss://internal.service` môže resolve-ovať na RFC1918
 * a gateway by sa mu pripojil do vnútornej siete (BlockHub kontajnery).
 *
 * Zamietame: RFC1918, loopback, link-local, CGNAT (100.64/10 — drží Tailscale),
 * multicast/reserved, IPv6 ULA (fc00::/7), link-local (fe80::/10),
 * multicast (ff00::/8) a `::` nedefinovanú adresu. IPv4-mapped `::ffff:`
 * sa rozbalí a hodnotí sa its IPv4 časť (inak by `::ffff:10.0.0.1` prešlo).
 */
export function isPublicIp(normalizedIp: string): boolean {
  const ip = parseIp(normalizedIp);
  if (ip === null) return false;
  const b = ip.bytes;

  if (ip.kind === 6) {
    // IPv4-mapped: `::ffff:a.b.c.d` — hodnotíme its v4 časť
    let mapped = true;
    for (let i = 0; i < 10; i += 1) if ((b[i] ?? 0) !== 0) mapped = false;
    if (mapped && (b[10] ?? 0) === 0xff && (b[11] ?? 0) === 0xff) {
      return isPublicIp(`${b[12] ?? 0}.${b[13] ?? 0}.${b[14] ?? 0}.${b[15] ?? 0}`);
    }
    // `::` a `::1`
    if ((b[15] ?? 0) === 0) {
      let allZero = true;
      for (let i = 0; i < 15; i += 1) if ((b[i] ?? 0) !== 0) allZero = false;
      if (allZero) return false;
    }
    if ((b[0] ?? 0) === 0 && (b[1] ?? 0) === 0 && (b[2] ?? 0) === 0 && (b[3] ?? 0) === 0 && (b[15] ?? 0) === 1) {
      return false; // ::1 loopback
    }
    if (((b[0] ?? 0) & 0xfe) === 0xfc) return false; // fc00::/7 ULA
    if (((b[0] ?? 0) & 0xff) === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80) return false; // fe80::/10
    if (((b[0] ?? 0) & 0xff) === 0xff) return false; // ff00::/8 multicast
    return true;
  }

  const a = b[0] ?? 0;
  const second = b[1] ?? 0;
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 127) return false; // loopback
  if (a === 10) return false; // RFC1918
  if (a === 172 && second >= 16 && second <= 31) return false; // RFC1918
  if (a === 192 && second === 168) return false; // RFC1918
  if (a === 169 && second === 254) return false; // link-local
  if (a === 100 && second >= 64 && second <= 127) return false; // CGNAT/Tailscale
  if (a === 198 && (second === 18 || second === 19)) return false; // benchmarking
  if (a === 192 && second === 0 && (b[2] ?? 0) === 0) return false; // IETF protocol assignees
  if (a >= 224 && a < 240) return false; // multicast
  if (a >= 240) return false; // reserved / broadcast
  return true;
}

/**
 * A6 (P0): kľúč limitera. IPv4 = adresa ako taká; **IPv6 = /64 prefix**
 * (prvých 8 bajtov). Dôvod: IPv6 sa prideľuje podnikom po /64 (a bežný
 * hostiteľ má v rámci siete celý /64 adries), takže kľúčovanie po /128
 * dalo jednému /64 neobmedzený rozpočet — stačilo rotovať poslednú
 * hex-skupinu.
 */
export function rateLimitKey(normalizedIp: string): string {
  const ip = parseIp(normalizedIp);
  if (ip === null) return normalizedIp;
  if (ip.kind === 4) return normalizedIp;
  let prefix = '';
  for (let i = 0; i < 8; i += 1) prefix += (ip.bytes[i] ?? 0).toString(16).padStart(2, '0');
  return `${prefix}::/64`;
}

/**
 * Socket IP priamo pripojeného klienta. `getConnInfo` je officiálny hono
 * helper, ale v testoch (`app.request()` bez node-bindingu) zahodí
 * výnimku — tam vrátime null a volajúci použije fallback.
 */
export function socketIp(c: Context): string | null {
  try {
    const address = getConnInfo(c).remote.address;
    return typeof address === 'string' ? normalizeIp(address) : null;
  } catch {
    return null;
  }
}

/**
 * Kľúč limitera: priame socket IP, alebo — len pri `trustXff` — ľavá
 * (pôvodná klientská) hodnota `X-Forwarded-For`. Bez dôvery je XFF
 * zámerne ignorované aj keď existuje (pozri hlavičku súboru).
 *
 * A6 (P0): ak je zadaný `trustedProxies` (neprázdny CIDR list), XFF
 * použiť NEDOKÁŽEME, kým socket IP nie je v jednej z týchto sietí.
 * Prázdny list = stará semantika (trustXff dôveruje ľubovoľnému peerovi),
 * aby sa dev inštancia bez Caddy nezachovala inak.
 *
 * Fallback `'unknown'` je vedome jeden spoločný kôš: testy a priame
 * volania bez socketu z neho nesmú dostať neobmedzený rozpočet.
 */
export function clientIp(c: Context, trustXff: boolean, trustedProxies?: readonly Cidr[]): string {
  if (trustXff) {
    const xff = c.req.header('x-forwarded-for');
    if (xff !== undefined && xff.trim() !== '') {
      const first = normalizeIp(xff.split(',')[0] ?? '');
      const proxyIsTrusted =
        trustedProxies === undefined ||
        trustedProxies.length === 0 ||
        ipMatchesCidr(socketIp(c) ?? '', trustedProxies);
      if (first !== null && proxyIsTrusted) return first;
    }
  }
  return socketIp(c) ?? 'unknown';
}

/**
 * Kľúč, pod ktorým limiter počítá: `clientIp` + IPv6 zoskupenie na /64
 * (A6). Volá to každý middleware, aby sa kľúčovanie nedalo zabudnúť.
 */
export function clientRateLimitKey(
  c: Context,
  trustXff: boolean,
  trustedProxies?: readonly Cidr[],
): string {
  return rateLimitKey(clientIp(c, trustXff, trustedProxies));
}

export interface EventRateLimitOptions {
  /** max requestov v okne; `0` alebo menej = limiter vypnutý */
  maxPerWindow: number;
  windowMs: number;
  /** dôverovať `X-Forwarded-For` (len za dôveryhodnou reverznou proxy) */
  trustXff?: boolean;
  /**
   * A6 (P0): CIDR siete, ktorých socket IP smie poslať `X-Forwarded-For`
   * (`GATEWAY_TRUSTED_PROXIES`). Prázdne = dôverovať komukoľvek pri
   * `trustXff` (staré správanie).
   */
  trustedProxies?: readonly Cidr[];
  /** A6 (P0): tvrdý LRU strop kľúčov; default `RATE_LIMIT_MAX_KEYS_DEFAULT` */
  maxKeys?: number;
  /** injectable hodiny pre testy */
  now?: () => number;
  /** logovanie odmietnutí (default ticho, aby testy nešpinili výstup) */
  logger?: (line: string) => void;
}

export interface IpRateLimitOptions extends EventRateLimitOptions {
  /** metódy, ktoré sa počítajú (default `['POST']`) — GET limiter dáva `['GET']` */
  methods?: readonly string[];
  /** popiska do hlášky a logu, default `POST /events` */
  label?: string;
}

/**
 * Všeobecný per-IP limiter (A4 + A6, P0). Počíta requesty vybraných
 * metód; iné metódy pustí bez počítania. Pri prekročení 429 s
 * `Retry-After` v tvare `{ ok: false, error, reasons[] }` a CORS
 * hlavičkami (registruje sa ZA cors() middleware — `c.json` ich prepíše
 * z `c.res`, inak by prehliadač chybu nevidel).
 */
export function ipRateLimit(options: IpRateLimitOptions): MiddlewareHandler {
  const max = options.maxPerWindow;
  if (!(max > 0)) return async (_c, next) => void (await next());

  const windowMs = options.windowMs > 0 ? options.windowMs : 60_000;
  const trustXff = options.trustXff === true;
  const trustedProxies = options.trustedProxies ?? [];
  const label = options.label ?? 'POST /events';
  const methods = new Set((options.methods ?? ['POST']).map((m) => m.toUpperCase()));
  const logger = options.logger ?? (() => undefined);
  const limiter = new SlidingWindowRateLimiter({
    maxPerWindow: max,
    windowMs,
    ...(options.maxKeys !== undefined ? { maxKeys: options.maxKeys } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  return async (c, next) => {
    if (!methods.has(c.req.method.toUpperCase())) return await next();

    const ip = clientRateLimitKey(c, trustXff, trustedProxies);
    const decision = limiter.check(ip);

    if (!decision.allowed) {
      const retryAfterS = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      logger(
        `rate limit: ${label} from ${ip} — ${String(max)} requests per ` +
          `${String(Math.round(windowMs / 1000))} s, retry-after ${String(retryAfterS)} s`,
      );
      return c.json(
        {
          ok: false,
          error: 'rate limited',
          reasons: [
            `${label}: more than ${String(max)} requests per ` +
              `${String(Math.round(windowMs / 1000))} s window from IP ${ip} — try again in ${String(retryAfterS)} s`,
          ],
        },
        429,
        {
          'Retry-After': String(retryAfterS),
          'X-RateLimit-Limit': String(max),
          'X-RateLimit-Remaining': '0',
        },
      );
    }

    await next();
    c.res.headers.set('X-RateLimit-Limit', String(max));
    c.res.headers.set('X-RateLimit-Remaining', String(decision.remaining));
  };
}

/**
 * Middleware limitujúci `POST /events` per IP — tenké volanie
 * `ipRateLimit` (zachováva verejné API F4AI-24). Iné metódy a cesty
 * nepustí bez počítania (GET /health, /topics… sú lacne čítacie a
 * OPTIONS preflight obslúži CORS middleware pred týmto).
 */
export function eventRateLimit(options: EventRateLimitOptions): MiddlewareHandler {
  return ipRateLimit({ ...options, methods: ['POST'], label: 'POST /events' });
}
