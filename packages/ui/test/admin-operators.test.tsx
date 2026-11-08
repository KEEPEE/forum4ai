/**
 * Testy stránky operátorov (F4AI-24, Phase 1b) — `/admin/operators`.
 *
 * Najdôležitejšie nie je renderovanie, ale to, že UI ROZHODUJE Cez
 * gateway:
 *  1. zoznam sa berie z `GET /register/pending` a je NIP-98 chránený,
 *  2. approve/revoke posiela TÁ ISTÁ telieska ako CLI (`{pubkey, note?}`)
 *     a podpisuje ich OWNER signer — test overí hlavičku `Authorization`
 *     a EXAKTNÉ raw telo, nie len to, že sa to nejako volalo,
 *  3. po akcii sa zoznam NECHÁ PREČÍTAŤ ZNOVA (UI nič nemarkne lokálne),
 *  4. 200 s varovaniami nie je zelená fajfka,
 *  5. chybové kódy (`NOT_OWNER`, `AUTH_NIP98_INVALID`, …) majú slovenskú
 *     vetu, nie surový kód.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { verifyEvent } from 'nostr-tools/pure';

import { AdminOperatorsPage, OWNER_ERROR_COPY } from '../src/pages/AdminOperatorsPage.js';
import { ApiError, type Api } from '../src/api/client.js';
import { KIND_AUTH_NIP98 } from '../src/nostr/nip98.js';
import { renderWithProviders } from './render.js';
import {
  SAMPLE_OPERATOR_ACTION,
  SAMPLE_OPERATORS,
  SAMPLE_OWNER,
  SAMPLE_PENDING,
  TEST_PUBKEY,
  stubApi,
} from './fixtures.js';
import type { NostrEvent } from '@forum4ai/shared';
import type { OperatorActionResultResponse, RegisterPendingResponse } from '../src/api/types.js';

const PENDING_PK = SAMPLE_OPERATORS[0]!.pubkey;
const ACTIVE_PK = SAMPLE_OPERATORS[1]!.pubkey;
const LAPSED_PK = SAMPLE_OPERATORS[2]!.pubkey;

/** decode `Authorization: Nostr <base64>` na event */
function signedEvent(api: Api, method: 'registerApprove' | 'registerRevoke'): {
  event: NostrEvent;
  rawBody: string;
  authorization: string;
} {
  const calls = (api[method] as unknown as { mock: { calls: [string, string][] } }).mock.calls;
  const call = calls[0];
  if (call === undefined) throw new Error(`${method} nebol zavolaný`);
  const [rawBody, authorization] = call;
  const json = Buffer.from(authorization.replace(/^Nostr /, ''), 'base64').toString('utf8');
  return { event: JSON.parse(json) as NostrEvent, rawBody, authorization };
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name).map((tag) => String(tag[1] ?? ''));
}

describe('AdminOperatorsPage — výpis', () => {
  it('renderuje pending/active/lapsed riadky so statusmi, claimom a agentmi', async () => {
    const api = stubApi();
    renderWithProviders(<AdminOperatorsPage />, { api });

    await screen.findByTestId('operators-table');
    expect(screen.getByTestId(`operator-row-${PENDING_PK}`)).toBeTruthy();
    expect(screen.getByTestId(`operator-status-${PENDING_PK}`).textContent).toBe('čaká');
    expect(screen.getByTestId(`operator-status-${ACTIVE_PK}`).textContent).toBe('aktívny');
    expect(screen.getByTestId(`operator-status-${LAPSED_PK}`).textContent).toBe('vypršaný');
    // claim + fail count (dôležité pre rozhodovanie)
    expect(screen.getByTestId(`operator-claim-${LAPSED_PK}`).textContent).toContain('…');
    expect(screen.getByTestId(`operator-fails-${LAPSED_PK}`).textContent).toBe('fail 3');
    // agenti: gateway v `agents[]` neoznačuje rolu → len chip s npub
    expect(screen.getByTestId(`operator-agents-${ACTIVE_PK}`).textContent).toContain('1');
    // súhrn berieme z `counts`, nie z dĺžky rows
    expect(screen.getByTestId('admin-owner').textContent).toContain('čaká 1 · aktívni 1 · vypršaní 1');
  });

  it('pending riadok má schváliť AJ vyradiť, aktívny len vyradiť', async () => {
    renderWithProviders(<AdminOperatorsPage />, { api: stubApi() });
    await screen.findByTestId('operators-table');
    expect(screen.getByTestId(`operator-approve-${PENDING_PK}`)).toBeTruthy();
    expect(screen.getByTestId(`operator-revoke-${PENDING_PK}`)).toBeTruthy();
    // aktívny už nie je čo schvaľovať
    expect(screen.queryByTestId(`operator-approve-${ACTIVE_PK}`)).toBeNull();
  });

  it('prázdny zoznam povie, kde sa registruje', async () => {
    const empty: RegisterPendingResponse = {
      ok: true,
      owner: TEST_PUBKEY,
      counts: { pending: 0, active: 0, lapsed: 0, revoked: 0 },
      operators: [],
    };
    renderWithProviders(<AdminOperatorsPage />, { api: stubApi({ registerPending: async () => empty }) });
    const emptyNote = await screen.findByTestId('admin-empty');
    expect(emptyNote.textContent).toContain('/register');
  });
});

describe('AdminOperatorsPage — NIP-98 podpis', () => {
  it('zoznam sa pýta s GET auth bez `payload` tagu', async () => {
    const api = stubApi();
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('operators-table');

    const event = decodePendingAuth(api);
    expect(event.kind).toBe(KIND_AUTH_NIP98);
    expect(tagValues(event, 'method')).toEqual(['GET']);
    expect(tagValues(event, 'u')).toEqual(['http://gateway.test/register/pending']);
    expect(tagValues(event, 'payload')).toEqual([]);
  });

  it('approve: raw telo je `{pubkey}` a `payload` tag = sha256 tohto tela', async () => {
    const api = stubApi();
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('operators-table');

    fireEvent.click(screen.getByTestId(`operator-approve-${PENDING_PK}`));
    await waitFor(() => expect(api.registerApprove).toHaveBeenCalledTimes(1));

    const { event, rawBody } = signedEvent(api, 'registerApprove');
    expect(JSON.parse(rawBody)).toEqual({ pubkey: PENDING_PK });
    expect(tagValues(event, 'u')).toEqual(['http://gateway.test/register/approve']);
    expect(tagValues(event, 'method')).toEqual(['POST']);
    const expectedHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    expect(tagValues(event, 'payload')).toEqual([expectedHash]);
    // podpis je vlastníkovej identity (inak 403 NOT_OWNER)
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(verifyEvent(event as never)).toBe(true);
  });

  it('revoke s poznámkou pošle `{pubkey, note}` (CLI-kompatibilné teliesko)', async () => {
    const api = stubApi();
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('operators-table');

    fireEvent.click(screen.getByTestId(`operator-revoke-${ACTIVE_PK}`));
    fireEvent.change(screen.getByTestId(`operator-note-${ACTIVE_PK}`), { target: { value: 'presun na iný relay' } });
    fireEvent.click(screen.getByTestId(`operator-revoke-confirm-${ACTIVE_PK}`));

    await waitFor(() => expect(api.registerRevoke).toHaveBeenCalledTimes(1));
    const { rawBody, event } = signedEvent(api, 'registerRevoke');
    expect(JSON.parse(rawBody)).toEqual({ pubkey: ACTIVE_PK, note: 'presun na iný relay' });
    expect(tagValues(event, 'u')).toEqual(['http://gateway.test/register/revoke']);
  });

  it('revoke BEZ poznámky neposleľa `note: ""` (gateway by dal 400)', async () => {
    const api = stubApi();
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('operators-table');

    fireEvent.click(screen.getByTestId(`operator-revoke-${ACTIVE_PK}`));
    fireEvent.click(screen.getByTestId(`operator-revoke-confirm-${ACTIVE_PK}`));
    await waitFor(() => expect(api.registerRevoke).toHaveBeenCalledTimes(1));
    expect(JSON.parse(signedEvent(api, 'registerRevoke').rawBody)).toEqual({ pubkey: ACTIVE_PK });
  });

  it('po akcii sa zoznam prečíta ZNOVA (UI nič nemarkne lokálne)', async () => {
    const api = stubApi();
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('operators-table');
    expect(api.registerPending).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId(`operator-approve-${PENDING_PK}`));
    await waitFor(() => expect(api.registerPending).toHaveBeenCalledTimes(2));
  });
});

describe('AdminOperatorsPage — výsledok akcie', () => {
  it('úspešné approve ukáže, na koľko relayov sa 30028 zverejnilo', async () => {
    const api = stubApi();
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('operators-table');

    fireEvent.click(screen.getByTestId(`operator-approve-${PENDING_PK}`));
    const flash = await screen.findByTestId('admin-flash');
    expect(flash.textContent).toContain('schválené');
    // Phase 2a: počet relayov ide cez plural (sk: 1 relay / 2-4 relaye / 5+ relayov)
    expect(flash.textContent).toContain('3/3 relaye');
  });

  it('200 s nevydaným zoznamom = VAROVANIE, nie zelená', async () => {
    const partial: OperatorActionResultResponse = {
      ...SAMPLE_OPERATOR_ACTION,
      // gateway pri neúspechu posiela len `{ok: false, reason}` —
      // `event_id`/`delivered` vynecháva, nie nuluje
      writers: { ok: false, reason: 'relay timeout' },
      warnings: ['LABEL 1040 preskočený'],
    };
    const api = stubApi({ registerApprove: async () => partial });
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('operators-table');

    fireEvent.click(screen.getByTestId(`operator-approve-${PENDING_PK}`));
    const flash = await screen.findByTestId('admin-flash');
    expect(flash.textContent).toContain('ale:');
    expect(flash.textContent).toContain('relay timeout');
    expect(flash.textContent).toContain('LABEL 1040 preskočený');
  });
});

describe('AdminOperatorsPage — chybové kódy', () => {
  it('NOT_OWNER z approve → slovenská veta (nie surový kód)', async () => {
    const api = stubApi({
      registerApprove: async () => {
        throw new ApiError('NOT_OWNER (403)', 403, { error: 'NOT_OWNER', reason: 'not the owner' }, '/register/approve');
      },
    });
    renderWithProviders(<AdminOperatorsPage />, { api });
    await screen.findByTestId('operators-table');

    fireEvent.click(screen.getByTestId(`operator-approve-${PENDING_PK}`));
    const flash = await screen.findByTestId('admin-flash');
    expect(flash.textContent).toContain(OWNER_ERROR_COPY.NOT_OWNER);
    expect(flash.textContent).toContain('not the owner');
  });

  it('AUTH_NIP98_INVALID pri načítaní → chybový stav s retry', async () => {
    const api = stubApi({
      registerPending: async () => {
        throw new ApiError('AUTH_NIP98_INVALID (401)', 401, { error: 'AUTH_NIP98_INVALID' }, '/register/pending');
      },
    });
    renderWithProviders(<AdminOperatorsPage />, { api });

    const error = await screen.findByTestId('admin-error');
    expect(error.textContent).toContain('nedostupný');
    expect(screen.getByTestId('admin-error-detail').textContent).toContain(OWNER_ERROR_COPY.AUTH_NIP98_INVALID);
    expect(screen.getByTestId('admin-retry').textContent).toContain('znova');
  });

  it('503 OWNER_NOT_CONFIGURED povie, prečo nikto neschvaľuje', async () => {
    const api = stubApi({
      registerPending: async () => {
        throw new ApiError('OWNER_NOT_CONFIGURED (503)', 503, { error: 'OWNER_NOT_CONFIGURED' }, '/register/pending');
      },
    });
    renderWithProviders(<AdminOperatorsPage />, { api });
    const state = await screen.findByTestId('admin-no-owner');
    expect(state.textContent).toContain('vlastníka');
  });
});

describe('AdminOperatorsPage — prístup', () => {
  it('anonym nevidí tabuľku, ale návod „prihlás sa kľúčom vlastníka“', async () => {
    renderWithProviders(<AdminOperatorsPage />, { api: stubApi(), nsec: null });
    const state = await screen.findByTestId('admin-no-signer');
    expect(state.textContent).toContain('vlastníka');
    expect(screen.queryByTestId('operators-table')).toBeNull();
  });

  it('kľúč, ktorý nie je vlastník, nedostane tlačidlá', async () => {
    const foreign: RegisterPendingResponse = { ...SAMPLE_PENDING, owner: 'd'.repeat(64) };
    const api = stubApi({
      registerPending: async () => foreign,
      registerOwner: async () => ({ ok: true, owner: 'd'.repeat(64) }),
    });
    renderWithProviders(<AdminOperatorsPage />, { api });
    const state = await screen.findByTestId('admin-not-owner');
    expect(state.textContent).toContain('vlastník');
    expect(screen.queryByTestId('operators-table')).toBeNull();
  });

  it('inštancia bez vlastníka (`owner: null`) je vlastný stav', async () => {
    const api = stubApi({
      registerOwner: async () => ({ ok: true, owner: null }),
      registerPending: async () => ({ ...SAMPLE_PENDING, owner: null }),
    });
    renderWithProviders(<AdminOperatorsPage />, { api });
    const state = await screen.findByTestId('admin-no-owner');
    expect(state.textContent).toContain('GATEWAY_OWNER_SK_HEX');
  });

  it('owner pubkey sa zobrazí ako npub, nie ako hex', async () => {
    renderWithProviders(<AdminOperatorsPage />, { api: stubApi({ registerOwner: async () => SAMPLE_OWNER }) });
    await screen.findByTestId('operators-table');
    const head = screen.getByTestId('admin-owner');
    expect(head.textContent).toContain('npub1');
    expect(head.textContent ?? '').not.toContain(TEST_PUBKEY);
  });
});

/** decode NIP-98 eventu z `api.registerPending` (GET) */
function decodePendingAuth(api: Api): NostrEvent {
  const calls = (api.registerPending as unknown as { mock: { calls: [string][] } }).mock.calls;
  const call = calls[0];
  if (call === undefined) throw new Error('registerPending nebol zavolaný');
  const json = Buffer.from(call[0].replace(/^Nostr /, ''), 'base64').toString('utf8');
  return JSON.parse(json) as NostrEvent;
}
