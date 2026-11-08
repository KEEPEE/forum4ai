/**
 * F4AI-31 (Phase 7) — CSP na produkcii (VPS, `aiforum.myhood.sk`).
 *
 * Dve časti, lebo hlavička bez chodu prehliadačom nič nedokazuje:
 *
 *  1. **hlavičky** — Caddy posiela `Content-Security-Policy` (enforce)
 *     AJ `Content-Security-Policy-Report-Only` (druhá hlavička, aby sme
 *     sprísnenie neprepísali jedným riadkom). Obe musia obsahovať ten
 *     istý `script-src` s hashom pred-paint skriptu z `index.html`.
 *  2. **chod aplikáciou** — feed, thread, search a paper s mermaidom a
 *     KaTeX. Chrome hlási porušenie cez `Log.entryAdded` so
 *     `source: "security"` a Playwright z neho urobí konzolovú správu
 *     typu `info` — preto `watchCsp` filtruje TEXT (`violates the …
 *     Content Security Policy` / `Refused to `), nie level. Asert je
 *     `violations == []`, teda zhodné s ručným overením zo 6. 11.
 *
 * Test je zámerne bez owner prihlásenia — CSP platí pre anonyma aj
 * prihláseného a anonymný chod je to, čo vidí väčšina návštev.
 */
import { expect, test } from '@playwright/test';

import { watchCsp } from '../../helpers/nostr.js';

const CSP_HASH = "'sha256-T6BiZymGq2JVYFFMDuK9XKoRuIwMJfxogPwgZBd0N0s='";

test('Caddy posiela enforce aj Report-Only hlavičku', async ({ request }) => {
  for (const path of ['/', '/api/health']) {
    const res = await request.get(path);
    expect(res.ok(), `${path} nie je 2xx`).toBe(true);
    const enforced = res.headers()['content-security-policy'] ?? '';
    const reportOnly = res.headers()['content-security-policy-report-only'] ?? '';
    expect(enforced, `${path} nema Content-Security-Policy`).toContain(`script-src 'self' ${CSP_HASH}`);
    expect(reportOnly, `${path} nema Report-Only variantu`).toContain(`script-src 'self' ${CSP_HASH}`);
    // zakázané vektory musia ostať v hlavičke, nie len v docs
    for (const directive of ["object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
      expect(enforced, `hlavička neobsahuje ${directive}`).toContain(directive);
    }
  }
});

test('anonymný chod aplikáciou nevyvolá jediné CSP porušenie', async ({ page }) => {
  const violations = watchCsp(page);

  await page.goto('/');
  await expect(page.getByTestId('feed-list')).toBeVisible();

  const threadHref = await page.locator('article a[href^="/threads/"]').first().getAttribute('href');
  if (threadHref !== null) await page.goto(threadHref);

  await page.goto('/search?q=relay');
  await expect(page.getByTestId('search-results')).toBeVisible();

  // paper: mermaid + KaTeX + inline štýly — presne tie, ktoré by
  // `style-src` bez 'unsafe-inline' zavraždili
  // zoznam paperov je deterministický zdroj odkazu — feed paper
  // neodkazuje (vedie na nite), takže `first()` na feede by len čakal
  await page.goto('/papers');
  const paperCount = await page.locator('a[href^="/paper/"]').count();
  if (paperCount > 0) {
    const paperHref = await page.locator('a[href^="/paper/"]').first().getAttribute('href');
    await page.goto(paperHref ?? '/papers');
    await expect(page.getByTestId('paper-page').or(page.getByTestId('state-404')).first()).toBeVisible();
  }

  // fonty a API volania prebehnú v rámci policy (asert len číta, nespraví nič)
  const fontsLoaded = await page.evaluate(() => document.fonts.status);
  expect(['loaded', 'loading'], `status fontov: ${fontsLoaded}`).toContain(fontsLoaded);

  expect(violations, `CSP porusenia: ${violations.join(' | ')}`).toEqual([]);
});
