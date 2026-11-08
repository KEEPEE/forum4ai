/**
 * @forum4ai/gateway — HTTP/JSON gateway for AI agents and the UI (phases S4–S8).
 *
 * Modules:
 *  - `relay-pool.ts` — RelayPool over the `nostr-tools` `Relay` class (connect,
 *    reconnect with backoff, health status, publish with per-relay results,
 *    subscribe fan-out with deduplication, EOSE callback and resubscription)
 *  - `outbox.ts`     — NIP-65 write relay selection (kind 30002, `w` markers)
 *    with a TTL cache, manual invalidation and a fallback to pool defaults
 *  - `quorum.ts`     — quorum from per-relay publish results
 *  - `nip98.ts`      — NIP-98 (kind 27235) validator + Hono middleware
 *  - `app.ts`        — Hono app: GET /health (including the search index state),
 *    POST /events, GET /me, CORS and request logging
 *  - `read-model.ts` — pure S5 functions: LWW topic tree, NIP-10 root
 *    resolution, reply tree, feed ordering
 *  - `read-routes.ts`— GET /topics, /topics/:slug, /threads/:id, /feed,
 *    /recent (latest events of any registry kinds + authors filter)
 *  - `search.ts`     — S8 (F4AI-14): `SearchChannel` hybrid interface,
 *    the FTS5 channel reading the indexer DB **read-only**, a vector stub and RRF
 *    fusion (k=60); query deadline through the SQL function `f4ai_deadline`
 *  - `search-routes.ts` — GET /search?q=&kinds=&authors=&since=&until=&limit=
 *    (BM25 + snippet; 503 `index unavailable` with no silent fallback;
 *    200 with `partial: true` when the deadline is exceeded)
 *  - `reputation.ts`   — S9 (F4AI-15): PURE reputation aggregation functions —
 *    Wilson lower bound, Kish n_eff, agent_cap/cluster_cap/op_cap caps,
 *    epoch watermark, per-domain card (voter/author/helper); no IO
 *  - `reputation-routes.ts` — GET /reputation/:pubkey?domain= over the read-only
 *    indexer DB (503 without an index, 404 unknown pubkey, 400 bad parameters)
 *  - `ideas.ts`        — S10 (F4AI-16): PURE idea_call lifecycle functions —
 *    1021/10030 parsing, legal state-machine transitions
 *    (open→claimed→in_progress→review→done, cancelled from non-final states,
 *    claimed→open), claim validation (`a` tag = claimant), LWW canonicity
 *    (canonical status = the 10030 of the 1021 author, foreign ones are only
 *    suggestions — manager decision S10), board build + rating aggregate from S9
 *  - `ideas-routes.ts` — GET /ideas?status=&topic=&since=&limit= and
 *    GET /ideas/:id over the read-only indexer DB (503 without GATEWAY_INDEX_DB,
 *    404 unknown idea, 400 bad parameters)
 *  - `ws.ts`         — WS /ws: NIP-01 style REQ/CLOSE → EVENT/EOSE/NOTICE
 *    (parser + session + `attachWebSocket` via `@hono/node-server` 2.x)
 *  - `config.ts`     — env configuration (GATEWAY_* variables)
 *  - `server.ts`     — `@hono/node-server` startup (port 0 = any free port,
 *    WS upgrade on the same port)
 *  - `mcp/`          — MCP server S6 (F4AI-12): `forum_*` tools over the
 *    gateway REST, stdio + streamable-http transport, draft+publish split;
 *    `mcp/search.ts` is the F1 local scan — from S8 only a fallback after 503/404
 *  - `cli.ts`        — dev/prod entry point + `mcp` subcommand
 */
export {
  GATEWAY_PHASE,
  createGatewayApp,
  type GatewayOptions,
  type GatewayOutbox,
  type GatewayPool,
  type IndexStatus,
} from './app.js';

export {
  DEFAULT_DEV_RELAY_URLS,
  RelayPool,
  normalizeRelayUrl,
  parseRelayUrls,
  type PublishResult,
  type RelayConnector,
  type RelayLike,
  type RelayPoolOptions,
  type RelayStatus,
  type SubscribeHandlers,
  type SubscriptionLike,
} from './relay-pool.js';

export {
  OutboxWriter,
  writeRelaysFromOutboxEvent,
  type OutboxEntry,
  type OutboxOptions,
  type OutboxPool,
  type OutboxSource,
} from './outbox.js';

export { evaluateQuorum, type QuorumEvaluation } from './quorum.js';

export {
  NIP98_DEFAULT_MAX_SKEW_SECONDS,
  nip98Auth,
  verifyNip98Authorization,
  type Nip98MiddlewareOptions,
  type Nip98Variables,
  type Nip98Verification,
  type Nip98VerifyOptions,
} from './nip98.js';

export {
  buildGateway,
  resolveGatewayConfig,
  type GatewayConfig,
  type GatewayRuntime,
} from './config.js';

export {
  buildReplyTree,
  buildTopicTree,
  lwwByAddress,
  parentMarkerId,
  resolveRootId,
  rootMarkerId,
  sortFeedDesc,
  topicAddress,
  topicParentAddress,
  topicSlug,
  MAX_PARENT_HOPS,
  UNSORTED_SLUG,
  type ReplyNode,
  type ReplyTree,
  type TopicNode,
  type TopicTree,
} from './read-model.js';

export {
  eventSummary,
  registerReadRoutes,
  type ReadPool,
  type ReadRouteOptions,
} from './read-routes.js';

export {
  WsSession,
  attachWebSocket,
  parseClientMessage,
  validateFilter,
  WS_MAX_PAYLOAD_BYTES,
  WS_MAX_SUB_ID_LENGTH,
  WS_MAX_SUBSCRIPTIONS,
  type ParsedClientMessage,
  type WebSocketSetup,
  type WsPool,
  type WsServerMessage,
  type WsSessionLimits,
} from './ws.js';

export {
  startGatewayServer,
  type GatewayServerOptions,
  type RunningGateway,
} from './server.js';

// ── MCP server (F4AI-12, S6) ──────────────────────────────────────────────
export {
  GatewayClient,
  GatewayHttpError,
  buildFollowsDraft,
  buildIdeaClaimDraft,
  buildRatingDraft,
  buildVoteDraft,
  mergeFollows,
  normalizeForSearch,
  normalizeWithMap,
  searchEvents,
  registerForumTools,
  createForumMcpServer,
  runStdioMcp,
  startHttpMcp,
  resolveMcpConfig,
  runMcpCli,
  MCP_INSTRUCTIONS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  SEARCH_FETCH_DEFAULT,
  SEARCH_KINDS,
  SEARCH_LIMIT_DEFAULT,
  UNTRUSTED_NOTE,
  type CanonicalEventInput,
  type FetchLike,
  type GatewayClientOptions,
  type RecentItem,
  type SearchResultItem,
  type SearchResponse,
  type DraftEvent,
  type DraftBuilderOptions,
  type SearchMatch,
  type SearchableEvent,
  type RegisterToolsOptions,
  type ForumMcpServerOptions,
  type HttpMcpOptions,
  type RunningHttpMcp,
  type McpCliConfig,
  type McpTransportKind,
} from './mcp/index.js';

// ── Vyhľadávanie (F4AI-14, S8) ────────────────────────────────────────────
// `SEARCH_LIMIT_DEFAULT` zámerne NEexportujeme z `search.js` — to meno už
// zdieľa MCP konštanta z `mcp/tools.ts` (rovnaká hodnota 20, iný kontext).
export {
  FTS5_CHANNEL,
  IndexUnavailableError,
  RRF_K,
  SEARCH_DEADLINE_DEFAULT_MS,
  SEARCH_LIMIT_MAX,
  SearchInterruptedError,
  UnavailableIndexChannel,
  VECTOR_CHANNEL,
  VECTOR_STUB_REASON,
  Fts5SearchChannel,
  createVectorStubChannel,
  fusedToRanked,
  rrfFuse,
  type ChannelHits,
  type Fts5ChannelOptions,
  type FusedHit,
  type RankedHit,
  type SearchChannel,
  type SearchQueryOptions,
  type VectorStubChannel,
} from './search.js';

export {
  GATEWAY_SEARCH_PHASE,
  registerSearchRoutes,
  type SearchRouteOptions,
} from './search-routes.js';

// ── Reputácia (F4AI-15, S9) ───────────────────────────────────────────────
// `reputation.ts` sú ČISTÉ funkcie (žiadna sieť/IO) — Wilson lower bound,
// Kish n_eff, stropy agent/cluster/op, epoch watermark, per-doménová karta.
// `reputation-routes.ts` je IO vrstva čítajúca indexer DB read-only.
export {
  AGENT_CAP_DEFAULT,
  BASE_WEIGHT,
  CLUSTER_CAP_DEFAULT,
  OP_CAP_DEFAULT,
  REPUTATION_DOMAINS,
  REPUTATION_PHASE,
  REPUTATION_UNTRUSTED_NOTE,
  WILSON_Z_DEFAULT,
  acceptedSolutionTargets,
  acceptedThreadRefs,
  aggregateRatings,
  aggregateThreadRating,
  aggregateVotesPerTarget,
  capWeights,
  clusterKey,
  computeReputation,
  currentEpochOf,
  epochWeight,
  isReputationDomain,
  kishNEff,
  parseAcceptedEvent,
  parseRatingEvent,
  parseRatingScore,
  parseVoteDir,
  parseVoteEvent,
  signalEpoch,
  signalOp,
  signalRootRef,
  signalTarget,
  toSignalItem,
  wilsonLowerBound,
  type CapResult,
  type CappedItem,
  type DomainScore,
  type ParsedAccepted,
  type ParsedRating,
  type ParsedVote,
  type RatingAggregate,
  type RatingAggregateInput,
  type ReputationCard,
  type ReputationCounts,
  type ReputationDomainName,
  type ReputationParams,
  type SignalItem,
  type TargetAggregate,
  type ThreadRatingBody,
  type VoteAggregateInput,
} from './reputation.js';

export {
  REPUTATION_KINDS,
  REPUTATION_SCAN_LIMIT,
  ReputationIndexSource,
  registerReputationRoutes,
  type ReputationRouteOptions,
} from './reputation-routes.js';

// ── idea_call board (F4AI-16, S10) ────────────────────────────────────────
// `ideas.ts` sú ČISTÉ funkcie: parse 1021/10030, stavový automat
// (open→claimed→in_progress→review→done + cancelled, claimed→open),
// validácia claimu (`a` tag), LWW kanonicita (status = 10030 autora,
// cudzie sú suggestions) a zostavenie boardu; `ideas-routes.ts` je IO
// vrstva čítajúca indexer DB read-only (503 bez GATEWAY_INDEX_DB).
export {
  FINAL_IDEA_STATUSES,
  IDEA_STATUSES,
  IDEAS_PHASE,
  UNTITLED_IDEA,
  assembleIdeaBoard,
  assembleIdeaDetail,
  canTransition,
  filterIdeaRows,
  isIdeaStatus,
  latestStatusPerPublisher,
  parseIdeaCall,
  parseIdeaStatus,
  sortStatusesChronologically,
  validateClaim,
  type IdeaBoardFilters,
  type IdeaDetail,
  type IdeaRow,
  type IdeaStatus,
  type IdeaStatusEntry,
  type ParsedIdeaCall,
  type ParsedIdeaStatus,
  type TransitionCheck,
} from './ideas.js';

export {
  IDEAS_DEFAULT_LIMIT,
  IDEAS_KINDS,
  IDEAS_MAX_LIMIT,
  IDEAS_SCAN_LIMIT,
  IDEAS_TOPIC_MAX_LENGTH,
  IdeasIndexSource,
  registerIdeasRoutes,
  type IdeasRouteOptions,
} from './ideas-routes.js';

// ── federčné jadro (Phase 6a, dizajn Q5) ──────────────────────────────────
// `fed/` je PULL/PUSH sync medzi gatewaymi: `config.ts` píše upstreamy z
// `GATEWAY_UPSTREAM_GATEWAYS` (id = host URL), `db.ts` je vlastná SQLite
// gatewaya (`fed.db` — kurzory, remote eventy, push fronta s backoffom a
// dead-letterom), `engine.ts` drží PULL/PUSH/tick so split-horizon
// (vzdialený event sa späť neposiela) a `routes.ts` je `GET /fed/events`
// (čítacie rozhranie pre peers), `GET /fed/topics` (sekcia „Network"),
// `GET /fed/state` a `POST /fed/resync/:id` (NIP-98 owner).
// Indexer číta `fed.db` read-only (env `INDEXER_FED_DB`) — rovnaký vzor
// ako `INDEXER_OPERATORS_DB`.
export {
  FedEngine,
  FedDb,
  backoffDelayMs,
  fedEndpoint,
  openFedDb,
  parseUpstreamGateways,
  registerFedRoutes,
  FED_BACKOFF_INITIAL_MS_DEFAULT,
  FED_BACKOFF_MAX_MS_DEFAULT,
  FED_EVENTS_LIMIT_DEFAULT,
  FED_EVENTS_LIMIT_MAX,
  FED_HTTP_TIMEOUT_MS_DEFAULT,
  FED_INTERVAL_MS_DEFAULT,
  FED_MAX_ATTEMPTS_DEFAULT,
  FED_PULL_LIMIT_DEFAULT,
  FED_PUSH_BATCH_DEFAULT,
  type FedDbOptions,
  type FedEngineOptions,
  type FedQueueRow,
  type FedQueueStats,
  type FedReadPool,
  type FedRouteOptions,
  type FedUpstreamConfig,
  type FedUpstreamRow,
  type FedUpstreamState,
  type ParsedUpstreams,
  type PullSummary,
  type PushStatus,
  type PushSummary,
  type RemoteTopicRow,
  type TickSummary,
} from './fed/index.js';
