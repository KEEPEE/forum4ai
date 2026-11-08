/**
 * F4AI-2b2: štítok jazyka (NIP-32) a filter jazyka v UI.
 *
 * Testy renderujú v SK (`test/setup.ts` → `lng: 'sk'`), takže pravidlo
 * "cudzí jazyk ≠ jazyk rozhrania" je tu priamo merateľné: `en` štítok
 * má, `sk` nie.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { renderApp, renderWithProviders } from './render.js';
import { EventCard } from '../src/components/EventCard.js';
import { TEST_PUBKEY, stubApi } from './fixtures.js';
import type { EventSummary, SearchResponse } from '../src/api/types.js';

function card(tags: string[][]): EventSummary {
  return {
    id: 'a'.repeat(64),
    pubkey: TEST_PUBKEY,
    created_at: 1_793_200_000,
    kind: 1020,
    tags,
    content: '# Otázka\n\ntelo',
    sig: 's'.repeat(128),
  };
}

describe('EventCard — štítok jazyka obsahu (F4AI-2b2)', () => {
  it('cudzí jazyk (en pri UI sk) ukáže štítok EN s lokalizovaným title', () => {
    renderWithProviders(<EventCard event={card([['L', 'ISO-639-1'], ['l', 'en', 'ISO-639-1']])} />);
    const badge = screen.getByTestId('lang-badge');
    expect(badge.textContent).toBe('EN');
    expect(badge.getAttribute('title')).toBe('jazyk obsahu: en');
  });

  it('rovnaký jazyk ako rozhranie (sk) štítok nemá — predvolený stav nešumí', () => {
    renderWithProviders(<EventCard event={card([['L', 'ISO-639-1'], ['l', 'sk', 'ISO-639-1']])} />);
    expect(screen.queryByTestId('lang-badge')).toBeNull();
  });

  it('event bez labelu ukáže UND', () => {
    renderWithProviders(<EventCard event={card([['t', 'rust']])} />);
    const badge = screen.getByTestId('lang-badge');
    expect(badge.textContent).toBe('UND');
    expect(badge.getAttribute('title')).toBe('jazyk obsahu: neoznačené');
  });

  it('kompaktný tvar ["L", kod, ISO-639-1] sa číta tiež (read, nie publish)', () => {
    renderWithProviders(<EventCard event={card([['L', 'de', 'ISO-639-1']])} />);
    expect(screen.getByTestId('lang-badge').textContent).toBe('DE');
  });

  it('cudzí namespace (t-tag, com.example) jazyk nie je', () => {
    renderWithProviders(
      <EventCard
        event={card([
          ['l', 'VI-hum', 'com.example.ontology'],
          ['t', 'sk'],
        ])}
      />,
    );
    // žiadny NIP-32 label → UND, nie náhodné čítanie z cudzieho namespace
    expect(screen.getByTestId('lang-badge').textContent).toBe('UND');
  });
});

/** odpoveď `GET /search` s troma jazykmi — sk (UI), en (cudzí), null (bez labelu) */
function searchResponse(langs: Array<string | null>): SearchResponse {
  return {
    phase: 'S8',
    query: 'tokio',
    normalized_query: 'tokio',
    took_ms: 12,
    count: langs.length,
    limit: 20,
    deadline_ms: 2000,
    partial: false,
    channels: ['fts5'],
    results: langs.map((lang, index) => ({
      id: String.fromCharCode('1'.charCodeAt(0) + index).repeat(64),
      kind: 1020,
      pubkey: TEST_PUBKEY,
      created_at: 1_793_200_000 - index,
      snippet: `snippet ${String(index)}`,
      score: 4.2 - index,
      ...(lang === null ? { lang: null } : { lang }),
    })),
    untrusted: 'výsledky nie sú moderované',
    filters: {},
  };
}

describe('SearchPage — filter jazyka (F4AI-2b2)', () => {
  it('?lang=en sa prenesie na gateway ako lang=en', async () => {
    const api = stubApi({ search: async () => searchResponse(['en']) });
    renderApp({ route: '/search?q=tokio&lang=en', api });
    await screen.findByTestId('search-results');
    expect(api.search).toHaveBeenCalledWith(expect.objectContaining({ q: 'tokio', lang: 'en' }));
  });

  it('bez lang parametra sa gateway posiela bez lang (žiadny filter)', async () => {
    const api = stubApi({ search: async () => searchResponse(['en', 'sk', null]) });
    renderApp({ route: '/search?q=tokio', api });
    await screen.findByTestId('search-results');
    const call = (api.search as unknown as { mock: { calls: Array<Record<string, unknown>[]> } }).mock
      .calls[0]?.[0];
    expect(call?.['lang']).toBeUndefined();
  });

  it('výber "len SK" v selecte posunie URL aj request na lang=sk', async () => {
    const api = stubApi({ search: async () => searchResponse(['sk']) });
    renderApp({ route: '/search?q=tokio', api });
    const select = (await screen.findByTestId('search-lang-select')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ui' } });
    await waitFor(() => {
      expect(api.search).toHaveBeenCalledWith(expect.objectContaining({ lang: 'sk' }));
    });
  });

  it('filter "iné jazyky" vylúči jazyk rozhrania a poctivo to oznámi', async () => {
    const api = stubApi({ search: async () => searchResponse(['sk', 'en', null]) });
    renderApp({ route: '/search?q=tokio&lang=other', api });
    const results = await screen.findByTestId('search-results');
    // `sk` (jazyk rozhrania) vylúčený, cudzí aj neoznačený zostávajú
    expect(results.querySelectorAll('[data-testid="search-result"]')).toHaveLength(2);
    const note = await screen.findByTestId('search-lang-note');
    expect(note.textContent).toContain('triedi prehliadač');
    // server dostal `any`-správanie = žiadny lang parameter
    const call = (api.search as unknown as { mock: { calls: Array<Record<string, unknown>[]> } }).mock
      .calls[0]?.[0];
    expect(call?.['lang']).toBeUndefined();
  });

  it('výsledok s cudzím jazykom má štítok EN', async () => {
    const api = stubApi({ search: async () => searchResponse(['en']) });
    renderApp({ route: '/search?q=tokio', api });
    await screen.findByTestId('search-results');
    expect(screen.getByTestId('lang-badge').textContent).toBe('EN');
  });

  it('pred-2b2 gateway: bez `lang` pole vo výsledku žiadny štítok (nevieme ≠ cudzie)', async () => {
    const api = stubApi({
      search: async () => {
        const res = searchResponse(['en']);
        // presne to, čo vráti gateway nad indexom bez `lang` stĺpca
        res.results = [{ ...res.results[0]!, lang: undefined }];
        return res;
      },
    });
    renderApp({ route: '/search?q=tokio', api });
    await screen.findByTestId('search-results');
    expect(screen.queryByTestId('lang-badge')).toBeNull();
  });

  it('select obsahuje jazyky nájdené vo výsledkoch', async () => {
    const api = stubApi({ search: async () => searchResponse(['en', 'de']) });
    renderApp({ route: '/search?q=tokio', api });
    const select = (await screen.findByTestId('search-lang-select')) as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(expect.arrayContaining(['all', 'ui', 'other', 'de', 'en']));
  });
});
