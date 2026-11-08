/**
 * `SearchPage` headings (F4AI-42).
 *
 * A search result used to be headed by the event's NIP-01 address or a slice of
 * its id, because a hit carried no title. The gateway now sends `title`; these
 * tests pin what the heading shows for each shape the API can return —
 * including the two shapes that must still fall back.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderApp } from './render.js';
import { TEST_PUBKEY, stubApi } from './fixtures.js';
import type { SearchResponse, SearchResult } from '../src/api/types.js';

const ID_PAPER = 'b'.repeat(64);
const ID_TOPIC = 'c'.repeat(64);
const ID_PLAIN = 'd'.repeat(64);

function hit(over: Partial<SearchResult> = {}): SearchResult {
  return {
    id: ID_PAPER,
    kind: 30023,
    pubkey: TEST_PUBKEY,
    created_at: 1_793_200_000,
    snippet: '…negentropy gates on <b>replication</b>…',
    score: 4.2,
    ...over,
  };
}

function response(results: SearchResult[]): SearchResponse {
  return {
    phase: 'S8',
    query: 'negentropy',
    normalized_query: 'negentropy',
    took_ms: 12,
    count: results.length,
    limit: 20,
    deadline_ms: 300,
    partial: false,
    channels: ['fts5'],
    results,
    untrusted: 'výsledky nie sú moderované',
    filters: {},
  };
}

/** the visible text of every result heading, in the order the page rendered them */
async function headings(): Promise<string[]> {
  const results = await screen.findByTestId('search-results');
  return Array.from(results.querySelectorAll('h3')).map((h3) => String(h3.textContent ?? ''));
}

describe('SearchPage — nadpis výsledku je titulok eventu (F4AI-42)', () => {
  it('titulok vyhráva nad adresou aj id', async () => {
    const api = stubApi({
      search: async () =>
        response([
          hit({ title: 'Negentropy Gates: Replication and LWW', addr: `30023:${TEST_PUBKEY}:negentropy-gates` }),
        ]),
    });
    renderApp({ route: '/search?q=negentropy', api });
    const [heading] = await headings();
    expect(heading).toBe('Negentropy Gates: Replication and LWW');
    // the address and the raw id must not leak into the heading any more
    expect(heading).not.toContain('30023:');
    expect(heading).not.toContain(ID_PAPER.slice(0, 16));
  });

  it('event bez titulku (`title: null`) sa vráti na adresu, bez adresy na id', async () => {
    const api = stubApi({
      search: async () =>
        response([
          hit({ id: ID_TOPIC, kind: 10030, title: null, addr: `10030:${TEST_PUBKEY}:claim` }),
          hit({ id: ID_PLAIN, kind: 1023, title: null }),
        ]),
    });
    renderApp({ route: '/search?q=negentropy', api });
    const [addressed, plain] = await headings();
    expect(addressed).toBe(`10030:${TEST_PUBKEY}:claim`);
    expect(plain).toBe(ID_PLAIN.slice(0, 16));
  });

  it('starý gateway bez poľa `title` sa chová ako `null` (žiadna regresia)', async () => {
    const legacy = hit({ id: ID_PLAIN, kind: 1020 });
    delete legacy.title; // pole v odpovedi vôbec nie je
    const api = stubApi({ search: async () => response([legacy]) });
    renderApp({ route: '/search?q=negentropy', api });
    const [heading] = await headings();
    expect(heading).toBe(ID_PLAIN.slice(0, 16));
  });

  it('nadpis je odkaz na vlákno eventu', async () => {
    const api = stubApi({ search: async () => response([hit({ title: 'Negentropy Gates' })]) });
    renderApp({ route: '/search?q=negentropy', api });
    const link = (await screen.findByRole('link', { name: 'Negentropy Gates' })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/threads/${ID_PAPER}`);
  });
});
