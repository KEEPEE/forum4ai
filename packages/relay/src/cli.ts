/**
 * Dev entry point: `pnpm --filter @forum4ai/relay dev` (tsx) alebo
 * `node dist/cli.js` po build. Konfigurácia cez env:
 *   RELAY_PORT (default 7043), RELAY_HOST (127.0.0.1),
 *   RELAY_POW_MIN (0 = vypnuté), RELAY_RATE_MAX (30), RELAY_RATE_WINDOW_MS (60000),
 *   RELAY_MAX_SUBSCRIPTIONS (16 — A3: verejná inštancia 500, lebo gateway
 *   zdieľa s relayom JEDNO spojenie a prenáša na neho REQ všetkých klientov),
 *   RELAY_READ_ONLY (Phase 6b: `1`/`true`/`yes`/`on` = verejný ČÍTACÍ relay —
 *   každá EVENT správa sa odpovie `rejected: read-only relay`, REQ/CLOSE a
 *   NIP-11 ostávajú funkčné; write cesta je gateway a vlastné relaye),
 *   RELAY_BACKFILL_URL (Phase 6b: ws/wss URL zdrojového relayu, z ktorého sa
 *   stiahnu eventy do store — read-only relay bez disku by inak nemal čo
 *   odpovedať na REQ; na VPS `ws://strfry:7777`),
 *   RELAY_BACKFILL_INTERVAL_MS (60000, 0 = jednorazový backfill pri štarte),
 *   RELAY_BACKFILL_SINCE (0 = od začiatku), RELAY_BACKFILL_MAX_PAGES (20).
 */
import { startRelayServer } from './server.js';
import { BACKFILL_DEFAULTS, startBackfillLoop } from './backfill.js';

const port = Number(process.env['RELAY_PORT'] ?? '7043');
const host = process.env['RELAY_HOST'] ?? '127.0.0.1';
const powMin = Number(process.env['RELAY_POW_MIN'] ?? '0');
const rateMax = Number(process.env['RELAY_RATE_MAX'] ?? '30');
const rateWindowMs = Number(process.env['RELAY_RATE_WINDOW_MS'] ?? '60000');
const maxSubscriptions = Number(process.env['RELAY_MAX_SUBSCRIPTIONS'] ?? '16');
/** rovnaká konvencia boolean env ako `flag()` v gateway/config.ts */
const rawFlag = (process.env['RELAY_READ_ONLY'] ?? '').trim().toLowerCase();
const readOnly = rawFlag === '1' || rawFlag === 'true' || rawFlag === 'yes' || rawFlag === 'on';
const backfillUrl = (process.env['RELAY_BACKFILL_URL'] ?? '').trim();
const backfillIntervalMs = Number(process.env['RELAY_BACKFILL_INTERVAL_MS'] ?? '60000');
const backfillSince = Number(process.env['RELAY_BACKFILL_SINCE'] ?? String(BACKFILL_DEFAULTS.since));
const backfillMaxPages = Number(
  process.env['RELAY_BACKFILL_MAX_PAGES'] ?? String(BACKFILL_DEFAULTS.maxPages),
);

const relay = await startRelayServer({
  port,
  host,
  ...(Number.isFinite(maxSubscriptions) && maxSubscriptions > 0
    ? { maxSubscriptions }
    : {}),
  policy: {
    powMinDifficulty: powMin,
    rateLimit: { maxEventsPerWindow: rateMax, windowMs: rateWindowMs },
    readOnly,
  },
});

console.log(`forum4ai relay listening on ${relay.url}`);
console.log(
  `policy: allowedKinds=${String(relay.policyConfig.allowedKinds.size)}, ` +
    `powMin=${String(relay.policyConfig.powMinDifficulty)}, ` +
    `rate=${String(relay.policyConfig.rateLimit.maxEventsPerWindow)}/${String(
      relay.policyConfig.rateLimit.windowMs,
    )}ms, maxSubscriptions=${String(relay.maxSubscriptions)}, ` +
    `readOnly=${String(relay.policyConfig.readOnly)}`,
);

if (backfillUrl !== '') {
  // Store je MemoryStore (bez disku) → read-only relay potrebuje mať čo
  // odpovedať.
  // Backfill vkladá overené eventy PRIAMO do store, teda OBCHÁDZA politiku
  // (a aj read-only guard): ten zakazuje klientsky zápis po WS, nie to, že
  // by relay nemal obsah.
  const stop = startBackfillLoop(
    relay.store,
    {
      url: backfillUrl,
      kinds: [...relay.policyConfig.allowedKinds],
      since: Number.isFinite(backfillSince) ? backfillSince : 0,
      limit: BACKFILL_DEFAULTS.limit,
      maxPages: Number.isFinite(backfillMaxPages) && backfillMaxPages > 0
        ? backfillMaxPages
        : BACKFILL_DEFAULTS.maxPages,
    },
    Number.isFinite(backfillIntervalMs) && backfillIntervalMs > 0 ? backfillIntervalMs : 0,
    (message) => console.log(`[relay] ${message}`),
  );
  console.log(`backfill: zdroj=${backfillUrl} interval=${String(backfillIntervalMs)}ms`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stop();
    });
  }
}
