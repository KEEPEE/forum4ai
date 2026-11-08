/**
 * Testy RichContent renderu (Phase 3b, dizajn Q3).
 *
 * Mermaid je v jsdom mocked — jeho render vyžaduje layout a d3, čo tu
 * nepotrebujeme; testujeme VECI, ktoré zaujímajú: že sa vôbec nenačíta,
 * kým v obsahu nie je ```mermaid zárez, že konfigurácia je strict, že sa
 * jeho SVG sanitizuje DOMPurify (reálny) a že chyba nepadá do crashu.
 *
 * Testy bežia v SK (`test/setup.ts`), preto copy očíravame cez testidy
 * a kde treba, cez slovenské reťazce.
 */
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RichContent, hasMathSyntax, parseFenceMeta, richFenceOf } from '../src/components/RichContent.js';

/** volania mocknutého mermaid modulu (počet renderov, odovzdaná konfigurácia) */
const mermaidCalls = vi.hoisted(() => ({
  render: 0,
  initialize: 0,
  configs: [] as Record<string, unknown>[],
  fail: false,
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: (config: Record<string, unknown>) => {
      mermaidCalls.initialize += 1;
      mermaidCalls.configs.push(config);
    },
    render: async (_id: string, source: string) => {
      mermaidCalls.render += 1;
      if (mermaidCalls.fail) throw new Error('Parse error: unexpected token');
      // zámerne špinavý výstup: script, foreignObject, image s href+onerror
      return {
        svg: `<svg data-fake="mermaid" data-src="${source.slice(0, 8)}"><g class="node"><text>diagram</text></g><style>.n{fill:red}</style><script>window.__pwned = 1</script><image href="https://evil.example/x.png" onerror="window.__pwned = 2"></image><foreignObject><b>html</b></foreignObject></svg>`,
      };
    },
  },
}));

/** kazdy test potrebuje vlastny zdroj — cache (source hash, tema) by inak
 *  zrazil počet volaní a testy o lazy/bytosti renderu klamali */
let sourceSeq = 0;
function mmSource(label: string): string {
  sourceSeq += 1;
  return `graph TD\n  ${label}${String(sourceSeq)}-->B${String(sourceSeq)}`;
}

function renderRich(content: string) {
  return render(<RichContent content={content} />);
}

describe('RichContent — markdown a GFM', () => {
  it('renderuje nadpisy, odrážky a tučný text ako HTML', () => {
    const { container } = renderRich('## Nadpis\n\n- **prvy** bod\n- druhy bod');
    expect(container.querySelector('h2')?.textContent).toBe('Nadpis');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toBe('prvy');
  });

  it('renderuje GFM tabuľku ako <table> s <th>', () => {
    const { container } = renderRich('| relay | p95 |\n| --- | --- |\n| alpha | 4 ms |\n| beta | 9 ms |');
    expect(container.querySelectorAll('thead th')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.textContent).toContain('alpha');
  });

  it('renderuje GFM task list s checkboxmi', () => {
    const { container } = renderRich('- [x] hotovo\n- [ ] otvorene');
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement | null)?.checked).toBe(true);
  });

  it('obyčajný ``` zárez ostáva code block so triedou .code-block', () => {
    const { container } = renderRich('```ts\nconst a = 1;\n```');
    const pre = container.querySelector('pre.code-block');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('const a = 1;');
    expect(pre?.querySelector('code.language-ts')).not.toBeNull();
  });

  it('neznámy zárezový jazyk (```uml) padne na code block, nie crash', () => {
    const { container } = renderRich('```uml\n@startuml\nA -> B\n@enduml\n```');
    expect(container.querySelector('pre.code-block')).not.toBeNull();
    expect(container.querySelector('[data-testid="mermaid-block"]')).toBeNull();
  });

  it('surové HTML v contente sa NERENDERUJE (bez rehype-raw) — zostáva text', () => {
    const { container } = renderRich('pred <script>window.__raw = 1</script> po');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>window.__raw = 1</script>');
  });

  it('odkazy dostanú rel="nofollow noopener ugc"', () => {
    const { container } = renderRich('[docs](https://example.org/a)');
    const link = container.querySelector<HTMLAnchorElement>('a[data-testid="prose-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('rel')).toBe('nofollow noopener ugc');
    expect(link?.getAttribute('href')).toBe('https://example.org/a');
  });

  it('obrázky: https prejde s lazy/no-referrer, http preskočí', () => {
    const https = renderRich('![topology](https://example.org/t.png)');
    const img = https.container.querySelector('img');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');

    const http = renderRich('![local](http://example.org/t.png)');
    expect(http.container.querySelector('img')).toBeNull();
    expect(http.container.querySelector('.chart-error')).not.toBeNull();
  });

  it('.prose je na kontajneri a custom className sa zachová', () => {
    const { container } = render(<RichContent content="text" className="event-body" testId="body" />);
    const wrapper = container.querySelector('[data-testid="body"]');
    expect(wrapper?.className).toBe('prose event-body');
  });
});

describe('RichContent — helpers', () => {
  it('hasMathSyntax chytí $$blok$$ aj $inline$, nie obyčajný text', () => {
    expect(hasMathSyntax('energy $$E = mc^2$$')).toBe(true);
    expect(hasMathSyntax('energy $E = mc^2$')).toBe(true);
    expect(hasMathSyntax('\\(x^2\\)')).toBe(true);
    expect(hasMathSyntax('zadna matematika tu nie je')).toBe(false);
  });

  it('parseFenceMeta parcuje fig a caption (s úvodzovkami aj bez)', () => {
    expect(parseFenceMeta('fig=arch caption="Replication topology"')).toEqual({
      fig: 'arch',
      caption: 'Replication topology',
    });
    expect(parseFenceMeta('')).toEqual({});
    expect(parseFenceMeta(undefined)).toEqual({});
    expect(parseFenceMeta("caption='single quoted'")).toEqual({ caption: 'single quoted' });
  });

  it('richFenceOf je null na obyčajnom pre a vracia jazyk/zdroj/meta pre mermaid', () => {
    const node = {
      type: 'element',
      tagName: 'pre',
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-mermaid'] },
          data: { meta: 'fig=x' },
          children: [{ type: 'text', value: 'graph TD\n' }],
        },
      ],
    };
    expect(richFenceOf(node as never)).toEqual({ lang: 'mermaid', source: 'graph TD', meta: 'fig=x' });
    expect(richFenceOf({ type: 'element', tagName: 'pre', children: [] } as never)).toBeNull();
  });
});

describe('RichContent — KaTeX len na vyžiadanie', () => {
  it('block math ($$ na vlastných riadkoch) renderuje .katex-display', async () => {
    const { container } = renderRich('energia je\n\n$$\nE = mc^2\n$$\n\nv príspevku');
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
    // `rehype-katex` nahrádza math uzol výstupom KaTeX: blok = .katex-display,
    // inline = .katex (triedy math-display/math-inline zanikajú)
    expect(container.querySelector('.katex-display')).not.toBeNull();
    expect(container.textContent).toContain('E');
  });

  it('inline math ($…$) renderuje .katex bez .katex-display', async () => {
    const { container } = renderRich('hmotnost $m$ a energia $E$');
    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(2));
    expect(container.querySelector('.katex-display')).toBeNull();
  });

  it('chybná math syntax nepadá — obsah ostáva, KaTeX kreslí chybu', async () => {
    const { container } = renderRich('$$\\frac{1}{$$');
    await waitFor(() => expect(container.textContent).toContain('frac'));
  });

  it('obsah bez matematiky nespúšťa math pipeline (katex chunk sa nenačíta)', async () => {
    const { container } = renderRich('ciste markdownove slova bez matematiky');
    // počkaj na microtasks: ak by sa math načítal, .katex by sa objavil
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('.katex')).toBeNull();
  });
});

describe('RichContent — mermaid lazy, strict, sanitizácia', () => {
  it('obsah bez ```mermaid nespustí mermaid vôbec', async () => {
    const before = mermaidCalls.render;
    const { container } = renderRich('```chart\n{"v":1,"type":"line","series":[{"name":"a","data":[1]}]}\n```');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mermaidCalls.render).toBe(before);
    expect(container.querySelector('[data-testid="mermaid-block"]')).toBeNull();
  });

  it('```mermaid zárez naštartuje mermaid a vloží SVG do .mermaid-block', async () => {
    const before = mermaidCalls.render;
    const { container } = renderRich('```mermaid\n' + mmSource('T') + '\n```');
    expect(container.querySelector('[data-testid="mermaid-block"]')).not.toBeNull();
    await waitFor(() => expect(mermaidCalls.render).toBeGreaterThan(before));
    await waitFor(() => expect(container.querySelector('[data-fake="mermaid"]')).not.toBeNull());
  });

  it('mermaid konfigurácia je strict: securityLevel, htmlLabels, stropy, theme base', async () => {
    renderRich('```mermaid\n' + mmSource('T') + '\n```');
    await waitFor(() => expect(mermaidCalls.configs.length).toBeGreaterThan(0));
    const config = mermaidCalls.configs.at(-1) as Record<string, unknown>;
    expect(config['securityLevel']).toBe('strict');
    expect(config['htmlLabels']).toBe(false);
    expect(config['maxTextSize']).toBe(20_000);
    expect(config['maxEdges']).toBe(300);
    expect(config['theme']).toBe('base');
    expect(config['startOnLoad']).toBe(false);
    // themeVariables prichádzajú z tokenov (--diagram-*), nie hardcodované
    const vars = config['themeVariables'] as Record<string, string>;
    expect(vars['primaryColor']).toBeTruthy();
    expect(vars['lineColor']).toBeTruthy();
  });

  it('DOMPurify zo SVG odstráni script, foreignObject a href/onerror na image', async () => {
    const { container } = renderRich('```mermaid\n' + mmSource('T') + '\n```');
    await waitFor(() => expect(container.querySelector('[data-fake="mermaid"]')).not.toBeNull());
    const holder = container.querySelector('[data-testid="mermaid-svg"]');
    expect(holder?.querySelector('script')).toBeNull();
    expect(holder?.querySelector('foreignObject')).toBeNull();
    const image = holder?.querySelector('image');
    expect(image?.getAttribute('href')).toBeNull();
    expect(image?.getAttribute('xlink:href')).toBeNull();
    expect(image?.getAttribute('onerror')).toBeNull();
    // obsah, ktorý má zostať, zostal
    expect(holder?.textContent).toContain('diagram');
  });

  it('zlyhanie renderu padne do .chart-error so zdrojom v <details>', async () => {
    mermaidCalls.fail = true;
    try {
      const { container } = renderRich('```mermaid\n' + mmSource('T') + '\n```');
      await waitFor(() => expect(container.querySelector('[data-testid="mermaid-error"]')).not.toBeNull());
      const box = container.querySelector('[data-testid="mermaid-error"]');
      expect(box?.className).toContain('chart-error');
      expect((box?.querySelector('details')?.textContent ?? '')).toContain('graph TD');
    } finally {
      mermaidCalls.fail = false;
    }
  });

  it('zdroj dlhší ako 20 000 znakov sa vôbec neskúsi renderovať', async () => {
    const before = mermaidCalls.render;
    const huge = `graph TD\n${'A-->B\n'.repeat(4000)}`;
    expect(huge.length).toBeGreaterThan(20_000);
    const { container } = renderRich(`\`\`\`mermaid\n${huge}\n\`\`\``);
    await waitFor(() => expect(container.querySelector('[data-testid="mermaid-error"]')).not.toBeNull());
    expect(mermaidCalls.render).toBe(before);
  });
});

describe('RichContent — Chart DSL', () => {
  const chart = (json: string) => `\`\`\`chart\n${json}\n\`\`\``;

  it('validný ```chart zárez renderuje SVG s var(--chart-N) tahmi', async () => {
    const { container } = renderRich(
      chart('{"v":1,"type":"line","x":{"label":"RPS"},"y":{"label":"p95","unit":"ms"},"series":[{"name":"relay","data":[1,2,3]},{"name":"gateway","data":[2,4,6]}]}'),
    );
    await waitFor(() => expect(container.querySelector('[data-testid="chart-svg"]')).not.toBeNull());
    const svg = container.querySelector('svg[data-testid="chart-svg"]');
    expect(svg?.getAttribute('data-chart-type')).toBe('line');
    expect(svg?.getAttribute('data-series')).toBe('2');
    const strokes = Array.from(container.querySelectorAll('path[stroke]')).map((p) => p.getAttribute('stroke'));
    expect(strokes).toContain('var(--chart-0)');
    expect(strokes).toContain('var(--chart-1)');
    // osi a popisky
    expect(container.querySelector('[data-testid="chart-x-label"]')?.textContent).toBe('RPS');
    expect(container.querySelector('[data-testid="chart-y-label"]')?.textContent).toBe('p95 [ms]');
  });

  it('category os vykreslí kategórie ako popisky osi', async () => {
    const { container } = renderRich(
      chart('{"v":1,"type":"bar","x":{"categories":["W1","W2"]},"series":[{"name":"a","data":[1,2]}]}'),
    );
    await waitFor(() => expect(container.querySelector('[data-testid="chart-svg"]')).not.toBeNull());
    expect(container.textContent).toContain('W1');
    expect(container.textContent).toContain('W2');
    // audit 7.5 P1-3: tyče sa plnia gradientom série (stop-color drží
    // --chart-N / --chart-N-end, takže téma prepína live) — flat
    // `fill="var(--chart-N)"` ostáva len v legendě, a tá je pri jednej
    // sérii preč (P2-8)
    const bars = container.querySelectorAll('rect[data-bar]');
    expect(bars.length).toBeGreaterThan(0);
    expect(bars[0]?.getAttribute('fill')).toMatch(/^url\(#f4ai-cg-/);
    const stops = Array.from(container.querySelectorAll('linearGradient stop')).map((s) => s.getAttribute('stop-color'));
    expect(stops).toContain('var(--chart-0)');
    expect(stops).toContain('var(--chart-0-end)');
    expect(container.querySelector('rect[fill="var(--chart-0)"]')).toBeNull();
  });

  it('stacked-bar a scatter typy renderujú SVG', async () => {
    for (const type of ['stacked-bar', 'scatter'] as const) {
      const { container } = renderRich(
        chart(`{"v":1,"type":"${type}","x":{"categories":["a","b"]},"series":[{"name":"s","data":[1,2]}]}`),
      );
      await waitFor(() => expect(container.querySelector(`svg[data-chart-type="${type}"]`)).not.toBeNull());
    }
  });

  it('err úsečky sa renderujú ako extra SVG prvky', async () => {
    const { container } = renderRich(
      chart('{"v":1,"type":"line","series":[{"name":"a","data":[1,2,3],"err":[0.1,0.2,0.3]}]}'),
    );
    await waitFor(() => expect(container.querySelector('[data-testid="chart-svg"]')).not.toBeNull());
    const titles = Array.from(container.querySelectorAll('title')).map((t) => t.textContent ?? '');
    expect(titles.some((t) => t.includes('±0.1'))).toBe(true);
  });

  it('neplatný chart DSL padne do .chart-error so zoznamom chýb a zdrojom', async () => {
    const { container } = renderRich(chart('{"v":2,"type":"pie","series":[]}'));
    await waitFor(() => expect(container.querySelector('[data-testid="chart-error"]')).not.toBeNull());
    const box = container.querySelector('[data-testid="chart-error"]');
    expect(box?.className).toContain('chart-error');
    expect(box?.textContent).toContain('root.v');
    expect((box?.querySelector('details')?.textContent ?? '')).toContain('"type":"pie"');
  });

  it('skazený JSON v ```chart nespadne — chybový box so zdrojom', async () => {
    const { container } = renderRich('```chart\n{"v":1,,}\n```');
    await waitFor(() => expect(container.querySelector('[data-testid="chart-error"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="chart-error"]')?.textContent).toContain('invalid JSON');
  });

  it('chart fence väčší ako 16 KB je chyba, nie render', async () => {
    const big = `{"v":1,"type":"line","series":[{"name":"a","data":[${Array.from({ length: 4000 }, (_, i) => i).join(',')}]}]}`;
    expect(big.length).toBeGreaterThan(16 * 1024);
    const { container } = renderRich(chart(big));
    await waitFor(() => expect(container.querySelector('[data-testid="chart-error"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="chart-svg"]')).toBeNull();
  });
});

describe('RichContent — fig/caption a limity', () => {
  it('fig + caption vytvoria .figure-block s .figure-caption (plain text)', async () => {
    const { container } = renderRich(
      '```mermaid fig=arch caption="Replication <b>topology</b>"\ngraph TD\n  A-->B\n```',
    );
    const figure = container.querySelector('[data-testid="figure-block"]');
    expect(figure).not.toBeNull();
    expect(figure?.getAttribute('data-fig')).toBe('arch');
    const caption = container.querySelector('[data-testid="figure-caption"]');
    expect(caption?.className).toContain('figure-caption');
    // caption je plain text: HTML tag v ňom nesmie byť element
    expect(caption?.textContent).toContain('Replication <b>topology</b>');
    expect(caption?.querySelector('b')).toBeNull();
  });

  it('bez fig/caption žiadny figure wrapper', async () => {
    const { container } = renderRich('```mermaid\n' + mmSource('T') + '\n```');
    expect(container.querySelector('[data-testid="figure-block"]')).toBeNull();
    expect(container.querySelector('[data-testid="mermaid-block"]')).not.toBeNull();
  });

  it('max 8 diagramov+grafov: deviaty dostane placeholder s i18n copy', async () => {
    const blocks = Array.from({ length: 9 }, (_, i) => `block ${String(i)}\n\n\`\`\`chart\n{"v":1,"type":"line","series":[{"name":"s${String(i)}","data":[${String(i)}]}]}\n\`\`\``).join('\n\n');
    const { container } = renderRich(blocks);
    await waitFor(() => expect(container.querySelectorAll('[data-testid="chart-block"]')).toHaveLength(8));
    const limit = container.querySelector('[data-testid="rich-block-limit"]');
    expect(limit).not.toBeNull();
    expect(limit?.textContent).toContain('8');
    expect(container.querySelectorAll('[data-testid="chart-block"]')).toHaveLength(8);
  });

  it('indexy blokov sú stabilné naprieč re-rendermi (žiadny drift limitu)', async () => {
    const blocks = Array.from({ length: 8 }, (_, i) => `\`\`\`chart\n{"v":1,"type":"line","series":[{"name":"s${String(i)}","data":[${String(i)}]}]}\n\`\`\``).join('\n\n');
    const { container, rerender } = render(<RichContent content={blocks} />);
    await waitFor(() => expect(container.querySelectorAll('[data-testid="chart-block"]')).toHaveLength(8));
    rerender(<RichContent content={blocks} />);
    rerender(<RichContent content={blocks} />);
    await waitFor(() => expect(container.querySelectorAll('[data-testid="chart-block"]')).toHaveLength(8));
    expect(container.querySelector('[data-testid="rich-block-limit"]')).toBeNull();
  });
});

describe('RichContent — theme observer a cleanup', () => {
  it('zmena data-theme pre-renderne mermaid (nový render)', async () => {
    const before = mermaidCalls.render;
    const { container } = renderRich('```mermaid\n' + mmSource('T') + '\n```');
    await waitFor(() => expect(container.querySelector('[data-fake="mermaid"]')).not.toBeNull());
    const afterFirst = mermaidCalls.render;
    expect(afterFirst).toBeGreaterThan(before);

    act(() => {
      document.documentElement.setAttribute('data-theme', 'nexaverse');
    });
    await waitFor(() => expect(mermaidCalls.render).toBeGreaterThan(afterFirst));
    document.documentElement.removeAttribute('data-theme');
  });

  it('po unmount observer nežije — zmena témy už nespustí render', async () => {
    const { container, unmount } = renderRich('```mermaid\n' + mmSource('T') + '\n```');
    await waitFor(() => expect(container.querySelector('[data-fake="mermaid"]')).not.toBeNull());
    unmount();
    const afterUnmount = mermaidCalls.render;
    act(() => {
      document.documentElement.setAttribute('data-theme', 'glass-light');
    });
    // flush microtasks + mutation observer callback
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mermaidCalls.render).toBe(afterUnmount);
    document.documentElement.removeAttribute('data-theme');
  });
});
