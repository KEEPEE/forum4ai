/**
 * Testy write-gate UI (dizajn B10): hook `useWriteStatus`, read-only
 * banner a zamknutý composer/modal. `fetch` je mocknutý na najnižšej
 * vrstve — `createApi({ fetch: jsonFetch(...) })`, takže test drží
 * SKUTOČNÝ tvar telieska gateway (`{ok, pubkey, allowed, reason, via,
 * operator}` z `register-routes.ts`) a overí aj URL requestu.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { JSX } from 'react';

import { ReadOnlyBanner } from '../src/components/ReadOnlyBanner.js';
import { Composer } from '../src/components/Composer.js';
import { NewIdeaModal } from '../src/components/NewIdeaModal.js';
import { HOW_IT_WORKS_SLUG, WRITE_STATUS_UNAVAILABLE, useWriteStatus } from '../src/hooks/useWriteStatus.js';
import { createApi } from '../src/api/client.js';
import { renderApp, renderWithProviders } from './render.js';
import { TEST_PUBKEY, WRITE_STATUS_DENIED, WRITE_STATUS_PENDING, jsonFetch, stubApi } from './fixtures.js';
import type { WriteStatusResponse } from '../src/api/types.js';

/** komponent-ponorka: vypíše stav hooku ako JSON (testy ho parsovali) */
function WriteStatusProbe(): JSX.Element {
  const write = useWriteStatus();
  return (
    <div data-testid="probe">
      {JSON.stringify({
        pubkey: write.pubkey,
        kind: write.kind,
        allowed: write.allowed,
        locked: write.locked,
        reason: write.reason,
        via: write.via,
      })}
    </div>
  );
}

function probeState(): { pubkey: string | null; kind: string; allowed: boolean; locked: boolean; reason: string | null } {
  return JSON.parse(String(screen.getByTestId('probe').textContent)) as {
    pubkey: string | null;
    kind: string;
    allowed: boolean;
    locked: boolean;
    reason: string | null;
  };
}

describe('useWriteStatus (GET /write-status)', () => {
  it('vráti allowed/reason z fetchu a pýta sa na pubkey podpisovateľa', async () => {
    const fetchMock = jsonFetch(200, {
      ok: true,
      pubkey: TEST_PUBKEY,
      allowed: false,
      reason: 'pubkey is not in the operator list',
      via: 'none',
      operator: null,
    });
    renderWithProviders(<WriteStatusProbe />, {
      api: createApi({ baseUrl: 'http://gateway.test', fetch: fetchMock }),
    });

    await waitFor(() => {
      expect(probeState().kind).toBe('denied');
    });
    expect(probeState().allowed).toBe(false);
    expect(probeState().locked).toBe(true);
    expect(probeState().reason).toBe('pubkey is not in the operator list');
    // request: GET {gateway}/write-status?pubkey=<hex podpisovateľa>
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(`http://gateway.test/write-status?pubkey=${TEST_PUBKEY}`);
  });

  it('allowed:true odomkne composer a reason je reason gatewayu', async () => {
    const fetchMock = jsonFetch(200, {
      ok: true,
      pubkey: TEST_PUBKEY,
      allowed: true,
      reason: 'registered active operator',
      via: 'operator',
      operator: TEST_PUBKEY,
    });
    renderWithProviders(<WriteStatusProbe />, {
      api: createApi({ baseUrl: 'http://gateway.test', fetch: fetchMock }),
    });

    await waitFor(() => {
      expect(probeState().kind).toBe('allowed');
    });
    expect(probeState().allowed).toBe(true);
    expect(probeState().locked).toBe(false);
    expect(probeState().reason).toBe('registered active operator');
  });

  it('zlyhanie fetchu = fail-closed s neutrálnym reason (banner nesmie klamať)', async () => {
    renderWithProviders(<WriteStatusProbe />, {
      api: createApi({
        baseUrl: 'http://gateway.test',
        fetch: async () => {
          throw new Error('offline');
        },
      }),
    });

    await waitFor(() => {
      expect(probeState().kind).toBe('unavailable');
    });
    expect(probeState().allowed).toBe(false);
    expect(probeState().locked).toBe(true);
    expect(probeState().reason).toBe(WRITE_STATUS_UNAVAILABLE);
    // neutrálny reason neobsahuje tvrdenie o používáčovi
    expect(String(probeState().reason)).not.toContain('nie je operátor');
  });
});

describe('ReadOnlyBanner (B10)', () => {
  it('ukáže text + odkaz na topic, keď gateway zamietol zápis', async () => {
    renderWithProviders(<ReadOnlyBanner />, { api: stubApi({ writeStatus: async () => WRITE_STATUS_DENIED }) });

    const banner = await screen.findByTestId('write-banner');
    // F4AI-23: copy viaže na `code` (WG_NOT_REGISTERED), nie na vetu gatewayu
    expect(banner.textContent).toContain('Zatiaľ nemáš prístup písať');
    expect(banner.textContent).toContain('ako sa pripojiť');
    const link = screen.getByTestId('write-banner-link');
    expect(link.getAttribute('href')).toBe(`/topics/${HOW_IT_WORKS_SLUG}`);
    // CTA podľa kódu: neregistrovaný vedie KAM (F4AI-22 registrácia)
    expect(screen.getByTestId('write-banner-cta').getAttribute('href')).toBe('/register');
    // reason gatewayu nie je zmetený — pri známom kóde je v `title`
    // (banner má našu copy, ale dôvod gatewayu sa dá overiť)
    expect(banner.getAttribute('title')).toContain('is not in the operator list');
    expect(screen.queryByTestId('write-banner-reason')).toBeNull();
  });

  it('WG_PENDING povie, že čaká na VLASTNÍKA (nie „skús to neskôr“)', async () => {
    // write-status má len `{allowed, reason, code, via, operator}` —
    // claim_id/relay NIE SU SOUČASŤOU, preto copy nesmie sľubovať hodnotu,
    // ktorú nemáme (detailNoValue variant)
    renderWithProviders(<ReadOnlyBanner />, { api: stubApi({ writeStatus: async () => WRITE_STATUS_PENDING }) });

    const banner = await screen.findByTestId('write-banner');
    expect(banner.textContent).toContain('Registrácia čaká na schválenie');
    expect(banner.textContent).toContain('čaká vo fronte');
    expect(banner.textContent).toContain('vlastník inštancie');
    // žiadna vyfabrikovaná hodnota ani nezasypaný placeholder
    expect(banner.textContent ?? '').not.toContain('{claimId');
    expect(screen.getByTestId('write-banner-cta').getAttribute('href')).toBe('/register');
  });

  it('neznámy kód dostane aspoň reason gatewayu (fallback, nie prázdna veta)', async () => {
    const future = { ...WRITE_STATUS_DENIED, code: 'WG_ZBUDNA' } as unknown as WriteStatusResponse;
    renderWithProviders(<ReadOnlyBanner />, { api: stubApi({ writeStatus: async () => future }) });

    const banner = await screen.findByTestId('write-banner');
    expect(banner.textContent).toContain('Zapisovanie nie je povolené');
    expect(String(screen.getByTestId('write-banner-reason').textContent)).toContain(
      'pubkey is not in the operator list',
    );
  });

  it('je skrytý, keď je povolené písať', async () => {
    renderWithProviders(<ReadOnlyBanner />);
    await waitFor(() => {
      expect(screen.queryByTestId('write-banner')).toBeNull();
    });
  });

  it('dismissible: krížik banner skryje', async () => {
    renderWithProviders(<ReadOnlyBanner />, { api: stubApi({ writeStatus: async () => WRITE_STATUS_DENIED }) });
    await screen.findByTestId('write-banner');
    fireEvent.click(screen.getByTestId('write-banner-dismiss'));
    await waitFor(() => {
      expect(screen.queryByTestId('write-banner')).toBeNull();
    });
  });

  it('pri nedostupnom statusi ukáže neutrálny text, nie dôvod operátora', async () => {
    renderWithProviders(<ReadOnlyBanner />, {
      api: createApi({
        baseUrl: 'http://gateway.test',
        fetch: async () => {
          throw new Error('offline');
        },
      }),
    });

    await screen.findByTestId('write-banner');
    expect(screen.getByTestId('write-banner-note').textContent).toContain('write status unavailable');
    expect(screen.queryByTestId('write-banner-reason')).toBeNull();
  });

  it('banner je nad obsahom stránky (App shell), nie len v composeri', async () => {
    renderApp({ api: stubApi({ writeStatus: async () => WRITE_STATUS_DENIED }), route: '/ideas' });
    await screen.findByTestId('write-banner');
    // B10: aj tlačidlo „nová idea“ je zamknuté
    expect((screen.getByTestId('new-idea-open') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('composer / modal gating (B10)', () => {
  it('composer je zamknutý pri allowed=false a title vysvetľuje prečo', async () => {
    renderWithProviders(<Composer />, { api: stubApi({ writeStatus: async () => WRITE_STATUS_DENIED }) });

    await screen.findByTestId('composer-locked');
    const textarea = screen.getByLabelText('text') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.title).toContain('pubkey is not in the operator list');
    expect((screen.getByLabelText('nadpis') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('composer-topic') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId('composer-submit-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('composer-sign-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('modal novej idey je zamknutý pri allowed=false', async () => {
    renderWithProviders(<NewIdeaModal onClose={() => undefined} onPublished={() => undefined} />, {
      api: stubApi({ writeStatus: async () => WRITE_STATUS_DENIED }),
    });

    await screen.findByTestId('new-idea-locked');
    expect((screen.getByTestId('new-idea-title') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('new-idea-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});
