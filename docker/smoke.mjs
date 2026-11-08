#!/usr/bin/env node
/**
 * docker/smoke.mjs — F4AI-21 (S15): smoke test of the dev stack's whole chain.
 *
 * Node 22, no build step. The only dependency is `nostr-tools` (event signing +
 * verifyEvent); REST goes through the global `fetch`, WS through the global
 * `WebSocket` (Node 22 has both without flags). Import resolution:
 *
 *   - the repo workspace (this container): `nostr-tools` is a devDependency of
 *     the root package.json → `pnpm install` puts it in the root node_modules;
 *   - the host machine (no pnpm, no root node_modules):
 *       cd ~/forum4ai-dev/docker && npm install --no-save --no-package-lock nostr-tools@2.25.2
 *     npm finds `package.json` at the repository root and installs into
 *     `~/forum4ai-dev/node_modules` — ESM resolution from `docker/smoke.mjs`
 *     walks up the tree and finds it there (verified during the 2026-10-29 deploy).
 *
 * Checks (exit 0 = all OK, otherwise 1):
 *   1  GET  gateway /health          → status ok, ≥2 relays connected
 *   2  GET  relay NIP-11 (ours)      → software forum4ai-relay
 *   3  GET  relay NIP-11 (strfry)    → software strfry
 *   4  GET  strfry /metrics          → 200, Prometheus text `nostr_`
 *   5  UI   GET /                    → 200 text/html with <div id="root">
 *   6  UI   main asset               → 200 application/javascript
 *   7  sign+verifyEvent              → nostr-tools finalizeEvent/verifyEvent
 *   8  POST gateway /events          → publish 1020 with a token, quorum_met
 *   9  WS   gateway /ws              → REQ → EVENT (our id) → EOSE
 *   10 GET  gateway /threads/:id     → root = our event (retry 20 s)
 *   11 GET  gateway /feed            → 200, items[]
 *   12 GET  gateway /topics          → 200, topics[]
 *   13 GET  gateway /ideas           → 200, items[]
 *   14 GET  gateway /search?q=token  → event found (retry budget 60 s)
 *   15 GET  gateway /reputation/:pk  → 200 card (retry budget 60 s)
 *
 * Usage:
 *   node docker/smoke.mjs                                   # default dev stack
 *   node docker/smoke.mjs --base-http http://localhost:18081 \
 *                           --ui http://localhost:18082     # locally on the host
 *   node docker/smoke.mjs --relays ws://HOST:18080,ws://HOST:18008
 *
 * `--relays` also feeds NIP-11 (GET with `Accept: application/nostr+json`); the
 * default `/metrics` URL comes from the second relay (strfry), overridable with `--metrics`.
 */
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools/pure';
import { randomBytes } from 'node:crypto';

// ── arguments ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  'base-http': 'http://127.0.0.1:18081',
  ui: 'http://127.0.0.1:18082',
  relays: 'ws://127.0.0.1:18080,ws://127.0.0.1:18008',
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    if (arg.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[arg.slice(2)] = argv[++i];
      continue;
    }
    throw new Error(`neznámy argument: ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  console.log(
    'usage: node docker/smoke.mjs [--base-http URL] [--ui URL] [--relays ws://A,ws://B] [--metrics URL] [--search-budget MS]',
  );
  process.exit(0);
}

const BASE = args['base-http'].replace(/\/+$/, '');
const UI = args.ui.replace(/\/+$/, '');
const RELAYS = args.relays
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
if (RELAYS.length < 2) {
  console.error(`--relays must contain at least 2 comma-separated addresses (got: ${args.relays})`);
  process.exit(1);
}
/** ws(s):// → http(s):// — NIP-11 is read with an HTTP GET at the same address */
function toHttp(wsUrl) {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
}
const METRICS = (args.metrics ?? `${toHttp(RELAYS[1])}/metrics`).replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 10_000;
const SEARCH_BUDGET_MS = Number(args['search-budget'] ?? 60_000);
const THREAD_BUDGET_MS = Number(args['thread-budget'] ?? 20_000);

// ── framework helpers ────────────────────────────────────────────────────────

const startedAt = Date.now();
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? '[OK]  ' : '[FAIL]';
  console.log(`${mark} ${name.padEnd(34)} ${detail}`);
}

/** one HTTP request with a timeout; never throws — returns {status, text, json, error} */
async function httpGet(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON — optional */
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      text,
      json,
      error: null,
    };
  } catch (err) {
    return { status: 0, contentType: '', text: '', json: null, error: errMessage(err) };
  }
}

async function httpPostJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, text, json, error: null };
  } catch (err) {
    return { status: 0, text: '', json: null, error: errMessage(err) };
  }
}

function errMessage(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Slovak pluralization of "pokus" (attempt) for the retry details */
function pokus(n) {
  if (n === 1) return '1 pokuse';
  if (n >= 2 && n <= 4) return `${String(n)} pokusoch`;
  return `${String(n)} pokusov`;
}

/**
 * Repeats `attempt` (returns {ok, detail}) on a deadline budget. Indexer and relay
 * propagation is asymptotic — retrying is part of the design, not a workaround.
 */
async function retryUntil(label, attempt, budgetMs, intervalMs = 2000) {
  const deadline = Date.now() + budgetMs;
  // the first iteration assigns before anything is read — no initializer,
  // otherwise eslint flags `no-useless-assignment`
  let last;
  let tries = 0;
  for (;;) {
    tries++;
    last = await attempt();
    if (last.ok === true) {
      record(label, true, `${last.detail} (po ${pokus(tries)})`);
      return;
    }
    if (Date.now() + intervalMs > deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  record(label, false, `${last.detail} — budget of ${String(budgetMs / 1000)} s exhausted`);
}

// ── WS check (the global WebSocket in Node 22) ───────────────────────────────

/**
 * NIP-01 `REQ` against the gateway /ws: waits for an EVENT with our id and an EOSE for sub_id.
 * Returns {ok, detail}. A one-shot connection; after EOSE it sends CLOSE and close().
 */
function wsReqEose(wsUrl, subId, filter, wantEventId, timeoutMs) {
  return new Promise((resolve) => {
    const finish = (ok, detail) => {
      try {
        // the global WebSocket (undici) only has the standard close() — after a
        // CLOSE message a correct close() is enough; terminate() does not exist here (only `ws` has it)
        if (ws !== undefined && ws.readyState === 1) {
          ws.send(JSON.stringify(['CLOSE', subId]));
          ws.close();
        }
      } catch {
        /* already closed */
      }
      resolve({ ok, detail });
    };
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      resolve({ ok: false, detail: `WebSocket constructor: ${errMessage(err)}` });
      return;
    }
    let gotEvent = false;
    let gotEose = false;
    const timer = setTimeout(() => {
      finish(false, `timed out after ${String(timeoutMs)} ms waiting for a reply (EVENT=${String(gotEvent)}, EOSE=${String(gotEose)})`);
    }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]?.id === wantEventId) {
        gotEvent = true;
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        gotEose = true;
      }
      if (gotEvent && gotEose) {
        clearTimeout(timer);
        finish(true, 'EVENT with our id + EOSE delivered');
      }
    });
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer);
      finish(false, `WS chyba: ${ev?.message ?? 'unknown'}`);
    });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      if (!gotEvent || !gotEose) {
        finish(false, `WS uzavretý skôr ako odpovedala (code ${String(ev.code)}, EVENT=${String(gotEvent)}, EOSE=${String(gotEose)})`);
      }
    });
  });
}

// ── NIP-11 check ─────────────────────────────────────────────────────────────

async function checkNip11(label, wsUrl, expectSoftwareIncludes) {
  const url = `${toHttp(wsUrl)}/`;
  const res = await httpGet(url, { Accept: 'application/nostr+json' });
  if (res.error !== null) {
    record(label, false, `${url} → ${res.error}`);
    return;
  }
  if (res.status !== 200 || res.json === null) {
    record(label, false, `${url} → HTTP ${String(res.status)}, nie JSON NIP-11 document`);
    return;
  }
  const software = typeof res.json.software === 'string' ? res.json.software : '';
  const version = typeof res.json.version === 'string' ? res.json.version : '?';
  if (!software.toLowerCase().includes(expectSoftwareIncludes.toLowerCase())) {
    record(label, false, `${url} → software '${software}' neobsahuje '${expectSoftwareIncludes}'`);
    return;
  }
  record(label, true, `${url} → software=${software} version=${version}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('── forum4ai smoke (F4AI-21) ' + '─'.repeat(40));
  console.log(`  gateway: ${BASE}`);
  console.log(`  ui:      ${UI}`);
  console.log(`  relaye:  ${RELAYS.join(', ')}`);
  console.log(`  metrics: ${METRICS}`);
  console.log('');

  // 1) gateway /health — 2 relays connected
  {
    const res = await httpGet(`${BASE}/health`);
    if (res.error !== null) {
      record('gateway /health', false, `${BASE}/health → ${res.error}`);
    } else if (res.status !== 200 || res.json?.status !== 'ok') {
      record('gateway /health', false, `HTTP ${String(res.status)}, status=${String(res.json?.status)}`);
    } else {
      const relays = Array.isArray(res.json.relays) ? res.json.relays : [];
      const connected = relays.filter((r) => r.connected === true).length;
      const indexOk = res.json.index?.available === true;
      record(
        'gateway /health',
        relays.length >= 2 && connected === relays.length,
        `${String(connected)}/${String(relays.length)} relayov connected, index available=${String(indexOk)}`,
      );
    }
  }

  // 2) + 3) NIP-11 on both relays
  await checkNip11('relay NIP-11 (nas)', RELAYS[0], 'forum4ai-relay');
  await checkNip11('relay NIP-11 (strfry)', RELAYS[1], 'strfry');

  // 4) strfry /metrics
  {
    const res = await httpGet(METRICS);
    const looksPrometheus = res.text.includes('nostr_');
    record(
      'strfry /metrics',
      res.status === 200 && looksPrometheus,
      res.error !== null
        ? `${METRICS} → ${res.error}`
        : `HTTP ${String(res.status)}, ${String(res.text.length)} B Prometheus textu, nostr_ metric=${String(looksPrometheus)}`,
    );
  }

  // 5) UI HTML
  let mainAsset = null;
  {
    const res = await httpGet(`${UI}/`);
    const isHtml = res.contentType.includes('text/html');
    const hasRoot = res.text.includes('<div id="root"');
    const assetMatch = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(res.text);
    if (assetMatch !== null) mainAsset = assetMatch[1];
    record(
      'UI GET /',
      res.status === 200 && isHtml && hasRoot,
      res.error !== null
        ? `${UI}/ → ${res.error}`
        : `HTTP ${String(res.status)}, content-type=${res.contentType.split(';')[0]}, root div=${String(hasRoot)}, asset=${mainAsset ?? '(nenajdeny)'}`,
    );
  }

  // 6) UI main asset
  if (mainAsset !== null) {
    const res = await httpGet(`${UI}${mainAsset}`);
    const isJs = /javascript|ecmascript/.test(res.contentType);
    record(
      'UI main asset',
      res.status === 200 && isJs,
      `${mainAsset} → HTTP ${String(res.status)}, content-type=${res.contentType.split(';')[0]}, ${String(res.text.length)} B`,
    );
  } else {
    record('UI main asset', false, 'index.html has no <script src="/assets/…js"> — the UI build is probably not what we expect');
  }

  // 7) signing + verifyEvent (locally, before the publish)
  const token = `smoke${randomBytes(4).toString('hex')}`; // one FTS token with no hyphens
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const template = {
    kind: 1020,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: `forum4ai smoke F4AI-21 token ${token} — riadny testovaci event, mozes ho smazat`,
  };
  let event;
  try {
    event = finalizeEvent(template, secretKey);
    const hashMatches = getEventHash(event) === event.id;
    const sigOk = verifyEvent(event);
    record(
      'sign + verifyEvent (1020)',
      sigOk && hashMatches,
      `id=${event.id.slice(0, 16)}… pubkey=${pubkey.slice(0, 16)}… verifyEvent=${String(sigOk)}, hash=${String(hashMatches)}`,
    );
  } catch (err) {
    record('sign + verifyEvent (1020)', false, `finalizeEvent/verifyEvent: ${errMessage(err)}`);
  }

  if (event === undefined) {
    // without the event there is no point continuing the write/read/WS part
    finish();
    return;
  }

  // 8) POST /events — publish with a quorum
  {
    const res = await httpPostJson(`${BASE}/events`, event);
    const ok = res.status === 200 && res.json?.ok === true && res.json?.quorum_met === true && res.json?.event_id === event.id;
    const relayResults = Array.isArray(res.json?.results)
      ? res.json.results.map((r) => `${(r.url ?? '?').replace(/^wss?:\/\//, '')}=${r.ok === true ? 'ok' : 'fail'}`).join(' ')
      : 'bez results';
    record(
      'POST /events publish 1020',
      ok,
      res.error !== null
        ? `${BASE}/events → ${res.error}`
        : `HTTP ${String(res.status)}, quorum_met=${String(res.json?.quorum_met)}, ${relayResults}`,
    );
  }

  // 9) WS /ws REQ → EVENT → EOSE
  {
    const wsUrl = `${BASE.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/ws`;
    const out = await wsReqEose(wsUrl, 'smoke1', { ids: [event.id], limit: 1 }, event.id, 15_000);
    record('WS /ws REQ/EOSE', out.ok, out.detail);
  }

  // 10) /threads/:id — root = our event (propagation to the relays)
  await retryUntil(
    'GET /threads/:id',
    async () => {
      const res = await httpGet(`${BASE}/threads/${event.id}`);
      if (res.error !== null) return { ok: false, detail: res.error };
      if (res.status !== 200) return { ok: false, detail: `HTTP ${String(res.status)} ${res.text.slice(0, 80)}` };
      if (res.json?.root?.id !== event.id) return { ok: false, detail: `root.id=${String(res.json?.root?.id)} ≠ our event` };
      return { ok: true, detail: `root=${String(res.json.root.kind)} ${String(res.json.root.id).slice(0, 12)}…, replies=${String(res.json.reply_count)}` };
    },
    THREAD_BUDGET_MS,
  );

  // 11) – 13) /feed, /topics, /ideas — shape checks
  for (const [label, key] of [
    ['/feed', 'items'],
    ['/topics', 'topics'],
    ['/ideas', 'items'],
  ]) {
    const res = await httpGet(`${BASE}${label}`);
    const arr = Array.isArray(res.json?.[key]) ? res.json[key].length : -1;
    record(
      `GET ${label}`,
      res.status === 200 && arr >= 0,
      res.error !== null ? `${BASE}${label} → ${res.error}` : `HTTP ${String(res.status)}, ${key}[]=${String(arr)}`,
    );
  }

  // 14) /search — finding the token (the indexer needs time)
  await retryUntil(
    'GET /search (token)',
    async () => {
      const res = await httpGet(`${BASE}/search?q=${encodeURIComponent(token)}`);
      if (res.error !== null) return { ok: false, detail: res.error };
      if (res.status === 503) return { ok: false, detail: `503 index unavailable: ${String(res.json?.reason)}` };
      if (res.status !== 200) return { ok: false, detail: `HTTP ${String(res.status)}` };
      const results = Array.isArray(res.json?.results) ? res.json.results : [];
      const hit = results.find((r) => r.id === event.id);
      if (hit === undefined) return { ok: false, detail: `count=${String(res.json?.count)}, our event is not among the ${String(results.length)} hits` };
      return { ok: true, detail: `hit id=${String(hit.id).slice(0, 12)}…, snippet="${String(hit.snippet ?? '').slice(0, 40)}…"` };
    },
    SEARCH_BUDGET_MS,
  );

  // 15) /reputation/:pubkey — 404 until the indexer has read our first event
  await retryUntil(
    'GET /reputation/:pubkey',
    async () => {
      const res = await httpGet(`${BASE}/reputation/${pubkey}`);
      if (res.error !== null) return { ok: false, detail: res.error };
      if (res.status === 404) return { ok: false, detail: '404 pubkey is not in the index yet' };
      if (res.status !== 200) return { ok: false, detail: `HTTP ${String(res.status)}` };
      if (res.json?.pubkey !== pubkey) return { ok: false, detail: `pubkey v odpovedi sedí (${String(res.json?.pubkey)})` };
      return { ok: true, detail: `epoch=${String(res.json?.epoch)}, domény=${Object.keys(res.json?.domains ?? {}).join('/')}` };
    },
    SEARCH_BUDGET_MS,
  );

  finish();
}

function finish() {
  const okCount = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log('');
  console.log('─'.repeat(64));
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  FAIL: ${r.name} — ${r.detail}`);
  }
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`súhrn: ${String(okCount)}/${String(total)} OK, ${secs} s → exit ${okCount === total ? '0' : '1'}`);
  process.exit(okCount === total ? 0 : 1);
}

main().catch((err) => {
  console.error(`smoke failed unexpectedly: ${errMessage(err)}`);
  if (err instanceof Error && err.stack !== undefined) console.error(err.stack);
  process.exit(1);
});
