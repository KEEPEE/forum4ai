/**
 * PaperBoard `/papers` (Phase 4b) — list z `GET /papers` + filtre žijúce
 * v URL (topic, q, lang). Testuje volanie klienta KVÔLI parametrov a
 * lokálne triedenie jazyka `other` (rovnaká dohoda ako SearchPage).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderApp } from './render.js';
import { PAPER_ID, SAMPLE_PAPERS, stubApi } from './fixtures.js';
import { ApiError } from '../src/api/client.js';

const text = (node: Element | null | undefined): string => node?.textContent ?? '';

async function renderBoard(route = '/papers', api = stubApi()): Promise<typeof api> {
  renderApp({ api, route });
  await waitFor(() => expect(screen.getByTestId('paper-board')).toBeTruthy());
  return api;
}

describe('PaperBoardPage — list', () => {
  it('nakreslí karty s odkazom na detail, autorov a veľkosť teľa', async () => {
    await renderBoard();
    const cards = screen.getAllByTestId('paper-card');
    expect(cards).toHaveLength(2);
    const first = within(cards[0] as HTMLElement);
    expect(text(first.getByTestId('paper-card-link'))).toBe('Negentropy Replication of Gated Nostr Forums');
    expect(first.getByTestId('paper-card-link').getAttribute('href')).toBe(`/paper/${PAPER_ID}`);
    expect(text(first.getByTestId('paper-card-authors'))).toContain('Jana Novakova');
    expect(text(first.getByTestId('paper-card-authors'))).toContain('Wei Chen');
    expect(text(first.getByTestId('paper-card-size'))).toContain('kB');
    expect(text(cards[0] as Element)).toContain('We replicate gated nostr forums');
  });

  it('jazykový štítok ukáže len jazyk odlišný od rozhrania (2b2)', async () => {
    await renderBoard();
    const cards = screen.getAllByTestId('paper-card');
    // rozhranie je `sk` → `en` papier štítok má, `sk` papier nie
    expect(text(cards[0] as Element)).toContain('EN');
    expect(text(cards[1] as Element)).not.toContain('SK');
  });

  it('počet výsledkov a odkaz na editor', async () => {
    await renderBoard();
    expect(text(screen.getByTestId('paper-count'))).toContain('2 papiere');
    expect(screen.getByTestId('new-paper-link').getAttribute('href')).toBe('/write-paper');
  });

  it('prázdny board nie je chyba — len empty stav', async () => {
    const api = stubApi({ papers: async () => ({ ...SAMPLE_PAPERS, items: [], count: 0 }) });
    await renderBoard('/papers', api);
    expect(text(screen.getByTestId('state-empty'))).toContain('Týmto filtrom zatiaľ neodpovedá žiadny papier.');
  });

  it('chyba gatewaya sa dá zopakovať', async () => {
    let fail = true;
    const api = stubApi({
      papers: async () => {
        if (fail) throw new ApiError('index unavailable', 503, { ok: false, error: 'index unavailable' }, '/papers');
        return SAMPLE_PAPERS;
      },
    });
    await renderBoard('/papers', api);
    await waitFor(() => expect(screen.getByTestId('state-error')).toBeTruthy());
    fail = false;
    const retry = document.querySelector('.retry-btn');
    expect(retry).toBeTruthy();
    fireEvent.click(retry as Element);
    await waitFor(() => expect(screen.getAllByTestId('paper-card').length).toBe(2));
  });
});

describe('PaperBoardPage — filtre', () => {
  it('q a topic idú do `GET /papers` (submit formulára, nie klávesa)', async () => {
    const api = await renderBoard();
    expect(api.papers).toHaveBeenLastCalledWith({ limit: 50 });

    fireEvent.change(screen.getByTestId('paper-filter-q'), { target: { value: 'negentropy' } });
    fireEvent.change(screen.getByTestId('paper-filter-topic'), { target: { value: 'distributed-systems' } });
    fireEvent.click(screen.getByTestId('paper-filter-submit'));

    expect(api.papers).toHaveBeenLastCalledWith({ limit: 50, q: 'negentropy', topic: 'distributed-systems' });
    // filter je v URL → zdieľateľný odkaz
    expect(window.location.search).toBe('');
  });

  it('jazykový filter posieta serveru presný kód (kód rozhrania je volba `ui`)', async () => {
    // stub filtruje ako gateway, aby test videl aj výsledok filtra
    const api = stubApi({
      papers: async (params) => {
        const items = SAMPLE_PAPERS.items.filter((row) => params?.lang === undefined || row.lang === params.lang);
        return { ...SAMPLE_PAPERS, items, count: items.length };
      },
    });
    await renderBoard('/papers', api);
    fireEvent.change(screen.getByTestId('paper-filter-lang'), { target: { value: 'en' } });
    await waitFor(() => expect(api.papers).toHaveBeenLastCalledWith({ limit: 50, lang: 'en' }));
    expect(screen.getAllByTestId('paper-card')).toHaveLength(1);

    fireEvent.change(screen.getByTestId('paper-filter-lang'), { target: { value: 'ui' } });
    await waitFor(() => expect(api.papers).toHaveBeenLastCalledWith({ limit: 50, lang: 'sk' }));
    expect(screen.getAllByTestId('paper-card')).toHaveLength(1);
  });

  it('`other` sa triedi lokálne (server pozná len presný `?lang=`)', async () => {
    const api = await renderBoard('/papers?lang=other');
    expect(api.papers).toHaveBeenLastCalledWith({ limit: 50 });
    const cards = screen.getAllByTestId('paper-card');
    expect(cards).toHaveLength(1);
    expect(text(cards[0] as Element)).toContain('Negentropy Replication');
  });

  it('filter z URL sa aplikuje pri prvom volaní a zobrazený input ho zrkadlí', async () => {
    const api = await renderBoard('/papers?topic=machine-learning&q=model');
    expect(api.papers).toHaveBeenLastCalledWith({ limit: 50, topic: 'machine-learning', q: 'model' });
    expect((screen.getByTestId('paper-filter-topic') as HTMLInputElement).value).toBe('machine-learning');
  });

  it('tlačidlo „zrušiť filtre“ vymaže URL aj dotazy na filter', async () => {
    const api = await renderBoard('/papers?topic=distributed-systems');
    fireEvent.click(screen.getByTestId('paper-filter-clear'));
    await waitFor(() => expect(api.papers).toHaveBeenLastCalledWith({ limit: 50 }));
    expect(screen.queryByTestId('paper-filter-clear')).toBeNull();
  });
});
