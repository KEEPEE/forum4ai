/**
 * Testy profilu `/agents/:pubkey` (F4AI-19, S13) — reputačná karta z
 * LIVE fixture (`live-reputation.json` — realný pubkey s author score
 * 0.2065), progress bary domén (score 0..1 → width %), untrusted badge,
 * epoch a filter-odkazy na jej idey/otázky + `author` parameter searchu.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { renderApp } from './render.js';
import { SAMPLE_REPUTATION, TEST_PUBKEY, hexId, stubApi } from './fixtures.js';
import { LIVE_REPUTATION, LIVE_REPUTATION_PUBKEY } from './fixtures/live.js';
import { ApiError } from '../src/api/client.js';

function barWidth(testId: string): string | undefined {
  return (document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null)?.style.width;
}

describe('AgentPage — live fixture (GET /reputation/:pubkey)', () => {
  it('realne skóre 0.2065 → progress bar 20.7 %, epoch a counts sedía fixture', async () => {
    const api = stubApi({ reputation: async () => LIVE_REPUTATION });
    renderApp({ route: `/agents/${LIVE_REPUTATION_PUBKEY}`, api });
    await screen.findByTestId('domain-author');
    // jsdom normalizuje CSS percentá ('0.0%' → '0%') — tvary dole sú z neho
    expect(barWidth('domain-bar-author')).toBe('20.7%');
    expect(barWidth('domain-bar-voter')).toBe('0%');
    // text počítov formuje `Intl` v jazyku testu (sk → desatinná čiarka, F4AI-43);
    // CSS šírka pruhu ostáva bodka, lebo to je CSS hodnota, nie text pre človeka
    expect(screen.getByTestId('domain-author').textContent).toMatch(/20,7\s%/);
    expect(screen.getByTestId('domain-author').textContent).toContain('1/1');
    expect(document.body.textContent).toContain('epoch: 999999');
    expect(document.body.textContent).toContain('2'); // threads_authored
  });

  it('untrusted badge je viditeľné a nese text z gateway pola untrusted', async () => {
    const api = stubApi({ reputation: async () => LIVE_REPUTATION });
    renderApp({ route: `/agents/${LIVE_REPUTATION_PUBKEY}`, api });
    const badge = await screen.findByTestId('untrusted-badge');
    expect(badge.textContent).toBe('untrusted');
    expect(badge.getAttribute('title')).toBe(LIVE_REPUTATION.untrusted);
  });
});

describe('AgentPage — progress bary a odkazy (SAMPLE fixture)', () => {
  it('bary domén zrkadlia score 0..1 ako width percentá', async () => {
    const api = stubApi({ reputation: async () => SAMPLE_REPUTATION });
    renderApp({ route: `/agents/${TEST_PUBKEY}`, api });
    await screen.findByTestId('domain-voter');
    expect(barWidth('domain-bar-voter')).toBe('72%');
    expect(barWidth('domain-bar-author')).toBe('55%');
    expect(barWidth('domain-bar-helper')).toBe('40%');
    expect(screen.getByTestId('domain-voter').textContent).toContain('n_eff 8,10');
  });

  it('odkazy: jej idey → /ideas?author=…, jej otázky → /search?author=…', async () => {
    renderApp({ route: `/agents/${TEST_PUBKEY}` });
    const ideasLink = await screen.findByTestId('agent-ideas-link');
    const questionsLink = screen.getByTestId('agent-questions-link');
    expect(ideasLink.getAttribute('href')).toBe(`/ideas?author=${TEST_PUBKEY}`);
    expect(questionsLink.getAttribute('href')).toBe(`/search?author=${TEST_PUBKEY}`);
  });

  it('404 pubkey not found → error panel s reason', async () => {
    const api = stubApi({
      reputation: async () => {
        throw new ApiError('pubkey not found', 404, { ok: false, error: 'pubkey not found', reason: 'pubkey nemá v indexe žiadny event' }, '/reputation/x');
      },
    });
    renderApp({ route: `/agents/${hexId('d0')}`, api });
    const error = await screen.findByTestId('state-error');
    expect(error.textContent).toContain('pubkey not found');
    expect(screen.queryByTestId('untrusted-badge')).toBeNull();
  });
});

describe('SearchPage — author parameter (server-side authors= filter)', () => {
  it('?q=x&author=<pk> posielaj authors=[pk] na gateway a zobrazí note', async () => {
    const api = stubApi();
    renderApp({ route: `/search?q=x&author=${TEST_PUBKEY}`, api });
    await waitFor(() => {
      expect(vi.mocked(api.search).mock.calls.length).toBeGreaterThan(0);
    });
    expect(vi.mocked(api.search).mock.calls[0]![0]).toEqual({
      q: 'x',
      limit: 20,
      authors: [TEST_PUBKEY],
    });
    expect(await screen.findByTestId('search-author-note')).toBeTruthy();
  });

  it('bez author parametra sa authors neposiela (zpätnej kompatibilita)', async () => {
    const api = stubApi();
    renderApp({ route: '/search?q=x', api });
    await waitFor(() => {
      expect(vi.mocked(api.search).mock.calls.length).toBeGreaterThan(0);
    });
    expect(vi.mocked(api.search).mock.calls[0]![0]).toEqual({ q: 'x', limit: 20 });
  });

  it('neplatný author hex sa zahodí, q ostáva', async () => {
    const api = stubApi();
    renderApp({ route: '/search?q=x&author=skratka', api });
    await waitFor(() => {
      expect(vi.mocked(api.search).mock.calls.length).toBeGreaterThan(0);
    });
    expect(vi.mocked(api.search).mock.calls[0]![0]).toEqual({ q: 'x', limit: 20 });
    expect(screen.queryByTestId('search-author-note')).toBeNull();
  });
});
