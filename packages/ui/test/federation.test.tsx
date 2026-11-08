/**
 * Testy federačného UI povrchu (Phase 6b, dizajn Q5).
 *
 * Kde je hranica toho, čo sa OPLATÍ testovať v UI (logika zobrazenia), a
 * čo patrí pod gateway/indexer (dizajn Q5 už otestovaný v 6a):
 *
 *  1. **Network sekcia** — existuje len keď `/fed/topics` vráci aspoň
 *     jeden cudzí koreň. Prázdna odpoveď aj 404 (gateway pred 6a) musia
 *     viesť k TÉMUŽ výsledku: sekcia nikde, stránka živá. Ticho degradovať
 *     je celá myšlienka federácie na strane čítačky.
 *  2. **Odkaz na cudzí topic** nesmie vyzerať ako domáci — nesené
 *     `?origin=` je to, čo prepne detail do cudzieho režimu.
 *  3. **Stipok pôvodu** je trojstavový: `self`/absencia → žiadny stipok,
 *     cudzí → stipok, cudzí + `trusted` 0 → varovný stipok. Absencia poľa
 *     NESMIE byť interpretovaná ako "domáce" (gateway pred 6a pole
 *     neposiela vôbec).
 *  4. **Cudzí detail** má dve volania a žiadne z nich nie je relay route —
 *     presne to test zaberá na argumentoch `api.search`.
 *  5. **Admin panel** mizne s 404 a Resync podpisuje a posiela TO ISTÉ
 *     telo (`'{}'`) — inak NIP-98 padne na 401 a používateľ uvidí
 *     nepochopiteľnú chybu.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { Sidebar } from '../src/components/Sidebar.js';
import { AdminOperatorsPage } from '../src/pages/AdminOperatorsPage.js';
import { renderApp, renderWithProviders } from './render.js';
import {
  FED_UPSTREAM,
  FED_UPSTREAM2,
  SAMPLE_FED_RESYNC,
  SAMPLE_FED_STATE,
  SAMPLE_FED_TOPICS,
  SAMPLE_FED_TOPICS_EMPTY,
  SAMPLE_SEARCH,
  fedNotFound,
  hexId,
  stubApi,
} from './fixtures.js';
import type { NostrEvent } from '@forum4ai/shared';
import type { SearchResponse } from '../src/api/types.js';

/** výsledok `GET /search` s voliteľnými `origin`/`trusted` — 6b pole */
function fedSearch(variants: Array<{ origin?: string; trusted?: boolean | number }>): SearchResponse {
  return {
    ...SAMPLE_SEARCH,
    count: variants.length,
    results: variants.map((variant, index) => ({
      ...SAMPLE_SEARCH.results[0]!,
      id: hexId(`f${String(index)}`),
      ...(variant.origin === undefined ? {} : { origin: variant.origin }),
      ...(variant.trusted === undefined ? {} : { trusted: variant.trusted }),
    })),
  };
}

describe('Sidebar — sekcia Network (z /fed/topics)', () => {
  it('cudzie korene sú pod upstream id a odkazujú na /topics/:slug?origin=<id>', async () => {
    const api = stubApi({ getFedTopics: async () => SAMPLE_FED_TOPICS });
    renderWithProviders(<Sidebar />, { api });

    const section = await screen.findByTestId('sidebar-network');
    // oba upstreamy sú vlastné skupiny, label je hostname bez portu
    expect(screen.getByTestId(`network-branch-${FED_UPSTREAM}`)).toBeTruthy();
    expect(section.textContent).toContain('b.example');
    expect(section.textContent).toContain('c.example');
    expect(screen.queryByText(FED_UPSTREAM)).toBeNull(); // port v labeli nechceme

    // skupina je spočiatku zbalená (rovnaké správanie ako domáci strom)
    expect(screen.getByTestId(`network-toggle-${FED_UPSTREAM}`).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: 'b-root' })).toBeNull();

    fireEvent.click(screen.getByTestId(`network-toggle-${FED_UPSTREAM}`));
    const link = await screen.findByRole('link', { name: 'b-root' });
    // `origin` je to, čo prepne detail do cudzieho režimu — bez neho by sa
    // cudzí topic skúšal čítať z domáceho `/topics/:slug` a bol by 404
    expect(link.getAttribute('href')).toBe(`/topics/b-root?origin=${encodeURIComponent(FED_UPSTREAM)}`);
    expect(screen.getByTestId(`network-count-${FED_UPSTREAM}`).textContent).toBe('1');
  });

  it('druhý upstream má vlastnú skupinu — cudzie stromy sa nemiešajú', async () => {
    const api = stubApi({ getFedTopics: async () => SAMPLE_FED_TOPICS });
    renderWithProviders(<Sidebar />, { api });
    await screen.findByTestId('sidebar-network');
    fireEvent.click(screen.getByTestId(`network-toggle-${FED_UPSTREAM2}`));
    const link = await screen.findByRole('link', { name: 'c-root' });
    expect(link.getAttribute('href')).toBe(`/topics/c-root?origin=${encodeURIComponent(FED_UPSTREAM2)}`);
    // koreň patrí pod svoju skupinu, nie pod susednú
    expect(screen.getByTestId(`network-children-${FED_UPSTREAM2}`).textContent).toContain('c-root');
    expect(screen.getByTestId(`network-children-${FED_UPSTREAM2}`).textContent).not.toContain('b-root');
  });

  it('federation bez cudzích koreňov: sekcia Network vôbec nie je', async () => {
    const api = stubApi({ getFedTopics: async () => SAMPLE_FED_TOPICS_EMPTY });
    renderWithProviders(<Sidebar />, { api });
    // domáci strom sa naťahuje a je tam, network nie
    await screen.findByTestId('sidebar-topic-tree');
    expect(screen.queryByTestId('sidebar-network')).toBeNull();
  });

  it('gateway pred 6a (404 na /fed/topics): sekcia zmizne, sidebar nespadne', async () => {
    const api = stubApi({
      getFedTopics: async () => {
        throw fedNotFound();
      },
    });
    renderWithProviders(<Sidebar />, { api });
    await screen.findByTestId('sidebar-topic-tree');
    expect(screen.queryByTestId('sidebar-network')).toBeNull();
    expect(screen.getByRole('link', { name: /feed/i })).toBeTruthy();
  });
});

describe('SearchPage — stipok a filter pôvodu', () => {
  it('cudzí hit má stipok s hostname a tooltip s plným id', async () => {
    const api = stubApi({ search: async () => fedSearch([{ origin: FED_UPSTREAM, trusted: true }]) });
    renderApp({ route: '/search?q=tokio', api });
    await screen.findByTestId('search-results');

    const chip = screen.getByTestId('origin-chip');
    expect(chip.textContent).toContain('b.example');
    expect(chip.getAttribute('title')).toContain(FED_UPSTREAM);
    expect(chip.className).toContain('origin-chip');
    expect(chip.className).not.toContain('warn');
  });

  it('cudzí hit od pisúceho mimo náš adresár má VAROVNÝ stipok', async () => {
    // gateway posiela boolean, read-only DB vracia 0 — oboje je "nedôveryhodný"
    for (const trusted of [false, 0] as const) {
      const api = stubApi({ search: async () => fedSearch([{ origin: FED_UPSTREAM, trusted }]) });
      const { unmount } = renderApp({ route: '/search?q=tokio', api });
      await screen.findByTestId('search-results');
      const chip = screen.getByTestId('origin-chip');
      expect(chip.className).toContain('warn');
      expect(chip.getAttribute('title')).toContain('adresári pisúcich');
      unmount();
    }
  });

  it('domáci hit (origin=self) stipok nemá a absencia poľa tiež nie', async () => {
    const api = stubApi({ search: async () => fedSearch([{ origin: 'self', trusted: true }]) });
    const first = renderApp({ route: '/search?q=tokio', api });
    await screen.findByTestId('search-results');
    expect(screen.queryByTestId('origin-chip')).toBeNull();
    first.unmount();

    // gateway PRED 6a: pole vôbec nie je → "nevieme" nie je "cudzie"
    const legacy = stubApi({ search: async () => fedSearch([{}]) });
    const { unmount } = renderApp({ route: '/search?q=tokio', api: legacy });
    await screen.findByTestId('search-results');
    expect(screen.queryByTestId('origin-chip')).toBeNull();
    unmount();
  });

  it('?origin=<id> sa prenesie na gateway a poctivo to oznámi', async () => {
    const api = stubApi({ search: async () => fedSearch([{ origin: FED_UPSTREAM, trusted: false }]) });
    renderApp({ route: `/search?q=tokio&origin=${encodeURIComponent(FED_UPSTREAM)}`, api });
    await screen.findByTestId('search-results');
    expect(api.search).toHaveBeenCalledWith(expect.objectContaining({ q: 'tokio', origin: FED_UPSTREAM }));
    const note = await screen.findByTestId('search-origin-note');
    expect(note.textContent).toContain(FED_UPSTREAM);
  });

  it('select obsahuje objavené inštancie a výbor pošle origin=', async () => {
    const api = stubApi({
      search: async () => fedSearch([{ origin: 'self', trusted: true }, { origin: FED_UPSTREAM, trusted: false }]),
    });
    renderApp({ route: '/search?q=tokio', api });
    const select = (await screen.findByTestId('search-origin-select')) as HTMLSelectElement;
    const values = [...select.options].map((option) => option.value);
    expect(values).toEqual(['all', 'self', FED_UPSTREAM]);
    // the option text is sentence case (F4AI-41) — the values above are what
    // the gateway receives, the labels are what the reader sees
    expect(select.options[0]?.textContent).toBe('Všetky inštancie');
    expect(select.options[1]?.textContent).toBe('Táto inštancia');

    fireEvent.change(select, { target: { value: FED_UPSTREAM } });
    await waitFor(() => {
      expect(api.search).toHaveBeenCalledWith(expect.objectContaining({ origin: FED_UPSTREAM }));
    });
  });

  it('bez cudzích hitov je select len all/self (filter nevymýšľame)', async () => {
    const api = stubApi({ search: async () => fedSearch([{ origin: 'self', trusted: true }]) });
    renderApp({ route: '/search?q=tokio', api });
    const select = (await screen.findByTestId('search-origin-select')) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['all', 'self']);
  });
});

describe('TopicPage — cudzí režim (?origin=)', () => {
  it('koreň z /fed/topics a vlákna z /search s filtrom pôvodu', async () => {
    const api = stubApi({
      getFedTopics: async () => SAMPLE_FED_TOPICS,
      search: async () => fedSearch([{ origin: FED_UPSTREAM, trusted: false }]),
    });
    renderApp({ route: `/topics/b-root?origin=${encodeURIComponent(FED_UPSTREAM)}`, api });

    const threads = await screen.findByTestId('topic-threads');
    expect(threads.querySelectorAll('[data-testid="remote-thread-card"]')).toHaveLength(1);
    // stipok pôvodu v hlavičke = na prvý pohľad cudzí strom
    expect(screen.getByTestId('topic-origin-chip').textContent).toContain('b.example');
    expect(screen.getByTestId('topic-remote-address').textContent).toBe(`30020:${hexId('e2')}:b-root`);
    expect(screen.getByTestId('topic-remote-note').textContent).toContain(FED_UPSTREAM);
    // vlákna sú náhľad z indexu, nie čítanie z relayu — stránka to musí povedať
    expect(screen.getByTestId('topic-remote-note-threads')).toBeTruthy();

    // DVE volania, žiadna relay route (`/topics/:slug` by pre cudzí event
    // vrátila 404, lebo cudzie eventy v relayoch nie sú)
    expect(api.getFedTopics).toHaveBeenCalledWith({ limit: 200 });
    expect(api.search).toHaveBeenCalledWith(
      expect.objectContaining({
        q: `30020:${hexId('e2')}:b-root`,
        kinds: [1020, 1021, 1022],
        origin: FED_UPSTREAM,
      }),
    );
    expect(api.topic).not.toHaveBeenCalled();
  });

  it('cudzí koreň, ktorý sme ešte nestiahli: not-found, nie prázdny domáci topic', async () => {
    const api = stubApi({ getFedTopics: async () => SAMPLE_FED_TOPICS });
    renderApp({ route: `/topics/never-pulled?origin=${encodeURIComponent(FED_UPSTREAM)}`, api });
    const empty = await screen.findByTestId('state-empty');
    expect(empty.textContent).toContain('topic nie je v sekcii siete');
    expect(empty.textContent).toContain(FED_UPSTREAM);
    expect(api.search).not.toHaveBeenCalled();
  });

  it('zlyhanie search (index nedostupný) stále ukáže koreň a povie prečo', async () => {
    const api = stubApi({
      getFedTopics: async () => SAMPLE_FED_TOPICS,
      search: async () => {
        throw new Error('index unavailable');
      },
    });
    renderApp({ route: `/topics/b-root?origin=${encodeURIComponent(FED_UPSTREAM)}`, api });
    expect(await screen.findByTestId('topic-remote-address')).toBeTruthy();
    const empty = await screen.findByTestId('state-empty');
    expect(empty.textContent).toContain('náhľad z vyhľadávania');
  });

  it('bez ?origin= zostáva domáci režim (relay route, žiadny cudzí loader)', async () => {
    const api = stubApi();
    renderApp({ route: '/topics/rust', api });
    await screen.findByTestId('topic-live-status');
    expect(api.topic).toHaveBeenCalled();
    // Sidebar si `/fed/topics` pýta bez limitu; NÁŠ cudzí loader posiela
    // `limit: 200`. Podľa tohto rozlíšime, či bežil RemoteTopicPage.
    expect(api.getFedTopics).not.toHaveBeenCalledWith({ limit: 200 });
    expect(screen.queryByTestId('topic-origin-chip')).toBeNull();
  });
});

describe('Admin — panel stavu federácie', () => {
  it('/fed/state: tabuľka upstreamov s checkpointom, frontou a chybou', async () => {
    const api = stubApi({ fedState: async () => SAMPLE_FED_STATE });
    renderWithProviders(<AdminOperatorsPage />, { api });

    const table = await screen.findByTestId('fed-state-table');
    expect(screen.getByTestId(`fed-row-${FED_UPSTREAM}`).textContent).toContain('3 čaká');
    expect(screen.getByTestId(`fed-error-${FED_UPSTREAM}`).textContent).toContain('v poriadku');
    // chybový upstream ukáže chybu a jeho mŕtve listy
    expect(screen.getByTestId(`fed-error-${FED_UPSTREAM2}`).textContent).toContain('ECONNREFUSED');
    expect(screen.getByTestId('fed-dead-letters').textContent).toContain('relay 410');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('Resync pošle podpísané {} a NIP-98 `u` tag presne s URL-encoded id', async () => {
    const api = stubApi({ fedState: async () => SAMPLE_FED_STATE, fedResync: async () => SAMPLE_FED_RESYNC });
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('fed-state-table');

    fireEvent.click(screen.getByTestId(`fed-resync-${FED_UPSTREAM}`));
    await waitFor(() => {
      expect(api.fedResync).toHaveBeenCalled();
    });
    const call = (api.fedResync as unknown as { mock: { calls: [string, string, string][] } }).mock.calls[0];
    expect(call?.[0]).toBe(FED_UPSTREAM);
    // telo MUSÍ byť byte-exact to, čo podpisoval NIP-98 (`payload:{}` → '{}')
    expect(call?.[1]).toBe('{}');
    const event = JSON.parse(Buffer.from((call?.[2] ?? '').replace(/^Nostr /, ''), 'base64').toString('utf8')) as NostrEvent;
    const urlTag = event.tags.find((tag) => tag[0] === 'u');
    // `nip98UrlCandidates` nespasuje zmenu CEETY, preto podpisujeme už
    // s encodeURIComponent — inak 401 `AUTH_NIP98_INVALID`
    expect(urlTag?.[1]).toBe(`http://gateway.test/fed/resync/${encodeURIComponent(FED_UPSTREAM)}`);
    expect((await screen.findByTestId('fed-flash')).textContent).toContain('kurzor vynulovaný na 0');
  });

  it('gateway pred 6a (404): panel zmizne a stránka operátorov je stále čitateľná', async () => {
    const api = stubApi(); // fedState default hádže 404
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('admin-operators');
    expect(screen.queryByTestId('fed-state')).toBeNull();
  });

  it('federation vypnutá (0 upstreamov): panel je, tabuľka nie', async () => {
    const api = stubApi({
      fedState: async () => ({
        ...SAMPLE_FED_STATE,
        federation: { enabled: false, upstreams: [] },
      }),
    });
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('fed-state');
    expect(screen.queryByTestId('fed-state-table')).toBeNull();
    expect(screen.getByTestId('fed-state-empty').textContent).toContain('Žiadny upstream');
  });
});
