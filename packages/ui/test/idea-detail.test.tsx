/**
 * Testy detailu `/ideas/:id` (F4AI-19, S13) — render z LIVE fixture
 * (`live-idea-detail.json` — realný claimed row so status_history +
 * suggestion), timeline záznamov, claim flow cez Signer mock → POST
 * /events s ocekavanymi `d`/`a` tagmi, nelegaly claim disabled a
 * autorovo potvrdenie claimu.
 *
 * PITS (S12): nostr-tools podpis NIE je deterministicky (auxRand) —
 * event overujeme `verifyEvent` + prepoctom id, nie porovnanim sig.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';

import { renderApp } from './render.js';
import {
  SAMPLE_IDEA_DETAIL,
  SAMPLE_IDEA_DETAIL_CONFIRM,
  SAMPLE_IDEA_DETAIL_DONE,
  SAMPLE_IDEA_DETAIL_PROGRESS,
  SAMPLE_PUBLISH,
  TEST_PUBKEY,
  hexId,
  stubApi,
} from './fixtures.js';
import { LIVE_IDEA_DETAIL, LIVE_IDEA_ID } from './fixtures/live.js';
import { ApiError } from '../src/api/client.js';
import type { PublishableEvent } from '../src/api/types.js';

function detailRoute(id: string): string {
  return `/ideas/${id}`;
}

function tagValue(event: PublishableEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

describe('IdeaDetailPage — live fixture (GET /ideas/:id)', () => {
  it('renderne realnu myslienku: titulek, status pill, claimant, timeline so note', async () => {
    const api = stubApi({ idea: async () => LIVE_IDEA_DETAIL });
    renderApp({ route: detailRoute(LIVE_IDEA_ID), api });
    expect(await screen.findByText(LIVE_IDEA_DETAIL.title)).toBeTruthy();
    expect(screen.getByTestId('detail-status-pill').textContent).toBe('claimed');
    expect(screen.getByTestId('detail-claimant').textContent).toContain('kanonický claimant');
    const history = screen.getByTestId('status-history');
    expect(history.querySelectorAll('[data-testid="timeline-entry"]')).toHaveLength(
      LIVE_IDEA_DETAIL.status_history.length,
    );
    expect(history.textContent).toContain('potvrdeny claim od agenta');
  });

  it('realna suggestion (in_progress od cudzieho pubkey) je vypisana v sekcii navrhy', async () => {
    const api = stubApi({ idea: async () => LIVE_IDEA_DETAIL });
    renderApp({ route: detailRoute(LIVE_IDEA_ID), api });
    const suggestions = await screen.findByTestId('suggestions-section');
    expect(suggestions.querySelectorAll('[data-testid="timeline-entry"]')).toHaveLength(1);
    expect(suggestions.textContent).toContain('návrh od');
  });

  it('claimed row: Claim je disabled — claimed→claimed nie je prechod (samoprechod)', async () => {
    const api = stubApi({ idea: async () => LIVE_IDEA_DETAIL });
    renderApp({ route: detailRoute(LIVE_IDEA_ID), api });
    const claimBtn = (await screen.findByTestId('claim-btn')) as HTMLButtonElement;
    expect(claimBtn.disabled).toBe(true);
    expect(screen.getByTestId('claim-disabled-reason').textContent).toContain('zhodný stav');
  });
});

describe('IdeaDetailPage — timeline a rating (SAMPLE fixtures)', () => {
  it('in_progress detail: 2 polozky timeline (claimed → in_progress) + rating agregat', async () => {
    const api = stubApi({ idea: async () => SAMPLE_IDEA_DETAIL_PROGRESS });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL.id), api });
    const history = await screen.findByTestId('status-history');
    const entries = history.querySelectorAll('[data-testid="timeline-entry"]');
    expect(entries).toHaveLength(2);
    expect(history.textContent).toContain('beriem si to');
    expect(screen.getByTestId('rating-aggregate').textContent).toContain('4.40/5');
    expect(screen.getByTestId('rating-badge').textContent).toBe('★ 4.40 (2)');
  });

  it('empty status_history vysvetli implicitny open status', async () => {
    const api = stubApi({ idea: async () => SAMPLE_IDEA_DETAIL });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL.id), api });
    const history = await screen.findByTestId('status-history');
    expect(history.textContent).toContain('implicitný `open`');
  });
});

describe('IdeaDetailPage — claim flow (Signer → POST /events)', () => {
  it('legalny claim (open→claimed): 10030 s d=id idey, a=tvuj pubkey, JSON status claimed', async () => {
    const api = stubApi({ idea: async () => SAMPLE_IDEA_DETAIL, publish: async () => SAMPLE_PUBLISH });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL.id), api });
    const claimBtn = (await screen.findByTestId('claim-btn')) as HTMLButtonElement;
    expect(claimBtn.disabled).toBe(false);
    fireEvent.click(claimBtn);

    await waitFor(() => {
      expect(vi.mocked(api.publish)).toHaveBeenCalledTimes(1);
    });
    const event = vi.mocked(api.publish).mock.calls[0]![0];
    expect(event.kind).toBe(10030);
    expect(tagValue(event, 'd')).toBe(SAMPLE_IDEA_DETAIL.id);
    expect(tagValue(event, 'a')).toBe(TEST_PUBKEY);
    expect(JSON.parse(event.content)).toMatchObject({ status: 'claimed' });
    // PITS S12: podpis je nedeterministicky — overujeme verifyEvent + id hash
    expect(verifyEvent(event as never)).toBe(true);
    expect(event.pubkey).toBe(TEST_PUBKEY);

    // po publishi: note + invalidate/refetch (druhe volanie api.idea)
    expect(await screen.findByTestId('claim-note')).toBeTruthy();
    await waitFor(() => {
      expect(vi.mocked(api.idea)).toHaveBeenCalledTimes(2);
    });
  });

  it('nelegalny claim (in_progress→claimed): disabled + dovod v tooltipu aj hintu', async () => {
    const api = stubApi({ idea: async () => SAMPLE_IDEA_DETAIL_PROGRESS });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL_PROGRESS.id), api });
    const claimBtn = (await screen.findByTestId('claim-btn')) as HTMLButtonElement;
    await waitFor(() => {
      expect(claimBtn.disabled).toBe(true);
    });
    const reason = screen.getByTestId('claim-disabled-reason').textContent ?? '';
    expect(reason).toContain("'in_progress' → 'claimed' nie je v automate");
    expect(claimBtn.title).toContain('nie je v automate');
    expect(vi.mocked(api.publish)).not.toHaveBeenCalled();
  });

  it('finalny stav done: claim disabled s dovodom finálny stav', async () => {
    const api = stubApi({ idea: async () => SAMPLE_IDEA_DETAIL_DONE });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL_DONE.id), api });
    const claimBtn = (await screen.findByTestId('claim-btn')) as HTMLButtonElement;
    await waitFor(() => {
      expect(claimBtn.disabled).toBe(true);
    });
    expect(screen.getByTestId('claim-disabled-reason').textContent).toContain('finálny stav');
  });

  it('publish 400 → claim-error s reasonmi gateway, bez reloadu', async () => {
    const api = stubApi({
      idea: async () => SAMPLE_IDEA_DETAIL,
      publish: async () => {
        throw new ApiError('invalid', 400, { ok: false, error: 'invalid event', reasons: ['claimed vyzaduje a tag'] }, '/events');
      },
    });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL.id), api });
    fireEvent.click(await screen.findByTestId('claim-btn'));
    const error = await screen.findByTestId('claim-error');
    expect(error.textContent).toContain('a tag');
    expect(vi.mocked(api.idea)).toHaveBeenCalledTimes(1);
  });
  // ── regression D1/D5 ─────────────────────────────────────────────────────
  it('claim pomenúva pubkey SKUTOČNÉHO signera (extension), nie uloženú identitu', async () => {
    // F4AI-23: relácia môže byť NIP-07. `a` tag menuje claimanta, takže
    // MUSÍ sedieť s pubkeyom, ktorý SKUTOČNE podpísal — nie s tým, čo
    // niekedy skončilo v úložisku. `nsec: null` + injectnutý provider =
    // v relácii je iba extension.
    const sk = generateSecretKey();
    const nip07Pubkey = getPublicKey(sk);
    const nip07 = {
      getPublicKey: async () => nip07Pubkey,
      signEvent: async (event: Record<string, unknown>) => {
        const signed = finalizeEvent(
          {
            kind: Number(event['kind']),
            content: String(event['content']),
            tags: event['tags'] as string[][],
            created_at: Number(event['created_at']),
          },
          sk,
        );
        return { ...event, id: signed.id, sig: signed.sig };
      },
    };
    const api = stubApi({ idea: async () => SAMPLE_IDEA_DETAIL, publish: async () => SAMPLE_PUBLISH });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL.id), api, nsec: null, nip07 });

    const claimBtn = (await screen.findByTestId('claim-btn')) as HTMLButtonElement;
    await waitFor(() => {
      expect(claimBtn.disabled).toBe(false);
    });
    fireEvent.click(claimBtn);
    await waitFor(() => {
      expect(vi.mocked(api.publish)).toHaveBeenCalledTimes(1);
    });
    const event = vi.mocked(api.publish).mock.calls[0]![0];
    // D1: `a` tag menuje claimanta — musí to byť ten, kto SKUTOČNE podpisuje
    expect(event.pubkey).toBe(nip07Pubkey);
    expect(tagValue(event, 'a')).toBe(nip07Pubkey);
    expect(tagValue(event, 'a')).not.toBe(TEST_PUBKEY);
    expect(verifyEvent(event as never)).toBe(true);
  });
});

describe('IdeaDetailPage — autor potvrzuje claim', () => {
  it('autor + claimed navrh: potvrdit claim publishne 10030 s a-tagom na claimanta navrho', async () => {
    const api = stubApi({ idea: async () => SAMPLE_IDEA_DETAIL_CONFIRM, publish: async () => SAMPLE_PUBLISH });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL_CONFIRM.id), api });
    const confirmBtn = (await screen.findByTestId('confirm-claim-btn')) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(vi.mocked(api.publish)).toHaveBeenCalledTimes(1);
    });
    const event = vi.mocked(api.publish).mock.calls[0]![0];
    expect(event.kind).toBe(10030);
    expect(tagValue(event, 'd')).toBe(SAMPLE_IDEA_DETAIL_CONFIRM.id);
    expect(tagValue(event, 'a')).toBe(hexId('c6'));
    expect(verifyEvent(event as never)).toBe(true);
  });

  it('nie autor: sekcia potvrdenia sa nezobrazi (cudzia identita)', async () => {
    const api = stubApi({
      idea: async () => ({ ...SAMPLE_IDEA_DETAIL_CONFIRM, author: hexId('c4') }),
    });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL_CONFIRM.id), api });
    await screen.findByTestId('claim-btn');
    expect(screen.queryByTestId('author-confirm')).toBeNull();
  });

  it('autor bez navrhu: potvrdit claim disabled (niel co potvrdit)', async () => {
    const api = stubApi({ idea: async () => SAMPLE_IDEA_DETAIL });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL.id), api });
    const confirmBtn = (await screen.findByTestId('confirm-claim-btn')) as HTMLButtonElement;
    await waitFor(() => {
      expect(confirmBtn.disabled).toBe(true);
    });
    expect(confirmBtn.title).toContain('ziadny claimed navrh');
  });
});

describe('IdeaDetailPage — chyby a navigacia', () => {
  it('404 idea not found ukaze error panel s reason', async () => {
    const api = stubApi({
      idea: async () => {
        throw new ApiError('idea not found', 404, { ok: false, error: 'idea not found', reason: '1021 nie je v indexe' }, '/ideas/x');
      },
    });
    renderApp({ route: detailRoute(hexId('f9')), api });
    const error = await screen.findByTestId('state-error');
    expect(error.textContent).toContain('idea not found');
  });

  it('breadcrumbs odkazu spat na /ideas board', async () => {
    const api = stubApi({ idea: async () => SAMPLE_IDEA_DETAIL });
    renderApp({ route: detailRoute(SAMPLE_IDEA_DETAIL.id), api });
    const crumbs = await screen.findByTestId('idea-detail-body');
    expect(crumbs).toBeTruthy();
    const back = document.querySelector<HTMLAnchorElement>('nav[aria-label="breadcrumbs"] a[href="/ideas"]');
    expect(back).not.toBeNull();
  });
});
