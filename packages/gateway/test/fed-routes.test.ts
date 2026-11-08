/**
 * Testy `/fed/*` route (Phase 6a, dizajn Q5).
 *
 * Rozdelenie autorizácie je záväzné a testuje sa dôkladne:
 *   GET  /fed/events      VEREJNÉ — read-only pohľad pre peerov (dizajn Q5
 *                         počíta s verejným read-only relayom, vzdialený
 *                         obsah je verejný),
 *   GET  /fed/topics      VEREJNÉ — sekcia „Network" pre UI,
 *   GET  /fed/state       NIP-98 OWNÉR (503 bez owner škály, 401 zlý token,
 *                         403 cudzí podpis — TENTO ISTÝ validátor ako
 *                         `POST /register/approve`),
 *   POST /fed/resync/:id  NIP-98 OWNÉR + 404 pre neznáme id.
 *
 * `/fed/events` je čítacie rozhranie, ktoré VOLÁ cudzí gateway, takže sa
 * tu strážia aj veci, inak nudné: orezanie na najSTARŠÍCH (inak by sa
 * staršie eventy nad limitom k peerovi nikdy nedostali), dedup per id,
 * overenie podpisu pred odoslaním a `partial` pri relay stropi (A12).
 */
import { createHash } from 'node:crypto';

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { FED_SYNC_KINDS, KINDS } from '@forum4ai/shared';
import type { Filter } from 'nostr-tools/filter';

import { GATEWAY_PHASE } from '../src/app.js';
import { FedEngine } from '../src/fed/engine.js';
import { openFedDb, type FedDb } from '../src/fed/db.js';
import {
  registerFedRoutes,
  FED_EVENTS_LIMIT_DEFAULT,
  FED_EVENTS_LIMIT_MAX,
  type FedReadPool,
} from '../src/fed/routes.js';

const OWNER_SK = generateSecretKey();
const OWNER_PK = getPublicKey(OWNER_SK).toLowerCase();
const OWNER_SK_HEX = Buffer.from(OWNER_SK).toString('hex');
const STRANGER_SK = generateSecretKey();

const UP = 'b.example:18081';
const T0 = 1_730_000_000;

/** NIP-98 token (kind 27235, tagy `u`/`method`/`payload`) — rovnaký tvar
 *  ako v `register-routes.test.ts`, lebo je to TENTO ISTÝ validátor */
function nip98Token(secretKey: Uint8Array, url: string, method: string, body?: string): string {
  const tags: string[][] = [['u', url], ['method', method]];
  if (body !== undefined && body !== '') {
    tags.push(['payload', createHash('sha256').update(body, 'utf8').digest('hex')]);
  }
  const event = finalizeEvent(
    { kind: KINDS.AUTH_NIP98, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    secretKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

/** fake pool: vracia nastavené eventy alebo hádže (503 cesty) */
function poolOf(events: Event[] | (() => Event[]), opts?: { throws?: boolean }): FedReadPool {
  return {
    query: async () => {
      if (opts?.throws === true) throw new Error('relay timeout');
      return typeof events === 'function' ? events() : events;
    },
  };
}

function signed(kind: number, content: string, createdAt: number, tags: string[][] = []): Event {
  return finalizeEvent({ kind, created_at: createdAt, tags, content }, OWNER_SK);
}

/** kópia s rozbitým podpisom (overuje sa `verifyFull`, nie nostr-tools) */
function tampered(event: Event): Event {
  return { ...event, sig: 'f'.repeat(64) };
}

let db: FedDb;
let engine: FedEngine;

function buildApp(pool: FedReadPool | null, ownerSkHex = OWNER_SK_HEX): Hono {
  const app = new Hono();
  registerFedRoutes(app, { engine, pool, ownerSkHex, logger: () => undefined });
  return app;
}

beforeEach(() => {
  db = openFedDb(':memory:');
  engine = new FedEngine({
    db,
    upstreams: [{ id: UP, baseUrl: `http://${UP}` }],
    logger: () => undefined,
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  engine.syncConfig();
});

// ── GET /fed/events (verejné) ──────────────────────────────────────────────

describe('GET /fed/events — verejné čítacie rozhranie pre peerov', () => {
  it('bez Authorization hlavičky vráti lokálny obsah (peer nepotrebuje účet)', async () => {
    const a = signed(KINDS.POST, 'vlakno A', T0 + 10);
    const b = signed(KINDS.TOPIC, 'koren', T0 + 20, [['d', 'root']]);
    const app = buildApp(poolOf([b, a]));

    const res = await app.request('http://gw.test/fed/events');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['phase']).toBe(GATEWAY_PHASE);
    expect(body['count']).toBe(2);
    // ASC: peer posúva kurzor na maximum stránky — najnovšie MUSIA ostať
    // na konci, inak by sa staršie eventy nad limitom nikdy nedostali
    expect((body['events'] as Event[]).map((event) => event.created_at)).toEqual([T0 + 10, T0 + 20]);
    expect(body['next_since']).toBe(T0 + 20);
    expect(body['kinds']).toEqual([...FED_SYNC_KINDS]);
    expect(body['limit']).toBe(FED_EVENTS_LIMIT_DEFAULT);
    expect(body['since']).toBe(0);
  });

  it('dedup per id a nepodpísaný event sa k peerovi nedostane', async () => {
    const good = signed(KINDS.POST, 'overeny', T0 + 30);
    const app = buildApp(poolOf([good, { ...good }, tampered(signed(KINDS.POST, 'pozmeneny', T0 + 31))]));
    const body = (await (await app.request('http://gw.test/fed/events')).json()) as Record<string, unknown>;
    expect(body['count']).toBe(1);
    expect((body['events'] as Event[])[0]?.content).toBe('overeny');
    // kánonická 7-pole kópia — bez nostr-tools Symbolov a navyše polí
    expect(Object.keys((body['events'] as Event[])[0] ?? {}).sort()).toEqual([
      'content',
      'created_at',
      'id',
      'kind',
      'pubkey',
      'sig',
      'tags',
    ]);
  });

  it('orezáva na najSTARŠÍCH `limit` a `next_since` je maximum stránky', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => signed(KINDS.POST, `vlakno ${String(i)}`, T0 + i));
    const app = buildApp(poolOf(rows));
    const body = (await (await app.request('http://gw.test/fed/events?limit=2')).json()) as Record<string, unknown>;
    expect(body['count']).toBe(2);
    expect((body['events'] as Event[]).map((event) => event.content)).toEqual(['vlakno 0', 'vlakno 1']);
    expect(body['next_since']).toBe(T0 + 1);
  });

  it('`since` je INKLUZÍVNE a `kinds=` prepíša default overlay', async () => {
    const seen: Filter[] = [];
    const app = new Hono();
    registerFedRoutes(app, {
      engine,
      pool: {
        query: async (filters) => {
          seen.push(filters[0] as Filter);
          return [];
        },
      },
      ownerSkHex: OWNER_SK_HEX,
      logger: () => undefined,
    });
    const res = await app.request(`http://gw.test/fed/events?since=${String(T0)}&kinds=30020,1023`);
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ since: T0, kinds: [30020, 1023], limit: FED_EVENTS_LIMIT_MAX });
  });

  it('neplatné parametre = 400 (stabilné `error`, žiadne 500)', async () => {
    const app = buildApp(poolOf([]));
    const cases: Array<[string, string]> = [
      ['since=-1', 'invalid since'],
      ['since=abc', 'invalid since'],
      ['since=1.5', 'invalid since'],
      ['limit=0', 'invalid limit'],
      [`limit=${String(FED_EVENTS_LIMIT_MAX + 1)}`, 'invalid limit'],
      ['limit=abc', 'invalid limit'],
      ['kinds=1023,abc', 'invalid kinds'],
    ];
    for (const [query, error] of cases) {
      const res = await app.request(`http://gw.test/fed/events?${query}`);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as Record<string, unknown>)['error'], query).toBe(error);
    }
  });

  it('bez poolu a pri zlyhaní relayu = 503 RELAY_UNAVAILABLE (nie prázdna odpoveď)', async () => {
    const noPool = buildApp(null);
    const res = await noPool.request('http://gw.test/fed/events');
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('RELAY_UNAVAILABLE');

    const broken = buildApp(poolOf([], { throws: true }));
    const res2 = await broken.request('http://gw.test/fed/events');
    expect(res2.status).toBe(503);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2['code']).toBe('RELAY_UNAVAILABLE');
    expect(body2['reasons']).toEqual(['relay timeout']);
  });

  it('relay strop (A12) sa označí `partial: true`, nie tichým krátením', async () => {
    const rows = Array.from({ length: FED_EVENTS_LIMIT_MAX }, (_, i) =>
      signed(KINDS.POST, `vlakno ${String(i)}`, T0 + i),
    );
    const app = buildApp(poolOf(rows));
    const body = (await (await app.request('http://gw.test/fed/events?limit=3')).json()) as Record<string, unknown>;
    expect(body['count']).toBe(3);
    expect(body['partial']).toBe(true);
  });
});

// ── GET /fed/topics (verejné, sekcia „Network") ────────────────────────────

describe('GET /fed/topics — korene VZDIALENÝCH stromov', () => {
  it('vráti len korene upstreamu (domáce topiky sa miešajú do GET /topics)', async () => {
    const root = signed(KINDS.TOPIC, 'koren inštancie B', T0 + 5, [['d', 'b-root']]);
    const child = signed(KINDS.TOPIC, 'dieta', T0 + 6, [
      ['d', 'b-child'],
      ['a', `30020:${root.pubkey}:b-root`],
    ]);
    db.insertRemoteEvent(UP, root as never);
    db.insertRemoteEvent(UP, child as never);

    const res = await buildApp(null).request('http://gw.test/fed/topics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    // UI (6b) kreslí tieto stromy POD sekciou Network, nikdy nie ako deti
    // domáceho koreňa `INSTANCE_ROOT_TOPIC` (dizajn Q5: never re-parented)
    expect(body['section']).toBe('network');
    expect(body['count']).toBe(1);
    const upstreams = body['upstreams'] as Array<Record<string, unknown>>;
    expect(upstreams).toHaveLength(1);
    expect(upstreams[0]).toMatchObject({ id: UP, topic_count: 2 });
    expect((upstreams[0]?.['roots'] as Array<Record<string, unknown>>).map((row) => row['slug'])).toEqual([
      'b-root',
    ]);
    expect((upstreams[0]?.['roots'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      origin: UP,
      kind: KINDS.TOPIC,
      address: `30020:${root.pubkey}:b-root`,
    });
  });

  it('inštancia bez upstreamov = prázdny zoznam (200, nie 404)', async () => {
    // samostatný engine bez upstreamov — `/fed/topics` MUSÍ existovať aj
    // when federácia vypnutá je (UI to volá sempre)
    const solo = new FedEngine({ db: openFedDb(':memory:'), upstreams: [], logger: () => undefined });
    const app = new Hono();
    registerFedRoutes(app, { engine: solo, pool: null, ownerSkHex: OWNER_SK_HEX, logger: () => undefined });
    const res = await app.request('http://gw.test/fed/topics');
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['count']).toBe(0);
    expect(body['upstreams']).toEqual([]);
  });

  it('limit mimo 1..200 = 400', async () => {
    const app = buildApp(null);
    for (const query of ['limit=0', 'limit=201', 'limit=x']) {
      const res = await app.request(`http://gw.test/fed/topics?${query}`);
      expect(res.status, query).toBe(400);
    }
  });
});

// ── GET /fed/state (owner) ─────────────────────────────────────────────────

describe('GET /fed/state — NIP-98 vlastník', () => {
  it('bez GATEWAY_OWNER_SK_HEX = 503 OWNER_NOT_CONFIGURED (ešte pred podpisom)', async () => {
    const res = await buildApp(null, '').request('http://gw.test/fed/state');
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('OWNER_NOT_CONFIGURED');
  });

  it('bez hlavičky a s cudzím podpisom = 401 / 403', async () => {
    const app = buildApp(null);
    const anonymous = await app.request('http://gw.test/fed/state');
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as Record<string, unknown>)['code']).toBe('AUTH_NIP98_INVALID');

    const stranger = await app.request('http://gw.test/fed/state', {
      headers: { authorization: nip98Token(STRANGER_SK, 'http://gw.test/fed/state', 'GET') },
    });
    expect(stranger.status).toBe(403);
    expect(((await stranger.json()) as Record<string, unknown>)['code']).toBe('NOT_OWNER');
  });

  it('token podpísaný pre INÚ route = 401 ( replay nie je dovoleny)', async () => {
    const app = buildApp(null);
    const res = await app.request('http://gw.test/fed/state', {
      headers: { authorization: nip98Token(OWNER_SK, 'http://gw.test/fed/topics', 'GET') },
    });
    expect(res.status).toBe(401);
  });

  it('vlastník dostane kurzory, parametre a mŕtve listy', async () => {
    db.bumpCheckpoint(UP, T0 + 42);
    db.recordPullAttempt(UP, true, 3, '');
    const doomed = signed(KINDS.POST, 'nemohol dojst', T0 + 9);
    db.enqueuePush(UP, doomed as never);
    db.markPushFailure(UP, doomed.id, 'HTTP 502', 0, 1);

    const res = await buildApp(null).request('http://gw.test/fed/state', {
      headers: { authorization: nip98Token(OWNER_SK, 'http://gw.test/fed/state', 'GET') },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['owner']).toBe(OWNER_PK);
    const fed = body['federation'] as Record<string, unknown>;
    expect(fed['enabled']).toBe(true);
    expect(fed['pull_limit']).toBe(200);
    expect(fed['max_attempts']).toBe(12);
    const upstreams = fed['upstreams'] as Array<Record<string, unknown>>;
    expect(upstreams).toHaveLength(1);
    expect(upstreams[0]).toMatchObject({
      id: UP,
      checkpoint: T0 + 42,
      pulled_events: 3,
      // mŕtve listy sa vracajú JEDNOTLIVO (operátor musí vidieť, ktoré
      // eventy stratil a prečo), nie ako počet
      dead_letters: [{ event_id: doomed.id, kind: KINDS.POST, attempts: 1, last_error: 'HTTP 502' }],
    });
    expect(upstreams[0]?.['queue']).toMatchObject({ dead: 1, pending: 0 });
  });
});

// ── POST /fed/resync/:id (owner) ───────────────────────────────────────────

describe('POST /fed/resync/:id — NIP-98 vlastník, reset kurzora', () => {
  const url = `http://gw.test/fed/resync/${UP}`;

  it('401 bez hlavičky, 403 cudzí podpis', async () => {
    const app = buildApp(null);
    expect((await app.request(url, { method: 'POST' })).status).toBe(401);
    const stranger = await app.request(url, {
      method: 'POST',
      headers: { authorization: nip98Token(STRANGER_SK, url, 'POST') },
    });
    expect(stranger.status).toBe(403);
  });

  it('vlastník resetne kurzor na 0 (historia sa stiahne znova, dedup neduplikuje)', async () => {
    db.bumpCheckpoint(UP, T0 + 100);
    const res = await buildApp(null).request(url, {
      method: 'POST',
      headers: { authorization: nip98Token(OWNER_SK, url, 'POST') },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, id: UP, checkpoint: 0 });
    expect(db.getUpstream(UP)?.checkpoint).toBe(0);
  });

  it('nezname id = 404 UPSTREAM_NOT_FOUND so zoznamom znamych', async () => {
    const bad = 'http://gw.test/fed/resync/cudzak.example';
    const res = await buildApp(null).request(bad, {
      method: 'POST',
      headers: { authorization: nip98Token(OWNER_SK, bad, 'POST') },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('UPSTREAM_NOT_FOUND');
    expect(body['reasons']).toEqual([
      `no upstream "cudzak.example" is configured (known: ${UP})`,
    ]);
  });

  it('id s portom prejde URL-kódované a normalizuje sa na lowercase', async () => {
    const encoded = `http://gw.test/fed/resync/${encodeURIComponent(UP.toUpperCase())}`;
    const res = await buildApp(null).request(encoded, {
      method: 'POST',
      headers: { authorization: nip98Token(OWNER_SK, encoded, 'POST') },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['id']).toBe(UP);
  });
});
