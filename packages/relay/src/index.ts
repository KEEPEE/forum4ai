/**
 * @forum4ai/relay — tenký NIP-01 relay (Node 22 + `ws` + nostr-tools)
 * s konfigurovateľnou forum4ai L2 politikou.
 *
 * Politika je čistý modul (`policy.ts`) testovateľný bez siete;
 * `server.ts` ju len napája na websocket protokol.
 */
export {
  RelayPolicy,
  DEFAULT_ALLOWED_KINDS,
  DEFAULT_POLICY,
  resolvePolicyConfig,
  okMessage,
} from './policy.js';
export type {
  RelayPolicyConfig,
  RateLimitConfig,
  PolicyDecision,
  PolicyCode,
} from './policy.js';

export { countLeadingZeroBitsHex } from './pow.js';

export { SlidingWindowRateLimiter } from './rate-limit.js';
export type { RateLimitResult, SlidingWindowOptions } from './rate-limit.js';

export { verifyFull } from './verify.js';

export { MemoryStore } from './store.js';
export type { StoreResult } from './store.js';

export { startRelayServer } from './server.js';
export type { RelayServerOptions, RunningRelay } from './server.js';

export { backfillOnce, startBackfillLoop, BACKFILL_DEFAULTS } from './backfill.js';
export type { BackfillConfig, BackfillResult } from './backfill.js';
