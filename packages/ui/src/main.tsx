/**
 * Entry point (S11, F4AI-17). Poradie importov je dôležité:
 *  1. fonty (self-hostované `@fontsource` — žiadny Google Fonts request,
 *     šablóna tm-603 ich ťahala z CDN, my ich distribujeme s bundle),
 *  2. `tokens.css` (design tokeny 3 tém: glass-dark / glass-light /
 *     nexaverse — kópia tokenov tm-603 + palety tm-607),
 *  3. `base.css` (reset, vrstvené pozadie, typografia, a11y, tlač),
 *  4. `app.css` (layout shell postavený na tokenoch),
 *  5. `components.css` (bohatšie komponenty — importované POSLEDNÉ,
 *     preto prepíšu `app.css` bez premenovania jedinej triedy),
 *  6. `setupI18n()` — jazyk sa musí vyriešiť pred prvým renderom.
 *
 * Chyba „chýba #root“ je boot error VOLANÝ pred i18n initom, preto
 * zostáva technický reťazec v kóde (nie je to text UI).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import '@fontsource-variable/syne';
import '@fontsource/outfit/300.css';
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/500.css';
import '@fontsource/outfit/600.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/components.css';

import { App } from './App.js';
import { IdentityProvider } from './nostr/IdentityContext.js';
import { applyTheme, readTheme } from './lib/theme.js';
import { setupI18n } from './i18n/index.js';

// tému aplikujeme pred prvým renderom, aby sa neblinulo tmavou verziou
applyTheme(readTheme());

const container = document.getElementById('root');
if (container === null) {
  throw new Error('v index.html chýba element #root');
}

// `IdentityProvider` je nad `App`: Header ukazuje npub a Composer podpisuje
// — bez neho by `useIdentity()` vrátilo prázdnu identitu (test entry.test.tsx
// kontroluje práve toto, lebo testy renderujú Appku s providerom samy).
// i18n pred prvým renderom (Phase 2a): EN je v bundle, `sk` si vyžiada
// lazy chunk. Jazyk musí byť známy skôr, než komponenty zavolajú `t()`,
// inak by prvý render ukázal kľúče. `setupI18n` je idempotentný — test
// entry.test.tsx má i18n predpriadaný z `test/setup.ts` a nesmie sa
// prepísať detekciou.
void setupI18n().then(() => {
  createRoot(container).render(
    <StrictMode>
      <BrowserRouter>
        <IdentityProvider>
          <App />
        </IdentityProvider>
      </BrowserRouter>
    </StrictMode>,
  );
});
