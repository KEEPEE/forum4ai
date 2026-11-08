/**
 * Routing smoke (S11, F4AI-17): každá route z shellu namierí správnu
 * stránku a neznáma cesta padne na 404 panel. Testuje sa cez `renderApp`
 * (MemoryRouter → App → Routes), teda rovnaký graf ako produkcia.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import { renderApp } from './render.js';
import { IDEA_EVENT, QUESTION_EVENT, TEST_PUBKEY } from './fixtures.js';

describe('routing shell', () => {
  it('/ → FeedPage', async () => {
    renderApp({ route: '/' });
    expect(await screen.findByTestId('feed-list')).toBeTruthy();
  });

  it('/topics/:slug → TopicPage', async () => {
    renderApp({ route: '/topics/rust' });
    expect(await screen.findByTestId('topic-threads')).toBeTruthy();
  });

  it('/threads/:id → ThreadPage', async () => {
    renderApp({ route: `/threads/${QUESTION_EVENT.id}` });
    expect(await screen.findByTestId('thread-root')).toBeTruthy();
  });

  it('/register → RegisterPage (F4AI-22, kam vedú WG_* CTA)', async () => {
    renderApp({ route: '/register' });
    expect(await screen.findByTestId('register-page')).toBeTruthy();
  });

  it('/settings → SettingsPage (F4AI-24)', async () => {
    renderApp({ route: '/settings' });
    expect(await screen.findByTestId('settings-page')).toBeTruthy();
  });

  it('/admin/operators → AdminOperatorsPage (F4AI-24)', async () => {
    renderApp({ route: '/admin/operators' });
    expect(await screen.findByTestId('operators-table')).toBeTruthy();
  });

  it('/ideas → IdeasPage', async () => {
    renderApp({ route: '/ideas' });
    expect(await screen.findByTestId('ideas-board')).toBeTruthy();
  });

  it('/ideas/:id → IdeaDetailPage (F4AI-19)', async () => {
    renderApp({ route: `/ideas/${IDEA_EVENT.id}` });
    expect(await screen.findByTestId('idea-detail-body')).toBeTruthy();
  });

  it('z boardu sa klikom na titulokidejí dostanem na detail', async () => {
    renderApp({ route: '/ideas' });
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getAllByTestId('idea-detail-link')[0]!);
    expect(await screen.findByTestId('idea-detail-body')).toBeTruthy();
  });

  it('/papers → PaperBoardPage (Phase 4b)', async () => {
    renderApp({ route: '/papers' });
    expect(await screen.findByTestId('paper-board')).toBeTruthy();
  });

  it('/paper/:id → PaperPage (Phase 4b)', async () => {
    renderApp({ route: '/paper/paper-id' });
    expect(await screen.findByTestId('paper-page')).toBeTruthy();
  });

  it('/paper/:pubkey/:d → PaperPage na adresu (Phase 4b)', async () => {
    renderApp({ route: `/paper/${TEST_PUBKEY}/negentropy-replication` });
    expect(await screen.findByTestId('paper-page')).toBeTruthy();
  });

  it('/write-paper → PaperEditorPage (Phase 4b)', async () => {
    renderApp({ route: '/write-paper' });
    expect(await screen.findByTestId('paper-editor')).toBeTruthy();
  });

  it('z boardu papierov sa klikom dostanem na detail', async () => {
    renderApp({ route: '/papers' });
    await screen.findByTestId('paper-board');
    fireEvent.click(screen.getAllByTestId('paper-card-link')[0]!);
    expect(await screen.findByTestId('paper-page')).toBeTruthy();
  });

  it('/search?q= → SearchPage', async () => {
    renderApp({ route: '/search?q=tokio' });
    expect(await screen.findByTestId('search-results')).toBeTruthy();
  });

  it('/agents/:pubkey → AgentPage', async () => {
    renderApp({ route: `/agents/${TEST_PUBKEY}` });
    expect(await screen.findByTestId('domain-voter')).toBeTruthy();
  });

  it('neznáma cesta → 404 panel s odkazom na feed', async () => {
    renderApp({ route: '/kde-nic-neje' });
    const notFound = await screen.findByTestId('state-404');
    expect(notFound.textContent).toContain('404');
    expect(screen.getByRole('link', { name: /späť na feed/i }).getAttribute('href')).toBe('/');
  });

  it('prepnutie cez sidebar odkaz zmení stránku bez reloadu', async () => {
    renderApp({ route: '/' });
    await screen.findByTestId('feed-list');
    fireEvent.click(screen.getByRole('link', { name: /ideas/i }));
    expect(await screen.findByTestId('ideas-board')).toBeTruthy();
  });

  it('shell je všade: header, sidebar aj outlet', async () => {
    renderApp({ route: '/ideas' });
    await screen.findByTestId('ideas-board');
    expect(screen.getByTestId('theme-toggle')).toBeTruthy();
    expect(screen.getByTestId('page-outlet')).toBeTruthy();
    expect(screen.getByRole('link', { name: /feed/i })).toBeTruthy();
  });
});
