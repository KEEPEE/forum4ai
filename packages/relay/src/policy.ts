/**
 * forum4ai relay politika — čistá, sieťovo nezávislá rozhodovacia funkcia.
 *
 * Pravidlá (konfigurovateľné, dev defaulty):
 *  0. `readOnly` (Phase 6b-deploy, `RELAY_READ_ONLY=1`): každá EVENT správa
 *     → `rejected: read-only relay`; čítanie (`REQ`, NIP-11) ostáva otvorené
 *  1. allowed kinds: 0, 3, 1020–1059, 10030, 27235, 30002, 30020–30029,
 *     30400, 30401 → inak `rejected: kind …`
 *  2. kind 1023 (post): práve jeden `e` tag s markerom `root`
 *     (0 alebo >1 → `rejected: root_marker`) — pravidlo zdieľame so
 *     shared validátorom `validatePostRootMarker` (rovnaký runtime, Node ESM)
 *  3. NIP-13 PoW: práh vedúcich nulových bitov z id, default 0 = vypnuté
 *  4. rate limit per pubkey: klzacie okno, default 30 EVENT správ / minútu
 *     → pri prekročení `rate-limited: …`
 *  5. podpis + prepočet NIP-01 hashu pred uložením (`verifyFull`)
 *
 * Navyše uplatňujeme shared L2 pravidlá, na ktoré S1 upozorňuje:
 * štruktúra eventu (sekundový `created_at`…), addressable kindy (30000+)
 * vyžadujú `d` tag a topic 30020 vyžaduje platný `d` slug + voliteľný
 * parent `a` tag.
 */
import {
  KINDS,
  findTags,
  validateEventStructure,
  validatePostRootMarker,
  validateTopic,
} from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';
import { countLeadingZeroBitsHex } from './pow.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';
import { verifyFull } from './verify.js';

export interface RateLimitConfig {
  maxEventsPerWindow: number;
  windowMs: number;
}

export interface RelayPolicyConfig {
  /** kindy, ktoré relay pripúšťa; ostatné odmietne s `rejected: kind` */
  allowedKinds: ReadonlySet<number>;
  /** NIP-13: minimálny počet vedúcich nulových bitov id; 0 = vypnuté (dev) */
  powMinDifficulty: number;
  rateLimit: RateLimitConfig;
  /**
   * Phase 6b-deploy: verejný **read-only** relay (`RELAY_READ_ONLY=1`).
   *
   * `evaluate()` s týmto flagom zamietne KAŽDÚ EVENT správu skôr, než urobí
   * čokoľvek iné — vrátane počítadla rate limitu, ktoré inak rastie z
   * každej EVENT správy per pubkey. Dôvod: verejná inštancia chce ponúknuť
   * čítací vstup klientom a agentom bez toho, aby jej relay perzistoval
   * cudzí obsah (write cesta je gateway + vlastné relaye).
   *
   * Čítacie cesty tým nedotčené: `REQ`/`CLOSE` (NIP-01) a NIP-11 document
   * (`GET /` s `Accept: application/nostr+json`) — politika rozhoduje len
   * o EVENT, tie druhé vôbec neprechádzajú cez ňu.
   */
  readOnly: boolean;
}

function kindRange(from: number, to: number): number[] {
  const kinds: number[] = [];
  for (let kind = from; kind <= to; kind += 1) kinds.push(kind);
  return kinds;
}

/**
 * Dev default podľa zadania F4AI-8 — nadmnožina shared registry
 * (o 0 set-metadata, 3 contacts a range 1020–1059 / 30020–30029);
 * 10002 RELAY_INFORMATION v nej zámerne nie je (informačný document
 * slúži NIP-11 endpoint, nie perzistentný obsah fóra).
 *
 * F4AI-12 (S6): pridávame 10031 FOLLOWS (replaceable sledovanie topikov,
 * d='follows') — MCP `forum_follow` tool posiela tento kind.
 */
export const DEFAULT_ALLOWED_KINDS: ReadonlySet<number> = new Set<number>([
  0,
  3,
  ...kindRange(1020, 1059),
  10030,
  10031,
  27235,
  30002,
  ...kindRange(30020, 30029),
  30400,
  30401,
]);

export const DEFAULT_POLICY: RelayPolicyConfig = {
  allowedKinds: DEFAULT_ALLOWED_KINDS,
  powMinDifficulty: 0,
  rateLimit: { maxEventsPerWindow: 30, windowMs: 60_000 },
  readOnly: false,
};

export type PolicyCode =
  | 'structure'
  | 'kind'
  | 'root_marker'
  | 'd_tag'
  | 'topic'
  | 'read_only'
  | 'pow'
  | 'rate_limited'
  | 'signature';

export type PolicyDecision =
  | { ok: true }
  | { ok: false; code: PolicyCode; message: string };

export function resolvePolicyConfig(
  overrides?: Partial<RelayPolicyConfig>,
): RelayPolicyConfig {
  return {
    ...DEFAULT_POLICY,
    ...overrides,
    rateLimit: { ...DEFAULT_POLICY.rateLimit, ...overrides?.rateLimit },
  };
}

const PUBKEY_HEX = /^[0-9a-f]{64}$/;

function reject(code: PolicyCode, message: string): PolicyDecision {
  return { ok: false, code, message };
}

/**
 * Wire OK správa pre NIP-01 tuple ["OK", id, false, msg] — povinné
 * prefixy z NIP-01 (`pow:`, `rate-limited:`), iné odmietnutia `rejected:`.
 */
export function okMessage(decision: Extract<PolicyDecision, { ok: false }>): string {
  const prefix =
    decision.code === 'rate_limited'
      ? 'rate-limited'
      : decision.code === 'pow'
        ? 'pow'
        : 'rejected';
  return `${prefix}: ${decision.message}`;
}

export class RelayPolicy {
  readonly config: RelayPolicyConfig;
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(config?: Partial<RelayPolicyConfig>, options?: { now?: () => number }) {
    this.config = resolvePolicyConfig(config);
    this.limiter = new SlidingWindowRateLimiter({
      ...this.config.rateLimit,
      now: options?.now,
    });
  }

  /**
   * Rozhodni o jednej EVENT správe. Čisté, bez I/O — testovateľné bez siete.
   *
   * Poradie: read-only guard (Phase 6b: verejný čítací relay — skôr než
   * čokoľvek iné, vrátane počítadla rate limitu) → guard pubkey (lebo rate
   * limit počítá *každú* EVENT správu per pubkey) → rate limit → štruktúra
   * → kind → 1023 root marker → addressable `d` → topic 30020 → PoW →
   * podpis+hash (kryptografia ako najdrahšia kontrola naposledy).
   */
  evaluate(event: unknown): PolicyDecision {
    if (this.config.readOnly) {
      return reject('read_only', 'read-only relay');
    }

    if (typeof event !== 'object' || event === null) {
      return reject('structure', 'event musí byť objekt');
    }
    const candidate = event as Partial<NostrEvent>;
    if (typeof candidate.pubkey !== 'string' || !PUBKEY_HEX.test(candidate.pubkey)) {
      return reject('structure', 'pubkey musí byť 64 hex znakov');
    }

    const limit = this.limiter.check(candidate.pubkey);
    if (!limit.allowed) {
      return reject(
        'rate_limited',
        `viac ako ${String(this.config.rateLimit.maxEventsPerWindow)} EVENT správ za ` +
          `${String(Math.round(this.config.rateLimit.windowMs / 1000))} s okno, ` +
          `skús to znova o ${String(limit.retryAfterMs)} ms`,
      );
    }

    const full = event as NostrEvent;

    const structure = validateEventStructure(full);
    if (!structure.valid) {
      return reject('structure', structure.errors.join('; '));
    }

    if (!this.config.allowedKinds.has(full.kind)) {
      return reject('kind', `kind ${String(full.kind)} nie je v zozname povolených kindov`);
    }

    if (full.kind === KINDS.POST) {
      const root = validatePostRootMarker(full.tags);
      if (!root.valid) {
        return reject('root_marker', root.errors.join('; '));
      }
    }

    // NIP-01: addressable kindy 30000+ vyžadujú `d` tag
    // (nadmnožina shared ADDRESSABLE_KINDS — relay pripúšťa širšie range)
    if (full.kind >= 30000 && findTags(full.tags, 'd').length === 0) {
      return reject('d_tag', `addressable kind ${String(full.kind)} vyžaduje d tag`);
    }

    if (full.kind === KINDS.TOPIC) {
      const topic = validateTopic(full.tags);
      if (!topic.valid) {
        return reject('topic', topic.errors.join('; '));
      }
    }

    if (this.config.powMinDifficulty > 0) {
      const bits = countLeadingZeroBitsHex(full.id);
      if (bits < this.config.powMinDifficulty) {
        return reject(
          'pow',
          `id má len ${String(bits)} vedúcich nulových bitov, vyžaduje sa ` +
            `${String(this.config.powMinDifficulty)}`,
        );
      }
    }

    if (!verifyFull(full)) {
      return reject(
        'signature',
        'podpis nesedí na id alebo id nesedí na hash obsahu (NIP-01 prepočet)',
      );
    }

    return { ok: true };
  }
}
