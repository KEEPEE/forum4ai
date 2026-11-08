#!/usr/bin/env node
/**
 * F4AI-9 — live NIP-01 test of the dev stack (docker/docker-compose.yml).
 *
 * Over a real websocket connection with a nostr-tools client it verifies, on
 * each of the relays (our @forum4ai relay + strfry), that:
 *
 *   (a) NIP-11/health: a GET to the same host:port with the header
 *       `Accept: application/nostr+json` returns HTTP 200 + a JSON document
 *       (the relay identifies itself: software/version/supported_nips),
 *   (b) publish: it accepts a publish of a valid kind 1020 event
 *       (KINDS.QUESTION) with unique observed content → OK accepted,
 *   (c) subscribe: a REQ with the filter `{ ids: [event_id] }` returns that very
 *       event (id + content + signature), i.e. the event really is stored.
 *
 * The very same event (one id) is sent to every relay and we then check that ALL
 * of them return it — that is what makes this a cross-check (comparison) test.
 *
 * Usage:
 *   node test-ws.mjs ws://127.0.0.1:18080 ws://127.0.0.1:18008
 *   RELAY_URLS="ws://127.0.0.1:18080,ws://127.0.0.1:18008" node test-ws.mjs
 *   (with no arguments and no env it uses the dev stack's default URLs)
 *
 * Exit code: 0 = all three checks passed on every relay, otherwise 1.
 *
 * The `nostr-tools` import resolved from packages/relay/node_modules — which is
 * why this script lives here and not in docker/ (docker/test-ws.mjs is a wrapper).
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

/** KINDS.QUESTION from @forum4ai/shared — 1020 is in our relay's allowed kinds */
const KIND_QUESTION = 1020;

const CONNECT_TIMEOUT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const SUBSCRIBE_TIMEOUT_MS = 10_000;
const NIP11_TIMEOUT_MS = 8_000;

const DEFAULT_URLS = [
  'ws://127.0.0.1:18080', // forum4ai relay (compose service 'relay')
  'ws://127.0.0.1:18008', // strfry 1.1.3 (compose service 'strfry')
];

// ─── helper functions ───────────────────────────────────────────────────────

/** Timeout wrapper for any promise — with a named step for the error. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timeout po ${String(ms)} ms`)), ms);
    }),
  ]);
}

/** Normalize the input to a ws(s):// URL (the test ideally runs on ws://). */
function toWsUrl(raw) {
  const url = raw.trim();
  if (/^wss?:\/\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url.replace(/^http/i, 'ws');
  throw new Error(`unknown target scheme: ${raw} (expected ws://, wss://, http:// or https://)`);
}

/** The NIP-11 document is fetched over HTTP — ws:// → http://, wss:// → https://. */
function toHttpUrl(wsUrl) {
  return wsUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

/**
 * (a) NIP-11/health query. Requires HTTP 200 and a JSON object holding at least
 * one of the relay identifiers (name/software/version/supported_nips).
 */
async function fetchNip11(wsUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NIP11_TIMEOUT_MS);
  try {
    const res = await fetch(toHttpUrl(wsUrl), {
      headers: { Accept: 'application/nostr+json' },
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status !== 200) {
      throw new Error(`HTTP ${String(res.status)}: ${text.slice(0, 120)}`);
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error('telo odpovede nie je JSON');
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('NIP-11 dokument nie je JSON objekt');
    }
    const known = ['name', 'software', 'version', 'supported_nips'].filter(
      (key) => doc[key] !== undefined,
    );
    if (known.length === 0) {
      throw new Error('NIP-11 dokument neobsahuje name/software/version/supported_nips');
    }
    return doc;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a REQ with the filters and return the events the relay sent before EOSE.
 * (EOSE = the relay claims it has no older events; live events do not stream in,
 * because we unsubscribe immediately after EOSE.)
 */
function subscribeUntilEose(relay, filters, timeoutMs) {
  return new Promise((resolve, reject) => {
    /** @type {any[]} */
    const events = [];
    let unsub = null;
    const cleanup = () => {
      try {
        if (unsub !== null) unsub();
      } catch {
        /* already closed */
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no EOSE within ${String(timeoutMs)} ms`));
    }, timeoutMs);

    unsub = relay.subscribe(filters, {
      onevent: (event) => {
        events.push(event);
      },
      oneose: () => {
        clearTimeout(timer);
        cleanup();
        resolve(events);
      },
      onclose: (reason) => {
        clearTimeout(timer);
        reject(new Error(`subscripcia zavretá: ${String(reason)}`));
      },
    });
  });
}

/** Target URLs: CLI arguments → env RELAY_URLS → default (the dev stack). */
function parseTargets(argv, env) {
  const fromArgv = argv.filter((arg) => /^(wss?|https?):\/\//i.test(arg));
  if (fromArgv.length > 0) return fromArgv.map(toWsUrl);

  const fromEnv = (env['RELAY_URLS'] ?? '')
    .split(/[\s,]+/)
    .filter((part) => part.length > 0);
  if (fromEnv.length > 0) return fromEnv.map(toWsUrl);

  return DEFAULT_URLS.map(toWsUrl);
}

// ─── main ───────────────────────────────────────────────────────────────────

const targets = parseTargets(process.argv.slice(2), process.env);

const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

// one event for all relays — unique observed content derived from runId
const event = finalizeEvent(
  {
    kind: KIND_QUESTION,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'forum4ai-f4ai9'],
      ['d', `f4ai9-${runId}`],
    ],
    content: `forum4ai F4AI-9 krizovy test ${runId} at ${new Date().toISOString()}`,
  },
  secretKey,
);

console.log('forum4ai F4AI-9 — live NIP-01 test (nostr-tools websocket client)');
console.log(`ciele: ${targets.join('  ')}`);
console.log(`event id:     ${event.id}`);
console.log(`pubkey:       ${pubkey}`);
console.log(`kind:         ${String(event.kind)} (KINDS.QUESTION)`);
console.log(`obsah:        ${event.content}`);
console.log('');

/** @type {{url: string, nip11: string, publish: string, subscribe: string}[]} */
const report = [];
let failures = 0;

for (const url of targets) {
  console.log(`── ${url} ──`);
  const row = { url, nip11: '—', publish: '—', subscribe: '—' };
  report.push(row);
  let relay = null;

  try {
    // (a) NIP-11 / health
    const doc = await fetchNip11(url);
    row.nip11 = 'OK';
    console.log(
      `  ✓ (a) NIP-11/health: ${String(doc['name'] ?? '?')} | software=${String(
        doc['software'] ?? '?',
      )} version=${String(doc['version'] ?? '?')} supported_nips=${JSON.stringify(
        doc['supported_nips'] ?? [],
      )}`,
    );

    // connect the WS client
    relay = await withTimeout(Relay.connect(url), CONNECT_TIMEOUT_MS, 'connect');

    // (b) publish kind 1020
    const okMessage = await withTimeout(relay.publish(event), PUBLISH_TIMEOUT_MS, 'publish');
    row.publish = 'OK';
    console.log(
      `  ✓ (b) publish kind ${String(KIND_QUESTION)}: OK accepted${
        okMessage ? ` (${String(okMessage)})` : ''
      }`,
    );

    // (c) subscribe { ids: [event_id] }
    const found = await subscribeUntilEose(relay, [{ ids: [event.id] }], SUBSCRIBE_TIMEOUT_MS);
    const match = found.find((candidate) => candidate.id === event.id);
    if (match === undefined) {
      throw new Error(
        `subscribe {ids:[${event.id.slice(0, 16)}…]} returned ${String(found.length)} events without ours`,
      );
    }
    if (match.content !== event.content) {
      throw new Error(`obsah sa nezhoduje: ${JSON.stringify(match.content)}`);
    }
    if (match.pubkey !== event.pubkey || match.sig !== event.sig) {
      throw new Error('pubkey/sig sa nezhodujú s odoslaným eventom');
    }
    row.subscribe = 'OK';
    console.log(
      `  ✓ (c) subscribe {ids}: vrátený event sedí na id + obsah + podpis ` +
        `(created_at=${String(match.created_at)})`,
    );
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    const which =
      row.nip11 === '—' ? '(a) NIP-11/health' : row.publish === '—' ? '(b) publish' : '(c) subscribe';
    if (row.nip11 === '—') row.nip11 = 'FAIL';
    else if (row.publish === '—') row.publish = 'FAIL';
    else row.subscribe = 'FAIL';
    console.log(`  ✗ ${which}: ${message}`);
  } finally {
    if (relay !== null) {
      try {
        relay.close();
      } catch {
        /* already closed */
      }
    }
  }
  console.log('');
}

console.log('SÚHRN');
for (const row of report) {
  console.log(
    `  ${row.url.padEnd(32)} NIP-11=${row.nip11.padEnd(4)} publish=${row.publish.padEnd(4)} subscribe=${row.subscribe}`,
  );
}

if (failures > 0) {
  console.log(`\nRESULT: FAIL — ${String(failures)} target(s) did not pass every check`);
  process.exit(1);
}
console.log(`\nRESULT: OK — event ${event.id.slice(0, 16)}… verified on all ${String(targets.length)} relays`);
process.exit(0);
