/**
 * Smoke test skutočného entry pointu (S11, F4AI-17 → F4AI-23, Phase 1b).
 *
 * Testy vyššie renderujú `<App/>` obalenú providermi sami — takže by
 * prešlo aj keby `main.tsx` zabudol naviesť `IdentityProvider` (a v S11
 * to naozaj chýbalo: header bez npub, composer „nebolo nájdené“). Tento
 * test importne `src/main.tsx` tak, ako ho volá browser.
 *
 * Phase 1b mení OČAKÁVANIE: entry point už nevygeneruje kľúč. Preto
 * testujeme oba stavy, ktoré reálne nastanú:
 *  1. s NIP-07 extensionom → v headeru je npub + označenie pozadia,
 *  2. bez neho → NÁVŠTEVNÍK JE ANONYM (čítať sa dá, header ponúkne
 *     „prihlásiť“) — žiadny ticho vygenerovaný kľúč v `localStorage`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools/pure';
import { screen, waitFor } from '@testing-library/react';

import { identityFromNsec } from '../src/nostr/keys.js';
import type { Nip07Provider } from '../src/nostr/signer.js';
import { TEST_NSEC, TEST_PUBKEY } from './fixtures.js';

const SECRET = identityFromNsec(TEST_NSEC).secretKey;
const scope = globalThis as unknown as { window: { nostr?: Nip07Provider } };

/** extension podpisujúci našim testovacím kľúčom (aby `verifyEvent` prešiel) */
function installNip07(): void {
  scope.window.nostr = {
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

/** `main.js` je module-cache — každý test potrebuje nový `#root` a reset */
function mountEntry(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  return root;
}

describe('main.tsx (entry point)', () => {
  afterEach(() => {
    document.getElementById('root')?.remove();
    scope.window.nostr = undefined;
    // bez resetModules by druhý import bol cache-nutý `main.js` a
    // `createRoot` by sa už nevolal
    vi.resetModules();
  });

  it('s NIP-07 extensionom navia App s IdentityProviderom — npub je vo headeri', async () => {
    mountEntry();
    installNip07();

    await import('../src/main.js');

    const chip = await screen.findByTestId('identity-npub', {}, { timeout: 4000 });
    expect(chip.textContent).toMatch(/npub1[02-9a-z]{5,}/);
    // pozadie je súčasť identity (F4AI-23) — nie je jedno, ČÍM podpisujeme
    expect(screen.getByTestId('identity-source').textContent).toBe('extension');
    // shell a routa sú na mieste
    expect(await screen.findByTestId('page-outlet')).toBeTruthy();
    await waitFor(() => {
      // Phase 3a: default témy je glass-dark (emerald + gold), nie nexaverse
      expect(document.documentElement.getAttribute('data-theme')).toBe('glass-dark');
    });
  });

  it('bez extensionu je návštevník anonym — header ponúkne prihlásenie (F4AI-23)', async () => {
    mountEntry();

    await import('../src/main.js');

    // žiadny chip: kľúč sa NEVYGENERUJE, čítať sa dá aj bez neho
    const login = await screen.findByTestId('login-open', {}, { timeout: 4000 });
    expect(screen.queryByTestId('identity-npub')).toBeNull();
    expect(login.textContent).toContain('prihlásiť');
    // a nič sa nezapísalo do úložiska — to bola podstata auto-keygen bugu
    expect(globalThis.localStorage.getItem('forum4ai_nsec')).toBeNull();
  });
});
