/**
 * Testy modalu "Nová idea" (F4AI-19, S13) — kind 1021 publish cez
 * `POST /events` s `title` tagom + `t` tagmi topicov, checkbox
 * "publikujem ako agent" (F1 heuristika filtru), validácia titulu,
 * chyba publishu a invalidácia boardu po úspechu.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { verifyEvent } from 'nostr-tools/pure';

import { renderApp } from './render.js';
import { SAMPLE_PUBLISH, stubApi } from './fixtures.js';
import { ApiError } from '../src/api/client.js';
import type { PublishableEvent } from '../src/api/types.js';

function openModal(api = stubApi()) {
  const result = renderApp({ route: '/ideas', api });
  return { ...result, api };
}

async function fill(title: string, text: string, topics: string): Promise<void> {
  fireEvent.change(await screen.findByTestId('new-idea-title'), { target: { value: title } });
  fireEvent.change(screen.getByTestId('new-idea-text'), { target: { value: text } });
  fireEvent.change(screen.getByTestId('new-idea-topics'), { target: { value: topics } });
}

function tagsOf(event: PublishableEvent): string[][] {
  return event.tags.map((tag) => [...tag]);
}

describe('NewIdeaModal', () => {
  it('tlačidlo + nová idea otvorí modal a zrušenie ho zavrie', async () => {
    const { api } = openModal();
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getByTestId('new-idea-open'));
    expect(await screen.findByTestId('new-idea-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-idea-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('new-idea-modal')).toBeNull();
    });
    expect(vi.mocked(api.publish)).not.toHaveBeenCalled();
  });

  it('publikácia pošle 1021 s title tagom a t tagmi topicov, potom refetchne board', async () => {
    const api = stubApi({ publish: async () => SAMPLE_PUBLISH });
    const { api: bound } = openModal(api);
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getByTestId('new-idea-open'));
    await fill('Agent na audit L2', 'popis auditu', 'rust, nostr-agents');
    fireEvent.click(screen.getByTestId('new-idea-submit'));

    await waitFor(() => {
      expect(vi.mocked(bound.publish)).toHaveBeenCalledTimes(1);
    });
    const event = vi.mocked(bound.publish).mock.calls[0]![0];
    expect(event.kind).toBe(1021);
    // F4AI-2b2: NIP-32 label = jazyk rozhrania; testy bežia so `lng: 'sk'`
    // (`test/setup.ts`), preto tu očakávame `sk`, nie default `en`.
    expect(tagsOf(event)).toEqual([
      ['title', 'Agent na audit L2'],
      ['t', 'rust'],
      ['t', 'nostr-agents'],
      ['L', 'ISO-639-1'],
      ['l', 'sk', 'ISO-639-1'],
    ]);
    expect(event.content).toBe('popis auditu');
    expect(verifyEvent(event as never)).toBe(true);

    // modal sa zavrel a board sa invalidoval (druhe volanie api.ideas)
    await waitFor(() => {
      expect(screen.queryByTestId('new-idea-modal')).toBeNull();
    });
    await waitFor(() => {
      expect(vi.mocked(bound.ideas)).toHaveBeenCalledTimes(2);
    });
  });

  it('checkbox publikujem ako agent pridá t tag agent', async () => {
    const api = stubApi({ publish: async () => SAMPLE_PUBLISH });
    const { api: bound } = openModal(api);
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getByTestId('new-idea-open'));
    await fill('Agentská myšlienka', 'text', 'dsgn');
    fireEvent.click(screen.getByTestId('new-idea-agent-check'));
    fireEvent.click(screen.getByTestId('new-idea-submit'));
    await waitFor(() => {
      expect(vi.mocked(bound.publish)).toHaveBeenCalledTimes(1);
    });
    const event = vi.mocked(bound.publish).mock.calls[0]![0];
    expect(tagsOf(event)).toContainEqual(['t', 'agent']);
  });

  it('prázdny titulok → chyba a žiadny publish', async () => {
    const { api } = openModal();
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getByTestId('new-idea-open'));
    await fill('', 'len text', 'x');
    fireEvent.click(screen.getByTestId('new-idea-submit'));
    const error = await screen.findByTestId('new-idea-error');
    expect(error.textContent).toContain('vyžaduje názov');
    expect(vi.mocked(api.publish)).not.toHaveBeenCalled();
    expect(screen.getByTestId('new-idea-modal')).toBeTruthy();
  });

  it('publish 400 → error s reasonmi, modal zostáva otvorený', async () => {
    const api = stubApi({
      publish: async () => {
        throw new ApiError('invalid', 400, { ok: false, error: 'invalid event', reasons: ['kind 1021 nie je v registry'] }, '/events');
      },
    });
    const { api: bound } = openModal(api);
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getByTestId('new-idea-open'));
    await fill('Dobra', 'text', '');
    fireEvent.click(screen.getByTestId('new-idea-submit'));
    const error = await screen.findByTestId('new-idea-error');
    expect(error.textContent).toContain('registry');
    expect(vi.mocked(bound.ideas)).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('new-idea-modal')).toBeTruthy();
  });

  it('kvórum nesplnené (424 ok false) → error veta, bez invalidácie', async () => {
    const api = stubApi({
      publish: async () => ({
        ok: false,
        event_id: 'e'.repeat(64),
        quorum_met: false,
        results: [{ url: 'ws://relay', ok: false, message: 'timeout' }],
        error: 'quorum not met',
      }),
    });
    const { api: bound } = openModal(api);
    await screen.findByTestId('ideas-board');
    fireEvent.click(screen.getByTestId('new-idea-open'));
    await fill('Kvoruum', 'text', '');
    fireEvent.click(screen.getByTestId('new-idea-submit'));
    const error = await screen.findByTestId('new-idea-error');
    expect(error.textContent).toContain('quorum not met');
    expect(vi.mocked(bound.ideas)).toHaveBeenCalledTimes(1);
  });
});
