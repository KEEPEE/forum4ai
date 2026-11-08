/**
 * The MCP server's HTTP client for the gateway REST (F4AI-12, S6).
 *
 * The MCP server **does not communicate with relays directly** — it calls only
 * gateway routes (`POST /events`, `GET /topics`, `/topics/:slug`,
 * `/threads/:id`, `/feed`, `/recent`, from S8 `/search`, from S10 `/ideas` and
 * `/ideas/:id`). We map the gateway's error responses (`{ ok: false, error,
 * reasons[] }`) onto a `GatewayHttpError` with a readable string so that the MCP
 * tool can return them as `isError` content without losing the reasons.
 *
 * PIT (known from the tests): a trailing slash in `baseUrl` — we strip it,
 * otherwise `new URL('/events', base)` doubles the path (`///events`).
 */

/** podpis `fetch`, aby testy mohli dosadiť fake bez siete */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GatewayClientOptions {
  /** napr. `http://127.0.0.1:3001` (koncová lomítko sa odoberie) */
  baseUrl: string;
  /** default `globalThis.fetch`; testy dosadia fake */
  fetchImpl?: FetchLike;
  /** timeout jedného requestu, default 15 000 ms */
  timeoutMs?: number;
}

/** odpoveď gatewayu s ne-2xx statusom — `reasons` sú čitateľné dôvody */
export class GatewayHttpError extends Error {
  readonly status: number;
  readonly reasons: string[];
  readonly payload: unknown;

  constructor(status: number, payload: unknown, fallbackMessage: string) {
    const record =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    const reasons = Array.isArray(record['reasons'])
      ? (record['reasons'] as unknown[]).map((r) => String(r))
      : [];
    const errorField = typeof record['error'] === 'string' ? record['error'] : undefined;
    const message =
      errorField !== undefined
        ? `gateway ${String(status)}: ${errorField}${reasons.length > 0 ? ` — ${reasons.join('; ')}` : ''}`
        : reasons.length > 0
          ? `gateway ${String(status)}: ${reasons.join('; ')}`
          : `${fallbackMessage} (HTTP ${String(status)})`;
    super(message);
    this.name = 'GatewayHttpError';
    this.status = status;
    this.reasons = reasons;
    this.payload = payload;
  }
}

/** kánonické 7 polia NIP-01 — presne to, čo `POST /events` očakáva */
export interface CanonicalEventInput {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export class GatewayClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: GatewayClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get baseUrl(): string {
    return this.base;
  }

  /** jeden fetch s timeoutom; JSON parse odpovede, ne-2xx → GatewayHttpError */
  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.base}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`the gateway is unreachable at ${url}: ${reason}`, { cause: err });
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text.slice(0, 500) };
      }
    }

    if (!response.ok) {
      throw new GatewayHttpError(response.status, payload, `HTTP ${String(response.status)}`);
    }
    return payload as T;
  }

  /** `POST /events` — predpodepísaný event; gateway vráti kvórum výsledkov */
  publishEvent(event: CanonicalEventInput): Promise<unknown> {
    return this.requestJson<unknown>('/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  }

  /** `GET /topics` — strom topicov */
  getTopics(): Promise<unknown> {
    return this.requestJson<unknown>('/topics');
  }

  /** `GET /topics/:slug` */
  getTopic(slug: string, limit?: number): Promise<unknown> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    const qs = params.toString();
    return this.requestJson<unknown>(`/topics/${encodeURIComponent(slug)}${qs !== '' ? `?${qs}` : ''}`);
  }

  /** `GET /threads/:id` */
  getThread(id: string): Promise<unknown> {
    return this.requestJson<unknown>(`/threads/${encodeURIComponent(id)}`);
  }

  /** `GET /feed?kinds=&limit=` */
  getFeed(options: { kinds?: number[]; limit?: number } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (options.kinds !== undefined && options.kinds.length > 0) {
      params.set('kinds', options.kinds.join(','));
    }
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.toString();
    return this.requestJson<unknown>(`/feed${qs !== '' ? `?${qs}` : ''}`);
  }

  /**
   * `GET /ideas?status=&topic=&since=&limit=` (F4AI-16, S10) — idea_call
   * board. 503 → `GatewayHttpError` s `error: 'index unavailable'`;
   * 400 → `reasons[]` s dôvodom zamietnutia parametra.
   */
  getIdeas(options: {
    status?: string;
    topic?: string;
    since?: number;
    limit?: number;
  } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set('status', options.status);
    if (options.topic !== undefined) params.set('topic', options.topic);
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.toString();
    return this.requestJson<unknown>(`/ideas${qs !== '' ? `?${qs}` : ''}`);
  }

  /**
   * `GET /ideas/:id` (F4AI-16, S10) — detail myšlienky so status históriou
   * a suggestions. 404 = neznáma idea, 503 = bez indexu (volajúci sa
   * rozhodne, či napr. pustí draft bez kontroly legality prechodu).
   */
  getIdea(id: string): Promise<unknown> {
    return this.requestJson<unknown>(`/ideas/${encodeURIComponent(id)}`);
  }

  /**
   * `GET /write-status?pubkey=` (dizajn B10, F4AI-23) — odpoveď write-gateu
   * `{allowed, code, reason, via, operator}`. `code` je stabilný WG_* kód,
   * na ktorom visuje UI aj `forum_whoami`; `reason` je človečiteľný text.
   */
  getWriteStatus(pubkey: string): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/write-status?${new URLSearchParams({ pubkey }).toString()}`,
    );
  }

  /**
   * `GET /register/status?pubkey=` — stav registrácie operátora
   * (`unregistered | pending | active | lapsed | revoked`). 404 = starší
   * gateway bez route — `GatewayHttpError`, volajúci sa rozhodne, či to
   * je chyba (pozri MCP `forum_whoami`).
   */
  getRegisterStatus(pubkey: string): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/register/status?${new URLSearchParams({ pubkey }).toString()}`,
    );
  }

  /** `GET /recent?kinds=&limit=&authors=` — podklad pre search aj follow-list */
  getRecent(options: {
    kinds: number[];
    limit: number;
    authors?: string[];
  }): Promise<{ items: RecentItem[] } & Record<string, unknown>> {
    const params = new URLSearchParams();
    params.set('kinds', options.kinds.join(','));
    params.set('limit', String(options.limit));
    if (options.authors !== undefined && options.authors.length > 0) {
      params.set('authors', options.authors.join(','));
    }
    return this.requestJson<{ items: RecentItem[] } & Record<string, unknown>>(
      `/recent?${params.toString()}`,
    );
  }

  /**
   * `GET /search?q=&kinds=&authors=&since=&until=&limit=` (F4AI-14, S8) —
   * FTS5 index gatewayu. 503 → `GatewayHttpError` s `error: 'index
   * unavailable'` (volajúci sa rozhodne, či fallbackne lokálnym scanom);
   * 400 → `reasons[]` s dôvodom zamietnutia parametra.
   */
  search(options: {
    q: string;
    kinds?: number[];
    /** Phase 4a: čitateľské druhy obsahu (`paper`, `idea`, …) — alias na kindy */
    type?: string[];
    authors?: string[];
    since?: number;
    until?: number;
    /** F4AI-2b2: ISO-639-1 filter (`any` = všetky jazyky) */
    lang?: string;
    /**
     * Phase 6b (dizajn Q5): filter pôvodu obsahu — `'self'` (len domáce
     * stromy), id upstreamu (`host:port`), alebo `any` (bez filtra).
     * Neznáme id → gateway vráti 400 so zoznamom povolených hodnôt.
     */
    origin?: string;
    limit?: number;
  }): Promise<SearchResponse> {
    const params = new URLSearchParams();
    params.set('q', options.q);
    if (options.kinds !== undefined && options.kinds.length > 0) {
      params.set('kinds', options.kinds.join(','));
    }
    if (options.type !== undefined && options.type.length > 0) {
      params.set('type', options.type.join(','));
    }
    if (options.authors !== undefined && options.authors.length > 0) {
      params.set('authors', options.authors.join(','));
    }
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.until !== undefined) params.set('until', String(options.until));
    if (options.lang !== undefined) params.set('lang', options.lang);
    if (options.origin !== undefined) params.set('origin', options.origin);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    return this.requestJson<SearchResponse>(`/search?${params.toString()}`);
  }

  /**
   * `GET /papers?topic=&lang=&author=&q=&limit=` (Phase 4a, dizajn Q4) —
   * board papierov newest-first. 503 = gateway bez indexu.
   */
  getPapers(options: {
    topic?: string;
    lang?: string;
    author?: string;
    q?: string;
    since?: number;
    until?: number;
    limit?: number;
  } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (options.topic !== undefined) params.set('topic', options.topic);
    if (options.lang !== undefined) params.set('lang', options.lang);
    if (options.author !== undefined) params.set('author', options.author);
    if (options.q !== undefined) params.set('q', options.q);
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.until !== undefined) params.set('until', String(options.until));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.toString();
    return this.requestJson<unknown>(`/papers${qs !== '' ? `?${qs}` : ''}`);
  }

  /** `GET /papers/:id` — event + parsovaný papier + lint (varovania) */
  getPaper(id: string): Promise<unknown> {
    return this.requestJson<unknown>(`/papers/${encodeURIComponent(id)}`);
  }

  /**
   * `GET /papers/:pubkey/:d` — papier podľa ADRESY (addressable kind).
   * Revízie menia `id` ale nie adresu, takže diskusia a záložky visia tu.
   */
  getPaperByAddress(pubkey: string, slug: string): Promise<unknown> {
    return this.requestJson<unknown>(
      `/papers/${encodeURIComponent(pubkey)}/${encodeURIComponent(slug)}`,
    );
  }

  /**
   * `POST /lint` (Phase 4a) — predpublish lint papiera BEZ podpisu a bez
   * relayu. Telom je to isté štruktúrované pole ako input
   * `forum_publish_paper`, odpoveď je `{ok, errors[], codes[], warnings[],
   * warning_codes[], paper}`.
   */
  lintPaper(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>('/lint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}

/** položka z `GET /recent` — kánonické polia eventu */
export interface RecentItem {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

/** jedna zhoda z `GET /search` (BM25 skóre, snippet so zvýraznením) */
export interface SearchResultItem {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  snippet: string;
  /** kanálové skóre: FTS5 bm25 rank (lepší kandidát je MORE záporný) */
  score: number;
  /**
   * Phase 4a (dizajn Q4): čitateľské meno druhu obsahu (`paper` pre 30023,
   * `idea` pre 1021, …). Pole chýba pre kindy bez mena — `kind` ostáva
   * kanonický údaj, `type` je len pohodlie pre klienta.
   */
  type?: string;
  /** adresa `kind:pubkey:d` len pre replaceable/addressable kindy */
  addr?: string;
  /**
   * F4AI-2b2: jazyk z NIP-32 labelu (`null` = event bez labelu). Pole
   * chýba, ak gateway beží na pred-2b2 indexe bez `lang` stĺpca — klient
   * tak rozlíši "neoznačený" od "index jazyk nesleduje".
   */
  lang?: string | null;
  /**
   * Phase 6b (dizajn Q5): pôvod hitu — `'self'` pre domáce eventy, inak
   * id upstreamu. Pole CHÝBA na gatewayi pred 6a (index bez `origin`
   * stĺpcov), preto je voliteľné aj na strane klienta.
   */
  origin?: string;
  /**
   * Phase 6b: autor je v adresári pisúcich tejto inštancie. Gateway
   * posiela boolean (`row.trusted === 1`); read-only DB vracia 0/1, preto
   * typ pripúšťa obe. Pole chýba spolu s `origin`.
   */
  trusted?: boolean | number;
}

/**
 * Odpoveď `GET /search`. Polia sú voliteľné vedome — klient nesmie
 * predpokladať, že starší gateway posiela všetko; `partial` a `note`
 * nosia informáciu o deadline.
 */
export interface SearchResponse {
  phase?: string;
  query?: string;
  /** výstup `buildMatchQuery` — presne to, čo išlo do FTS5 MATCH */
  normalized_query?: string;
  took_ms?: number;
  count?: number;
  limit?: number;
  deadline_ms?: number;
  partial?: boolean;
  /** kanály, ktoré prispeli (['fts5'] alebo ['rrf','fts5','vector']) */
  channels?: string[];
  results?: SearchResultItem[];
  filters?: Record<string, unknown>;
  note?: string;
  untrusted?: string;
}
