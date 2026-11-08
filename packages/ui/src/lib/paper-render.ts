/**
 * Príprava tela papiera na vykreslenie (Phase 4b).
 *
 * `preparePaper(body, labels)` z markdownu `content` eventu urobí dve veci:
 *
 *  1. **index** — číslovanie a väzby, ktoré UI pridáva nad irackým
 *     formátom autora (dizajn Q4: „UI robí číslovanie/citácie/export"):
 *      - sekcie h1..h6 → `1.`, `1.2`, `1.2.3` (predpis: najplytčšia úroveň
 *        v dokumente je úroveň 1, aby `##`-only papier nezačinal `1.1`),
 *      - obrázky: ` ```mermaid fig=x ` / ` ```chart fig=x ` v poradí
 *        dokumentu → 1, 2… (poradie berieme z `collectDeclaredRefs`,
 *        teda TO ISTÉ ako lint `XREF_UNKNOWN`),
 *      - tabuľky: riadok `Table: <caption> {#tbl:x}` → 1, 2…,
 *      - rovnice: `$$ … $$ {#eq:x}` → (1), (2)…,
 *      - citácie `[@key]` / `[@a; @b]` → [1], [2]… v poradí prvej citácie
 *        (`collectCitations`),
 *      - sekcia referencií: poradie = citované kľúče (poradie prvej
 *        citácie) a za nimi necitované položky v poradie CSL poľa.
 *
 *  2. **content** — upravený markdown pre `RichContent` v `paper` móde:
 *      - ` ```references ` zárez sa VYNECHÁ z teľa (stáva sa sekciovou
 *        časťou stránky, nie code blockom),
 *      - nadpisy dostanú číslo do textu (`## 1.2 Metóda`),
 *      - deklarované rovnice sa prepíšu na ` ```equation id=… num=… `
 *        zárez (renderer z nich robí KaTeX s číslom `(N)` a kotvou),
 *      - `@fig:x` → `[Obrázok 1](#fig:x "popis")` (nevyriešený →
 *        `[@fig:x](#xref-unknown:fig:x)`),
 *      - `[@key]` → `[1](#ref:key "titulok")` (nevyriešený →
 *        `[@key](#cite-unknown:key)`).
 *
 * Všetko je čistá funkcia bez Reactu — testovateľná samostatne a volaná
 * v `useMemo`. Default mód RichContent sa týmto vôbec nedotýka.
 */
import {
  collectCitations,
  collectDeclaredRefs,
  parseCslReferences,
  proseOnly,
  referencesFences,
  scanFences,
  type CslItem,
} from '@forum4ai/shared/paper';
import { parseFenceMeta } from '@forum4ai/shared/fence-meta';

/** id deklarácií a citácií — rovnaká znaková množina ako `collectDeclaredRefs` */
const ID_CHARS = String.raw`[A-Za-z0-9_$.\-:]+`;

export interface PaperRefEntry {
  id: string;
  num: number;
  caption: string;
}

export interface PaperCitationEntry {
  key: string;
  num: number;
  /** koľkokrát kľúč text cituje (na „cited by N") */
  count: number;
  /** titulok z CSL položky (hover nad citáciou), '' = nevieme */
  title: string;
}

/** jedna položka sekcie Referencie: číslo, CSL položka, počet citácií */
export interface PaperReferenceEntry {
  key: string;
  num: number;
  item: CslItem;
  citedBy: number;
}

export interface PaperIndex {
  figures: Map<string, PaperRefEntry>;
  tables: Map<string, PaperRefEntry>;
  equations: Map<string, PaperRefEntry>;
  citations: Map<string, PaperCitationEntry>;
  /** poradie sekcie Referencie: citované (poradie prvej citácie), potom necitované */
  references: PaperReferenceEntry[];
  /** parsované CSL pole, null = zárez chýba/je nečitateľný */
  referencesParsed: CslItem[] | null;
  /** kľúče v poradí prvej citácie */
  citationOrder: string[];
}

export interface PaperLabels {
  figure: string;
  table: string;
  equation: string;
}

export interface PreparedPaper {
  content: string;
  index: PaperIndex;
}

/** popisky pre linky — volajúci dodáva lokalizované (`t('paper:labels.…')`) */
export const FALLBACK_LABELS: PaperLabels = { figure: 'Figure', table: 'Table', equation: 'Equation' };

/** riadky pokryté fenced zárezmi (otvárací + vnútro + zatvárací) */
function fenceRanges(body: string): Set<number> {
  const lines = body.split('\n');
  const covered = new Set<number>();
  for (const fence of scanFences(body)) {
    const inner = fence.source === '' ? 0 : fence.source.split('\n').length;
    const last = fence.open ? lines.length - 1 : fence.line + 1 + inner;
    for (let i = fence.line; i <= last && i < lines.length; i += 1) covered.add(i);
  }
  return covered;
}

/** odsadenie do max 3 medzier (CommonMark) — inak je to already code */
function headingLevel(line: string): { level: number; text: string } | null {
  const match = /^( {0,3})(#{1,6})\s+(.*)$/.exec(line);
  if (match === null) return null;
  return { level: (match[2] ?? '').length, text: match[3] ?? '' };
}

const TABLE_CAPTION = new RegExp(String.raw`^Table:\s*(.+?)\s*\{#tbl:(${ID_CHARS})\}\s*$`, 'i');

/**
 * Rozpoznaj riadok popisku tabuľky (`Table: <caption> {#tbl:id}`).
 * Exportované pre `RichContent` paper mód — to isté pravidlo ako pri
 * číslovaní, takže sa nejdú dve interpretácie.
 */
export function parseTableCaption(line: string): { id: string; caption: string } | null {
  const match = TABLE_CAPTION.exec(line.trim());
  if (match === null) return null;
  const id = match[2] ?? '';
  return id === '' ? null : { id, caption: (match[1] ?? '').trim() };
}

/** `{#eq:id}` na konci riadka (za `$$`) alebo samostatne */
const EQ_ATTR = new RegExp(String.raw`\{#eq:(${ID_CHARS})\}`);

/**
 * Vyber ` ```references ` zárezy z riadkov (malo by ich byť ≤1; mažeme
 * všetky, aby sa neobjavil code block). Vracia čistý text + surový
 * JSON posledného zárezu na parse CSL.
 */
function stripReferences(body: string): { body: string; raw: string | null } {
  const fences = referencesFences(body);
  if (fences.length === 0) return { body, raw: null };
  const lines = body.split('\n');
  const drop = new Set<number>();
  for (const fence of fences) {
    const inner = fence.source === '' ? 0 : fence.source.split('\n').length;
    const last = fence.open ? lines.length - 1 : fence.line + 1 + inner;
    for (let i = fence.line; i <= last; i += 1) drop.add(i);
  }
  const last = fences[fences.length - 1];
  return {
    body: lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n'),
    raw: last?.source ?? null,
  };
}

/** titulok obrázka z info riadka zárezu (`caption="…"` alebo `caption=…`) */
function figureCaptions(body: string): Map<string, string> {
  const captions = new Map<string, string>();
  for (const fence of scanFences(body)) {
    if (fence.lang !== 'mermaid' && fence.lang !== 'chart') continue;
    const meta = parseFenceMeta(fence.meta);
    if (meta.fig !== undefined && !captions.has(meta.fig)) captions.set(meta.fig, meta.caption ?? '');
  }
  return captions;
}

/** popisy tabuliek z riadkov `Table: … {#tbl:x}` (v poradí dokumentu) */
function tableCaptions(body: string): Map<string, string> {
  const captions = new Map<string, string>();
  const ranges = fenceRanges(body);
  body.split('\n').forEach((line, i) => {
    if (ranges.has(i)) return;
    const parsed = parseTableCaption(line);
    if (parsed !== null && !captions.has(parsed.id)) captions.set(parsed.id, parsed.caption);
  });
  return captions;
}

/** počet výskytov každého kľúča v proze (rovnaká regex logika ako `collectCitations`) */
function citationCounts(body: string): Map<string, number> {
  const prose = proseOnly(body);
  const counts = new Map<string, number>();
  const bracket = /\[([^[\]]*)\](?![([])/g;
  let match = bracket.exec(prose);
  while (match !== null) {
    const inner = match[1] ?? '';
    if (inner.includes('@')) {
      const keyRe = /@([A-Za-z0-9_$][A-Za-z0-9_$.\-:]*)/g;
      let key = keyRe.exec(inner);
      while (key !== null) {
        const cleaned = (key[1] ?? '').replace(/\.+$/, '');
        if (cleaned !== '') counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
        key = keyRe.exec(inner);
      }
    }
    match = bracket.exec(prose);
  }
  return counts;
}

/** unikni `"` a `\` v markdown link titulku */
function escTitle(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** krátky hover titulok CSL položky: `Family — Title (rok)` */
function cslTitleHint(item: CslItem): string {
  const first = item.author?.[0];
  const family = first && typeof first.family === 'string' ? first.family.trim() : '';
  const literal = first && typeof first.literal === 'string' ? first.literal.trim() : '';
  const who = family !== '' ? family : literal;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const year = item.issued?.['date-parts']?.[0]?.[0];
  const head = [who, title].filter((p) => p !== '').join(' — ');
  return typeof year === 'number' && head !== '' ? `${head} (${String(year)})` : head;
}

/**
 * Nahraď citácie a krížové odkazy v jednom prozaickom segmente (mimo
 * inline kódu — to rieši volajúci).
 */
function replaceRefs(segment: string, index: PaperIndex, labels: PaperLabels): string {
  const pattern = new RegExp(
    String.raw`\[([^[\]]*)\](?![(\[])|@(fig|tbl|eq):(${ID_CHARS})`,
    'g',
  );
  return segment.replace(pattern, (whole, innerRaw: string | undefined, kindRaw: string | undefined, idRaw: string | undefined) => {
    // krížový odkaz `@fig:x`
    if (kindRaw !== undefined && idRaw !== undefined) {
      const kind = kindRaw as 'fig' | 'tbl' | 'eq';
      const id = idRaw.replace(/\.+$/, '');
      const map = kind === 'fig' ? index.figures : kind === 'tbl' ? index.tables : index.equations;
      const entry = map.get(id);
      if (entry === undefined) return `[@${kind}:${id}](#xref-unknown:${kind}:${id})`;
      const label = kind === 'fig' ? labels.figure : kind === 'tbl' ? labels.table : labels.equation;
      const title = entry.caption !== '' ? ` "${escTitle(entry.caption)}"` : '';
      return `[${label} ${String(entry.num)}](#${kind}:${id}${title})`;
    }
    // citačná skupina `[…@…]`
    if (innerRaw === undefined || !innerRaw.includes('@')) return whole;
    const keyRe = /@([A-Za-z0-9_$][A-Za-z0-9_$.\-:]*)/g;
    const keys: string[] = [];
    let key = keyRe.exec(innerRaw);
    while (key !== null) {
      const cleaned = (key[1] ?? '').replace(/\.+$/, '');
      if (cleaned !== '') keys.push(cleaned);
      key = keyRe.exec(innerRaw);
    }
    if (keys.length === 0) return whole;

    const link = (k: string): string => {
      const entry = index.citations.get(k);
      if (entry === undefined) return `[@${k}](#cite-unknown:${k})`;
      const title = entry.title !== '' ? ` "${escTitle(entry.title)}"` : '';
      return `[${String(entry.num)}](#ref:${k}${title})`;
    };

    // čistá skupina len z @kľúčov (± `;` `,` medzery, voliteľný `-` pred
    // kľúčom pri pandom potlačení mena) → nahradíme celú zátvorku
    const pure = new RegExp(String.raw`^[\s;,]*(?:-?@[A-Za-z0-9_$][A-Za-z0-9_$.\-:]*[\s;,]*)+$`).test(innerRaw);
    if (pure) return keys.map(link).join(', ');
    // skupina s dodatkovým textom (`see @a, p. 20`) → text ponecháme a
    // kľúče v ňom nahradíme odkazmi
    return innerRaw.replace(/-?@[A-Za-z0-9_$][A-Za-z0-9_$.\-:]*/g, (token) => link(token.replace(/^-?@/, '').replace(/\.+$/, '')));
  });
}

/** aplikuj `replaceRefs` len mimo inline code spans */
function replaceRefsProse(line: string, index: PaperIndex, labels: PaperLabels): string {
  return line
    .split(/(`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : replaceRefs(part, index, labels)))
    .join('');
}

/**
 * Pokus o blok rovnic so `{#eq:id}` na riadku `i`. Vracia emitované
 * riadky zárezu a index ďalšieho riadku, alebo null (nekonsumuj nič).
 */
function tryEquation(
  lines: string[],
  i: number,
  covered: Set<number>,
  index: PaperIndex,
): { emit: string[]; next: number } | null {
  if (covered.has(i)) return null;
  const open = /^\s*\$\$([\s\S]*)$/.exec(lines[i] ?? '');
  if (open === null) return null;
  const rest = open[1] ?? '';

  let content: string | null = null;
  let after = '';
  let next = -1;

  const closeSame = /^(.*?)\$\$(.*)$/.exec(rest);
  if (closeSame !== null && (closeSame[1] ?? '').trim() !== '') {
    content = (closeSame[1] ?? '').trim();
    after = closeSame[2] ?? '';
    next = i + 1;
  } else if (closeSame === null) {
    // viacriadkový blok: hľadaj uzatvárací `$$`
    for (let j = i + 1; j < lines.length; j += 1) {
      if (covered.has(j)) break;
      const close = /^([\s\S]*?)\$\$(.*)$/.exec(lines[j] ?? '');
      if (close === null) continue;
      const innerFirst = rest.trim() === '' ? [] : [rest];
      const innerMiddle = lines.slice(i + 1, j);
      content = [...innerFirst, ...innerMiddle, (close[1] ?? '')].join('\n').trim();
      after = close[2] ?? '';
      next = j + 1;
      break;
    }
  }
  if (content === null || next < 0) return null;

  const attr = EQ_ATTR.exec(after);
  const id = attr?.[1];
  if (id === undefined) return null;
  const entry = index.equations.get(id);
  if (entry === undefined) return null;

  return {
    emit: [`\`\`\`equation id=${id} num=${String(entry.num)}`, content, '```'],
    next,
  };
}

/**
 * Priprav telo + index. `labels` sú lokalizované popisky (link texty sa
 * vypaľujú do markdownu, preto ich potrebuje aj čistá funkcia).
 */
export function preparePaper(body: string, labels: PaperLabels = FALLBACK_LABELS): PreparedPaper {
  const stripped = stripReferences(body);
  const proseBody = stripped.body;
  const parsed = stripped.raw !== null ? parseCslReferences(stripped.raw) : { items: null, errors: [] };
  const referencesParsed = parsed.items;

  // ── indexy v poradí deklarácií (zhodné s `collectDeclaredRefs` = lint) ──
  const declared = collectDeclaredRefs(proseBody);
  const figCaptions = figureCaptions(proseBody);
  const tblCaptions = tableCaptions(proseBody);

  const figures = new Map<string, PaperRefEntry>();
  declared.fig.forEach((id, i) => {
    figures.set(id, { id, num: i + 1, caption: figCaptions.get(id) ?? '' });
  });
  const tables = new Map<string, PaperRefEntry>();
  declared.tbl.forEach((id, i) => {
    tables.set(id, { id, num: i + 1, caption: tblCaptions.get(id) ?? '' });
  });
  const equations = new Map<string, PaperRefEntry>();
  declared.eq.forEach((id, i) => {
    equations.set(id, { id, num: i + 1, caption: '' });
  });

  // ── citácie: poradie prvej citácie, počet výskytov, titulky ───────────
  // Do číselníka sa dostanú LEN kľúče, ktoré majú CSL položku. Nevyriešený
  // `[@key]` nesmie spaliť číslo, inak by Referencie mali dieru a odkaz by
  // mieril na položku, ktorá neexistuje (renderuje sa ako marker).
  const citationOrder = collectCitations(proseBody);
  const counts = citationCounts(proseBody);
  const byId = new Map<string, CslItem>();
  for (const item of referencesParsed ?? []) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const citations = new Map<string, PaperCitationEntry>();
  let cnum = 0;
  for (const key of citationOrder) {
    const item = byId.get(key);
    if (item === undefined) continue;
    cnum += 1;
    citations.set(key, { key, num: cnum, count: counts.get(key) ?? 0, title: cslTitleHint(item) });
  }

  // ── poradie sekcie Referencie: citované (poradie prvej citácie), potom
  //    necitované v poradí CSL poľa — čísla SÚ totožné s číslami citácií ──
  const referenceEntries: PaperReferenceEntry[] = [];
  for (const entry of citations.values()) {
    referenceEntries.push({ key: entry.key, num: entry.num, item: byId.get(entry.key) as CslItem, citedBy: entry.count });
  }
  let uncitedNum = citations.size;
  for (const item of referencesParsed ?? []) {
    if (citations.has(item.id)) continue;
    uncitedNum += 1;
    referenceEntries.push({ key: item.id, num: uncitedNum, item, citedBy: 0 });
  }

  const index: PaperIndex = {
    figures,
    tables,
    equations,
    citations,
    references: referenceEntries,
    referencesParsed,
    citationOrder,
  };

  // ── transformácia markdownu ────────────────────────────────────────────
  const lines = proseBody.split('\n');
  const covered = fenceRanges(proseBody);

  // číslovanie sekcií: najplytčšia prítomná úroveň = úroveň 1
  let minLevel = 7;
  lines.forEach((line, i) => {
    if (covered.has(i)) return;
    const heading = headingLevel(line);
    if (heading !== null) minLevel = Math.min(minLevel, heading.level);
  });
  const counters = new Array<number>(7).fill(0);

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (covered.has(i)) {
      out.push(line);
      i += 1;
      continue;
    }

    const heading = headingLevel(line);
    if (heading !== null) {
      const depth = heading.level - minLevel;
      counters[depth] = (counters[depth] ?? 0) + 1;
      for (let d = depth + 1; d < counters.length; d += 1) counters[d] = 0;
      const number = counters.slice(0, depth + 1).join('.');
      // formát predpisu: vrchná úroveň s bodkou (`1.`), podriadene bez
      // koncové bodky (`1.2`, `1.2.3`) — inak by `1.2.` vyzeralo ako veta
      const label = depth === 0 ? `${number}.` : number;
      const text = replaceRefsProse(heading.text, index, labels);
      out.push(`${'#'.repeat(heading.level)} ${label} ${text}`);
      i += 1;
      continue;
    }

    if (parseTableCaption(line) !== null) {
      // popisek tabuľky ponecháme ako text — `p` komponent v paper móde z
      // neho urobí číslovaný `<caption>`-block s kotvou
      out.push(line);
      i += 1;
      continue;
    }

    const equation = tryEquation(lines, i, covered, index);
    if (equation !== null) {
      out.push(...equation.emit);
      i = equation.next;
      continue;
    }

    out.push(replaceRefsProse(line, index, labels));
    i += 1;
  }

  return { content: out.join('\n'), index };
}
