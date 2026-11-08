/**
 * Export referencií papiera do BibTeXu a APA (Phase 4b).
 *
 * Zdroj dát: ` ```references ` CSL-JSON zárez v tele papiera — parity
 * `CslItem` zo `@forum4ai/shared/paper` (to isté pole, ktoré lintuje
 * `parseCslReferences` a ktoré zobrazuje References sekcia). Export je
 * ČISTO klientsky: žiadna sieť, žiadne knižnice — testy porovnávajú
 * presný výstup.
 *
 * Dohoda o formáte (dokumentovaná, lebo ju čaká aj report):
 *  - BibTeX: `@type{key, field = {value}, ...}`, typ mapovaný podľa CSL
 *    `type` (article-journal→@article, book→@book, inproceedings/
 *    conference/paper-conference→@inproceedings, thesis→@phdthesis,
 *    report→@techreport, iné→@misc). Polia: author, title, year,
 *    journal|booktitle|institution (z `container-title`), doi, url.
 *  - APA: textová veta `Family, F. (Year). Title. Container.
 *    https://doi.org/…` — „APA-ish", bez kurzívy a s konzervatívnymi
 *    fallbackmi (chýbajúci rok → n.d., literal autor → bez premenovania).
 *
 * Poradie záznamov = poradie, ktoré dodal volajúci (PaperPage posiela
 * poradie citácií z `preparePaper`, teda číslovanie sedí s textom).
 */
import type { CslItem, CslPerson } from '@forum4ai/shared/paper';

/** jeden exportovaný záznam: `key` je CSL id, `num` číslo v References */
export interface PaperExportEntry {
  key: string;
  num: number;
  item: CslItem;
}

/** CSL `type` → BibTeX entry type; neznáme typy padajú na `misc` */
const BIBTEX_TYPE: Record<string, string> = {
  'article-journal': 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  article: 'article',
  book: 'book',
  'book-chapter': 'incollection',
  chapter: 'incollection',
  inproceedings: 'inproceedings',
  conference: 'inproceedings',
  'paper-conference': 'inproceedings',
  proceedings: 'proceedings',
  thesis: 'phdthesis',
  report: 'techreport',
  dataset: 'misc',
  webpage: 'misc',
  document: 'misc',
  misc: 'misc',
};

/** kde sa `container-title` v danom BibTeX type uloží (inak vynecháme) */
const CONTAINER_FIELD: Record<string, string> = {
  article: 'journal',
  incollection: 'booktitle',
  inproceedings: 'booktitle',
  proceedings: 'series',
  phdthesis: 'school',
  techreport: 'institution',
};

/** rok z CSL `issued.date-parts` ([[2026, 1, 1]] → "2026") */
export function cslYear(item: CslItem): string | null {
  const parts = item.issued?.['date-parts'];
  if (!Array.isArray(parts)) return null;
  const first = parts[0];
  if (!Array.isArray(first) || first.length === 0) return null;
  const year = first[0];
  return typeof year === 'number' && Number.isFinite(year) ? String(year) : null;
}

/** BibTeX key z CSL id: povolené len [A-Za-z0-9_.-], iné za `_` */
export function bibkey(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^[-_.:]+/, '');
  return cleaned === '' ? 'ref' : cleaned;
}

/** autor do BibTeXu: `Family, Given` a ` and ` (literal → bez premenovania) */
function bibAuthor(person: CslPerson): string | null {
  if (typeof person.literal === 'string' && person.literal.trim() !== '') return person.literal.trim();
  const family = typeof person.family === 'string' ? person.family.trim() : '';
  const given = typeof person.given === 'string' ? person.given.trim() : '';
  if (family === '' && given === '') return null;
  if (family === '') return given;
  return given === '' ? family : `${family}, ${given}`;
}

/** iniciály krstného mena pre APA: `Jan Q.` → `J. Q.` */
function apaInitials(given: string): string {
  return given
    .split(/[\s-]+/)
    .filter((part) => part !== '')
    .map((part) => `${(part[0] ?? '').toUpperCase()}.`)
    .join(' ');
}

/** autor do APA: `Family, J. Q.`; literal → ako prichádza */
function apaAuthor(person: CslPerson): string | null {
  if (typeof person.literal === 'string' && person.literal.trim() !== '') return person.literal.trim();
  const family = typeof person.family === 'string' ? person.family.trim() : '';
  const given = typeof person.given === 'string' ? person.given.trim() : '';
  if (family === '' && given === '') return null;
  const initials = given === '' ? '' : apaInitials(given);
  if (family === '') return initials;
  return initials === '' ? family : `${family}, ${initials}`;
}

/** `A, B a C` → `A, B, & C` (APA) — dva autori len `A, & B` */
function joinApa(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  const last = names[names.length - 1] ?? '';
  return `${names.slice(0, -1).join(', ')}, & ${last}`;
}

/** vyčisti hodnotu pre BibTeX zátvorkový obal: zbalené zátvorky, escapovaný # */
function bibValue(value: string): string {
  return value.replace(/[{}]/g, '').replace(/#/g, '\\#').trim();
}

/** DOI → čistý identifikátor (ak je zadaný ako URL, orežeme prefix) */
export function bareDoi(doi: string): string {
  const trimmed = doi.trim();
  const match = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(trimmed);
  return match !== null ? (match[1] ?? trimmed) : trimmed;
}

/** ORCID → čistý identifikátor `0000-…` (ak je zadaný ako URL, orežeme prefix) */
export function bareOrcid(orcid: string): string {
  const trimmed = orcid.trim();
  const match = /^https?:\/\/orcid\.org\/(.+)$/i.exec(trimmed);
  return match !== null ? (match[1] ?? trimmed) : trimmed;
}

/**
 * Jeden záznam → BibTeX. `key` sa sanitizuje a pri kolízii doplní
 * `-<num>`, aby výstup zostal parsovateľný aj pri duplicitných id.
 */
export function cslToBibEntry(entry: PaperExportEntry, taken?: Set<string>): string {
  const type = BIBTEX_TYPE[entry.item.type] ?? 'misc';
  const containerField = CONTAINER_FIELD[type];
  const fields: [string, string][] = [];

  const authors = (entry.item.author ?? []).map(bibAuthor).filter((v): v is string => v !== null);
  if (authors.length > 0) fields.push(['author', authors.join(' and ')]);
  if (typeof entry.item.title === 'string' && entry.item.title.trim() !== '') {
    fields.push(['title', entry.item.title.trim()]);
  }
  const year = cslYear(entry.item);
  if (year !== null) fields.push(['year', year]);
  const container = entry.item['container-title'];
  if (containerField !== undefined && typeof container === 'string' && container.trim() !== '') {
    fields.push([containerField, container.trim()]);
  }
  if (typeof entry.item.DOI === 'string' && entry.item.DOI.trim() !== '') {
    fields.push(['doi', bibValue(bareDoi(entry.item.DOI))]);
  }
  if (typeof entry.item.URL === 'string' && entry.item.URL.trim() !== '') {
    fields.push(['url', bibValue(entry.item.URL.trim())]);
  } else if (typeof entry.item.DOI === 'string' && entry.item.DOI.trim() !== '') {
    fields.push(['url', `https://doi.org/${bibValue(bareDoi(entry.item.DOI))}`]);
  }

  let key = bibkey(entry.key);
  if (taken !== undefined) {
    if (taken.has(key)) key = `${key}-${String(entry.num)}`;
    taken.add(key);
  }

  const body = fields.map(([name, value]) => `  ${name} = {${bibValue(value)}}`).join(',\n');
  return `@${type}{${key},\n${body}\n}`;
}

/** zoznam záznamov → BibTeX súbor (položky odsepené prázdным riadkom) */
export function cslToBibTeX(entries: readonly PaperExportEntry[]): string {
  const taken = new Set<string>();
  return entries.map((entry) => cslToBibEntry(entry, taken)).join('\n\n') + (entries.length > 0 ? '\n' : '');
}

/**
 * Jeden záznam → APA-ish riadok (používa ho References sekcia aj export):
 * `Family, J. (2026). Title. Container. https://doi.org/…`
 */
export function cslToApaLine(item: CslItem): string {
  const authors = (item.author ?? []).map(apaAuthor).filter((v): v is string => v !== null);
  const parts: string[] = [];
  if (authors.length > 0) {
    // APA kladie pred rok bodku: `Novakova, J., & Berg, O. (2026).` —
    // zoznam už končí bodkou z iniciál, preto ju nepridávame dvakrát
    const list = joinApa(authors);
    parts.push(list.endsWith('.') ? list : `${list}.`);
  }
  parts.push(`(${cslYear(item) ?? 'n.d.'}).`);
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (title !== '') parts.push(`${title}.`);
  const container = typeof item['container-title'] === 'string' ? item['container-title'].trim() : '';
  if (container !== '') parts.push(`${container}.`);
  if (typeof item.DOI === 'string' && item.DOI.trim() !== '') {
    parts.push(`https://doi.org/${bareDoi(item.DOI)}`);
  } else if (typeof item.URL === 'string' && item.URL.trim() !== '') {
    parts.push(item.URL.trim());
  }
  return parts.join(' ');
}

/** zoznam záznamov → .txt export (číslované `[N]` podľa References) */
export function cslToApa(entries: readonly PaperExportEntry[]): string {
  return entries.map((entry) => `[${String(entry.num)}] ${cslToApaLine(entry.item)}`).join('\n') + (entries.length > 0 ? '\n' : '');
}

/**
 * Stiahni textový súbor cez Blob + `a[download]` (bez servera). Vracia
 * created URL, aby ho volajúci mohol revokovať v teste; v prehliadači
 * to revokuje sám helper.
 */
export function downloadTextFile(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
