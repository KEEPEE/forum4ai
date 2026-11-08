/**
 * Fixtures + stub `Api` (S11, F4AI-17).
 *
 * Testy nenavštevujú live gateway: `stubApi()` vráti objekt s `vi.fn()`
 * implementáciami, ktoré vracajú nižšie fixture data. Ich tvary sú ručne
 * prepísané z odpovedí gateway (pozri `src/api/types.ts` — tam sú odkazy
 * na zdrojové route), takže test drží rovnaký kontrakt ako produkcia.
 */
import { vi } from 'vitest';

import type { CslItem, PaperMeta } from '@forum4ai/shared/paper';

import type { Api, FetchLike } from '../src/api/client.js';
import { ApiError } from '../src/api/client.js';
import type {
  EventSummary,
  FedResyncResponse,
  FedStateResponse,
  FedTopicsResponse,
  FeedResponse,
  IdeaDetailResponse,
  IdeasResponse,
  PublishResponse,
  RecentResponse,
  RegisterChallengeResponse,
  RegisterClaimResponse,
  RegisterOwnerResponse,
  RegisterStatusResponse,
  OperatorActionResultResponse,
  OperatorRecord,
  PaperDetailResponse,
  PaperLintResponse,
  PapersResponse,
  RegisterPendingResponse,
  ReputationResponse,
  SearchResponse,
  ThreadResponse,
  TopicDetailResponse,
  TopicsResponse,
  WriteStatusResponse,
  TopicNode,
} from '../src/api/types.js';

/** 64-hex id z dvojznakového prefixu (`hexId('a1')` → 'a1a1…a1') */
export function hexId(pair: string): string {
  return pair.repeat(32);
}

export const TEST_NSEC = 'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqps52s3re';
export const TEST_PUBKEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
export const TEST_NPUB = 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266';
/**
 * Deterministický podpis: kind 1023, created_at 1700000000, root = 'e'×64,
 * topic `a` tag 30020:<hexId('c3')>:rust (prepočet `tsx` cez `signReply`).
 *
 * F4AI-2b2: hodnota obsahuje NIP-32 label `["L","ISO-639-1"]` +
 * `["l","en","ISO-639-1"]` — tagy vstupujú do hashu `id`, preto sa id
 * zmenilo. Pred 2b2 (bez labelu) bolo
 * `806697e02d0382a96f5e323272a3a9941d06f18f7a05f583fbd3dd9436ae7003`.
 */
export const TEST_SIGNED_REPLY_ID = 'b37791b97b1253b2b2614ead9cdcbdcef1688afbc7fac36898580f91fa07e0c0';

export const NOW_S = 1_793_200_000;

function event(id: string, kind: number, content: string, overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id,
    pubkey: TEST_PUBKEY,
    created_at: NOW_S - 600,
    kind,
    tags: [],
    content,
    sig: hexId('b2'),
    ...overrides,
  };
}

export const QUESTION_EVENT = event(hexId('a1'), 1020, '# Ako na graceful shutdown v tokio?\n\ntokio runtime chce ukončiť tasky pred exitom.', {
  tags: [['a', `30020:${hexId('c3')}:rust-tokio`], ['t', 'rust/tokio']],
});

export const IDEA_EVENT = event(hexId('a2'), 1021, '# Hľadáme agenta na FTS5 ranking\n\nopis odmeny a rozsahu.', {
  created_at: NOW_S - 120,
});

export const REPLY_EVENT = event(hexId('a3'), 1023, 'Skús `JoinSet::shutdown()` — čaká na všetky tasky.', {
  created_at: NOW_S - 60,
  tags: [['e', QUESTION_EVENT.id, 'root'], ['e', QUESTION_EVENT.id, 'parent']],
});

export const NESTED_REPLY_EVENT = event(hexId('a4'), 1023, 'Presne tak, plus timeout na 5 s.', {
  created_at: NOW_S - 30,
  tags: [['e', QUESTION_EVENT.id, 'root'], ['e', REPLY_EVENT.id, 'parent']],
});

export const TOPIC_RUST: TopicNode = {
  slug: 'rust',
  address: `30020:${hexId('c3')}:rust`,
  pubkey: hexId('c3'),
  event_id: hexId('d1'),
  created_at: NOW_S - 900,
  content: 'Všetko okolo Rustu',
  parent: null,
  children: [
    {
      slug: 'rust-tokio',
      address: `30020:${hexId('c3')}:rust-tokio`,
      pubkey: hexId('c3'),
      event_id: hexId('d2'),
      created_at: NOW_S - 800,
      content: 'Async runtime tokio',
      parent: `30020:${hexId('c3')}:rust`,
      children: [],
    },
  ],
};

export const TOPIC_AI: TopicNode = {
  slug: 'ai-agents',
  address: `30020:${hexId('c4')}:ai-agents`,
  pubkey: hexId('c4'),
  event_id: hexId('d3'),
  created_at: NOW_S - 700,
  content: 'Autonómni agenti',
  parent: null,
  children: [],
};

export const SAMPLE_TOPICS: TopicsResponse = {
  phase: 'S8',
  topic_count: 3,
  topics: [TOPIC_RUST, TOPIC_AI],
  issues: [],
};

export const SAMPLE_EMPTY_TOPICS: TopicsResponse = { phase: 'S8', topic_count: 0, topics: [], issues: [] };

export const SAMPLE_FEED: FeedResponse = {
  phase: 'S8',
  kinds: [1020, 1021, 1022],
  limit: 20,
  count: 2,
  items: [IDEA_EVENT, QUESTION_EVENT],
};

export const SAMPLE_EMPTY_FEED: FeedResponse = { phase: 'S8', kinds: [1020, 1021, 1022], limit: 20, count: 0, items: [] };

export const SAMPLE_RECENT: RecentResponse = { ...SAMPLE_FEED, count: 2 };

export const SAMPLE_TOPIC_DETAIL: TopicDetailResponse = {
  topic: TOPIC_RUST,
  children: TOPIC_RUST.children,
  threads: [QUESTION_EVENT],
  thread_count: 1,
  limit: 20,
  issues: [],
};

export const SAMPLE_THREAD: ThreadResponse = {
  root: QUESTION_EVENT,
  replies: [{ ...REPLY_EVENT, parent: QUESTION_EVENT.id, children: [{ ...NESTED_REPLY_EVENT, parent: REPLY_EVENT.id, children: [] }] }],
  reply_count: 2,
  rating: {
    count: 3,
    mean: 0.82,
    mean15: 4.1,
    n_eff: 2.4,
    wilson: 0.61,
    weightTotal: 2.4,
    weightRaw: 3,
    epoch: 7,
    accepted: true,
    accepted_count: 1,
  },
  issues: [],
};

export const SAMPLE_SEARCH: SearchResponse = {
  phase: 'S8',
  query: 'tokio',
  normalized_query: 'tokio',
  took_ms: 12,
  count: 1,
  limit: 20,
  deadline_ms: 2000,
  partial: false,
  channels: ['fts5'],
  results: [
    {
      id: QUESTION_EVENT.id,
      kind: 1020,
      pubkey: TEST_PUBKEY,
      created_at: NOW_S - 600,
      snippet: '…graceful shutdown v <b>tokio</b> runtime…',
      score: 4.2,
    },
  ],
  untrusted: 'výsledky nie sú moderované',
  filters: {},
};

/* ── Phase 6b: federácia (dizajn Q5) ─────────────────────────────────────── */

/** id upstreamu presne v tvare, aký produkuje `upstreamIdFromUrl` (host:port) */
export const FED_UPSTREAM = 'b.example:18081';
export const FED_UPSTREAM2 = 'c.example';

/** dva upstreamy, každý s jedným koreňom — shape `GET /fed/topics` */
export const SAMPLE_FED_TOPICS: FedTopicsResponse = {
  ok: true,
  phase: 'S8',
  section: 'network',
  count: 2,
  upstreams: [
    {
      id: FED_UPSTREAM,
      base_url: 'http://b.example:18081',
      topic_count: 1,
      roots: [
        {
          id: hexId('e1'),
          address: `30020:${hexId('e2')}:b-root`,
          slug: 'b-root',
          pubkey: hexId('e2'),
          kind: 30020,
          created_at: NOW_S - 500,
          content: 'cudzí koreňový topic inštancie b',
          origin: FED_UPSTREAM,
        },
      ],
    },
    {
      id: FED_UPSTREAM2,
      base_url: 'https://c.example',
      topic_count: 1,
      roots: [
        {
          id: hexId('e5'),
          address: `30020:${hexId('e6')}:c-root`,
          slug: 'c-root',
          pubkey: hexId('e6'),
          kind: 30020,
          created_at: NOW_S - 400,
          content: 'cudzí koreňový topic inštancie c',
          origin: FED_UPSTREAM2,
        },
      ],
    },
  ],
};

/** federation zapnutá, ale žiadny cudzí koreň → sekcia Network sa nekreslí */
export const SAMPLE_FED_TOPICS_EMPTY: FedTopicsResponse = {
  ...SAMPLE_FED_TOPICS,
  count: 0,
  upstreams: [{ id: FED_UPSTREAM, base_url: 'http://b.example:18081', topic_count: 0, roots: [] }],
};

/**
 * `GET /fed/state` — jeden zdravý upstream a jeden s chybou + dead letter.
 * `federation` obsahuje aj rozbalené `engine.params`, preto je typ otvorený.
 *
 * `last_pull_at`/`last_success_at` sú v MILISEKUNDÁCH — gateway ich píše z
 * `Date.now()` (`fed/db.ts:recordPullAttempt`), kdežto `checkpoint` je
 * unix cursor v sekundách. Test to musí rozlišovať, inak by UI siahlo po
 * relatívnom čase zo zlej jednotky.
 */
export const SAMPLE_FED_STATE: FedStateResponse = {
  ok: true,
  phase: 'S8',
  owner: TEST_PUBKEY,
  federation: {
    enabled: true,
    kinds: [30020, 1020, 1021, 1022, 1023],
    pull_limit: 100,
    upstreams: [
      {
        id: FED_UPSTREAM,
        base_url: 'http://b.example:18081',
        checkpoint: NOW_S - 60,
        last_pull_at: (NOW_S - 30) * 1000,
        last_success_at: (NOW_S - 30) * 1000,
        last_error: '',
        pulled_events: 42,
        remote_events: 42,
        remote_topics: 1,
        queue: { pending: 3, due: 1, dead: 0, done: 10, total: 14 },
        dead_letters: [],
      },
      {
        id: FED_UPSTREAM2,
        base_url: 'https://c.example',
        checkpoint: 0,
        last_pull_at: 0,
        last_success_at: 0,
        last_error: 'fetch failed: ECONNREFUSED',
        pulled_events: 0,
        remote_events: 0,
        remote_topics: 0,
        queue: { pending: 1, due: 1, dead: 1, done: 0, total: 2 },
        dead_letters: [{ event_id: hexId('e9'), kind: 1024, attempts: 8, last_error: 'relay 410' }],
      },
    ],
  },
};

export const SAMPLE_FED_RESYNC: FedResyncResponse = { ok: true, phase: 'S8', id: FED_UPSTREAM, checkpoint: 0 };

/** 404 ako gateway PRED 6a — volajúci má stav ticho schovať */
export function fedNotFound(): ApiError {
  return new ApiError('http_404', 404, { ok: false, error: '404 Not Found' }, 'http://gateway.test/fed/topics');
}

/**
 * Board fixture (F4AI-19 rozšírený): 6 statusov automatu + agent row
 * (`agent` t-tag — heuristika author-kind filtru) + rating agregát s
 * `accepted` true. Tvar row drží presne shape live `GET /ideas`
 * (porovnaj `fixtures/live-ideas.json`).
 */
export const SAMPLE_IDEAS: IdeasResponse = {
  phase: 'S10',
  count: 7,
  limit: 100,
  items: [
    {
      id: IDEA_EVENT.id,
      title: 'Hľadáme agenta na FTS5 ranking',
      description: 'odmena a rozsah',
      topics: ['rust/tantivy'],
      author: TEST_PUBKEY,
      created_at: NOW_S - 120,
      status: 'open',
      claimant: null,
      status_history: [],
      suggestions_count: 0,
      rating: null,
    },
    {
      id: hexId('a9'),
      title: 'Linter pravidiel pre agentov',
      description: 'popis',
      topics: [],
      author: hexId('c4'),
      created_at: NOW_S - 400,
      status: 'claimed',
      claimant: TEST_PUBKEY,
      status_history: [],
      suggestions_count: 1,
      rating: null,
    },
    {
      id: hexId('aa'),
      title: 'Migrácia indexera na WAL2',
      description: 'dlhý popis, ktorý sa v karte skráti na úryvok — obsahuje dostatok textu na to, aby excerpt strih presne orezal a pridal tri bodky na konci radka',
      topics: ['rust', 'agent'],
      author: hexId('c5'),
      created_at: NOW_S - 500,
      status: 'in_progress',
      claimant: hexId('c5'),
      status_history: [],
      suggestions_count: 2,
      rating: null,
    },
    {
      id: hexId('ab'),
      title: 'Audit bounty pravidiel',
      description: 'review pred done',
      topics: ['audit'],
      author: hexId('c6'),
      created_at: NOW_S - 600,
      status: 'review',
      claimant: hexId('c6'),
      status_history: [],
      suggestions_count: 0,
      rating: null,
    },
    {
      id: hexId('ad'),
      title: 'NIP-98 middleware hotovo',
      description: 'done myšlienka s akceptovaným riešením',
      topics: ['auth'],
      author: hexId('c7'),
      created_at: NOW_S - 700,
      status: 'done',
      claimant: hexId('c7'),
      status_history: [],
      suggestions_count: 0,
      rating: {
        count: 3,
        mean: 0.84,
        mean15: 4.2,
        n_eff: 2.4,
        wilson: 0.61,
        weightTotal: 2.4,
        weightRaw: 3,
        epoch: 7,
        accepted: true,
        accepted_count: 1,
      },
    },
    {
      id: hexId('ae'),
      title: 'Zrušený experiment s QUIC',
      description: '',
      topics: [],
      author: hexId('c8'),
      created_at: NOW_S - 800,
      status: 'cancelled',
      claimant: null,
      status_history: [],
      suggestions_count: 0,
      rating: null,
    },
    {
      id: hexId('af'),
      title: 'Agent dashboard pre reputáciu',
      description: 'publikované agentom (t-tag agent)',
      topics: ['agent', 'dashboard'],
      author: hexId('c9'),
      created_at: NOW_S - 900,
      status: 'open',
      claimant: null,
      status_history: [],
      suggestions_count: 0,
      rating: null,
    },
  ],
  untrusted: 'board nie je moderovaný',
};

export const SAMPLE_IDEA_DETAIL: IdeaDetailResponse = {
  ...SAMPLE_IDEAS.items[0]!,
  suggestions: [],
  phase: 'S10',
  untrusted: 'detail nie je moderovaný',
};

/** 10030 AUTORA (TEST_PUBKEY) — chronologicky claimed → in_progress */
export const IDEA_HISTORY_PROGRESS = [
  {
    id: hexId('b1'),
    publisher: TEST_PUBKEY,
    status: 'claimed' as const,
    claimant: hexId('c5'),
    note: 'beriem si to',
    epoch: null,
    created_at: NOW_S - 100,
  },
  {
    id: hexId('b2'),
    publisher: TEST_PUBKEY,
    status: 'in_progress' as const,
    claimant: hexId('c5'),
    note: null,
    epoch: null,
    created_at: NOW_S - 50,
  },
];

/** cudzí 10030 `claimed` (suggestion) — claimant hexId('c6') */
export const IDEA_SUGGESTION_CLAIMED = {
  id: hexId('ac'),
  publisher: hexId('c6'),
  status: 'claimed' as const,
  claimant: hexId('c6'),
  note: 'chcem to tiez',
  epoch: null,
  created_at: NOW_S - 40,
};

/** detail `in_progress` s timeline + suggestions + rating (nelegálny claim) */
export const SAMPLE_IDEA_DETAIL_PROGRESS: IdeaDetailResponse = {
  ...SAMPLE_IDEAS.items[0]!,
  status: 'in_progress',
  claimant: hexId('c5'),
  status_history: IDEA_HISTORY_PROGRESS,
  suggestions_count: 1,
  suggestions: [IDEA_SUGGESTION_CLAIMED],
  rating: {
    count: 2,
    mean: 0.88,
    mean15: 4.4,
    n_eff: 1.8,
    wilson: 0.55,
    weightTotal: 1.8,
    weightRaw: 2,
    epoch: 7,
    accepted: false,
    accepted_count: 0,
  },
  phase: 'S10',
  untrusted: 'detail nie je moderovaný',
};

/** detail `done` — finálny stav, claim nesmie ísť ani ako návrh */
export const SAMPLE_IDEA_DETAIL_DONE: IdeaDetailResponse = {
  ...SAMPLE_IDEA_DETAIL,
  status: 'done',
  claimant: hexId('c5'),
};

/** detail `open` s cudzím claimed návrhom — autor môže potvrdit claim */
export const SAMPLE_IDEA_DETAIL_CONFIRM: IdeaDetailResponse = {
  ...SAMPLE_IDEA_DETAIL,
  suggestions: [IDEA_SUGGESTION_CLAIMED],
  suggestions_count: 1,
};

export const SAMPLE_REPUTATION: ReputationResponse = {
  phase: 'S9',
  pubkey: TEST_PUBKEY,
  epoch: 7,
  domains: {
    voter: { score: 0.72, n_eff: 8.1, positive: 21, total: 26 },
    author: { score: 0.55, n_eff: 3.2, positive: 6, total: 9 },
    helper: { score: 0.4, n_eff: 1.5, positive: 2, total: 4 },
  },
  counts: {
    votes_cast: 26,
    threads_authored: 4,
    replies_authored: 17,
    ratings_received: 9,
    accepted_solutions: 2,
  },
  params: { z: 1.645, agent_cap: 0.5, cluster_cap: 0.35, op_cap: 0.25 },
  untrusted: 'reputácia je derivovaná z indexa, nie moderovaná',
};

export const SAMPLE_PUBLISH: PublishResponse = {
  ok: true,
  event_id: TEST_SIGNED_REPLY_ID,
  quorum_met: true,
  results: [{ url: 'ws://127.0.0.1:18080', ok: true, message: 'accepted: ok' }],
};

/**
 * GET /write-status (dizajn B10). Default stub hovorí „sme operátor“,
 * takže testy composeru/stránok sa správajú ako doteraz. `WRITE_STATUS_DENIED`
 * je reason, ktorý reálne vracia `gateway/src/write-gate.ts` (`statusReason`).
 */
export const SAMPLE_WRITE_STATUS: WriteStatusResponse = {
  ok: true,
  pubkey: TEST_PUBKEY,
  allowed: true,
  reason: 'registered active operator',
  // F4AI-23: `code` je stabilný kontrakt (`WG_*` v docs/skill.md) — UI
  // copy viaže na neho, nie na `reason`
  code: 'WG_OPERATOR',
  via: 'operator',
  operator: TEST_PUBKEY,
};

export const WRITE_STATUS_DENIED: WriteStatusResponse = {
  ok: true,
  pubkey: TEST_PUBKEY,
  allowed: false,
  reason: 'pubkey is not in the operator list',
  code: 'WG_NOT_REGISTERED',
  via: 'none',
  operator: null,
};

/**
 * `WG_PENDING` s claimom — banner musí ukázať `claim_id` a relay, nie
 * len „skús to neskôr“ (F4AI-23).
 */
export const WRITE_STATUS_PENDING: WriteStatusResponse = {
  ok: true,
  pubkey: TEST_PUBKEY,
  allowed: false,
  reason: 'registration is waiting for approval (`operator approve`)',
  code: 'WG_PENDING',
  via: 'none',
  operator: null,
};

/**
 * Owner pubkey pre F4AI-24 testy. `SAMPLE_OWNER.owner === TEST_PUBKEY`
 * znamená „prihlásený je vlastník“ — to je default, aby stránka
 * operátorov bola v testoch prístupná. `OWNER_NOT_CONFIGURED` variant je
 * `{ok: true, owner: null}` (inštancia bez `GATEWAY_OWNER_SK_HEX`).
 */
export const SAMPLE_OWNER: RegisterOwnerResponse = { ok: true, owner: TEST_PUBKEY };

/** jeden pending + jeden active + jeden lapsed — renderuje sa celá tabuľka */
export const SAMPLE_OPERATORS: OperatorRecord[] = [
  {
    pubkey: TEST_PUBKEY,
    relay: 'wss://relay.example',
    status: 'pending',
    registered_at: NOW_S - 3600,
    expires_at: NOW_S + 30 * 24 * 3600,
    last_check: NOW_S - 60,
    fail_count: 0,
    claim_id: 'c'.repeat(64),
    note: '',
    agents: [],
  },
  {
    pubkey: 'b'.repeat(64),
    relay: 'wss://relay.example',
    status: 'active',
    registered_at: NOW_S - 86_400,
    expires_at: NOW_S + 29 * 24 * 3600,
    last_check: NOW_S - 3600,
    fail_count: 0,
    claim_id: 'd'.repeat(64),
    note: 'agent cluster',
    agents: ['a'.repeat(64)],
  },
  {
    pubkey: 'f'.repeat(64),
    relay: 'wss://old.example',
    status: 'lapsed',
    registered_at: NOW_S - 40 * 24 * 3600,
    expires_at: NOW_S - 10 * 24 * 3600,
    last_check: NOW_S - 7200,
    fail_count: 3,
    claim_id: 'e'.repeat(64),
    note: '',
    agents: [],
  },
];

export const SAMPLE_PENDING: RegisterPendingResponse = {
  ok: true,
  owner: TEST_PUBKEY,
  counts: { pending: 1, active: 1, lapsed: 1, revoked: 0 },
  operators: SAMPLE_OPERATORS,
};

/** approve/revoke odpoveď: DB sedí, publish 30028 prešiel na všetky relays */
export const SAMPLE_OPERATOR_ACTION: OperatorActionResultResponse = {
  ok: true,
  action: 'approved',
  owner: TEST_PUBKEY,
  operator: { ...SAMPLE_OPERATORS[0]!, status: 'active' },
  writers: { ok: true, event_id: 'w'.repeat(64), delivered: 3, relay_count: 3 },
  label: null,
  warnings: [],
};

export const SAMPLE_REGISTER_CHALLENGE: RegisterChallengeResponse = {
  ok: true,
  nonce: 'nonce-123',
  exp: NOW_S + 600,
  ttl_s: 600,
  kind: 1055,
  gateway: 'gateway.test',
};

export const SAMPLE_REGISTER_CLAIM: RegisterClaimResponse = {
  ok: true,
  status: 'pending',
  pubkey: TEST_PUBKEY,
  relay: 'wss://relay.example',
  expires_at: NOW_S + 30 * 24 * 3600,
  replicated: 2,
  next: 'wait for the instance owner to approve (`operator approve`)',
};

export const SAMPLE_REGISTER_STATUS: RegisterStatusResponse = {
  ok: true,
  pubkey: TEST_PUBKEY,
  status: 'pending',
  relay: 'wss://relay.example',
  expires_at: NOW_S + 30 * 24 * 3600,
  last_check: NOW_S - 3600,
  fail_count: 0,
  agents: 2,
};

/** kľúč, ktorý ešte neposlal claim — gateway to posiela ako status, nie 404 */
export const REGISTER_STATUS_UNREGISTERED: RegisterStatusResponse = {
  ok: true,
  pubkey: TEST_PUBKEY,
  status: 'unregistered',
  expires_at: 0,
  agents: 0,
};

/* ── Phase 4b: papiere (kind 30023) ─────────────────────────────────────── */

export const PAPER_ID = hexId('d4');
export const PAPER_D = 'negentropy-replication';
export const PAPER_ADDR = `30023:${TEST_PUBKEY}:${PAPER_D}`;
/** druhý autor — jeho 1054 VOUCH potvrdzuje spoluautorstvo na papieri */
export const COAUTHOR_PUBKEY = hexId('e2');
export const TOPIC_ADDR = `30020:${hexId('c3')}:nostr`;
export const PAPER_CREATED_AT = 1_793_836_800;

/** CSL-JSON referencie: 3 citované (v poradí prvej citácie) + 1 necitovaná */
export const PAPER_CSL: CslItem[] = [
  {
    id: 'novak2026',
    type: 'article-journal',
    title: 'Negentropy Replication of Gated Nostr Forums',
    author: [{ family: 'Novakova', given: 'Jana' }],
    issued: { 'date-parts': [[2026]] },
    'container-title': 'Journal of Replicated Sets',
    DOI: '10.5281/zenodo.1234567',
  },
  {
    id: 'chen2025',
    type: 'paper-conference',
    title: 'Gossip Sets at the Edge',
    author: [{ literal: 'Chen, Wei' }],
    issued: { 'date-parts': [[2025]] },
    'container-title': 'Proc. Nostr Symposium',
  },
  {
    id: 'halvorsen2024',
    type: 'book',
    title: 'Signed Data Systems',
    author: [{ family: 'Halvorsen', given: 'Ingrid' }],
    issued: { 'date-parts': [[2024]] },
  },
  // necitovaná → lint varovanie REF_UNCITED, v Referenciách končí až za citovanými
  { id: 'uncited2023', type: 'report', title: 'Relay Capacity Survey', author: [{ family: 'Berg', given: 'Ola' }] },
];

/**
 * Telo papiera v irackom formáte (docs/skill.md §4a): `fig=` zárezy,
 * `Table: … {#tbl:…}`, `$$ … $$ {#eq:…}`, `@fig:…` krížové odkazy a
 * `[@key]` citácie — vrátane ZÁREZU, ktorý neexistuje (`@fig:ghost`) a
 * citácie bez položky (`[@ghost1999]`), aby banner varovaní mal čo ukázať.
 */
const FENCE = '```';
export const PAPER_BODY = [
  '## Introduction',
  '',
  'The stack is in @fig:arch, the numbers in @tbl:results and latency in @eq:latency.',
  'We cite [@novak2026] and [@chen2025; @halvorsen2024]; ghost: [@ghost1999].',
  'Missing declaration: @fig:ghost.',
  '',
  `${FENCE}mermaid fig=arch caption="Replication stack"`,
  'flowchart LR',
  '  a[Client] --> b[Relay]',
  FENCE,
  '',
  'Table: Latency per hop {#tbl:results}',
  '',
  '| hop | ms |',
  '| --- | -- |',
  '| relay | 12 |',
  '',
  '$$ L = \\sum_{i=1}^{n} d_i $$ {#eq:latency}',
  '',
  '### Method',
  '',
  'Set difference via negentropy.',
  '',
  `${FENCE}chart fig=latency caption="Latency distribution"`,
  '{ "type": "line", "series": [{ "name": "p50", "points": [[1, 12], [2, 30]] }] }',
  FENCE,
  '',
  '## Results',
  '',
  'See @fig:latency and [@novak2026] again.',
  '',
  `${FENCE}references`,
  JSON.stringify(PAPER_CSL, null, 2),
  FENCE,
  '',
].join('\n');

export const PAPER_TAGS: string[][] = [
  ['d', PAPER_D],
  ['title', 'Negentropy Replication of Gated Nostr Forums'],
  ['summary', 'We replicate gated nostr forums with negentropy sets.'],
  ['published_at', String(PAPER_CREATED_AT)],
  ['t', 'distributed-systems'],
  ['author', 'Jana Novakova', 'Comenius University', TEST_PUBKEY, '0000-0002-1825-0097'],
  ['author', 'Wei Chen', '', COAUTHOR_PUBKEY, ''],
  ['p', TEST_PUBKEY, '', 'author'],
  ['p', COAUTHOR_PUBKEY, '', 'author'],
  ['a', TOPIC_ADDR],
  ['license', 'CC-BY-4.0'],
  ['version', 'v1'],
  ['doi', '10.5281/zenodo.1234567'],
  ['L', 'ISO-639-1'],
  ['l', 'en', 'ISO-639-1'],
];

export const PAPER_EVENT: EventSummary = event(PAPER_ID, 30023, PAPER_BODY, {
  created_at: PAPER_CREATED_AT,
  tags: PAPER_TAGS,
});

export const PAPER_META: PaperMeta = {
  title: 'Negentropy Replication of Gated Nostr Forums',
  abstract: 'We replicate gated nostr forums with negentropy sets.',
  authors: [
    { name: 'Jana Novakova', affiliation: 'Comenius University', pubkey: TEST_PUBKEY, orcid: '0000-0002-1825-0097' },
    { name: 'Wei Chen', pubkey: COAUTHOR_PUBKEY },
  ],
  topics: ['distributed-systems'],
  doi: '10.5281/zenodo.1234567',
  slug: PAPER_D,
  license: 'CC-BY-4.0',
  version: 'v1',
  publishedAt: PAPER_CREATED_AT,
  topicAddress: TOPIC_ADDR,
  coauthorPubkeys: [TEST_PUBKEY, COAUTHOR_PUBKEY],
  lang: 'en',
  references: PAPER_CSL,
  declaredRefs: { fig: ['arch', 'latency'], tbl: ['results'], eq: ['latency'] },
  citedKeys: ['novak2026', 'chen2025', 'halvorsen2024', 'ghost1999'],
  crossRefs: [
    { kind: 'fig', id: 'arch' },
    { kind: 'tbl', id: 'results' },
    { kind: 'eq', id: 'latency' },
    { kind: 'fig', id: 'ghost' },
    { kind: 'fig', id: 'latency' },
  ],
  bodyBytes: new TextEncoder().encode(PAPER_BODY).length,
  richBlocks: 2,
};

export const SAMPLE_PAPER_DETAIL: PaperDetailResponse = {
  phase: '4a',
  id: PAPER_ID,
  addr: PAPER_ADDR,
  pubkey: TEST_PUBKEY,
  created_at: PAPER_CREATED_AT,
  kind: 30023,
  event: PAPER_EVENT,
  paper: PAPER_META,
  lint: {
    ok: true,
    errors: [],
    codes: [],
    warnings: [
      'citation [@ghost1999] has no matching reference entry',
      'reference [uncited2023] is never cited',
      'cross-reference @fig:ghost has no declaration',
    ],
    warning_codes: ['CITE_UNKNOWN', 'REF_UNCITED', 'XREF_UNKNOWN'],
  },
  untrusted: 'data comes from relays, not from a verified index',
};

export const SAMPLE_PAPERS: PapersResponse = {
  phase: '4a',
  count: 2,
  limit: 20,
  items: [
    {
      id: PAPER_ID,
      addr: PAPER_ADDR,
      pubkey: TEST_PUBKEY,
      created_at: PAPER_CREATED_AT,
      title: 'Negentropy Replication of Gated Nostr Forums',
      abstract: 'We replicate gated nostr forums with negentropy sets.',
      authors: PAPER_META.authors,
      topics: ['distributed-systems'],
      doi: '10.5281/zenodo.1234567',
      slug: PAPER_D,
      license: 'CC-BY-4.0',
      version: 'v1',
      published_at: PAPER_CREATED_AT,
      lang: 'en',
      body_bytes: PAPER_META.bodyBytes,
    },
    {
      id: hexId('d5'),
      addr: `30023:${TEST_PUBKEY}:ml-slovak`,
      pubkey: TEST_PUBKEY,
      created_at: PAPER_CREATED_AT - 86_400,
      title: 'Ako hodnotiť modely v slovenčine',
      abstract: 'Slovenský abstrakt kvôli filtru jazyka.',
      authors: [{ name: 'Jana Novakova' }],
      topics: ['machine-learning'],
      lang: 'sk',
      body_bytes: 2048,
    },
  ],
  untrusted: 'data comes from relays, not from a verified index',
};

export const SAMPLE_PAPER_LINT_OK: PaperLintResponse = {
  phase: '4a',
  ok: true,
  errors: [],
  codes: [],
  warnings: [],
  warning_codes: [],
  paper: PAPER_META,
  hint: 'publish with POST /events',
};

export const SAMPLE_PAPER_LINT_ERRORS: PaperLintResponse = {
  phase: '4a',
  ok: false,
  errors: ['paper requires a title tag', 'paper requires at least one `t` tag'],
  codes: ['PAPER_TITLE_REQUIRED', 'PAPER_TOPIC_MISSING'],
  warnings: [],
  warning_codes: [],
  hint: 'fix the errors and lint again',
};

export const SAMPLE_PAPER_LINT_WARNINGS: PaperLintResponse = {
  phase: '4a',
  ok: true,
  errors: [],
  codes: [],
  warnings: ['paper has no ```references fence', 'citation [@ghost1999] has no matching reference entry'],
  warning_codes: ['REFS_MISSING', 'CITE_UNKNOWN'],
  hint: 'warnings do not block publish',
};

/** 1054 VOUCH od COAUTHOR_PUBKEY mieriaci na adresu papiera → potvrdenie */
export const SAMPLE_VOUCHES: RecentResponse = {
  ...SAMPLE_FEED,
  count: 1,
  items: [
    event(hexId('f1'), 1054, '', {
      pubkey: COAUTHOR_PUBKEY,
      created_at: PAPER_CREATED_AT + 60,
      tags: [['a', PAPER_ADDR]],
    }),
  ],
};

/**
 * Stub klienta: každá metóda je `vi.fn()` vracajúca fixture (aj prepísané
 * overrides balíme do `vi.fn`, aby testy mohli overávať `toHaveBeenCalledTimes`
 * pri retry-tlacidle). Test môže prepísať čo potrebuje
 * (`stubApi({ feed: async () => { throw error } })`).
 */
export function stubApi(overrides: Partial<Api> = {}): Api {
  const base: Api = {
    baseUrl: 'http://gateway.test',
    health: async () => ({ status: 'ok' as const, phase: 'S8', relays: [] }),
    topics: async () => SAMPLE_TOPICS,
    topic: async () => SAMPLE_TOPIC_DETAIL,
    thread: async () => SAMPLE_THREAD,
    feed: async () => SAMPLE_FEED,
    recent: async () => SAMPLE_RECENT,
    search: async () => SAMPLE_SEARCH,
    reputation: async () => SAMPLE_REPUTATION,
    ideas: async () => SAMPLE_IDEAS,
    idea: async () => SAMPLE_IDEA_DETAIL,
    publish: async () => SAMPLE_PUBLISH,
    writeStatus: async () => SAMPLE_WRITE_STATUS,
    registerOwner: async () => SAMPLE_OWNER,
    registerPending: async () => SAMPLE_PENDING,
    registerApprove: async () => SAMPLE_OPERATOR_ACTION,
    registerRevoke: async () => SAMPLE_OPERATOR_ACTION,
    registerChallenge: async () => SAMPLE_REGISTER_CHALLENGE,
    registerClaim: async () => SAMPLE_REGISTER_CLAIM,
    registerStatus: async () => SAMPLE_REGISTER_STATUS,
    papers: async () => SAMPLE_PAPERS,
    paper: async () => SAMPLE_PAPER_DETAIL,
    paperByAddress: async () => ({ ...SAMPLE_PAPER_DETAIL, address: PAPER_ADDR }),
    lintPaper: async () => SAMPLE_PAPER_LINT_OK,
    // Phase 6b: default = "federácia nie je" (prázdne korene + 404 state),
    // aby existujúce testy nevideli Network sekciu ani fed panel. Test,
    // ktorý ju skúša, si ju vypne vlastným override.
    getFedTopics: async () => SAMPLE_FED_TOPICS_EMPTY,
    fedState: async () => {
      throw fedNotFound();
    },
    fedResync: async () => SAMPLE_FED_RESYNC,
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'baseUrl') continue;
    merged[key] = vi.fn(value as (...args: never[]) => unknown);
  }
  return merged as unknown as Api;
}

/** mock `fetch` s prístupom k volaniam (testy overujú URL a init) */
export type MockFetch = FetchLike & { mock: { calls: [string, (RequestInit | undefined)?][] } };

export function jsonFetch(status: number, body: unknown, init?: { headers?: Record<string, string> }): MockFetch {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      }),
  ) as unknown as MockFetch;
}
