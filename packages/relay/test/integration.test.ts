/**
 * Integračný test: relay beží na voľnom TCP porte, klient je
 * nostr-tools `Relay` (reálny NIP-01 websocket). Overí publish OK,
 * rejected (kind / root markery), subscribe filter a rate limit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import type { Filter } from 'nostr-tools/filter';
import WebSocket from 'ws';
import { KINDS } from '@forum4ai/shared';

import { startRelayServer } from '../src/server.js';
import type { RunningRelay } from '../src/server.js';

const SK = generateSecretKey();
const PUBKEY = getPublicKey(SK);
const ROOT_ID = 'e'.repeat(64);

/** poll helper pre live testy (EOSE/live event prichádza async) */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function sign(kind: number, tags: string[][], content: string): Event {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
    SK,
  );
}

/** Počkaj na prvý event a EOSE subsidiacie; resolve až po EOSE. */
function subscribeToEose(
  relay: Relay,
  filters: Filter[],
  timeoutMs = 4000,
): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const events: Event[] = [];
    const timeout = setTimeout(
      () => reject(new Error('EOSE neprišlo v timeoute')),
      timeoutMs,
    );
    relay.subscribe(filters, {
      onevent: (evt) => {
        events.push(evt);
      },
      oneose: () => {
        clearTimeout(timeout);
        resolve(events);
      },
      onclose: (reason) => {
        clearTimeout(timeout);
        reject(new Error(`subscripcia zavretá: ${reason}`));
      },
    });
  });
}

describe('relay integrácia (ws:// + nostr-tools klient)', () => {
  let server: RunningRelay;
  let client: Relay;

  beforeAll(async () => {
    server = await startRelayServer({ port: 0 });
    client = await Relay.connect(server.url);
  });

  afterAll(async () => {
    client.close();
    await server.close();
  });

  it('relay beží na voľnom porte a policy defaulty sedí', () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`ws://127.0.0.1:${String(server.port)}`);
    expect(server.policyConfig.powMinDifficulty).toBe(0);
    expect(server.policyConfig.rateLimit).toEqual({ maxEventsPerWindow: 30, windowMs: 60_000 });
  });

  it('publish platného 1020 → OK a subscribe {ids} vráti uložený event', async () => {
    const event = sign(KINDS.QUESTION, [['d', 'integrak-1020']], 'Ako testujeme relay?');
    await expect(client.publish(event)).resolves.toMatch(/accepted/);

    const received = await subscribeToEose(client, [{ ids: [event.id] }]);
    expect(received.map((evt) => evt.id)).toEqual([event.id]);
    expect(received[0]?.content).toBe('Ako testujeme relay?');
    expect(received[0]?.kind).toBe(KINDS.QUESTION);
  });

  it('publish kind 4 (mimo registry) → rejected: kind', async () => {
    const note = sign(4, [], 'poznamka kind 4');
    await expect(client.publish(note)).rejects.toThrow(/rejected: kind 4/);
  });

  it('publish 1023 s dvoma root markermi → rejected: root_marker', async () => {
    const post = sign(
      KINDS.POST,
      [
        ['e', ROOT_ID, 'root'],
        ['e', 'a'.repeat(64), 'root'],
      ],
      'post s dvoma rootmi',
    );
    await expect(client.publish(post)).rejects.toThrow(/rejected: .*root/);
  });

  it('publish 1023 bez root markera → rejected: root_marker', async () => {
    const post = sign(KINDS.POST, [['e', ROOT_ID, 'parent']], 'post bez rootu');
    await expect(client.publish(post)).rejects.toThrow(/rejected: .*root/);
  });

  it('duplicitný publish → OK duplicate a store rastie len raz', async () => {
    const event = sign(KINDS.REACTION, [['e', ROOT_ID, 'root']], '+');
    const before = server.store.size;
    await expect(client.publish(event)).resolves.toMatch(/accepted/);
    await expect(client.publish(event)).resolves.toMatch(/duplicate/);
    expect(server.store.size).toBe(before + 1);
  });

  it('subscribe {kinds, authors} vráti uložené eventy triedene created_at asc', async () => {
    const first = sign(KINDS.VOTE, [['e', ROOT_ID, 'root']], 'vote-1');
    const second = sign(KINDS.VOTE, [['e', ROOT_ID, 'root']], 'vote-2');
    await client.publish(first);
    await client.publish(second);

    const received = await subscribeToEose(client, [
      { kinds: [KINDS.VOTE], authors: [PUBKEY] },
    ]);
    const ids = received.map((evt) => evt.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    for (let i = 1; i < received.length; i += 1) {
      expect((received[i - 1]?.created_at ?? 0)).toBeLessThanOrEqual(received[i]?.created_at ?? 0);
    }
  });

  it('ephemeral 27235 sa akceptuje, ale neuloží', async () => {
    const auth = sign(KINDS.AUTH_NIP98, [], '{"method":"GET"}');
    const before = server.store.size;
    await expect(client.publish(auth)).resolves.toMatch(/accepted/);
    expect(server.store.size).toBe(before);
  });
});

describe('relay integrácia — rate limit', () => {
  let server: RunningRelay;
  let client: Relay;

  beforeAll(async () => {
    server = await startRelayServer({
      port: 0,
      policy: { rateLimit: { maxEventsPerWindow: 2, windowMs: 60_000 } },
    });
    client = await Relay.connect(server.url);
  });

  afterAll(async () => {
    client.close();
    await server.close();
  });

  it('3. EVENT v okne → rate-limited', async () => {
    await expect(
      client.publish(sign(KINDS.QUESTION, [], 'rl-1')),
    ).resolves.toMatch(/accepted/);
    await expect(
      client.publish(sign(KINDS.QUESTION, [], 'rl-2')),
    ).resolves.toMatch(/accepted/);
    await expect(client.publish(sign(KINDS.QUESTION, [], 'rl-3'))).rejects.toThrow(
      /rate-limited/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* regression A4 — live fan-out do subsidií INÝCH klientov              */
/* ------------------------------------------------------------------ */

describe('relay integrácia — live fan-out (regression A4)', () => {
  let server: RunningRelay;
  let publisher: Relay;
  let watcher: Relay;

  beforeAll(async () => {
    server = await startRelayServer({ port: 0 });
    publisher = await Relay.connect(server.url);
    watcher = await Relay.connect(server.url);
  });

  afterAll(async () => {
    publisher.close();
    watcher.close();
    await server.close();
  });

  it('event od jedného klienta dorazí live do subscripcie druhého klienta', async () => {
    const since = Math.floor(Date.now() / 1000);
    let eose = false;
    const received: Event[] = [];
    watcher.subscribe([{ kinds: [KINDS.QUESTION], authors: [PUBKEY], since }], {
      onevent: (evt) => {
        received.push(evt);
      },
      oneose: () => {
        eose = true;
      },
    });
    await waitFor(() => eose, 'EOSE subsidiacie watchera');

    const event = sign(KINDS.QUESTION, [['d', 'fanout-a4']], 'fan-out test A4');
    await publisher.publish(event);

    await waitFor(
      () => received.some((evt) => evt.id === event.id),
      'live event v subscipcii watchera (pred fixom sa vracal len publikujucemu)',
    );
    expect(received.map((evt) => evt.id)).toContain(event.id);
  });
});

/* ------------------------------------------------------------------ */
/* regression L1 + A13 — protokolové limity (raw ws klient)             */
/* ------------------------------------------------------------------ */

describe('relay integrácia — CLOSED a max_subscriptions (L1, A13)', () => {
  let server: RunningRelay;

  beforeAll(async () => {
    server = await startRelayServer({ port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  function openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(server.url);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  it('REQ bez filtra → relay posiela CLOSED (NIP-01), nie CLOSE', async () => {
    const ws = await openSocket();
    try {
      const msg = await new Promise<unknown[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('CLOSED správa neprišla')), 3000);
        ws.on('message', (raw: Buffer | string) => {
          const data: unknown = JSON.parse(raw.toString());
          if (Array.isArray(data) && data[0] === 'CLOSED') {
            clearTimeout(timeout);
            resolve(data);
          }
        });
        ws.send(JSON.stringify(['REQ', 's1']));
      });
      expect(msg[0]).toBe('CLOSED');
      expect(String(msg[1])).toBe('s1');
      expect(String(msg[2])).toMatch(/invalid: .*filter/);
    } finally {
      ws.close();
    }
  });

  it('17. REQ per connection → CLOSED rate-limited (max_subscriptions 16)', async () => {
    const ws = await openSocket();
    try {
      const closed = new Promise<unknown[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('17. REQ bez CLOSED')), 3000);
        ws.on('message', (raw: Buffer | string) => {
          const data: unknown = JSON.parse(raw.toString());
          if (Array.isArray(data) && data[0] === 'CLOSED') {
            clearTimeout(timeout);
            resolve(data);
          }
        });
      });
      for (let i = 0; i < 17; i += 1) {
        ws.send(JSON.stringify(['REQ', `s${String(i)}`, { kinds: [KINDS.QUESTION] }]))
;
      }
      const msg = await closed;
      expect(msg[1]).toBe('s16');
      expect(String(msg[2])).toMatch(/max_subscriptions/);
    } finally {
      ws.close();
    }
  });
});

// ── A3 (P0, security review): MAX_SUBSCRIPTIONS cez env ─────────────────────

describe('relay integrácia — max_subscriptions konfigurovateľné (A3, P0)', () => {
  let server: RunningRelay;

  beforeAll(async () => {
    server = await startRelayServer({ port: 0, maxSubscriptions: 2 });
  });

  afterAll(async () => {
    await server.close();
  });

  function openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(server.url);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  it('relay s maxSubscriptions=2 prijme 2 REQ a tretí odmietne CLOSED', async () => {
    expect(server.maxSubscriptions).toBe(2);
    const ws = await openSocket();
    try {
      const closed = new Promise<unknown[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('3. REQ bez CLOSED')), 3000);
        ws.on('message', (raw: Buffer | string) => {
          const data: unknown = JSON.parse(raw.toString());
          if (Array.isArray(data) && data[0] === 'CLOSED') {
            clearTimeout(timeout);
            resolve(data);
          }
        });
      });
      for (let i = 0; i < 3; i += 1) {
        ws.send(JSON.stringify(['REQ', `s${String(i)}`, { kinds: [KINDS.QUESTION] }]));
      }
      const msg = await closed;
      expect(msg[1]).toBe('s2');
      expect(String(msg[2])).toMatch(/max_subscriptions 2/);
    } finally {
      ws.close();
    }
  });

  it('NIP-11 document hlási efektívny strop (klient sa má správať slušne)', async () => {
    const res = await fetch(server.url.replace(/^ws/, 'http'), {
      headers: { Accept: 'application/nostr+json' },
    });
    expect(res.ok).toBe(true);
    const doc = (await res.json()) as { limitation?: { max_subscriptions?: number } };
    expect(doc.limitation?.max_subscriptions).toBe(2);
  });

  it('bez voliteľného parametra zostáva dev default 16 (žiadna zmena správania)', async () => {
    const plain = await startRelayServer({ port: 0 });
    try {
      expect(plain.maxSubscriptions).toBe(16);
    } finally {
      await plain.close();
    }
  });
});

describe('relay integrácia — read-only rezim (Phase 6b-deploy)', () => {
  let roServer: RunningRelay;
  let roClient: Relay;

  beforeAll(async () => {
    roServer = await startRelayServer({ port: 0, policy: { readOnly: true } });
    roClient = await Relay.connect(roServer.url);
  });

  afterAll(async () => {
    roClient.close();
    await roServer.close();
  });

  it('EVENT → OK [id, false, "rejected: read-only relay"] a store ostáva prázdny', async () => {
    const event = sign(KINDS.QUESTION, [['d', 'ro-1020']], 'read-only by to mal pustiť?');
    const before = roServer.store.size;
    await expect(roClient.publish(event)).rejects.toThrow(/rejected: read-only relay/);
    expect(roServer.store.size).toBe(before);
  });

  it('REQ na read-only relayi funguje (EOSE príde, prázdny store → 0 eventov)', async () => {
    const received = await subscribeToEose(roClient, [{ kinds: [KINDS.QUESTION] }]);
    expect(received).toEqual([]);
  });

  it('NIP-11 document je na read-only relayi stále 200', async () => {
    const res = await fetch(roServer.url.replace(/^ws/, 'http'), {
      headers: { Accept: 'application/nostr+json' },
    });
    expect(res.ok).toBe(true);
    const doc = (await res.json()) as { software?: string };
    expect(doc.software).toBe('forum4ai-relay');
  });

  it('COUNT nie je read-only režimom blokované (relay ho pozná ako unknown command)', async () => {
    const ws = new WebSocket(roServer.url);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
    });
    try {
      const notice = new Promise<unknown[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('COUNT bez NOTICE')), 3000);
        ws.on('message', (raw: Buffer | string) => {
          const data: unknown = JSON.parse(raw.toString());
          if (Array.isArray(data) && data[0] === 'NOTICE') {
            clearTimeout(timeout);
            resolve(data);
          }
        });
      });
      ws.send(JSON.stringify(['COUNT', 'c0', { kinds: [KINDS.QUESTION] }]));
      const msg = await notice;
      // read-only mení len EVENT; COUNT ostáva tým, čím bol predtým
      expect(String(msg[1])).toMatch(/unknown command: COUNT/);
    } finally {
      ws.close();
    }
  });
});
