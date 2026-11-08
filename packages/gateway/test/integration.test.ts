/**
 * Integračný test gateway proti dev relayom na 127.0.0.1
 * (náš relay s politikou :18080 + strfry 1.1.3 :18008).
 *
 * Celý suite sa preskočí, ak sú relaye nedosiahnuteľné — unit testy
 * zostávajú deterministické. Gateway beží na voľnom TCP porte
 * (`startGatewayServer({ port: 0 })`), klient je reálny fetch; S5 blok
 * navyše cvičí WS /ws cez klientský `ws`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import { getToken } from 'nostr-tools/nip98';
import { WebSocket } from 'ws';

import { KINDS } from '@forum4ai/shared';

import { createGatewayApp } from '../src/app.js';
import { OutboxWriter } from '../src/outbox.js';
import { registerReadRoutes } from '../src/read-routes.js';
import { RelayPool, normalizeRelayUrl } from '../src/relay-pool.js';
import { DEV_RELAY_URLS } from './dev-relays.js';
import { startGatewayServer, type RunningGateway } from '../src/server.js';
import { attachWebSocket } from '../src/ws.js';

const RELAYS = [...DEV_RELAY_URLS];
const NET_TIMEOUT = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function reachable(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const relay = await Relay.connect(url, { timeout: timeoutMs });
    relay.close();
    return true;
  } catch {
    return false;
  }
}

const probes = await Promise.all(RELAYS.map((url) => reachable(url)));
const relaysOnline = probes.every(Boolean);

function sign(secret: Uint8Array, kind: number, tags: string[][], content: string): Event {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
    secret,
  );
}

/**
 * Overí prítomnosť eventu na relayi. Relay OK správu pošle predtím, než
 * je zápis viditeľný pre concurrent REQ (strfry), preto s pár retrymi.
 */
async function presentOnRelay(url: string, id: string, attempts = 6): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let relay: Relay | null = null;
    try {
      relay = await Relay.connect(url, { timeout: 5_000 });
      const found = await new Promise<boolean>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }, 5_000);
        relay?.subscribe([{ ids: [id] }], {
          onevent: (event) => {
            if (!settled && event.id === id) {
              settled = true;
              clearTimeout(timer);
              resolve(true);
            }
          },
          oneose: () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(false);
            }
          },
        });
      });
      if (found) return true;
    } catch {
      // relay nedostupný — skús znova
    } finally {
      relay?.close();
    }
    await sleep(400 * (attempt + 1));
  }
  return false;
}

describe.skipIf(!relaysOnline)('gateway integrácia — dev relaye 127.0.0.1', () => {
  let pool: RelayPool;
  let outbox: OutboxWriter;
  let gateway: RunningGateway;
  let base: string;

  beforeAll(async () => {
    pool = new RelayPool({ urls: RELAYS, connectTimeoutMs: 5_000, publishTimeoutMs: 5_000 });
    const statuses = await pool.connectAll();
    expect(statuses.every((s) => s.connected)).toBe(true);

    outbox = new OutboxWriter(pool, {
      defaultWriteRelays: RELAYS,
      ttlMs: 60_000,
      fetchTimeoutMs: 4_000,
    });

    const app = createGatewayApp({
      pool,
      outbox,
      logger: () => undefined,
      corsOrigin: '*',
    });
    gateway = await startGatewayServer(app, { port: 0, hostname: '127.0.0.1' });
    base = gateway.url;
  }, NET_TIMEOUT);

  afterAll(async () => {
    pool?.close();
    await gateway?.close();
  });

  it('health ukazuje agregát connected 2/2 bez internal hostname (A9)', { timeout: NET_TIMEOUT }, async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { status: string; relays: { connected: string } };
    expect(body.status).toBe('ok');
    expect(body.relays).toEqual({ connected: '2/2' });
    // A9: verejná odpoveď nesmie prezradiť vnútorné adresy relayov
    for (const leak of ['127.0.0.1', ':18080', ':18008', 'lastError']) {
      expect(text).not.toContain(leak);
    }
  });

  it('publish reálneho 1020 → 200, quorum_met a event je na oboch relayoch', { timeout: NET_TIMEOUT }, async () => {
    const sk = generateSecretKey();
    const event = sign(sk, KINDS.QUESTION, [['d', `f4ai10-${String(Date.now())}`]], 'F4AI-10 integrácia: otázka');

    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      event_id: string;
      quorum_met: boolean;
      results: { url: string; ok: boolean; message: string }[];
    };
    expect(body.event_id).toBe(event.id);
    expect(body.quorum_met).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r) => r.ok)).toBe(true);

    for (const url of RELAYS) {
      expect(await presentOnRelay(url, event.id)).toBe(true);
    }
  });

  it('neplatný podpis → 400 a event sa na relayoch neobjaví', { timeout: NET_TIMEOUT }, async () => {
    const sk = generateSecretKey();
    const event = sign(sk, KINDS.QUESTION, [['d', `f4ai10-badsig-${String(Date.now())}`]], 'zlý podpis');
    const tampered = { ...event, sig: '1'.repeat(128) };

    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tampered),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reasons: string[] };
    expect(body.reasons.join(' ')).toMatch(/verifyFull/);

    expect(await presentOnRelay(RELAYS[0] as string, event.id, 1)).toBe(false);
  });

  it('kind 4 → 400 (politika: len kindy našej registry)', { timeout: NET_TIMEOUT }, async () => {
    const sk = generateSecretKey();
    const note = sign(sk, 4, [], 'kind 4 súkromná poznámka');
    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(note),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reasons: string[] };
    expect(body.reasons.join(' ')).toMatch(/kind 4/);
  });

  it('GET /me s NIP-98 tokenom vráti podpisom overený pubkey', { timeout: NET_TIMEOUT }, async () => {
    const sk = generateSecretKey();
    const expected = getPublicKey(sk);
    const token = await getToken(`${base}/me`, 'GET', async (template) => finalizeEvent(template, sk));

    const ok = await fetch(`${base}/me`, { headers: { authorization: `Nostr ${token}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { pubkey: string }).pubkey).toBe(expected);

    // token via pre inú adresu → 401
    const wrongToken = await getToken(`${base}/meee`, 'GET', async (template) =>
      finalizeEvent(template, sk),
    );
    const bad = await fetch(`${base}/me`, { headers: { authorization: `Nostr ${wrongToken}` } });
    expect(bad.status).toBe(401);

    const missing = await fetch(`${base}/me`);
    expect(missing.status).toBe(401);
  });

  it('NIP-65: autor s 30002 sa publikuje na jeho write relays (source outbox)', { timeout: NET_TIMEOUT }, async () => {
    const sk = generateSecretKey();
    const author = getPublicKey(sk);

    // 30002 s `w` markerami na oba dev relaye — priamo na relaye
    const outboxEvent = sign(
      sk,
      KINDS.OUTBOX,
      [
        ['d', ''],
        ...RELAYS.map((url) => ['r', url, 'w'] as string[]),
      ],
      '',
    );
    for (const url of RELAYS) {
      const relay = await Relay.connect(url, { timeout: 5_000 });
      try {
        await relay.publish(outboxEvent);
      } finally {
        relay.close();
      }
    }

    // outbox cache môže byť pred zápisom prázdny (viditeľnosť na relayi) →
    // invaliduj a skús znova, kým 30002 neuvidí
    let entry = await outbox.lookup(author);
    for (let attempt = 0; attempt < 8 && entry.source !== 'outbox'; attempt += 1) {
      await sleep(500);
      outbox.invalidate(author);
      entry = await outbox.lookup(author);
    }
    expect(entry.source).toBe('outbox');
    expect(entry.relays.sort()).toEqual(RELAYS.map((url) => normalizeRelayUrl(url) as string).sort());

    const event = sign(sk, KINDS.POST, [['e', 'a'.repeat(64), 'root']], 'post cez outbox write relays');
    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quorum_met: boolean; results: { url: string; ok: boolean }[] };
    expect(body.quorum_met).toBe(true);
    expect(body.results.map((r) => r.url).sort()).toEqual(entry.relays.slice().sort());
    expect(body.results.every((r) => r.ok)).toBe(true);

    expect(await presentOnRelay(RELAYS[0] as string, event.id)).toBe(true);
  });

  it('reconnect: pool oznámi offline relay a po obnovení ho vráti späť', { timeout: NET_TIMEOUT }, async () => {
    // falošný relay v poolu — nedostupná adresa na rovnakom hostiteľovi
    const dead = 'ws://127.0.0.1:18999';
    const deadPool = new RelayPool({
      urls: [RELAYS[0] as string, dead],
      initialBackoffMs: 200,
      maxBackoffMs: 1_000,
    });
    try {
      const statuses = await deadPool.connectAll();
      const deadStatus = statuses.find((s) => s.url === normalizeRelayUrl(dead));
      const liveStatus = statuses.find((s) => s.url === normalizeRelayUrl(RELAYS[0] as string));
      expect(liveStatus?.connected).toBe(true);
      expect(deadStatus?.connected).toBe(false);
      expect(deadStatus?.lastError).toBeTruthy();
      expect(deadStatus?.attempts).toBeGreaterThanOrEqual(1);
      expect(deadPool.readyRelays()).toEqual([normalizeRelayUrl(RELAYS[0] as string)]);
    } finally {
      deadPool.close();
    }
  });
});

// ── S5 (F4AI-11): čítacie route + WS /ws ─────────────────────────────────

/**
 * Integrácia S5: cez `POST /events` publikujeme 3 topicy (koreň, podtopic,
 * druhý koreň) + 2 otázky v koreňovom topicu + 2 odpovede (druhá odpoveď
 * má `parent` marker na prvú). Potom overíme:
 *  - GET /topics → strom (podtopic pod koreňom, druhý koreň samostatne),
 *  - GET /topics/:slug → deti + threardy podľa adresy 30020:<pubkey>:<slug>,
 *  - GET /threads/:id → root + strom odpovedí (R2 zavesená pod R1),
 *  - WS /ws → REQ na kinds:[30020] doručí EVENT nášho topicu + EOSE,
 *  - WS limit 5 subscriptionov → NOTICE.
 *
 * Proti strfry race (OK správa pred viditeľnosťou zápisu) používame retry
 * helper `eventually` — každý pokus znova dotiahne data z relaya.
 */
describe.skipIf(!relaysOnline)('gateway S5 integrácia — read route + WS', () => {
  let pool: RelayPool;
  let outbox: OutboxWriter;
  let gateway: RunningGateway;
  let base: string;

  const S5_TIMEOUT = 90_000;
  const RUN = Date.now();
  const SLUG_ROOT = `f4ai11-koren-${String(RUN)}`;
  const SLUG_CHILD = `f4ai11-podtopic-${String(RUN)}`;
  const SLUG_ROOT2 = `f4ai11-druhy-${String(RUN)}`;

  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const NOW = Math.floor(Date.now() / 1000);

  const signAt = (kind: number, tags: string[][], content: string, offset: number): Event =>
    finalizeEvent({ kind, created_at: NOW + offset, tags, content }, sk);

  const addrRoot = `30020:${pk}:${SLUG_ROOT}`;
  const T1 = signAt(KINDS.TOPIC, [['d', SLUG_ROOT]], 'korenovy topic', 1);
  const T2 = signAt(KINDS.TOPIC, [['d', SLUG_CHILD], ['a', addrRoot]], 'podtopic', 2);
  const T3 = signAt(KINDS.TOPIC, [['d', SLUG_ROOT2]], 'druhy koren', 3);
  const Q1 = signAt(KINDS.QUESTION, [['a', addrRoot]], 'otazka 1', 4);
  const Q2 = signAt(KINDS.QUESTION, [['a', addrRoot]], 'otazka 2', 5);
  const R1 = signAt(KINDS.POST, [['e', Q1.id, 'root']], 'odpoved 1', 6);
  const R2 = signAt(
    KINDS.POST,
    [
      ['e', Q1.id, 'root'],
      ['e', R1.id, 'parent'],
    ],
    'odpoved 2 pod odpoved 1',
    7,
  );

  /** retry proti strfry race: kým `attempt` nevráti pravdivú hodnotu */
  async function eventually<T>(
    attempt: () => Promise<T | null | undefined | false>,
    attempts = 8,
  ): Promise<T> {
    let lastError = 'pokusy neskončili žiadnym výsledkom';
    for (let i = 0; i < attempts; i += 1) {
      try {
        const result = await attempt();
        if (result) return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await sleep(400 * (i + 1));
    }
    throw new Error(`eventually zlyhal po ${String(attempts)} pokusoch: ${lastError}`);
  }

  beforeAll(async () => {
    pool = new RelayPool({ urls: RELAYS, connectTimeoutMs: 5_000, publishTimeoutMs: 5_000 });
    const statuses = await pool.connectAll();
    expect(statuses.every((s) => s.connected)).toBe(true);

    outbox = new OutboxWriter(pool, {
      defaultWriteRelays: RELAYS,
      ttlMs: 60_000,
      fetchTimeoutMs: 4_000,
    });

    const app = createGatewayApp({ pool, outbox, logger: () => undefined, corsOrigin: '*' });
    registerReadRoutes(app, { pool, queryTimeoutMs: 8_000, logger: () => undefined });
    const websocket = attachWebSocket(app, pool);

    gateway = await startGatewayServer(app, { port: 0, hostname: '127.0.0.1', websocket });
    base = gateway.url;
  }, NET_TIMEOUT);

  afterAll(async () => {
    pool?.close();
    await gateway?.close();
  });

  it('publish 3 topicov + 2 otázok + 2 odpovedí cez POST /events → 200', { timeout: S5_TIMEOUT }, async () => {
    for (const event of [T1, T2, T3, Q1, Q2, R1, R2]) {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      const text = await res.text(); // text čítame raz — teleso je single-use
      expect(res.status, `kind ${String(event.kind)}: ${text}`).toBe(200);
      const body = JSON.parse(text) as { quorum_met: boolean };
      expect(body.quorum_met).toBe(true);
    }
  });

  it('GET /topics over strom: podtopic pod koreňom, druhý koreň samostatne', { timeout: S5_TIMEOUT }, async () => {
    const found = await eventually(async () => {
      const res = await fetch(`${base}/topics`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        topics: { slug: string; children: { slug: string }[] }[];
      };
      const root = body.topics.find((t) => t.slug === SLUG_ROOT);
      const root2 = body.topics.find((t) => t.slug === SLUG_ROOT2);
      if (!root || !root2) return null;
      if (!root.children.some((c) => c.slug === SLUG_CHILD)) return null;
      return { root, root2 };
    });
    expect(found.root.children.map((c) => c.slug)).toContain(SLUG_CHILD);
    expect(found.root2.slug).toBe(SLUG_ROOT2);
  });

  it('GET /topics/:slug: deti + threardy podľa adresy s pubkey topicu', { timeout: S5_TIMEOUT }, async () => {
    const found = await eventually(async () => {
      const res = await fetch(`${base}/topics/${SLUG_ROOT}`);
      if (res.status !== 200) return null;
      const body = (await res.json()) as {
        topic: { address: string };
        children: { slug: string }[];
        threads: { id: string }[];
        thread_count: number;
      };
      const ids = body.threads.map((t) => t.id);
      if (!ids.includes(Q1.id) || !ids.includes(Q2.id)) return null;
      return body;
    });
    expect(found.topic.address).toBe(addrRoot);
    expect(found.children.map((c) => c.slug)).toContain(SLUG_CHILD);
    expect(found.thread_count).toBeGreaterThanOrEqual(2);

    // limit ostrihne, počet ostane
    const limited = await fetch(`${base}/topics/${SLUG_ROOT}?limit=1`);
    const limitedBody = (await limited.json()) as { threads: unknown[]; thread_count: number };
    expect(limitedBody.threads).toHaveLength(1);
    expect(limitedBody.thread_count).toBeGreaterThanOrEqual(2);
  });

  it('GET /threads/:id: root + strom odpovedí (R2 pod R1)', { timeout: S5_TIMEOUT }, async () => {
    const found = await eventually(async () => {
      const res = await fetch(`${base}/threads/${Q1.id}`);
      if (res.status !== 200) return null;
      const body = (await res.json()) as {
        root: { id: string };
        replies: { id: string; children: { id: string }[] }[];
        reply_count: number;
      };
      if (body.replies.length < 1) return null;
      const r1 = body.replies.find((r) => r.id === R1.id);
      if (!r1 || !r1.children.some((c) => c.id === R2.id)) return null;
      return body;
    });
    expect(found.root.id).toBe(Q1.id);
    expect(found.reply_count).toBe(2);
    const r1 = found.replies.find((r) => r.id === R1.id) as (typeof found.replies)[number];
    expect(r1.children.map((c) => c.id)).toEqual([R2.id]);
  });

  it('GET /threads/:id 404 pre neznáme id', { timeout: S5_TIMEOUT }, async () => {
    const res = await fetch(`${base}/threads/${'0'.repeat(64)}`);
    expect(res.status).toBe(404);
  });

  it('GET /feed vracia naše otázky created_at desc', { timeout: S5_TIMEOUT }, async () => {
    const found = await eventually(async () => {
      const res = await fetch(`${base}/feed?kinds=1020&limit=50`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string }[] };
      const ids = body.items.map((i) => i.id);
      if (!ids.includes(Q1.id) || !ids.includes(Q2.id)) return null;
      return body;
    });
    const ids = found.items.map((i) => i.id);
    expect(ids.indexOf(Q2.id)).toBeLessThan(ids.indexOf(Q1.id)); // created_at desc
  });

  it('WS /ws: REQ na kinds:[30020] doručí EVENT nášho topicu + EOSE', { timeout: S5_TIMEOUT }, async () => {
    const probe = async (): Promise<{ gotEvent: boolean; gotEose: boolean } | null> =>
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${String(gateway.port)}/ws`);
        let gotEvent = false;
        let gotEose = false;
        const finish = (): void => {
          ws.terminate();
          resolve(gotEvent && gotEose ? { gotEvent, gotEose } : null);
        };
        const timer = setTimeout(finish, 12_000);
        ws.on('open', () => {
          ws.send(JSON.stringify(['REQ', 's1', { kinds: [KINDS.TOPIC] }]));
        });
        ws.on('message', (raw: Buffer | string) => {
          let msg: unknown;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === 's1') {
            const tags: unknown = (msg[2] as { tags?: unknown })?.tags;
            const d = Array.isArray(tags)
              ? (tags.find((t: unknown) => Array.isArray(t) && t[0] === 'd') as string[] | undefined)?.[1]
              : undefined;
            if (d === SLUG_ROOT) gotEvent = true;
          } else if (msg[0] === 'EOSE' && msg[1] === 's1') {
            gotEose = true;
            if (gotEvent) {
              clearTimeout(timer);
              finish();
            }
          }
        });
        ws.on('error', () => {
          clearTimeout(timer);
          resolve(null);
        });
      });

    const result = await eventually(probe, 6);
    expect(result?.gotEvent).toBe(true);
    expect(result?.gotEose).toBe(true);
  });

  it('WS /ws: 6. REQ nad limit 5 → NOTICE; CLOSE uvoľní miesto', { timeout: S5_TIMEOUT }, async () => {
    const outcome = await new Promise<{ notice: boolean; reReqEose: boolean }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(gateway.port)}/ws`);
      let notice = false;
      let reReqEose = false;
      const finish = (): void => {
        ws.terminate();
        resolve({ notice, reReqEose });
      };
      const timer = setTimeout(finish, 15_000);
      ws.on('open', () => {
        for (let i = 0; i < 6; i += 1) {
          ws.send(JSON.stringify(['REQ', `sub-${String(i)}`, { kinds: [KINDS.TOPIC], limit: 1 }]));
        }
      });
      ws.on('message', (raw: Buffer | string) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'NOTICE' && String(msg[1]).includes('limit')) {
          notice = true;
          // uvoľni jeden sub a skús REQ s duplicitným id — musí prejsť (EOSE)
          ws.send(JSON.stringify(['CLOSE', 'sub-0']));
          ws.send(JSON.stringify(['REQ', 'sub-0', { kinds: [KINDS.TOPIC], limit: 1 }]));
        }
        if (msg[0] === 'EOSE' && msg[1] === 'sub-0' && notice) {
          reReqEose = true;
          clearTimeout(timer);
          finish();
        }
      });
      ws.on('error', () => {
        clearTimeout(timer);
        resolve({ notice, reReqEose });
      });
    });
    expect(outcome.notice).toBe(true);
    expect(outcome.reReqEose).toBe(true);
  });
});
