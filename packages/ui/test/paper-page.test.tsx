/**
 * PaperPage `/paper/:id` a `/paper/:pubkey/:d` (Phase 4b).
 *
 * Testuje to, čo UI pridáva nad dátami gatewaya: číslovanie sekcií,
 * číslované popisky obrázkov/tabuliek/rovníc, krížové odkazy a ich
 * nevyriešené markery, citácie → Referencie s back-odkazom, lokálne
 * copy lint varovaní (nikdy veta gatewaya) a klientsky export.
 *
 * Testy bežia v SK (`test/setup.ts`), preto copy očíravame slovenskými
 * reťazcami a testidami. Projekt nepoužíva jest-dom matchery — tvrdé
 * asertácie idú cez `textContent` / `getAttribute` (rovnaké ako zvyšok
 * suite).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderApp } from './render.js';
import {
  COAUTHOR_PUBKEY,
  PAPER_ADDR,
  PAPER_BODY,
  PAPER_ID,
  SAMPLE_PAPER_DETAIL,
  SAMPLE_VOUCHES,
  TEST_PUBKEY,
  stubApi,
} from './fixtures.js';
import { ApiError } from '../src/api/client.js';

// mermaid potrebuje layout + d3; tu nás zaujíma popisek a kotva, nie SVG
vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    render: async () => ({ svg: '<svg data-fake="mermaid"><g><text>diagram</text></g></svg>' }),
  },
}));

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:forum4ai/paper') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

const text = (node: Element | null | undefined): string => node?.textContent ?? '';

async function renderPaper(route = `/paper/${PAPER_ID}`): Promise<void> {
  renderApp({ api: stubApi({ recent: async () => SAMPLE_VOUCHES }), route });
  await waitFor(() => expect(screen.getByTestId('paper-page')).toBeTruthy());
}

/** stiahnuté súbory: `download` atribút anchora v momente kliku */
function captureDownloads(): { names: string[]; restore: () => void } {
  const names: string[] = [];
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download !== '') names.push(this.download);
  };
  return { names, restore: () => (HTMLAnchorElement.prototype.click = original) };
}

describe('PaperPage — hlavička a autori', () => {
  it('nakreslí názov, jazykový štítok a metadáta (verzia, licencia, DOI, adresa)', async () => {
    await renderPaper();
    expect(text(screen.getByTestId('paper-title'))).toContain('Negentropy Replication of Gated Nostr Forums');
    // papier je `en`, rozhranie `sk` → štítok jazyka sa ukáže (2b2)
    expect(text(screen.getByTestId('paper-lang'))).toBe('EN');
    expect(text(screen.getByTestId('paper-version'))).toContain('Verzia v1');
    expect(text(screen.getByTestId('paper-license'))).toContain('CC-BY-4.0');
    expect(screen.getByTestId('doi-link').getAttribute('href')).toBe('https://doi.org/10.5281/zenodo.1234567');
    expect(text(screen.getByTestId('paper-address'))).toContain(PAPER_ADDR);
  });

  it('autor má afiliáciu, ORCID odkaz a pubkey chip', async () => {
    await renderPaper();
    const rows = within(screen.getByTestId('paper-authors')).getAllByTestId('author-row');
    expect(rows).toHaveLength(2);
    expect(text(rows[0])).toContain('Jana Novakova');
    expect(text(rows[0])).toContain('Comenius University');
    expect(within(rows[0] as HTMLElement).getByTestId('orcid-link').getAttribute('href')).toBe(
      'https://orcid.org/0000-0002-1825-0097',
    );
    const links = within(rows[0] as HTMLElement).getAllByRole('link');
    expect(links.some((a) => a.getAttribute('href') === `/agents/${TEST_PUBKEY}`)).toBe(true);
  });

  it('štítok spoluautora: 1054 VOUCH z toho istého pubkey = potvrdený, inak neutrálny', async () => {
    await renderPaper();
    const badges = screen.getAllByTestId('coauthor-badge');
    expect(badges).toHaveLength(2);
    // VOUCH v fixture je od COAUTHOR_PUBKEY → druhý autor potvrdený
    expect(text(badges[0])).toContain('spoluautor, potvrdenie čaká');
    expect(badges[0]?.getAttribute('data-confirmed')).toBe('no');
    expect(text(badges[1])).toContain('potvrdený spoluautor');
    expect(badges[1]?.getAttribute('data-confirmed')).toBe('yes');
  });

  it('bez VOUChov sú oba štítky neutrálne (potvrdenie netvrdíme bez dôkazu)', async () => {
    renderApp({ api: stubApi({ recent: async () => ({ ...SAMPLE_VOUCHES, items: [] }) }), route: `/paper/${PAPER_ID}` });
    await waitFor(() => expect(screen.getByTestId('paper-page')).toBeTruthy());
    for (const badge of screen.getAllByTestId('coauthor-badge')) {
      expect(badge.getAttribute('data-confirmed')).toBe('no');
    }
  });

  it('abstrakt a topic chip odkazujúci na /topics/:slug', async () => {
    await renderPaper();
    expect(text(screen.getByTestId('paper-abstract'))).toContain(
      'We replicate gated nostr forums with negentropy sets.',
    );
    expect(screen.getByRole('link', { name: '#distributed-systems' }).getAttribute('href')).toBe(
      '/topics/distributed-systems',
    );
  });
});

describe('PaperPage — číslovanie, krížové odkazy, citácie', () => {
  it('sekcie sú číslované (1., 1.1) a `references` zárez nie je code block', async () => {
    await renderPaper();
    const body = screen.getByTestId('paper-body');
    expect(within(body).getByRole('heading', { name: '1. Introduction', level: 2 })).toBeTruthy();
    expect(within(body).getByRole('heading', { name: '1.1 Method', level: 3 })).toBeTruthy();
    expect(within(body).getByRole('heading', { name: '2. Results', level: 2 })).toBeTruthy();
    // žiadny code block s CSL JSON — referencie sú samostatná sekcia
    expect(text(body)).not.toContain('"container-title"');
  });

  it('obrázok má číslovaný popisek a kotvu; graf je druhý', async () => {
    await renderPaper();
    const figures = screen.getAllByTestId('figure-caption');
    expect(text(figures[0])).toContain('Obrázok 1 — Replication stack');
    expect(text(figures[1])).toContain('Obrázok 2 — Latency distribution');
    expect(document.getElementById('fig:arch')).toBeTruthy();
  });

  it('tabuľka má číslovaný popisek s kotvou', async () => {
    await renderPaper();
    const caption = screen.getByTestId('table-caption');
    expect(text(caption)).toContain('Tabuľka 1 — Latency per hop');
    expect(caption.getAttribute('id')).toBe('tbl:results');
  });

  it('rovnica je KaTeX s číslom (1) a kotvou', async () => {
    await renderPaper();
    const block = screen.getByTestId('equation-block');
    expect(block.getAttribute('id')).toBe('eq:latency');
    expect(text(screen.getByTestId('equation-number'))).toBe('(1)');
    await waitFor(() => expect(block.querySelector('.katex')).toBeTruthy());
  });

  it('krížové odkazy sú interné odkazy s popisom v titulku (bez nového tabu)', async () => {
    await renderPaper();
    const fig = screen.getAllByTestId('xref').find((node) => node.getAttribute('href') === '#fig:arch');
    expect(fig).toBeTruthy();
    expect(text(fig)).toContain('Obrázok 1');
    expect(fig?.getAttribute('title')).toBe('Replication stack');
    expect(fig?.getAttribute('target')).toBeNull();
  });

  it('nevyriešený @fig:ghost zostane viditeľný (marker, nie tichá strata)', async () => {
    await renderPaper();
    const marker = screen.getByTestId('xref-unknown');
    expect(text(marker)).toContain('@fig:ghost');
    expect(marker.getAttribute('title')).toBe('Nevyriešený krížový odkaz na fig:ghost');
  });

  it('citácie sú superskript čísla; nevyriešená `[@ghost1999]` je marker', async () => {
    await renderPaper();
    const cites = screen.getAllByTestId('citation');
    expect(text(cites[0])).toBe('1');
    expect(cites[0]?.tagName.toLowerCase()).toBe('sup');
    // prvý výskyt nesie kotvu, na ktorú sa viaže back-link z referencie
    expect(cites[0]?.getAttribute('id')).toBe('cite:novak2026');
    const unknown = screen.getByTestId('citation-unknown');
    expect(text(unknown)).toContain('@ghost1999');
    expect(unknown.getAttribute('title')).toBe('Citovaný kľúč ghost1999 nie je v referenciách');
  });

  it('referencie: citované v poradí citácií, necitovaná posledná, back-link „citované na N“', async () => {
    await renderPaper();
    const entries = within(screen.getByTestId('paper-references')).getAllByTestId('reference-entry');
    expect(entries.map((node) => node.getAttribute('id'))).toEqual([
      'ref:novak2026',
      'ref:chen2025',
      'ref:halvorsen2024',
      'ref:uncited2023',
    ]);
    expect(text(entries[0])).toContain('[1]');
    expect(text(entries[0])).toContain('Novakova, J. (2026)');
    expect(text(entries[3])).toContain('[4]');
    const backlink = within(entries[0] as HTMLElement).getByTestId('reference-backlink');
    expect(text(backlink)).toContain('citované na 2 miestach');
    expect(backlink.getAttribute('href')).toBe('#cite:novak2026');
    // necitovaná referencia nemá back-link
    expect(within(entries[3] as HTMLElement).queryByTestId('reference-backlink')).toBeNull();
  });
});

describe('PaperPage — lint banner a export', () => {
  it('banner varovaní skladá copy z locale podľa kódu (nie vetu gatewaya)', async () => {
    await renderPaper();
    const banner = screen.getByTestId('paper-lint-banner');
    const codes = within(banner).getAllByTestId('lint-code').map((node) => node.getAttribute('data-code'));
    expect(codes).toEqual(['CITE_UNKNOWN', 'REF_UNCITED', 'XREF_UNKNOWN']);
    expect(within(banner).getByText('Citovaný kľúč nie je v referenciách.')).toBeTruthy();
    // veta gatewaya sa v UI neobjaví ako finálny text
    expect(text(banner)).not.toContain('has no matching reference entry');
  });

  it('chyby lintu sa ukážou tiež (errors + codes)', async () => {
    const api = stubApi({
      recent: async () => SAMPLE_VOUCHES,
      paper: async () => ({
        ...SAMPLE_PAPER_DETAIL,
        lint: {
          ok: false,
          errors: ['paper requires a title tag'],
          codes: ['PAPER_TITLE_REQUIRED'],
          warnings: [],
          warning_codes: [],
        },
      }),
    });
    renderApp({ api, route: `/paper/${PAPER_ID}` });
    await waitFor(() => expect(screen.getByTestId('paper-lint-banner')).toBeTruthy());
    expect(text(screen.getByTestId('paper-lint-errors'))).toContain('Papier nemá názov.');
  });

  it('export BibTeX stiahne .bib v poradí citácií', async () => {
    await renderPaper();
    const downloads = captureDownloads();
    try {
      fireEvent.click(screen.getByTestId('export-bibtex'));
      expect(downloads.names).toEqual(['negentropy-replication.bib']);
      const calls = (URL.createObjectURL as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const blob = calls[calls.length - 1]?.[0] as Blob | undefined;
      expect(blob).toBeInstanceOf(Blob);
      const bib = await (blob as Blob).text();
      expect(bib).toContain('@article{novak2026,');
      expect(bib).toContain('@book{halvorsen2024,');
      // poradie záznamov = poradie citácií (1..4), nie abeceda
      expect(bib.indexOf('@article{novak2026')).toBeLessThan(bib.indexOf('@techreport{uncited2023'));
    } finally {
      downloads.restore();
    }
  });

  it('export APA stiahne .txt číslovaný podľa referencií', async () => {
    await renderPaper();
    const downloads = captureDownloads();
    try {
      fireEvent.click(screen.getByTestId('export-apa'));
      expect(downloads.names).toEqual(['negentropy-replication.txt']);
    } finally {
      downloads.restore();
    }
  });

  it('tlačidlá exportu sú disabled bez referencií', async () => {
    const api = stubApi({
      recent: async () => SAMPLE_VOUCHES,
      paper: async () => ({
        ...SAMPLE_PAPER_DETAIL,
        // telo bez ` ```references ` zárezu → žiadne číslované citácie
        event: { ...SAMPLE_PAPER_DETAIL.event, content: PAPER_BODY.split('```references')[0] ?? '' },
        paper: { ...SAMPLE_PAPER_DETAIL.paper, references: null },
      }),
    });
    renderApp({ api, route: `/paper/${PAPER_ID}` });
    await waitFor(() => expect(screen.getByTestId('paper-page')).toBeTruthy());
    expect((screen.getByTestId('export-bibtex') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('export-apa') as HTMLButtonElement).disabled).toBe(true);
    expect(text(screen.getByTestId('paper-references'))).toContain(
      'Práca cituje kľúče, ale nemá čitateľnú sekciu referencií.',
    );
  });

  it('tlačidlo Tlačiť volá window.print', async () => {
    const print = vi.fn();
    Object.defineProperty(window, 'print', { value: print, writable: true, configurable: true });
    await renderPaper();
    fireEvent.click(screen.getByTestId('paper-print'));
    expect(print).toHaveBeenCalledTimes(1);
  });
});

describe('PaperPage — routy a stavy', () => {
  it('`/paper/:id` volá GET /papers/:id', async () => {
    const api = stubApi({ recent: async () => SAMPLE_VOUCHES });
    renderApp({ api, route: `/paper/${PAPER_ID}` });
    await waitFor(() => expect(screen.getByTestId('paper-page')).toBeTruthy());
    expect(api.paper).toHaveBeenCalledWith(PAPER_ID);
    expect(api.paperByAddress).not.toHaveBeenCalled();
  });

  it('`/paper/:pubkey/:d` volá adresu a ukáže ju', async () => {
    const api = stubApi({ recent: async () => SAMPLE_VOUCHES });
    renderApp({ api, route: `/paper/${TEST_PUBKEY}/negentropy-replication` });
    await waitFor(() => expect(screen.getByTestId('paper-page')).toBeTruthy());
    expect(api.paperByAddress).toHaveBeenCalledWith(TEST_PUBKEY, 'negentropy-replication');
    expect(text(screen.getByTestId('paper-address'))).toContain(PAPER_ADDR);
  });

  it('404 z gatewaya → lokálna veta „nie je v indexe“', async () => {
    const api = stubApi({
      recent: async () => SAMPLE_VOUCHES,
      paper: async () => {
        throw new ApiError('paper not found', 404, { ok: false, error: 'paper not found' }, '/papers/x');
      },
    });
    renderApp({ api, route: `/paper/${PAPER_ID}` });
    await waitFor(() => expect(screen.getByTestId('state-empty')).toBeTruthy());
    expect(text(screen.getByTestId('state-empty'))).toContain('Tento papier nie je v indexe.');
  });

  it('VOUCHe sa pýtajú na kind 1054 (kvôli štítkom spoluautorov)', async () => {
    const api = stubApi({ recent: async () => SAMPLE_VOUCHES });
    renderApp({ api, route: `/paper/${PAPER_ID}` });
    await waitFor(() => expect(screen.getByTestId('paper-page')).toBeTruthy());
    expect(api.recent).toHaveBeenCalledWith({ kinds: [1054], limit: 100 });
  });

  it('zlyhanie /recent nepadá — štítky len ostanú neutrálne', async () => {
    const api = stubApi({
      recent: async () => {
        throw new ApiError('index unavailable', 503, { ok: false, error: 'index unavailable' }, '/recent');
      },
    });
    renderApp({ api, route: `/paper/${PAPER_ID}` });
    await waitFor(() => expect(screen.getByTestId('paper-page')).toBeTruthy());
    expect(screen.getAllByTestId('coauthor-badge').every((b) => b.getAttribute('data-confirmed') === 'no')).toBe(true);
  });

  it('fixture je konzistentná: COAUTHOR pubkey je 64-hex a detail sedí s boardom', async () => {
    await renderPaper();
    expect(COAUTHOR_PUBKEY).toHaveLength(64);
    expect(SAMPLE_PAPER_DETAIL.id).toBe(PAPER_ID);
  });
});
