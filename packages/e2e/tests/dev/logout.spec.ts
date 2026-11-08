/**
 * F4AI-31 (Phase 7) — logout (A stack na `127.0.0.1`).
 *
 * `disconnect()` v `IdentityContext` je zámerne bez bootstrapu: anonym je
 * po odhlásení KONEČNÝ stav, nie prechodný. Test to drží na troch miestach
 * naraz — chip zmizne, úložisko je opäť čisté (predvoľba pozadia aj kľúč)
 * a reload žiadnu identitu nevráti. To posledné je vec, ktorú by vrátil
 * len tichý auto-keygen alebo predvoľba v `localStorage`.
 *
 * Čítanie ostáva funkčné: odhlásenie nesmie používáčovi vzdať to, čo
 * mal aj pred prihlásením.
 */
import { expect, test } from '@playwright/test';

import { nsecOf, randomIdentity } from '../../helpers/nostr.js';
import { identityStorage, loginWithNsec, logout } from '../../helpers/ui.js';

test('logout vráti anonyma a vyčistí obe úložiská', async ({ page }) => {
  const identity = randomIdentity();

  await page.goto('/');
  await loginWithNsec(page, nsecOf(identity));
  await expect(page.getByTestId('identity-npub')).toContainText(identity.npub.slice(0, 10));

  await logout(page);

  // plocha identity: žiadny chip, len „sign in“
  await expect(page.getByTestId('identity-npub')).toHaveCount(0);
  await expect(page.getByTestId('login-open')).toBeVisible();

  // obe úložiská: kľúč, predvoľba pozadia aj NIP-46 záznam sú preč
  await expect.poll(() => identityStorage(page)).toEqual({
    forum4ai_nsec: null,
    forum4ai_signer: null,
    forum4ai_bunker: null,
  });

  // anonym stale číta
  await expect(page.getByTestId('feed-list')).toBeVisible();
  await expect(page.locator('article')).not.toHaveCount(0);

  // reload nic nevráti — po odhlásení nie je čo obnovovať
  await page.reload();
  await expect(page.getByTestId('identity-npub')).toHaveCount(0);
  await expect(page.getByTestId('login-open')).toBeVisible();
});

test('po logouti je composer opäť zamknutý s výzvou na prihlásenie', async ({ page }) => {
  const identity = randomIdentity();

  await page.goto('/');
  await loginWithNsec(page, nsecOf(identity));

  const threadHref = await page.locator('article a[href^="/threads/"]').first().getAttribute('href');
  await page.goto(threadHref ?? '/');
  await expect(page.getByTestId('composer-identity')).toBeVisible();

  await logout(page);

  await expect(page.getByTestId('composer-anonymous')).toContainText(/sign in/i);

  // gate je na `127.0.0.1` OFF, takže zamknutie neprichádza od gate ale od
  // absencie podpisovateľa — podpis musí hlasne zlyhať
  await page.locator('#composer-text').fill('odpoveď po odhlásení');
  await page.getByTestId('composer-submit-btn').click();
  await expect(page.getByTestId('composer-error')).toContainText(/sign in to write/i);
});
