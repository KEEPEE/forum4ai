/**
 * F4AI-20 (S14) — Playwright E2E nad live stackom na `127.0.0.1`
 * (relay `:18080`, strfry `:18008`, gateway `:18081`) a `vite preview`
 * buildom `packages/ui` na `:4173` (globalSetup).
 *
 * Jeden hlavný scenár (per-beh unikátne tokeny `E2A<rand>` / `E2I<rand>`):
 *
 *  a) **agent skript** — nostr-tools priamo v teste (nie UI): cez
 *     `POST /events` gateway publishneme reťazec 1020 otázka → 1023
 *     odpoveď (root marker) → 1031 rating (score 5, grounding_ref+epoch v
 *     JSON contente) → 1032 accepted_solution → 1030 hlas +1 od druhého
 *     kľúča. Potom retry-until: `GET /threads/:id` nesie rating agregát
 *     s `accepted: true` a `GET /search?q=E2A<rand>` nájde otázku
 *     (indexer live subscribe doručuje do ~1 s, anti-entropia 300 s je
 *     poistka → budget 60 s).
 *  b) **UI** — `/search?q=` karta → klik → thread detail: reply strom,
 *     rating ★ badge, accepted pill, untrusted badge.
 *  c) **UI composer** — reset identity (nový kľúč), odpoveď z UI →
 *     publish → reply pribudne do stroma (live/WS + refetch).
 *  d) **reputácia** — `GET /reputation/<pubkey autora odpovede>`: helper
 *     doména `total > 0` (odpoveď dostala +1 hlas a bola akceptovaná) a
 *     UI `/agents/:pubkey` vykreslí reputation bar s width > 0.
 *  e) **idea flow** — 1021 `E2I<rand>` (t tag `e2e`) skriptom + cudzí
 *     claim-návrh 10030 → `GET /ideas/:id` ukazuje `suggestions_count ≥ 1`
 *     (návrh NIE je status), UI `/ideas?topic=e2e` nájde kartu, claim z UI
 *     (identita = autor idey → kanonický status) → pill `claimed`.
 *
 * Prečo kľúče v skripte a nie v UI: reťazec rating/accepted/hlas vyžaduje
 * tri nezávislé identity (autor otázky, autor odpovede, volič) — UI má
 * jednu. Identita UI sa skriptu odovzdá cez `localStorage` (`forum4ai_nsec`,
 * NIP-19 nsec) pomocou `addInitScript`, takže UI podpisuje rovnakým kľúčom
 * ako autor idey a claim sa stáva kanonickým statusom (rozhodnutie S10).
 *
 * PITS zadané manažérom, ktoré test rešpektuje:
 *  - `nostr-tools` podpis je randomizovaný (`auxRand`) → každý event
 *    overujeme `verifyEvent` + prepočtom `getEventHash` pred publishom;
 *  - strfry OK-before-write race → čítania idú cez `waitUntil` retry,
 *    publish cez `publish` retry (424 kvórum/network);
 *  - live dáta rastú → per-beh unikátne tokeny, `workers: 1`.
 *
 * Epoch watermark: live dataset má watermark `epoch` tagu 999999, preto
 * NAŠE signály `epoch` TAG nedostávajú (v JSON contente áno — tam sa
 * nevyhodnocujú) a vždy sa počíta ich váha 1.0.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';

const GW = process.env['E2E_GATEWAY_URL'] ?? 'http://127.0.0.1:18081';

const KIND = {
  QUESTION: 1020,
  IDEA_CALL: 1021,
  POST: 1023,
  VOTE: 1030,
  SOLUTION_RATING: 1031,
  ACCEPTED_SOLUTION: 1032,
  IDEA_CALL_STATUS: 10030,
} as const;

/** kánonický 7-pôlový NIP-01 event (presne to, čo vyžaduje `POST /events`) */
interface Ev {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Template {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

// ── minimálne typy odpovedí gateway (e2e balík je samostatný, bez build
//    závislosti na dist balíkov — len to, čo test skutočne číta) ──────────

interface ThreadResponseLite {
  root?: { id: string };
  replies?: { id: string }[];
  rating?: { count: number; mean15: number; accepted: boolean; accepted_count: number };
}

interface SearchResponseLite {
  count: number;
  results?: { id: string; kind: number; snippet?: string }[];
}

interface ReputationResponseLite {
  domains?: Record<'voter' | 'author' | 'helper', { score: number; positive: number; total: number }>;
}

interface IdeaDetailLite {
  id: string;
  status: string;
  suggestions_count: number;
}

// ── helpery ───────────────────────────────────────────────────────────────

/**
 * Podpíše template a OVERÍ podpis aj id (PITS: `auxRand` randomizuje
 * podpis — ten musí byť validný a `id` sa musí rovnať SHA-256 hashu
 * obsahu; `verifyEvent` kontroluje oboje naraz).
 */
function sign(secretKey: Uint8Array, template: Template): Ev {
  const ev = finalizeEvent({ ...template }, secretKey);
  // `verifyEvent` je type-guard — v zápornej vetve by sa `ev` zúžil na
  // `never`, preto id odoberáme PRED guardmi
  const evId = ev.id;
  if (getEventHash(ev) !== evId) {
    throw new Error(`id nezodpovedá hashu obsahu (kind ${String(template.kind)})`);
  }
  if (!verifyEvent(ev)) {
    throw new Error(`verifyEvent zlyhal (kind ${String(template.kind)}, id ${evId.slice(0, 12)}…)`);
  }
  if (ev.pubkey !== getPublicKey(secretKey)) {
    throw new Error(`pubkey eventu nesedí s tajným kľúčom (kind ${String(template.kind)})`);
  }
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags as string[][],
    content: ev.content,
    sig: ev.sig,
  };
}

/**
 * `POST /events` s retry na prechodné zlyhania (424 kvórum, 5xx, sieť).
 * Publish je idempotentný — relaye dedupnú podľa id. 400 je logická chyba
 * (validácia L2), tá sa neopakuje.
 */
async function publish(request: APIRequestContext, ev: Ev, label: string): Promise<void> {
  let last: string | undefined;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await request.fetch(`${GW}/events`, {
      method: 'POST',
      data: ev,
      headers: { 'content-type': 'application/json' },
      timeout: 15_000,
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; quorum_met?: boolean; error?: string; reasons?: string[] }
      | null;
    if (res.ok() && body?.quorum_met === true) return;
    if (res.status() === 400) {
      throw new Error(`publish ${label}: 400 validacia — ${JSON.stringify(body)}`);
    }
    last = `HTTP ${String(res.status())} ${JSON.stringify(body)}`;
    await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
  }
  throw new Error(`publish ${label} nedosiahol quorum (posledna odpoved: ${last})`);
}

/** GET na gateway → status + JSON teliesko */
async function getJson<T>(request: APIRequestContext, path: string): Promise<{ status: number; body: T }> {
  const res = await request.fetch(`${GW}${path}`, { timeout: 15_000 });
  return { status: res.status(), body: (await res.json()) as T };
}

/**
 * Retry-until-podmienka (strfry OK-before-write race + indexer ingestia).
 * Budget 60 s: live subscribe doručuje do ~1 s (zmerané), anti-entropia
 * 300 s je len poistka pre pripojenie, ktoré práve padlo.
 */
async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
): Promise<NonNullable<T>> {
  const started = Date.now();
  // (initializácia zámerná bez hodnoty — každá cesta k throw nižšie prichádza
  // cez priradenie v try/catch, inak `no-useless-assignment` nadáva)
  let last: string;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
      last = 'podmienka este nesplnena';
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`[e2e] ${label}: timeout ${String(timeoutMs)} ms (${last})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

// ── scenár ────────────────────────────────────────────────────────────────

test.describe('F4AI-20 — live E2E: question → answer → rating → search → UI → reputacia → idea claim', () => {
  test('hlavny scenar a–e proti live 127.0.0.1', async ({ page, request }) => {
    // per-beh unikátne tokeny: retry (retries: 2) dostane NOVÝ token,
    // takže nikdy nezávisí od dát predchádzajúceho pokusu
    const rand = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const qToken = `E2A${rand}`;
    const iToken = `E2I${rand}`;

    // tri nezávislé identity skriptu: autor otázky (+ rating/accepted),
    // autor odpovede (reputačný subjekt d), volič (+1 od druhého kľúča)
    const keyAuthor = generateSecretKey();
    const keyHelper = generateSecretKey();
    const keyVoter = generateSecretKey();
    const keyIdea = generateSecretKey();
    const keySuggester = generateSecretKey();

    // ── a) agent-skript: celý reťazec cez POST /events (gateway, quorum 2/2) ──
    const now = Math.floor(Date.now() / 1000);

    const question = sign(keyAuthor, {
      kind: KIND.QUESTION,
      content: `${qToken} ako funguju Nostr relays?`,
      tags: [['t', 'e2e-question']],
      created_at: now,
    });
    await publish(request, question, 'otazka 1020');

    const answer = sign(keyHelper, {
      kind: KIND.POST,
      content: `Odpoved na ${qToken}: relays drzia TRN a overuju podpisy (NIP-01).`,
      // L2 pravidlo: práve jeden e tag s markerom root (validators.ts)
      tags: [['e', question.id, 'root']],
      created_at: now + 1,
    });
    await publish(request, answer, 'odpoved 1023');

    const rating = sign(keyAuthor, {
      kind: KIND.SOLUTION_RATING,
      // score 5 + grounding_ref + epoch v JSON contente (epoch TAG tu
      // zamerne nie je — live watermark 999999 by signál vynuloval)
      content: JSON.stringify({ score: 5, grounding_ref: `e2e-${rand}`, epoch: 1 }),
      // e tag solution (bez markera = cieľ agregátu) + question (root)
      tags: [
        ['e', answer.id],
        ['e', question.id, 'root'],
      ],
      created_at: now + 2,
    });
    await publish(request, rating, 'rating 1031');

    const accepted = sign(keyAuthor, {
      kind: KIND.ACCEPTED_SOLUTION,
      content: `prijate riesenie ${answer.id.slice(0, 12)}`,
      tags: [
        ['e', answer.id],
        ['e', question.id, 'root'],
      ],
      created_at: now + 3,
    });
    await publish(request, accepted, 'accepted 1032');

    const vote = sign(keyVoter, {
      kind: KIND.VOTE,
      content: '+1',
      tags: [
        ['e', answer.id],
        ['e', question.id, 'root'],
      ],
      created_at: now + 4,
    });
    await publish(request, vote, 'hlas 1030');

    // rating agregát s accepted=true (gateway číta priamo relaye → rýchle,
    // retry kryje OK-before-write race strfry)
    const thread = await waitUntil('GET /threads/:id rating accepted', async () => {
      const { status, body } = await getJson<ThreadResponseLite>(request, `/threads/${question.id}`);
      if (status !== 200) return null;
      if (body.rating?.accepted !== true || body.rating.count < 1) return null;
      return body;
    });
    expect(thread.root?.id).toBe(question.id);
    expect(thread.rating?.mean15).toBeCloseTo(5, 2);
    expect(thread.rating?.accepted_count).toBeGreaterThanOrEqual(1);
    expect((thread.replies ?? []).some((r) => r.id === answer.id)).toBe(true);

    // indexer: otázka musi byt vyhladatelna (live subscribe, retry)
    const hit = await waitUntil('GET /search q=E2A<rand> nájde otázku', async () => {
      const { body } = await getJson<SearchResponseLite>(request, `/search?q=${qToken}`);
      return body.results?.find((r) => r.id === question.id) ?? null;
    });
    expect(hit.kind).toBe(KIND.QUESTION);

    // ── b) UI: search → karta → thread detail (strom, rating, accepted) ──
    await page.goto(`/search?q=${qToken}`);
    const searchCard = page.getByTestId('search-result').filter({ hasText: qToken }).first();
    await expect(searchCard, 'karta otazky vo vysledkoch vyhladavania').toBeVisible();
    await searchCard.locator('h3 a').click();
    await expect(page).toHaveURL(new RegExp(`/threads/${question.id}`));

    await expect(page.getByTestId('thread-root')).toContainText(qToken);
    await expect(page.getByTestId('reply-tree-0')).toBeVisible();
    await expect(page.getByTestId(`reply-node-${answer.id.slice(0, 8)}`)).toContainText(
      'relays drzia TRN',
    );
    await expect(page.getByTestId('thread-rating-badge')).toContainText('5.00/5');
    await expect(page.getByTestId('thread-accepted-pill')).toBeVisible();
    await expect(page.getByTestId('untrusted-badge').first(), 'obsah fóra je untrusted').toBeVisible();

    // ── c) UI composer: odpoveď z UI → live do stroma ──
    //
    // Phase 1b vzala testu predpoklad, na ktorom stál: aplikácia si
    // **nezavádza** vlastný kľúč (auto-keygen je preč), takže pred
    // prihlásením je čitateľ anonym a `identity-npub` neexistuje.
    // „Reset identity“ preto nie je „nový npub“ — je to odhlásenie.
    // Test to fixne tu a potom sa prihlási dev nsec tabom (build previewu
    // sa stavia s `VITE_ALLOW_NSEC=true`, inak tab nie je).
    await expect(page.getByTestId('identity-npub'), '1b: anonym nemá kľúč').toHaveCount(0);
    await page.getByTestId('login-open').click();
    await page.getByTestId('login-tab-nsec').click();
    await page.getByTestId('login-nsec-input').fill(nsecEncode(keyHelper));
    await page.getByTestId('login-nsec-btn').click();
    const npubAfter = (await page.getByTestId('identity-npub').textContent()) ?? '';
    expect(npubAfter, 'po prihlásení je v hlavičke npub').toContain('npub1');

    const replyText = `E2R${rand} autorska odpoved z UI (Playwright E2E)`;
    await page.locator('#composer-text').fill(replyText);
    await page.getByTestId('composer-submit-btn').click();
    // jazykovo neutrálny asert: UI jazyk závisí od `navigator.language`
    // (detektor), a tento projekt ho nepinuje — important je, že publish
    // prešiel kvórom, nie ktorým jazykom to napíše
    await expect(page.getByTestId('composer-note'), 'publish z UI prijaty relaymi').toContainText(
      /accepted by relays|prijaté relaymi/,
      { timeout: 30_000 },
    );
    // reply pribudne do stroma bez reloadu (live WS + onPublished refetch)
    await expect(
      page.locator('[data-testid^="reply-node-"]').filter({ hasText: `E2R${rand}` }),
      'odpoved z UI sa objavila v reply strome',
    ).toBeVisible({ timeout: 30_000 });

    // ── d) reputačný vplyv autora odpovede ──
    const helperPk = getPublicKey(keyHelper);
    const rep = await waitUntil('GET /reputation helper total>0', async () => {
      const { status, body } = await getJson<ReputationResponseLite>(request, `/reputation/${helperPk}`);
      if (status !== 200) return null;
      if ((body.domains?.helper?.total ?? 0) < 1) return null;
      return body;
    });
    expect(rep.domains?.helper.total, 'helper domena ma aspon jednu odpoved').toBeGreaterThan(0);
    expect(rep.domains?.helper.positive, 'odpoved dostala +1 hlas / bola akceptovana').toBeGreaterThan(0);

    await page.goto(`/agents/${helperPk}`);
    await expect(page.getByTestId('domain-helper')).toBeVisible();
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const bars = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="domain-bar-"]'));
            return bars.reduce((max, el) => Math.max(max, Number.parseFloat(el.style.width) || 0), 0);
          }),
        { message: 'aspon jedna reputacna bara ma width > 0' },
      )
      .toBeGreaterThan(0);

    // ── e) idea flow: 1021 + cudzí claim-návrh → UI board → claim autorom ──
    const idea = sign(keyIdea, {
      kind: KIND.IDEA_CALL,
      content: `${iToken} navrh: e2e test celeho retazca forum4ai`,
      tags: [['t', 'e2e']],
      created_at: Math.floor(Date.now() / 1000),
    });
    await publish(request, idea, 'idea 1021');

    // cudzí claim-návrh 10030 (LWW per publikujúci) — pre board je to
    // SUGGESTION (suggestions_count), nie kanonický status (rozhodnutie S10)
    const suggestion = sign(keySuggester, {
      kind: KIND.IDEA_CALL_STATUS,
      content: JSON.stringify({ status: 'claimed', note: `cudzi claim-navrh e2e-${rand}` }),
      tags: [
        ['d', idea.id],
        ['a', getPublicKey(keySuggester)],
      ],
      created_at: Math.floor(Date.now() / 1000) + 1,
    });
    await publish(request, suggestion, 'claim-navrh 10030');

    const ideaRow = await waitUntil('GET /ideas/:id suggestion_count>=1 a status stale open', async () => {
      const { status, body } = await getJson<IdeaDetailLite>(request, `/ideas/${idea.id}`);
      if (status !== 200) return null;
      if (body.suggestions_count < 1) return null;
      return body;
    });
    expect(ideaRow.status, 'cudzi navrh NIE je kanonicky status').toBe('open');

    // UI identita = autor idey → claim z UI je kanonický status (nie návrh).
    // addInitScript nastaví localStorage pred scriptom aplikácie pri KAŽDEJ
    // navigácii, takže IdentityContext nacita nsec autora.
    await page.addInitScript((nsec: string) => {
      // Phase 1b: nsec sa číta z `sessionStorage` (nie localStorage) a len
      // za `VITE_ALLOW_NSEC`; predvoľba pozadia `forum4ai_signer` ostáva v
      // `localStorage`. Bez oboch riadkov by UI zostal anonym a test by
      // nemal kým podpisovať claim.
      window.sessionStorage.setItem('forum4ai_nsec', nsec);
      window.localStorage.setItem('forum4ai_signer', 'nsec');
    }, nsecEncode(keyIdea));

    await page.goto('/ideas?topic=e2e');
    const ideaCard = page.getByTestId('idea-card').filter({ hasText: iToken }).first();
    await expect(ideaCard, 'karta idey na boardi s filtrom topic=e2e').toBeVisible();
    await expect(ideaCard.getByTestId('status-pill-open')).toBeVisible();

    await ideaCard.getByTestId('idea-detail-link').click();
    await expect(page).toHaveURL(new RegExp(`/ideas/${idea.id}`));
    await expect(page.getByTestId('detail-status-pill')).toHaveText('open');
    // 1b: chip v hlavičke zobrazuje **krátku** podobu npub (`npub1g3qg8…274v8r`)
    //     a odznak zdroja; plná hodnota je v `title`. `toContainText` celeho
    //     npub by po 1b nemohol projst nikdy.
    await expect(page.getByTestId('identity-npub')).toHaveAttribute(
      'title',
      new RegExp(`^${npubEncode(getPublicKey(keyIdea))} · `),
    );

    await page.getByTestId('claim-btn').click();
    await expect(page.getByTestId('claim-note'), 'claim publikovany z UI').toBeVisible({ timeout: 30_000 });

    await waitUntil('GET /ideas/:id status claimed (kanonicky status autora)', async () => {
      const { status, body } = await getJson<IdeaDetailLite>(request, `/ideas/${idea.id}`);
      if (status !== 200) return null;
      return body.status === 'claimed' ? body : null;
    });

    await page.reload();
    await expect(page.getByTestId('detail-status-pill'), 'status pill po claimi').toHaveText('claimed');

    // a board po claimi ukazuje claimed pill na karte
    await page.goto('/ideas?topic=e2e');
    await expect(
      page.getByTestId('idea-card').filter({ hasText: iToken }).first().getByTestId('status-pill-claimed'),
    ).toBeVisible();
  });
});
