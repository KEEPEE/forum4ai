/**
 * Lazy cesty RichContent (Phase 3b): testuje, že sa drahé moduly NAČÍTAJÚ
 * len keď to obsah vyžaduje. Mermaid, remark-math a rehype-katex sú tu
 * mocknuté recording factory — počítadlo volaní je dôkaz cesty, nie výstupu
 * (výstup testuje `rich-content.test.tsx`).
 */
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RichContent } from '../src/components/RichContent.js';

const loads = vi.hoisted(() => ({ mermaid: 0, remarkMath: 0, rehypeKatex: 0, dompurify: 0 }));

vi.mock('mermaid', () => {
  loads.mermaid += 1;
  return {
    default: {
      initialize: () => undefined,
      render: async () => ({ svg: '<svg></svg>' }),
    },
  };
});

vi.mock('dompurify', () => {
  loads.dompurify += 1;
  return { default: { sanitize: (svg: string) => svg } };
});

vi.mock('remark-math', () => {
  loads.remarkMath += 1;
  return { default: () => undefined };
});

vi.mock('rehype-katex', () => {
  loads.rehypeKatex += 1;
  return { default: () => undefined };
});

describe('RichContent — lazy import cesty', () => {
  it('obyčajný markdown nespustí mermaid ani math moduly', async () => {
    const before = { ...loads };
    render(<RichContent content="# nadpis\n\n- zoznam\n- dalsi bod\n\n`code`" />);
    // flush: dynamic importy by sa stihli spustiť
    await waitFor(() => expect(document.body).toBeTruthy());
    expect(loads.mermaid).toBe(before.mermaid);
    expect(loads.remarkMath).toBe(before.remarkMath);
    expect(loads.rehypeKatex).toBe(before.rehypeKatex);
    expect(loads.dompurify).toBe(before.dompurify);
  });

  it('math obsah naštartuje remark-math + rehype-katex (a len ich)', async () => {
    const before = { ...loads };
    render(<RichContent content={'energia $$E = mc^2$$ tu'} />);
    await waitFor(() => expect(loads.remarkMath).toBeGreaterThan(before.remarkMath));
    expect(loads.rehypeKatex).toBeGreaterThan(before.rehypeKatex);
    expect(loads.mermaid).toBe(before.mermaid);
  });

  it('mermaid zárez naštartuje mermaid + dompurify (a len ich)', async () => {
    const before = { ...loads };
    render(<RichContent content={'```mermaid\ngraph TD\n  A-->B\n```'} />);
    await waitFor(() => expect(loads.mermaid).toBeGreaterThan(before.mermaid));
    expect(loads.dompurify).toBeGreaterThan(before.dompurify);
    expect(loads.remarkMath).toBe(before.remarkMath);
  });

  it('chart zárez nespustí mermaid (chart renderer je vlastný modul)', async () => {
    const before = { ...loads };
    render(<RichContent content={'```chart\n{"v":1,"type":"line","series":[{"name":"a","data":[1]}]}\n```'} />);
    await waitFor(() => expect(document.body).toBeTruthy());
    expect(loads.mermaid).toBe(before.mermaid);
    expect(loads.remarkMath).toBe(before.remarkMath);
  });
});
