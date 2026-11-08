/**
 * Publish quorum (F4AI-10).
 *
 * A sensible rule from the task: publishing counts as successful when at
 * least `minOk` write relays returned OK (default 1). With fewer, the route
 * returns 424 Failed Dependency with the per-relay results so the client sees
 * why (and can send the event again).
 */
import type { PublishResult } from './relay-pool.js';

export interface QuorumEvaluation {
  quorum_met: boolean;
  ok_count: number;
  total: number;
  min_ok: number;
}

export function evaluateQuorum(results: PublishResult[], minOk = 1): QuorumEvaluation {
  const min_ok = Number.isFinite(minOk) && minOk > 1 ? Math.floor(minOk) : 1;
  const ok_count = results.filter((result) => result.ok).length;
  return {
    quorum_met: ok_count >= min_ok,
    ok_count,
    total: results.length,
    min_ok,
  };
}
