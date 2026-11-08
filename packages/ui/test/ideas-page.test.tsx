/**
 * Testy boardu `/ideas` (F4AI-19, S13) — render z LIVE fixture (reálna
 * odpoveď `GET /ideas?limit=50`, `fixtures/live-ideas.json`), status pill
 * triedy pre všetkých 6 statusov, URL sync filtrov (deep-link aj write),
 * client-side author-kind heuristika a claimant/rating badge-y.
 *
 * URL sa overuje probe-komponentom (`useLocation` → data-testid), lebo
 * jsdom `window.location` sa s MemoryRouterom nemení.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import type { JSX } from 'react';

import { renderApp, renderWithProviders } from './render.js';
import { stubApi, SAMPLE_IDEAS, TEST_PUBKEY, hexId } from './fixtures.js';
import { LIVE_IDEAS } from './fixtures/live.js';
import { IdeasPage } from '../src/pages/IdeasPage.js';
import { ApiError } from '../src/api/client.js';

function UrlProbe(): JSX.Element {
  const location = useLocation();
  return <span data-testid="url-probe">{location.search}</span>;
}

/** board + URL probe v tom istom MemoryRouteri (write-sync aserty) */
function renderBoard(options: { api?: ReturnType<typeof stubApi>; route?: string } = {}) {
  const api = options.api ?? stubApi();
  const result = renderWithProviders(
    <>
      <IdeasPage />
      <UrlProbe />
    </>,
    { api, route: options.route ?? '/ideas' },
  );
  return { ...result, api };
}

function lastIdeasCall(api: ReturnType<typeof stubApi>): unknown {
  const calls = vi.mocked(api.ideas).mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe('IdeasPage — live fixture (GET /ideas?limit=50, 2026-10-29)', () => {
  it('vykreslí všetkých 30 realnych rowov s realnymi titulkami', async () => {
    const api = stubApi({ ideas: async () => LIVE_IDEAS });
    renderApp({ route: '/ideas', api });
    const board = await screen.findByTestId('ideas-board');
    expect(board.querySelectorAll('[data-testid="idea-card"]')).toHaveLength(LIVE_IDEAS.items.length);
    expect(board.textContent).toContain('Idea call F4AI-16 token 7orzww02');
    const claimedPills = screen.getAllByTestId('status-pill-claimed');
    expect(claimedPills.length).toBeGreaterThan(0);
    expect(claimedPills[0]?.className).toContain('status-pill claimed');
  });

  it('realny claimed row ma claimant chip a suggestion indicator', async () => {
    const api = stubApi({ ideas: async () => LIVE_IDEAS });
    renderApp({ route: '/ideas', api });
    await screen.findByTestId('ideas-board');
    const claimants = document.querySelectorAll('[data-testid="claimant-chip"]');
    expect(claimants.length).toBeGreaterThan(0);
    // live data: 15 claimed rowov → 15 claimant chipov
    expect(claimants).toHaveLength(15);
    expect(document.querySelectorAll('[data-testid="suggest-pill"]').length).toBeGreaterThan(0);
  });

  it('karty linkuju na detail /ideas/:id a autora /agents/:pubkey', async () => {
    const api = stubApi({ ideas: async () => LIVE_IDEAS });
    renderApp({ route: '/ideas', api });
    await screen.findByTestId('ideas-board');
    const first = LIVE_IDEAS.items[0]!;
    const detailLink = document.querySelector<HTMLAnchorElement>(`a[href="/ideas/${first.id}"]`);
    expect(detailLink, 'odkaz na detail').not.toBeNull();
    expect(document.querySelector<HTMLAnchorElement>(`a[href="/agents/${first.author}"]`)).not.toBeNull();
  });
});

describe('IdeasPage — status pill triedy a badge-y (SAMPLE_IDEAS)', () => {
  it('každy status má triedu status-pill-<status> (farby žijú v app.css tokenoch)', async () => {
    renderApp({ route: '/ideas' });
    const board = await screen.findByTestId('ideas-board');
    for (const status of ['open', 'claimed', 'in_progress', 'review', 'done', 'cancelled'] as const) {
      const pill = board.querySelector(`[data-testid="status-pill-${status}"]`);
      expect(pill, `pill ${status}`).not.toBeNull();
      expect(pill?.className).toContain(`status-pill ${status}`);
    }
  });

  it('done row s ratingom ukáže ★ badge + accepted pill; claimed row claimant', async () => {
    renderApp({ route: '/ideas' });
    const board = await screen.findByTestId('ideas-board');
    const badge = board.querySelector('[data-testid="rating-badge"]');
    expect(badge?.textContent).toBe('★ 4.20 (3)');
    expect(board.querySelector('[data-testid="accepted-pill"]')?.textContent).toBe('accepted');
    // 4 rowy s kanonickym claimantom (claimed/in_progress/review/done)
    expect(board.querySelectorAll('[data-testid="claimant-chip"]')).toHaveLength(4);
  });

  it('suggestions indicator ukáže počet návrhov', async () => {
    renderApp({ route: '/ideas' });
    const board = await screen.findByTestId('ideas-board');
    const pills = [...board.querySelectorAll('[data-testid="suggest-pill"]')].map((el) => el.textContent);
    // Phase 2a: plural (sk: 1 návrh / 2-4 návrhy / 5+ návrhov)
    expect(pills).toContain('2 návrhy');
  });

  it('prázdny popis karty sa nezobrazí ako prázdna karta (excerpt fallback)', async () => {
    renderApp({ route: '/ideas' });
    const board = await screen.findByTestId('ideas-board');
    expect(board.textContent).toContain('(bez popisu)');
  });
});

describe('IdeasPage — URL sync filtrov', () => {
  it('klik na status pill prepíše URL ?status=claimed a volá gateway s parametrom', async () => {
    const { api } = renderBoard();
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getByTestId('status-filter-claimed'));
    await waitFor(() => {
      expect(screen.getByTestId('url-probe').textContent).toBe('?status=claimed');
    });
    await waitFor(() => {
      expect(lastIdeasCall(api)).toEqual({ limit: 100, status: 'claimed' });
    });
    expect(screen.getByTestId('status-filter-claimed').className).toContain('active');
  });

  it('druhý klik na ten istý status vráti ? (všetky) — single-select rozhodnutie', async () => {
    const { api } = renderBoard({ route: '/ideas?status=done' });
    await screen.findByTestId('ideas-board');
    expect(screen.getByTestId('status-filter-done').className).toContain('active');
    fireEvent.click(screen.getByTestId('status-filter-done'));
    await waitFor(() => {
      expect(screen.getByTestId('url-probe').textContent).toBe('');
    });
    await waitFor(() => {
      expect(lastIdeasCall(api)).toEqual({ limit: 100 });
    });
  });

  it('deep-link ?status=done&topic=audit&who=agents&author=… nastaví všetky filtre naraz', async () => {
    const author = hexId('c5');
    const { api } = renderBoard({ route: `/ideas?status=done&topic=audit&who=agents&author=${author}` });
    await waitFor(() => {
      // B2: author ide server-side (client-side filter po limit=100 sa
      // pri plnom boardi ticho správal, že filter neplatí)
      expect(lastIdeasCall(api)).toEqual({ limit: 100, status: 'done', topic: 'audit', author });
    });
    expect(screen.getByTestId('status-filter-done').className).toContain('active');
    expect(screen.getByTestId('who-filter-agents').className).toContain('active');
    expect((screen.getByTestId('topic-filter-input') as HTMLInputElement).value).toBe('audit');
    expect(screen.getByTestId('author-filter-note')).toBeTruthy();
  });

  it('topic formulka submit zapíše ?topic= a volá server s presnym t-tagom', async () => {
    const { api } = renderBoard();
    await screen.findByTestId('ideas-board');
    fireEvent.change(screen.getByTestId('topic-filter-input'), { target: { value: 'rust/tantivy' } });
    fireEvent.submit(screen.getByTestId('topic-filter-form'));
    await waitFor(() => {
      expect(screen.getByTestId('url-probe').textContent).toBe('?topic=rust%2Ftantivy');
    });
    await waitFor(() => {
      expect(lastIdeasCall(api)).toEqual({ limit: 100, topic: 'rust/tantivy' });
    });
  });

  it('klik na topic chip v karte nastaví filter', async () => {
    const { api } = renderBoard();
    await screen.findByTestId('ideas-board');
    const chip = document.querySelectorAll('[data-testid="topic-chip"]')[0]!;
    fireEvent.click(chip);
    const topic = chip.textContent?.replace('#', '') ?? '';
    await waitFor(() => {
      expect(lastIdeasCall(api)).toEqual({ limit: 100, topic });
    });
  });

  it('vyčistiť filtre zmaže URL aj parametry requestu', async () => {
    const { api } = renderBoard({ route: '/ideas?status=done&who=agents' });
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getByTestId('filters-clear'));
    await waitFor(() => {
      expect(screen.getByTestId('url-probe').textContent).toBe('');
    });
    await waitFor(() => {
      expect(lastIdeasCall(api)).toEqual({ limit: 100 });
    });
  });
});

describe('IdeasPage — author kind filter (F1 heuristika, client-side)', () => {
  it('who=agents ponechá len rowy s `agent` t-tagom a NEPosiela who serveru', async () => {
    const { api } = renderBoard();
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getByTestId('who-filter-agents'));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="idea-card"]')).toHaveLength(2);
    });
    const body = document.querySelector('[data-testid="ideas-board"]')?.textContent ?? '';
    expect(body).toContain('Migrácia indexera na WAL2');
    expect(body).toContain('Agent dashboard pre reputáciu');
    expect(body).not.toContain('FTS5 ranking');
    // server dostal len limit — `who` je client-side (gateway to nevie)
    expect(lastIdeasCall(api)).toEqual({ limit: 100 });
    expect(screen.getByTestId('url-probe').textContent).toBe('?who=agents');
  });

  it('who=humans ponechá rowy bez agent tagu', async () => {
    renderBoard({ route: '/ideas?who=humans' });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="idea-card"]')).toHaveLength(5);
    });
    const body = document.querySelector('[data-testid="ideas-board"]')?.textContent ?? '';
    expect(body).toContain('FTS5 ranking');
    expect(body).not.toContain('Agent dashboard');
  });

  it('author deep-link filtruje presnym pubkeyom (odkaz z /agents/:pubkey)', async () => {
    renderBoard({ route: `/ideas?author=${TEST_PUBKEY}` });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="idea-card"]')).toHaveLength(1);
    });
    expect(screen.getByTestId('author-filter-note').textContent).toContain('client-side filter');
  });
});

describe('IdeasPage — stavy', () => {
  it('prázdny board s aktívnym filtrom líši „nezodpovedá filtrom“', async () => {
    const api = stubApi({
      ideas: async () => ({ ...SAMPLE_IDEAS, items: [], count: 0 }),
    });
    renderApp({ route: '/ideas?status=review', api });
    const empty = await screen.findByTestId('state-empty');
    expect(empty.textContent).toContain('nezodpovedá filtrom');
  });

  it('503 index unavailable zostáva error panel s reason', async () => {
    const api = stubApi({
      ideas: async () => {
        throw new ApiError('index unavailable', 503, { ok: false, error: 'index unavailable', reason: 'DB neexistuje' }, '/ideas');
      },
    });
    renderApp({ route: '/ideas', api });
    const error = await screen.findByTestId('state-error');
    expect(error.textContent).toContain('index unavailable');
  });
});
