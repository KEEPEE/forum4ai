/**
 * Testy federačného enginu (Phase 6a, dizajn Q5) — PULL, PUSH, backoff,
 * split-horizon a tick. Siete simulujeme `fetchImpl`, takže test beží
 * bez jedinej TCP spojenia (dva in-process gatewaye cvičí
 * `fed-integration.test.ts`).
 *
 * Kľúčové vlastnosti, ktoré sa strážia:
 *  1. PULL uloží cudzí event s `origin = id upstreamu` a posunie kurzor na
 *     najvyšší `created_at`; druhý PULL ten istý event neduplikuje,
 *  2. nepodpísaný/poškodený event sa NEULOŽI (index by dostal odpad), ale
 *     kurzor sa ním nezasekne,
 *  3. saturovaná stránka bez novej riadky posunie kurzor o 1 s (inak by sa
 *     engine točil v tej istej sekunde donekonečna),
 *  4. PUSH: 200 → `done`, 4xx/5xx/sieť → `pending` s RASTÚCIM backoffom a
 *     po `maxAttempts` → `dead` (mŕtvy list),
 *  5. split-horizon: event stiahnutý od upstreamu sa späť netlačí,
 *  6. tick je SEQUENCIÁLNY a re-entrantny (druhé kolečko vráti skipped),
 *  7. `done` položky fronty kúri `prune()` (fronta nemôže rásť navždy).
 */
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { beforeEach, describe, expect, it } from 'vitest';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import {
  FedEngine,
  FED_BACKOFF_MAX_MS_DEFAULT,
  backoffDelayMs,
  fedEndpoint,
  type FedEngineOptions,
} from '../src/fed/engine.js';
import { FedDb, openFedDb } from '../src/fed/db.js';

const SK = generateSecretKey();
const UP = 'b.example:18081';
const T0 = 1_730_000_000;

function event(kind: number, content: string, createdAt: number, tags: string[][] = []): NostrEvent {
  return finalizeEvent({ kind, created_at: createdAt, tags, content }, SK) as unknown as NostrEvent;
}

/** volania, ktoré engine poslal (metóda, URL, telo) */
interface Call {
  method: string;
  url: string;
  body: string;
}

interface FakePeer {
  calls: Call[];
  /** odpoveď podľa cesty: `/fed/events` = PULL, `/events` = PUSH */
  handler: (call: Call) => { status: number; body: string };
}

function makePeer(handler: FakePeer['handler']): FakePeer {
  const peer: FakePeer = {
    calls: [],
    handler: (call) => handler(call),
  };
  return peer;
}

function fetchOf(peer: FakePeer): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const call: Call = {
      method: String(init?.method ?? 'GET').toUpperCase(),
      url,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    peer.calls.push(call);
    const reply = peer.handler(call);
    return new Response(reply.body, {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** fetch, ktorý hádže ako mŕtvy port (ECONNREFUSED) */
function refusingFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:1');
    (error as Error & { code?: string }).code = 'ECONNREFUSED';
    throw error;
  };
}

let db: FedDb;

beforeEach(() => {
  db = openFedDb(':memory:');
  db.syncUpstreams([{ id: UP, baseUrl: `http://${UP}` }]);
});

function engineOf(options: Partial<FedEngineOptions> = {}): FedEngine {
  return new FedEngine({
    db,
    upstreams: [{ id: UP, baseUrl: `http://${UP}` }],
    logger: () => undefined,
    ...options,
  });
}

describe('backoff a endpointy', () => {
  it('backoff zdvojnásobuje a je orezaný na strop', () => {
    expect(backoffDelayMs(0, 1_000, 600_000)).toBe(1_000);
    expect(backoffDelayMs(1, 1_000, 600_000)).toBe(2_000);
    expect(backoffDelayMs(2, 1_000, 600_000)).toBe(4_000);
    expect(backoffDelayMs(10, 1_000, 600_000)).toBe(600_000);
    // záporné a obrovské exponenty nesmú vyletieť mimo rozsah
    expect(backoffDelayMs(-5, 1_000, 600_000)).toBe(1_000);
    expect(backoffDelayMs(999, 1_000, FED_BACKOFF_MAX_MS_DEFAULT)).toBe(FED_BACKOFF_MAX_MS_DEFAULT);
  });

  it('fedEndpoint rešpektuje /api prefix verejnej inštancie a nelúši dvojbodky', () => {
    expect(fedEndpoint('https://aiforum.myhood.sk/api', '/fed/events')).toBe(
      'https://aiforum.myhood.sk/api/fed/events',
    );
    expect(fedEndpoint('http://127.0.0.1:18081/', '/events')).toBe(
      'http://127.0.0.1:18081/events',
    );
  });
});

describe('PULL — čítanie cudzieho obsahu', () => {
  it('uloží eventy s origin = id upstreamu a posunie kurzor', async () => {
    const a = event(KINDS.POST, 'vlakno z B', T0 + 10);
    const b = event(KINDS.TOPIC, 'koren z B', T0 + 20, [['d', 'b-root']]);
    const peer = makePeer(() => ({
      status: 200,
      body: JSON.stringify({ ok: true, events: [a, b] }),
    }));
    const engine = engineOf({ fetchImpl: fetchOf(peer) });

    const summary = await engine.pullOnce(UP);
    expect(summary.ok).toBe(true);
    expect(summary).toMatchObject({ fetched: 2, inserted: 2, invalid: 0, checkpoint: T0 + 20 });
    expect(db.remoteCount(UP)).toBe(2);
    expect(db.remoteEvents(UP).map((row) => row.content)).toEqual(['vlakno z B', 'koren z B']);
    expect(db.getUpstream(UP)?.checkpoint).toBe(T0 + 20);

    // ďalší PULL ide INKLUZÍVNE od kurzora a dedupuje per id
    const second = await engine.pullOnce(UP);
    expect(second).toMatchObject({ ok: true, fetched: 2, inserted: 0 });
    expect(db.remoteCount(UP)).toBe(2);

    // PULL dopyt musí niesť kurzor, limit a kindy
    const pull = peer.calls.find((call) => call.method === 'GET');
    expect(pull?.url).toContain('/fed/events?since=0');
    expect(pull?.url).toContain('limit=200');
    expect(pull?.url).toContain('kinds=1020');
  });

  it('neplatný podpis sa neuloží a nezasekne kurzor', async () => {
    const good = event(KINDS.POST, 'overeny', T0 + 30);
    const broken = { ...event(KINDS.POST, 'pozmeneny', T0 + 40), sig: 'f'.repeat(64) };
    const peer = makePeer(() => ({
      status: 200,
      body: JSON.stringify({ ok: true, events: [good, broken] }),
    }));
    const engine = engineOf({ fetchImpl: fetchOf(peer) });

    const summary = await engine.pullOnce(UP);
    expect(summary).toMatchObject({ ok: true, fetched: 2, inserted: 1, invalid: 1 });
    expect(db.remoteEvents(UP).map((row) => row.content)).toEqual(['overeny']);
    // kurzor ide aj cez neplatný event — inak by jeden zlý event zablokoval
    // celú inštanciu (dedup per id drží, takže opakovanie nič nestojí)
    expect(db.getUpstream(UP)?.checkpoint).toBe(T0 + 40);
  });

  it('saturovaná stránka bez novej riadky posunie kurzor o 1 s (inak nekonečná slučka)', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => event(KINDS.POST, `stary ${String(i)}`, T0 + 5));
    const peer = makePeer(() => ({ status: 200, body: JSON.stringify({ ok: true, events: rows }) }));
    const engine = engineOf({ fetchImpl: fetchOf(peer), pullLimit: 3 });

    const first = await engine.pullOnce(UP);
    expect(first.inserted).toBe(3);
    expect(db.getUpstream(UP)?.checkpoint).toBe(T0 + 5);

    // druhý PULL: rovnaká sekunda, všetky id už poznáme → MUSÍme o 1 s ďalej
    const second = await engine.pullOnce(UP);
    expect(second.inserted).toBe(0);
    expect(db.getUpstream(UP)?.checkpoint).toBe(T0 + 6);
  });

  it('peer porušný kind (30028 writers) sa do remote_events nedostane', async () => {
    const writers = event(KINDS.NODE_DIRECTORY, '[]', T0 + 45, [['d', 'forum4ai-writers']]);
    const post = event(KINDS.POST, 'vlakno', T0 + 46);
    const peer = makePeer(() => ({
      status: 200,
      body: JSON.stringify({ ok: true, events: [writers, post] }),
    }));
    const engine = engineOf({ fetchImpl: fetchOf(peer) });

    const summary = await engine.pullOnce(UP);
    expect(summary).toMatchObject({ ok: true, fetched: 2, inserted: 1, skipped: 1 });
    expect(db.remoteEvents(UP).map((row) => row.content)).toEqual(['vlakno']);
    // kurzor prešiel aj cez odmietnutý kind — inak by ho peer posielal donekonečna
    expect(db.getUpstream(UP)?.checkpoint).toBe(T0 + 46);
  });

  it('HTTP 500 a odmietnutá spojnia sa zapíšu ako chyba upstreamu', async () => {
    const peer = makePeer(() => ({ status: 500, body: JSON.stringify({ ok: false }) }));
    const failing = engineOf({ fetchImpl: fetchOf(peer) });
    const summary = await failing.pullOnce(UP);
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain('HTTP 500');
    expect(db.getUpstream(UP)?.lastError).toContain('HTTP 500');

    const dead = engineOf({ fetchImpl: refusingFetch() });
    const net = await dead.pullOnce(UP);
    expect(net.ok).toBe(false);
    expect(net.error).toContain('ECONNREFUSED');
    expect(db.getUpstream(UP)?.lastError).toContain('ECONNREFUSED');
  });

  it('neznámy upstream = chyba, nie tichý success', async () => {
    const engine = engineOf({ fetchImpl: refusingFetch() });
    const summary = await engine.pullOnce('nikto.example');
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain('unknown upstream');
  });
});

describe('PUSH — podielanie domáceho obsahu', () => {
  it('enqueueLocalEvent radi len federované kindy a len raz', () => {
    const engine = engineOf({ fetchImpl: refusingFetch() });
    const post = event(KINDS.POST, 'vlakno', T0 + 1);
    expect(engine.enqueueLocalEvent(post)).toEqual({ queued: [UP], skipped: [] });
    expect(engine.enqueueLocalEvent(post)).toEqual({ queued: [], skipped: [`${UP}:skipped-known`] });

    // 30028 writers sa neposiela (zdroj pravdy je relay, nie gateway)
    const writers = event(KINDS.NODE_DIRECTORY, '[]', T0 + 2, [['d', 'forum4ai-writers']]);
    expect(engine.enqueueLocalEvent(writers)).toEqual({ queued: [], skipped: [] });
    expect(db.queueStats(UP).total).toBe(1);
  });

  it('split-horizon: cudzí event sa späť do upstreamu netlačí', () => {
    const remote = event(KINDS.POST, 'cudzi od B', T0 + 3);
    db.insertRemoteEvent(UP, remote);
    const engine = engineOf({ fetchImpl: refusingFetch() });
    expect(engine.enqueueLocalEvent(remote)).toEqual({ queued: [], skipped: [`${UP}:skipped-remote`] });
    expect(db.queueStats(UP).total).toBe(0);
  });

  it('200 od upstreamu → done a last_success_at sa aktualizuje', async () => {
    const peer = makePeer(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const engine = engineOf({ fetchImpl: fetchOf(peer) });
    const ev = event(KINDS.POST, 'domaci vlakno', T0 + 4);
    engine.enqueueLocalEvent(ev);

    const summary = await engine.pushOnce(UP);
    expect(summary).toMatchObject({ attempted: 1, sent: 1, failed: 0, dead: 0 });
    expect(db.getQueueRow(UP, ev.id)?.status).toBe('done');

    const push = peer.calls.find((call) => call.method === 'POST');
    expect(push?.url).toBe(`http://${UP}/events`);
    expect(JSON.parse(push?.body ?? '{}')).toMatchObject({ id: ev.id, kind: KINDS.POST });
    // metrika: push úspešný MUSÍ svietiť v `last_success_at` (inak by
    // GET /fed/state tvrdil, že upstream je ticho)
    expect(db.getUpstream(UP)?.lastSuccessAt).toBeGreaterThan(0);
    expect(db.getUpstream(UP)?.lastError).toBe('');
  });

  it('403 od upstreamu → retry s backoffom a chybový kód v audite', async () => {
    let clock = 10_000;
    // FED.DB aj engine musia mat TENTO ISTÝ čas: `queued_at`/`next_attempt_at`
    // píše db, `duePushes` ich porovnáva s časom enginu
    db = new FedDb({ path: ':memory:', now: () => clock });
    db.syncUpstreams([{ id: UP, baseUrl: `http://${UP}` }]);
    const peer = makePeer(() => ({
      status: 403,
      body: JSON.stringify({ ok: false, code: 'WRITE_NOT_ALLOWED', error: 'writer not allowed' }),
    }));
    const engine = engineOf({
      fetchImpl: fetchOf(peer),
      backoffInitialMs: 1_000,
      backoffMaxMs: 8_000,
      maxAttempts: 4,
      now: () => clock,
    });
    const ev = event(KINDS.POST, 'neprepusteny', T0 + 5);
    engine.enqueueLocalEvent(ev);

    const summary = await engine.pushOnce(UP);
    expect(summary).toMatchObject({ attempted: 1, sent: 0, failed: 1 });
    const row = db.getQueueRow(UP, ev.id);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toBe(clock + 2_000); // initial * 2^1
    expect(row?.lastError).toContain('WRITE_NOT_ALLOWED');
    expect(db.getUpstream(UP)?.lastError).toContain('HTTP 403');

    // backoff rastie exponenciálne a je orezaný na strop (8000)
    const growth: number[] = [];
    for (let round = 0; round < 2; round += 1) {
      clock = (db.getQueueRow(UP, ev.id)?.nextAttemptAt ?? clock) + 1;
      const at = clock;
      await engine.pushOnce(UP);
      growth.push((db.getQueueRow(UP, ev.id)?.nextAttemptAt ?? 0) - at);
    }
    expect(growth).toEqual([4_000, 8_000]);

    // posledný pokus = mŕtvy list (už sa nikdy neskúša)
    clock = (db.getQueueRow(UP, ev.id)?.nextAttemptAt ?? clock) + 1;
    await engine.pushOnce(UP);
    const final = db.getQueueRow(UP, ev.id);
    expect(final?.attempts).toBe(4);
    expect(final?.status).toBe('dead');
    expect(final?.nextAttemptAt).toBe(0);
    expect(db.deadLetters(UP).map((row2) => row2.eventId)).toEqual([ev.id]);
  });

  it('mŕtvy port: fronta rastie a po obnovení upstreamu sa vybiduje', async () => {
    let clock = 1_000;
    db = new FedDb({ path: ':memory:', now: () => clock });
    db.syncUpstreams([{ id: UP, baseUrl: `http://${UP}` }]);
    let alive = false;
    const delivered: string[] = [];
    const peer = makePeer((call) => {
      if (!alive) throw new Error('connect ECONNREFUSED');
      delivered.push(JSON.parse(call.body).id as string);
      return { status: 200, body: JSON.stringify({ ok: true }) };
    });
    const engine = engineOf({
      // fetchImpl nesmie zahodiť — engine to rieši try/catch, tu to necháme
      // na fetch, ktorý to hodí (rovnaká cesta ako v produkcii)
      fetchImpl: async (url, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        peer.calls.push({ method: String(init?.method ?? 'GET'), url, body });
        const reply = peer.handler({ method: 'POST', url, body });
        return new Response(reply.body, { status: reply.status });
      },
      backoffInitialMs: 1_000,
      backoffMaxMs: 4_000,
      maxAttempts: 50,
      now: () => clock,
    });

    const ids = ['p1', 'p2', 'p3'].map((tag) => {
      const ev = event(KINDS.POST, `vlakno ${tag}`, T0 + 100);
      engine.enqueueLocalEvent(ev);
      return ev.id;
    });

    // upstream je mŕtvy → položky ostávajú pending a backoff rastie
    for (let round = 0; round < 3; round += 1) {
      clock += 10_000;
      const summary = await engine.pushOnce(UP);
      expect(summary.sent).toBe(0);
      expect(summary.failed).toBeGreaterThan(0);
    }
    expect(db.queueStats(UP)).toMatchObject({ pending: 3, done: 0, dead: 0 });

    // upstream ožil → fronta sa vybiduje bez straty
    alive = true;
    clock += 60_000;
    const drained = await engine.pushOnce(UP);
    expect(drained).toMatchObject({ attempted: 3, sent: 3, failed: 0 });
    expect(delivered.sort()).toEqual([...ids].sort());
    expect(db.queueStats(UP)).toMatchObject({ pending: 0, done: 3 });
  });

  it('prune() zmaže LEN hotové položky po `pruneKeepMs` a nie častejšie ako raz za interval', async () => {
    let clock = 1_000;
    // `sent_at` píše FED.DB, nie engine — hodiny musia byť SPOLOČNÉ, inak
    // sa porovnávajú dve rôzne časové osi (a test by klamal)
    const own = new FedDb({ path: ':memory:', now: () => clock });
    own.syncUpstreams([{ id: UP, baseUrl: `http://${UP}` }]);
    const peer = makePeer(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const engine = new FedEngine({
      db: own,
      upstreams: [{ id: UP, baseUrl: `http://${UP}` }],
      fetchImpl: fetchOf(peer),
      now: () => clock,
      pruneIntervalMs: 100,
      pruneKeepMs: 500,
      logger: () => undefined,
    });
    const ev = event(KINDS.POST, 'done vlakno', T0 + 6);
    engine.enqueueLocalEvent(ev);
    await engine.pushOnce(UP);
    expect(own.getQueueRow(UP, ev.id)?.status).toBe('done');

    // ešte nie je čo mazať (keep 500 ms)
    expect(engine.prune()).toBe(0);
    clock = 10_000;
    expect(engine.prune()).toBe(1);
    expect(own.getQueueRow(UP, ev.id)).toBeNull();
    // druhé kolo v tom istom intervale už nič nezmá (drahý scan sa neopakuje)
    expect(engine.prune()).toBe(0);
  });
});

describe('tick a diagnostika', () => {
  it('tick je sekvenciálny (PULL potom PUSH per upstream)', async () => {
    const order: string[] = [];
    const peer = makePeer((call) => {
      order.push(call.method === 'GET' ? 'pull' : 'push');
      if (call.method === 'GET') return { status: 200, body: JSON.stringify({ ok: true, events: [] }) };
      return { status: 200, body: JSON.stringify({ ok: true }) };
    });
    const engine = engineOf({ fetchImpl: fetchOf(peer) });
    engine.enqueueLocalEvent(event(KINDS.POST, 'vlakno', T0 + 7));

    const result = await engine.tick();
    expect(result.skipped).toBe(false);
    expect(order).toEqual(['pull', 'push']);
    expect(result.pulled).toHaveLength(1);
    expect(result.pushed[0]).toMatchObject({ sent: 1 });
  });

  it('druhé kolečko počas behu vráti skipped (žiadne prekrývanie PULLov)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new FedEngine({
      db,
      upstreams: [{ id: UP, baseUrl: `http://${UP}` }],
      logger: () => undefined,
      fetchImpl: async (url, init) => {
        if ((init?.method ?? 'GET') === 'GET') await gate;
        return new Response(JSON.stringify({ ok: true, events: [] }), { status: 200 });
      },
    });
    const first = engine.tick();
    const second = await engine.tick();
    expect(second).toEqual({ pulled: [], pushed: [], skipped: true });
    release();
    await first;
  });

  it('start(0) je no-op a stop() je idempotentný (testy a single-instance)', () => {
    const engine = engineOf({ fetchImpl: refusingFetch() });
    engine.start(0);
    engine.stop();
    engine.stop();
    // bez upstreamov sa timer nespúšťa ani pri kladnej periode
    const noPeers = new FedEngine({ db, upstreams: [], logger: () => undefined });
    noPeers.start(1_000);
    expect(noPeers.enabled).toBe(false);
    noPeers.stop();
  });

  it('state() a remoteTopics() ukazujú pravdu o kurzore, fronte a strome B', async () => {
    const root = event(KINDS.TOPIC, 'koren B', T0 + 8, [['d', 'b-root']]);
    const child = event(KINDS.TOPIC, 'dieta B', T0 + 9, [
      ['d', 'b-child'],
      ['a', `30020:${root.pubkey}:b-root`],
    ]);
    const peer = makePeer(() => ({ status: 200, body: JSON.stringify({ ok: true, events: [root, child] }) }));
    const engine = engineOf({ fetchImpl: fetchOf(peer) });
    await engine.pullOnce(UP);

    const [state] = engine.state();
    expect(state).toMatchObject({
      id: UP,
      base_url: `http://${UP}`,
      checkpoint: T0 + 9,
      remote_events: 2,
      remote_topics: 2,
      last_error: '',
    });
    expect(state?.queue).toMatchObject({ pending: 0, done: 0, dead: 0 });

    const topics = engine.remoteTopics();
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ id: UP, topic_count: 2 });
    // sekcia „Network" ukazuje KORENE, nie celý strom
    expect(topics[0]?.roots.map((row) => row.slug)).toEqual(['b-root']);

    // resync vráti kurzor na 0 (dedup per id drží, takže to nie je duplikát)
    expect(engine.resync(UP)).toBe(true);
    expect(db.getUpstream(UP)?.checkpoint).toBe(0);
    expect(engine.resync('nikto')).toBe(false);
  });

  it('params() zrkadlí efektívne hodnoty pre GET /fed/state', () => {
    const engine = engineOf({
      fetchImpl: refusingFetch(),
      pullLimit: 11,
      pushBatch: 7,
      maxAttempts: 3,
      backoffInitialMs: 5,
      backoffMaxMs: 40,
      httpTimeoutMs: 999,
    });
    expect(engine.params).toEqual({
      kinds: expect.any(Array),
      pull_limit: 11,
      push_batch: 7,
      backoff_initial_ms: 5,
      backoff_max_ms: 40,
      max_attempts: 3,
      http_timeout_ms: 999,
      prune_interval_ms: 3_600_000,
      prune_keep_ms: 86_400_000,
    });
  });
});
