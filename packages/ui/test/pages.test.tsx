/**
 * Testy stránok (S11, F4AI-17): každá route má tri stavy — loading,
 * data, error — a data sa renderujú zo stub odpovedí gateway.
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';

import { renderApp } from './render.js';
import { realRootOf } from '../src/pages/ThreadPage.js';
import { useResource } from '../src/hooks/useResource.js';
import { ApiError } from '../src/api/client.js';
import {
  QUESTION_EVENT,
  SAMPLE_EMPTY_FEED,
  SAMPLE_IDEAS,
  SAMPLE_REPUTATION,
  TEST_PUBKEY,
  stubApi,
} from './fixtures.js';

function unavailable(): ApiError {
  return new ApiError(
    'index unavailable (503) na /search',
    503,
    { ok: false, error: 'index unavailable', reason: 'GATEWAY_INDEX_DB nie je nastavená' },
    '/search',
  );
}

describe('FeedPage (/)', () => {
  it('po načítaní ukáže príspevky z /feed', async () => {
    renderApp();
    const list = await screen.findByTestId('feed-list');
    expect(list.querySelectorAll('[data-testid="event-card"]')).toHaveLength(2);
    expect(list.textContent).toContain('graceful shutdown');
  });

  it('zobrazí loading stav skôr, než dorazia dáta', () => {
    let resolveFeed: ((value: unknown) => void) | undefined;
    const api = stubApi({
      feed: () => new Promise((resolve) => {
        resolveFeed = resolve;
      }) as never,
    });
    renderApp({ api });
    // loading panel mdže byť aj v sidebari (strom topicov), feed k nim patrí
    expect(screen.getAllByTestId('state-loading').length).toBeGreaterThanOrEqual(1);
    resolveFeed?.({ phase: 'S8', kinds: [1020], limit: 20, count: 0, items: [] });
  });

  it('pri chybe ukáže reason z gateway a tlačidlo retry', async () => {
    const api = stubApi({
      feed: async () => {
        throw unavailable();
      },
    });
    renderApp({ api });
    const error = await screen.findByTestId('state-error');
    expect(error.textContent).toContain('index unavailable');
    expect(error.textContent).toContain('GATEWAY_INDEX_DB');
    fireEvent.click(screen.getByRole('button', { name: /skúsiť znova/i }));
    await waitFor(() => {
      expect(api.feed).toHaveBeenCalledTimes(2);
    });
  });

  it('prázdny feed oznámi, že relaye neobsahujú príspevky', async () => {
    renderApp({ api: stubApi({ feed: async () => SAMPLE_EMPTY_FEED }) });
    const empty = await screen.findByTestId('state-empty');
    expect(empty.textContent).toContain('feed je zatiaľ prázdny');
  });
});

describe('TopicPage (/topics/:slug)', () => {
  it('vykreslí uzol topicu, deti a vlákna', async () => {
    renderApp({ route: '/topics/rust' });
    expect(await screen.findByRole('heading', { level: 1, name: 'rust' })).toBeTruthy();
    const threads = await screen.findByTestId('topic-threads');
    expect(threads.querySelectorAll('[data-testid="event-card"]')).toHaveLength(1);
    // odkaz na die topicu je v deti aj v sidebar strome
    const childLinks = screen.getAllByRole('link', { name: 'rust-tokio' });
    expect(childLinks.some((link) => link.getAttribute('href') === '/topics/rust-tokio')).toBe(true);
  });

  it('404 topicu prežije a ukáže chybový panel', async () => {
    const api = stubApi({
      topic: async () => {
        throw new ApiError('topic not found', 404, { ok: false, error: 'topic not found', slug: 'x' }, '/topics/x');
      },
    });
    renderApp({ route: '/topics/x', api });
    const error = await screen.findByTestId('state-error');
    expect(error.textContent).toContain('topic not found');
  });
});

describe('ThreadPage (/threads/:id)', () => {
  it('ukáže root, strom odpovedí a agregát hodnotení', async () => {
    renderApp({ route: `/threads/${QUESTION_EVENT.id}` });
    expect(await screen.findByTestId('thread-root')).toBeTruthy();
    const replies = await screen.findAllByTestId('reply-card');
    expect(replies).toHaveLength(2);
    expect(screen.getByText('4,10')).toBeTruthy();
    expect(screen.getByText(/riešenie akceptované/i)).toBeTruthy();
  });

  it('composer na vlákne je viazaný na id rootu', async () => {
    renderApp({ route: `/threads/${QUESTION_EVENT.id}` });
    const composer = await screen.findByTestId('composer');
    expect(composer).toBeTruthy();
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'odpoveď z testu' } });
    fireEvent.click(screen.getByTestId('composer-sign-btn'));
    const signed = await screen.findByTestId('composer-signed-event');
    expect(signed.textContent).toContain(QUESTION_EVENT.id.slice(0, 16));
  });
});

describe('IdeasPage (/ideas)', () => {
  it('vykreslí board s status pilulkami', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('link', { name: /ideas/i }));
    const board = await screen.findByTestId('ideas-board');
    expect(board.querySelectorAll('[data-testid="idea-card"]')).toHaveLength(SAMPLE_IDEAS.items.length);
    expect(board.textContent).toContain('FTS5 ranking');
    expect(board.textContent).toContain('claimed');
  });

  it('503 index unavailable oznámi chýbajúci index', async () => {
    const api = stubApi({
      ideas: async () => {
        throw unavailable();
      },
    });
    renderApp({ route: '/ideas', api });
    const error = await screen.findByTestId('state-error');
    expect(error.textContent).toContain('index unavailable');
  });
});

describe('SearchPage (/search)', () => {
  it('s dotazom ukáže výsledky so snippetom', async () => {
    renderApp({ route: '/search?q=tokio' });
    const results = await screen.findByTestId('search-results');
    expect(results.querySelectorAll('[data-testid="search-result"]')).toHaveLength(1);
    expect(results.textContent).toContain('graceful');
  });

  it('bez dotazu nevolá gateway a ukáže nápovedu', async () => {
    const api = stubApi();
    renderApp({ route: '/search', api });
    expect(await screen.findByTestId('state-empty')).toBeTruthy();
    expect(api.search).not.toHaveBeenCalled();
  });

  it('chybu indexu zobrazí ako error panel', async () => {
    const api = stubApi({
      search: async () => {
        throw unavailable();
      },
    });
    renderApp({ route: '/search?q=x', api });
    expect(await screen.findByTestId('state-error')).toBeTruthy();
  });
});

describe('AgentPage (/agents/:pubkey)', () => {
  it('ukáže domény reputácie a počty aktivity', async () => {
    renderApp({ route: `/agents/${TEST_PUBKEY}` });
    const voter = await screen.findByTestId('domain-voter');
    expect(voter.textContent).toMatch(/72,0\s%/);
    expect(screen.getByTestId('domain-author').textContent).toContain('n_eff');
    expect(screen.getByText('26')).toBeTruthy();
    expect(SAMPLE_REPUTATION.domains.voter?.score).toBe(0.72);
  });

  it('neznámy pubkey (404) ukáže reason', async () => {
    const api = stubApi({
      reputation: async () => {
        throw new ApiError('pubkey not found', 404, { ok: false, error: 'pubkey not found', reason: 'pubkey nemá v indexe žiadny event' }, '/reputation/x');
      },
    });
    renderApp({ route: `/agents/${TEST_PUBKEY}`, api });
    const error = await screen.findByTestId('state-error');
    expect(error.textContent).toContain('pubkey not found');
  });
});

// ── regression C1 ──────────────────────────────────────────────────────────

describe('realRootOf (C1 — root odpovede v permalink)', () => {
  const QUESTION = 'a1'.padEnd(64, '0');
  const ANSWER = 'b2'.padEnd(64, '0');

  it('otázka 1020 je root sama → null', () => {
    expect(realRootOf({ kind: 1020, tags: [] })).toBeNull();
  });

  it('1023 s root markerom → skutočný root (otázka)', () => {
    expect(
      realRootOf({ kind: 1023, tags: [['e', ANSWER, 'parent'], ['e', QUESTION, 'root']] }),
    ).toBe(QUESTION);
  });

  it('1023 bez root markera → prvý 64-hex `e` tag (fallback)', () => {
    expect(realRootOf({ kind: 1023, tags: [['e', QUESTION, ''], ['k', 'x']] })).toBe(QUESTION);
  });

  it('1023 bez použiteľných `e` tagov → null (composer ostane na rootovi)', () => {
    expect(realRootOf({ kind: 1023, tags: [['t', 'nostr'], ['e', 'krátky', 'root']] })).toBeNull();
  });
});

// ── regression D3 ──────────────────────────────────────────────────────────

describe('useResource (D3 — stale data pri zmene deps)', () => {
  it('pri zmene deps hneď zahodí staré dá, nové dorazia po resolve', async () => {
    let resolveB: ((value: string) => void) | undefined;
    const { rerender, result } = renderHook(
      ({ id }: { id: string }) =>
        useResource<string>(
          () =>
            id === 'a'
              ? Promise.resolve('data-A')
              : (new Promise<string>((resolve) => {
                  resolveB = resolve;
                }) as Promise<string>),
          [id],
        ),
      { initialProps: { id: 'a' } },
    );
    await waitFor(() => expect(result.current.data).toBe('data-A'));

    rerender({ id: 'b' });
    // D3: pod novou route nesmie svietiť STARÉ data entity A
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    resolveB?.('data-B');
    await waitFor(() => expect(result.current.data).toBe('data-B'));
    expect(result.current.loading).toBe(false);
  });

  it('reload (nonce) data CHÁNA — žiadne medzivýpadové odmountovanie', async () => {
    let calls = 0;
    const { result } = renderHook(() =>
      useResource<string>(
        () =>
          new Promise<string>((resolve) => {
            calls += 1;
            resolve(`data-${String(calls)}`);
          }),
        ['stable'],
      ),
    );
    await waitFor(() => expect(result.current.data).toBe('data-1'));
    act(() => result.current.reload());
    // D3: reload nie je zmena deps — data ostávajú, kým dorazia nové
    // (inak by stránka odmountovala composer s práve zverejnenou odpovedou)
    expect(result.current.data).toBe('data-1');
    await waitFor(() => expect(result.current.data).toBe('data-2'));
  });
});
