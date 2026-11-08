/**
 * F4AI-31 (Phase 7) — anonym bez kľúča (A stack na `127.0.0.1`, write gate OFF).
 *
 * Dizajn Q1/1b: čitateľ NEMÁ kľúč vôbec. Test preto skúma tri veci
 * naraz, lebo všetky tri sa ľahko pokazia jednou zmenou:
 *
 *  1. **čítanie funguje** — feed, thread, search (žiadne „prázdno“),
 *  2. **composer je zamknutý a povie prečo** — `composer-anonymous`
 *     s výzvou na prihlásenie, nie „identita nedostupná“,
 *  3. **nikde nie je tichý kľúč** — 1b odstránil auto-keygen, takže po
 *     prvej návšteve NEEXISTUJE `forum4ai_nsec` (v `sessionStorage` ani
 *     `localStorage`) ani predvoľba `forum4ai_signer`. Tento asert je
 *     pointa celej 1b zmeny a testuje sa aj po navigácii a po otvorení
 *     login modalu, lebo presne tam sa kľúč začal generovať znova.
 */
import { expect, test } from '@playwright/test';

import { identityStorage, openLoginModal } from '../../helpers/ui.js';

const GW = process.env['E2E_GATEWAY_URL'] ?? 'http://127.0.0.1:18081';

test.beforeEach(async ({ page }) => {
  // čistý štart: žiadna predchádzajúca relácia (per-beh stav neovplyvňuje
  // aserty o tom, čo app sama zapíše)
  await page.goto('/');
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
});

test('anonym číta feed a nevygeneruje si žiadny kľúč', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('feed-list')).toBeVisible();
  // feed nie je prázdny — anonym vidí rovnaké nitky ako prihlásený
  await expect(page.locator('article')).not.toHaveCount(0);

  // identita: len tlačidlo „sign in“, žiadny `npub` chip
  await expect(page.getByTestId('login-open')).toBeVisible();
  await expect(page.getByTestId('identity-npub')).toHaveCount(0);

  // 1b: žiadne tiché kľúče — ani po štarte, ani po prejdení feedu
  await expect.poll(() => identityStorage(page)).toEqual({
    forum4ai_nsec: null,
    forum4ai_signer: null,
    forum4ai_bunker: null,
  });
});

test('anonym otvorí thread: číta, composer je zamknutý s výzvou', async ({ page }) => {
  await page.goto('/');
  const threadHref = await page.locator('article a[href^="/threads/"]').first().getAttribute('href');
  expect(threadHref, 'feed neobsahuje ani jednu nitku').not.toBeNull();

  await page.goto(threadHref ?? '/');
  await expect(page.getByTestId('composer-anonymous')).toBeVisible();
  await expect(page.getByTestId('composer-anonymous')).toContainText(/sign in/i);

  // Na `127.0.0.1` je write gate OFF, preto `composer-locked` NEVYKRESLÍ a pole
  // je písateľné — anonymita tu nie je zamknutý gate, ale absencia kľúča.
  // Pokus o odoslanie preto musí spadnúť na hlasnú chybu („no signer“),
  // nie sa ticho stratiť: presne to zaručuje 1b (žiadny tichý kľúč).
  await expect(page.getByTestId('composer-locked')).toHaveCount(0);
  await page.locator('#composer-text').fill('pokus o odpoveď bez kľúča');
  await page.getByTestId('composer-submit-btn').click();
  // composer povie RUŠTLIVÚ vetu z write-gate copy, nie technické
  // „no signer“ — to je správne správanie 1b a test to drží
  await expect(page.getByTestId('composer-error')).toContainText(/sign in to write/i);
  await expect(page.getByTestId('composer-anonymous')).toBeVisible();
});

test('anonym hľadá a dostáva výsledky (FTS5 bez podpisu)', async ({ page }) => {
  const search = await fetch(`${GW}/search?q=relay&limit=5`, { signal: AbortSignal.timeout(15_000) });
  const body = (await search.json()) as { count: number; results: { title?: string }[] };
  expect(body.count, 'gateway nemá žiadny výsledok na „relay“').toBeGreaterThan(0);

  await page.goto('/search?q=relay');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect(page.getByTestId('search-result').first()).toBeVisible();
});

test('ani po navigácii a login modale nevznikne kľúč (auto-keygen je preč)', async ({ page }) => {
  await page.goto('/');
  await openLoginModal(page);
  // modal sa NEZATVÁRA klikom — jeho nadpis má nekonečnú animáciu a
  // Playwright by čakal na „stable“; navigácia ho odstaví a to stačí,
  // lebo bod testu je, čo modal NEZAPÍŠE do úložiska
  await page.goto('/topics/technology');
  await page.goto('/settings');

  await expect.poll(() => identityStorage(page)).toEqual({
    forum4ai_nsec: null,
    forum4ai_signer: null,
    forum4ai_bunker: null,
  });
});

test('read-only stránky anonymovi vysvetlia, prečo nemôže písať', async ({ page }) => {
  await page.goto('/register');
  await expect(page.getByTestId('register-anonymous')).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByTestId('settings-anonymous')).toBeVisible();
  // copy je čitateľná veta, nie technický kód
  await expect(page.getByTestId('settings-anonymous')).toContainText(/nostr key is enough/i);

  await page.goto('/admin/operators');
  await expect(page.getByTestId('admin-no-signer')).toBeVisible();
});
