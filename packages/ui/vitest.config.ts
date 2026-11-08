import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest 5 + Testing Library (S11, F4AI-17).
 *
 * `jsdom` je potrebný pre render komponent (`render()` z @testing-library/react
 * vyžaduje DOM). Siete v testoch nechávame zatvorené: REST vrstva berie
 * `fetch` ako parameter (injectable), takže testy nepotrebujú MSW ani live
 * gateway — len injectnú mock funkciu.
 *
 * Pozn.: Vitest uprednostňuje tento súbor pred `vite.config.ts` a NEMERGEJE
 * ich, preto tu opakujeme aj React plugin (JSX transform pre .tsx testy).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    // CSS importy v komponentách testom stačí ignorovať (tokeny testujeme
    // čítaním súboru z disku — test/tokens.test.ts).
    css: false,
  },
});
