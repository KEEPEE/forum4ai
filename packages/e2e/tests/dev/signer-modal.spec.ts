/**
 * F4AI-31 (Phase 7) — login modal: tri cesty k podpisovateľovi.
 *
 *  1. **NIP-07 bez extenzie** — v headless Chrome nie je Alby/nos2x,
 *     takže `detectNip07` po 1,2 s vráti null a modal musí ukázať
 *     RUŠTLÍVU výzvu (inštaluj extenziu a reload), nie chybu appky.
 *  2. **NIP-07 s extenziou** — falošný `window.nostr` (CDP, nie `<script>`,
 *     preto ho neblokuje CSP) prepne hint na „našli sme extenziu“.
 *  3. **bunker (NIP-46)** — modal vykreslí vstup `bunker://…` a hint,
 *     tlačidlo je disabled kým pole nie je plné. Skutočné NIP-46
 *     pripojenie tu nehráme (needs live bunker); unit testy
 *     (`packages/ui/test/nip46*.test.ts`) pokrývajú protokol.
 *
 * Tab `nsec (dev)` sa v tomto buildu ukáže — je to dôkaz, že dev web je
 * postavený s `VITE_ALLOW_NSEC=true` (na produkcii tab vôbec nie je).
 */
import { expect, test } from '@playwright/test';

import { installFakeExtension, randomIdentity } from '../../helpers/nostr.js';
import { openLoginModal } from '../../helpers/ui.js';

test('bez extenzie: NIP-07 hint povie, čo nainštalovať (žiadna chyba)', async ({ page }) => {
  await page.goto('/');
  await openLoginModal(page);

  // prvý tab je NIP-07 a defaultne je aktívny
  await expect(page.getByTestId('login-tab-nip07')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('login-nip07-hint')).toContainText(/no extension found/i);
  await expect(page.getByTestId('login-nip07-hint')).toContainText(/alby|nos2x|keys\.band/i);
  await expect(page.getByTestId('login-nip07-btn')).toHaveText(/connect extension/i);

  // klik bez extenzie = ruštlivá veta, nie pád: modal ostáva a chybu
  // vypíše na mieste, kde sa dala čítať (`auth:errors.extensionMissing`)
  await page.getByTestId('login-nip07-btn').click();
  await expect(page.getByTestId('login-error')).toContainText(/no nostr extension is installed/i);
  await expect(page.getByTestId('login-modal')).toBeVisible();

  // dev brána: tab s nsec existuje (produkcia ho nema)
  await expect(page.getByTestId('login-tab-nsec')).toBeVisible();
});

test('s falošnou extenziou: appka sa prihlási sama (pozadie extension)', async ({ page }) => {
  const identity = randomIdentity();
  await installFakeExtension(page, identity);
  await page.goto('/');

  // NIP-07 je default pozadie dizajnu Q1 — detekcia `window.nostr`
  // PREPOJÍ identitu bez jedného kliku, takže v hlavičke je npub a
  // odznak `extension` (nie `dev nsec`). Tlačidlo „sign in“ už nie je.
  await expect(page.getByTestId('identity-npub')).toContainText(identity.npub.slice(0, 10));
  await expect(page.getByTestId('identity-source')).toHaveText('extension');
  await expect(page.getByTestId('login-open')).toHaveCount(0);
});

test('bunker tab: vykreslí NIP-46 flow a drži tlačidlo zamknuté', async ({ page }) => {
  await page.goto('/');
  await openLoginModal(page);
  await page.getByTestId('login-tab-bunker').click();

  const uri = page.getByTestId('login-bunker-uri');
  await expect(uri).toBeVisible();
  await expect(uri).toHaveAttribute('placeholder', /bunker:\/\//);
  await expect(page.getByTestId('login-bunker-hint')).toContainText(/private key stays in the vault/i);
  await expect(page.getByTestId('login-bunker-btn')).toBeDisabled();

  await uri.fill('bunker://abc123?relay=wss%3A%2F%2Frelay.aiforum.myhood.sk&secret=xyz');
  await expect(page.getByTestId('login-bunker-btn')).toBeEnabled();

  // NIP-07 tab zostáva dostupný — cesty sa navzájom nemažú
  await page.getByTestId('login-tab-nip07').click();
  await expect(page.getByTestId('login-nip07-btn')).toBeVisible();
});
