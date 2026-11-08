/**
 * Export referencií (Phase 4b): CSL-JSON → BibTeX a APA. Testuje PRESNÝ
 * výstup čistých funkcií — to je kontrakt, ktorý si používateľ stiahne.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bareDoi,
  bareOrcid,
  bibkey,
  cslToApa,
  cslToApaLine,
  cslToBibEntry,
  cslToBibTeX,
  cslYear,
  downloadTextFile,
  type PaperExportEntry,
} from '../src/lib/paper-export.js';
import type { CslItem } from '@forum4ai/shared/paper';

const ARTICLE: CslItem = {
  id: 'novak2026',
  type: 'article-journal',
  title: 'Negentropy Replication',
  author: [
    { family: 'Novakova', given: 'Jana' },
    { family: 'Berg', given: 'Ola' },
  ],
  issued: { 'date-parts': [[2026, 3, 1]] },
  'container-title': 'Journal of Replicated Sets',
  DOI: '10.5281/zenodo.1234567',
};

const CONF: CslItem = {
  id: 'chen2025',
  type: 'paper-conference',
  title: 'Gossip Sets at the Edge',
  author: [{ literal: 'Chen, Wei' }],
  issued: { 'date-parts': [[2025]] },
  'container-title': 'Proc. Nostr Symposium',
};

const BOOK: CslItem = {
  id: 'halvorsen2024',
  type: 'book',
  title: 'Signed Data Systems',
  author: [{ family: 'Halvorsen', given: 'Ingrid Marie' }],
  issued: { 'date-parts': [[2024]] },
};

const REPORT: CslItem = {
  id: 'survey2023',
  type: 'report',
  title: 'Relay Capacity Survey',
  author: [{ family: 'Berg', given: 'Ola' }],
  URL: 'https://example.org/survey',
};

const entry = (item: CslItem, num: number): PaperExportEntry => ({ key: item.id, num, item });

describe('cslYear / bibkey / bareDoi / bareOrcid', () => {
  it('rok je len rok z date-parts', () => {
    expect(cslYear(ARTICLE)).toBe('2026');
    expect(cslYear(BOOK)).toBe('2024');
    expect(cslYear(REPORT)).toBeNull();
    expect(cslYear({ id: 'x', type: 'misc', issued: { 'date-parts': [[]] } })).toBeNull();
  });

  it('bibkey sanitizuje neplatné znaky', () => {
    expect(bibkey('novak2026')).toBe('novak2026');
    expect(bibkey('a b/c')).toBe('a_b_c');
    expect(bibkey('')).toBe('ref');
  });

  it('DOI a ORCID sa orezávajú z URL na identifikátor', () => {
    expect(bareDoi('https://doi.org/10.5281/zenodo.1234567')).toBe('10.5281/zenodo.1234567');
    expect(bareDoi('10.5281/zenodo.1234567')).toBe('10.5281/zenodo.1234567');
    expect(bareOrcid('https://orcid.org/0000-0002-1825-0097')).toBe('0000-0002-1825-0097');
    expect(bareOrcid('0000-0002-1825-0097')).toBe('0000-0002-1825-0097');
  });
});

describe('cslToBibTeX', () => {
  it('article-journal → @article s journal/doi/url', () => {
    const bib = cslToBibTeX([entry(ARTICLE, 1)]);
    expect(bib).toBe(
      [
        '@article{novak2026,',
        '  author = {Novakova, Jana and Berg, Ola},',
        '  title = {Negentropy Replication},',
        '  year = {2026},',
        '  journal = {Journal of Replicated Sets},',
        '  doi = {10.5281/zenodo.1234567},',
        '  url = {https://doi.org/10.5281/zenodo.1234567}',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('paper-conference → @inproceedings s booktitle; literal autor bez premenovania', () => {
    const bib = cslToBibEntry(entry(CONF, 2));
    expect(bib).toContain('@inproceedings{chen2025,');
    expect(bib).toContain('  author = {Chen, Wei},');
    expect(bib).toContain('  booktitle = {Proc. Nostr Symposium}');
  });

  it('book → @book bez container poľa; report → @techreport s institution', () => {
    const book = cslToBibEntry(entry(BOOK, 3));
    expect(book).toContain('@book{halvorsen2024,');
    expect(book).not.toContain('journal');
    const report = cslToBibEntry(entry(REPORT, 4));
    expect(report).toContain('@techreport{survey2023,');
    expect(report).toContain('  url = {https://example.org/survey}');
    expect(report).not.toContain('year =');
  });

  it('neznámý CSL typ padá na @misc', () => {
    expect(cslToBibEntry(entry({ id: 'x', type: 'podcast' }, 1))).toContain('@misc{x,');
  });

  it('kolízia kľúčov sa rieši príponou -<num> (výstup zostane parsovateľný)', () => {
    const dup: CslItem = { id: 'novak2026', type: 'misc', title: 'Second' };
    const bib = cslToBibTeX([entry(ARTICLE, 1), entry(dup, 2)]);
    expect(bib).toContain('@article{novak2026,');
    expect(bib).toContain('@misc{novak2026-2,');
  });

  it('prázdny zoznam nevygeneruje ani newline', () => {
    expect(cslToBibTeX([])).toBe('');
  });
});

describe('cslToApaLine / cslToApa', () => {
  it('APA-ish veta s iniciálami, rokom, kontajnerom a DOI', () => {
    expect(cslToApaLine(ARTICLE)).toBe(
      'Novakova, J., & Berg, O. (2026). Negentropy Replication. Journal of Replicated Sets. https://doi.org/10.5281/zenodo.1234567',
    );
  });

  it('iniciály viacerých mien: `Ingrid Marie` → `I. M.`', () => {
    expect(cslToApaLine(BOOK)).toBe('Halvorsen, I. M. (2024). Signed Data Systems.');
  });

  it('bez roku → n.d.; literal autor sa preberá ako cele meno', () => {
    expect(cslToApaLine(CONF)).toBe('Chen, Wei. (2025). Gossip Sets at the Edge. Proc. Nostr Symposium.');
    expect(cslToApaLine(REPORT)).toBe('Berg, O. (n.d.). Relay Capacity Survey. https://example.org/survey');
  });

  it('export .txt číslova `[N]` podľa čísel v References', () => {
    const txt = cslToApa([entry(ARTICLE, 1), entry(BOOK, 3)]);
    expect(txt.split('\n')[0]).toBe(
      '[1] Novakova, J., & Berg, O. (2026). Negentropy Replication. Journal of Replicated Sets. https://doi.org/10.5281/zenodo.1234567',
    );
    expect(txt).toContain('[3] Halvorsen, I. M. (2024). Signed Data Systems.');
    expect(cslToApa([])).toBe('');
  });
});

describe('downloadTextFile', () => {
  beforeAll(() => {
    // jsdom nemá Blob URL — stub stačí, testuje sa že helper volá create/
    // revoke a nastaví `download` na `<a>`
    URL.createObjectURL = vi.fn(() => 'blob:forum4ai/test') as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('vytvorí Blob, klikne na anchor s príponou a uvoľní URL', () => {
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });

    downloadTextFile('paper.bib', '@misc{a,\n}\n', 'application/x-bibtex');

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('paper.bib');
    expect(clicked[0]?.href).toBe('blob:forum4ai/test');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:forum4ai/test');
  });
});
