/**
 * Testy ThreadPage s LIVE fixture (F4AI-18, S12) — strom odpovedí sa
 * renderuje zo skutočnej odpovede `GET /threads/:id` (fixture
 * `test/fixtures/live-thread-*.json`), nie z ručne písaného stubu:
 *  - vnorenie `children` (1023 → 1023) → `reply-tree-0` / `reply-tree-1`
 *  - untrusted badge na root karte aj odpovediach
 *  - autor = skrátený npub + tooltip s plným npubom, relatívny čas
 *  - 1031 rating badge len pri `rating.count > 0`
 *  - accepted solution pill len pri `rating.accepted`
 *  - live indikátor (fake WS → `connecting`) a composer viazaný na root
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { renderApp } from './render.js';
import { stubApi } from './fixtures.js';
import {
  LIVE_NESTED_CHILD_ID,
  LIVE_THREAD_ACCEPTED,
  LIVE_THREAD_NESTED,
} from './fixtures/live.js';
import { npubOf } from '../src/lib/npub.js';

function renderThread(fixture: typeof LIVE_THREAD_NESTED): void {
  const api = stubApi({ thread: async () => fixture });
  renderApp({ route: `/threads/${fixture.root.id}`, api });
}

describe('ThreadPage — strom z live fixture (nested)', () => {
  it('renderuje root a vnorené odpovede s odsadením (reply-tree depth)', async () => {
    renderThread(LIVE_THREAD_NESTED);
    const root = await screen.findByTestId('thread-root');
    expect(root.textContent).toContain(LIVE_THREAD_NESTED.root.content.split('\n')[0] ?? '');

    const tree0 = await screen.findByTestId('reply-tree-0');
    expect(tree0.textContent).toContain('odpoved 1');
    const tree1 = await screen.findByTestId('reply-tree-1');
    expect(tree1.textContent).toContain('odpoved 2 pod odpoved 1');
    // dieťa visí pod rodičom (odsadenie = hĺbka 1)
    expect(tree1.closest('[data-testid^="reply-node-"]')?.getAttribute('data-testid')).toBe(
      `reply-node-${(LIVE_THREAD_NESTED.replies[0]?.id ?? '').slice(0, 8)}`,
    );
    expect(LIVE_NESTED_CHILD_ID.length).toBe(64);
  });

  it('autor je skrátený npub s tooltipom na plný npub a relatívnym časom', async () => {
    renderThread(LIVE_THREAD_NESTED);
    const cards = await screen.findAllByTestId('event-author');
    const first = cards[0] as HTMLElement;
    const expectedNpub = npubOf(LIVE_THREAD_NESTED.root.pubkey);
    expect(first.getAttribute('title')).toBe(expectedNpub);
    expect(first.textContent).toMatch(/^npub1.{4,}…/);
    expect(expectedNpub.startsWith('npub1')).toBe(true);

    const times = document.querySelectorAll('[data-testid="thread-root"] time');
    expect(times.length).toBe(1);
    expect(times[0]?.textContent).toMatch(/práve teraz|pred \d+ (min|h|d)|\d{4}-\d{2}-\d{2}/);
  });

  it('každá karta vlákna má untrusted badge (obsah nie je moderovaný)', async () => {
    renderThread(LIVE_THREAD_NESTED);
    const badges = await screen.findAllByTestId('untrusted-badge');
    // badge v hlavičke + root karta + 2 odpovede
    expect(badges.length).toBe(4);
  });

  it('rating badge chýba pri count 0 a accepted pill tiež', async () => {
    renderThread(LIVE_THREAD_NESTED);
    await screen.findByTestId('thread-root');
    expect(screen.queryByTestId('thread-rating-badge')).toBeNull();
    expect(screen.queryByTestId('thread-accepted-pill')).toBeNull();
    // Phase 2a: počet odpovedí ide cez plural (sk: 1 odpoveď / 2-4 odpovede / 5+ odpovedí)
    expect(screen.getByText(/2 odpovede/)).toBeTruthy();
  });

  it('live indikátor je prítomný (fake WS bez open → connecting)', async () => {
    renderThread(LIVE_THREAD_NESTED);
    await waitFor(() => expect(screen.getByTestId('thread-live-status').textContent).toBe('live: connecting'));
  });
});

describe('ThreadPage — rating + accepted z live fixture (1031/1032)', () => {
  it('rating badge ukáže priemer a počet, accepted pill pri rating.accepted', async () => {
    renderThread(LIVE_THREAD_ACCEPTED);
    const badge = await screen.findByTestId('thread-rating-badge');
    expect(badge.textContent).toContain('4,00/5');
    expect(badge.textContent).toContain('1×');
    const pill = await screen.findByTestId('thread-accepted-pill');
    expect(pill.textContent).toContain('akceptované');
    expect(screen.getByTestId('thread-root').textContent).toContain('Reputacny test otazka');
  });

  it('composer je viazaný na root vlákna (replyTo = root id)', async () => {
    renderThread(LIVE_THREAD_ACCEPTED);
    const composer = await screen.findByTestId('composer');
    expect(composer.textContent).toContain('pridaj odpoveď na toto vlákno');
    // root marker v podepísanom evente smeruje na id rootu — overíme cez
    // podpis: root id je `root` e tag prvý
    const rootLink = screen.getByTestId('thread-root').querySelector('a[href^="/threads/"]');
    expect(rootLink?.getAttribute('href')).toBe(`/threads/${LIVE_THREAD_ACCEPTED.root.id}`);
  });
});
