/**
 * Testy Sidebaru (S11, F4AI-17): navigácia Feed/Ideas/Search + strom
 * topicov z `GET /topics` (live dáta, placeholder pri chybe/prázdnom
 * indexe).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import { Sidebar } from '../src/components/Sidebar.js';
import { renderWithProviders } from './render.js';
import { ApiError } from '../src/api/client.js';
import { SAMPLE_EMPTY_TOPICS, SAMPLE_TOPICS, TOPIC_AI, TOPIC_RUST, stubApi } from './fixtures.js';

describe('Sidebar', () => {
  it('odkazuje na Feed / Ideas / Papers / Search', () => {
    renderWithProviders(<Sidebar />);
    const feed = screen.getByRole('link', { name: /feed/i });
    expect(feed.getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: /ideas/i }).getAttribute('href')).toBe('/ideas');
    // Phase 4b — Papiere (v SK preklade «Papiere», testy renderujú v SK)
    expect(screen.getByRole('link', { name: /papiere/i }).getAttribute('href')).toBe('/papers');
    expect(screen.getByRole('link', { name: /search/i }).getAttribute('href')).toBe('/search');
  });

  it('korene sú viditeľné, deti sú spočiatku zbalené (S12 toggle)', async () => {
    renderWithProviders(<Sidebar />);
    const tree = await screen.findByTestId('sidebar-topic-tree');
    expect(tree.textContent).toContain('rust');
    expect(tree.textContent).toContain('ai-agents');
    // podtopic `rust-tokio` je za toggle-om — kým ho nerozbalíme, v strome nie je
    expect(screen.queryByRole('link', { name: 'rust-tokio' })).toBeNull();
    expect(screen.getByTestId('topic-toggle-rust').getAttribute('aria-expanded')).toBe('false');
  });

  it('rozbalenie zobrazí deti s odkazmi na /topics/:slug a opäť zbalí', async () => {
    renderWithProviders(<Sidebar />);
    await screen.findByTestId('sidebar-topic-tree');

    fireEvent.click(screen.getByTestId('topic-toggle-rust'));
    const child = await screen.findByRole('link', { name: 'rust-tokio' });
    expect(child.getAttribute('href')).toBe('/topics/rust-tokio');
    expect(screen.getByTestId('topic-children-rust').textContent).toContain('rust-tokio');
    expect(screen.getByTestId('topic-toggle-rust').getAttribute('aria-expanded')).toBe('true');

    // zbaliť
    fireEvent.click(screen.getByTestId('topic-toggle-rust'));
    expect(screen.queryByRole('link', { name: 'rust-tokio' })).toBeNull();
    expect(screen.getByTestId('topic-toggle-rust').getAttribute('aria-expanded')).toBe('false');
  });

  it('list topicov bez detí toggle nemá (len spacer)', async () => {
    renderWithProviders(<Sidebar />);
    await screen.findByTestId('sidebar-topic-tree');
    expect(screen.queryByTestId('topic-toggle-ai-agents')).toBeNull();
    expect(screen.getByTestId('topic-branch-ai-agents')).toBeTruthy();
  });

  it('pri chybe gateway ukáže placeholder a stránka nespadne', async () => {
    const api = stubApi({
      topics: async () => {
        throw new ApiError('index unavailable', 503, { ok: false, error: 'index unavailable' }, '/topics');
      },
    });
    renderWithProviders(<Sidebar />, { api });
    const notice = await screen.findByTestId('sidebar-topics-error');
    expect(notice.textContent).toContain('placeholder');
    expect(notice.textContent).toContain('index unavailable');
  });

  it('pri prázdnom indexe povie, že nie je žiadny topic', async () => {
    renderWithProviders(<Sidebar />, { api: stubApi({ topics: async () => SAMPLE_EMPTY_TOPICS }) });
    const notice = await screen.findByTestId('sidebar-topics-empty');
    expect(notice.textContent).toContain('30020');
  });

  it('badge nití: thread_count > 0 sa zobrazí, 0 aj chýbajúce pole nie', async () => {
    // gateway od activity ordering posiela `thread_count` (vlastné nite +
    // descendants) a podľa neho radí korene — sidebar to len zrcadlí;
    // starší gateway pole neposiela → žiadny badge, nič sa nenechá prekvapiť
    const api = stubApi({
      topics: async () => ({
        ...SAMPLE_TOPICS,
        topics: [
          { ...TOPIC_RUST, thread_count: 7 },
          { ...TOPIC_AI, thread_count: 0 },
          { ...TOPIC_RUST, slug: 'bez-poctu', address: null, children: [] },
        ],
      }),
    });
    renderWithProviders(<Sidebar />, { api });
    const badge = await screen.findByTestId('topic-threads-rust');
    expect(badge.textContent).toBe('7');
    expect(screen.queryByTestId('topic-threads-ai-agents')).toBeNull();
    expect(screen.queryByTestId('topic-threads-bez-poctu')).toBeNull();
    // badge počtu detí ostáva zachovaný samostatne (topic-count = children)
    expect(screen.getByTestId('topic-count-rust').textContent).toBe('1');
  });

  it('bloky účtu: registrovať a nastavenia sú vždy, operátori len vlastníkovi (F4AI-24)', async () => {
    // `GET /register/owner` vráti pubkey prihláseného → sme vlastník
    const ownerApi = stubApi();
    const { unmount } = renderWithProviders(<Sidebar />, { api: ownerApi });
    const nav = await screen.findByTestId('account-nav');
    expect(nav.querySelector('[href="/register"]')).toBeTruthy();
    expect(nav.querySelector('[href="/settings"]')).toBeTruthy();
    expect(nav.querySelector('[href="/admin/operators"]')).toBeTruthy();
    unmount();

    // cudzí vlastník → ani odkaz neukážeme (klik by skončil 403 NOT_OWNER)
    const memberApi = stubApi({ registerOwner: async () => ({ ok: true, owner: 'd'.repeat(64) }) });
    renderWithProviders(<Sidebar />, { api: memberApi });
    const memberNav = await screen.findByTestId('account-nav');
    expect(memberNav.querySelector('[href="/register"]')).toBeTruthy();
    expect(memberNav.querySelector('[href="/admin/operators"]')).toBeNull();
  });
});
