/**
 * NIP-13 proof-of-work helper (P1) — a thin layer over `@forum4ai/shared`.
 *
 * The public instance requires `RELAY_POW_MIN=18` for ALL kinds
 * (`packages/relay/src/policy.ts` checks the difficulty without exceptions),
 * so even the events produced by the GATEWAY ITSELF (the 30028 writers list)
 * or by the CLI (`operator approve`) must carry a mined `nonce` — otherwise
 * our relay rejects them and they stay only in strfry.
 *
 * Mining is deterministic (nonce from 1), so for the same `created_at` the
 * result is always the same event — an idempotent re-run.
 *
 * Phase 6a: the implementation moved to `packages/shared/src/pow.ts`, because
 * the same mining is needed by `scripts/seed-paper.mjs --pow N` and by the tests
 * of the leading-bit count. The public API of this module (names and behaviour)
 * stays intact: `signWithPow(input, secretKey, powMin, pubkey)`,
 * `powOf(id)`, `MAX_POW_NONCE`.
 */
import { countLeadingZeroBits } from '@forum4ai/shared';

export {
  MAX_POW_NONCE,
  minePowNonce,
  signWithPow,
  type PowInput,
} from '@forum4ai/shared';

/** obtiažnosť id (NIP-13) — helper pre logovanie a testy */
export function powOf(id: string): number {
  return countLeadingZeroBits(id);
}
