/**
 * Test setup (S11 → F4AI-18/S12). RTL 16 nerobí auto-cleanup bez
 * `globals: true` (vitest config tu necháva vypnuté, aby testy
 * importovali `describe/it` explicitne), preto voláme `cleanup()` ručne.
 * `localStorage` v jsdom prežíva medzi testami — mažeme ho, inak by si
 * navzájom liezli do cesty testy identity a témy.
 *
 * S12:
 *  - `globalThis.WebSocket` dosadíme `FakeWebSocket` — stránky volajú
 *    `useLiveFeed()` s defaultným konštruktorom a skutočné WS na
 *    `ws://gateway.test/ws` by v jsdomu zlyhávalo + reconnect timery
 *    by prežívali test. Testy live hooku injectnú vlastný fake.
 *  - `window.nostr` mažeme po každom teste (NIP-07 mocky si ho stavajú
 *    samy a nesmú uniesť do ďalšieho testu).
 *
 * Phase 2a (i18n):
 *  - i18n sa inicializuje TU, synchronne a s `lng: 'sk'` — resources
 *    pre EN aj SK sú importované priamo (`test/i18n.ts`), takže sa
 *    backend vôbec nevolá a testy nečakajú na žiadny dynamic import.
 *    Vďaka tomu existujúce aserty na slovenský text zostávajú bez zmien.
 *  - `detection` je v testoch vypnuté (žiadne čítanie ani zápis do
 *    `localStorage`), aby testy identity/temy nevideli jazykový kľúč.
 *  - po každom teste vrátime jazyk na `sk` (test prepínača jazyka ho
 *    mení), inak by si navzájom liezli do cesty.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

import { i18n, initI18n } from '../src/i18n/index.js';
import { FakeWebSocket, resetFakeSockets } from './fake-ws.js';
import { TEST_LANG, TEST_RESOURCES } from './i18n.js';

// jsdom 30 WebSocket síce má, ale pre testy ho chceme deterministický
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

// top-level await: setupFiles sa vyhodnotia skôr, než test importuje
// komponenty (moduly volajú `i18n.t()` už pri module scope getters)
await initI18n(i18n, {
  lng: TEST_LANG,
  resources: TEST_RESOURCES,
  detection: { order: [], caches: [] },
});

afterEach(() => {
  cleanup();
  globalThis.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  const scope = globalThis as unknown as { window?: { nostr?: unknown } };
  if (scope.window !== undefined) delete scope.window.nostr;
  resetFakeSockets();
  return i18n.changeLanguage(TEST_LANG);
});
