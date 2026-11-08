# @forum4ai/relay

A thin **NIP-01 relay** (Node 22 + [`ws`](https://www.npmjs.com/package/ws) +
nostr-tools) with a configurable forum4ai L2 kind-scheme policy.

## Why not khatru (verified 2026-10-28, F4AI-8)

The original plan called for [khatru](https://github.com/fiatjaf/khatru), but
verification showed it is not available in the JS ecosystem at all:

- **npm**: `khatru` → 404 (the only registry hit is a nonsensical `khatru-ui` from 2019),
- **JSR** (jsr.io, searched with a real browser): 0 results for both
  `khatru` and `johnlightley`; the `@johnlightley` scope does not exist (404) and
  the `@fiatjaf` scope holds 5 packages — none of them is khatru,
- **GitHub**: the repository is a **Go framework** (`go.mod`, `pkg.go.dev`
  redirects), in maintenance mode since 2024 with the Go successor `fiatjaf.com/nostr/khatru`.

No TS/JS port exists, so we wrote our own thin implementation on top of `ws` —
the policy stays a pure module and the tests run in the same vitest toolchain
as the rest of the monorepo (`pnpm -r test`).

## Policy (`src/policy.ts`)

A pure, network-independent decision function — testable without a server.
Configurable parameters with dev defaults:

| # | Rule | Default | Consequence of violation |
|---|---|---|---|
| 0 | `readOnly` — public **read-only** relay (`RELAY_READ_ONLY=1`, Phase 6b) | `false` | `OK … false "rejected: read-only relay"` (every `EVENT`; `REQ`/`CLOSE`/NIP-11 remain) |
| 1 | allowed kinds: `0, 3, 1020–1059, 10030, 27235, 30002, 30020–30029, 30400, 30401` | 57 kinds | `rejected: kind …` |
| 2 | kind 1023 (post): exactly one `e` tag with a `root` marker (64-hex id) | shared with the shared `validatePostRootMarker` | `rejected: …root…` |
| 3 | NIP-13 PoW: threshold of leading zero bits from the id | `powMinDifficulty: 0` (disabled for dev) | `pow: …` |
| 4 | rate limit per pubkey, sliding window | 30 EVENT messages / 60 s | `rate-limited: …` |
| 5 | signature **and** recomputed NIP-01 hash before storing (`verifyFull`) | always on | `rejected: signature…` |

It additionally enforces the shared L2 rules from S1: event structure (second-granularity
`created_at`, hex formats), the `d` tag for addressable kinds 30000+ and topic
30020 validation (`d` slug + optional parent `a` tag).

> `verifyFull` is the equivalent of the S1 helper from `shared/test/event-signature.test.ts`.
> Compared to a naive `verifyEvent` it solves two nostr-tools 2.x pitfalls:
> (a) the hash is verified explicitly (`getEventHash(event) === event.id`) and
> (b) before verifying, a fresh canonical 7-field copy is built — nostr-tools
> memoizes the verification result under a `Symbol` and the spread `{ ...event }`
> carries it over, so an altered copy would otherwise pass without a real check.

## Storage (`src/store.ts`)

In-memory, NIP-01 semantics: regular events are append-only with dedup by id,
ephemeral 20000–29999 are not stored (forward only), replaceable 10000–19999 use
LWW per `(pubkey, kind)`, addressable 30000+ use LWW per `(pubkey, kind, d)`.

## Relay (`src/server.ts`)

`startRelayServer({ port, host, policy, now })` starts an HTTP+WS server
(NIP-11 information document on `Accept: application/nostr+json`),
`port: 0` = a free port (integration tests). It handles `EVENT`, `REQ`,
`CLOSE`, `AUTH` (NOTICE for now) and live-forwards accepted events to active
subscriptions.

## Run

```bash
pnpm --filter @forum4ai/relay dev            # tsx watch src/cli.ts (ws://127.0.0.1:7043)
RELAY_PORT=7043 RELAY_POW_MIN=0 RELAY_RATE_MAX=30 node dist/cli.js
RELAY_READ_ONLY=1 node dist/cli.js           # public read-only relay (Phase 6b)
RELAY_READ_ONLY=1 RELAY_BACKFILL_URL=ws://strfry:7777 node dist/cli.js   # read-only relay with content
```

### Content backfill (`src/backfill.ts`, Phase 6b)

The store is a `MemoryStore` — the relay **has no disk**. A read-only relay nobody
can write to would therefore have nothing to answer `REQ` with. `RELAY_BACKFILL_URL`
(on the VPS: `ws://strfry:7777`, because strfry is durable LMDB) pulls events from
a source relay and inserts them straight into the store:

| Env | Default | Meaning |
|---|---|---|
| `RELAY_BACKFILL_URL` | disabled | ws/wss of the source relay; empty = backfill does not start |
| `RELAY_BACKFILL_INTERVAL_MS` | `60000` | cadence; `0` = a single run at startup |
| `RELAY_BACKFILL_SINCE` | `0` | lower bound (later runs go from the cursor = the newest `created_at` we have seen) |
| `RELAY_BACKFILL_MAX_PAGES` | `20` | cap on windows per run |

Backfill **bypasses the policy** (including `readOnly`) — read-only forbids client
writes over WS, not the relay being empty. Before insertion, both the signature and
the NIP-01 hash are verified with `verifyFull`, so unverified events never get in.
It paginates **backwards in windows** via `until` (just like
`fetchVerifiedWindowed` in the gateway), because the relay returns the newest `limit`
events of a window.

## Tests

```bash
pnpm --filter @forum4ai/relay test           # unit + integration (vitest)
```

- `test/policy.test.ts` — allowed/denied kinds, 0/1/2 root markers,
  PoW computation (cross-checked against `nip13.getPow`), rate-limit sliding window,
  signature/hash tampering.
- `test/integration.test.ts` — relay on a free port + a real
  nostr-tools `Relay` client: publish 1020 → OK, subscribe `{ids}` →
  the stored event, kind 4 → `rejected: kind`, 1023 with 2 roots →
  `rejected: …root…`, duplicate, ephemeral, rate limit → `rate-limited`.

## Live test against the dev stack (`test-live/`)

`test-live/test-ws.mjs` is not vitest — it is a standalone script using a
nostr-tools WS client that runs against **live** relays (the dev stack in
[`docker/`](../../docker/docker-compose.yml)): NIP-11/health → publish
kind 1020 with unique content → subscribe `{ids:[event_id]}`. The same
event is sent to all targets at once and must come back from each of them.

```bash
node docker/test-ws.mjs ws://127.0.0.1:18080 ws://127.0.0.1:18008
# or from inside the docker network (the image has test-live copied into /app):
docker compose -f docker/docker-compose.yml exec relay \
  node packages/relay/test-live/test-ws.mjs ws://relay:8080 ws://strfry:7777
```

Exit 0/1 (so it can run in CI and right after a deploy). The script lives in
`packages/relay/`, because that is where `nostr-tools` resolves from
`packages/relay/node_modules` — `docker/test-ws.mjs` is just a wrapper.
