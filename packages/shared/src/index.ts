export {
  KINDS,
  ALLOWED_KINDS,
  THREAD_ROOT_KINDS,
  ADDRESSABLE_KINDS,
  CONTENT_LANG_KINDS,
  isAllowedKind,
  isAddressableKind,
  isContentLangKind,
} from './kinds.js';
export type { KindName, KindValue } from './kinds.js';

export { ok, fail, failIssues } from './types.js';
export type {
  NostrEvent,
  NostrTag,
  UnsignedNostrEvent,
  ReferenceMarker,
  ValidationCode,
  ValidationIssue,
  ValidationResult,
} from './types.js';

// F4AI-2b2: NIP-32 jazykové označenie obsahu — jeden zdroj pravdy pre
// gateway (validácia + stamping pri draftoch), indexer (lang stĺpec),
// UI (badge) aj seed skripty. Konvencia tagov je zdokumentovaná v module.
export {
  LANG_NAMESPACE,
  LANG_NAMESPACE_TAG,
  LANG_VALUE_TAG,
  DEFAULT_CONTENT_LANG,
  ISO_639_1,
  isKnownLangCode,
  normalizeLangCode,
  langTags,
  compactLangTag,
  readContentLang,
  isInvalidLangHit,
  parseContentLang,
} from './languages.js';
export type { LangTagHit } from './languages.js';

export { verifyFull } from './verify.js';

// Phase 6a (dizajn Q5): federácia — tvár `origin`, konštanta sekcie
// „Network" a kindy federovaného overlaya. Čistý modul bez I/O, aby ho
// vedel importovať gateway, indexer aj UI (čip 6b) z jedného zdroja.
export {
  ORIGIN_SELF,
  NETWORK_ROOT_SLUG,
  NETWORK_SECTION_LABEL,
  FED_SYNC_KINDS,
  FED_SYNC_KIND_SET,
  isFedSyncKind,
  isSelfOrigin,
  normalizeOrigin,
  upstreamIdFromUrl,
  addressOf,
  topicAddress,
  parseAddress,
  type EventOrigin,
} from './federation.js';

// Phase 6a: NIP-13 PoW helper — jeden zdroj pravdy pre gateway (republish
// 30028), `scripts/seed-paper.mjs --pow N` aj testy. `countLeadingZeroBits`
// je ekvivalent nostr-tools `nip13.getPow` (krížovo overené testom).
export {
  MAX_POW_NONCE,
  countLeadingZeroBits,
  minePowNonce,
  signWithPow,
  type PowInput,
} from './pow.js';

// FTS5 match-query builder zdieľaný indexerom (zapisuje aj dopytuje) a
// gatewayom (read-only GET /search nad indexer DB) — detail v `search.ts`
export { buildMatchQuery } from './search.js';

// Phase 3b (dizajn Q3): Chart DSL v1 — čistý validátor bez I/O, ktorý zdieľa
// UI (render ```chart zárezu), gateway lint a MCP lint (Phase 4). UI vie
// importovať aj subpathom `@forum4ai/shared/chart-dsl`, aby si do bundle
// neťahalo celý index (nostr-tools závislosti).
export {
  validateChartDsl,
  CHART_TYPES,
  CHART_SCALES,
  CHART_DSL_MAX_JSON_BYTES,
  CHART_DSL_MAX_SERIES,
  CHART_DSL_MAX_POINTS,
  CHART_DSL_MAX_CATEGORIES,
} from './chart-dsl.js';
export type {
  ChartDsl,
  ChartDslValidation,
  ChartAxisX,
  ChartAxisY,
  ChartSeries,
  ChartPoint,
  ChartPointPair,
  ChartType,
  ChartScale,
} from './chart-dsl.js';

export {
  findTags,
  rootMarkers,
  validateKind,
  validatePostRootMarker,
  validateTopic,
  validateEventStructure,
  validateEvent,
  CREATED_AT_MAX_FUTURE_S,
  // A7 (P0, security review): zdieľané stropy a spodná hranica created_at —
  // gateway (`POST /events`) aj relay (politika) jedia z toho istého zdroja
  CREATED_AT_MIN_S,
  MAX_CONTENT_BYTES,
  MAX_TAGS,
  MAX_TAG_ELEMENT_BYTES,
  utf8ByteLength,
} from './validators.js';

// Phase 4a (dizajn Q4): per-kind veľkostné stropy + rich-content stropy z
// Q3. `MAX_CONTENT_BYTES`/`MAX_TAGS`/`MAX_TAG_ELEMENT_BYTES` už idú z
// `validators.js` (re-export), tu sú len NOVÉ mená. UI si neťahá koreň
// balíka (nostr-tools) — importuje subpath `@forum4ai/shared/limits`.
export {
  MAX_CONTENT_BYTES_BY_KIND,
  MAX_TAGS_BY_KIND,
  contentLimitForKind,
  tagsLimitForKind,
  MERMAID_MAX_TEXT_SIZE,
  MERMAID_MAX_EDGES,
  MAX_RICH_BLOCKS_PER_POST,
} from './limits.js';

// Phase 4a: metadata fence info stringu (`fig=` / `caption=`) — presunuté z
// UI, aby gateway lint nekopíroval logiku. UI re-exportuje z RichContent.
export { parseFenceMeta, parseFenceAttrs } from './fence-meta.js';
export type { FenceMeta } from './fence-meta.js';

// Phase 4a (dizajn Q4): papierový profil kindu 30023 — validátor, lint,
// CSL-JSON referencie a skeny krížových odkazov/citácií. Zdieľa ho gateway
// (400 + `paper_warnings[]`), MCP (`forum_lint_paper`), indexer (stĺpce) aj
// UI editor/čitačka (Phase 4b).
export {
  PAPER_KIND,
  MAX_PAPER_TITLE_CHARS,
  MAX_PAPER_AUTHORS,
  MIN_PAPER_AUTHORS,
  MAX_PAPER_AUTHOR_NAME_CHARS,
  MAX_PAPER_AFFILIATION_CHARS,
  MAX_PAPER_ABSTRACT_BYTES,
  MAX_PAPER_TOPIC_CHARS,
  MAX_PAPER_BODY_BYTES,
  MAX_PAPER_WARNINGS,
  lintPaper,
  validatePaperEvent,
  paperInputFromEvent,
  buildPaperTags,
  buildPaperBody,
  slugifyPaperTitle,
  normalizeAuthors,
  normalizeTopics,
  scanFences,
  proseOnly,
  referencesFences,
  collectCitations,
  collectCrossRefs,
  collectDeclaredRefs,
  parseCslReferences,
  validateCslArray,
} from './paper.js';
export type {
  PaperAuthor,
  PaperCode,
  PaperWarningCode,
  PaperMeta,
  PaperLintInput,
  PaperValidation,
  CslItem,
  CslPerson,
  MarkdownFence,
  ReferencesParse,
} from './paper.js';

// ── adresár pisúcich / agentov (dizajn B5–B7, Phase 6a presun zo shared) ──
// 30028 `d=forum4ai-writers` (vlastník inštancie) a 30028 `d=agents`
// (operátor). Parser je čistá funkcia a Phase 6a (dizajn Q5) ho presunul z
// gatewaya SEM, lebo ho potrebuje aj indexer druhej inštancie
// (`INDEXER_TRUST_DIRECTORIES`) — dve verzie parsera by sa rozšly.
export {
  AGENTS_D_TAG,
  MAX_AGENT_TAGS,
  MAX_FAILED_CHECKS,
  MAX_WRITER_TAGS,
  REGISTRATION_TTL_S,
  RESAMPLE_INTERVAL_S,
  WRITER_ROLES,
  WRITERS_D_TAG,
  buildWritersContent,
  buildWritersTags,
  isAgentsEvent,
  isWritersEvent,
  parseAgentsEvent,
  parseWritersEvent,
} from './writers.js';
export type {
  AgentEntry,
  OperatorStatus,
  ParsedWriters,
  WriterEntry,
  WriterRole,
} from './writers.js';
