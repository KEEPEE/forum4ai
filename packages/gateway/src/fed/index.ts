/**
 * `fed/` — the federation core of the gateway (Phase 6a, design Q5).
 *
 *   `config.ts`  — parsing `GATEWAY_UPSTREAM_GATEWAYS` / `GATEWAY_UPSTREAM_IDS`
 *   `db.ts`      — `fed.db` (upstreams + cursors, remote_events, push queue)
 *   `engine.ts`  — PULL / PUSH / backoff / split-horizon / tick
 *   `routes.ts`  — `GET /fed/events`, `GET /fed/topics`,
 *                  `GET /fed/state`, `POST /fed/resync/:id`
 *
 * Federation is DISABLED until `GATEWAY_UPSTREAM_GATEWAYS` is set: no upstream,
 * no timer, no `/fed/state` data, and `POST /events` behaves exactly as it did
 * before 6a (no queue).
 */
export { parseUpstreamGateways, type FedUpstreamConfig, type ParsedUpstreams } from './config.js';
export {
  FedDb,
  openFedDb,
  type FedDbOptions,
  type FedQueueRow,
  type FedQueueStats,
  type FedUpstreamRow,
  type PushStatus,
  type RemoteTopicRow,
} from './db.js';
export {
  FedEngine,
  backoffDelayMs,
  fedEndpoint,
  FED_INTERVAL_MS_DEFAULT,
  FED_PULL_LIMIT_DEFAULT,
  FED_PUSH_BATCH_DEFAULT,
  FED_BACKOFF_INITIAL_MS_DEFAULT,
  FED_BACKOFF_MAX_MS_DEFAULT,
  FED_MAX_ATTEMPTS_DEFAULT,
  FED_HTTP_TIMEOUT_MS_DEFAULT,
  type FedEngineOptions,
  type PullSummary,
  type PushSummary,
  type TickSummary,
  type FedUpstreamState,
} from './engine.js';
export {
  registerFedRoutes,
  FED_EVENTS_LIMIT_DEFAULT,
  FED_EVENTS_LIMIT_MAX,
  type FedReadPool,
  type FedRouteOptions,
} from './routes.js';
