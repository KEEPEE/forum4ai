/**
 * `preparePaper` (Phase 4b) — číslovanie sekcií/obrázkov/tabuliek/rovníc,
 * krížové odkazy a citácie. Testujeme na fixture tele (`PAPER_BODY`), ktoré
 * zámerné obsahuje nevyriešený `@fig:ghost` a `[@ghost1999]`.
 *
 * Popisky sú v SK, lebo testy renderujú v slovenčine (`test/setup.ts`) —
 * link texty sa vypaľujú do markdownu, preto sú súčasťou kontraktu.
 */
import { describe, expect, it } from 'vitest';

import { FALLBACK_LABELS, parseTableCaption, preparePaper } from '../src/lib/paper-render.js';
import { PAPER_BODY, PAPER_CSL } from './fixtures.js';

const SK = { figure: 'Obrázok', table: 'Tabuľka', equation: 'Rovnica' };

describe('preparePaper — index', () => {
  const { index } = preparePaper(PAPER_BODY, SK);

  it('čísla obrázky v poradí deklarácií (zhodné s lint XREF_UNKNOWN)', () => {
    expect(index.figures.get('arch')).toMatchObject({ num: 1, caption: 'Replication stack' });
    expect(index.figures.get('latency')).toMatchObject({ num: 2, caption: 'Latency distribution' });
    expect(index.figures.has('ghost')).toBe(false);
  });

  it('čísla tabuľku z `Table: … {#tbl:x}` a rovnicu z `{#eq:x}`', () => {
    expect(index.tables.get('results')).toMatchObject({ num: 1, caption: 'Latency per hop' });
    expect(index.equations.get('latency')).toMatchObject({ num: 1 });
  });

  it('citácie majú číslo v poradí prvej citácie a počet výskytov', () => {
    expect([...index.citations.keys()]).toEqual(['novak2026', 'chen2025', 'halvorsen2024']);
    expect(index.citations.get('novak2026')).toMatchObject({ num: 1, count: 2 });
    expect(index.citations.get('chen2025')).toMatchObject({ num: 2, count: 1 });
    expect(index.citations.get('halvorsen2024')).toMatchObject({ num: 3, count: 1 });
    // nevyriešená citácia NIE je v číselníku (nemá CSL položku)
    expect(index.citations.has('ghost1999')).toBe(false);
    expect(index.citationOrder).toEqual(['novak2026', 'chen2025', 'halvorsen2024', 'ghost1999']);
  });

  it('titulok citácie z CSL položky (hover)', () => {
    expect(index.citations.get('novak2026')?.title).toBe(
      'Novakova — Negentropy Replication of Gated Nostr Forums (2026)',
    );
    // `literal` autor sa berie ako cele meno
    expect(index.citations.get('chen2025')?.title).toBe('Chen, Wei — Gossip Sets at the Edge (2025)');
  });

  it('referencie: citované v poradí citácií, necitované na konci; čísla = čísla citácií', () => {
    expect(index.references.map((entry) => [entry.num, entry.key, entry.citedBy])).toEqual([
      [1, 'novak2026', 2],
      [2, 'chen2025', 1],
      [3, 'halvorsen2024', 1],
      [4, 'uncited2023', 0],
    ]);
    expect(index.referencesParsed?.map((item) => item.id)).toEqual(PAPER_CSL.map((item) => item.id));
  });
});

describe('preparePaper — markdown', () => {
  const { content } = preparePaper(PAPER_BODY, SK);

  it('číslovanie sekcií: najplytčšia prítomná úroveň je 1', () => {
    expect(content).toContain('## 1. Introduction');
    expect(content).toContain('### 1.1 Method');
    expect(content).toContain('## 2. Results');
  });

  it('`references` zárez zmizne z teľa (nie je to code block)', () => {
    expect(content).not.toContain('```references');
    expect(content).not.toContain('"container-title"');
  });

  it('rovnica sa emituje ako `equation` zárez s id a číslom', () => {
    expect(content).toContain('```equation id=latency num=1');
    expect(content).toContain('L = \\sum_{i=1}^{n} d_i');
  });

  it('krížové odkazy → číslovaný interný odkaz s popisom v titulku', () => {
    expect(content).toContain('[Obrázok 1](#fig:arch "Replication stack")');
    expect(content).toContain('[Tabuľka 1](#tbl:results "Latency per hop")');
    expect(content).toContain('[Rovnica 1](#eq:latency)');
  });

  it('nevyriešený krížový odkaz zostane viditeľný (marker pre XREF_UNKNOWN)', () => {
    expect(content).toContain('[@fig:ghost](#xref-unknown:fig:ghost)');
  });

  it('citácie → číslovaný odkaz do referencií; skupina `[@a; @b]` rozpálená na dve', () => {
    expect(content).toContain('[1](#ref:novak2026 "Novakova — Negentropy Replication of Gated Nostr Forums (2026)")');
    expect(content).toContain('[2](#ref:chen2025');
    expect(content).toContain('[3](#ref:halvorsen2024');
    expect(content).toContain('[@ghost1999](#cite-unknown:ghost1999)');
  });

  it('druhý výskyt rovnakej citácie dostane TO ISTÉ číslo', () => {
    const results = content.slice(content.indexOf('## 2. Results'));
    expect(results).toContain('[1](#ref:novak2026');
  });

  it('popisek tabuľky ostáva textový riadok (renderer z neho urobí kotvu)', () => {
    expect(content).toContain('Table: Latency per hop {#tbl:results}');
  });

  it('mermaid/chart zárez sa nemení (renderer kreslí popisek s číslom)', () => {
    expect(content).toContain('```mermaid fig=arch caption="Replication stack"');
    expect(content).toContain('```chart fig=latency caption="Latency distribution"');
  });
});

describe('preparePaper — okrajové prípady', () => {
  it('papier bez referencií: index prázdny, telo bez zmien odkazov', () => {
    const { index, content } = preparePaper('## Intro\n\nText without refs.', FALLBACK_LABELS);
    expect(index.references).toEqual([]);
    expect(index.referencesParsed).toBeNull();
    expect(content).toContain('## 1. Intro');
  });

  it('h1 dokument sa čísluje od 1., nie od 1.1', () => {
    const { content } = preparePaper('# Title\n\n## A\n\n### A1\n\n## B');
    expect(content).toContain('# 1. Title');
    expect(content).toContain('## 1.1 A');
    expect(content).toContain('### 1.1.1 A1');
    expect(content).toContain('## 1.2 B');
  });

  it('nevyriešená rovnica (`{#eq:x}` bez deklarácie) sa nemeoní na zárez', () => {
    // deklarácia chýba, lebo `collectDeclaredRefs` ju síce vidí, ale
    // `$$` blok bez platného id sa nemeoní — tu testujeme pár id/číslo
    const { content } = preparePaper('## S\n\n$$ a = b $$ {#eq:one}\n\nMore @eq:one text.');
    expect(content).toContain('```equation id=one num=1');
    expect(content).toContain('[Equation 1](#eq:one)');
  });

  it('citácia v inline kóde sa nenahrádza', () => {
    const { content } = preparePaper('## S\n\nUse `[@novak2026]` syntax for citations.', FALLBACK_LABELS);
    expect(content).toContain('`[@novak2026]`');
    expect(content).not.toContain('#ref:novak2026');
  });

  it('skupina s dodatkovým textom si text ponechá', () => {
    const { content } = preparePaper(
      '## S\n\nSee [@novak2026, p. 12].\n\n```references\n[{"id":"novak2026","type":"book","title":"T"}]\n```',
    );
    expect(content).toContain('See [1](#ref:novak2026 "T"), p. 12.');
  });
});

describe('parseTableCaption', () => {
  it('rozpozná platný popisek', () => {
    expect(parseTableCaption('Table: Latency per hop {#tbl:results}')).toEqual({
      id: 'results',
      caption: 'Latency per hop',
    });
  });

  it('odmietne riadok bez `{#tbl:}` alebo s textom navyše', () => {
    expect(parseTableCaption('Table: no anchor')).toBeNull();
    expect(parseTableCaption('paragraph mentioning Table: x {#tbl:y} inline')).toBeNull();
  });
});
