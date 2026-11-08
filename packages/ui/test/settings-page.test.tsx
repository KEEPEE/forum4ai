/**
 * Testy panela „Členovia a agenti“ (F4AI-24, Phase 1b — `/settings`).
 *
 * Panel je READ-ONLY a musí byť ÚPLNÝ: ukáže to, čo vlastník publikoval
 * do kind 30028 (`d=forum4ai-writers`, `d=agents`), a to, čo o nás vie
 * write-gate. Nič z toho nevymýšľame:
 *  1. pýtame sa na 30028 PRAVO od prihláseného pubkey (iný vlastník
 *     nemôže niekomu inemu ukázať jeho zoznam),
 *  2. bez záznamu povieme „ešte nič“, NIE „si člen“,
 *  3. varovania parsera (neplatný pubkey, neznámy role marker) sa
 *     ukážu — tichá korekcia dát je horšia ako chybové hlásenie,
 *  4. write-gate rozhodnutie ostáva vedľa, lebo 30028 NIE JE zdroj
 *     oprávnenia (rozhoduje DB gatewayu).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { SettingsPage } from '../src/pages/SettingsPage.js';
import { AGENTS_D_TAG, WRITERS_D_TAG } from '../src/lib/members.js';
import { renderWithProviders } from './render.js';
import {
  SAMPLE_OWNER,
  SAMPLE_WRITE_STATUS,
  TEST_NPUB,
  TEST_PUBKEY,
  WRITE_STATUS_DENIED,
  hexId,
  stubApi,
} from './fixtures.js';
import type { EventSummary, RecentResponse } from '../src/api/types.js';

function summary(tags: string[][], created_at = 1_700_000_000): EventSummary {
  return { id: hexId('e'), pubkey: TEST_PUBKEY, created_at, kind: 30028, tags, content: '', sig: hexId('f') };
}

function recent(items: EventSummary[]): RecentResponse {
  return { phase: 'S8', kinds: [30028], limit: 16, count: items.length, items, authors: [TEST_PUBKEY] };
}

const MEMBER = hexId('b1');
const AGENT = hexId('c3');

const WRITERS = summary([['d', WRITERS_D_TAG], ['p', MEMBER, 'wss://relay.example', '1800000000']], 200);
const AGENTS = summary([['d', AGENTS_D_TAG], ['p', AGENT, '', 'agent']], 100);

describe('SettingsPage — identita a write-gate', () => {
  it('ukáže celý npub (tu sa dá kopírovať), pozadie a tlačidlo odpojenia', async () => {
    renderWithProviders(<SettingsPage />, { api: stubApi() });
    await screen.findByTestId('settings-page');
    const npub = screen.getByTestId('settings-npub');
    // na nastaveniach JE miesto na celý kľúč (na opýtanie si účtu);
    // naopak header/composer ho krátiť MUSIA
    expect(npub.textContent).toBe(TEST_NPUB);
    expect(npub.getAttribute('title')).toBe(TEST_NPUB);
    expect(screen.getByTestId('settings-source').textContent).toBe('dev nsec');

    fireEvent.click(screen.getByTestId('settings-disconnect'));
    expect(await screen.findByTestId('settings-anonymous')).toBeTruthy();
  });

  it('anonym nevidí zoznamy — najprv sa musí prihlásiť', async () => {
    renderWithProviders(<SettingsPage />, { api: stubApi(), nsec: null });
    const state = await screen.findByTestId('settings-anonymous');
    expect(state.textContent).toContain('prihlás');
    expect(screen.queryByTestId('settings-members')).toBeNull();
  });

  it('povolený zápis ukáže WG_OPERATOR copy a kód', async () => {
    renderWithProviders(<SettingsPage />, { api: stubApi({ writeStatus: async () => SAMPLE_WRITE_STATUS }) });
    const allowed = await screen.findByTestId('settings-write-allowed');
    expect((allowed.textContent ?? '').toLowerCase()).toContain('zapisuješ ako operátor');
    expect(screen.getByTestId('settings-write-code').textContent).toContain('WG_OPERATOR');
  });

  it('zamietnutý zápis ukáže copy podľa kódu a CTA na registráciu', async () => {
    renderWithProviders(<SettingsPage />, { api: stubApi({ writeStatus: async () => WRITE_STATUS_DENIED }) });
    const denied = await screen.findByTestId('settings-write-denied');
    expect(denied.textContent).toContain('Zatiaľ nemáš prístup písať');
    expect(screen.getByTestId('settings-write-code').textContent).toContain('WG_NOT_REGISTERED');
  });
});

describe('SettingsPage — členovia a agenti (30028)', () => {
  it('pýta sa 30028 od VLASTNÉHO pubkey (nie od hocikoho)', async () => {
    const api = stubApi({ recent: async () => recent([WRITERS, AGENTS]) });
    renderWithProviders(<SettingsPage />, { api });
    await screen.findByTestId('settings-writers-list');

    const args = (api.recent as unknown as { mock: { calls: [Record<string, unknown> | undefined][] } }).mock
      .calls[0]?.[0];
    expect(args?.['kinds']).toEqual([30028]);
    expect(args?.['authors']).toEqual([TEST_PUBKEY]);
  });

  it('ukáže členov s relayom a expiráciou a agentov s rolou', async () => {
    const api = stubApi({ recent: async () => recent([WRITERS, AGENTS]) });
    renderWithProviders(<SettingsPage />, { api });

    const writers = await screen.findByTestId('settings-writers-list');
    expect(writers.textContent).toContain('člen');
    expect(screen.getByTestId(`settings-writers-expiry-${MEMBER}`)).toBeTruthy();

    const agents = await screen.findByTestId('settings-agents-list');
    expect(agents.textContent).toContain('agent');
    expect(screen.getByTestId(`settings-agents-role-${AGENT}`).textContent).toBe('agent');
  });

  it('bez 30028 záznamu povie „ešte nič“ (nie „si člen“)', async () => {
    const api = stubApi({ recent: async () => recent([]) });
    renderWithProviders(<SettingsPage />, { api });

    const writersEmpty = await screen.findByTestId('settings-writers-empty');
    expect(writersEmpty.textContent).toContain('nepublikoval');
    expect(screen.getByTestId('settings-agents-empty').textContent).toContain('žiadni agenti');
    // write-gate rozhodnutie ostáva viditeľné vedľa
    expect(screen.getByTestId('settings-write-allowed')).toBeTruthy();
  });

  it('varovania parsera sa ukážu (neznámy role marker nie je tichá korekcia)', async () => {
    const odd = summary([['d', AGENTS_D_TAG], ['p', AGENT, '', 'moderator']]);
    const api = stubApi({ recent: async () => recent([WRITERS, odd]) });
    renderWithProviders(<SettingsPage />, { api });

    const warnings = await screen.findByTestId('settings-agents-warnings');
    expect(warnings.textContent).toContain('neznámy role marker');
  });

  it('z dvoch verzií listu ukáže najnovšiu', async () => {
    const older = summary([['d', WRITERS_D_TAG], ['p', hexId('b9')]], 100);
    const api = stubApi({ recent: async () => recent([older, WRITERS]) });
    renderWithProviders(<SettingsPage />, { api });

    // staršia verzia (b9…) sa v zobrazení vôbec neobjaví
    await screen.findByTestId(`settings-writers-entry-${MEMBER}`);
    expect(screen.queryByTestId(`settings-writers-entry-${hexId('b9')}`)).toBeNull();
    // čas poslednej editácie sa ukáže, aby bolo jasné, ktorú verziu čítame
    expect(screen.getByTestId('settings-writers-updated').textContent).toContain('publikované');
  });

  it('chyba fetchu nesklame — panel povie, že zoznam nevieme', async () => {
    const api = stubApi({
      recent: async () => {
        throw new Error('relay nedostupný');
      },
    });
    renderWithProviders(<SettingsPage />, { api });

    const error = await screen.findByTestId('settings-members-error');
    expect(error.textContent).toContain('nepodarilo načítať');
    expect(screen.queryByTestId('settings-writers-list')).toBeNull();
  });

  it('vlastník má odkaz na správu operátorov, bečný člen nie', async () => {
    const ownerApi = stubApi({ recent: async () => recent([WRITERS]), registerOwner: async () => SAMPLE_OWNER });
    const { unmount } = renderWithProviders(<SettingsPage />, { api: ownerApi });
    await screen.findByTestId('settings-writers-list');
    expect(screen.getByTestId('settings-admin-link').getAttribute('href')).toBe('/admin/operators');
    unmount();

    const memberApi = stubApi({
      recent: async () => recent([WRITERS]),
      registerOwner: async () => ({ ok: true, owner: hexId('d9') }),
    });
    renderWithProviders(<SettingsPage />, { api: memberApi });
    await screen.findByTestId('settings-writers-list');
    expect(screen.queryByTestId('settings-admin-link')).toBeNull();
  });

  it('panel je len čítať — žiadne tlačidlo „pridať člena“', async () => {
    const api = stubApi({ recent: async () => recent([WRITERS, AGENTS]) });
    renderWithProviders(<SettingsPage />, { api });
    await screen.findByTestId('settings-members');
    const buttons = screen
      .getByTestId('settings-members')
      .querySelectorAll('button');
    expect(buttons.length).toBe(0);
    // write-gate je autorita, nie 30028 — panel to povie výslovne
    await waitFor(() => expect(screen.getByTestId('settings-write')).toBeTruthy());
  });
});
