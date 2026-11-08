/**
 * Testy login modalu (F4AI-23, Phase 1b) — výber podpisového pozadia.
 *
 * Kľúčové pravidlá, ktoré strážime:
 *  1. tab `nsec` sa v produkcii NEZOBRAZÍ (gate `VITE_ALLOW_NSEC`),
 *  2. NIP-07 je default a po úspechu sa modal ZAVRIE (header vidí výsldeok),
 *  3. zamietnutý prístup nenechá používáča čakať — chyba ostáva v modale,
 *  4. NIP-46: kľúč konzumenta putuje do `localStorage`, KOREŇOVÝ kľúč
 *     nikdy (stránka ho ani nevidí),
 *  5. dev nsec → `sessionStorage`, nikdy `localStorage`.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { finalizeEvent } from 'nostr-tools/pure';

import { Header } from '../src/components/Header.js';
import { LoginModal } from '../src/components/LoginModal.js';
import { BUNKER_STORAGE_KEY, SIGNER_STORAGE_KEY } from '../src/nostr/IdentityContext.js';
import { NSEC_STORAGE_KEY, createMemoryStorage, identityFromNsec } from '../src/nostr/keys.js';
import type { BunkerModuleLike, Nip07Provider } from '../src/nostr/signer.js';
import { renderWithProviders } from './render.js';
import { TEST_NSEC, TEST_PUBKEY, hexId } from './fixtures.js';

const SECRET = identityFromNsec(TEST_NSEC).secretKey;

/** NIP-07 provider podpisujúci testovacím kľúčom (aby `verifyEvent` prešiel) */
function makeNip07(options: { reject?: boolean } = {}): Nip07Provider {
  if (options.reject === true) {
    return {
      getPublicKey: async () => {
        throw new Error('prístup zamietnutý v extenzii');
      },
      signEvent: async (event) => event,
    };
  }
  return {
    getPublicKey: async () => TEST_PUBKEY,
    signEvent: async (event) => {
      const signed = finalizeEvent(
        {
          kind: Number(event['kind']),
          content: String(event['content']),
          tags: event['tags'] as string[][],
          created_at: Number(event['created_at']),
        },
        SECRET,
      );
      return { ...event, id: signed.id, sig: signed.sig };
    },
  };
}

/** falošný NIP-46 modul — žiadna sieť, podpisuje lokálnym kľúčom */
function makeBunkerModule(): BunkerModuleLike {
  return {
    parseBunkerInput: async (input) =>
      input.startsWith('bunker://') ? { relays: ['wss://relay.example'], pubkey: hexId('b1'), secret: 's' } : null,
    BunkerSigner: {
      fromBunker: () => ({
        connect: async () => undefined,
        getPublicKey: async () => TEST_PUBKEY,
        signEvent: async (event) => {
          const signed = finalizeEvent(
            { kind: event.kind, content: event.content, tags: event.tags, created_at: event.created_at },
            SECRET,
          );
          return { id: signed.id, sig: signed.sig };
        },
      }),
    },
  };
}

const BUNKER_URI = 'bunker://abc?relay=wss://relay.example&secret=x';

describe('LoginModal — gate dev cesty', () => {
  it('bez `VITE_ALLOW_NSEC` sa tab s nsec NEZOBRAZÍ', () => {
    renderWithProviders(<LoginModal onClose={() => undefined} />, { nsec: null, allowNsec: false });
    expect(screen.getByTestId('login-tab-nip07')).toBeTruthy();
    expect(screen.getByTestId('login-tab-bunker')).toBeTruthy();
    expect(screen.queryByTestId('login-tab-nsec')).toBeNull();
  });

  it('s povoleným dev režimom pribudne tretí tab', () => {
    renderWithProviders(<LoginModal onClose={() => undefined} />, { nsec: null, allowNsec: true });
    expect(screen.getByTestId('login-tab-nsec').textContent).toContain('dev');
  });

  it('default tab je extension (dizajn Q1)', () => {
    renderWithProviders(<LoginModal onClose={() => undefined} />, { nsec: null });
    expect(screen.getByTestId('login-tab-nip07').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('login-nip07-btn').textContent).toContain('extension');
  });
});

describe('LoginModal — NIP-07', () => {
  it('úspešné pripojenie zavrie modal a header ukáže `extension`', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <>
        <Header />
        <LoginModal onClose={onClose} />
      </>,
      { nsec: null, nip07: makeNip07() },
    );

    fireEvent.click(screen.getByTestId('login-nip07-btn'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // header (cez provider) vidí výsledok — nie lokálny state modalu
    expect(screen.getByTestId('identity-source').textContent).toBe('extension');
    expect(screen.getByTestId('identity-npub').textContent).toContain('npub1');
  });

  it('zamietnutý prístup: chyba ostáva v modale, modal sa nezavrie', async () => {
    const onClose = vi.fn();
    renderWithProviders(<LoginModal onClose={onClose} />, { nsec: null, nip07: makeNip07({ reject: true }) });

    fireEvent.click(screen.getByTestId('login-nip07-btn'));
    const error = await screen.findByTestId('login-error');
    expect(error.textContent).toContain('zamietnutý');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('bez extensionu hint povie ČO nainštalovať (nie „nefunguje to“)', () => {
    renderWithProviders(<LoginModal onClose={() => undefined} />, { nsec: null, nip07: null });
    expect(screen.getByTestId('login-nip07-hint').textContent).toContain('Alby');
  });
});

describe('LoginModal — NIP-46 bunker', () => {
  it('pripojenie bunkra nastaví pozadie a uloží LEN kľúč konzumenta', async () => {
    const onClose = vi.fn();
    const storage = createMemoryStorage();
    renderWithProviders(
      <>
        <Header />
        <LoginModal onClose={onClose} />
      </>,
      { nsec: null, bunkerModule: makeBunkerModule(), storage },
    );

    fireEvent.click(screen.getByTestId('login-tab-bunker'));
    fireEvent.change(screen.getByTestId('login-bunker-uri'), { target: { value: BUNKER_URI } });
    // tlačidlo je zamknuté, kým nie je vložený odkaz
    fireEvent.click(screen.getByTestId('login-bunker-btn'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('identity-source').textContent).toBe('bunker');
    // predvoľba + session prežívajú reload, ale KOREŇOVÝ kľúč nie —
    // v zázname je iba pubkey bunkra a kľúč konzumenta
    expect(storage.getItem(SIGNER_STORAGE_KEY)).toBe('bunker');
    const record = storage.getItem(BUNKER_STORAGE_KEY);
    expect(record).toContain('bunker://');
    expect(record ?? '').not.toContain(TEST_NSEC);
    expect(record ?? '').not.toContain(SECRET);
  });

  it('tlačidlo je zamknuté bez odkazu (aby sme neposielali prázdny connect)', () => {
    renderWithProviders(<LoginModal onClose={() => undefined} />, { nsec: null });
    fireEvent.click(screen.getByTestId('login-tab-bunker'));
    expect((screen.getByTestId('login-bunker-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('neplatný odkaz → chyba v modale, žiadne tiché ticho', async () => {
    const onClose = vi.fn();
    renderWithProviders(<LoginModal onClose={onClose} />, { nsec: null, bunkerModule: makeBunkerModule() });
    fireEvent.click(screen.getByTestId('login-tab-bunker'));
    fireEvent.change(screen.getByTestId('login-bunker-uri'), { target: { value: 'https://zle.example' } });
    fireEvent.click(screen.getByTestId('login-bunker-btn'));
    expect((await screen.findByTestId('login-error')).textContent).toContain('bunker');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('LoginModal — dev nsec', () => {
  it('kľúč ide do `sessionStorage`, NIE do `localStorage`', async () => {
    const onClose = vi.fn();
    const session = createMemoryStorage();
    const local = createMemoryStorage();
    renderWithProviders(<LoginModal onClose={onClose} />, {
      nsec: null,
      allowNsec: true,
      sessionStorage: session,
      storage: local,
    });

    fireEvent.click(screen.getByTestId('login-tab-nsec'));
    fireEvent.change(screen.getByTestId('login-nsec-input'), { target: { value: TEST_NSEC } });
    fireEvent.click(screen.getByTestId('login-nsec-btn'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(session.getItem(NSEC_STORAGE_KEY)).toBe(identityFromNsec(TEST_NSEC).nsec);
    expect(local.getItem(NSEC_STORAGE_KEY)).toBeNull();
    // normalizácia: aj surový hex sa ukladá ako `nsec1…`
    expect(String(session.getItem(NSEC_STORAGE_KEY))).toMatch(/^nsec1/);
  });

  it('pokiaľ gate nevypnem, nsec sa nikam nedostane', async () => {
    const session = createMemoryStorage();
    renderWithProviders(<LoginModal onClose={() => undefined} />, {
      nsec: null,
      allowNsec: false,
      sessionStorage: session,
    });
    // tab nie je viditeľný → ani náhodným vložením sa nsec nepoužije
    expect(screen.queryByTestId('login-nsec-input')).toBeNull();
    expect(session.getItem(NSEC_STORAGE_KEY)).toBeNull();
  });
});
