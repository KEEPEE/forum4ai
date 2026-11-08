/**
 * Zdieľaný FTS5 match-query builder (F4AI-14, S8).
 *
 * Pôvodne bol definovaný v `packages/indexer/src/db.ts` (F4AI-13). S8 ho
 * potrebuje aj gateway — `GET /search` číta indexer DB **read-only** a musí
 * zostaviť ten istý bezpečný MATCH reťazec ako indexer, inak by sa líšilo
 * čo sa indexuje a čo sa dopytuje. Nechávame ho preto na jednom mieste:
 *
 *   shared (čistá funkcia, bez závislosti na SQLite)
 *     ├── packages/indexer/src/db.ts   → import + re-export (API balíka sa
 *     │                                  nemení, testy `from '../src/db.js'`
 *     │                                  fungujú ďalej)
 *     └── packages/gateway/src/search.ts → read-only dopyt nad indexer DB
 *
 * Prečo nepoužiť priamy import `buildMatchQuery` z `@forum4ai/indexer`:
 * indexer už závisí od gateway (berie z neho `RelayPool`), takže by gateway →
 * indexer vytvoril **cyklus workspace balíkov**. `pnpm -r build`/`pnpm -r test`
 * sú topologicky zoradené a cyklus na čistej výkonne kopii (bez `dist/`)
 * nemá platné poradie — prvý článek cyklu by padol na chýbajúcich typoch
 * druhého. Presunutím čistej funkcie do shared cyklus nevznikne.
 */

/** FTS5 kľúčové slová sa nesmú objaviť ako holý token (syntax error). */
const FTS_KEYWORDS = new Set(['and', 'or', 'not', 'near']);

/**
 * Bezpečný FTS5 MATCH reťazec z ľubovoľného vstupu: tokeny obalíme do
 * úvodzoviek (syntax error pri `'`, `(`, `:` … zmizne), čisté alfanumerické
 * tokeny a prefixové `slovo*` nechávame voľné, kľúčové slová FTS5
 * (AND/OR/NOT/NEAR) uzatvárame (inak z nich je operátor a syntax error).
 * Viacnásobné tokeny spájame implicitným AND. `raw` režim priamo na FTS5
 * syntaxe je k dispozícii ako `SearchOptions.rawMatch` na `IndexerDb.search`.
 *
 * Diakritiku tu **neupravujeme** — tokenizér `unicode61 remove_diacritics 2`
 * (pinned v indexer schéme) ju zráža až pri indexovaní aj dopyte, takže
 * `reklamacna` nájde `reklamačná` bez akéhokoľvek prepisu na našej strane.
 */
export function buildMatchQuery(input: string): string {
  const tokens = input.trim().split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) return '';
  const quoted: string[] = [];
  for (const token of tokens) {
    if (FTS_KEYWORDS.has(token.toLowerCase())) {
      quoted.push(`"${token}"`);
      continue;
    }
    // čistý alfanumerický token alebo prefix `slovo*` ide voľne; `a:b` by
    // FTS5 vyhladal ako filter stĺpca (=> "no such column: a"), ten tu
    // nepoužívame, preto ho uzatvárame
    if (/^[A-Za-z0-9_]+$/.test(token)) {
      quoted.push(token);
      continue;
    }
    const bare = token.replace(/\*+$/, '');
    if (bare !== '' && /^[A-Za-z0-9_]+$/.test(bare)) {
      quoted.push(`${bare}*`);
      continue;
    }
    if (bare === '') continue; // token bez významu ('*', '()', …) vynecháme
    quoted.push(`"${token.replaceAll('"', '""')}"`);
  }
  return quoted.join(' AND ');
}
