/**
 * UI helpery (F4AI-31, Phase 7) — operácie, ktoré test opakuje a ktoré
 * musia ostať čitateľné. Všetko ide cez `data-testid`, nie cez text —
 * texty sa prekladajú (EN/SK) a menia, testid je kontrakt kódu.
 */
import { expect, type Page } from '@playwright/test';

/** otvorí login modal (anonym ho má vpravo hore) */
export async function openLoginModal(page: Page): Promise<void> {
  await page.getByTestId('login-open').click();
  await expect(page.getByTestId('login-modal')).toBeVisible();
}

/**
 * Prihlásenie vložením nsec — DEV CESTA. Funguje len v buildu s
 * `VITE_ALLOW_NSEC=true` (`127.0.0.1` A stack); produkcia tab neukáže vôbec,
 * tam testuje vlastníka falošnou NIP-07 extenziou.
 */
export async function loginWithNsec(page: Page, nsec: string): Promise<void> {
  await openLoginModal(page);
  await page.getByTestId('login-tab-nsec').click();
  await page.getByTestId('login-nsec-input').fill(nsec);
  await page.getByTestId('login-nsec-btn').click();
  await expect(page.getByTestId('login-modal')).toBeHidden();
}

/** identita → menu → odpojiť (popisek líši pozadie, testid je rovnaký) */
export async function logout(page: Page): Promise<void> {
  await page.getByTestId('identity-npub').click();
  await expect(page.getByTestId('identity-menu')).toBeVisible();
  await page.getByTestId('identity-disconnect').click();
  await expect(page.getByTestId('identity-menu')).toBeHidden();
}

/** kľúče, ktoré by UI mohlo zanechať po akejkoľvek relácii */
export const IDENTITY_STORAGE_KEYS = ['forum4ai_nsec', 'forum4ai_signer', 'forum4ai_bunker'] as const;

/**
 * Obsah oboch úložísk po odstránení neutrálnych kľúčov (jazyk, téma,
 * koncepty). `forum4ai_nsec` je v `sessionStorage`, predvoľba pozadia
 * a NIP-46 záznam v `localStorage` — test kontroluje OBE naraz, lebo
 * presne o tom je 1b: žiadne tiché kľúče nikde.
 */
export async function identityStorage(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate((keys: string[]) => {
    const out: Record<string, string | null> = {};
    for (const key of keys) {
      let value: string | null;
      try {
        value = window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
      } catch {
        value = null;
      }
      out[key] = value;
    }
    return out;
  }, [...IDENTITY_STORAGE_KEYS]);
}
