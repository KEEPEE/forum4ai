/**
 * Integračný test federácie (Phase 6a, dizajn Q5) — DVA in-process gatewaye
 * A a B na reálnych TCP portoch (`startGatewayServer({ port: 0 })`), kde
 * `A.upstreams = [B]`. Federácia beží cez SKUTOČNÉ HTTP (žiadny mock fetchu),
 * takže test chytá aj to, čo unit test nemôže: skladanie URL, `since`/`limit`
 * parametre, NIP-98 cez reálnu HTTP vrstvu a tvar odpovede.
 *
 * Relaye sú ZÁMERNE in-process (`RelayLike` connector), po jednom pre každú
 * inštanciu:
 *  1. dev relaye na 127.0.0.1 sú zdieľané a test do nich NESMÍ písať
 *     (cudzie eventy by sa objavili v reálnom indexi a v sekciách UI),
 *  2. split-horizon je pozorovateľný LEN ak má každá inštancia VLASTNÚ
 *     zbierku eventov — na zdieľanom relayi by bol test falošne zelený,
 *  3. test beží vždy (žiadny `skipIf` na dostupnosť siete).
 *
 * Co sa strážia (body zadania 6a): PULL ingests B events with origin=B ·
 * PUSH delivers A events to B · split-horizon (B-origin events are never
 * pushed back to B) · retry queue (dead port → queue grows with backoff,
 * then the server comes up → it drains) · checkpoint survives an app
 * restart · `/fed/events` + `/fed/topics` are public while `/fed/state` +
 * `/fed/resync/:id` require NIP-98 owner auth.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KINDS } from '@forum4ai/shared';

import { buildGateway, type GatewayRuntime } from '../src/config.js';
import { startGatewayServer, type RunningGateway } from '../src/server.js';
import type { RelayConnector, RelayLike, SubscribeHandlers, SubscriptionLike } from '../src/relay-pool.js';

const T0 = Math.floor(Date.now() / 1000) - 3_600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Iba-process relay: `publish` uloží, `subscribe` vráti to, čo sedí na
 * filter, a EOSE pošle na ďalšom ticku (inak by `pool.query` čakal timeout).
 */
class MemRelay implements RelayLike {
  readonly url: string;
  connected = true;
  onclose: (() => void) | null = null;
  readonly store = new Map<string, Event>();

  constructor(url: string) {
    this.url = url;
  }

  async publish(event: Event): Promise<string> {
    if (!this.connected) throw new Error('Tried to send message on a closed connection');
    this.store.set(event.id, event);
    return `accepted: ${event.id.slice(0, 8)}`;
  }

  subscribe(filters: Filter[], params: SubscribeHandlers): SubscriptionLike {
    const matches: Event[] = [];
    for (const event of this.store.values()) {
      if (filters.some((filter) => matchesFilter(event, filter))) matches.push(event);
    }
    matches.sort((a, b) => a.created_at - b.created_at);
    for (const event of matches) params.onevent?.(event);
    setTimeout(() => params.oneose?.(), 0);
    return { close: () => undefined };
  }

  close(): void {
    this.connected = false;
    this.onclose?.();
  }
}

function matchesFilter(event: Event, filter: Filter): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  return true;
}

interface Instance {
  name: string;
  rt: GatewayRuntime;
  app: Hono;
  relay: MemRelay;
  base: string;
  gateway: RunningGateway;
}

const OWNER_A = generateSecretKey();
const OWNER_B = generateSecretKey();
const AUTHOR_A = generateSecretKey();
const AUTHOR_B = generateSecretKey();

/** koreň vlákna — `POST /events` odmietne 1023 bez root markera
 *  (`['e', <64-hex>, 'root']`, marker je na indexe 2), takže aj federované
 *  testy musia posielať štrukturálne platné vlákna */
const ROOT_EVENT = 'c'.repeat(64);

function sign(
  secret: Uint8Array,
  kind: number,
  content: string,
  created_at: number,
  tags: string[][] = [],
): Event {
  const withRoot =
    kind === KINDS.POST && !tags.some((tag) => tag[0] === 'e')
      ? [['e', ROOT_EVENT, 'root'], ...tags]
      : tags;
  return finalizeEvent({ kind, created_at, tags: withRoot, content }, secret);
}

/** NIP-98 token (kind 27235) — ten istý tvar ako v `register-routes.test.ts` */
function nip98Token(secretKey: Uint8Array, url: string, method: string): string {
  const event = finalizeEvent(
    {
      kind: KINDS.AUTH_NIP98,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', url], ['method', method]],
      content: '',
    },
    secretKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

async function publish(instance: Instance, event: Event): Promise<Response> {
  return instance.app.request(`${instance.base}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

const dir = mkdtempSync(join(tmpdir(), 'f4ai-fed-int-'));

async function makeInstance(options: {
  name: string;
  ownerSk: Uint8Array;
  upstreams?: { id: string; baseUrl: string }[];
  fedDbPath?: string;
  port?: number;
  backoffInitialMs?: string;
}): Promise<Instance> {
  const relay = new MemRelay(`ws://fake-${options.name}.example`);
  const connector: RelayConnector = async () => relay;
  const rt = buildGateway(
    {
      GATEWAY_RELAY_URLS: relay.url,
      GATEWAY_WRITE_GATE: 'off',
      GATEWAY_QUIET: '1',
      GATEWAY_OWNER_SK_HEX: Buffer.from(options.ownerSk).toString('hex'),
      ...(options.backoffInitialMs !== undefined
        ? { GATEWAY_FED_BACKOFF_INITIAL_MS: options.backoffInitialMs }
        : {}),
    },
    {
      connector,
      upstreams: options.upstreams ?? [],
      // interval nespúšťame — test volá `tick()` sám, inak by pretekal
      // s aserciami
      fedIntervalMs: 0,
      fedDbPath: options.fedDbPath ?? null,
      disableWebsocket: true,
      indexDb: null,
      logger: () => undefined,
    },
  );
  const gateway = await startGatewayServer(rt.app, {
    port: options.port ?? 0,
    hostname: '127.0.0.1',
  });
  return { name: options.name, rt, app: rt.app, relay, base: gateway.url, gateway };
}

function closeRuntime(rt: GatewayRuntime): void {
  // rovnaké poradie ako `cli.ts` shutdown — WAL súbory musia ísť dole
  // korektne, inak ich indexer (read-only) uvidí nedokončené
  rt.fed.close();
  rt.search?.close();
  rt.reputation?.close();
  rt.ideas?.close();
  rt.papers?.close();
  rt.operators.close();
  rt.pool.close();
}

/** voľný TCP port, na ktorom práve nikto nepočúva */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(resolve));
  return port;
}

let A: Instance;
let B: Instance;
/** id upstreamu B tak, ako ho A vidí (host + port z URL) */
let B_ID: string;

beforeAll(async () => {
  B = await makeInstance({ name: 'b', ownerSk: OWNER_B });
  B_ID = new URL(B.base).host;
  A = await makeInstance({
    name: 'a',
    ownerSk: OWNER_A,
    upstreams: [{ id: B_ID, baseUrl: B.base }],
    fedDbPath: join(dir, 'a-fed.db'),
  });
});

afterAll(async () => {
  for (const instance of [A, B]) {
    if (instance === undefined) continue;
    closeRuntime(instance.rt);
    await instance.gateway.close();
    instance.relay.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('federácia A ↔ B cez reálne HTTP', () => {
  it('PULL: A stiahne obsah B a označí ho origin = id inštancie B', async () => {
    const post = sign(AUTHOR_B, KINDS.POST, 'vlakno z B (stiahni ma)', T0 + 10);
    expect((await publish(B, post)).status).toBe(200);

    const result = await A.rt.fed.engine.tick();
    const pull = result.pulled.find((entry) => entry.upstream === B_ID);
    expect(pull).toMatchObject({ ok: true, fetched: 1, inserted: 1, invalid: 0, skipped: 0 });

    const rows = A.rt.fed.db.remoteEvents(B_ID);
    expect(rows.map((row) => row.id)).toEqual([post.id]);
    // `origin` NIE je URL relaya ani 'self' — je to id upstreamu (host:port),
    // podľa neho UI kreslí štítok a `GET /search?origin=` filteruje.
    // `remoteEvents()` vracia KÁNONICKÉ EVENTY (7 polí), nie riadky tabuľky,
    // takže origin sa overuje tým, že záznam patrí pod id upstreamu a pod
    // žiadny iný (rovnaký dotaz s cudzím id musí byť prázdny).
    expect(A.rt.fed.db.remoteCount(B_ID)).toBe(1);
    expect(A.rt.fed.db.remoteCount('self')).toBe(0);
    expect(A.rt.fed.db.remoteCount('cudzak.example')).toBe(0);
    expect(A.rt.fed.db.getUpstream(B_ID)?.checkpoint).toBeGreaterThanOrEqual(post.created_at);
    expect(A.rt.fed.db.getUpstream(B_ID)?.pulledEvents).toBe(1);

    // druhý tick ten istý event neduplikuje (dedup per id)
    const again = await A.rt.fed.engine.tick();
    expect(again.pulled.find((entry) => entry.upstream === B_ID)?.inserted).toBe(0);
    expect(A.rt.fed.db.remoteCount(B_ID)).toBe(1);
  });

  it('PUSH: A doručí vlastné vlákno do B (cez POST /events, nie relay-to-relay)', async () => {
    const post = sign(AUTHOR_A, KINDS.POST, 'vlakno z A (PUSH)', T0 + 20);
    expect((await publish(A, post)).status).toBe(200);
    // hook beží až po kvóre, ale MUSÍ byť viditeľný hneď
    expect(A.rt.fed.db.queueStats(B_ID).pending).toBe(1);

    const result = await A.rt.fed.engine.tick();
    const push = result.pushed.find((entry) => entry.upstream === B_ID);
    expect(push).toMatchObject({ attempted: 1, sent: 1, failed: 0, dead: 0 });
    // B prijal A-vlakno do VLASTNÉHO relaya → index B ho uvidí ako cudzí
    expect(B.relay.store.has(post.id)).toBe(true);
    expect(A.rt.fed.db.getQueueRow(B_ID, post.id)?.status).toBe('done');
  });

  it('split-horizon: B-obsah sa späť do B netlačí (ani keď ho klient pošle znova na A)', async () => {
    // event patrí B (jeho obsah už A stiahol), ale klient ho pošle aj na A
    const rebroadcast = sign(AUTHOR_B, KINDS.POST, 'cudzi event, ktory A uz pozna', T0 + 30);
    B.relay.store.set(rebroadcast.id, rebroadcast);
    await A.rt.fed.engine.tick();
    expect(A.rt.fed.db.hasRemoteEvent(rebroadcast.id)).toBe(true);

    const before = A.rt.fed.db.queueStats(B_ID).total;
    expect((await publish(A, rebroadcast)).status).toBe(200);
    await A.rt.fed.engine.tick();

    // žiadna nová položka fronty = žiadny push späť do B (inak by sa
    // rovnaké vlákna v inštancii B mnohili donekonečna)
    expect(A.rt.fed.db.queueStats(B_ID).total).toBe(before);
    expect(A.rt.fed.db.getQueueRow(B_ID, rebroadcast.id)).toBeNull();
  });

  it('GET /fed/events je VEREJNÉ (bez NIP-98) a ide ASC s `next_since`', async () => {
    const res = await B.app.request(`${B.base}/fed/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['count']).toBeGreaterThan(0);
    const events = body['events'] as Event[];
    const times = events.map((event) => event.created_at);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(body['next_since']).toBe(times[times.length - 1]);
    // kánonických 7 polí (peer overuje `id` ↔ `sig` priamo z tohto JSONu)
    expect(Object.keys(events[0] ?? {}).sort()).toEqual([
      'content',
      'created_at',
      'id',
      'kind',
      'pubkey',
      'sig',
      'tags',
    ]);
  });

  it('GET /fed/topics: A ukáže KORENE stromu B, nie domáce topiky', async () => {
    const root = sign(AUTHOR_B, KINDS.TOPIC, 'koren stromu B', T0 + 40, [['d', 'b-root']]);
    const child = sign(AUTHOR_B, KINDS.TOPIC, 'dieta stromu B', T0 + 41, [
      ['d', 'b-child'],
      ['a', `30020:${root.pubkey}:b-root`],
    ]);
    B.relay.store.set(root.id, root);
    B.relay.store.set(child.id, child);
    await A.rt.fed.engine.tick();

    const res = await A.app.request(`${A.base}/fed/topics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['section']).toBe('network');
    const upstreams = body['upstreams'] as Array<Record<string, unknown>>;
    expect(upstreams).toHaveLength(1);
    expect(upstreams[0]?.['id']).toBe(B_ID);
    // sekcia „Network" nesmie zaplaviť celý strom — len korene
    expect((upstreams[0]?.['roots'] as Array<Record<string, unknown>>).map((row) => row['slug'])).toEqual([
      'b-root',
    ]);
    expect((upstreams[0]?.['roots'] as Array<Record<string, unknown>>)[0]?.['origin']).toBe(B_ID);
    expect(upstreams[0]?.['topic_count']).toBeGreaterThanOrEqual(2);
  });

  it('/fed/state a /fed/resync/:id vyžadojú NIP-98 vlastníka (401 / 403 / 200 / 404)', async () => {
    const stateUrl = `${A.base}/fed/state`;
    expect((await A.app.request(stateUrl)).status).toBe(401);

    const stranger = await A.app.request(stateUrl, {
      headers: { authorization: nip98Token(AUTHOR_A, stateUrl, 'GET') },
    });
    expect(stranger.status).toBe(403);

    const owner = await A.app.request(stateUrl, {
      headers: { authorization: nip98Token(OWNER_A, stateUrl, 'GET') },
    });
    expect(owner.status).toBe(200);
    const fed = ((await owner.json()) as Record<string, unknown>)['federation'] as Record<string, unknown>;
    expect(fed['enabled']).toBe(true);
    const upstreams = fed['upstreams'] as Array<Record<string, unknown>>;
    expect(upstreams[0]).toMatchObject({ id: B_ID, remote_events: A.rt.fed.db.remoteCount(B_ID) });

    // resync cudzím podpisom = 403, vlastníkom = 200 a kurzor je 0
    const resyncUrl = `${A.base}/fed/resync/${encodeURIComponent(B_ID)}`;
    expect(
      (
        await A.app.request(resyncUrl, {
          method: 'POST',
          headers: { authorization: nip98Token(AUTHOR_A, resyncUrl, 'POST') },
        })
      ).status,
    ).toBe(403);
    const resync = await A.app.request(resyncUrl, {
      method: 'POST',
      headers: { authorization: nip98Token(OWNER_A, resyncUrl, 'POST') },
    });
    expect(resync.status).toBe(200);
    expect(A.rt.fed.db.getUpstream(B_ID)?.checkpoint).toBe(0);

    // nezname id = 404 (nie tichy success)
    const bad = `${A.base}/fed/resync/nikto.example`;
    const badRes = await A.app.request(bad, {
      method: 'POST',
      headers: { authorization: nip98Token(OWNER_A, bad, 'POST') },
    });
    expect(badRes.status).toBe(404);
    expect(((await badRes.json()) as Record<string, unknown>)['code']).toBe('UPSTREAM_NOT_FOUND');

    // po resynci A stiahne celú históriu B ZNOVA — bez duplikátov (dedup
    // per id je to, čo robí resync lacným)
    const beforeResync = A.rt.fed.db.remoteCount(B_ID);
    const tick = await A.rt.fed.engine.tick();
    expect(tick.pulled[0]).toMatchObject({ ok: true });
    expect(tick.pulled[0]?.inserted).toBe(0);
    expect(A.rt.fed.db.remoteCount(B_ID)).toBe(beforeResync);
  });

  it('fronta: mŕtvy port → ECONNREFUSED a backoff, potom upstream vstane → vybiduje sa', async () => {
    const deadPort = await freePort();
    const upstreamId = `127.0.0.1:${String(deadPort)}`;
    const C = await makeInstance({
      name: 'c',
      ownerSk: OWNER_A,
      upstreams: [{ id: upstreamId, baseUrl: `http://${upstreamId}` }],
      backoffInitialMs: '500',
    });
    try {
      const post = sign(AUTHOR_A, KINDS.POST, 'vlakno, kym je upstream mrtvy', T0 + 50);
      expect((await publish(C, post)).status).toBe(200);

      const dead = await C.rt.fed.engine.tick();
      expect(dead.pulled[0]).toMatchObject({ ok: false });
      // `describeError` MUSÍ ukázať cause — undici by inak hlásil len
      // „fetch failed" a operátor by nevedel, či je port zlý alebo DNS
      expect(dead.pulled[0]?.error).toContain('ECONNREFUSED');
      expect(dead.pushed[0]).toMatchObject({ attempted: 1, sent: 0, failed: 1 });

      const row = C.rt.fed.db.getQueueRow(upstreamId, post.id);
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(1);
      expect(row?.nextAttemptAt).toBeGreaterThan(Date.now());
      expect(C.rt.fed.db.getUpstream(upstreamId)?.lastError).toContain('ECONNREFUSED');

      // ďalší tick hneď: backoff nesmie pustiť pokus pred časom
      const gated = await C.rt.fed.engine.tick();
      expect(gated.pushed[0]).toMatchObject({ attempted: 0, sent: 0 });
      expect(C.rt.fed.db.getQueueRow(upstreamId, post.id)?.attempts).toBe(1);

      // upstream vstane na TOM ISTOM porte → fronta sa vybiduje bez straty
      const up = await startGatewayServer(B.rt.app, { port: deadPort, hostname: '127.0.0.1' });
      try {
        // backoff po 1. pokuse = initial * 2^1 = 1000 ms → pred týmto časom
        // MUSÍ fronta mlčať (a preto spíme až zaň)
        await sleep(1_100);
        const drained = await C.rt.fed.engine.tick();
        expect(drained.pushed[0]).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
        expect(C.rt.fed.db.getQueueRow(upstreamId, post.id)?.status).toBe('done');
        expect(B.relay.store.has(post.id)).toBe(true);
        expect(C.rt.fed.db.getUpstream(upstreamId)?.lastError).toBe('');
      } finally {
        await up.close();
      }
    } finally {
      closeRuntime(C.rt);
      await C.gateway.close();
      C.relay.close();
    }
  });

  it('kurzor prežije restart procesu (fed.db je perzistentný súbor)', async () => {
    const checkpoint = A.rt.fed.db.getUpstream(B_ID)?.checkpoint ?? 0;
    const remoteIds = A.rt.fed.db.remoteEvents(B_ID).map((row) => row.id);
    expect(checkpoint).toBeGreaterThan(0);
    closeRuntime(A.rt);

    // TENTO ISTÝ súbor a TENTO ISTÝ upstream → žiadny cold-start od nuly
    const A2 = await makeInstance({
      name: 'a2',
      ownerSk: OWNER_A,
      upstreams: [{ id: B_ID, baseUrl: B.base }],
      fedDbPath: join(dir, 'a-fed.db'),
    });
    try {
      expect(A2.rt.fed.db.getUpstream(B_ID)?.checkpoint).toBe(checkpoint);
      expect(A2.rt.fed.db.remoteEvents(B_ID).map((row) => row.id)).toEqual(remoteIds);

      // PULL od obnoveného kurzora NESMIE doniesť staré eventy znova —
      // jediné nové, čo môže prísť, je to, čo pribudlo do B medzitým
      const tick = await A2.rt.fed.engine.tick();
      expect(tick.pulled[0]).toMatchObject({ ok: true });
      const after = A2.rt.fed.db.remoteEvents(B_ID).map((row) => row.id);
      expect(new Set(after).size).toBe(after.length); // ziadny duplikat
      expect(after.filter((id) => new Set(remoteIds).has(id))).toEqual(remoteIds);
      expect(A2.rt.fed.db.getUpstream(B_ID)?.checkpoint).toBeGreaterThanOrEqual(checkpoint);
    } finally {
      closeRuntime(A2.rt);
      await A2.gateway.close();
      A2.relay.close();
    }
  });
});
