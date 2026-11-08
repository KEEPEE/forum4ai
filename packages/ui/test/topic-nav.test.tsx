/**
 * Testy topic navigácie (F4AI-18, S12) — klikací prechod sidebar →
 * `/topics/:slug` na LIVE fixture (`test/fixtures/live-topics.json`,
 * `live-topic-detail.json`):
 *  - koreňové topicy viditeľné, podtopicy za rozbaľovacím toggle
 *  - klik na podtopic naviguje na jeho detail (breadcrumb + nadpis)
 *  - detail zje `topic + deti + vlákna s náhľadom` z `GET /topics/:slug`
 *  - empty (žiadne vlákna) a error (404 `topic not found`) stavy
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { renderApp } from './render.js';
import { stubApi } from './fixtures.js';
import { LIVE_TOPIC_DETAIL, LIVE_TOPICS } from './fixtures/live.js';
import { ApiError } from '../src/api/client.js';
import type { TopicDetailResponse } from '../src/api/types.js';

/** detail pre ľubovoľný slug — mení len identifikátor, inak live shape */
function detailFor(slug: string): TopicDetailResponse {
  return { ...LIVE_TOPIC_DETAIL, topic: { ...LIVE_TOPIC_DETAIL.topic, slug } };
}

function liveApi(overrides: Partial<{ topic: (slug: string) => Promise<TopicDetailResponse> }> = {}) {
  return stubApi({
    topics: async () => LIVE_TOPICS,
    topic: (slug) => Promise.resolve(detailFor(slug)),
    ...overrides,
  });
}

describe('sidebar → topic detail (plná navigácia)', () => {
  it('korene z live /topics sú viditeľné a počet topicov je v nadpise sekcie', async () => {
    renderApp({ route: '/', api: liveApi() });
    const tree = await screen.findByTestId('sidebar-topic-tree');
    expect(tree.textContent).toContain('dbg-koren');
    expect(tree.textContent).toContain('f4ai11-koren-1793208437023');
    // podtopic je zbalený
    expect(screen.queryByRole('link', { name: 'dbg-pod' })).toBeNull();
    // the count belongs in the section heading; the heading's case is sentence
    // case now (F4AI-41), so the matcher must not pin it
    expect(screen.getByText(/topiky \(\d+\)/i)).toBeTruthy();
  });

  it('rozbalím dbg-koren → klik na dbg-pod → TopicPage dbg-pod', async () => {
    renderApp({ route: '/', api: liveApi() });
    await screen.findByTestId('sidebar-topic-tree');

    fireEvent.click(screen.getByTestId('topic-toggle-dbg-koren'));
    const pod = await screen.findByRole('link', { name: 'dbg-pod' });
    expect(pod.getAttribute('href')).toBe('/topics/dbg-pod');

    fireEvent.click(pod);
    const heading = await screen.findByRole('heading', { level: 1, name: 'dbg-pod' });
    expect(heading).toBeTruthy();
    expect(screen.getByText('f4ai11-koren-1793208437023')).toBeTruthy();
  });

  it('klik na koreňový topic naviguje na detail s vláknami z live fixture', async () => {
    renderApp({ route: '/', api: liveApi() });
    await screen.findByTestId('sidebar-topic-tree');

    fireEvent.click(screen.getByRole('link', { name: 'dbg-koren' }));
    await screen.findByRole('heading', { level: 1, name: 'dbg-koren' });

    const threads = await screen.findByTestId('topic-threads');
    // live detail obsahuje 2 otázky s `a` tagom na adresu topicu
    expect(threads.textContent).toContain('otazka 1');
    expect(threads.textContent).toContain('otazka 2');
    // Phase 2a: počet vlákien ide cez plural (sk: 1 vlákno / 2-4 vlákna / 5+ vlákien)
    expect(screen.getByText('2 vlákna v topicu')).toBeTruthy();
    expect(screen.getByTestId('topic-live-status').textContent).toBe('live: connecting');
  });

  it('detail zobrazí deti topicu a fixný topic v question composeri', async () => {
    renderApp({ route: `/topics/${LIVE_TOPIC_DETAIL.topic.slug}`, api: liveApi() });
    const childLink = await screen.findByTestId(`topic-child-${LIVE_TOPIC_DETAIL.children[0]?.slug ?? ''}`);
    expect(childLink.getAttribute('href')).toBe(`/topics/${LIVE_TOPIC_DETAIL.children[0]?.slug}`);

    const fixed = await screen.findByTestId('composer-topic-fixed');
    expect(fixed.textContent).toContain(LIVE_TOPIC_DETAIL.topic.slug);
    expect(screen.getByTestId('topic-composer').textContent).toContain('polož otázku v tomto topicu');
  });
});

describe('TopicPage — empty a error stavy', () => {
  it('topic bez vlákien ukáže empty stav s hintom na composer', async () => {
    const api = liveApi({
      topic: async (slug) => ({ ...detailFor(slug), threads: [], thread_count: 0 }),
    });
    renderApp({ route: '/topics/empty-topic', api });
    const empty = await screen.findByTestId('state-empty');
    expect(empty.textContent).toContain('zatiaľ nie je vlákno');
    // composer na vloženie otázky aj tak ostáva
    expect(screen.getByTestId('topic-composer')).toBeTruthy();
  });

  it('404 `topic not found` sa zobrazí ako error s reasonom a retry', async () => {
    const api = liveApi({
      topic: async () => {
        throw new ApiError('topic not found (404)', 404, { ok: false, error: 'topic not found', slug: 'x' }, '/topics/x');
      },
    });
    renderApp({ route: '/topics/nonexistent-xyz', api });
    const error = await screen.findByTestId('state-error');
    expect(error.textContent).toContain('topic not found');
    await waitFor(() => expect(api.topic).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /skúsiť znova/i })).toBeTruthy();
  });
});
