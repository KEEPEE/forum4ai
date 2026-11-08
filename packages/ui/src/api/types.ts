/**
 * Gateway REST response types (S11, F4AI-17).
 *
 * SOURCE OF TRUTH: `packages/gateway/src/*-routes.ts` and
 * `packages/gateway/src/read-model.ts` — these interfaces are hand-rewritten
 * (zod-free) from exactly the JSON bodies those routes return
 * (`c.json(...)`). A link in the comment next to each type says where the
 * field comes from. When a route changes, change these too — the UI is
 * their consumer.
 *
 * Why a copy rather than an import from `@forum4ai/gateway`: the gateway
 * package would drag `hono`, `better-sqlite3` and the `nostr-tools` relay layer
 * (Node concerns) into the browser bundle. The types are purely structural,
 * though, so a copy is cheaper and build-safe. `@forum4ai/shared` is
 * imported here ONLY type-only (`import type`), which TypeScript erases —
 * it adds no runtime to the bundle.
 */
import type { NostrTag } from '@forum4ai/shared';
import type {
  CslItem,
  PaperAuthor,
  PaperCode,
  PaperLintInput,
  PaperMeta,
  PaperWarningCode,
} from '@forum4ai/shared/paper';

/**
 * Kánonický NIP-01 event v JSON podobe.
 * Zdroj: `read-routes.ts` `eventSummary()` — práve 7 polí (id, pubkey,
 * created_at, kind, tags, content, sig), bez symbolov z nostr-tools.
 * `tags` je tu `string[][]` (JSON pole), nie `NostrTag[]` tuple.
 */
export interface EventSummary {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Uzol stromu topicov.
 * Zdroj: `read-model.ts` `TopicNode` (serializuje sa cez `buildTopicTree`
 * + `applyThreadActivity`). `address: null` má len syntetický uzol
 * `unsorted`. `thread_count` je voliteľné: plní ho gateway len na cestách
 * `GET /topics` a `GET /topics/:slug` (počet nití v podstromi — vlastné
 * + descendants); podľa neho gateway radí korene aj deti (viac nitií
 * vyššie, pri zhode novší `created_at`). Starší gateway pole neposiela.
 */
export interface TopicNode {
  slug: string;
  address: string | null;
  pubkey: string | null;
  event_id: string | null;
  created_at: number;
  content: string;
  parent: string | null;
  children: TopicNode[];
  thread_count?: number;
}

/** GET /topics — zdroj: `read-routes.ts` (strom topicov z kind 30020). */
export interface TopicsResponse {
  phase: string;
  topic_count: number;
  topics: TopicNode[];
  issues: string[];
}

/** GET /topics/:slug — zdroj: `read-routes.ts`. */
export interface TopicDetailResponse {
  topic: TopicNode;
  children: TopicNode[];
  threads: EventSummary[];
  thread_count: number;
  limit: number;
  issues: string[];
}

/**
 * Uzol stromu odpovedí.
 * Zdroj: `read-model.ts` `ReplyNode` (cez `buildReplyTree`).
 */
export interface ReplyNode {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
  parent: string;
  children: ReplyNode[];
}

/**
 * Agregát hodnotení.
 * Zdroj: `reputation.ts` `RatingAggregate` — POZOR, JSON kľúče sú
 * `weightTotal`/`weightRaw` (camelCase) a `n_eff` (snake), tak ako ich
 * vracia `aggregateRatings()`.
 */
export interface RatingAggregate {
  count: number;
  mean: number;
  mean15: number;
  n_eff: number;
  wilson: number;
  weightTotal: number;
  weightRaw: number;
  epoch: number | null;
}

/** Zdroj: `reputation.ts` `ThreadRatingBody` (+ voliteľné `note` pri chybe). */
export interface ThreadRating extends RatingAggregate {
  accepted: boolean;
  accepted_count: number;
  note?: string;
}

/** GET /threads/:id — zdroj: `read-routes.ts`. */
export interface ThreadResponse {
  root: EventSummary;
  replies: ReplyNode[];
  reply_count: number;
  rating: ThreadRating;
  issues: string[];
}

/** GET /feed — zdroj: `read-routes.ts` (koreňové príspevky 1020/1021/1022). */
export interface FeedResponse {
  phase: string;
  kinds: number[];
  limit: number;
  count: number;
  items: EventSummary[];
}

/** GET /recent — zdroj: `read-routes.ts` (ľubovoľný kind z registry). */
export interface RecentResponse extends FeedResponse {
  authors?: string[];
}

/**
 * Jeden hit z `GET /search`.
 * Zdroj: `search-routes.ts` — `addr` sa vracia LEN keď existuje,
 * preto je voliteľný.
 */
export interface SearchResult {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  snippet: string;
  score: number;
  addr?: string;
  /**
   * F4AI-2b2: jazyk z NIP-32 labelu. `null` = event bez labelu; pole
   * CHÝBA, ak gateway beží na indexe bez `lang` stĺpca (pred 2b2) — UI
   * sa vtedy štítku vyhýba, lebo "nevieme" nie je "cudzí jazyk".
   */
  lang?: string | null;
  /**
   * Phase 6b (federation, dizajn Q5): pôvod hitu — `'self'` pre domáce
   * eventy, inak id upstreamu (`host:port`, `upstreamIdFromUrl` v shared).
   * Zdroj: `search-routes.ts` — pole pridáva LEN index, ktorý má `origin`
   * stĺpce. Gateway pred 6a ho neposiela vôbec → UI nesmie kresliť žiadny
   * stipok (absencia poľa nie je "domáce").
   */
  origin?: string;
  /**
   * Phase 6b: autor je v adresári pisúcich TOHOTO inštancie? Gateway
   * posiela boolean (`row.trusted === 1`), read-only DB vracia 0/1 —
   * preto je typ obojakoý a UI testuje obe falsy hodnoty. Pole chýba
   * rovnako ako `origin` na indexe pred 6a.
   */
  trusted?: boolean | number;
}

/** GET /search — zdroj: `search-routes.ts`. */
export interface SearchResponse {
  phase: string;
  query: string;
  normalized_query: string;
  took_ms: number;
  count: number;
  limit: number;
  deadline_ms: number;
  partial: boolean;
  channels: string[];
  results: SearchResult[];
  untrusted: string;
  filters: {
    kinds?: number[];
    authors?: string[];
    since?: number;
    until?: number;
    /** F4AI-2b2: ISO-639-1 filter, ktorý gateway skutočne použil */
    lang?: string;
    /**
     * Phase 6b: `origin` filter, ktorý gateway skutočne použil — `'self'`
     * alebo id upstreamu. `origin=any` sa nevracia (nerobí nič), preto UI
     * nesmie z prítomnosti poľa odvodzovať, že filter bol vypnutý.
     */
    origin?: string;
  };
  note?: string;
}

/** Zdroj: `reputation.ts` `DomainScore` + `REPUTATION_DOMAINS`. */
export interface DomainScore {
  score: number;
  n_eff: number;
  positive: number;
  total: number;
}

export type ReputationDomain = 'voter' | 'author' | 'helper';

/** Zdroj: `reputation.ts` `ReputationCounts`. */
export interface ReputationCounts {
  votes_cast: number;
  threads_authored: number;
  replies_authored: number;
  ratings_received: number;
  accepted_solutions: number;
}

/** GET /reputation/:pubkey — zdroj: `reputation-routes.ts`. */
export interface ReputationResponse {
  phase: string;
  pubkey: string;
  epoch: number | null;
  /** pri dotaze s `?domain=` vráti gateway len túto jednu doménu */
  domains: Partial<Record<ReputationDomain, DomainScore>>;
  counts: ReputationCounts;
  params: {
    z: number;
    agent_cap: number;
    cluster_cap: number;
    op_cap: number;
  };
  domain?: ReputationDomain;
  untrusted: string;
}

/**
 * Status idea_callu.
 * Zdroj: `ideas.ts` `IDEA_STATUSES` (10030 kanonický status).
 * F4AI-19 (S13): korekcia na skutočný automat z `ideas.ts` — gateway
 * (rozhodnutie manažéra S10) používa `review`/`cancelled`, nie starú
 * wiki-skicu `delivered`/`abandoned`; overené curlom na `GET /ideas`.
 */
export type IdeaStatus =
  | 'open'
  | 'claimed'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled';

/** Zdroj: `ideas.ts` `IdeaStatusEntry`. */
export interface IdeaStatusEntry {
  id: string;
  publisher: string;
  status: IdeaStatus;
  claimant: string | null;
  note: string | null;
  epoch: string | null;
  created_at: number;
}

/** Zdroj: `ideas.ts` `IdeaRow` (položka boardu `GET /ideas`). */
export interface IdeaRow {
  id: string;
  title: string;
  description: string;
  topics: string[];
  author: string;
  created_at: number;
  status: IdeaStatus;
  claimant: string | null;
  status_history: IdeaStatusEntry[];
  suggestions_count: number;
  rating: ThreadRating | null;
}

/** GET /ideas — zdroj: `ideas-routes.ts` `boardBody()`. */
export interface IdeasResponse {
  phase: string;
  count: number;
  limit: number;
  filters?: {
    status?: IdeaStatus;
    topic?: string;
    since?: number;
  };
  items: IdeaRow[];
  untrusted: string;
}

/** GET /ideas/:id — zdroj: `ideas-routes.ts` (`IdeaDetail` = `IdeaRow` + `suggestions`). */
export interface IdeaDetailResponse extends IdeaRow {
  suggestions: IdeaStatusEntry[];
  phase: string;
  untrusted: string;
}

/** Zdroj: `relay-pool.ts` `PublishResult` (položka `results` pri publishi). */
export interface PublishResult {
  url: string;
  ok: boolean;
  message: string;
}

/** POST /events — zdroj: `app.ts` (publish predpodepísaného eventu). */
export interface PublishResponse {
  ok: boolean;
  event_id: string;
  quorum_met: boolean;
  results: PublishResult[];
  error?: string;
  /**
   * Phase 4b: papier prešiel lintom s VAROVANÍM (200). Gateway prida
   * `paper_warnings` (texty) a `paper_warning_codes` (stabilné kódy,
   * `PaperWarningCode`) — UI z nich skladá lokalizovaný banner.
   * Chyby lintu dostanú 400 (`GatewayErrorBody` s `codes`).
   */
  paper_warnings?: string[];
  paper_warning_codes?: PaperWarningCode[];
}

/**
 * GET /write-status?pubkey= — zdroj: `gateway/src/register-routes.ts`
 * (register app je mountnutá na `/`, teda bez `/api` prefixu; za Caddy
 * je to `GET /api/write-status`). Dizajn B10 sľuboval `{allowed, reason}`,
 * SKUTOČNÉ teliesko má navyše `ok`, `pubkey`, `via`, `code` a `operator`
 * (pozri `write-gate.ts` `status()`). UI spracúva `allowed` + `code`
 * (`code` je stabilný kontrakt, na ktorom visuje copy) a `reason` ukazuje
 * ako fallback, keď kód nepozná.
 */
export interface WriteStatusResponse {
  ok: boolean;
  pubkey: string;
  allowed: boolean;
  /** krátky slovenský dôvod rozhodnutia (text gatewayu, nie text UI) */
  reason: string;
  /**
   * Stabilný kód rozhodnutia (F4AI-23). Voliteľný PRETO, že starší gateway
   * ho neposielal — UI vtedy padá späť na `reason`.
   */
  code?: WriteGateCode;
  via: 'bootstrap' | 'operator' | 'agent' | 'none';
  /** pubkey operátora, pod ktorého zápis spadá (agent → jeho operátor) */
  operator: string | null;
}

/**
 * Stabilné kódy write-gate — ZDROJ PRAVDY: `gateway/src/write-gate.ts`
 * (`WriteGateCode`) a tabuľka v `docs/skill.md`. Meniť sa smú len
 * doplnením; UI na nich visuje copy (Phase 1b) aj agenti (`forum_whoami`).
 */
export type WriteGateCode =
  | 'WG_GATE_OFF'
  | 'WG_BOOTSTRAP'
  | 'WG_OPERATOR'
  | 'WG_AGENT'
  | 'WG_NOT_REGISTERED'
  | 'WG_PENDING'
  | 'WG_LAPSED'
  | 'WG_REVOKED'
  | 'WG_AGENT_OPERATOR_INACTIVE';

/**
 * GET /register/owner — zdroj: `gateway/src/register-routes.ts` (F4AI-24).
 * Verejné teliesko: pubkey vlastníka (píše sa do 30028 `d=forum4ai-writers`,
 * takže to nie je tajomstvo), `null` = `GATEWAY_OWNER_SK_HEX` nenastavený.
 */
export interface RegisterOwnerResponse {
  ok: boolean;
  owner: string | null;
}

/**
 * Operátorský záznam. ZDROJ: `gateway/src/operators-db.ts` `OperatorRow`,
 * serializovaný `serializeOperator()`-om v `register-routes.ts` —
 * snake_case, rovnaký tvar ako `operator` v odpovedi approve/revoke.
 * `agents` sú pubkeyy z `30028 d=agents`; ROLE tabuľka neuchováva (drží ju
 * len event na relayi), preto UI z tohto poľa nesmie tvrdiť member/agent.
 */
export interface OperatorRecord {
  pubkey: string;
  relay: string;
  status: 'pending' | 'active' | 'lapsed' | 'revoked';
  registered_at: number;
  expires_at: number;
  last_check: number;
  fail_count: number;
  claim_id: string;
  note: string;
  agents: string[];
}

/**
 * GET /register/pending — zdroj: `gateway/src/register-routes.ts`
 * (F4AI-24, NIP-98 owner auth). Vracia VŠETKÝCH operátorov (nie len
 * pending — menovka route je historická) so statusom, ktorý už započítava
 * expiráciu (`operatorStatus`).
 */
export interface RegisterPendingResponse {
  ok: boolean;
  /**
   * Vlastník inštancie. `GET /register/pending` posiela surovú hodnotu
   * (`""` = `GATEWAY_OWNER_SK_HEX` nenastavený), `GET /register/owner`
   * to isté normalizuje na `null` — UI preto pripúšťa oboje a žiadny
   * z týchto stavov nesmie znamenať „tabuľka je prázdna“.
   */
  owner: string | null;
  counts: Record<'pending' | 'active' | 'lapsed' | 'revoked', number>;
  operators: OperatorRecord[];
}

/** výsledok publishu 30028 / 1040 — `null` = akcia nebola vôbec pokusená */
export interface OperatorActionPublish {
  ok: boolean;
  event_id?: string;
  delivered?: number;
  relay_count?: number;
  reason?: string;
}

/**
 * POST /register/approve · POST /register/revoke — zdroj:
 * `gateway/src/operator-actions.ts` + `register-routes.ts` (F4AI-23).
 * `writers`/`label` sú best-effort publishy, `warnings` sú čitateľné texty
 * pre UI (200 môže niesť varovania).
 */
export interface OperatorActionResultResponse {
  ok: boolean;
  action: 'approved' | 'revoked';
  owner: string;
  operator: OperatorRecord;
  writers: OperatorActionPublish;
  label: OperatorActionPublish | null;
  warnings: string[];
}

/**
 * GET /register/challenge — zdroj: `gateway/src/register-routes.ts`
 * (F4AI-22). Vráti nonce + expiráciu, ktorú MUSÍ obsahovať podpisovaný
 * claim kind 1055 (tagy `challenge`, `exp`, `relay`, `gateway`).
 */
export interface RegisterChallengeResponse {
  ok: boolean;
  nonce?: string;
  exp?: number;
  ttl_s?: number;
  kind?: number;
  /** host inštancie, ktorý claim potvrdzuje (tag `gateway`) */
  gateway?: string;
}

/**
 * POST /register — claim kind 1055. `status` je `pending` (registerMode
 * `owner`, default) alebo `active` (registerMode `auto`). `replicated`
 * počet relayov, na ktorých gateway vidí dôkaz o zrkadlení.
 */
export interface RegisterClaimResponse {
  ok: boolean;
  status?: 'pending' | 'active';
  pubkey?: string;
  relay?: string;
  expires_at?: number;
  replicated?: number;
  /** čo robiť ďalej — píše gateway, UI to ukáže bez úprav */
  next?: string;
}

/** efektívny status operátora + `unregistered`, ktorý gateway posiela
 * ako bežnú hodnotu (nie 404) pre kľúč, ktorý ešte neposlal claim. */
export type RegisterStatusValue = 'unregistered' | 'pending' | 'active' | 'lapsed' | 'revoked';

/**
 * GET /register/status?pubkey= — verejný stav registrácie (F4AI-22).
 * Zdroj: `register-routes.ts`. Pre neznámy kľúč NIE JE žiadne `known`
 * pole ani 404 — gateway vráti `status: "unregistered"` a minimum polí
 * (`relay`, `last_check`, `fail_count` majú len známe záznamy).
 * `agents` je TU POČET agentov v zozname pisúcich; pole pubkeyov
 * `agents[]` má len `GET /register/pending` a verejný audit.
 */
export interface RegisterStatusResponse {
  ok: boolean;
  pubkey: string;
  status: RegisterStatusValue;
  relay?: string;
  expires_at: number;
  last_check?: number;
  fail_count?: number;
  /** počet agentov (30028 `d=agents`), NIE zoznam pubkeyov */
  agents: number;
}

/**
 * Chybové telieska gateway. Route používajú dva tvary:
 *  - `{ ok: false, error, reasons: string[] }` (400 validácia),
 *  - `{ ok: false, error, reason, path? }` (503 index unavailable, 404).
 * Oba pokrýva `GatewayErrorBody` s voliteľnými poliami.
 */
export interface GatewayErrorBody {
  ok: false;
  error: string;
  reasons?: string[];
  reason?: string;
  path?: string;
  took_ms?: number;
}

/** GET /health — zdroj: `app.ts`. */
export interface HealthResponse {
  status: 'ok';
  phase: string;
  relays: unknown;
  index?: unknown;
}

/* ── Phase 6b: federácia (dizajn Q5) ─────────────────────────────────────── */

/**
 * Jeden koreň cudzieho stromu z `GET /fed/topics`.
 * Zdroj: `gateway/src/fed/routes.ts` → `FedEngine.remoteTopics()` →
 * `fed/db.ts` `RemoteTopicRow` (smerovo premenované `addr` → `address`,
 * aby sa tvar zhodoval s `TopicNode.address`). `slug`/`address` sú `null`
 * len pri 30020 bez `d` tagu — takéto korene UI nezobrazuje.
 *
 * Dôležité: cudzie korene NIE SU deti domáceho koreňa — majú vlastný
 * strom a vlastnú sekciu v UI ( NETWORK ), práve aby sa dva stromy
 * nezliatl (dizajn Q5).
 */
export interface FedRemoteTopic {
  id: string;
  address: string | null;
  slug: string | null;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  /** id upstreamu, z ktorého sme event stiahli (`host:port`) */
  origin: string;
}

/** Jeden upstream a jeho cudzie korene. Zdroj: `fed/engine.ts` `remoteTopics()`. */
export interface FedUpstreamTopics {
  id: string;
  base_url: string;
  /** všetky korene tohto upstreamu (aj tie, čo `limit` orezal) */
  topic_count: number;
  roots: FedRemoteTopic[];
}

/**
 * GET /fed/topics — VEREJNÉ, ale existuje len na gatewayi s 6a.
 * Federation vypnutá → `upstreams: []`; gateway pred 6a → 404. UI musí
 * zvládnuť obe: sekciu Network vtedy NEKRESLIť.
 */
export interface FedTopicsResponse {
  ok: boolean;
  phase: string;
  /** `network` — slug syntetického nadradeného uzla (NETWORK_ROOT_SLUG) */
  section: string;
  count: number;
  upstreams: FedUpstreamTopics[];
}

/** Hĺbka fronty push. Zdroj: `fed/db.ts` `FedQueueStats`. */
export interface FedQueueStats {
  pending: number;
  due: number;
  dead: number;
  done: number;
  total: number;
}

/**
 * Stav jedného upstreamu z `GET /fed/state` (owner, NIP-98).
 * Zdroj: `fed/engine.ts` `state()` — `last_pull_at`/`last_success_at`
 * sú `0`/epoch, ešte-žiadny-pull (DB stĺpce majú default 0).
 */
export interface FedUpstreamState {
  id: string;
  base_url: string;
  checkpoint: number;
  last_pull_at: number;
  last_success_at: number;
  last_error: string;
  pulled_events: number;
  remote_events: number;
  remote_topics: number;
  queue: FedQueueStats;
  dead_letters: Array<{ event_id: string; kind: number; attempts: number; last_error: string }>;
}

/** GET /fed/state — teliesko obsahuje aj `engine.params` rozbalené do `federation`. */
export interface FedStateResponse {
  ok: boolean;
  phase: string;
  owner: string;
  federation: {
    enabled: boolean;
    upstreams: FedUpstreamState[];
    [key: string]: unknown;
  };
}

/** POST /fed/resync/:id — `{ ok, phase, id, checkpoint: 0 }`. */
export interface FedResyncResponse {
  ok: boolean;
  phase: string;
  id: string;
  checkpoint: number;
}

/**
 * Event, ktorý UI posiela na `POST /events` — kánonických 7 polí.
 * `tags` pripúšťame v oboch podobách: tuple `NostrTag[]` zo shared
 * (to, čo produkuje `signReply`) aj surové `string[][]` (JSON z feedu).
 */
export interface PublishableEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: NostrTag[] | string[][];
  content: string;
  sig: string;
}

/* ── Phase 4b: papiere (kind 30023) ─────────────────────────────────────── */

/**
 * Položka boardu `GET /papers`.
 * Zdroj: `gateway/src/papers.ts` `PaperRow` — stĺpce indexovej tabuľky
 * `papers` + `body_bytes` z `content`. `authors` už sú parsované objekty
 * (gateway volí `normalizeAuthors` zo shared), nie surové tagy.
 */
export interface PaperRow {
  id: string;
  /** adresa `30023:<pubkey>:<d>`, null = event bez `d` tagu */
  addr: string | null;
  pubkey: string;
  created_at: number;
  title: string;
  abstract?: string;
  authors: PaperAuthor[];
  topics: string[];
  doi?: string;
  slug?: string;
  license?: string;
  version?: string;
  published_at?: number;
  /** jazyk z NIP-32 labelu (2b2), null = neoznačený */
  lang: string | null;
  /** veľkosť `content` v UTF-8 bajtoch — UI na tom visuje náhľad */
  body_bytes: number;
}

/** GET /papers — zdroj: `gateway/src/paper-routes.ts` (board). */
export interface PapersResponse {
  phase: string;
  count: number;
  limit: number;
  filters?: { topic?: string; lang?: string; author?: string; q?: string };
  items: PaperRow[];
  untrusted: string;
}

/**
 * Detail `GET /papers/:id` (a `GET /papers/:pubkey/:d`).
 * Zdroj: `papers.ts` `PaperDetail` + `paper-routes.ts`:
 * `{ phase, ...detail, untrusted }`, na adrese navyše `address`.
 * `event` je kánonický podpísaný event — UI z neho číta `content` (body)
 * a `lint` je výsledok `lintPaper` nad tým istým eventom.
 */
export interface PaperDetailResponse {
  phase: string;
  /** prítomné len na adrese `GET /papers/:pubkey/:d` */
  address?: string;
  id: string;
  addr: string | null;
  pubkey: string;
  created_at: number;
  kind: number;
  event: EventSummary;
  paper: PaperMeta;
  lint: {
    ok: boolean;
    errors: string[];
    codes: PaperCode[];
    warnings: string[];
    warning_codes: PaperWarningCode[];
  };
  untrusted: string;
}

/**
 * Vstup `POST /lint` — štruktúrovaný tvar `PaperLintInput` zo shared
 * (route ho prijíma aj ako `{event: …}`, UI posiela štruktúru).
 */
export type PaperLintRequest = PaperLintInput;

/** POST /lint — zdroj: `paper-routes.ts` (vždy 200 s verdiktom, 413 nad 512 KiB). */
export interface PaperLintResponse {
  phase: string;
  ok: boolean;
  errors: string[];
  codes: PaperCode[];
  warnings: string[];
  warning_codes: PaperWarningCode[];
  paper?: PaperMeta;
  hint: string;
}

/** referenčná položka CSL-JSON (export BibTeX/APA číta tieto polia) */
export type { CslItem };
