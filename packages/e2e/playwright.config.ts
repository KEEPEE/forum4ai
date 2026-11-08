/**
 * Playwright config (F4AI-20 S14 → F4AI-31 Phase 7) — tri projekty, jeden
 * balík, žiadny build navyše:
 *
 *  | projekt | ciele                                              | baseURL default |
 *  |---------|----------------------------------------------------|-----------------|
 *  | `dev`   | anonym, nsec login, NIP-07 hint, bunker modal,      | `http://127.0.0.1:18082` |
 *  |         | logout (login 3 cesty + logout + anonym)            | A stack, write gate OFF |
 *  | `owner` | CSP hlavičky + owner approve/revoke s NIP-98 v      | `https://aiforum.myhood.sk` |
 *  |         | prehliadači (proti produkcii)                       | VPS, gate enforce |
 *  | `chain` | F4AI-20 celý reťazec nad `vite preview` buildom     | `http://127.0.0.1:4173` |
 *
 * `E2E_BASE` prepíše baseURL toho práve spúšťaného projektu — preto
 * `pnpm test:e2e -- --project=dev` stačí bez envu a
 * `pnpm test:e2e -- --project=owner` mierí na produkciu (env je poistka a
 * spôsob, ako presmerovať oba projekty na inú inštanciu).
 *
 * `workers: 1` — dáta na live stackoch sú živé a testy vkladajú vlastné
 * eventy/operátorov; jeden worker + per-beh unikátne tokeny robia beh
 * deterministickým. `retries` majú `dev`/`chain` 2 (prechodné výkyvy siete
 * a OK-before-write race strfry — každý retry generuje NOVÝ token),
 * `owner` 0 — ten mení produkčný stav (schválený/vyradený operátor) a
 * automatický retry by zanechal dva záznamy.
 *
 * Browser: chromium headless (`npx playwright install chromium`).
 * `E2E_BROWSER_CHANNEL=chrome` prepne na lokálnu Google Chrome — rovnaké
 * API, overené v tomto kontajneri.
 */
import { defineConfig, devices } from '@playwright/test';

const BASE = process.env['E2E_BASE'] ?? process.env['E2E_BASE_URL'] ?? '';
const CHANNEL = process.env['E2E_BROWSER_CHANNEL'];

const DEV_BASE = BASE !== '' ? BASE : 'http://127.0.0.1:18082';
const OWNER_BASE = BASE !== '' ? BASE : 'https://aiforum.myhood.sk';
const CHAIN_BASE = BASE !== '' ? BASE : 'http://127.0.0.1:4173';

const browserUse = {
  ...devices['Desktop Chrome'],
  // UI prepína jazyk podľa `navigator.language` — E2E tvrdí angličtinu,
  // aby aserty na texty nezáviseli od locale kontajnera.
  locale: 'en-US',
  ...(CHANNEL !== undefined && CHANNEL !== '' ? { channel: CHANNEL } : {}),
};

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 2,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'dev',
      testMatch: 'dev/**/*.spec.ts',
      retries: 2,
      use: { ...browserUse, baseURL: DEV_BASE },
    },
    {
      name: 'owner',
      testMatch: 'owner/**/*.spec.ts',
      retries: 0,
      use: { ...browserUse, baseURL: OWNER_BASE },
    },
    {
      name: 'chain',
      testMatch: 'full-chain.spec.ts',
      retries: 2,
      use: { ...browserUse, baseURL: CHAIN_BASE },
    },
  ],
  globalSetup: './global-setup.ts',
});
