/**
 * Mermaid renderer (Phase 3b, dizajn Q3 „Rich content").
 *
 * Mermaid sa privádza LEN dynamic importom (`import('mermaid')` +
 * `import('dompurify')`) — jeho chunk vázi a forum má diagram len v
 * zátorkách postov. Tento modul preto neimportuje `mermaid` staticky;
 * privádza ho volajúci (RichContent) a predáva sem už načítané moduly.
 *
 * Bezpečnosť (dizajn Q3 / security review):
 *  - `securityLevel: 'strict'` — žiadne click handlery, labely enkódujú;
 *  - `htmlLabels: false` — žiadne `foreignObject` (HTML v SVG je vektor
 *    útokov),
 *  - `maxTextSize: 20_000`, `maxEdges: 300` — lacný DoS strop,
 *  - výstup SA SANITIZUJE DOMPurify (svg profil, bez `script`/
 *    `foreignObject`/`href`) a až potom vloží do DOM — mermaid síce sanitizuje
 *    sám, ale dvakrát chránené nie je premnožené (vlastný parser, vlastné
 *    `<style>` bloky).
 *
 * Theming: `theme: 'base'` + `themeVariables` prečítané z `getComputedStyle`
 * tokenov `--diagram-*` — SVG dedí paletu témy. Vlakno to drží samo: graf sa
 * po zmene `data-theme` pre-renderuje (RichContent drží MutationObserver).
 */
import type { DOMPurify as DOMPurifyNamespace } from 'dompurify';

/**
 * Stropy bohatého obsahu (dizajn Q3) — od Phase 4a ich drží shared
 * (`@forum4ai/shared/limits`), lebo ich potrebuje aj gateway lint papiera
 * (30023). Tu ostáva **re-export**, takže importy `from '../lib/mermaid-render.js'`
 * (RichContent, testy) sa nemenia.
 */
import { MAX_RICH_BLOCKS_PER_POST, MERMAID_MAX_EDGES, MERMAID_MAX_TEXT_SIZE } from '@forum4ai/shared/limits';

export { MAX_RICH_BLOCKS_PER_POST, MERMAID_MAX_EDGES, MERMAID_MAX_TEXT_SIZE };

/** kľúče diagram tokenov → mermaid themeVariables (mapovanie je pevné) */
const DIAGRAM_VARS = [
  '--diagram-bg',
  '--diagram-fg',
  '--diagram-line',
  '--diagram-accent',
  '--diagram-note',
  '--diagram-primary',
  '--diagram-secondary',
] as const;

export interface DiagramTheme {
  bg: string;
  fg: string;
  line: string;
  accent: string;
  note: string;
  primary: string;
  secondary: string;
  /** audit 7.5 P1-4: font tela (`--font-body`) — mermaid ním meria text */
  font: string;
}

/** fallback = hodnoty glass-dark tokenov (keď CSS ešte nenabehol / jsdom) */
const FALLBACK_THEME: DiagramTheme = {
  bg: '#12121f',
  fg: '#ffffff',
  line: 'rgba(0, 240, 255, 0.55)',
  accent: '#9d4edd',
  note: 'rgba(255, 209, 102, 0.16)',
  primary: 'rgba(0, 240, 255, 0.16)',
  secondary: 'rgba(255, 0, 212, 0.14)',
  font: "'Outfit', 'Outfit Variable', sans-serif",
};

/**
 * Prečítaj diagram paletu aktuálnej témy z DOM. `getComputedStyle` rieši
 * `var()` na konkrétne hodnoty — SVG atribúty nemôžu použiť CSS premennú
 * priamo, preto hodnoty snímame a posielame ako concrete colors.
 */
export function readDiagramTheme(doc: Document = document): DiagramTheme {
  const style = doc.defaultView?.getComputedStyle(doc.documentElement);
  if (style === undefined || style === null) return FALLBACK_THEME;
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };
  void DIAGRAM_VARS;
  return {
    bg: read('--diagram-bg', FALLBACK_THEME.bg),
    fg: read('--diagram-fg', FALLBACK_THEME.fg),
    line: read('--diagram-line', FALLBACK_THEME.line),
    accent: read('--diagram-accent', FALLBACK_THEME.accent),
    note: read('--diagram-note', FALLBACK_THEME.note),
    primary: read('--diagram-primary', FALLBACK_THEME.primary),
    secondary: read('--diagram-secondary', FALLBACK_THEME.secondary),
    font: read('--font-body', FALLBACK_THEME.font),
  };
}

/** themeVariables pre `theme: 'base'` — mapovanie tokenov na mermaid role */
export function mermaidThemeVariables(theme: DiagramTheme = readDiagramTheme()): Record<string, string> {
  return {
    background: theme.bg,
    primaryColor: theme.primary,
    primaryBorderColor: theme.line,
    primaryTextColor: theme.fg,
    secondaryColor: theme.secondary,
    secondaryBorderColor: theme.accent,
    secondaryTextColor: theme.fg,
    tertiaryColor: theme.note,
    tertiaryBorderColor: theme.accent,
    tertiaryTextColor: theme.fg,
    lineColor: theme.line,
    textColor: theme.fg,
    mainBkg: theme.primary,
    nodeBorder: theme.line,
    nodeTextColor: theme.fg,
    clusterBkg: theme.note,
    clusterBorder: theme.accent,
    titleColor: theme.fg,
    edgeLabelBackground: theme.bg,
    actorBkg: theme.primary,
    actorBorder: theme.line,
    actorTextColor: theme.fg,
    actorLineColor: theme.line,
    signalColor: theme.line,
    signalTextColor: theme.fg,
    labelBoxBkgColor: theme.primary,
    labelBoxBorderColor: theme.line,
    labelTextColor: theme.fg,
    loopTextColor: theme.fg,
    noteBkgColor: theme.note,
    noteTextColor: theme.fg,
    noteBorderColor: theme.accent,
    activationBkgColor: theme.secondary,
    activationBorderColor: theme.accent,
    sequenceNumberColor: theme.fg,
    labelColor: theme.fg,
    // audit 7.5 P1-4: body font témy (--font-body) — mermaid jím meria aj
    // kreslí text, takže uzly sedia s typografiou stránky (nie hardcodované)
    fontFamily: theme.font,
  };
}

/**
 * DOMPurify profil pre mermaid SVG (dizajn Q3): povolené svg+svgFilters,
 * zakázané `foreignObject`/`script` a `href`/`xlink:href` (no href =
 * žiadne navigačné/objavené vnorenia).
 */
export function sanitizeMermaidSvg(purify: DOMPurifyNamespace, svg: string): string {
  return purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script'],
    FORBID_ATTR: ['href', 'xlink:href'],
  });
}

/**
 * Renderuj mermaid zdroj na sanitizovaný SVG reťazec. `mermaid` a `purify`
 * sú už dynamicky načítané moduly (príslušné `default` exporty).
 */
export async function renderMermaidSvg(
  mermaid: { initialize: (config: Record<string, unknown>) => void; render: (id: string, text: string) => Promise<{ svg: string }> },
  purify: DOMPurifyNamespace,
  source: string,
  id: string,
  theme?: DiagramTheme,
): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: MERMAID_MAX_TEXT_SIZE,
    maxEdges: MERMAID_MAX_EDGES,
    theme: 'base',
    themeVariables: mermaidThemeVariables(theme),
  });
  const { svg } = await mermaid.render(id, source);
  return sanitizeMermaidSvg(purify, svg);
}
