/**
 * `GET /search` — REST search over the indexer SQLite DB (F4AI-14, S8).
 *
 * Decision from the task (no silent fallback):
 *   index not available → **503 `{ error: 'index unavailable' }`**.
 *   The gateway does NOT pretend to search — the local scan (F1) stays only as
 *   an explicit fallback of the MCP tool, which labels it itself with `source`.
 *
 * Parameters:
 *   q=…              required query (tokens = implicit AND, prefix `slovo*`)
 *                    A5 (P1): max 200 characters, max 8 tokens, prefix stem ≥3 chars
 *   kinds=…          csv of integers (filter by kind)
 *   type=…           Phase 4a (design Q4): csv of reader-facing content types —
 *                    `question|idea|collab|post|paper|topic`. It is an ALIAS for
 *                    kinds and is summed in (union) with `kinds=`, so
 *                    `?kinds=1020&type=paper` searches questions AND papers.
 *                    An unknown name → 400 with the list of valid ones (a silently
 *                    ignored filter would return more than what was asked for).
 *   authors=…        csv of 64-hex pubkeys
 *   since=…/until=…  unix seconds, a closed interval
 *   limit=…          1..50, default 20
 *   lang=…           F4AI-2b2: filter by the content language (NIP-32 label).
 *                    `lang=en` only en, `lang=any` (or omitted) all, an unknown
 *                    code → 400. On an index without a `lang` column
 *                    (pre-2b2) the filter is silently ignored — the query would
 *                    otherwise fail with `no such column`.
 *   origin=…         Phase 6a (design Q5): a provenance filter. `origin=self`
 *                    only own content, `origin=<id>` only the content of the
 *                    instance with this id (id = the host of its gateway URL),
 *                    `origin=any` or OMITTED = all sources. The default is
 *                    deliberately `any`: the Q5 E2E step expects that
 *                    `B /search?q=<uuid>` finds instance A's thread without
 *                    further parameters. An unknown id → **400** with the list of
 *                    allowed values (`self`, `any`, ids from
 *                    `GATEWAY_UPSTREAM_GATEWAYS` and ids the index already
 *                    contains) — a typo in an id must not look like
 *                    "that instance has nothing".
 *
 * Response:
 *   { phase, query, normalized_query, took_ms, count, limit, results[],
 *     channels[], partial, deadline_ms, filters, untrusted }
 *   `results[]` = { id, kind, type?, pubkey, created_at, snippet, score, addr?, lang?, origin?, trusted? }
 *   `type` is the reader-facing name of the type (`paper` for 30023) — it is added
 *   only for kinds that have a name; `kind` stays the canonical datum.
 *   `lang` is the ISO-639-1 code from the NIP-32 label, `null` = an event without
 *   a label; the field does not appear in the record at all if the index does not
 *   track language (an old DB).
 *   `origin` is `'self'` or the id of another instance and `trusted` is `false`
 *   when the author is NOT a writer of this instance (a foreign directory
 *   `INDEXER_TRUST_DIRECTORIES` or a PULL from an upstream) — the UI draws a
 *   "from aiforum.myhood.sk" chip from `origin`. Neither field appears on an
 *   index from before 6a (the gateway is read-only and does not migrate).
 *   CAREFUL: `trusted` is not the same as the string in `untrusted` — that one is
 *   the "data not instructions" convention for the agent (`UNTRUSTED_NOTE`).
 *
 * `normalized_query` is the output of `buildMatchQuery` (shared with the indexer),
 * so the client sees what was really sent to FTS5 — and the tests prove that the
 * same string is a syntactically valid FTS5 expression.
 *
 * ── Deadline and `partial` (documented behaviour) ─────────────────────
 *   `GATEWAY_SEARCH_DEADLINE_MS` (default 300 — A5 lowered it from 2000 because
 *   SQLite blocks the event loop) is the budget for one FTS5 query.
 *   better-sqlite3 13.0.3 has no progress handler (verified on the installed
 *   package), which is why we realize the deadline with the SQL function
 *   `f4ai_deadline(?)`, which SQLite calls per row and which aborts the statement
 *   after it is exceeded. Two cases, both return **HTTP 200**:
 *     1. the query was aborted → `partial: true`, `results: []`,
 *        `count: 0`, `took_ms` ≈ deadline, a `note` with the reason.
 *        (An aborted FTS5 query has no rows at all — `ORDER BY rank`
 *        needs-full-scan, so partial results do not exist.)
 *     2. the query completed, but `took_ms > deadline_ms` → `partial: true`
 *        with full results (the measurement is exact, we only state that the
 *        response was slower than the budget).
 *   When it happens: on a large index or when the writer holds a WAL checkpoint.
 *   Client atoms: `partial: true` = "retry / narrow the filter", not an error.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';

import { KINDS, ORIGIN_SELF, normalizeLangCode } from '@forum4ai/shared';

import {
  FTS5_CHANNEL,
  IndexUnavailableError,
  SEARCH_DEADLINE_DEFAULT_MS,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SearchInterruptedError,
  UNTRUSTED_NOTE,
  createVectorStubChannel,
  fusedToRanked,
  rrfFuse,
  type ChannelHits,
  type Fts5SearchChannel,
  type RankedHit,
  type SearchChannel,
} from './search.js';

export const GATEWAY_SEARCH_PHASE = 'S8';

const ID_RE = /^[0-9a-f]{64}$/;
const MAX_FILTER_VALUES = 32;

/**
 * A5 (P1): stropy dotazu. FTS5 beží v SQLite synchronne v event loop-e
 * gatewaya, takže JEDEN dlhý dotaz zamrzne aj WS a zápisy ostatných.
 * 200 znakov a 8 tokenov sú stropy, ktoré človeku ani agentovi prácu
 * nesťažujú — BM25 s viacerými AND tokenmi už index nerozlíši.
 */
export const MAX_QUERY_CHARS = 200;
export const MAX_QUERY_TOKENS = 8;
/**
 * A5: prefixový token (`slovo*`) je najdrahší tvar — `a*` precvaká celý
 * index. Krátky kmeň preto odmietame (≥3 znaky); bežné slovenské/anglické
 * korene majú 3+ znaky vždy, takže to nie je obmedzenie funkčnosti.
 */
export const MIN_PREFIX_TOKEN_CHARS = 3;

export type QueryVerdict =
  | { ok: true; q: string; tokens: string[] }
  | { ok: false; error: string; reason: string };

/**
 * A5 (P1): validácia `q` PRED tým, čo vôbec urobíme s indexom. Exportované
 * pre testy aj pre MCP klientov (rovnaké pravidlá, jeden zdroj pravdy).
 */
export function validateQuery(raw: string | undefined): QueryVerdict {
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, error: 'missing q', reason: 'q is a required search query parameter' };
  }
  if (raw.length > MAX_QUERY_CHARS) {
    return {
      ok: false,
      error: 'q too long',
      reason: `q may have at most ${String(MAX_QUERY_CHARS)} characters (you have ${String(raw.length)}) — shorten the query`,
    };
  }
  const q = raw.trim();
  const tokens = q.split(/\s+/).filter((token) => token !== '');
  if (tokens.length > MAX_QUERY_TOKENS) {
    return {
      ok: false,
      error: 'too many tokens',
      reason: `q may have at most ${String(MAX_QUERY_TOKENS)} tokens (you have ${String(tokens.length)}) — narrow the query`,
    };
  }
  for (const token of tokens) {
    const bare = token.replace(/\*+$/, '');
    if (bare !== token && bare.length < MIN_PREFIX_TOKEN_CHARS) {
      return {
        ok: false,
        error: 'prefix too short',
        reason: `the prefix token "${token}" is too short — a prefix search term must have at least ${String(MIN_PREFIX_TOKEN_CHARS)} characters (e.g. "agent*")`,
      };
    }
  }
  return { ok: true, q, tokens };
}

export interface SearchRouteOptions {
  /**
   * Kanály v poradí priority (prvý je primárny = jeho nedostupnosť dá 503).
   * Default: [FTS5 (ak je nastavený), vector stub].
   */
  channels?: SearchChannel[];
  /** primárny FTS5 kanál — pre 503 diagnostiku a `index` v /health */
  index?: Fts5SearchChannel;
  /** rozpočet na FTS5 dopyt, default 2000 ms (GATEWAY_SEARCH_DEADLINE_MS) */
  deadlineMs?: number;
  defaultLimit?: number;
  maxLimit?: number;
  logger?: (line: string) => void;
  /** injectnable hodiny (testy) */
  now?: () => number;
  /**
   * Phase 6a (dizajn Q5): id inštancií, ktoré SMÚ skončiť v `origin=`
   * filtry. Stavebné kamene sú id z `GATEWAY_UPSTREAM_GATEWAYS` a
   * `SELECT DISTINCT origin` z indexu (inštancia kŕmená len strfry
   * routerom má cudzie id bez toho, aby sama pullala). Volá sa len keď
   * klient `origin=` skutočne pošle, takže federáčne vypnutá inštancia
   * túto funkciu nikdy nevolá.
   */
  knownOrigins?: () => string[];
}

interface ParsedParams {
  q: string;
  kinds?: number[];
  /** Phase 4a: čitateľské mená z `type=` (len pre echo vo `filters`) */
  types?: string[];
  authors?: string[];
  since?: number;
  until?: number;
  /** F4AI-2b2: ISO-639-1 filter; `undefined` = všetky jazyky */
  lang?: string;
  /**
   * Phase 6a (dizajn Q5): filter pôvodu; `undefined` = `any` (žiadny
   * filter). Hodnota je `'self'` alebo id upstreamu (host jeho gateway URL).
   */
  origin?: string;
  limit: number;
}

type ParseFailure = { error: string; reason: string };

/**
 * Phase 4a (dizajn Q4): `type=` je človečiteľský alias na filter kindov.
 * Agenti aj UI premýšľajú v typoch obsahu („papiere"), nie v číslach;
 * `kinds=` ostáva platné a presnejšie API. `type=paper` je jediná cesta,
 * ako sa k papierom (30023) cez search dostane čitateľne.
 */
export const SEARCH_TYPE_KINDS: Readonly<Record<string, number>> = {
  question: KINDS.QUESTION,
  idea: KINDS.IDEA_CALL,
  collab: KINDS.COLLAB_CALL,
  post: KINDS.POST,
  paper: KINDS.PUBLICATION,
  topic: KINDS.TOPIC,
};

/** reverse map (kind → type) pre `type` pole vo výsledkoch */
const TYPE_BY_KIND = new Map<number, string>(
  Object.entries(SEARCH_TYPE_KINDS).map(([name, kind]) => [kind, name]),
);

/** `type` pre výsledok; undefined = kind nemá čitateľské meno */
export function searchTypeForKind(kind: number): string | undefined {
  return TYPE_BY_KIND.get(kind);
}

/**
 * Paruj `type=` (csv). Viac typov je SÚČET (union) kindov — `type=idea,paper`
 * hľadá ideá AJ papiere. Neznáme meno = 400 so zoznamom platných, lebo
 * ticho ignorovaný filter by vrátil viac výsledkov, než si pýtal.
 */
function parseTypes(raw: string | undefined): { value?: number[]; names?: string[] } | ParseFailure {
  if (raw === undefined || raw.trim() === '') return {};
  const values: number[] = [];
  const names: string[] = [];
  const bad: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed === '') continue;
    const kind = SEARCH_TYPE_KINDS[trimmed];
    if (kind === undefined) bad.push(trimmed);
    else if (!names.includes(trimmed)) {
      names.push(trimmed);
      if (!values.includes(kind)) values.push(kind);
    }
  }
  if (bad.length > 0) {
    return {
      error: 'invalid type',
      reason: `type must be one of: ${Object.keys(SEARCH_TYPE_KINDS).join(', ')} (bad: ${bad.join(', ')})`,
    };
  }
  if (values.length > MAX_FILTER_VALUES) {
    return { error: 'invalid type', reason: `type may have at most ${String(MAX_FILTER_VALUES)} values` };
  }
  return { value: values.length > 0 ? values : undefined, names: names.length > 0 ? names : undefined };
}

/**
 * `kinds=` a `type=` sa SČÍTAVAJÚ (union), nie vzájomne vylučujú:
 * `?kinds=1020&type=paper` = otázky A papire. Prázdny výsledok = filter
 * nebol zadaný (null), čo je iný význam ako „žiadny kind".
 */
function mergeKindFilters(kinds?: number[], types?: number[]): number[] | undefined {
  if (kinds === undefined && types === undefined) return undefined;
  const merged: number[] = [];
  for (const value of [...(kinds ?? []), ...(types ?? [])]) {
    if (!merged.includes(value)) merged.push(value);
  }
  return merged.length > 0 ? merged : undefined;
}

function parseKinds(raw: string | undefined): { value?: number[] } | ParseFailure {
  if (raw === undefined || raw.trim() === '') return {};
  const values: number[] = [];
  const bad: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const value = Number(trimmed);
    // na rozdiel od /recent tu NEfiltrujeme cez shared registry: index môže
    // obsahovať aj kindy mimo registry (INDEXER_REQUIRE_REGISTRY=0 indexuje
    // range 1020–1059), a čítací filter nesmie skryť existujúce záznamy
    if (Number.isInteger(value) && value >= 0 && value <= 4_294_967_295) {
      if (!values.includes(value)) values.push(value);
    } else {
      bad.push(trimmed);
    }
  }
  if (bad.length > 0) {
    return { error: 'invalid kinds', reason: `kinds must be non-negative integers (bad: ${bad.join(', ')})` };
  }
  if (values.length > MAX_FILTER_VALUES) {
    return { error: 'invalid kinds', reason: `kinds may have at most ${String(MAX_FILTER_VALUES)} values` };
  }
  return { value: values.length > 0 ? values : undefined };
}

function parseAuthors(raw: string | undefined): { value?: string[] } | ParseFailure {
  if (raw === undefined || raw.trim() === '') return {};
  const values: string[] = [];
  const bad: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    if (ID_RE.test(trimmed)) {
      if (!values.includes(trimmed)) values.push(trimmed);
    } else {
      bad.push(trimmed);
    }
  }
  if (bad.length > 0) {
    return {
      error: 'invalid authors',
      reason: `authors must be 64-hex pubkeys (bad: ${bad.join(', ')})`,
    };
  }
  if (values.length > MAX_FILTER_VALUES) {
    return { error: 'invalid authors', reason: `authors may have at most ${String(MAX_FILTER_VALUES)} values` };
  }
  return { value: values.length > 0 ? values : undefined };
}

function parseTimestamp(raw: string | undefined, name: string): { value?: number } | ParseFailure {
  if (raw === undefined || raw.trim() === '') return {};
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    return { error: `invalid ${name}`, reason: `${name} must be a non-negative integer (unix seconds)` };
  }
  return { value };
}

function parseLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): { value: number } | ParseFailure {
  if (raw === undefined || raw.trim() === '') return { value: fallback };
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return { error: 'invalid limit', reason: `limit must be an integer 1..${String(max)}` };
  }
  return { value };
}

/**
 * F4AI-2b2: filter podľa jazyka obsahu (NIP-32 label v indexi).
 *   `lang=en`  → iba eventy s labelom `en`
 *   `lang=any` → všetky jazyky (explicitne, to isté ako parameter vynechať)
 *   neznámy kód → 400, NIE tichá prázdna odpoveď — klient má preklep,
 *   nie prázdne fórum (rovnaké pravidlo ako pri `kinds=`).
 */
function parseLang(raw: string | undefined): { value?: string } | ParseFailure {
  if (raw === undefined || raw.trim() === '') return {};
  if (raw.trim().toLowerCase() === 'any') return {};
  const value = normalizeLangCode(raw);
  if (value === null) {
    return {
      error: 'invalid lang',
      reason: "lang must be 'any' or a known ISO-639-1 code (two letters, e.g. 'en', 'sk')",
    };
  }
  return { value };
}

/**
 * Phase 6a (dizajn Q5): filter pôvodu obsahu.
 *   `origin=self`   → len obsah tejto inštancie
 *   `origin=<id>`   → len obsah upstreamu (id = host jeho gateway URL,
 *                     napr. `127.0.0.1:18081` alebo `aiforum.myhood.sk`)
 *   `origin=any`    → všetky zdroje (explicitne to isté ako parameter vynechať)
 *   VYNECHANÉ       → **any**. Default zámerne NIE je `self`: dizajn Q5
 *                     (E2E krok 5) očakáva, že `B /search?q=<uuid>` nájde
 *                     A-ke vlákno bez ďalších parametrov.
 *
 * Neznáma hodnota je **400 so zoznamom povolených id**, nie tichá prázdna
 * odpoveď: `origin` je identifikátor inštancie, nie voľne tváriteľný
 * reťazec, a preklep (`origin=aiforum.myhod.sk`) by inak vyzeral ako
 * „inštancia nemá nič", čo je klamstvo. Povolené sú `self`, `any`, id z
 * `GATEWAY_UPSTREAM_GATEWAYS` a id, ktoré už v indexu sú (router-fed
 * inštancia). Zoznam sa NEvaliduje na DNS/64-hex tvar — id prichádza z
 * konfigurácie a z dát, nie od klienta.
 */
function parseOrigin(
  raw: string | undefined,
  knownOrigins: () => readonly string[],
): { value?: string } | ParseFailure {
  if (raw === undefined) return {};
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'any') return {};
  if (value === ORIGIN_SELF) return { value: ORIGIN_SELF };
  // zoznam known id počítame LAZILY — `origin=self|any` nesmie otvoriť
  // index (a teda ani zaplatiť DISTINCT scan) len preto, aby sme odpovedali
  // na parameter, ktorý nič nefiltruje
  const known = knownOrigins();
  if (known.includes(value)) return { value };
  return {
    error: 'invalid origin',
    reason:
      `origin must be 'self', 'any' or a known instance id ` +
      `(known: ${known.length > 0 ? known.join(', ') : 'none — no upstreams configured and the index holds no remote content'}; bad: ${JSON.stringify(value)})`,
  };
}

/** normalizácia známych id (dedup, lowercase, bez `self`/`any`/prázdnych) */
function normalizeKnownOrigins(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = item.trim().toLowerCase();
    if (value === '' || value === ORIGIN_SELF || value === 'any') continue;
    if (!out.includes(value)) out.push(value);
  }
  return out.sort();
}

function badRequest(c: Context, failure: ParseFailure) {
  return c.json({ ok: false, error: failure.error, reasons: [failure.reason] }, 400);
}

export function registerSearchRoutes(app: Hono, options: SearchRouteOptions): void {
  const now = options.now ?? (() => Date.now());
  const deadlineMs = options.deadlineMs ?? SEARCH_DEADLINE_DEFAULT_MS;
  const defaultLimit = options.defaultLimit ?? SEARCH_LIMIT_DEFAULT;
  const maxLimit = options.maxLimit ?? SEARCH_LIMIT_MAX;
  const logger = options.logger ?? ((line: string) => console.log(line));
  const index = options.index;

  /** kanály: explicitné, inak [FTS5 (ak existuje), vector stub] */
  const channels: SearchChannel[] =
    options.channels ??
    (index !== undefined
      ? [index, createVectorStubChannel()]
      : [createVectorStubChannel()]);

  app.get('/search', async (c) => {
    const started = now();
    // A5 (P1): stropy dotazu SKÔR, než sa vôbec siahne do SQLite
    const query = validateQuery(c.req.query('q'));
    if (!query.ok) {
      return c.json({ ok: false, error: query.error, reasons: [query.reason] }, 400);
    }

    const kinds = parseKinds(c.req.query('kinds'));
    if ('error' in kinds) return badRequest(c, kinds);
    // Phase 4a (dizajn Q4): `type=` je alias na kindy — sčíta sa s `kinds=`,
    // aby `?kinds=1020&type=paper` hľadal otázky AJ papire
    const types = parseTypes(c.req.query('type'));
    if ('error' in types) return badRequest(c, types);
    const kindFilter = mergeKindFilters(kinds.value, types.value);
    const authors = parseAuthors(c.req.query('authors'));
    if ('error' in authors) return badRequest(c, authors);
    const since = parseTimestamp(c.req.query('since'), 'since');
    if ('error' in since) return badRequest(c, since);
    const until = parseTimestamp(c.req.query('until'), 'until');
    if ('error' in until) return badRequest(c, until);
    const lang = parseLang(c.req.query('lang'));
    if ('error' in lang) return badRequest(c, lang);
    // Phase 6a (dizajn Q5): `origin=` — default ANY (nie 'self'), lebo
    // dizajn Q5 chce, aby `B /search?q=<uuid>` našiel cudzie vlákno bez
    // parametrov. Neplatná hodnota je 400 so zoznamom známych id.
    const origin = parseOrigin(c.req.query('origin'), () =>
      normalizeKnownOrigins(options.knownOrigins?.() ?? []),
    );
    if ('error' in origin) return badRequest(c, origin);
    const limit = parseLimit(c.req.query('limit'), defaultLimit, maxLimit);
    if ('error' in limit) return badRequest(c, limit);

    if (since.value !== undefined && until.value !== undefined && since.value > until.value) {
      return badRequest(c, {
        error: 'invalid since/until',
        reason: `since (${String(since.value)}) is greater than until (${String(until.value)})`,
      });
    }

    const params: ParsedParams = {
      q: query.q,
      limit: limit.value,
      ...(kindFilter !== undefined ? { kinds: kindFilter } : {}),
      ...(types.names !== undefined ? { types: types.names } : {}),
      ...(authors.value !== undefined ? { authors: authors.value } : {}),
      ...(since.value !== undefined ? { since: since.value } : {}),
      ...(until.value !== undefined ? { until: until.value } : {}),
      ...(lang.value !== undefined ? { lang: lang.value } : {}),
      ...(origin.value !== undefined ? { origin: origin.value } : {}),
    };

    const deadlineAt = started + deadlineMs;
    const collected: ChannelHits[] = [];
    let normalizedQuery = '';
    let interrupted = false;
    let interruptNote = '';

    /**
     * FTS5 kanál má bohatšie API (`searchDetailed`) — vracia aj
     * `normalized_query`, teda presne ten reťazec, ktorý išiel do MATCH.
     * Ostatné kanály voláme cez rozhranie `SearchChannel`.
     */
    const runChannel = async (channel: SearchChannel): Promise<RankedHit[]> => {
      if (channel.name === FTS5_CHANNEL && typeof (channel as Fts5SearchChannel).searchDetailed === 'function') {
        const detailed = (channel as Fts5SearchChannel).searchDetailed(params.q, { ...params, deadlineAt });
        normalizedQuery = detailed.normalizedQuery;
        return detailed.hits;
      }
      return await channel.search(params.q, { ...params, deadlineAt });
    };

    for (const [position, channel] of channels.entries()) {
      const isPrimary = position === 0;
      try {
        const hits = await runChannel(channel);
        if (hits.length > 0) collected.push({ channel: channel.name, hits });
      } catch (err) {
        if (err instanceof IndexUnavailableError) {
          if (isPrimary) {
            // ROZHODNUTIE: 503 s jasnou správou, žiadny tichý fallback
            const tookMs = now() - started;
            logger(
              `[gateway search] 503 index unavailable path=${err.path} reason=${err.reason} took=${String(tookMs)}ms`,
            );
            return c.json(
              {
                ok: false,
                error: 'index unavailable',
                reason: err.reason,
                path: err.path,
                took_ms: tookMs,
              },
              503,
            );
          }
          logger(`[gateway search] channel ${channel.name} unavailable: ${err.reason}`);
          continue;
        }
        if (err instanceof SearchInterruptedError) {
          if (!isPrimary) {
            logger(`[gateway search] channel ${channel.name} interrupted by the deadline`);
            continue;
          }
          interrupted = true;
          interruptNote = `the fts5 query was interrupted after ${String(err.tookMs)}ms (deadline ${String(err.deadlineMs)}ms)`;
          continue;
        }
        if (isPrimary) {
          const tookMs = now() - started;
          const reason = err instanceof Error ? err.message : String(err);
          logger(`[gateway search] 503 channel ${channel.name} failed: ${reason}`);
          return c.json(
            {
              ok: false,
              error: 'index unavailable',
              reason,
              took_ms: tookMs,
            },
            503,
          );
        }
        logger(`[gateway search] channel ${channel.name} failed: ${String(err)}`);
      }
    }

    // fúzia: 1 kanál → passthrough, ≥2 → RRF (k=60), 0 → prázdne
    let merged: RankedHit[] = [];
    let contributing: string[] = collected.map((entry) => entry.channel);
    if (collected.length === 1) {
      merged = collected[0]?.hits ?? [];
    } else if (collected.length > 1) {
      const fused = rrfFuse(collected);
      merged = fusedToRanked(fused).slice(0, params.limit);
      contributing = ['rrf', ...collected.map((entry) => entry.channel)];
    }
    // `addr` vracame len keď existuje (adresa replaceable/addressable kindu);
    // `score` je kanálové skóre — pri RRF je to RRF skóre (viac = lepšie)
    const results = merged.map((hit) => {
      const type = searchTypeForKind(hit.kind);
      return {
        id: hit.id,
        kind: hit.kind,
        // Phase 4a: čitateľské meno druhu obsahu (`paper`, `idea`, …) —
        // UI aj agent si majú čo zobrať; kind číslo ostáva kanonický filter
        ...(type !== undefined ? { type } : {}),
        pubkey: hit.pubkey,
        created_at: hit.created_at,
        snippet: hit.snippet ?? '',
        score: hit.score,
        ...(hit.addr !== null && hit.addr !== undefined ? { addr: hit.addr } : {}),
        // F4AI-2b2: `lang` posielame len keď ho index pozná (kanál ho buď
        // vyplní, alebo pole vôbec nevytvorí) — UI tak rozlíši "bez labelu"
        // (null) od "index jazyk nesleduje" (pole chýba)
        ...(hit.lang !== undefined ? { lang: hit.lang } : {}),
        // Phase 6a (dizajn Q5): `origin` + `trusted` — UI z `origin` kreslí
        // čip „from aiforum.myhood.sk". Aditívne, rovnaké pravidlo ako pri
        // `lang`: index pred 6a polia nevyplní vôbec.
        ...(hit.origin !== undefined ? { origin: hit.origin } : {}),
        ...(hit.trusted !== undefined ? { trusted: hit.trusted } : {}),
      };
    });

    const tookMs = now() - started;
    const partial = interrupted || tookMs > deadlineMs;
    const body: Record<string, unknown> = {
      phase: GATEWAY_SEARCH_PHASE,
      query: params.q,
      normalized_query: normalizedQuery,
      took_ms: tookMs,
      count: results.length,
      limit: params.limit,
      deadline_ms: deadlineMs,
      partial,
      channels: contributing,
      results,
      untrusted: UNTRUSTED_NOTE,
      filters: {
        ...(params.kinds !== undefined ? { kinds: params.kinds } : {}),
        ...(params.types !== undefined ? { types: params.types } : {}),
        ...(params.authors !== undefined ? { authors: params.authors } : {}),
        ...(params.since !== undefined ? { since: params.since } : {}),
        ...(params.until !== undefined ? { until: params.until } : {}),
        ...(params.lang !== undefined ? { lang: params.lang } : {}),
        // Phase 6a: echo len keď klient filter poslal — default je `any`
        // a ten sa v `filters` neobjaví (rovnaká konvencia ako pri `lang`)
        ...(params.origin !== undefined ? { origin: params.origin } : {}),
      },
    };
    if (partial) {
      body['note'] =
        interruptNote !== ''
          ? `${interruptNote} — results are not complete, narrow the query or raise GATEWAY_SEARCH_DEADLINE_MS`
          : `the query took ${String(tookMs)}ms, which is over the deadline ${String(deadlineMs)}ms — results are complete, but the response was slow`;
    }
    return c.json(body, 200);
  });
}
