/**
 * Render helper (S11, F4AI-17 → F4AI-23/24, Phase 1b): obalí strom
 * providermi, ktoré appka potrebuje (ApiProvider s mock klientom,
 * IdentityProvider s memory úložiskom, MemoryRouter na cestu), a vráti
 * výsledok Testing Library.
 *
 * Phase 1b pridáva vstupy pre RELÁCIU, nie len pre kľúč:
 *  - `nsec: null` → anonym (žiadna predpriadaná identita; pred Phase 1b
 *    sa tu ticho vygeneroval náhodný kľúč, čo testy maskovali),
 *  - `nip07` → falošný `window.nostr` bez siahanie do globálneho scope,
 *  - `bunkerModule` → falošný NIP-46 modul (test bunkra bez siete),
 *  - `allowNsec` → gate dev nsec nezávislý od env,
 *  - `sessionStorage` → memory úložisko pre dev kľúč.
 *
 * `storage`/`sessionStorage` rozlišujú `undefined` (default memory
 * úložisko) od `null` (úložisko NEEXISTUJE — SSR / Safari private mode).
 */
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';

import { ApiProvider } from '../src/api/ApiContext.js';
import { IdentityProvider } from '../src/nostr/IdentityContext.js';
import { createMemoryStorage, identityFromNsec, type Identity, type KeyStorage } from '../src/nostr/keys.js';
import type { BunkerModuleLike, Nip07Provider } from '../src/nostr/signer.js';
import { stubApi, TEST_NSEC } from './fixtures.js';
import type { Api } from '../src/api/client.js';
import { App } from '../src/App.js';

export interface RenderOptions {
  api?: Api;
  route?: string;
  /** `localStorage`-like; `null` = úložisko neexistuje */
  storage?: KeyStorage | null;
  /** `sessionStorage`-like; `null` = úložisko neexistuje */
  sessionStorage?: KeyStorage | null;
  /** predpriadaná dev identita; `null` = anonym (žiadny kľúč) */
  nsec?: string | null;
  /** falošný `window.nostr` (test NIP-07 bez globálu) */
  nip07?: Nip07Provider | null;
  /** falošný NIP-46 modul (test bunkra bez siete) */
  bunkerModule?: BunkerModuleLike;
  /** gate dev nsec tabu; default `nsecAllowed()` z env */
  allowNsec?: boolean;
  /** lehota detekcie NIP-07; default 0 = test nesmie čakať na extension */
  nip07TimeoutMs?: number;
}

/** props pre `IdentityProvider` — jedna implementencia pre App aj komponent */
function providerProps(options: RenderOptions): {
  storage: KeyStorage | null;
  sessionStorage: KeyStorage | null;
  identity?: Identity;
  nip07?: Nip07Provider | null;
  bunkerModule?: BunkerModuleLike;
  allowNsec?: boolean;
  nip07TimeoutMs: number;
} {
  const nsec = options.nsec === undefined ? TEST_NSEC : options.nsec;
  return {
    storage: options.storage === undefined ? createMemoryStorage() : options.storage,
    sessionStorage: options.sessionStorage === undefined ? createMemoryStorage() : options.sessionStorage,
    ...(nsec === null ? {} : { identity: identityFromNsec(nsec) }),
    ...(options.nip07 !== undefined ? { nip07: options.nip07 } : {}),
    ...(options.bunkerModule !== undefined ? { bunkerModule: options.bunkerModule } : {}),
    ...(options.allowNsec !== undefined ? { allowNsec: options.allowNsec } : {}),
    nip07TimeoutMs: options.nip07TimeoutMs ?? 0,
  };
}

export function renderApp(options: RenderOptions = {}): RenderResult & { api: Api } {
  const api = options.api ?? stubApi();

  const result = render(
    <MemoryRouter initialEntries={[options.route ?? '/']}>
      <ApiProvider client={api}>
        <IdentityProvider {...providerProps(options)}>
          <App />
        </IdentityProvider>
      </ApiProvider>
    </MemoryRouter>,
  );
  return { ...result, api };
}

/** komponent bez celého layoutu (Header/Sidebar/Composer samostatne) */
export function renderWithProviders(ui: ReactElement, options: RenderOptions = {}): RenderResult & { api: Api } {
  const api = options.api ?? stubApi();

  const result = render(
    <MemoryRouter initialEntries={[options.route ?? '/']}>
      <ApiProvider client={api}>
        <IdentityProvider {...providerProps(options)}>
          {ui}
        </IdentityProvider>
      </ApiProvider>
    </MemoryRouter>,
  );
  return { ...result, api };
}
