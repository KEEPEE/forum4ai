import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Playwright report/výstupy sú generované artefakty (minifikovaný JS) —
    // `pnpm test:e2e` ich vytvorí kedykoľvek a nesmú rozhodiť `pnpm lint`
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `.tsx` patrí do TS bloku od S11 (F4AI-17) — bez neho by React
    // komponenty v `packages/ui` nedostali TS parser a DOM globals
    files: ['**/*.{ts,mts,cts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // browser kód UI balíka: `document`/`localStorage`/`window` namiesto
    // Node globalov (inak by `no-undef`-štýlove kontroly hlásili DOM API)
    files: ['packages/ui/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
);
