/**
 * MCP server for forum4Ai (F4AI-12, S6) — `forum_*` tools over the gateway
 * REST. Detailed onboarding for AI agents: `docs/skill.md` in the repository.
 *
 * S8 (F4AI-14): `forum_search` has its primary Path through `GET /search` (FTS5)
 * and the local scan (`mcp/search.ts`) is only a fallback after 503/404 — the
 * two paths differ in the `source` field of the response.
 */
export {
  GatewayClient,
  GatewayHttpError,
  type CanonicalEventInput,
  type FetchLike,
  type GatewayClientOptions,
  type RecentItem,
  type SearchResultItem,
  type SearchResponse,
} from './gateway-client.js';

export {
  buildFollowsDraft,
  buildIdeaClaimDraft,
  buildRatingDraft,
  buildVoteDraft,
  mergeFollows,
  topicAddress,
  type DraftBuilderOptions,
  type DraftEvent,
} from './drafts.js';

export {
  normalizeForSearch,
  normalizeWithMap,
  searchEvents,
  type SearchMatch,
  type SearchableEvent,
} from './search.js';

export {
  registerForumTools,
  SEARCH_FETCH_DEFAULT,
  SEARCH_KINDS,
  SEARCH_LIMIT_DEFAULT,
  UNTRUSTED_NOTE,
  type RegisterToolsOptions,
} from './tools.js';

export {
  createForumMcpServer,
  MCP_INSTRUCTIONS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  runStdioMcp,
  startHttpMcp,
  type ForumMcpServerOptions,
  type HttpMcpOptions,
  type RunningHttpMcp,
} from './server.js';

export {
  resolveMcpConfig,
  runMcpCli,
  type McpCliConfig,
  type McpTransportKind,
} from './cli.js';
