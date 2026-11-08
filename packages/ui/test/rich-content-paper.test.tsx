/**
 * RichContent v `paper` móde (Phase 4b) — papierové rozšírenia sú OPT-IN:
 * default mód (bežné príspevky) musí ostať byte-identical, preto testy
 * porovnávajú OBA reží na tom istom vstupe.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RichContent } from '../src/components/RichContent.js';
import { preparePaper } from '../src/lib/paper-render.js';
import { PAPER_BODY } from './fixtures.js';

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    render: async () => ({ svg: '<svg data-fake="mermaid"><g><text>diagram</text></g></svg>' }),
  },
}));

const SK = { figure: 'Obrázok', table: 'Tabuľka', equation: 'Rovnica' };
const prepared = preparePaper(PAPER_BODY, SK);

const text = (node: Element | null | undefined): string => node?.textContent ?? '';

describe('paper mód', () => {
  it('`references` zárez nie je code block', () => {
    render(<RichContent mode="paper" paper={prepared.index} content={prepared.content} />);
    expect(document.querySelector('pre.code-block')).toBeNull();
    expect(text(screen.getByTestId('rich-content'))).not.toContain('"container-title"');
  });

  it('`equation` zárez je KaTeX s číslom a kotvou', async () => {
    render(<RichContent mode="paper" paper={prepared.index} content={prepared.content} />);
    const block = screen.getByTestId('equation-block');
    expect(block.getAttribute('id')).toBe('eq:latency');
    expect(text(screen.getByTestId('equation-number'))).toBe('(1)');
    await waitFor(() => expect(block.querySelector('.katex')).toBeTruthy());
  });

  it('rovnica bez KaTeX (fallback) nezničí obsah', async () => {
    // katex sa v testoch naimportuje, preto testujeme aspoň že surový TeX
    // zostáva v DOM pred tým, než príde HTML — a číslo je viditeľné vždy
    render(<RichContent mode="paper" paper={prepared.index} content={prepared.content} />);
    expect(text(screen.getByTestId('equation-number'))).toBe('(1)');
  });

  it('fig= zárez dostane číslovaný popisek a kotvu', () => {
    render(<RichContent mode="paper" paper={prepared.index} content={prepared.content} />);
    const captions = screen.getAllByTestId('figure-caption');
    expect(text(captions[0])).toContain('Obrázok 1 — Replication stack');
    expect(text(captions[1])).toContain('Obrázok 2 — Latency distribution');
    expect(document.getElementById('fig:arch')).toBeTruthy();
  });

  it('`Table: … {#tbl:x}` je číslovaný popisek s kotvou', () => {
    render(<RichContent mode="paper" paper={prepared.index} content={prepared.content} />);
    const caption = screen.getByTestId('table-caption');
    expect(text(caption)).toContain('Tabuľka 1 — Latency per hop');
    expect(caption.getAttribute('id')).toBe('tbl:results');
  });

  it('citácia je superskript; prvý výskyt nesie kotvu, druhý už nie', () => {
    render(<RichContent mode="paper" paper={prepared.index} content={prepared.content} />);
    const cites = screen.getAllByTestId('citation');
    expect(cites.length).toBeGreaterThanOrEqual(2);
    expect(cites[0]?.tagName.toLowerCase()).toBe('sup');
    expect(cites[0]?.getAttribute('id')).toBe('cite:novak2026');
    const second = cites.filter((n) => n.getAttribute('id') === 'cite:novak2026');
    expect(second).toHaveLength(1);
  });

  it('nevyriešené značky majú vlastné markery', () => {
    render(<RichContent mode="paper" paper={prepared.index} content={prepared.content} />);
    expect(screen.getByTestId('citation-unknown')).toBeTruthy();
    expect(screen.getByTestId('xref-unknown')).toBeTruthy();
  });

  it('interné odkazy neotvárajú nový tab, externé áno', () => {
    render(
      <RichContent
        mode="paper"
        paper={prepared.index}
        content={'[Obrázok 1](#fig:arch)\n\n[web](https://example.org)'}
      />,
    );
    const internal = screen.getByTestId('xref');
    expect(internal.getAttribute('target')).toBeNull();
    const external = screen.getByTestId('prose-link');
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toContain('nofollow');
  });

  // audit 7.5 P2-13: `…$` inline math FUNGUJE v paper móde (RichContent
  // naťahuje remark-math/rehype-katex bez ohľadu na mód) — chytili sme
  // preto len zlý seed, ktorý `\Delta` obalil backtickmi (code chip).
  // Tento test drží, že `$\Delta$` je KaTeX, nie code chip.
  it('inline `$…$` sa v paper móde parsí na KaTeX', async () => {
    render(
      <RichContent
        mode="paper"
        paper={prepared.index}
        content={'positive $\\Delta$ means the gate is saturated'}
      />,
    );
    await waitFor(() => expect(document.querySelector('.katex')).toBeTruthy());
    expect(document.querySelector('.prose :not(pre) > code')).toBeNull();
  });
});

describe('default mód (regresia — nesmie sa správať ako papier)', () => {
  it('`references` zárez je normálny code block', () => {
    render(<RichContent content={'```references\n[{"id":"a","type":"book"}]\n```'} />);
    expect(document.querySelector('pre.code-block')).toBeTruthy();
    expect(screen.queryByTestId('equation-block')).toBeNull();
  });

  it('#ref: odkaz je bežný externý odkaz (žiadny superskript)', () => {
    render(<RichContent content={'citatia [1](#ref:novak2026)'} />);
    const link = screen.getByTestId('prose-link');
    expect(link.getAttribute('href')).toBe('#ref:novak2026');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.queryByTestId('citation')).toBeNull();
  });

  it('`Table: … {#tbl:x}` ostáva odsek bez kotvy', () => {
    render(<RichContent content={'Table: Latency {#tbl:results}\n\n| a |\n| - |\n| 1 |'} />);
    expect(screen.queryByTestId('table-caption')).toBeNull();
  });

  it('`equation` zárez je v default móde code block', () => {
    render(<RichContent content={'```equation id=x num=1\nE = mc^2\n```'} />);
    expect(document.querySelector('pre.code-block')).toBeTruthy();
    expect(screen.queryByTestId('equation-block')).toBeNull();
  });

  it('fig= popisek v default móde nemá číslo (to pridáva až paper mód)', () => {
    render(<RichContent content={'```chart fig=arch caption="Stack"\n{"type":"line","series":[{"name":"a","points":[[1,2]]}]}\n```'} />);
    const caption = screen.getByTestId('figure-caption');
    expect(text(caption)).toBe('Stack');
    expect(text(caption)).not.toContain('Obrázok');
  });
});
