/**
 * Operator registration (design B2–B4, P1).
 *
 * Two parts, both testable without a network:
 *
 * 1. **Challenge** — `nonce = HMAC(GATEWAY_REG_SECRET, pubkey|exp)`.
 *    Nothing is stored: validity is bound to `exp` and replay is covered by
 *    the set of used nonces in memory (until `exp`). 10 minutes, 5/hour/IP
 *    (the limiter is on the route, not here).
 *
 * 2. **Proof of replication** — the gateway verifies that the claimant's relay
 *    (a) is `wss://` + port 443 + DNS resolves to a PUBLIC IP,
 *     (b) has `pubkey` = claimant in its NIP-11 document (it binds the relay to
 *        the key — otherwise anybody would point at damus.io),
 *     (c) serves the claim event itself (kind 1055),
 *     (d) serves ≥4 of 5 random ids from our last week with a VALID signature
 *        (proof that the relay replicates the forum).
 *
 * The error text of a foreign relay is Never returned to the client (the same
 * rule as when sanitizing the transient publish — it leaks host:port).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as dns } from 'node:dns';

import { verifyFull } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';
import type { Filter } from 'nostr-tools/filter';

import { isPublicIp, normalizeIp } from './rate-limit.js';
import { normalizeRelayUrl, type RelayLike } from './relay-pool.js';

/** platnosť challenge (dizajn B2): 10 minút */
export const CHALLENGE_TTL_S = 600;
/** koľko id zo nášho týždňa sa vyžaduje (dizajn B4: ≥4 z 5) */
export const REPLICATION_SAMPLE_SIZE = 5;
export const REPLICATION_MIN_OK = 4;
/** tvrdý timeout jedného probe (dizajn B4) */
export const PROBE_TIMEOUT_MS = 5_000;
/** max súbežných probe (dizajn B4: "at most 2 global in-flight checks") */
export const PROBE_MAX_IN_FLIGHT = 2;
/** strop množiny použitých nonce (predídene rastu pri útoku) */
const USED_NONCE_MAX = 10_000;

const HEX64 = /^[0-9a-f]{64}$/;

// ── 1) challenge ────────────────────────────────────────────────────────────

export interface Challenge {
  nonce: string;
  /** sekundy, kedy challenge vyprší */
  exp: number;
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Vytvorí challenge pre `pubkey`. `exp` je SOUČASŤ podpisu, takže overenie
 * nepotrebuje žiadny store — stačí HMAC a hodiny.
 */
export function createChallenge(secret: string, pubkey: string, nowS: number = Math.floor(Date.now() / 1000)): Challenge {
  const exp = nowS + CHALLENGE_TTL_S;
  return { nonce: hmac(secret, `${pubkey.toLowerCase()}|${String(exp)}`), exp };
}

export type ChallengeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Overí HMAC nonce a jej expiráciu. `reason` je interný kód (logujeme ho),
 * klient dostáva len všeobecné "challenge je neplatný" — nech neprezradíme,
 * či niekto hádał secret alebo len starú nonce.
 */
export function verifyChallenge(
  secret: string,
  pubkey: string,
  nonce: string,
  exp: number,
  nowS: number = Math.floor(Date.now() / 1000),
): ChallengeVerdict {
  if (secret === '') return { ok: false, reason: 'no_secret' };
  if (!HEX64.test(pubkey)) return { ok: false, reason: 'bad_pubkey' };
  if (!Number.isFinite(exp) || exp <= 0) return { ok: false, reason: 'bad_exp' };
  if (exp < nowS) return { ok: false, reason: 'expired' };
  if (exp > nowS + CHALLENGE_TTL_S + 60) return { ok: false, reason: 'exp_too_far' };
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) return { ok: false, reason: 'bad_nonce_shape' };
  const expected = hmac(secret, `${pubkey.toLowerCase()}|${String(Math.floor(exp))}`);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(nonce, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_hmac' };
  return { ok: true };
}

/**
 * Množina použitých nonce (do `exp`). Replay-útok by inak umožnil použiť
 * jeden challenge 5-krát za 10 minút (a pri 5/hour/IP si ho útočník
 * vyberá pomaly, ale isto).
 */
export class UsedNonces {
  private readonly entries = new Map<string, number>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Math.floor(Date.now() / 1000));
  }

  get size(): number {
    return this.entries.size;
  }

  has(nonce: string): boolean {
    const exp = this.entries.get(nonce);
    if (exp === undefined) return false;
    if (exp < this.now()) {
      this.entries.delete(nonce);
      return false;
    }
    return true;
  }

  /** `true` = nonce bola voľná a práve sme ju spotrebovali */
  consume(nonce: string, exp: number): boolean {
    this.prune();
    if (this.entries.has(nonce)) return false;
    if (this.entries.size >= USED_NONCE_MAX) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(nonce, exp);
    return true;
  }

  prune(): number {
    const nowS = this.now();
    let removed = 0;
    for (const [nonce, exp] of this.entries) {
      if (exp < nowS) {
        this.entries.delete(nonce);
        removed += 1;
      }
    }
    return removed;
  }
}

// ── 2) bezpečná URL + probe ─────────────────────────────────────────────────

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

/**
 * Produkčný resolver (dizajn B4): OS resolver cez `dns.promises.lookup`,
 * teda rovnaká cesta, ktorou sa potom pripája aj WebSocket — inak by sme
 * overovali jednu odpoveď a pripojili sa na druhú. `verbatim: true`
 * necháva aj AAAA (pravidlo "aspoň jedna odpoveď je verejná" si vyberie).
 */
export const defaultResolver: Resolver = async (host) => {
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: Number(answer.family),
  }));
};

/**
 * NIP-11 information document relaya (dizajn B4: `pubkey` viaže relay na
 * kľúč). Žiadna textová chyba sa nedostáva von — vrátime `null` a volajúci
 * dostane kód `nip11_unreachable`.
 *
 * URL už posielame normalizovanú (`https://host/`), ale DNS rebinding
 * medzi resolverom a fetchom je teoreticky možný TOCTOU — preto je tu
 * tvrdý timeout a `redirect: 'error'` ( presmerovanie na internú adresu
 * by inak obišlo kontrolu verejnej IP).
 */
export async function fetchNip11Info(
  httpsUrl: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(httpsUrl, {
      headers: { Accept: 'application/nostr+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type SafeUrlVerdict =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: 'bad_url' | 'not_wss' | 'bad_port' | 'dns_failed' | 'not_public_ip' };

/**
 * Kontrola URL cudzieho relaya (dizajn B4). Port 443 je súčasťou pravidiel
 * schválne: bez neho by `wss://host:6379` stačilo na to, aby sme si
 * osiahli ľubovoľnú službu v sieti (a odpoveď relaya by nám ju popsala).
 */
export async function assertSafeRelayUrl(
  rawUrl: string,
  resolve: Resolver,
): Promise<SafeUrlVerdict> {
  const url = normalizeRelayUrl(rawUrl);
  if (url === null) return { ok: false, reason: 'bad_url' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'bad_url' };
  }
  if (parsed.protocol !== 'wss:') return { ok: false, reason: 'not_wss' };
  // explicitný port musí byť 443; implicitný (= bez portu) je tiež 443
  if (parsed.port !== '' && parsed.port !== '443') return { ok: false, reason: 'bad_port' };
  const host = parsed.hostname;
  if (host === '') return { ok: false, reason: 'bad_url' };

  // ak je host rovnou IP adresa, hodnotíme ju priamo (DNS by sme inak
  // preskočili a `wss://10.0.0.5` by prešlo)
  const direct = normalizeIp(host);
  if (direct !== null) {
    return isPublicIp(direct) ? { ok: true, url, host } : { ok: false, reason: 'not_public_ip' };
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await resolve(host);
  } catch {
    return { ok: false, reason: 'dns_failed' };
  }
  if (!Array.isArray(answers) || answers.length === 0) return { ok: false, reason: 'dns_failed' };
  // STAČÍ, ak aspoň jedna odpoveď je verejná IP — relay môže mať aj
  // internú AAAA vedľa verejnej A, a my sa pripojíme na tú verejnú
  for (const answer of answers) {
    const normalized = normalizeIp(answer.address);
    if (normalized !== null && isPublicIp(normalized)) {
      return { ok: true, url, host };
    }
  }
  return { ok: false, reason: 'not_public_ip' };
}

/**
 * Globálny rozpočet súbežných probe. Registrácia je vzácna udalosť, ale
 * bez stropu by 20 paralelných claimov openslo 20 DNS + 20 WS + 20 NIP-11
 * spojení naraz (a cudzí relay by nás tým len brzdil).
 */
export class ProbeBudget {
  private inFlight = 0;
  private readonly max: number;

  constructor(max: number = PROBE_MAX_IN_FLIGHT) {
    this.max = max > 0 ? max : PROBE_MAX_IN_FLIGHT;
  }

  get active(): number {
    return this.inFlight;
  }

  /** `false` = rozpočet je plný, volajúci má vrátiť 429/503 a neskúšať znova */
  tryAcquire(): boolean {
    if (this.inFlight >= this.max) return false;
    this.inFlight += 1;
    return true;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

export type ProbeReason =
  | 'busy'
  | 'unsafe_url'
  | 'unreachable'
  | 'nip11_unreachable'
  | 'nip11_no_pubkey'
  | 'nip11_pubkey_mismatch'
  | 'claim_not_served'
  | 'replication_insufficient'
  | 'timeout';

export type ProbeVerdict = { ok: true; replicated: number } | { ok: false; reason: ProbeReason };

export interface ProbeDeps {
  /** konektor na relay (výrobca: `Relay.connect` s timeoutom; test: fake) */
  connect: (url: string) => Promise<RelayLike>;
  /** NIP-11 fetch (test: fake) */
  fetchInfo: (httpsUrl: string) => Promise<Record<string, unknown> | null>;
  resolve: Resolver;
  timeoutMs?: number;
  /** náhodné id na sampling (posiela VOLAJÚCI — gateway ich má z indexu) */
  sampleIds: readonly string[];
}

/**
 * Jednorázový dotaz na relay: vráti eventy, ktoré relay poslal **do EOSE**.
 * Bez EOSE nemáme dôkaz, že relay dotaz obslužil celý — time-out, predčasné
 * zavretie ani výnimka sa počítajú ako PRÁZDNA odpoveď (inak by relay, ktorý
 * len čiastočne odpovedá, tváril sa ako replikovaný). `limit` v filtri
 * nastavujeme explicitne (inak by relay orezal na svoj strop a my by sme
 * nevedeli, či je to dôkaz alebo len strop).
 */
function queryIds(relay: RelayLike, ids: readonly string[], timeoutMs: number): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    let settled = false;
    const finish = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answered ? events : []);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const filter: Filter = { ids: [...ids], limit: Math.max(ids.length, 1) };
    try {
      const sub = relay.subscribe([filter], {
        onevent: (event) => {
          events.push(event as unknown as NostrEvent);
        },
        oneose: () => finish(true),
        onclose: () => finish(false),
      });
      if (settled) sub.close();
    } catch {
      finish(false);
    }
  });
}

/**
 * Kompletná kontrola cudzieho relaya (dizajn B4). Vracia LEN kódy — text
 * chyby cudzieho relaya sa klientovi neukazuje nikdy.
 */
export async function probeOperatorRelay(
  rawUrl: string,
  claim: { claimant: string; claimId: string },
  deps: ProbeDeps,
): Promise<ProbeVerdict> {
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const safe = await assertSafeRelayUrl(rawUrl, deps.resolve);
  if (!safe.ok) return { ok: false, reason: 'unsafe_url' };

  let relay: RelayLike;
  try {
    relay = await deps.connect(safe.url);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  try {
    // NIP-11: `pubkey` viaže relay na kľúč majiteľa (bez tohto kroku by
    // útočník ukázal na hociktoré verejné relay, ktoré už dáta má)
    let info: Record<string, unknown> | null = null;
    try {
      info = await deps.fetchInfo(`https://${safe.host}/`);
    } catch {
      info = null;
    }
    if (info === null) return { ok: false, reason: 'nip11_unreachable' };
    const infoPubkey = info['pubkey'];
    if (typeof infoPubkey !== 'string' || infoPubkey === '') {
      return { ok: false, reason: 'nip11_no_pubkey' };
    }
    if (infoPubkey.toLowerCase() !== claim.claimant) {
      return { ok: false, reason: 'nip11_pubkey_mismatch' };
    }

    // claim musí byť served (inak claimant len tvrdí, že niečo publikoval)
    const claimEvents = await queryIds(relay, [claim.claimId], timeoutMs);
    const claimServed = claimEvents.some(
      (event) => event.id === claim.claimId && event.pubkey === claim.claimant && verifyFull(event),
    );
    if (!claimServed) return { ok: false, reason: 'claim_not_served' };

    // sampling: ≥4 z 5 náhodných id NAŠHO fóra so validným podpisom
    const sample = deps.sampleIds.slice(0, REPLICATION_SAMPLE_SIZE);
    if (sample.length < REPLICATION_MIN_OK) return { ok: false, reason: 'replication_insufficient' };
    const replicated = await queryIds(relay, sample, timeoutMs);
    const valid = new Set<string>();
    for (const event of replicated) {
      if (!sample.includes(event.id)) continue;
      if (!verifyFull(event)) continue;
      valid.add(event.id);
    }
    if (valid.size < REPLICATION_MIN_OK) return { ok: false, reason: 'replication_insufficient' };
    return { ok: true, replicated: valid.size };
  } finally {
    try {
      relay.close();
    } catch {
      /* už zavreté */
    }
  }
}

/** náhodná vzorka `count` id z pole (Fisher–Yates, bez mutácie vstupu) */
export function sampleIds(ids: readonly string[], count: number, random: () => number = Math.random): string[] {
  const pool = [...ids];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = pool[i] as string;
    pool[i] = pool[j] as string;
    pool[j] = swap;
  }
  return pool.slice(0, Math.max(0, count));
}

/** id challenge limitéra (5/hour/IP) — exportované pre testy */
export function challengeRateKey(ip: string): string {
  return `register:${ip}`;
}

/** koreľácia challenge s requestom (logovanie, nie bezpečnosť) */
export function newRequestId(): string {
  return randomUUID();
}
