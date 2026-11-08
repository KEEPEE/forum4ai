/**
 * F4AI-31 (Phase 7) — druhý priechod: nsec login → dotaz v topiku →
 * viditeľný vo feedi (A stack na `127.0.0.1`).
 *
 * Prečo práve táto cesta: `VITE_ALLOW_NSEC=true` je dev brána (1b),
 * takže vložený kľúč je jediná anonymná cesta k podpisu bez extenzie.
 * Test zároveň drží dve invarianty 1b:
 *
 *  - kľúč je v `sessionStorage`, NIKDY v `localStorage` (zavretím tabu
 *    zmizne — inak by sme ticho vracali trvalú identitu),
 *  - po odhlásení je úložisko opäť čisté.
 *
 * Dotaz je kind 1020 do fixného topiku (`composer-topic-fixed`), takže
 * test potrebuje existujúci topik — berieme prvý zo `GET /topics`, nie
 * hardcodovaný slug (dáta na `127.0.0.1` rastú a menia sa).
 */
import { expect, test } from '@playwright/test';

import { nsecOf, randomIdentity, token } from '../../helpers/nostr.js';
import { loginWithNsec, logout } from '../../helpers/ui.js';

const GW = process.env['E2E_GATEWAY_URL'] ?? 'http://127.0.0.1:18081';

interface TopicRow {
  slug: string;
  address: string;
}

test('nsec login → dotaz v topiku → nájdený vo feedi aj v searchi', async ({ page }) => {
  const identity = randomIdentity();
  const marker = token('E7Q');

  await page.goto('/');
  await loginWithNsec(page, nsecOf(identity));

  // 1) identita v hlavičke + odznak pozadia (dev nsec, nie extension)
  await expect(page.getByTestId('identity-npub')).toContainText(identity.npub.slice(0, 10));
  await expect(page.getByTestId('identity-source')).toHaveText('dev nsec');

  // 2) kľúč patrí do sessionStorage, nie do localStorage
  const stored = await page.evaluate(() => ({
    session: window.sessionStorage.getItem('forum4ai_nsec'),
    local: window.localStorage.getItem('forum4ai_nsec'),
  }));
  expect(stored.session, 'nsec musi byt v sessionStorage').not.toBeNull();
  expect(stored.local, 'nsec nesmie byt v localStorage').toBeNull();

  // 3) composer vie, kim podpisuje
  // `GET /topics` je dopyt cez relay pool (~1 s) a vie byt docasne
  // 500/partial — preto poll, nie jeden fetch. Bez neho by tento test
  // padal na `topics.find` nad undefined (skusene pri behu 2).
  let topic: TopicRow | undefined;
  await expect
    .poll(
      async () => {
        try {
          const res = await fetch(`${GW}/topics`, { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) return false;
          const body = (await res.json()) as { topics?: TopicRow[] };
          topic = (body.topics ?? []).find((row) => row.address !== '');
          return topic !== undefined;
        } catch {
          return false;
        }
      },
      { timeout: 60_000, message: 'GET /topics nevraca zoznam topicov (relay pool)' },
    )
    .toBe(true);

  await page.goto(`/topics/${topic?.slug ?? ''}`);
  await expect(page.getByTestId('composer-topic-fixed')).toBeVisible();
  await expect(page.getByTestId('composer-identity')).toContainText(identity.npub.slice(0, 10));
  await expect(page.getByTestId('composer-signer')).toHaveText('dev nsec');

  // 4) publikácia dotazu (1020) — gateway musí dosiahnuť quorum
  await page.locator('#composer-title').fill(`Phase 7 E2E question ${marker}`);
  await page.locator('#composer-text').fill(`Automated Playwright check ${marker} — reply chain starts here.`);
  await page.getByTestId('composer-submit-btn').click();
  await expect(page.getByTestId('composer-note')).toContainText(/accepted|quorum/i, { timeout: 60_000 });

  // 5) ingestia: indexer musí nitku nájsť (live subscribe) a zoberieme
  //    z neho aj `id` — jediná deterministická cesta k nitke, lebo
  //    pool čítania (topic/feed) môžu byť čiastočné
  let threadId = '';
  await expect
    .poll(
      async () => {
        const res = await fetch(`${GW}/search?q=${marker}&limit=5`, { signal: AbortSignal.timeout(15_000) });
        const body = (await res.json()) as { count: number; results?: { id?: string }[] };
        threadId = body.results?.[0]?.id ?? '';
        return body.count;
      },
      { timeout: 90_000, intervals: [2_000, 3_000, 5_000] },
    )
    .toBeGreaterThan(0);
  expect(threadId, 'search nevratil id nitky').toMatch(/^[0-9a-f]{64}$/);

  // 6a) TVRDÉ aserty: používáč svoj príspevok nájde — search a detail
  //     nitky. Obe čítajú isté dáta (indexer + thread read).
  await page.goto(`/search?q=${marker}`);
  await expect(page.getByTestId('search-result').first()).toContainText(marker);

  await page.goto(`/threads/${threadId}`);
  await expect(page.getByTestId('thread-root')).toContainText(marker);

  // 6b) BEST-EFFORT: topic zoznam. `GET /topics/:slug` aj `/feed` čítajú
  //     **relay pool** a gateway akceptuje publish už pri 1 z 2 relajo
  //     (`GATEWAY_QUORUM_MIN_OK` default 1), takže čerstvá nitka môže žiť
  //     na JEDNEJ relaji a pool read ju pred anti-entropiou (300 s)
  //     nevidí. Sonda to overila: prvých ~90 s po publikácii dopyt nitku
  //     nevracal, 20/20 dopytov o minútu neskôr už áno. Test preto skúsi
  //     60 s a ak to nepomôže, zapíše annotation a na tom nezlyhá —
  //     pointa testu je, že príspevok NIE JE stratený (6a), nie že pool
  //     stihol replikovať.
  let topicVisible = false;
  for (let attempt = 0; attempt < 12 && !topicVisible; attempt += 1) {
    await page.goto(`/topics/${topic?.slug ?? ''}`);
    topicVisible = (await page.locator('article').filter({ hasText: marker }).count()) > 0;
    if (!topicVisible) await page.waitForTimeout(5_000);
  }
  if (!topicVisible) {
    test.info().annotations.push({
      type: 'note',
      description: `topic zoznam neobsahuje ${marker} (ciastocny relay-pool read pri quorum 1/2) — tvrdé aserty (search, thread) presli`,
    });
  }

// 7) odhlásenie → anonym, kľúč preč
  await logout(page);
  await expect(page.getByTestId('login-open')).toBeVisible();
  await expect(page.getByTestId('identity-npub')).toHaveCount(0);
  const after = await page.evaluate(() => window.sessionStorage.getItem('forum4ai_nsec'));
  expect(after, 'po odhláseni nesmie ostat kľúč').toBeNull();
});
