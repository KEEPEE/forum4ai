#!/usr/bin/env node
/**
 * F4AI-9 — wrapper around the live WS test of the dev stack.
 *
 * The real test lives in `packages/relay/test-live/test-ws.mjs`, because that is
 * where `nostr-tools` resolved from `packages/relay/node_modules` (pnpm workspace).
 * Node resolves imports relative to the module that writes them — so it is enough
 * for this wrapper to live in docker/ and import its sibling script.
 *
 * Usage (the same arguments as the test itself):
 *   node docker/test-ws.mjs ws://127.0.0.1:18080 ws://127.0.0.1:18008
 *   RELAY_URLS="ws://…:18080,ws://…:18008" node docker/test-ws.mjs
 *
 * Exit code 0/1 is inherited from the test.
 */
await import('../packages/relay/test-live/test-ws.mjs');
