/**
 * F4AI-31 (Phase 7) — owner flow na produkcii: registrácia → Approve →
 * Revoke s NIP-98 podpisom v prehliadači.
 *
 * Kľúčové rozhodnutie: vlastník sa prihlasuje **falošnou NIP-07
 * extenziou**, nie nsec. Produkčný build nemá `VITE_ALLOW_NSEC=true`,
 * takže tab s nsec sa nevykreslí a `sessionStorage` kľúč by sa neobnovil
 * (gate v `IdentityContext`). NIP-07 je default pozadie — stačí
 * `window.nostr` a podpis počíta Node cez `exposeBinding`, takže súkromný
 * kľúč nikdy nevstúpi do stránky a CSP mu nestojí
 * v ceste (viaže sa cez CDP, nie cez `<script>`).
 *
 * Druhý kompromis je popísaný v `docs/CSP.md` a v README: registrácia
 * operátora je na VPS dnes ukončená already-dokumentovanou prekážkou —
 * claim musí tvrdiť o relaji, ktorá je `wss://` na port 443 s verejnou
 * IP a NIP-11 `pubkey` = claimant. `relay.aiforum.myhood.sk` zatiaľ
 * **nemá DNS záznam** (otvorená vec z 6b), takže `POST /api/register`
 * vráti 422 `unsafe_url`. Test preto:
 *
 *  1. skúsi SKUTOČNÚ registráciu (ak DNS dorastie, flow prejde celý),
 *  2. ak probe zlyhá, naseeduje pending riadok cez `E2E_SEED_CMD`
 *     (popísanú shell vetu, ktorá vloží rovnaký riadok, aký by vytvoril
 *     `POST /register`) a pokračuje — schvaľovanie a revokácia v UI sú
 *     tak testované na reálnej inštancii s reálnym NIP-98,
 *  3. bez `E2E_SEED_CMD` test skipne s dôvodom, nie klame zelenou.
 *
 * Po revokácii test overí `GET /api/write-status` → `allowed:false` a
 * `code:"WG_REVOKED"`, teda že gate skutočne číta rozhodnutie vlastníka.
 */
import { execSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

import {
  installFakeExtension,
  ownerIdentityFromEnv,
  randomIdentity,
  registerOperator,
  writeStatus,
  type OwnerIdentity,
} from '../../helpers/nostr.js';

const BASE = process.env['E2E_BASE'] ?? 'https://aiforum.myhood.sk';
const API = process.env['E2E_OWNER_API'] ?? `${BASE.replace(/\/$/, '')}/api`;
const HOST = new URL(BASE).host;
/** relaj, o ktorej claim tvrdi — tá naša verejná (DNS zatiaľ chýba) */
const RELAY = process.env['E2E_OWNER_RELAY'] ?? 'wss://relay.aiforum.myhood.sk';

let owner: OwnerIdentity | null = null;
try {
  owner = ownerIdentityFromEnv();
} catch {
  owner = null;
}

test('owner sa prihlási NIP-07 pozadím a vidi spravu operatorov', async ({ page }) => {
  test.skip(owner === null, 'owner kľúč nie je k dispozícii (E2E_OWNER_NSEC / E2E_OWNER_NSEC_FILE)');
  const identity = owner as OwnerIdentity;

  await installFakeExtension(page, identity);
  await page.goto('/');

  // NIP-07 detekcia prebehne hneď — header ukazuje npub vlastníka
  await expect(page.getByTestId('identity-npub')).toContainText(identity.npub.slice(0, 10));
  await expect(page.getByTestId('identity-source')).toHaveText('extension');

  // owner link sa v menu objaví len ak `GET /api/register/owner` sedí
  await page.getByTestId('identity-npub').click();
  await expect(page.getByTestId('menu-admin-operators')).toBeVisible();
  await page.getByTestId('menu-admin-operators').click();

  // NIP-98 (kind 27235) podpisuje prehliadač — 200 bez 401/403 je pointa
  await expect(page.getByTestId('admin-operators')).toBeVisible();
  await expect(page.getByTestId('admin-owner')).toContainText(identity.npub.slice(0, 10));
  await expect(page.getByTestId('admin-error')).toHaveCount(0);
  await expect(page.getByTestId('admin-not-owner')).toHaveCount(0);
});

test('registracia → Approve → Revoke a write-gate povie WG_REVOKED', async ({ page }) => {
  test.skip(owner === null, 'owner kľúč nie je k dispozícii (E2E_OWNER_NSEC / E2E_OWNER_NSEC_FILE)');
  const identity = owner as OwnerIdentity;
  const fresh = randomIdentity();

  // ── 1) skutočná registrácia (rovnaký postup ako CLI `operator claim`)
  const attempt = await registerOperator(API, HOST, RELAY, fresh);
  const registered = attempt.status === 200 && attempt.body['ok'] === true;
  if (!registered) {
    const reasons = Array.isArray(attempt.body['reasons'])
      ? (attempt.body['reasons'] as unknown[]).map(String).join('; ')
      : JSON.stringify(attempt.body);
    test.info().annotations.push({
      type: 'issue',
      description: `POST /api/register -> ${String(attempt.status)}: ${reasons}`,
    });
    const seed = process.env['E2E_SEED_CMD'];
    test.skip(
      seed === undefined || seed === '',
      `registracny probe nepreiel (${reasons}) a E2E_SEED_CMD nie je nastavene — nemoze co schvalovat`,
    );
    // pending riadok s tym istym pubkey/claim_id, co by vytvoril register
    execSync((seed as string).replaceAll('{pubkey}', fresh.pubkey).replaceAll('{claim}', attempt.claim.id), {
      stdio: 'pipe',
      timeout: 120_000,
    });
  }

  // ── 2) UI: riadok je pending a owner ho schvali
  await installFakeExtension(page, identity);
  await page.goto('/admin/operators');
  const row = page.getByTestId(`operator-row-${fresh.pubkey}`);
  await expect(row, registered ? 'register prebehol, ale riadok nie je v tabulke' : 'seed nenesie riadok v tabulke').toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId(`operator-status-${fresh.pubkey}`)).toHaveText('pending');

  await page.getByTestId(`operator-approve-${fresh.pubkey}`).click();
  await expect(page.getByTestId(`operator-status-${fresh.pubkey}`)).toHaveText('active', { timeout: 60_000 });

  // gate musi schvaleneho pustit (ešte pred revokaciou)
  const active = await writeStatus(API, fresh.pubkey);
  expect(active.allowed, `schvaleny operator by mal pisat: ${JSON.stringify(active)}`).toBe(true);
  expect(active.code).toBe('WG_OPERATOR');

  // ── 3) revoke: potvrdenie + poznamka, potom gate nesmie pustiť
  await page.getByTestId(`operator-revoke-${fresh.pubkey}`).click();
  await page.getByTestId(`operator-note-${fresh.pubkey}`).fill('e2e phase 7 revoke');
  await page.getByTestId(`operator-revoke-confirm-${fresh.pubkey}`).click();
  await expect(page.getByTestId(`operator-status-${fresh.pubkey}`)).toHaveText('revoked', { timeout: 60_000 });

  const revoked = await writeStatus(API, fresh.pubkey);
  expect(revoked.allowed, `po revokacii nesmie pisat: ${JSON.stringify(revoked)}`).toBe(false);
  expect(revoked.code, `ocakavali sme WG_REVOKED, prišlo ${revoked.code}`).toBe('WG_REVOKED');

  // zoznam sa po akcii nacitava znova — tlacidlo revoke je prec, approve spat
  await expect(page.getByTestId(`operator-revoke-${fresh.pubkey}`)).toHaveCount(0);
  await expect(page.getByTestId(`operator-approve-${fresh.pubkey}`)).toBeVisible();
});
