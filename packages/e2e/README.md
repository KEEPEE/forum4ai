# `@forum4ai/e2e` — Playwright E2E (F4AI-20 S14, F4AI-31 Phase 7)

Three projects, one package:

| Project | Goal | Run |
| --- | --- | --- |
| `dev` | anonymous (no key), **nsec login** + a query in the feed, NIP-07 hint, bunker modal, **logout** | `pnpm test:e2e -- --project=dev` → `http://127.0.0.1:18082` (A stack, write gate OFF, build with `VITE_ALLOW_NSEC=true`) |
| `owner` | **CSP** (enforce + Report-Only, 0 violations in Chrome) and **owner approve → revoke** with NIP-98 in the browser + `WG_REVOKED` | `pnpm test:e2e -- --project=owner` → `https://aiforum.myhood.sk` (VPS) |
| `chain` | F4AI-20 the full chain (question → answer → rating → search → UI → reputation → idea claim) | `pnpm test:e2e:chain` → `vite preview` build on `127.0.0.1:4173` |

`globalSetup` sets up the scene **only for the projects being run** — `dev` needs
only a health check of the dev gateway, `owner` a health check of the VPS gateway,
and `chain` additionally a UI build + `vite preview`.

An end-to-end test of the **whole chain** over a **live stack** on `127.0.0.1`
(relay `:18080`, strfry `:18008`, gateway `:18081`) and a static build of
`packages/ui` served via `vite preview` on `127.0.0.1:4173`.

Unlike the unit/integration tests of the other packages (vitest, mock/
in-memory), this package **uses no fake networks** — it publishes real
Nostr events to real relays and browses the real UI in a real browser.

## What it tests

One main scenario (`tests/full-chain.spec.ts`), per-run unique tokens
`E2A<rand>` / `E2I<rand>` (live data grows → it never depends on previous
runs, not even after a retry):

| Step | Verifies |
| --- | --- |
| a) agent script | `POST /events` gateway: 1020 question → 1023 answer (root marker) → 1031 rating (JSON `score: 5`, `grounding_ref`, `epoch`) → 1032 accepted → 1030 vote `+1` from a second key; then retry-until `GET /threads/:id` carries `rating.accepted: true` and `GET /search?q=E2A…` finds the question |
| b) UI search/detail | a card in `/search?q=`, click into the thread, reply tree, rating ★ badge (`5.00/5`), accepted pill, untrusted badge |
| c) UI composer | reset identity (new key), an answer from the UI → `POST /events` → the reply appears in the tree **without a reload** (live WS + refetch) |
| d) reputation | `GET /reputation/<pubkey of the answer author>`: the helper domain `total > 0` and `positive > 0`; the UI `/agents/:pubkey` renders at least one reputation bar with `width > 0` |
| e) idea flow | 1021 `E2I…` (t tag `e2e`) + a foreign claim suggestion 10030 → `GET /ideas/:id` shows `suggestions_count ≥ 1` at `status: open` (S10 decision: a foreign claim is a suggestion, not a status) → the UI `/ideas?topic=e2e` finds the card → claim from the UI (identity = the author) → the `claimed` status pill on the detail and on the board |

## Why keys live in the script, not the UI

The rating → accepted → vote chain requires **three independent identities**
(the question author, the answer author, the voter — the L2 caps and reputation
domains demand it). The UI has one. So the script signs with `nostr-tools`
directly and hands the UI identity over through `localStorage` (`forum4ai_nsec`,
NIP-19 nsec) using `page.addInitScript` — the UI then signs with the idea author's
key, and its claim is the canonical status (not a suggestion).

Every event is verified before publishing with `verifyEvent` + a recomputed
`getEventHash` (PITS: the `nostr-tools` signature is randomized by `auxRand` —
it must be valid and the `id` must equal the content hash).

## Running

```bash
# Phase 7: user paths on 127.0.0.1 (anonymous, nsec, modal, logout)
pnpm test:e2e -- --project=dev

# Phase 7: production — CSP + owner approve/revoke (missing owner key => skip, not a lie)
E2E_OWNER_NSEC_FILE=/tmp/.f4ai_owner_sk \
  E2E_SEED_CMD='/path/to/deployment/seed-operator.sh {pubkey} {claim}' \
  pnpm test:e2e -- --project=owner

# F4AI-20: the full chain over the build (build UI with VITE_GATEWAY_URL + Playwright)
pnpm test:e2e:chain

# everything at once (dev + owner + chain):
pnpm test:e2e

# headed mode (you watch the browser):
pnpm test:e2e:headed

# without rebuilding the UI (fast repeat, assumes an existing dist/):
pnpm --filter @forum4ai/e2e exec playwright test
```

Before the first run, the Playwright browser binaries must be installed:

```bash
npx playwright install chromium
```

In this container (Ubuntu 24.04, glibc 2.39) **this command alone** was enough —
the system libraries (`libnss3`, `libatk`, `libgbm`, …) are present, and Playwright
runs its `chromium-headless-shell` even under root (default `--no-sandbox`).
Verified: `chromium.launch()` → `156.0.8078.4`, test green.

### Fallback: local Chrome

If running Playwright's own build fails on another machine due to missing system
libraries (`npx playwright install-deps` needs root), try:

```bash
E2E_BROWSER_CHANNEL=chrome pnpm test:e2e
```

`playwright.config.ts` then switches the project to `channel: 'chrome'` —
the local Google Chrome (verified version `153.0.8010.52`), same Playwright API.
In the CI/agent container this was **not** needed — the default Playwright chromium
runs.

## Configuration (env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `E2E_GATEWAY_URL` | `http://127.0.0.1:18081` | live gateway (REST + WS); the tests read it directly, the UI gets it as build-time `VITE_GATEWAY_URL` |
| `E2E_BASE_URL` | `http://127.0.0.1:4173` | `vite preview` baseURL |
| `E2E_PREVIEW_PORT` | `4173` | preview port (globalSetup) |
| `E2E_BROWSER_CHANNEL` | — | e.g. `chrome` for the local-Chrome fallback |
| `E2E_BASE` | per-project (see the table above) | overrides the `baseURL` of the project being run |
| `E2E_OWNER_API` | `https://aiforum.myhood.sk/api` | REST gateway for the `owner` project (`/register/*`, `/write-status`) |
| `E2E_OWNER_NSEC` / `E2E_OWNER_NSEC_FILE` | — | the owner key (hex or `nsec1…`); **never printed**, the test shows only the pubkey. On the deployment host it lives in the file pointed to by `E2E_OWNER_NSEC_FILE` |
| `E2E_OWNER_RELAY` | `wss://relay.aiforum.myhood.sk` | the relay the registration claim asserts (tag `relay`) |
| `E2E_SEED_CMD` | — | a command that seeds the pending operator row (`{pubkey}`, `{claim}`); without it the `owner` test skips if the probe does not pass |
| `E2E_SKIP_PREVIEW` | — | `1` = do not start `vite preview` even for `chain` (fast repeat) |

`globalSetup` (`global-setup.ts`): gateway health check → build the UI (only if
`dist/` is missing; `test:e2e` builds ahead of time with `VITE_GATEWAY_URL`) →
`vite preview --strictPort` → wait-on health. Teardown ends the preview.

## Why it is not in `pnpm -r test`

`pnpm -r test` stays **fast and browser-free**: the e2e package's `test` script
is `echo` (it only announces that it runs via `test:e2e`). The reason: Playwright
needs a downloaded browser and a **live stack on `127.0.0.1`** — in CI without a network,
or on a machine without a browser, `pnpm -r test` would fail on infrastructure,
not on code.

## Robustness notes (PITS)

- **strfry OK-before-write race** — every read (`/threads`, `/search`,
  `/reputation`, `/ideas`) goes through a `waitUntil` retry (60 s budget; the
  indexer's live subscribe delivers within ~1 s, the 300 s anti-entropy is a backstop).
- **`epoch` watermark** — the live dataset has an `epoch` tag watermark of
  `999999`; our signals therefore get no `epoch` **tag** (the value lives only in
  the rating's JSON content, where it is not evaluated) — otherwise the aggregator
  would give them weight 0.
- **live data grows** — `workers: 1`, per-run unique tokens, `retries: 2`
  (a retry = a new token, never referencing the previous attempt's data).
- **trace/screenshot** — `trace: on-first-retry`, `screenshot: only-on-failure`
  into `test-results/`; the HTML report in `playwright-report/`.

## Owner flow on production — why it seeds (F4AI-31)

`POST /api/register` does not create an operator on its own: it verifies the claim
and then **probes the relay** the claim asserts (`probeOperatorRelay`):

1. `wss://` on port 443, DNS to a **public** IP,
2. the relay's NIP-11 document must have `pubkey` = the claimant,
3. the relay must serve the 1055 claim itself,
4. at least 4 of 5 event samples from the last 7 days (replication).

On the VPS there is nothing that can pass today: `relay.aiforum.myhood.sk` **has no
DNS record yet** (an open item from 6b), so the probe returns 422 *"the relay must be
wss:// on port 443 and its DNS must resolve to a public IP"*. So the test:

1. tries a **real** registration — if DNS catches up, the whole flow passes without
   any change to the test,
2. if the probe fails, it seeds a pending row via `E2E_SEED_CMD` (exactly the row a
   successful `POST /register` would create: `status='pending'`, `claim_id` from the
   real claim, `note='e2e phase 7'`) and **continues** — Approve and Revoke then run
   the full production path (the browser signs the NIP-98 kind 27235 →
   `POST /api/register/approve|revoke` → rewrite 30028 → write-gate),
3. without `E2E_SEED_CMD` the test **skips** with a reason — it is not green for nothing.

The seed runs inside the `forum4ai-gateway` container (`better-sqlite3` is only
there); the script is the deployment's `seed-operator.sh` +
`seed-operator.cjs`, which live next to the deployment, not in this repository. Cleanup: `./seed-operator.sh <pubkey> "" delete` deletes **only**
rows with `note LIKE 'e2e phase 7%'` (revoke rewrites the note to "e2e phase 7 revoke",
hence `LIKE`, not an exact match).

The owner logs in with a **fake NIP-07 extension** (`window.nostr` +
`exposeBinding`), not nsec: the production build does not set `VITE_ALLOW_NSEC=true`,
so the nsec tab never appears in the UI. The private key therefore never enters the
page (Node signs it), and CSP does not stand in its way, because Playwright injects
the binding over CDP, not via `<script>`.

## Cleanup after an owner run

The owner project changes production state (an approved and a retired operator, a
rewrite of 30028 `d=forum4ai-writers`). Retries are therefore set to `0` and the
seeded row is deleted:

```bash
./seed-operator.sh <pubkey-z-annotation> "" delete
```

The pubkey is in the `test operator: <hex>` annotation in the HTML report
(`playwright-report/`) and in the stdout list.
