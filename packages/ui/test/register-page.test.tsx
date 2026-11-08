/**
 * Testy stránky registrácie (F4AI-22 → Phase 1b, `/register`).
 *
 * Registrácia je to, kam vedú CTA z `WG_NOT_REGISTERED` / `WG_LAPSED`,
 * preto je súčasťou login slicu. Režim je ten, ktorý drží backend
 * (`gateway/src/register-routes.ts`, F4AI-22):
 *  1. `GET /register/challenge` → nonce + exp,
 *  2. KLIENT podpíše claim kind 1055 (tagy `challenge`, `exp`, `relay`,
 *     `gateway`) — žiadne heslo, žiadny serverový účet,
 *  3. `POST /register` → `status: pending`, rozhoduje vlastník,
 *  4. UI po odoslaní OPÄTU prečíta status a write-status (rozhodnutie
 *     nemarkujeme lokálne).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { verifyEvent } from 'nostr-tools/pure';

import { KIND_OPERATOR_CLAIM, RegisterPage } from '../src/pages/RegisterPage.js';
import { ApiError, type Api } from '../src/api/client.js';
import { renderWithProviders } from './render.js';
import {
  REGISTER_STATUS_UNREGISTERED,
  SAMPLE_REGISTER_CHALLENGE,
  SAMPLE_REGISTER_CLAIM,
  SAMPLE_REGISTER_STATUS,
  TEST_PUBKEY,
  WRITE_STATUS_DENIED,
  stubApi,
} from './fixtures.js';
import type { NostrEvent } from '@forum4ai/shared';

const RELAY = 'wss://muj-relay.example';

function claimEvent(api: Api): NostrEvent {
  const calls = (api.registerClaim as unknown as { mock: { calls: NostrEvent[][] } }).mock.calls;
  const sent = calls[0]?.[0];
  if (sent === undefined) throw new Error('registerClaim nebol zavolaný');
  return sent;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  const tag = event.tags.find((entry) => entry[0] === name);
  return tag?.[1] as string | undefined;
}

async function submitClaim(api: Api): Promise<void> {
  await screen.findByTestId('register-form');
  fireEvent.change(screen.getByTestId('register-relay'), { target: { value: RELAY } });
  fireEvent.click(screen.getByTestId('register-submit'));
  await waitFor(() => expect(api.registerClaim).toHaveBeenCalledTimes(1));
}

describe('RegisterPage — prihlásenie', () => {
  it('anonym nedostane formulár — claim nemá kto podpísať', async () => {
    renderWithProviders(<RegisterPage />, { api: stubApi(), nsec: null });
    const state = await screen.findByTestId('register-anonymous');
    expect(state.textContent).toContain('1055');
    expect(screen.queryByTestId('register-form')).toBeNull();
  });

  it('pýta sa challenge na VLASTNÝ pubkey', async () => {
    const api = stubApi();
    renderWithProviders(<RegisterPage />, { api });
    await submitClaim(api);
    expect(api.registerChallenge).toHaveBeenCalledWith(TEST_PUBKEY);
  });
});

describe('RegisterPage — claim kind 1055', () => {
  it('podpíše 1055 s tagmi challenge/exp/relay/gateway a platným podpisom', async () => {
    const api = stubApi();
    renderWithProviders(<RegisterPage />, { api });
    await submitClaim(api);

    const event = claimEvent(api);
    expect(event.kind).toBe(KIND_OPERATOR_CLAIM);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(tagValue(event, 'challenge')).toBe(SAMPLE_REGISTER_CHALLENGE.nonce);
    expect(tagValue(event, 'exp')).toBe(String(SAMPLE_REGISTER_CHALLENGE.exp));
    expect(tagValue(event, 'relay')).toBe(RELAY);
    // `gateway` tag musí sedieť s inštanciou, nie s doménou používáča
    expect(tagValue(event, 'gateway')).toBe('gateway.test');
    expect(verifyEvent(event as never)).toBe(true);
  });

  it('po odoslaní ukáže result a znova si prečíta status aj write-status', async () => {
    const api = stubApi();
    renderWithProviders(<RegisterPage />, { api });
    await submitClaim(api);

    const result = await screen.findByTestId('register-result');
    expect(result.textContent).toContain('čaká');
    // status sa NEMARKNE lokálne — volá sa `GET /register/status` znova
    await waitFor(() => expect(api.registerStatus).toHaveBeenCalledTimes(2));
  });

  it('relay je povinný (gateway ho overuje na relayi, nehádžeme ho za používáča)', async () => {
    const api = stubApi();
    renderWithProviders(<RegisterPage />, { api });
    await screen.findByTestId('register-form');
    expect((screen.getByTestId('register-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('register-relay-hint').textContent).toContain('relay');
  });
});

describe('RegisterPage — chyby', () => {
  it('gateway bez challenge povie, že registrácia je vypnutá', async () => {
    const api = stubApi({
      registerChallenge: async () => ({ ok: false } as Awaited<ReturnType<Api['registerChallenge']>>),
    });
    renderWithProviders(<RegisterPage />, { api });
    await screen.findByTestId('register-form');
    fireEvent.change(screen.getByTestId('register-relay'), { target: { value: RELAY } });
    fireEvent.click(screen.getByTestId('register-submit'));

    const error = await screen.findByTestId('register-error');
    expect(error.textContent).toContain('challenge');
    expect(api.registerClaim).not.toHaveBeenCalled();
  });

  it('400 od gatewayu → reasons z telieska, nie surový status', async () => {
    const api = stubApi({
      registerClaim: async () => {
        throw new ApiError('BAD_REQUEST (400)', 400, { error: 'BAD_REQUEST', reason: 'relay nie je dosiahnuteľný' }, '/register');
      },
    });
    renderWithProviders(<RegisterPage />, { api });
    await submitClaim(api).catch(() => undefined);

    const error = await screen.findByTestId('register-error');
    expect(error.textContent).toContain('relay nie je dosiahnuteľný');
  });

  it('claim vráti `ok: false` → veta z `next` (gateway vie prečo)', async () => {
    const api = stubApi({
      registerClaim: async () => ({ ...SAMPLE_REGISTER_CLAIM, ok: false, next: 'claim už čaká vo fronte' }),
    });
    renderWithProviders(<RegisterPage />, { api });
    await submitClaim(api);
    expect((await screen.findByTestId('register-error')).textContent).toContain('už čaká vo fronte');
  });
});

describe('RegisterPage — kde som', () => {
  it('pending status ukáže štítok „čaká“ a dôvod (vlastník rozhoduje)', async () => {
    const api = stubApi();
    renderWithProviders(<RegisterPage />, { api });
    const status = await screen.findByTestId('register-status');
    expect(screen.getByTestId('register-status-label').textContent).toBe('čaká');
    // dôvod je v `title` — text riadku patrí dátumu expirácie, nie vete
    const detail = status.querySelector('[title]');
    expect(detail?.getAttribute('title')).toContain('vlastník');
  });

  it('neznámy kľúč povie, že claim ešte nebol poslaný', async () => {
    // kontrakt: `status: "unregistered"` (žiadne `known`, žiadne 404)
    const api = stubApi({ registerStatus: async () => REGISTER_STATUS_UNREGISTERED });
    renderWithProviders(<RegisterPage />, { api });
    expect(await screen.findByTestId('register-unknown')).toBeTruthy();
    expect(screen.queryByTestId('register-status')).toBeNull();
  });

  it('status route zlyhá → stránka stále funguje (status nie je kritický)', async () => {
    const api = stubApi({
      registerStatus: async () => {
        throw new Error('502');
      },
    });
    renderWithProviders(<RegisterPage />, { api });
    await screen.findByTestId('register-form');
    expect(screen.queryByTestId('register-status')).toBeNull();
    expect(screen.getByTestId('register-write-copy')).toBeTruthy();
  });

  it('copy write-gate je podľa kódu — neregistrovaný vidí, ČO má urobiť', async () => {
    const api = stubApi({ writeStatus: async () => WRITE_STATUS_DENIED });
    renderWithProviders(<RegisterPage />, { api });
    const copy = await screen.findByTestId('register-write-copy');
    expect(copy.textContent).toContain('Zatiaľ nemáš prístup písať');
  });

  it('npub je skrátený, celý je v `title`', async () => {
    renderWithProviders(<RegisterPage />, { api: stubApi({ registerStatus: async () => SAMPLE_REGISTER_STATUS }) });
    const npub = await screen.findByTestId('register-npub');
    expect(npub.textContent).toContain('…');
    expect(npub.getAttribute('title')).toMatch(/^npub1/);
  });
});
