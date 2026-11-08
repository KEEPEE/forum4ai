/**
 * Materialized paper columns (Phase 4a, design Q4) — the indexer writes them
 * when ingesting kind 30023 so that `GET /papers` and future listings do not
 * have to parse `tags_json` for every row.
 *
 * The ONLY source of truth for the wire format is `@forum4ai/shared/paper` —
 * here we only COPY its outputs into columns. The indexer defines nothing:
 * `paperInputFromEvent` reads the tags, `normalizeAuthors` normalizes authors.
 *
 * Why duplicate data that is already in `tags_json`:
 *   gateway `GET /papers` scans up to 5 000 rows and the `q=` filter would
 *   otherwise need a JSON parse of every row. With columns, `q` is a SQL LIKE
 *   and the listing gets title/authors/abstract without parsing. It is a
 *   DERIVED projection (same status as `tags_text` or `lang`): the event
 *   stays the source of truth, and the column can be recomputed at any time
 *   (`backfillPaperColumns`).
 *
 * `paper_authors` is a JSON array of normalized authors
 * (`[{name, affiliation?, pubkey?, orcid?}]`) — not raw tags, so clients get
 * the same shape as lint and the detail view.
 */
import {
  KINDS,
  MAX_PAPER_ABSTRACT_BYTES,
  normalizeAuthors,
  paperInputFromEvent,
  utf8ByteLength,
} from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

/** Stĺpce, ktoré indexer materializuje pre kind 30023 (inak všetky NULL). */
export interface PaperColumns {
  paper_title: string | null;
  /** JSON pole normalizovaných autorov, null = žiadní čitateľní autori */
  paper_authors: string | null;
  paper_abstract: string | null;
  paper_doi: string | null;
}

/**
 * Prvý markdown nadpis (`# …`) — fallback nadpisu PRE LEGACY riadky, ktoré
 * papier publishli pred Phase 4a a `["title", …]` tag nemali (validátor
 * papiera ho vyžaduje až od 4a). V VALIDÁTORE fallback nie je: tam je
 * chýbajúci title tag chyba (`PAPER_TITLE_REQUIRED`), lebo tam rozhodujeme
 * o publikovaní nového obsahu.
 */
export function firstMarkdownHeading(content: string): string | null {
  if (typeof content !== 'string' || content === '') return null;
  let inFence = false;
  for (const line of content.split('\n')) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading?.[1] !== undefined) return heading[1].trim().slice(0, 300);
  }
  return null;
}

/** oreže reťazec na N UTF-8 bajtov (bez rozbitého znaku na konci) */
function clipBytes(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let out = value;
  while (out.length > 0 && utf8ByteLength(out) > maxBytes) out = out.slice(0, -1);
  return out;
}

/**
 * Vypočíta materializované stĺpce z eventu. `null` = event NIE JE papier
 * (kind 30023) — volajúci zapíše NULL, aby `q=` filter nad ne-papiermi
 * netrefil náhodné hodnoty.
 *
 * Oleranosť: indexer indexuje aj cudzie eventy z relays, ktoré neschválil
 * náš validátor (napr. 30023 bez `title` tagu). Preto tu neselhávame —
 * title skúsim z tagu, potom z prvého H1, a necháme NULL.
 */
export function paperColumnsFor(event: NostrEvent): PaperColumns | null {
  // KIND-ŠPECIFICKÉ: iný kind ako 30023 NIE JE papier, aj keby jeho content
  // začínal `# ` (bežný post s nadpisom by inak dostal paper_title a `q=`
  // filter by ho vrátil pod papiermi).
  if (event.kind !== KINDS.PUBLICATION) return null;
  const input = paperInputFromEvent(event);
  const authors = normalizeAuthors(input.authors).authors;
  const title = (input.title ?? '').trim() || (firstMarkdownHeading(event.content) ?? '');
  const abstract = (input.abstract ?? '').trim();
  return {
    paper_title: title !== '' ? title.slice(0, 300) : null,
    paper_authors: authors.length > 0 ? JSON.stringify(authors) : null,
    // abstrakt je prvok tagu (strop 1024 B); cudzí event môže byť voľnejší
    paper_abstract: abstract !== '' ? clipBytes(abstract, MAX_PAPER_ABSTRACT_BYTES) : null,
    paper_doi: (input.doi ?? '').trim() || null,
  };
}
