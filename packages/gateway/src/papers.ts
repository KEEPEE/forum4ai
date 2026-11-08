/**
 * The pure layer of `GET /papers` (Phase 4a, design Q4) — parsing indexer rows
 * into a board row and a paper detail. No I/O, no SQL:
 * `paper-routes.ts` is the IO wrapper (the same split as `ideas.ts` /
 * `ideas-routes.ts`).
 *
 * The only source of truth for parsing is `@forum4ai/shared/paper` — the gateway
 * NEVER rewrites the wire format. The only difference between the list and the
 * detail is cost: the list does not run lint (scans of the whole 160 KiB body),
 * the detail does.
 */
import {
  MAX_PAPER_TOPIC_CHARS,
  normalizeAuthors,
  normalizeTopics,
  paperInputFromEvent,
  utf8ByteLength,
  validatePaperEvent,
} from '@forum4ai/shared';
import type { NostrEvent, PaperAuthor, PaperCode, PaperMeta, PaperWarningCode } from '@forum4ai/shared';

export const PAPERS_PHASE = '4a';

/**
 * Strop scanu kindu 30023 v jednom requeste (riadky). Paper je 100× ťažší
 * ako post — 5 000 riadkov je dostatok na to, aby board ostal aktuálny, a
 * zároveň to drží JSON parse v desiatkach ms (cache v route).
 */
export const PAPERS_SCAN_LIMIT = 5_000;
export const PAPERS_DEFAULT_LIMIT = 20;
export const PAPERS_MAX_LIMIT = 100;
export const PAPERS_TOPIC_MAX_LENGTH = MAX_PAPER_TOPIC_CHARS;
/** dĺžka `q` filtra (rovnaká logika ako `q` na /search — mieri do SQL LIKE) */
export const PAPERS_QUERY_MAX_CHARS = 200;

/** Radu boardu `GET /papers` — meta bez teľa a bez lintu. */
export interface PaperRow {
  id: string;
  /** adresa `30023:<pubkey>:<d>` (addressable kind), null = bez `d` tagu */
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
  /** veľkosť `content` v UTF-8 bajtoch — UI na tom visuje pri náhľade */
  body_bytes: number;
}

/** Detail `GET /papers/:id` — event + parsovaný papier + lint. */
export interface PaperDetail {
  id: string;
  addr: string | null;
  pubkey: string;
  created_at: number;
  kind: number;
  /** kánonický event tak, ako leží v indexe (signatúra od writer of record) */
  event: NostrEvent;
  /** parsovaný papier (title/authors/topics/doi/references/krížové odkazy) */
  paper: PaperMeta;
  /** lint výsledok: `ok` + chyby a varovania so stabilnými kódmi */
  lint: {
    ok: boolean;
    errors: string[];
    codes: PaperCode[];
    warnings: string[];
    warning_codes: PaperWarningCode[];
  };
}

export interface PaperBoardFilters {
  topic?: string;
  lang?: string;
  /** 64-hex pubkey autora (pubkey eventu AJ `author` tag s pubkey) */
  author?: string;
  /** substring cez nadpis/abstrakt (case-insensitive) */
  q?: string;
  since?: number;
  until?: number;
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Radu boardu z eventu. `paperInputFromEvent` je jediná cesta, ktorou sa
 * wire format číta — list NEspúšťa lint (žiadne regex skeny 160 KiB tela),
 * preto nevráti `references` ani varovania.
 */
export function paperRowFromEvent(event: NostrEvent): PaperRow {
  const input = paperInputFromEvent(event);
  const body = typeof event.content === 'string' ? event.content : '';
  const authors = normalizeAuthors(input.authors).authors;
  const topics = normalizeTopics(
    input.topics ?? (input.topic !== undefined ? [input.topic] : undefined),
  );
  const row: PaperRow = {
    id: event.id,
    addr: input.slug !== undefined ? `${event.kind}:${event.pubkey}:${input.slug}` : null,
    pubkey: event.pubkey,
    created_at: event.created_at,
    title: (input.title ?? '').trim(),
    authors,
    topics,
    lang: input.lang ?? null,
    body_bytes: utf8ByteLength(body),
  };
  if (input.abstract !== undefined) row.abstract = input.abstract;
  if (input.doi !== undefined) row.doi = input.doi;
  if (input.slug !== undefined) row.slug = input.slug;
  if (input.license !== undefined) row.license = input.license;
  if (input.version !== undefined) row.version = input.version;
  if (input.publishedAt !== undefined) row.published_at = input.publishedAt;
  return row;
}

/**
 * Detail = row + kánonický event +Lint. Lint beží len TU (jeden papier),
 * nie pri scane boardu.
 */
export function paperDetailFromEvent(event: NostrEvent): PaperDetail {
  const result = validatePaperEvent(event);
  const input = paperInputFromEvent(event);
  return {
    id: event.id,
    addr: input.slug !== undefined ? `${event.kind}:${event.pubkey}:${input.slug}` : null,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    event,
    paper: result.data ?? {
      title: '',
      authors: [],
      topics: [],
      coauthorPubkeys: [],
      lang: null,
      references: null,
      declaredRefs: { fig: [], tbl: [], eq: [] },
      citedKeys: [],
      crossRefs: [],
      bodyBytes: 0,
      richBlocks: 0,
    },
    lint: {
      ok: result.ok,
      errors: result.errors,
      codes: result.codes,
      warnings: result.warnings,
      warning_codes: result.warning_codes,
    },
  };
}

/**
 * Filter boardu (čistá funkcia — SQL vyberie len kind/jazyk/authora,
 * topic a `q` idú sem, lebo sedia v tagoch, nie v stĺpcoch).
 * Výsledok je newest-first (`created_at DESC, id DESC`), to isté drží SQL.
 */
export function filterPaperRows(rows: readonly PaperRow[], filters: PaperBoardFilters): PaperRow[] {
  const topic = filters.topic !== undefined ? normalizeForMatch(filters.topic) : undefined;
  const q = filters.q !== undefined ? normalizeForMatch(filters.q) : undefined;
  const author = filters.author !== undefined ? filters.author.toLowerCase() : undefined;

  return rows.filter((row) => {
    if (topic !== undefined && !row.topics.some((value) => normalizeForMatch(value) === topic)) return false;
    if (filters.lang !== undefined && row.lang !== filters.lang) return false;
    if (author !== undefined) {
      const authorKeys = [row.pubkey, ...row.authors.map((entry) => entry.pubkey ?? '')];
      if (!authorKeys.some((key) => key.toLowerCase() === author)) return false;
    }
    if (filters.since !== undefined && row.created_at < filters.since) return false;
    if (filters.until !== undefined && row.created_at > filters.until) return false;
    if (q !== undefined) {
      const haystack = normalizeForMatch(`${row.title} ${row.abstract ?? ''}`);
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}
