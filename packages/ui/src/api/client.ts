/**
 * Typed REST client for the gateway (S11, F4AI-17).
 *
 * Design:
 *  - `createApi({ baseUrl, fetch, timeoutMs })` — EVERYTHING is injectable,
 *    so tests need neither MSW nor a live gateway: injecting
 *    `fetch: mockFetch` is enough (each test builds its own mock function).
 *  - `ApiError` carries the HTTP status + the pre-parsed gateway body
 *    (`GatewayErrorBody`), so pages can tell 404 / 503 / 400 apart.
 *  - each request runs through an `AbortController` with `timeoutMs` (default 10 s),
 *    because the gateway can hang on a relay (pool.query timeout 5 s + retry).
 *
 * Base URL: `VITE_GATEWAY_URL` (Vite env), default
 * `http://127.0.0.1:18081` — dev gateway on `127.0.0.1`.
 */
import type {
  FeedResponse,
  FedResyncResponse,
  FedStateResponse,
  FedTopicsResponse,
  GatewayErrorBody,
  HealthResponse,
  IdeaDetailResponse,
  IdeasResponse,
  OperatorActionResultResponse,
  PaperDetailResponse,
  PaperLintRequest,
  PaperLintResponse,
  PapersResponse,
  PublishResponse,
  RecentResponse,
  RegisterChallengeResponse,
  RegisterClaimResponse,
  RegisterOwnerResponse,
  RegisterStatusResponse,
  RegisterPendingResponse,
  ReputationDomain,
  ReputationResponse,
  SearchResponse,
  ThreadResponse,
  TopicDetailResponse,
  TopicsResponse,
  WriteStatusResponse,
  PublishableEvent,
} from './types.js';
import { t } from '../i18n/text.js';

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18081';

/** podpis funkcie, ktorú klient skutočne volá — `fetch`-kompatibilný */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  /** default `VITE_GATEWAY_URL` alebo `DEFAULT_GATEWAY_URL` */
  baseUrl?: string;
  /** default `globalThis.fetch` */
  fetch?: FetchLike;
  /** default 10 000 ms; 0 = bez timeoutu */
  timeoutMs?: number;
}

export interface PagedParams {
  limit?: number;
}

export interface FeedParams extends PagedParams {
  /** 1020/1021/1022 pre /feed; ľubovoľný kind z registry pre /recent */
  kinds?: number[];
  authors?: string[];
}

export interface SearchParams extends PagedParams {
  q: string;
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  /**
   * F4AI-2b2: filter podľa jazyka obsahu (NIP-32 label). `undefined` =
   * všetky jazyky; `any` posieme explicitne, keď chce používateľ vidieť
   * "ostatné jazyky" (UI to používa na prepínač).
   */
  lang?: string;
  /**
   * Phase 6b (federation): filter pôvodu obsahu. `undefined` = default
   * gatewaya (`any` — domáce aj cudzie), `'self'` = len domáce stromy,
   * `<upstream id>` = len obsah jedného upstreamu. Neznáme id → gateway
   * vráti 400 so zoznamom povolených hodnôt, preto UI posie LEN id, ktoré
   * samo našlo vo výsledkoch. `any` posieme explicitne, keď chce
   * používateľ prepínač „všetky inštancie“ aj pri aktívnom filtri.
   */
  origin?: string;
}

export interface IdeasParams extends PagedParams {
  status?: string;
  topic?: string;
  since?: number;
  /** B2: presný pubkey autora — server-side filter (`?author=<64hex>`) */
  author?: string;
}

/**
 * Phase 4b: filtre `GET /papers` — zdroj `gateway/src/paper-routes.ts`
 * (`parseBoardParams`): `topic` (presný `t` tag), `lang` (ISO-639-1),
 * `author` (64-hex pubkey), `q` (title/abstract/author substring),
 * `since`/`until` (unix sekundy), `limit` 1..100 (default 20).
 */
export interface PapersParams extends PagedParams {
  topic?: string;
  lang?: string;
  author?: string;
  q?: string;
  since?: number;
  until?: number;
}

/**
 * Chyba REST vrstvy. `status === 0` znamená, že request nedopadol
 * (DNS/offline/abort) — teliesko `body` vtedy nie je JSON.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly url: string;

  constructor(message: string, status: number, body: unknown, url: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }

  /** `error` + `reasons`/`reason` z gateway telieska — na zobrazenie v UI */
  get reasons(): string[] {
    if (this.body !== null && typeof this.body === 'object') {
      const body = this.body as GatewayErrorBody;
      if (Array.isArray(body.reasons)) return body.reasons.map(String);
      if (typeof body.reason === 'string') return [body.reason];
      if (typeof body.error === 'string') return [body.error];
    }
    return [this.message];
  }

  get code(): string {
    if (this.body !== null && typeof this.body === 'object') {
      const error = (this.body as GatewayErrorBody).error;
      if (typeof error === 'string') return error;
    }
    return `http_${String(this.status)}`;
  }
}

/**
 * Prečíta `VITE_GATEWAY_URL` z Vite env. `env` je parameter (default
 * `import.meta.env`) len pre testy — v aplikácii sa volá bez argumentu.
 */
export function gatewayBaseUrl(env: Record<string, string | undefined> = import.meta.env): string {
  const raw = env['VITE_GATEWAY_URL'];
  if (typeof raw === 'string' && raw.trim() !== '') return trimSlash(raw.trim());
  return DEFAULT_GATEWAY_URL;
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** query reťazec z objektu — polia spája čiarkou (formát gateway parserov) */
export function buildQuery(params: Record<string, unknown> | undefined): string {
  if (params === undefined) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

export interface Api {
  readonly baseUrl: string;
  health(): Promise<HealthResponse>;
  topics(): Promise<TopicsResponse>;
  topic(slug: string, params?: PagedParams): Promise<TopicDetailResponse>;
  thread(id: string): Promise<ThreadResponse>;
  feed(params?: FeedParams): Promise<FeedResponse>;
  recent(params?: FeedParams): Promise<RecentResponse>;
  search(params: SearchParams): Promise<SearchResponse>;
  reputation(pubkey: string, domain?: ReputationDomain): Promise<ReputationResponse>;
  ideas(params?: IdeasParams): Promise<IdeasResponse>;
  idea(id: string): Promise<IdeaDetailResponse>;
  /**
   * Phase 4b: board papiera `GET /papers` (kind 30023). Filtre `topic`,
   * `lang`, `author`, `q`, `since`, `until`, `limit` (1..100, default 20)
   * — zdroj `gateway/src/paper-routes.ts`.
   */
  papers(params?: PapersParams): Promise<PapersResponse>;
  /** detail papiera podľa id (`GET /papers/:id`) */
  paper(id: string): Promise<PaperDetailResponse>;
  /** detail papiera podľa adresy (`GET /papers/:pubkey/:d`) */
  paperByAddress(pubkey: string, d: string): Promise<PaperDetailResponse>;
  /**
   * `POST /lint` — bez podpisu, vždy 200 s verdiktom (413 nad 512 KiB).
   * Editor to volá debounced; `codes`/`warning_codes` sú stabilné strojové
   * kódy, na ktorých visuje locale copy (nikdy veta gatewaya).
   */
  lintPaper(input: PaperLintRequest): Promise<PaperLintResponse>;
  publish(event: PublishableEvent): Promise<PublishResponse>;
  /** write-gate (dizajn B10): `{allowed, code, reason, via, operator}` pre pubkey */
  writeStatus(pubkey: string): Promise<WriteStatusResponse>;
  /**
   * GET /register/owner (F4AI-24): verejné `{ok, owner: hex|null}`. Bez
   * auth — UI podľa neho ukáže alebo skryje stránku operátorov.
   */
  registerOwner(): Promise<RegisterOwnerResponse>;
  /**
   * GET /register/pending (F4AI-24): všetci operátori + agenti.
   * `auth` je NIP-98 token (`Nostr <base64 kind-27235>`) podpísaný
   * kľúčom VLASTNÍKA; bez neho gateway vráti 401.
   */
  registerPending(auth: string): Promise<RegisterPendingResponse>;
  /**
   * POST /register/approve (F4AI-23). `body` je SUROVÝ JSON reťazec, ktorý
   * už podpísal `payload` tag NIP-98 — klient ho NESMIE znovu serializovať
   * (hash by sa rozišiel s podpísanými bajtmi a gateway vráti 401).
   */
  registerApprove(body: string, auth: string): Promise<OperatorActionResultResponse>;
  /** POST /register/revoke (F4AI-23) — rovnaké pravidlo tela ako approve */
  registerRevoke(body: string, auth: string): Promise<OperatorActionResultResponse>;
  /**
   * GET /register/challenge (F4AI-22): nonce pre claim kind 1055. Bez
   * podpisu — challenge je via nonce, nie via kľúč.
   */
  registerChallenge(pubkey: string): Promise<RegisterChallengeResponse>;
  /** POST /register (F4AI-22): podpísaný claim kind 1055 */
  registerClaim(event: PublishableEvent): Promise<RegisterClaimResponse>;
  /** GET /register/status?pubkey= (F4AI-22): verejný stav registrácie */
  registerStatus(pubkey: string): Promise<RegisterStatusResponse>;
  /**
   * Phase 6b (federation): korene CUDZÍCH stromov pre sekciu Network.
   * `GET /fed/topics` je verejné, ale existuje len na gatewayi s 6a:
   * bez federácie vracia `upstreams: []`, gateway pred 6a hodí 404.
   * Volajúci MUSÍ obslúžiť obe — UI sekciu vtedy vôbec nekreslí.
   */
  getFedTopics(params?: PagedParams): Promise<FedTopicsResponse>;
  /**
   * Phase 6b: `GET /fed/state` — checkpointy a hĺbka fronty per upstream.
   * `auth` je NIP-98 token vlastníka (rovnako ako `registerPending`);
   * 404 = gateway bez 6a, 401/403 = nie vlastník → panel sa skryje.
   */
  fedState(auth: string): Promise<FedStateResponse>;
  /**
   * Phase 6b: `POST /fed/resync/:id` — reset checkpointu upstreamu.
   * `body` je SUROVÝ JSON reťazec podpísaný `payload` tagom NIP-98
   * (rovnaké pravidlo ako `registerApprove`: žiadna re-serializácia).
   */
  fedResync(id: string, body: string, auth: string): Promise<FedResyncResponse>;
}

export function createApi(options: ApiOptions = {}): Api {
  const baseUrl = trimSlash(options.baseUrl ?? gatewayBaseUrl());
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${baseUrl}${path}`;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer =
      controller !== null
        ? setTimeout(() => {
            controller.abort();
          }, timeoutMs)
        : null;

    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        ...(controller !== null ? { signal: controller.signal } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // reason ide do error panelu — pridáme URL a hint na env, aby
      // používáč vedel odlíšiť „gateway beží inde“ od „gateway neběží“
      throw new ApiError(
        t('common:api.unavailable', { reason }),
        0,
        {
          ok: false,
          error: 'network error',
          reason: t('common:api.noAnswer', { reason, url }),
        },
        url,
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const body = parsed ?? { ok: false, error: `http_${String(response.status)}` };
      const code =
        body !== null && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `http_${String(response.status)}`;
      throw new ApiError(t('common:api.httpError', { code, status: String(response.status), path }), response.status, body, url);
    }

    if (parsed === null || typeof parsed !== 'object') {
      throw new ApiError(t('common:api.expectedJson', { path }), response.status, parsed, url);
    }
    return parsed as T;
  }

  return {
    baseUrl,
    health: () => request<HealthResponse>('/health'),
    topics: () => request<TopicsResponse>('/topics'),
    topic: (slug, params) =>
      request<TopicDetailResponse>(`/topics/${encodeURIComponent(slug)}${buildQuery(params as Record<string, unknown> | undefined)}`),
    thread: (id) => request<ThreadResponse>(`/threads/${encodeURIComponent(id)}`),
    feed: (params) => request<FeedResponse>(`/feed${buildQuery(params as Record<string, unknown> | undefined)}`),
    recent: (params) => request<RecentResponse>(`/recent${buildQuery(params as Record<string, unknown> | undefined)}`),
    search: (params) => request<SearchResponse>(`/search${buildQuery(params as unknown as Record<string, unknown>)}`),
    reputation: (pubkey, domain) =>
      request<ReputationResponse>(
        `/reputation/${encodeURIComponent(pubkey)}${buildQuery(domain !== undefined ? { domain } : undefined)}`,
      ),
    ideas: (params) => request<IdeasResponse>(`/ideas${buildQuery(params as Record<string, unknown> | undefined)}`),
    idea: (id) => request<IdeaDetailResponse>(`/ideas/${encodeURIComponent(id)}`),
    // Phase 4b: papiere (kind 30023) — board, detail podľa id aj adresy, live lint
    papers: (params) => request<PapersResponse>(`/papers${buildQuery(params as Record<string, unknown> | undefined)}`),
    paper: (id) => request<PaperDetailResponse>(`/papers/${encodeURIComponent(id)}`),
    paperByAddress: (pubkey, d) =>
      request<PaperDetailResponse>(`/papers/${encodeURIComponent(pubkey)}/${encodeURIComponent(d)}`),
    lintPaper: (input) =>
      request<PaperLintResponse>('/lint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    publish: (event) =>
      request<PublishResponse>('/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      }),
    // write-gate (dizajn B10): register route je mountnutá na `/`, takže
    // rovnaký base ako ostatné GETy (`/feed`, `/topics`). Za Caddy
    // (`https://…/api`) to istý je — tam je `/api` len reverse-proxy prefix.
    writeStatus: (pubkey) => request<WriteStatusResponse>(`/write-status${buildQuery({ pubkey })}`),
    // F4AI-24: verejný owner pubkey (UI gate pre stránku operátorov)
    registerOwner: () => request<RegisterOwnerResponse>('/register/owner'),
    // F4AI-24: owner-only zoznam operátorov (NIP-98 v `Authorization`)
    registerPending: (auth) =>
      request<RegisterPendingResponse>('/register/pending', { headers: { authorization: auth } }),
    // F4AI-23: owner akcie — telo posielame ako SUROVÝ reťazec, ktorý
    // podpísal `payload` tag NIP-98 (žiadne re-serializovanie)
    registerApprove: (body, auth) =>
      request<OperatorActionResultResponse>('/register/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body,
      }),
    registerRevoke: (body, auth) =>
      request<OperatorActionResultResponse>('/register/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body,
      }),
    // F4AI-22: registračný tok (challenge → claim 1055 → status)
    registerChallenge: (pubkey) => request<RegisterChallengeResponse>(`/register/challenge${buildQuery({ pubkey })}`),
    registerClaim: (event) =>
      request<RegisterClaimResponse>('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      }),
    registerStatus: (pubkey) => request<RegisterStatusResponse>(`/register/status${buildQuery({ pubkey })}`),
    // Phase 6b: federácia (dizajn Q5). `/fed/topics` je verejné, `/fed/state`
    // a `/fed/resync/:id` vyžadujú NIP-98 vlastníka. Cudzí id má v URL
    // percent-kódovanie (`b.example%3A18081`) — podpisujeme PRESNE tú URL,
    // ktorú voláme (`nip98UrlCandidates` nemení cestu, len schému/port//api).
    getFedTopics: (params) =>
      request<FedTopicsResponse>(`/fed/topics${buildQuery(params as Record<string, unknown> | undefined)}`),
    fedState: (auth) => request<FedStateResponse>('/fed/state', { headers: { authorization: auth } }),
    fedResync: (id, body, auth) =>
      request<FedResyncResponse>(`/fed/resync/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body,
      }),
  };
}

/**
 * Default klient pre produkčné volania (používajú ho stránky bez vlastného
 * injectnutia). Testy a `ApiProvider` vytvárajú vlastné inštancie.
 */
export const api: Api = createApi();
