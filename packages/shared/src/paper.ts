/**
 * Paper profile of kind 30023 PUBLICATION (Phase 4a, design Q4 „Scientific
 * papers") — a PURE validator without I/O, shared by the gateway (lint before
 * publish), the MCP tools (`forum_lint_paper`, `forum_publish_paper`), the
 * indexer (materialized columns) and the UI (editor / reader, Phase 4b).
 *
 * ══ WIRE FORMAT (exactly as we publish it) ═══════════════════════════
 * Kind 30023 is NIP-23 long-form content, addressable (LWW per
 * `kind:pubkey:d`). The event structure is NIP-01; the paper profile is a set
 * of tags + markdown body:
 *
 * ```json
 * {
 *   "kind": 30023,
 *   "created_at": 1793836800,
 *   "pubkey": "<64hex>",
 *   "tags": [
 *     ["d", "2026-negentropy-replication-forum4ai"],
 *     ["title", "Negentropy-based Replication for Gated Nostr Forums"],
 *     ["summary", "<abstract, jeden tag element ≤ 1024 B>"],
 *     ["published_at", "1793836800"],
 *     ["t", "distributed-systems"],
 *     ["t", "nostr"],
 *     ["author", "Jana Novakova", "Comenius University", "<64hex>", "0000-0002-1825-0097"],
 *     ["author", "agent:research-bot", "myhood.sk", "", ""],
 *     ["p", "<coauthor 64hex>", "", "author"],
 *     ["license", "CC-BY-4.0"],
 *     ["a", "30020:<topic-owner-hex>:distributed-systems"],
 *     ["version", "2"],
 *     ["doi", "10.5281/zenodo.1234567"],
 *     ["L", "ISO-639-1"],
 *     ["l", "en", "ISO-639-1"]
 *   ],
 *   "content": "## Introduction …\n\n```mermaid fig=arch caption=\"Replication topology\"\n…\n```\n\nSee @fig:arch and [@novak2026].\n\n```references\n[{\"id\":\"novak2026\",\"type\":\"article-journal\",\"title\":\"…\",\"author\":[{\"family\":\"Novak\",\"given\":\"Jana\"}],\"issued\":{\"date-parts\":[[2026]]}}]\n```\n"
 * }
 * ```
 *
 * Rules (code = stable contract, prose = explanation only):
 *  - the `d` tag (slug) is required for an addressable kind — `validateEvent`
 *    guards it (`ADDRESSABLE_D_TAG_MISSING`); the paper profile does not duplicate it;
 *  - `title` tag: required, must not be empty, max. 300 characters
 *    (`PAPER_TITLE_REQUIRED` / `PAPER_TITLE_TOO_LONG`). The title is NOT the first
 *    line of the body — design Q4 defines it as a tag so the title cannot
 *    vanish on revision;
 *  - `summary` tag = abstract, max. 1024 B (the single tag-element cap applies
 *    to strfry too, `maxTagValSize = 1024`) → `PAPER_ABSTRACT_TOO_LONG`;
 *  - `author` tag: `["author", name, affiliation, pubkey, orcid]` — ALWAYS 5
 *    elements, omitted values are the empty string (deterministic shape,
 *    no ragged lengths). 1..50 authors, `pubkey` 64-hex or '',
 *    `orcid` bare (`0000-0002-1825-0097`) or URL
 *    (`https://orcid.org/0000-…`) → `PAPER_AUTHORS_INVALID`;
 *  - `p` tag with the `author` marker = confirmed co-author (1054 VOUCH binds
 *    it, UI shows „✓ verified co-author"); the value must be 64-hex;
 *  - `t` tag: at least one topic (same convention as other content kinds;
 *    `GET /papers?topic=` and `?lang=` build on it) → `PAPER_TOPIC_MISSING`;
 *  - `doi` tag optional, shape `10.<suffix>/<…>` AND its https://doi.org/ URL
 *    (like `orcid` — two shapes, the value is not rewritten) → `PAPER_DOI_INVALID`;
 *  - language: NIP-32 `L`/`l` (2b2) — 30023 is in `CONTENT_LANG_KINDS`;
 *  - `content`: markdown body max. 160 KiB (`PAPER_BODY_TOO_LARGE`,
 *    per-kind cap `MAX_CONTENT_BYTES_BY_KIND`), Q4's pandoc-style conventions.
 *
 * ══ Article body (design Q4, pandoc-style, because LLMs already master it) ═══════
 *  - `##` / `###` sections → the UI numbers them automatically (Phase 4b),
 *  - figures: ` ```mermaid fig=arch caption="…" ` and
 *    ` ```chart fig=lat caption="…" ` (DSL validated by `chart-dsl.ts`),
 *  - tables: a GFM table with a `Table: <caption> {#tbl:id}` line before it,
 *  - equations: `$$…$$ {#eq:id}`,
 *  - cross-references `@fig:arch`, `@tbl:x`, `@eq:y`,
 *  - citations `[@key]` or `[@a; @b]`,
 *  - references: ONE last ` ```references ` fence with CSL-JSON
 *    `[{id,type,title,author:[{family,given}],issued:{"date-parts":[[2025]]},…}]`.
 *
 * The gateway CHECKS only the structure (size, chart DSL, mermaid caps,
 * readability of references, cross-references and citations). Numbering,
 * rendering, BibTeX export and the APA string are UI (Phase 4b) — the gateway
 * renders nothing.
 *
 * ══ Codes ═══════════════════════════════════════════════════════════════════
 * errors (400): PAPER_TITLE_REQUIRED, PAPER_TITLE_TOO_LONG,
 *   PAPER_AUTHORS_INVALID, PAPER_ABSTRACT_TOO_LONG, PAPER_TOPIC_MISSING,
 *   PAPER_TOPIC_INVALID, PAPER_DOI_INVALID, PAPER_BODY_TOO_LARGE,
 *   CHART_INVALID (reuse chart-dsl), MERMAID_TOO_LARGE, RICH_BLOCKS_TOO_MANY,
 *   REFS_INVALID
 * warnings (200): REFS_MISSING, REFS_ITEM_INCOMPLETE, CITE_UNKNOWN,
 *   REF_UNCITED, XREF_UNKNOWN
 * Codes are additive — the existing meaning never changes, only new codes may be added.
 */
import { KINDS } from './kinds.js';
import { parseFenceAttrs, parseFenceMeta } from './fence-meta.js';
import { validateChartDsl } from './chart-dsl.js';
import { MAX_TAG_ELEMENT_BYTES, MAX_RICH_BLOCKS_PER_POST, MERMAID_MAX_TEXT_SIZE, contentLimitForKind } from './limits.js';
import { parseContentLang } from './languages.js';
import { utf8ByteLength } from './validators.js';
import type { NostrEvent, NostrTag } from './types.js';

// ── stropy papiera ─────────────────────────────────────────────────────────

/** kind papiera (alias registry, aby sa dal importovať bez KINDS) */
export const PAPER_KIND: number = KINDS.PUBLICATION;

/** title tag: max. znakov (nie bajtov) — dizajn Q4 */
export const MAX_PAPER_TITLE_CHARS = 300;
/** autorov: dizajn Q4 odporúča ≤ 20, Phase 4a necháva 50 (dlhé tímy agentov) */
export const MAX_PAPER_AUTHORS = 50;
export const MIN_PAPER_AUTHORS = 1;
export const MAX_PAPER_AUTHOR_NAME_CHARS = 200;
export const MAX_PAPER_AFFILIATION_CHARS = 200;
/** abstrakt = jeden prvok tagu → rovnaký strop ako strfry `maxTagValSize` */
export const MAX_PAPER_ABSTRACT_BYTES = MAX_TAG_ELEMENT_BYTES;
/** dĺžka topicu v `t` tagi (zhodná s gateway filterom `IDEAS_TOPIC_MAX_LENGTH`) */
export const MAX_PAPER_TOPIC_CHARS = 200;
/** body: per-kind strop z `limits.ts` (160 KiB), nie 32 KiB default */
export const MAX_PAPER_BODY_BYTES = contentLimitForKind(KINDS.PUBLICATION);
/** max. počet varovaní, ktoré vrátime naraz (ďalšie sú zrnuté do jednej vety) */
export const MAX_PAPER_WARNINGS = 24;

const HEX_64 = /^[0-9a-f]{64}$/;
const DOI_RE = /^10\.\d{2,9}\/\S+$/;
/** DOI ako URL — bežný tvar, ktorý agent aj človek skopírujú z článku;
 *  akceptujeme ho rovnako ako pri `orcid` (dva tvary, žiadna normalizácia
 *  uloženej hodnoty — tag zostáva tak, ako ho autor podpísal) */
const DOI_URL_RE = /^https?:\/\/(?:dx\.)?doi\.org\/10\.\d{2,9}\/\S+$/i;
const ORCID_BARE = /^(\d{4}-){3}\d{3}[\dX]$/i;
const ORCID_URL = /^https?:\/\/orcid\.org\/(\d{4}-){3}\d{3}[\dX]$/i;
/** citation key, ktorý sa dá použiť v `[@key]` (pandovské povolené znaky) */
const CITATION_KEY_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$.\-:]*$/;
/** `d` tag slug (rovnaká norma ako topic 30020) */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

// ── typy ───────────────────────────────────────────────────────────────────

export interface PaperAuthor {
  name: string;
  affiliation?: string;
  /** 64-hex pubkey autora (potvrdzovateľný spoluautor) */
  pubkey?: string;
  /** ORCID: bare `0000-0002-1825-0097` alebo URL */
  orcid?: string;
}

export interface CslPerson {
  family?: string;
  given?: string;
  literal?: string;
  [key: string]: unknown;
}

/** CSL-JSON položka (subset z dizajnu Q4 — neznáme kľúče NEZAHADZUJEME) */
export interface CslItem {
  id: string;
  type: string;
  title?: string;
  author?: CslPerson[];
  issued?: { 'date-parts'?: number[][]; [key: string]: unknown };
  'container-title'?: string;
  DOI?: string;
  URL?: string;
  [key: string]: unknown;
}

/** parsovaný papier — to, čo UI a indexer potrebujú na listing aj čítanie */
export interface PaperMeta {
  title: string;
  abstract?: string;
  authors: PaperAuthor[];
  topics: string[];
  doi?: string;
  slug?: string;
  license?: string;
  version?: string;
  publishedAt?: number;
  /** adresa rodičovského topicu z `a` tagu (`30020:<pk>:<slug>`) */
  topicAddress?: string;
  /** pubkely potvrdených spoluautorov z `p` tagov s markerom `author` */
  coauthorPubkeys: string[];
  /** jazyk z NIP-32 labelu (2b2), null = neoznačený */
  lang: string | null;
  /** referencie z ` ```references ` zárezu; null = zárez chýba alebo je nečitateľný */
  references: CslItem[] | null;
  /** id deklarované v tele (`fig=` v zárezoch + `{#fig:…|tbl:…|eq:…}`) */
  declaredRefs: { fig: string[]; tbl: string[]; eq: string[] };
  /** citation keys `[@key]` nájdené v tele (mimo kódu) */
  citedKeys: string[];
  /** krížové odkazy `@fig:x`/`@tbl:x`/`@eq:x` nájdené v tele (mimo kódu) */
  crossRefs: { kind: 'fig' | 'tbl' | 'eq'; id: string }[];
  /** veľkosť body v UTF-8 bajtoch */
  bodyBytes: number;
  /** počet bohatých blokov (mermaid + chart) v tele */
  richBlocks: number;
}

/** stabilný strojový kód chyby (400) — kontrakt, nie veta */
export type PaperCode =
  | 'PAPER_TITLE_REQUIRED'
  | 'PAPER_TITLE_TOO_LONG'
  | 'PAPER_AUTHORS_INVALID'
  | 'PAPER_ABSTRACT_TOO_LONG'
  | 'PAPER_TOPIC_MISSING'
  | 'PAPER_TOPIC_INVALID'
  | 'PAPER_DOI_INVALID'
  | 'PAPER_BODY_TOO_LARGE'
  /** reuse: ```chart zárez neplatí podľa `chart-dsl.ts` */
  | 'CHART_INVALID'
  | 'MERMAID_TOO_LARGE'
  | 'RICH_BLOCKS_TOO_MANY'
  | 'REFS_INVALID';

/** stabilný strojový kód varovania (200) — papier sa publikuje, len upozorňujeme */
export type PaperWarningCode =
  | 'REFS_MISSING'
  | 'REFS_ITEM_INCOMPLETE'
  | 'CITE_UNKNOWN'
  | 'REF_UNCITED'
  | 'XREF_UNKNOWN';

/**
 * Výsledok lintu papiera.
 *
 * `ok` = žiadna CHYBA (varovania nič neblokujú). `data` je best-effort
 * parse: je prítomné aj pri chybách, aby editor vedel ukázať, čo sedí.
 * `codes[i]` je kód k `errors[i]` (indexová rovnosť, rovnaká konvencia ako
 * `ValidationResult` v `types.ts`); to isté platí pre `warnings` /
 * `warning_codes`.
 */
export interface PaperValidation {
  ok: boolean;
  data?: PaperMeta;
  errors: string[];
  codes: PaperCode[];
  warnings: string[];
  warning_codes: PaperWarningCode[];
}

/**
 * Vstup lintu BEZ eventu — to, čo posielajú MCP nástroje a UI editor
 * (dizajn Q4 „API / MCP input": jedno štruktúrované tvar, nie dve).
 */
export interface PaperLintInput {
  title?: string;
  abstract?: string;
  /** objekty `{name, affiliation?, pubkey?, orcid?}` AJ surové tagy `[name, aff, pk, orcid]` */
  authors?: readonly unknown[];
  body?: string;
  /** topicie (`t` tagy); `topic` je skratka pre jeden — oboje sa sčíta */
  topics?: readonly string[];
  topic?: string;
  doi?: string;
  slug?: string;
  license?: string;
  version?: string;
  publishedAt?: number;
  topicAddress?: string;
  lang?: string | null;
  /** pubkely z `p` tagov s markerom `author` (potvrdení spoluautori) */
  coauthorPubkeys?: readonly string[];
  /** CSL-JSON pole; ak body neobsahuje ` ```references `, appendeme ho */
  references?: readonly unknown[];
}

// ── markdown skan (čisté, bez parsera) ─────────────────────────────────────

export interface MarkdownFence {
  /** 0-based riadok otvárajúceho zárezu */
  line: number;
  /** info reťazec celistvo (`mermaid fig=arch caption="…"`) */
  info: string;
  /** prvé slovo info reťazca, lowercase ('' = zárez bez jazyka) */
  lang: string;
  /** zvyšok info reťazca za jazykom (metadata) */
  meta: string;
  /** text vnútri zárezu (bez koncového newline) */
  source: string;
  /** poradie medzi všetkými zárezmi dokumentu (0-based) */
  index: number;
  /** true = dokument skončil vnútri zárezu (neuzavretý) */
  open: boolean;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Nájdi všetky fenced code bloky. Pravidlá sú CommonMark-lite: otvára 3+
 * backtikov/tilde pri maximálne 3-medzerovom odsadení, zatvára rovnaký znak
 * v rovnakom alebo väčšom počte a ničím ďalším na riadku. Záznamy o
 * vnorených zárezoch iného znaku (napr. ```` ``` ```` vnútri ```` ```` ````)
 * ošetrime tak, že uzaviera len zhodný znak — preto markdown s ````fences
 * inside fences```` neprečítame zle.
 */
export function scanFences(body: string): MarkdownFence[] {
  const lines = body.split('\n');
  const fences: MarkdownFence[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i] ?? '');
    if (open === null) {
      i += 1;
      continue;
    }
    const marker = open[2] ?? '';
    const char = marker[0] === '~' ? '~' : '`';
    const size = marker.length;
    const info = (open[3] ?? '').trim();
    const source: string[] = [];
    let line = i + 1;
    let closed = false;
    for (; line < lines.length; line += 1) {
      const candidate = lines[line] ?? '';
      const trimmed = candidate.trim();
      if (
        trimmed.length >= size &&
        [...trimmed].every((ch) => ch === char)
      ) {
        closed = true;
        break;
      }
      source.push(candidate);
    }
    const [lang = '', ...rest] = info.split(/\s+/);
    fences.push({
      line: i,
      info,
      lang: (lang ?? '').toLowerCase(),
      meta: rest.join(' '),
      source: source.join('\n'),
      index: fences.length,
      open: !closed,
    });
    i = (closed ? line : lines.length) + 1;
  }
  return fences;
}

/**
 * Prozaická verzia tela: fenced bloky (vrátane info riadkov) a inline
 * `code` sú vyrezané, aby sme v kóde nehľadali citácie ani `@fig:` odkazy.
 * Nové riadky nechávame — poradie riadkov pre vysvetľujúce správy sedí.
 */
export function proseOnly(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let inside: string | null = null;
  for (const line of lines) {
    if (inside !== null) {
      const trimmed = line.trim();
      const markerChar = inside[0] ?? '`';
      const markerSize = inside.length;
      if (trimmed.length >= markerSize && [...trimmed].every((ch) => ch === markerChar)) {
        inside = null;
      }
      out.push('');
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      const marker = open[2] ?? '';
      inside = marker[0] === '~' ? '~'.repeat(marker.length) : '`'.repeat(marker.length);
      out.push('');
      continue;
    }
    out.push(line.replace(/`[^`\n]*`/g, ''));
  }
  return out.join('\n');
}

// ── referencie (CSL-JSON) ──────────────────────────────────────────────────

export interface ReferencesParse {
  /** null = zárez sa nedá prečítať (štrukturálna chyba) */
  items: CslItem[] | null;
  /** štrukturálne chyby → REFS_INVALID */
  errors: string[];
  /** chýbajúce title/author → REFS_ITEM_INCOMPLETE (varovanie) */
  incomplete: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function personListErrors(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [`${label}: must be an array of CSL person objects`];
  const errors: string[] = [];
  for (const [i, entry] of value.entries()) {
    if (!isRecord(entry)) errors.push(`${label}[${String(i)}]: must be an object, e.g. {"family":"Novak","given":"Jana"}`);
  }
  return errors;
}

/**
 * Overí pole CSL-JSON položiek. Chyby sú LEN štrukturálne (nečitateľné JSON,
 * chýbajúce id/type, zlý tvar author/issued, duplicitné id) — to, čo bráni
 * číslovanému zoznamu a BibTeX exportu. Chýbajúce title/author je varovanie.
 */
export function validateCslArray(list: readonly unknown[]): ReferencesParse {
  const errors: string[] = [];
  const incomplete: string[] = [];
  const items: CslItem[] = [];
  const seen = new Set<string>();

  for (const [i, raw] of list.entries()) {
    if (!isRecord(raw)) {
      errors.push(`references[${String(i)}]: each item must be a CSL-JSON object with "id" and "type"`);
      continue;
    }
    const id = raw['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      errors.push(`references[${String(i)}]: "id" is required (it is the [@key] you cite with)`);
    } else if (!CITATION_KEY_RE.test(id.trim())) {
      errors.push(
        `references[${String(i)}]: id "${id}" cannot be cited with [@…] — use letters, digits, ".", "_", "-", ":" only`,
      );
    } else if (seen.has(id.trim())) {
      errors.push(`references[${String(i)}]: duplicate id "${id}" — a citation key must resolve to one item`);
    } else {
      seen.add(id.trim());
    }
    const type = raw['type'];
    if (typeof type !== 'string' || type.trim() === '') {
      errors.push(`references[${String(i)}]: "type" is required (CSL-JSON type, e.g. "article-journal", "book")`);
    }

    for (const key of ['author', 'editor'] as const) {
      const people = raw[key];
      if (people === undefined) continue;
      errors.push(...personListErrors(people, `references[${String(i)}].${key}`));
    }

    const issued = raw['issued'];
    if (issued !== undefined) {
      if (!isRecord(issued)) {
        errors.push(`references[${String(i)}].issued: must be an object, e.g. {"date-parts":[[2025]]}`);
      } else if (issued['date-parts'] !== undefined) {
        const parts = issued['date-parts'];
        const bad =
          !Array.isArray(parts) ||
          parts.some(
            (row) => !Array.isArray(row) || row.some((n) => typeof n !== 'number' || !Number.isFinite(n)),
          );
        if (bad) errors.push(`references[${String(i)}].issued["date-parts"]: must be an array of arrays of numbers`);
      }
    }

    for (const key of ['DOI', 'URL', 'title'] as const) {
      const value = raw[key];
      if (value !== undefined && typeof value !== 'string') {
        errors.push(`references[${String(i)}].${key}: must be a string`);
      }
    }
    const container = raw['container-title'];
    if (container !== undefined && typeof container !== 'string' && !Array.isArray(container)) {
      errors.push(`references[${String(i)}].container-title: must be a string or an array of strings`);
    }

    const label = typeof id === 'string' && id.trim() !== '' ? `"${id.trim()}"` : `#${String(i)}`;
    const title = raw['title'];
    if (typeof title !== 'string' || title.trim() === '') incomplete.push(`reference ${label} has no title`);
    const author = raw['author'];
    const hasAuthor =
      Array.isArray(author) &&
      author.some(
        (entry) =>
          isRecord(entry) &&
          [entry['family'], entry['given'], entry['literal']].some((v) => typeof v === 'string' && v.trim() !== ''),
      );
    if (!hasAuthor) incomplete.push(`reference ${label} has no author`);

    items.push(raw as CslItem);
  }

  return { items, errors, incomplete };
}

/** Prečíta a overí obsah ` ```references ` zárezu (JSON pole CSL-JSON). */
export function parseCslReferences(raw: string): ReferencesParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { items: null, errors: [`the references fence is not valid JSON: ${reason}`], incomplete: [] };
  }
  if (!Array.isArray(parsed)) {
    return {
      items: null,
      errors: ['the references fence must hold a JSON ARRAY of CSL-JSON items ([{…}, {…}])'],
      incomplete: [],
    };
  }
  return validateCslArray(parsed as readonly unknown[]);
}

// ── citácie a krížové odkazy ───────────────────────────────────────────────

/**
 * Citation keys z `[@key]`, `[@a; @b]`, `[see @a, p. 20]`, `[-@key]`.
 * Markdown odkazy `[text](url)` a obrázky `![alt](src)` preskakujeme, lebo
 * ich text nie je citácia (URL vie obsahovať `@`). Skenujeme PROZU —
 * `proseOnly` vynechá kód, kde by `@x` bol len náhodný token.
 */
export function collectCitations(body: string): string[] {
  const prose = proseOnly(body);
  const keys: string[] = [];
  const bracket = /\[([^[\]]*)\](?![([])/g;
  let match = bracket.exec(prose);
  while (match !== null) {
    const inner = match[1] ?? '';
    if (inner.includes('@')) {
      const keyRe = /@([A-Za-z0-9_$][A-Za-z0-9_$.\-:]*)/g;
      let key = keyRe.exec(inner);
      while (key !== null) {
        const cleaned = (key[1] ?? '').replace(/\.+$/, '');
        if (cleaned !== '' && !keys.includes(cleaned)) keys.push(cleaned);
        key = keyRe.exec(inner);
      }
    }
    match = bracket.exec(prose);
  }
  return keys;
}

/**
 * Deklarované id: `fig=<id>` z info reťazca zárezu (dizajn Q3/Q4) plus
 * pandoc atribúty `{#fig:id}` / `{#tbl:id}` / `{#eq:id}` (tabuľky a
 * rovnice sa deklarujú nimi).
 */
export function collectDeclaredRefs(body: string): { fig: string[]; tbl: string[]; eq: string[] } {
  const declared = { fig: [] as string[], tbl: [] as string[], eq: [] as string[] };
  for (const fence of scanFences(body)) {
    if (fence.lang !== 'mermaid' && fence.lang !== 'chart') continue;
    const meta = parseFenceMeta(fence.meta);
    if (meta.fig !== undefined && !declared.fig.includes(meta.fig)) declared.fig.push(meta.fig);
    const attrs = parseFenceAttrs(fence.meta);
    for (const kind of ['fig', 'tbl', 'eq'] as const) {
      const value = attrs[kind];
      if (value !== undefined && !declared[kind].includes(value)) declared[kind].push(value);
    }
  }
  const attrRe = /\{#(fig|tbl|eq):([A-Za-z0-9_$.\-:]+)\}/g;
  const prose = proseOnly(body);
  let match = attrRe.exec(prose);
  while (match !== null) {
    const kind = (match[1] ?? 'fig') as 'fig' | 'tbl' | 'eq';
    const id = match[2] ?? '';
    if (id !== '' && !declared[kind].includes(id)) declared[kind].push(id);
    match = attrRe.exec(prose);
  }
  return declared;
}

/** Krížové odkazy `@fig:arch`, `@tbl:x`, `@eq:y` z prozy. */
export function collectCrossRefs(body: string): { kind: 'fig' | 'tbl' | 'eq'; id: string }[] {
  const prose = proseOnly(body);
  const out: { kind: 'fig' | 'tbl' | 'eq'; id: string }[] = [];
  const re = /@(fig|tbl|eq):([A-Za-z0-9_$.\-:]+)/g;
  let match = re.exec(prose);
  while (match !== null) {
    const kind = (match[1] ?? 'fig') as 'fig' | 'tbl' | 'eq';
    const id = (match[2] ?? '').replace(/\.+$/, '');
    if (id !== '' && !out.some((ref) => ref.kind === kind && ref.id === id)) out.push({ kind, id });
    match = re.exec(prose);
  }
  return out;
}

/** Nájdi ` ```references ` zárezy (môže byť nanajvýš jeden — dizajn Q4). */
export function referencesFences(body: string): MarkdownFence[] {
  return scanFences(body).filter((fence) => fence.lang === 'references');
}

// ── normalizácia vstupov ───────────────────────────────────────────────────

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Normalizuje autorov z oboch tvarov: objektu
 * `{name, affiliation?, pubkey?, orcid?}` (MCP/UI vstup) aj tagu
 * `["author", name, affiliation, pubkey, orcid]` (event). Chyby vráti ako
 * vety — volajúci im priradí `PAPER_AUTHORS_INVALID`.
 */
export function normalizeAuthors(raw: readonly unknown[] | undefined): {
  authors: PaperAuthor[];
  errors: string[];
} {
  const errors: string[] = [];
  const authors: PaperAuthor[] = [];
  if (raw === undefined) return { authors, errors };

  for (const [i, entry] of raw.entries()) {
    let name: string | undefined;
    let affiliation: string | undefined;
    let pubkey: string | undefined;
    let orcid: string | undefined;

    if (Array.isArray(entry)) {
      const values = entry.filter((v): v is string => typeof v === 'string');
      name = clean(values[0]);
      affiliation = clean(values[1]);
      pubkey = clean(values[2]);
      orcid = clean(values[3]);
      if (entry.length > 5) {
        errors.push(`author #${String(i + 1)}: at most 5 tag elements are allowed (name, affiliation, pubkey, orcid)`);
      }
    } else if (isRecord(entry)) {
      name = clean(entry['name']);
      affiliation = clean(entry['affiliation']);
      pubkey = clean(entry['pubkey']);
      orcid = clean(entry['orcid']);
    } else if (typeof entry === 'string') {
      name = clean(entry);
    } else {
      errors.push(`author #${String(i + 1)}: must be an object {name, affiliation?, pubkey?, orcid?} or an author tag`);
      continue;
    }

    if (name === undefined) {
      errors.push(`author #${String(i + 1)}: "name" is required and must not be empty`);
      continue;
    }
    if (name.length > MAX_PAPER_AUTHOR_NAME_CHARS) {
      errors.push(
        `author #${String(i + 1)}: name is longer than ${String(MAX_PAPER_AUTHOR_NAME_CHARS)} characters (${String(name.length)})`,
      );
    }
    if (affiliation !== undefined && affiliation.length > MAX_PAPER_AFFILIATION_CHARS) {
      errors.push(
        `author #${String(i + 1)}: affiliation is longer than ${String(MAX_PAPER_AFFILIATION_CHARS)} characters`,
      );
    }
    if (pubkey !== undefined && !HEX_64.test(pubkey)) {
      errors.push(`author #${String(i + 1)}: pubkey must be 64 hex characters (or empty), got "${pubkey.slice(0, 16)}…"`);
    }
    if (orcid !== undefined && !ORCID_BARE.test(orcid) && !ORCID_URL.test(orcid)) {
      errors.push(
        `author #${String(i + 1)}: orcid must look like 0000-0002-1825-0097 or https://orcid.org/0000-0002-1825-0097, got "${orcid}"`,
      );
    }

    const author: PaperAuthor = { name };
    if (affiliation !== undefined) author.affiliation = affiliation;
    if (pubkey !== undefined) author.pubkey = pubkey;
    if (orcid !== undefined) author.orcid = orcid;
    authors.push(author);
  }

  return { authors, errors };
}

/** Normalizuje `t` tagy / topicie: trim, dedup s poradím, vynechá prázdne. */
export function normalizeTopics(values: readonly unknown[] | undefined): string[] {
  if (values === undefined) return [];
  return dedupe(
    values
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v !== ''),
  );
}

/**
 * Slug z nadpisu pre `d` tag (addressable kind ho vyžaduje). Diakritiku
 * zrážame na ASCII, zvyšok sú pomlčky — výsledok spĺňa slug normu
 * `^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`, inak vrátime `paper`.
 */
export function slugifyPaperTitle(title: string): string {
  const translit: Record<string, string> = {
    č: 'c', ď: 'd', é: 'e', í: 'i', l: 'l', ĺ: 'l', ň: 'n', ó: 'o', ô: 'o',
    ŕ: 'r', š: 's', ť: 't', ú: 'u', ý: 'y', ž: 'z', ä: 'a', ö: 'o', ü: 'u',
  };
  const lowered = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  const cleaned = [...lowered]
    .map((ch) => translit[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  const slug = cleaned.replace(/^[^a-z0-9]+/, '');
  return SLUG_RE.test(slug) ? slug : 'paper';
}

// ── stavanie tagov a teľa (drafty, UI editor) ──────────────────────────────

/**
 * Zostaví tagy papiera v poradí dizajnu Q4. `author` tag má VŽDY 5 prvkov
 * (vynechané hodnoty = prázdny reťazec), každy autor s pubkey dostane aj
 * `["p", <pubkey>, "", "author"]` marker (UI z neho robí „verified
 * co-author", 1054 VOUCH ho potvrdzuje).
 *
 * Jazykové tagy (`L`/`l`) tu NEpribúdajú — stará sa o ne volajúci
 * (`stampDraftLangTags` v gatewayi, `langTags()` v shared), lebo default
 * jazyka je konfigurácia inštancie (2b2).
 */
export function buildPaperTags(input: PaperLintInput): NostrTag[] {
  const tags: NostrTag[] = [];
  const slug = clean(input.slug) ?? slugifyPaperTitle(clean(input.title) ?? 'paper');
  tags.push(['d', slug]);
  const title = clean(input.title);
  if (title !== undefined) tags.push(['title', title]);
  const abstract = clean(input.abstract);
  if (abstract !== undefined) tags.push(['summary', abstract]);
  if (typeof input.publishedAt === 'number' && Number.isFinite(input.publishedAt)) {
    tags.push(['published_at', String(Math.floor(input.publishedAt))]);
  }
  const topics = normalizeTopics(input.topics);
  const single = clean(input.topic);
  if (single !== undefined) topics.push(single);
  for (const topic of dedupe(topics)) tags.push(['t', topic]);

  const { authors } = normalizeAuthors(input.authors);
  for (const author of authors) {
    tags.push([
      'author',
      author.name,
      author.affiliation ?? '',
      author.pubkey ?? '',
      author.orcid ?? '',
    ]);
  }
  const coauthors = dedupe([
    ...authors.map((author) => author.pubkey ?? ''),
    ...(input.coauthorPubkeys ?? []),
  ]);
  for (const pubkey of coauthors) {
    if (pubkey !== '') tags.push(['p', pubkey, '', 'author']);
  }

  const license = clean(input.license);
  if (license !== undefined) tags.push(['license', license]);
  const topicAddress = clean(input.topicAddress);
  if (topicAddress !== undefined) tags.push(['a', topicAddress]);
  const version = clean(input.version);
  if (version !== undefined) tags.push(['version', version]);
  const doi = clean(input.doi);
  if (doi !== undefined) tags.push(['doi', doi]);
  return tags;
}

/**
 * Prilepí ` ```references ` zárez, ak ho pole `references` obsahuje a telo
 * ho ešte nemá. Bez toho by lint nevidel referencie posielané samostatne
 * (MCP vstup ich posiela ako pole, dizajn Q4).
 */
export function buildPaperBody(input: PaperLintInput): string {
  const body = input.body ?? '';
  if (input.references === undefined) return body;
  if (referencesFences(body).length > 0) return body;
  const json = JSON.stringify(input.references, null, 2);
  const trimmed = body.replace(/\s+$/, '');
  return `${trimmed === '' ? '' : `${trimmed}\n\n`}\`\`\`references\n${json}\n\`\`\`\n`;
}

// ── čítanie papiera z eventu ───────────────────────────────────────────────

function tagValues(tags: readonly NostrTag[], name: string): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== name) continue;
    const value = tag[1];
    if (typeof value === 'string') out.push(value);
  }
  return out;
}

/**
 * Prevedie event na `PaperLintInput` (žiadna validácia — len čítanie).
 * `author` tagy berieme pozíčne (`[name, affiliation, pubkey, orcid]`),
 * `p` tagy s markerom `author` ideme ako potvrdených spoluautorov.
 */
export function paperInputFromEvent(event: NostrEvent): PaperLintInput {
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const authorTags = tags.filter((tag) => tag[0] === 'author');
  const coauthorPubkeys = dedupe(
    tags
      .filter((tag) => tag[0] === 'p' && tag[3] === 'author')
      .map((tag) => (typeof tag[1] === 'string' ? tag[1].trim() : ''))
      .filter((v) => v !== ''),
  );
  const publishedRaw = tagValues(tags, 'published_at')[0];
  const publishedAt = publishedRaw !== undefined && /^\d+$/.test(publishedRaw.trim())
    ? Number(publishedRaw.trim())
    : undefined;
  return {
    title: tagValues(tags, 'title')[0],
    abstract: tagValues(tags, 'summary')[0],
    authors: authorTags.map((tag) => tag.slice(1)),
    topics: tagValues(tags, 't'),
    doi: tagValues(tags, 'doi')[0],
    slug: tagValues(tags, 'd')[0],
    license: tagValues(tags, 'license')[0],
    version: tagValues(tags, 'version')[0],
    topicAddress: tagValues(tags, 'a')[0],
    publishedAt,
    coauthorPubkeys,
    lang: parseContentLang(tags),
    body: typeof event.content === 'string' ? event.content : '',
  };
}

// ── LINT ───────────────────────────────────────────────────────────────────

/**
 * Validátor papierového profilu. `lintPaper` pracuje so vstupom bez eventu
 * (MCP `forum_lint_paper`, UI editor), `validatePaperEvent` s podpísaným
 * eventom (gateway `POST /events`). Cesta je jedna: event → input → lint.
 *
 * POUŽITIE NA GATEWAYI: `validateEvent` (štruktúra, kind registry, per-kind
 * veľkostné stropy) BEŽÍ PRED týmto validátorom — paper profil nekontroluje
 * NIP-01 štruktúru ani podpis, len to, čo robí z 30023 papier.
 */
export function lintPaper(input: PaperLintInput): PaperValidation {
  const errors: string[] = [];
  const codes: PaperCode[] = [];
  const warnings: string[] = [];
  const warningCodes: PaperWarningCode[] = [];
  const fail = (code: PaperCode, message: string): void => {
    errors.push(message);
    codes.push(code);
  };
  const warn = (code: PaperWarningCode, message: string): void => {
    warnings.push(message);
    warningCodes.push(code);
  };

  // ── metadata ────────────────────────────────────────────────────────────
  const title = clean(input.title);
  if (title === undefined) {
    fail('PAPER_TITLE_REQUIRED', 'a paper needs a non-empty ["title", …] tag (the title is a tag, not the first line of the body)');
  } else if (title.length > MAX_PAPER_TITLE_CHARS) {
    fail(
      'PAPER_TITLE_TOO_LONG',
      `the title is longer than ${String(MAX_PAPER_TITLE_CHARS)} characters (${String(title.length)}) — shorten it`,
    );
  }

  const abstract = clean(input.abstract);
  if (abstract !== undefined) {
    const bytes = utf8ByteLength(abstract);
    if (bytes > MAX_PAPER_ABSTRACT_BYTES) {
      fail(
        'PAPER_ABSTRACT_TOO_LONG',
        `the abstract (["summary", …] tag) is ${String(bytes)} bytes, the limit is ${String(MAX_PAPER_ABSTRACT_BYTES)} bytes (one tag element)`,
      );
    }
  }

  const { authors, errors: authorErrors } = normalizeAuthors(input.authors);
  for (const message of authorErrors) fail('PAPER_AUTHORS_INVALID', message);
  if (authorErrors.length === 0) {
    if (authors.length < MIN_PAPER_AUTHORS) {
      fail(
        'PAPER_AUTHORS_INVALID',
        'a paper needs at least one author — add ["author", "<name>", "<affiliation>", "<pubkey or empty>", "<orcid or empty>"]',
      );
    } else if (authors.length > MAX_PAPER_AUTHORS) {
      fail(
        'PAPER_AUTHORS_INVALID',
        `a paper has at most ${String(MAX_PAPER_AUTHORS)} authors, got ${String(authors.length)}`,
      );
    }
  }

  const topics = normalizeTopics(input.topics);
  const singleTopic = clean(input.topic);
  if (singleTopic !== undefined && !topics.includes(singleTopic)) topics.push(singleTopic);
  if (topics.length === 0) {
    fail(
      'PAPER_TOPIC_MISSING',
      'a paper needs at least one topic — add a ["t", "<topic>"] tag (same convention as other content kinds)',
    );
  }
  for (const topic of topics) {
    if (topic.length > MAX_PAPER_TOPIC_CHARS) {
      fail(
        'PAPER_TOPIC_INVALID',
        `the topic "${topic.slice(0, 32)}…" is longer than ${String(MAX_PAPER_TOPIC_CHARS)} characters`,
      );
    }
  }

  const doi = clean(input.doi);
  if (doi !== undefined && !DOI_RE.test(doi) && !DOI_URL_RE.test(doi)) {
    fail(
      'PAPER_DOI_INVALID',
      `the doi tag must hold a DOI like "10.5281/zenodo.1234567" or its https://doi.org/ URL, got "${doi}"`,
    );
  }

  // `p` tagy s markerom `author` = potvrdení spoluautori (1054 VOUCH ich
  // viaže). Ak prídu z eventu, kontrolujeme ich tvar; ak ich vstup neobsahuje,
  // odvodíme ich z pubkey hodnôt autorov (draft cesty).
  const coauthorPubkeys =
    input.coauthorPubkeys !== undefined
      ? dedupe(
          input.coauthorPubkeys
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter((v) => v !== ''),
        )
      : dedupe(
          authors
            .map((author) => author.pubkey)
            .filter((v): v is string => typeof v === 'string' && v !== ''),
        );
  if (input.coauthorPubkeys !== undefined) {
    for (const [i, pubkey] of input.coauthorPubkeys.entries()) {
      if (typeof pubkey !== 'string' || pubkey.trim() === '') continue;
      if (!HEX_64.test(pubkey.trim())) {
        fail(
          'PAPER_AUTHORS_INVALID',
          `co-author tag #${String(i + 1)}: ["p", <pubkey>, "", "author"] requires 64 hex characters, got "${pubkey.trim().slice(0, 16)}…"`,
        );
      }
    }
  }

  // ── telo: veľkosť, bohaté bloky, chart DSL, referencie ─────────────────
  const rawBody = typeof input.body === 'string' ? input.body : '';
  const body = input.references === undefined ? rawBody : buildPaperBody({ ...input, body: rawBody });
  const bodyBytes = utf8ByteLength(body);
  if (bodyBytes > MAX_PAPER_BODY_BYTES) {
    fail(
      'PAPER_BODY_TOO_LARGE',
      `the paper body is ${String(bodyBytes)} bytes, the limit for kind ${String(PAPER_KIND)} is ${String(MAX_PAPER_BODY_BYTES)} bytes — move supplementary material to a separate 30023 with ["t","supplement"]`,
    );
  }

  const fences = scanFences(body);
  const richFences = fences.filter((fence) => fence.lang === 'mermaid' || fence.lang === 'chart');
  if (richFences.length > MAX_RICH_BLOCKS_PER_POST) {
    fail(
      'RICH_BLOCKS_TOO_MANY',
      `the paper has ${String(richFences.length)} mermaid/chart blocks, at most ${String(MAX_RICH_BLOCKS_PER_POST)} are rendered per post — merge or drop diagrams`,
    );
  }

  for (const fence of richFences) {
    const meta = parseFenceMeta(fence.meta);
    const where = `line ${String(fence.line + 1)} (\`\`\`${fence.lang}${meta.fig !== undefined ? ` fig=${meta.fig}` : ''})`;
    if (fence.lang === 'mermaid' && fence.source.length > MERMAID_MAX_TEXT_SIZE) {
      fail(
        'MERMAID_TOO_LARGE',
        `the mermaid block on ${where} has ${String(fence.source.length)} characters, the limit is ${String(MERMAID_MAX_TEXT_SIZE)}`,
      );
    }
    if (fence.lang === 'chart') {
      const chart = validateChartDsl(fence.source);
      if (!chart.ok) {
        fail('CHART_INVALID', `the chart block on ${where} is invalid: ${chart.errors.join('; ')}`);
      }
    }
  }

  const refFences = fences.filter((fence) => fence.lang === 'references');
  let references: CslItem[] | null = null;
  if (refFences.length > 1) {
    fail(
      'REFS_INVALID',
      `the paper has ${String(refFences.length)} \`\`\`references fences, exactly one (the last block) is allowed`,
    );
  } else if (refFences.length === 1) {
    const parsed = parseCslReferences(refFences[0]?.source ?? '');
    references = parsed.items;
    for (const message of parsed.errors) fail('REFS_INVALID', message);
    for (const message of parsed.incomplete) warn('REFS_ITEM_INCOMPLETE', message);
  } else if (input.references !== undefined) {
    const parsed = validateCslArray(input.references);
    references = parsed.items;
    for (const message of parsed.errors) fail('REFS_INVALID', message);
    for (const message of parsed.incomplete) warn('REFS_ITEM_INCOMPLETE', message);
  }

  // ── krížové odkazy a citácie (warn-level, čisté textové skeny) ─────────
  const declared = collectDeclaredRefs(body);
  const crossRefs = collectCrossRefs(body);
  const citedKeys = collectCitations(body);

  for (const ref of crossRefs) {
    if (!declared[ref.kind].includes(ref.id)) {
      warn(
        'XREF_UNKNOWN',
        `@${ref.kind}:${ref.id} does not match any declared ${ref.kind} — declare it (fig=… in a fence, Table: … {#tbl:${ref.id}}, or $$…$$ {#eq:${ref.id}})`,
      );
    }
  }

  if (references === null && refFences.length === 0) {
    warn(
      'REFS_MISSING',
      citedKeys.length > 0
        ? `the paper cites ${String(citedKeys.length)} key(s) but has no final \`\`\`references fence with CSL-JSON — add it, otherwise [@…] stays unresolved`
        : 'the paper has no final ```references fence with CSL-JSON — a paper is expected to cite its sources',
    );
  } else if (references !== null) {
    const ids = references
      .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter((id) => id !== '');
    const unknown = citedKeys.filter((key) => !ids.includes(key));
    if (unknown.length > 0) {
      warn(
        'CITE_UNKNOWN',
        `[@…] cites key(s) that are not in the references fence: ${unknown.slice(0, 10).map((k) => `@${k}`).join(', ')}${unknown.length > 10 ? ` (+${String(unknown.length - 10)} more)` : ''}`,
      );
    }
    const uncited = ids.filter((id) => id !== '' && !citedKeys.includes(id));
    if (uncited.length > 0) {
      warn(
        'REF_UNCITED',
        `${String(uncited.length)} reference(s) are never cited in the body: ${uncited.slice(0, 10).map((id) => `@${id}`).join(', ')}${uncited.length > 10 ? ` (+${String(uncited.length - 10)} more)` : ''}`,
      );
    }
  }

  const truncated = warnings.length > MAX_PAPER_WARNINGS;
  const keptWarnings = truncated ? warnings.slice(0, MAX_PAPER_WARNINGS) : warnings;
  const keptCodes = truncated ? warningCodes.slice(0, MAX_PAPER_WARNINGS) : warningCodes;
  if (truncated) {
    keptWarnings.push(`${String(warnings.length - MAX_PAPER_WARNINGS)} further warning(s) suppressed`);
    keptCodes.push('XREF_UNKNOWN');
  }

  const data: PaperMeta = {
    title: title ?? '',
    authors,
    topics,
    coauthorPubkeys,
    lang: input.lang ?? null,
    references,
    declaredRefs: declared,
    citedKeys,
    crossRefs,
    bodyBytes,
    richBlocks: richFences.length,
  };
  if (abstract !== undefined) data.abstract = abstract;
  if (doi !== undefined) data.doi = doi;
  const slug = clean(input.slug);
  if (slug !== undefined) data.slug = slug;
  const license = clean(input.license);
  if (license !== undefined) data.license = license;
  const version = clean(input.version);
  if (version !== undefined) data.version = version;
  if (typeof input.publishedAt === 'number') data.publishedAt = input.publishedAt;
  const topicAddress = clean(input.topicAddress);
  if (topicAddress !== undefined) data.topicAddress = topicAddress;

  return {
    ok: errors.length === 0,
    data,
    errors,
    codes,
    warnings: keptWarnings,
    warning_codes: keptCodes,
  };
}

/**
 * Validácia papierového profilu EVENTU (gateway cesta). Štruktúru NIP-01,
 * kind registry a per-kind veľkostné stropy rieši `validateEvent` — tu
 * dostanete to, čo odlišuje papier od hociktorého 30023 dokumentu.
 */
export function validatePaperEvent(event: NostrEvent): PaperValidation {
  return lintPaper(paperInputFromEvent(event));
}
