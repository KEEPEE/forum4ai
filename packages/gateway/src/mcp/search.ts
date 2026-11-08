/**
 * Lokálne vyhľadávanie pre MCP `forum_search` (F4AI-12, S6 — F1 verzia).
 *
 * Ako to funguje: gateway `GET /recent` stiahne posledných N eventov
 * (default 500, kindy 1020/1021/1022/1023) a TU prebehne substring/word
 * matching — case-insensitive a so **normalizáciou slovenskej diakritiky**
 * (`háčiky`/`čárky` sa porovnávajú bez mäkčeňov: `priklad` nájde `Príklad`,
 * `vlhk` nájde `vlhko`). Toto je zámerne jednoduché riešenie prvej fázy:
 * **v S8 to vymeníme za SQLite FTS5** (indexovaný fulltext na gatewayi),
 * rozhranie nástroja (`query`, `limit`) sa nezmení.
 *
 * Determinizmus: skóre = postih za chýbajúce termíny (AND sémantika —
 * všetky termíny sa musia objaviť), body za výskyty a bonus za whole-word
 * zhodu + full-phrase; pri rovnakom skóre rozhoduje `created_at` klesajúco.
 * Snippet sa vracia z ORIGINÁLneho contentu — index si drží mapovanie
 * normalizovanej pozície späť na surový reťazec.
 */
import { eventTitle } from '@forum4ai/shared';

/** normalizácia pre porovnanie: NFD → odstrániť mäkčene → lowercase → zlúčiť biele znaky */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizuje text a zároveň vráti mapovanie pozície v normalizovanom
 * reťazci na pozíciu v origináli (kvôli snippetu z pôvodných znakov).
 */
export function normalizeWithMap(text: string): { normalized: string; rawIndex: number[] } {
  const rawIndex: number[] = [];
  let normalized = '';
  for (const [i, ch] of [...text].entries()) {
    const stripped = ch
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase();
    for (const out of stripped) {
      normalized += out;
      rawIndex.push(i);
    }
  }
  // biele znaky zlúčime ako pri normalizeForSearch — pozície zostávajú
  // korektné (mapujeme na začiatok bielych seqencií, to stačí na snippet)
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return { normalized, rawIndex };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function countWordOccurrences(hay: string, term: string): number {
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:[^a-z0-9]|$)`, 'g');
  return (hay.match(re) ?? []).length;
}

/** vstup vyhľadávania — stačia kánonické polia, ktoré prídu z /recent */
export interface SearchableEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface SearchMatch {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  score: number;
  matched_terms: string[];
  /** výstrižok z originálneho contentu okolo prvej zhody (~160 znakov) */
  snippet: string;
  /**
   * F4AI-42: the event's title, derived by the same `eventTitle` rule the FTS5
   * index uses — so an agent that fell back to a local scan sees the same
   * headings it would have seen from `GET /search`. `null` = no readable title.
   */
  title: string | null;
}

const SNIPPET_RADIUS = 80;

/**
 * Nájdi eventy obsahujúce **všetky** termíny dotazu (AND, case/diacritics
 * insensitive). Vráti zoradené zhody (skóre klesajúco, potom created_at
 * klesajúco) ostrihnuté na `limit`.
 */
export function searchEvents(
  events: SearchableEvent[],
  query: string,
  limit: number,
): SearchMatch[] {
  const normalizedQuery = normalizeForSearch(query);
  const terms = normalizedQuery.split(' ').filter((t) => t !== '');
  if (terms.length === 0) return [];

  const matches: SearchMatch[] = [];
  for (const event of events) {
    const { normalized, rawIndex } = normalizeWithMap(event.content);
    if (normalized === '') continue;

    const hitTerms: string[] = [];
    let score = 0;
    let firstHitAt = -1;
    let allFound = true;
    for (const term of terms) {
      const at = normalized.indexOf(term);
      if (at === -1) {
        allFound = false;
        break;
      }
      hitTerms.push(term);
      score += countOccurrences(normalized, term) + 2 * countWordOccurrences(normalized, term);
      if (firstHitAt === -1 || at < firstHitAt) firstHitAt = at;
    }
    if (!allFound) continue;

    if (terms.length > 1 && normalized.includes(normalizedQuery)) {
      score += 50; // full-phrase bonus
    }

    const snippetStart = Math.max(0, rawIndex[firstHitAt] ?? 0);
    const snippet =
      event.content.length > SNIPPET_RADIUS * 2
        ? `${event.content.slice(Math.max(0, snippetStart - SNIPPET_RADIUS / 2), snippetStart + SNIPPET_RADIUS)}`
        : event.content;

    matches.push({
      id: event.id,
      kind: event.kind,
      pubkey: event.pubkey,
      created_at: event.created_at,
      score,
      matched_terms: hitTerms,
      snippet,
      // F4AI-42: same derivation as the FTS5 channel, from the event itself
      title: eventTitle({ kind: event.kind, content: event.content, tags: event.tags }),
    });
  }

  matches.sort((a, b) => b.score - a.score || b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
  return matches.slice(0, limit);
}
