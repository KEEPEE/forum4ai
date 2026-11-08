/**
 * RichContent — safe rendering of post content (Phase 3b, design Q3
 * "Rich content (UML, charts, math)").
 *
 * Markdown + GFM (tables, task lists), KaTeX, mermaid diagrams and our own
 * Chart DSL — and all of it ONLY lazy: the only thing static in the bundle is
 * the react-markdown core + remark-gfm. KaTeX, mermaid (large, its own chunks)
 * and the chart SVG renderer arrive by dynamic import exactly when the
 * content needs them:
 *
 *   - `$$…$$` / `$…$`  → `remark-math` + `rehype-katex` + KaTeX CSS,
 *   - ```mermaid fence → `mermaid` + `dompurify`,
 *   - ```chart fence   → SVG renderer + validator from `shared`.
 *
 * Security (design Q3):
 *  - react-markdown WITHOUT `rehype-raw` — raw HTML in the content is never
 *    rendered (it stays escaped text),
 *  - links `rel="nofollow noopener ugc"`, images `https:` only,
 *    `referrerPolicy=no-referrer`, `loading=lazy`,
 *  - mermaid `securityLevel:'strict'`, `htmlLabels:false`, text/edge caps,
 *    the output is sanitized with DOMPurify and inserted via `ref` (fragment), not
 *    `dangerouslySetInnerHTML` on an unprocessed string,
 *  - unknown/broken fence languages fall back to a plain `.code-block`, never
 *    to a crash — a broken chart/diagram shows `.chart-error` with the source in
 *    `<details>` (design: "error visible, never an empty spot").
 *
 * Limits budget (design Q3): ≤ 8 diagrams+charts per post (overflow =
 * placeholder), mermaid source ≤ 20 000 characters, chart JSON ≤ 16 KB, ≤ 12
 * series, ≤ 2 000 points (the last three are guarded by `validateChartDsl` in shared).
 *
 * Fence metadata (```mermaid fig=arch caption="…") is parsed from
 * `node.data.meta` (mdast-util-to-hast keeps a copy of it) and the caption renders
 * as plain text in `.figure-caption` — React escapes it.
 *
 * Theming: `tokens.css` has `--chart-*` and `--diagram-*` for every theme; charts
 * draw `var()` directly (they repaint themselves with the theme), mermaid is
 * RE-RENDERED after `<html data-theme>` changes — we keep the MutationObserver
 * here and unsubscribe on unmount.
 */
import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import type { Components, ExtraProps } from 'react-markdown';

import { validateChartDsl } from '@forum4ai/shared/chart-dsl';
import {
  MAX_RICH_BLOCKS_PER_POST,
  MERMAID_MAX_TEXT_SIZE,
  readDiagramTheme,
  renderMermaidSvg,
} from '../lib/mermaid-render.js';
import { parseTableCaption, type PaperIndex } from '../lib/paper-render.js';
import type { ChartDsl } from '@forum4ai/shared/chart-dsl';

/**
 * Detekcia math syntaxe (dizajn Q3): `$$…$$`, `\(...\)` alebo inline `$…$`.
 * Mierne liberálna — post s „$5 a $10" dostane KaTeX, ktorý z toho spraví
 * math; to je akceptovateľná daň za to, že katex chunk nenosíme vždy.
 */
export const MATH_SYNTAX = /\$\$|\\\(|\\\)|(^|[^\\])\$[^$\n]+\$/;

export function hasMathSyntax(content: string): boolean {
  return MATH_SYNTAX.test(content);
}

/**
 * Metadata zárezu (`fig=arch caption="Replication topology"`). Parsovanie
 * presídlilo do shared (`@forum4ai/shared/fence-meta`) v Phase 4a, lebo ho
 * potrebuje aj gateway lint papiera — gateway nemôže importovať UI. Tu
 * ostáva re-export, verejné API komponenty (a jej testy) sa nemenia.
 */
import { parseFenceMeta } from '@forum4ai/shared/fence-meta';

export { parseFenceMeta };
export type { FenceMeta } from '@forum4ai/shared/fence-meta';

/** textový obsah hast uzla (rekurzívne, bez @types/hast dependency) */
function textOf(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: unknown; children?: unknown };
  if (n.type === 'text' && typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) return n.children.map((child) => textOf(child)).join('');
  return '';
}

function languageOf(className: unknown): string | null {
  const list = Array.isArray(className) ? className : typeof className === 'string' ? [className] : [];
  for (const cls of list) {
    if (typeof cls !== 'string') continue;
    const match = /^language-([\w+-]+)$/.exec(cls);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/**
 * Rozhodni, či je `pre` node náš bohatý blok (mermaid/chart). Vracia jazyk,
 * zdroj a metadata; inak `null` → obyčajný code block (fallback, nikdy
 * crash).
 */
export function richFenceOf(node: ExtraProps['node']): { lang: 'mermaid' | 'chart'; source: string; meta: string } | null {
  if (node === undefined || !('children' in node) || !Array.isArray(node.children)) return null;
  const code = node.children.find(
    (child) => typeof child === 'object' && child !== null && 'tagName' in child && child.tagName === 'code',
  );
  if (code === undefined || typeof code !== 'object' || !('properties' in code)) return null;
  const properties = code.properties as { className?: string | string[] } | undefined;
  const lang = languageOf(properties?.className);
  if (lang !== 'mermaid' && lang !== 'chart') return null;
  const data = 'data' in code ? (code.data as { meta?: string } | undefined) : undefined;
  return {
    lang,
    source: textOf(code as ExtraProps['node']).replace(/\n$/, ''),
    meta: data?.meta ?? '',
  };
}

/**
 * Phase 4b: to isté čo `richFenceOf`, ale pre ĽUBOVOĽný jazyk zárezu —
 * paper mód potrebuje rozlíšiť aj `references` (nerenderovať) a
 * `equation` (KaTeX s číslom). Vracia `null` pre obyčajný odsek textu.
 */
function fenceOfAny(node: ExtraProps['node']): { lang: string; source: string; meta: string } | null {
  if (node === undefined || !('children' in node) || !Array.isArray(node.children)) return null;
  const code = node.children.find(
    (child) => typeof child === 'object' && child !== null && 'tagName' in child && child.tagName === 'code',
  );
  if (code === undefined || typeof code !== 'object' || !('properties' in code)) return null;
  const properties = code.properties as { className?: string | string[] } | undefined;
  const lang = languageOf(properties?.className);
  if (lang === null) return null;
  const data = 'data' in code ? (code.data as { meta?: string } | undefined) : undefined;
  return {
    lang,
    source: textOf(code as ExtraProps['node']).replace(/\n$/, ''),
    meta: data?.meta ?? '',
  };
}

/* ── cache mermaid SVG (zdroj hash + téma), dizajn Q3 ──────────────────── */

const MERMAID_CACHE_MAX = 32;
const mermaidCache = new Map<string, string>();

function djb2(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

function cachePut(key: string, value: string): void {
  if (mermaidCache.size >= MERMAID_CACHE_MAX) {
    const oldest = mermaidCache.keys().next();
    if (!oldest.done) mermaidCache.delete(oldest.value);
  }
  mermaidCache.set(key, value);
}

/* ── MermaidBlock ──────────────────────────────────────────────────────── */

type BlockState = { kind: 'loading' } | { kind: 'ok'; svg: string } | { kind: 'error'; message: string };

/**
 * Jeden mermaid diagram: lazy import knižníc, strict konfigurácia, DOMPurify
 * sanitizácia, vloženie `ref`-om. `themeEpoch` mení MutationObserver v
 * RichContent pri zmene `data-theme` → SVG sa pre-renderuje s novými
 * tokenmi (dizajn Q3: „Rendered SVGs are cached by (source hash, theme)").
 */
const MermaidBlock = memo(function MermaidBlock({
  source,
  fig,
  themeEpoch,
}: {
  source: string;
  fig?: string;
  themeEpoch: number;
}): JSX.Element {
  const { t } = useTranslation('forum');
  const holder = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BlockState>({ kind: 'loading' });

  const tooLong = source.length > MERMAID_MAX_TEXT_SIZE;

  useEffect(() => {
    if (tooLong) {
      setState({ kind: 'error', message: t('rich.diagramTooLong', { max: String(MERMAID_MAX_TEXT_SIZE) }) });
      return;
    }
    let cancelled = false;
    const theme = readDiagramTheme();
    // identita témy je atribút `data-theme` (farby z neho odvodené);
    // cache teda prežíva prepnutie témy a trhá ho, keď sa téma reálne zmení
    const themeName = document.documentElement.getAttribute('data-theme') ?? 'default';
    const cacheKey = `${djb2(source)}|${themeName}`;
    const cached = mermaidCache.get(cacheKey);
    if (cached !== undefined) {
      setState({ kind: 'ok', svg: cached });
      return;
    }
    void (async () => {
      try {
        const [{ default: mermaid }, { default: purify }] = await Promise.all([import('mermaid'), import('dompurify')]);
        const svg = await renderMermaidSvg(
          mermaid as unknown as Parameters<typeof renderMermaidSvg>[0],
          purify,
          source,
          `f4ai-m-${djb2(source)}-${String(themeEpoch)}`,
          theme,
        );
        if (cancelled) return;
        cachePut(cacheKey, svg);
        setState({ kind: 'ok', svg });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, themeEpoch, tooLong, t]);

  // sanitizované SVG vložíme cez ref (fragment), nie innerHTML na surový výstup
  useEffect(() => {
    const el = holder.current;
    if (el === null || state.kind !== 'ok') return;
    const template = document.createElement('template');
    template.innerHTML = state.svg;
    el.replaceChildren(template.content);
  }, [state]);

  if (state.kind === 'error') {
    return (
      <div className="chart-error" data-testid="mermaid-error" role="alert">
        {`${t('rich.diagramFailed')}: ${state.message}`}
        <details>
          <summary>{t('rich.showSource')}</summary>
          <pre>{source}</pre>
        </details>
      </div>
    );
  }

  return (
    <div className="mermaid-block" data-testid="mermaid-block" data-fig={fig}>
      {state.kind === 'loading' && (
        <p className="claim-hint" data-testid="mermaid-loading">
          {t('rich.rendering')}
        </p>
      )}
      <div ref={holder} data-testid="mermaid-svg" />
    </div>
  );
});

/* ── ChartBlock ────────────────────────────────────────────────────────── */

/**
 * Jeden ```chart blok: validácia zdieľaným `validateChartDsl` (shared —
 * rovnaký kód použije aj gateway lint v Phase 4), potom lazy import SVG
 * renderera. Neplatný DSL → `.chart-error` so zoznamom chýb a zdrojom.
 */
const ChartBlock = memo(function ChartBlock({ source, fig }: { source: string; fig?: string }): JSX.Element {
  const { t } = useTranslation('forum');
  const validation = useMemo(() => validateChartDsl(source), [source]);
  const [element, setElement] = useState<JSX.Element | null>(null);

  useEffect(() => {
    if (!validation.ok || validation.data === undefined) return;
    let cancelled = false;
    void import('../lib/chart-svg.js')
      .then((mod) => {
        if (!cancelled) setElement(mod.renderChart(validation.data as ChartDsl));
      })
      .catch(() => {
        // renderer sa nepodarilo načítať → zostane placeholder, obsah nepadne
      });
    return () => {
      cancelled = true;
    };
  }, [validation]);

  if (!validation.ok) {
    return (
      <div className="chart-error" data-testid="chart-error" role="alert">
        {`${t('rich.chartInvalid')}: ${validation.errors.join('; ')}`}
        <details>
          <summary>{t('rich.showSource')}</summary>
          <pre>{source}</pre>
        </details>
      </div>
    );
  }

  return (
    <div className="chart-block" data-testid="chart-block" data-fig={fig}>
      {element ?? (
        <p className="claim-hint" data-testid="chart-loading">
          {t('rich.rendering')}
        </p>
      )}
    </div>
  );
});

/* ── wrapper postavy (fig/caption) ─────────────────────────────────────── */

function Figure({
  fig,
  caption,
  id,
  children,
}: {
  fig?: string;
  caption?: string;
  /** Phase 4b: kotva `fig:<id>` pre krížové odkazy (`@fig:x`) */
  id?: string;
  children: JSX.Element;
}): JSX.Element {
  if (caption === undefined && fig === undefined) return children;
  return (
    <figure className="figure-block" data-testid="figure-block" data-fig={fig} id={id}>
      {children}
      {caption !== undefined && (
        <figcaption className="figure-caption" data-testid="figure-caption">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

/* ── numberovaná rovnica (paper mód, Phase 4b) ─────────────────────────── */

/**
 * ` ```equation id=x num=1 ` zárez, ktorý vytvoril `preparePaper` z
 * `$$ … $$ {#eq:x}`. KaTeX sa lazy-importuje samostatne (paper môže mať
 * ROVNICE aj bez `$$` syntaxe, ktorú by `hasMathSyntax` nevidel); pri
 * zlyhaní zostáva surový TeX — nikdy prázdne miesto.
 */
function EquationBlock({ source, id, num }: { source: string; id: string; num: number }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([import('katex'), import('katex/dist/katex.min.css')])
      .then(([katex]) => {
        if (cancelled) return;
        try {
          setHtml(katex.default.renderToString(source, { throwOnError: false, displayMode: true }));
        } catch {
          setHtml(null);
        }
      })
      .catch(() => {
        // katex sa nepodarilo načítať → zobrazíme surový TeX
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <div className="equation-block" id={`eq:${id}`} data-testid="equation-block" data-num={num}>
      <div className="equation-body" data-testid="equation-body">
        {html !== null ? <span dangerouslySetInnerHTML={{ __html: html }} /> : <code>{source}</code>}
      </div>
      <span className="equation-number" data-testid="equation-number">
        ({num})
      </span>
    </div>
  );
}

/* ── RichContent ───────────────────────────────────────────────────────── */

export interface RichContentProps {
  /** surový markdown content eventu (NIP-01 `content`) */
  content: string;
  /** extra triedy kontajnera (`.prose` pridávame sempre) */
  className?: string;
  testId?: string;
  /**
   * Phase 4b: `paper` mód pridáva papierové rozšírenia (číslované
   * rovnice z ` ```equation `, kotvy obrázkov, `Table:` popisky,
   * interné odkazy na `#fig:`/`#tbl:`/`#eq:`/`#ref:` a sup citácie).
   * Default (`undefined`) je BYTE-IDENTICAL so starším správaním —
   * bežné príspevky sa nesprávajú inak.
   */
  mode?: 'default' | 'paper';
  /** index z `preparePaper` (číslovanie, popisky, citácie) pre paper mód */
  paper?: PaperIndex;
}

/**
 * Vykresli markdown obsah fóra. `className` sa udržiava na kontajneri
 * (existujúce `event-body` apod.), `.prose` je wrapper dizajnového systému
 * z Phase 3a.
 */
export function RichContent({
  content,
  className,
  testId = 'rich-content',
  mode = 'default',
  paper,
}: RichContentProps): JSX.Element {
  const { t } = useTranslation('forum');
  const { t: tp } = useTranslation('paper');

  // --- math: lazy plugin load iba ak content obsahuje math syntax -------
  const needsMath = useMemo(() => hasMathSyntax(content), [content]);
  const [mathPlugins, setMathPlugins] = useState<{ remarkMath: unknown; rehypeKatex: unknown } | null>(null);

  useEffect(() => {
    if (!needsMath || mathPlugins !== null) return;
    let cancelled = false;
    void Promise.all([import('remark-math'), import('rehype-katex'), import('katex/dist/katex.min.css')])
      .then(([remarkMath, rehypeKatex]) => {
        if (!cancelled) setMathPlugins({ remarkMath: remarkMath.default, rehypeKatex: rehypeKatex.default });
      })
      .catch(() => {
        // katex sa nepodarilo načítať → math zostane ako literal text,
        // obsah sa nesmie hodiť do erroru
      });
    return () => {
      cancelled = true;
    };
  }, [needsMath, mathPlugins]);

  // --- theme: MutationObserver na <html data-theme> → pre-render mermaid --
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeEpoch((epoch) => epoch + 1);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
    };
  }, []);

  // --- rozpočet: ≤ 8 diagramov+grafov na príspevok -----------------------
  // React volá `pre` komponenty v poradí dokumentu; počítadlo resetujeme na
  // začiatku každého renderu, takže indexy sú stabilné naprieč re-rendermi
  // (a StrictMode double-render je deterministický).
  const budget = useRef({ n: 0 });
  budget.current.n = 0;

  // paper mód: prvý výskyt citácie nesie kotvu `cite:<key>` (back-link z
  // Referencií). Znovu-reset per render, rovnako ako `budget`.
  const seenCites = useRef<Set<string>>(new Set());
  seenCites.current = new Set();

  const components = useMemo<Components>(() => {
    const base: Components = {
      pre: (props) => {
        const fence = richFenceOf(props.node);
        if (fence === null) {
          return <pre className="code-block">{props.children}</pre>;
        }
        const meta = parseFenceMeta(fence.meta);
        const index = budget.current.n;
        budget.current.n += 1;
        if (index >= MAX_RICH_BLOCKS_PER_POST) {
          return (
            <div className="chart-error" data-testid="rich-block-limit" role="note">
              {t('rich.tooManyBlocks', { max: String(MAX_RICH_BLOCKS_PER_POST) })}
            </div>
          );
        }
        return (
          <Figure fig={meta.fig} caption={meta.caption}>
            {fence.lang === 'mermaid' ? (
              <MermaidBlock source={fence.source} fig={meta.fig} themeEpoch={themeEpoch} />
            ) : (
              <ChartBlock source={fence.source} fig={meta.fig} />
            )}
          </Figure>
        );
      },
      // odkazy: nofollow + noopener (dizajn Q3), externé v novom tabi
      a: ({ href, children }) => (
        <a href={href} target="_blank" rel="nofollow noopener ugc" data-testid="prose-link">
          {children}
        </a>
      ),
      // obrázky: len https, bez referencií, lazy (dizajn Q3)
      img: ({ src, alt }) => {
        if (typeof src !== 'string' || !src.startsWith('https://')) {
          return <span className="chart-error">{alt ?? ''}</span>;
        }
        return <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />;
      },
    };

    if (mode !== 'paper') return base;

    // ── paper mód (Phase 4b) ────────────────────────────────────────────
    // `preparePaper` predspracoval markdown: číslovanie je v texte,
    // `@fig:`/`[@key]` sú markdown odkazy s našimi `#…` ciele a rovnice
    // sú ` ```equation ` zárezy. Tu ich len preložíme na prvky.
    const paperComponents: Components = {
      ...base,
      pre: (props) => {
        const fence = fenceOfAny(props.node);
        if (fence === null) return <pre className="code-block">{props.children}</pre>;
        // `references` zárez NIE JE code block — stáva sa sekciovou
        // časťou stránky (PaperPage); sem sa má dostať len ako poistka
        if (fence.lang === 'references') return null;
        if (fence.lang === 'equation') {
          const id = /(?:^|\s)id=([^\s]+)/.exec(fence.meta)?.[1] ?? '';
          const num = Number(/(?:^|\s)num=(\d+)/.exec(fence.meta)?.[1] ?? '0');
          return <EquationBlock source={fence.source} id={id} num={Number.isFinite(num) ? num : 0} />;
        }
        const rich = richFenceOf(props.node);
        if (rich === null) return <pre className="code-block">{props.children}</pre>;
        const meta = parseFenceMeta(rich.meta);
        const index = budget.current.n;
        budget.current.n += 1;
        if (index >= MAX_RICH_BLOCKS_PER_POST) {
          return (
            <div className="chart-error" data-testid="rich-block-limit" role="note">
              {t('rich.tooManyBlocks', { max: String(MAX_RICH_BLOCKS_PER_POST) })}
            </div>
          );
        }
        const figure = meta.fig !== undefined ? paper?.figures.get(meta.fig) : undefined;
        const caption =
          figure !== undefined
            ? `${tp('labels.figure')} ${String(figure.num)}${figure.caption !== '' ? ` — ${figure.caption}` : ''}`
            : meta.caption;
        return (
          <Figure fig={meta.fig} caption={caption} id={figure !== undefined ? `fig:${figure.id}` : undefined}>
            {rich.lang === 'mermaid' ? (
              <MermaidBlock source={rich.source} fig={meta.fig} themeEpoch={themeEpoch} />
            ) : (
              <ChartBlock source={rich.source} fig={meta.fig} />
            )}
          </Figure>
        );
      },
      // `Table: … {#tbl:x}` → číslovaný popisek s kotvou (tabuľka nasleduje)
      p: (props) => {
        const node = props.node;
        if (node !== undefined) {
          const parsed = parseTableCaption(textOf(node));
          if (parsed !== null) {
            const entry = paper?.tables.get(parsed.id);
            if (entry !== undefined) {
              return (
                <div
                  className="table-caption"
                  id={`tbl:${entry.id}`}
                  data-testid="table-caption"
                  data-num={entry.num}
                >
                  {`${tp('labels.table')} ${String(entry.num)}${entry.caption !== '' ? ` — ${entry.caption}` : ''}`}
                </div>
              );
            }
          }
        }
        return <p>{props.children}</p>;
      },
      a: (props) => {
        const href = typeof props.href === 'string' ? props.href : '';
        const title = typeof props.title === 'string' ? props.title : undefined;
        // citácia → superskript číslovaný odkaz do Referencií
        if (href.startsWith('#ref:')) {
          const key = href.slice('#ref:'.length);
          const first = !seenCites.current.has(key);
          seenCites.current.add(key);
          return (
            <sup className="citation" data-testid="citation" id={first ? `cite:${key}` : undefined}>
              <a href={href} title={title}>
                {props.children}
              </a>
            </sup>
          );
        }
        if (href.startsWith('#cite-unknown:')) {
          const key = href.slice('#cite-unknown:'.length);
          return (
            <span className="xref-unknown" data-testid="citation-unknown" title={tp('cite.unresolved', { key })}>
              {props.children}
            </span>
          );
        }
        if (href.startsWith('#xref-unknown:')) {
          const ref = href.slice('#xref-unknown:'.length).replace(':', ':');
          return (
            <span className="xref-unknown" data-testid="xref-unknown" title={tp('xref.unresolved', { ref })}>
              {props.children}
            </span>
          );
        }
        // interný krížový odkaz: bez `target=_blank`, s titulkom-popisom
        if (/^#(fig|tbl|eq):/.test(href)) {
          return (
            <a href={href} className="xref" data-testid="xref" title={title}>
              {props.children}
            </a>
          );
        }
        return (
          <a href={props.href} target="_blank" rel="nofollow noopener ugc" data-testid="prose-link">
            {props.children}
          </a>
        );
      },
    };
    return paperComponents;
  }, [t, tp, themeEpoch, mode, paper]);

  const remarkPlugins = useMemo(
    () => (mathPlugins !== null ? [remarkGfm, mathPlugins.remarkMath] : [remarkGfm]),
    [mathPlugins],
  );
  const rehypePlugins = useMemo(() => (mathPlugins !== null ? [mathPlugins.rehypeKatex] : []), [mathPlugins]);

  return (
    <div className={['prose', className].filter((v) => v !== undefined && v !== '').join(' ')} data-testid={testId}>
      <Markdown remarkPlugins={remarkPlugins as never[]} rehypePlugins={rehypePlugins as never[]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
