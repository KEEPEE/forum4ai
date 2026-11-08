/**
 * Unit testy Hono app — POST /events validácia + kvórum, GET /health,
 * GET /me (NIP-98), CORS a logging. Pool a outbox sú mocknuté, takže
 * test je čistio logika route (integrácia proti reálnym relayom je v
 * `integration.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { getToken } from 'nostr-tools/nip98';

import { KINDS } from '@forum4ai/shared';

import { createGatewayApp, GATEWAY_PHASE, type GatewayOutbox, type GatewayPool } from '../src/app.js';
import type { ContentLangPolicy } from '../src/content-lang.js';
import type { PublishResult, RelayStatus } from '../src/relay-pool.js';

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const ROOT_ID = 'e'.repeat(64);

function sign(kind: number, tags: string[][], content: string): Event {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
    sk,
  );
}

class MockPool implements GatewayPool {
  publishCalls: { event: Event; relays?: string[] }[] = [];
  results: PublishResult[] = [
    { url: 'ws://w1.example/', ok: true, message: 'accepted: event uložený' },
  ];
  statuses: RelayStatus[] = [
    {
      url: 'ws://w1.example/',
      connected: true,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      lastConnectedAt: 1,
    },
  ];

  async publish(event: Event, relays?: string[]): Promise<PublishResult[]> {
    this.publishCalls.push({ event, relays });
    return this.results;
  }

  status(): RelayStatus[] {
    return this.statuses;
  }
}

class MockOutbox implements GatewayOutbox {
  relays = ['ws://w1.example/'];
  calls: string[] = [];

  async writeRelaysFor(author: string): Promise<string[]> {
    this.calls.push(author);
    return this.relays;
  }
}

function makeApp(overrides?: {
  pool?: MockPool;
  outbox?: MockOutbox;
  quorumMinOk?: number;
  maxBodyBytes?: number;
  /** F4AI-2b2: jazyková politika obsahu (default `en`, žiadne vynucovanie) */
  contentLang?: ContentLangPolicy;
}) {
  const pool = overrides?.pool ?? new MockPool();
  const outbox = overrides?.outbox ?? new MockOutbox();
  const lines: string[] = [];
  const app = createGatewayApp({
    pool,
    outbox,
    quorumMinOk: overrides?.quorumMinOk,
    maxBodyBytes: overrides?.maxBodyBytes,
    ...(overrides?.contentLang !== undefined ? { contentLang: overrides.contentLang } : {}),
    logger: (line) => lines.push(line),
  });
  return { app, pool, outbox, lines };
}

async function postJson(app: ReturnType<typeof makeApp>['app'], body: unknown) {
  return app.request('/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /events — platné eventy', () => {
  it('publikuje na write relays z outboxu a vráti per-relay výsledky + quorum', async () => {
    const { app, pool, outbox } = makeApp();
    const event = sign(1020, [['d', 'unit-1020']], 'Ako sa píše gateway test?');

    const res = await postJson(app, event);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      event_id: string;
      quorum_met: boolean;
      results: PublishResult[];
    };
    expect(body.ok).toBe(true);
    expect(body.event_id).toBe(event.id);
    expect(body.quorum_met).toBe(true);
    expect(body.results).toEqual([
      { url: 'ws://w1.example/', ok: true, message: 'accepted: event uložený' },
    ]);

    expect(outbox.calls).toEqual([pubkey]);
    expect(pool.publishCalls).toHaveLength(1);
    expect(pool.publishCalls[0]?.relays).toEqual(['ws://w1.example/']);
    expect(pool.publishCalls[0]?.event.id).toBe(event.id);
  });

  it('kvórum nenaplnený → 424 s per-relay dôvodmi', async () => {
    const { app, pool } = makeApp();
    pool.results = [
      { url: 'ws://w1.example/', ok: false, message: 'rejected: kind 1020' },
      { url: 'ws://w2.example/', ok: false, message: 'not connected' },
    ];
    const event = sign(1020, [['d', 'unit-424']], 'kvórum test');

    const res = await postJson(app, event);
    expect(res.status).toBe(424);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      quorum_met: boolean;
      results: PublishResult[];
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('quorum not met');
    expect(body.quorum_met).toBe(false);
    expect(body.results).toHaveLength(2);
  });

  it('minOk=2 vyžaduje OK aspoň od dvoch relayov', async () => {
    const { app, pool } = makeApp({ quorumMinOk: 2 });
    pool.results = [
      { url: 'ws://w1.example/', ok: true, message: 'accepted' },
      { url: 'ws://w2.example/', ok: false, message: 'timeout' },
    ];
    const res = await postJson(app, sign(1020, [['d', 'unit-q2']], 'dva relaye'));
    expect(res.status).toBe(424);

    pool.results = [
      { url: 'ws://w1.example/', ok: true, message: 'accepted' },
      { url: 'ws://w2.example/', ok: true, message: 'accepted' },
    ];
    const ok = await postJson(app, sign(1020, [['d', 'unit-q2b']], 'dva relaye OK'));
    expect(ok.status).toBe(200);
  });
});

describe('POST /events — 400 s dôvodom', () => {
  it('prázdne telo a neplatný JSON', async () => {
    const { app } = makeApp();

    const empty = await postJson(app, '');
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { reasons: string[] }).reasons.join(' ')).toMatch(/empty/);

    const broken = await postJson(app, '{to nie je json');
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { reasons: string[] }).reasons.join(' ')).toMatch(/JSON/);

    const array = await postJson(app, '[]');
    expect(array.status).toBe(400);
  });

  it('chýbajúce a neočakávané polia', async () => {
    const { app } = makeApp();
    const event = sign(1020, [['d', 'unit-fields']], 'pole test');

    const missing = { ...event } as Record<string, unknown>;
    delete missing['sig'];
    const resMissing = await postJson(app, missing);
    expect(resMissing.status).toBe(400);
    expect(((await resMissing.json()) as { reasons: string[] }).reasons.join(' ')).toMatch(
      /missing fields: sig/,
    );

    const resExtra = await postJson(app, { ...event, extra: 'funkcia navyše' });
    expect(resExtra.status).toBe(400);
    expect(((await resExtra.json()) as { reasons: string[] }).reasons.join(' ')).toMatch(
      /unexpected fields: extra/,
    );
  });

  it('kind 4 nie je v registry (rovnaké ako politika nášho relaya)', async () => {
    const { app, pool } = makeApp();
    const res = await postJson(app, sign(4, [], 'poznamka kind 4'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reasons: string[] }).reasons.join(' ')).toMatch(/kind 4/);
    expect(pool.publishCalls).toHaveLength(0);
  });

  it('zlý podpis → 400 (verifyFull: podpis aj prepočet id)', async () => {
    const { app, pool } = makeApp();
    const event = sign(1020, [['d', 'unit-sig']], 'podpis test');
    const tampered = { ...event, sig: '0'.repeat(128) };
    const res = await postJson(app, tampered);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reasons: string[] }).reasons.join(' ')).toMatch(/verifyFull/);
    expect(pool.publishCalls).toHaveLength(0);
  });

  it('id nezodpovedá obsahu (pozmenený content bez prepočtu) → 400', async () => {
    const { app } = makeApp();
    const event = sign(1020, [['d', 'unit-hash']], 'povodny obsah');
    const res = await postJson(app, { ...event, content: 'iny obsah' });
    expect(res.status).toBe(400);
  });

  it('created_at v milisekundách → 400', async () => {
    const { app } = makeApp();
    const event = finalizeEvent(
      { kind: 1020, created_at: Date.now(), tags: [['d', 'unit-ms']], content: 'ms' },
      sk,
    );
    const res = await postJson(app, event);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reasons: string[] }).reasons.join(' ')).toMatch(/milliseconds/);
  });

  it('post 1023 bez root markera → 400 (shared pravidlo)', async () => {
    const { app } = makeApp();
    const res = await postJson(app, sign(1023, [['e', ROOT_ID, 'parent']], 'post bez rootu'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reasons: string[] }).reasons.join(' ')).toMatch(/root/);
  });

  it('addressable 30023 bez d tagu → 400', async () => {
    const { app } = makeApp();
    const res = await postJson(app, sign(30023, [], 'publication bez d'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reasons: string[] }).reasons.join(' ')).toMatch(/d tag/);
  });
});

describe('GET /health, GET /me a middleware', () => {
  it('health vráti agregát connected N/M — nie per-relay detaily (A9)', async () => {
    const { app } = makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; phase: string; relays: { connected: string } };
    expect(body.status).toBe('ok');
    expect(body.phase).toBe(GATEWAY_PHASE);
    expect(body.relays).toEqual({ connected: '1/1' });
  });

  it('A9: /health neunikne internal hostname ani lastError', async () => {
    const pool = new MockPool();
    pool.statuses = [
      {
        url: 'ws://relay:8080/',
        connected: true,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        lastConnectedAt: 1,
      },
      {
        url: 'ws://strfry:7777/',
        connected: false,
        attempts: 4,
        nextAttemptAt: 999,
        lastError: 'connect ECONNREFUSED 172.18.0.7:7777',
        lastConnectedAt: null,
      },
    ];
    const { app } = makeApp({ pool });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { relays: { connected: string } };
    expect(body.relays.connected).toBe('1/2');
    // ani hostname, ani port, ani kus chyby sa v odpovedi nesmú objaviť
    for (const leak of ['relay:8080', 'strfry', 'ECONNREFUSED', '172.18.0.7', 'lastError', 'attempts']) {
      expect(text).not.toContain(leak);
    }
  });

  it('GET /me s NIP-98 tokenom vráti pubkey overený podpisom', async () => {
    const { app } = makeApp();
    const token = await getToken('http://localhost/me', 'GET', async (template) =>
      finalizeEvent(template, sk),
    );
    const res = await app.request('/me', {
      headers: { authorization: `Nostr ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pubkey: string }).pubkey).toBe(pubkey);
  });

  it('GET /me bez hlavičky → 401 s dôvodom', async () => {
    const { app } = makeApp();
    const res = await app.request('/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('unauthorized');
    expect(body.reason).toMatch(/Authorization/);
  });

  it('CORS hlavičky pre UI z prehliadača (dev origin *)', async () => {
    const { app } = makeApp();
    const res = await app.request('/health', { headers: { origin: 'http://ui.local:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const preflight = await app.request('/events', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://ui.local:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('request logging píše metódu, cestu a status', async () => {
    const { app, lines } = makeApp();
    await app.request('/health');
    expect(lines.some((line) => /GET \/health 200 \d+ms/.test(line))).toBe(true);
  });

  it('neznáma cesta → 400/404 JSON', async () => {
    const { app } = makeApp();
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('not found');
  });
});

// ── regression A17 ─────────────────────────────────────────────────────────

describe('A17: strop tela a genericka internal error', () => {
  it('telo nad maxBodyBytes → 413 payload too large (Content-Length aj chunked)', async () => {
    const { app, pool } = makeApp({ maxBodyBytes: 200 });
    const big = JSON.stringify({ hello: 'x'.repeat(500) });
    const res = await app.request('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe('payload too large');
    expect(pool.publishCalls).toHaveLength(0);

    // bez Content-Length hlavy (chunked) — rozhoduje dlzka textu
    const chunked = await app.request('/events', {
      method: 'POST',
      body: big,
      duplex: 'half',
    } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it('malé telo ostáva 200 a publish prebehne', async () => {
    const { app, pool } = makeApp({ maxBodyBytes: 100_000 });
    const event = sign(1020, [['d', 'a17-ok']], 'male telo');
    const res = await postJson(app, event);
    expect(res.status).toBe(200);
    expect(pool.publishCalls).toHaveLength(1);
  });

  it('vnútorná chyba poolu → 500 s VŠEOBECNÝM dôvodom (netecie String(err))', async () => {
    const pool = new MockPool();
    pool.publish = async () => {
      throw new Error('SQLITE_BUSY /home/secret/path/index.db');
    };
    const { app, lines } = makeApp({ pool });
    const event = sign(1020, [['d', 'a17-500']], 'bublina');
    const res = await postJson(app, event);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('internal error');
    // klient nesmie videt cesty / SQL / vnutorne detaily
    expect(body.reason).not.toContain('SQLITE');
    expect(body.reason).not.toContain('/home/secret');
    // ale logger ich dostane cele
    expect(lines.some((line) => line.includes('SQLITE_BUSY'))).toBe(true);
  });
});

// ── A7 + A1 (P0, security review): odmietnutie NIP-98 authu a drahých eventov ──

describe('A7 (P0): POST /events odmietne kind 27235 a drahé eventy', () => {
  it('kind 27235 (NIP-98 signed HTTP auth) → 400 s vysvetlením, nie publish', async () => {
    const { app, pool } = makeApp();
    // kind 27235 = NIP-98 signed HTTP auth (token pre `GET /me`); poslať ho
    // na POST /events je chyba klienta — nie je to dátový event fóra
    const authEvent = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', 'POST'],
          ['u', 'http://localhost/events'],
        ],
        content: '',
      },
      sk,
    );
    expect(authEvent.kind).toBe(27235);
    const res = await postJson(app, authEvent);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reasons: string[] };
    expect(body.error).toBe('invalid event');
    expect(body.reasons.join(' ')).toMatch(/27235/);
    expect(body.reasons.join(' ')).toMatch(/\/me/);
    expect(pool.publishCalls).toHaveLength(0);
  });

  it('40 KB obsah → 400 (zdieľaný strop 32 KB zo shared/validators)', async () => {
    const { app, pool } = makeApp();
    const event = sign(KINDS.QUESTION, [], 'a'.repeat(40 * 1024));
    const res = await postJson(app, event);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reasons: string[] };
    expect(body.reasons.join(' ')).toMatch(/32768/);
    expect(pool.publishCalls).toHaveLength(0);
  });

  it('created_at z roku 2023 → 400 (spodná hranica 2024-01-01)', async () => {
    const { app, pool } = makeApp();
    const event = { ...sign(KINDS.QUESTION, [], 'stará otázka'), created_at: 1_700_000_000 };
    const res = await postJson(app, event);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reasons: string[] };
    expect(body.reasons.join(' ')).toMatch(/2024-01-01/);
    expect(pool.publishCalls).toHaveLength(0);
  });

  it('65 tagov → 400; 64 tagov still prejde', async () => {
    const { app } = makeApp();
    const tag = (i: number): string[] => ['e', i.toString(16).padStart(64, '0')];
    const many = sign(KINDS.CONTACTS, Array.from({ length: 65 }, (_, i) => tag(i)), '');
    expect((await postJson(app, many)).status).toBe(400);
    const ok = sign(KINDS.CONTACTS, Array.from({ length: 64 }, (_, i) => tag(i)), '');
    expect((await postJson(app, ok)).status).toBe(200);
  });

  it('default write-gate je OFF — zápis neobmedzený (dev inštancia 127.0.0.1)', async () => {
    const { app, pool } = makeApp();
    const res = await postJson(app, sign(KINDS.QUESTION, [], 'otázka od hocikoho'));
    expect(res.status).toBe(200);
    expect(pool.publishCalls).toHaveLength(1);
  });
});

/**
 * F4AI-2b2: NIP-32 jazykové označenie obsahu pri zápise.
 *
 * Konvencia: `["L","ISO-639-1"]` + `["l","<kod>","ISO-639-1"]` na obsahovom
 * evente (self-reporting, samostatný label event 1985 neposielame). Gateway
 * nemôže do podpísaného eventu pripojiť tag (rozbil by `id`/`sig`) — preto
 *  (a) overí to, čo klient poslal, (b) hlási efektívny jazyk v odpovedi,
 *  (c) default skutočne pripája tam, kde podpis ešte neexistuje (drafty).
 */
describe('POST /events — jazyk obsahu (NIP-32 L/l, F4AI-2b2)', () => {
  const EN_LABEL = [
    ['L', 'ISO-639-1'],
    ['l', 'en', 'ISO-639-1'],
  ];
  const SK_LABEL = [
    ['L', 'ISO-639-1'],
    ['l', 'sk', 'ISO-639-1'],
  ];

  type PublishBody = {
    ok: boolean;
    lang?: string;
    lang_declared?: boolean;
    code?: string;
    reasons?: string[];
  };

  it('event bez labelu → 200 a odpoveď hlási efektívny default en', async () => {
    const { app, pool } = makeApp();
    const event = sign(KINDS.QUESTION, [], 'How does the gateway stamp languages?');
    const res = await postJson(app, event);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishBody;
    expect(body.lang).toBe('en');
    expect(body.lang_declared).toBe(false);
    // podpisový kontrakt: gateway do eventu NEZASAHUJE — na relay letí
    // presne to, čo klient podpísal (bez L/l tagu)
    expect(pool.publishCalls[0]?.event.tags).toEqual([]);
  });

  it('klient označil en → 200, declared true a tagy zostávajú byte-identické', async () => {
    const { app, pool } = makeApp();
    const event = sign(KINDS.QUESTION, [...EN_LABEL], 'How do I stamp my own language?');
    const res = await postJson(app, event);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishBody;
    expect(body.lang).toBe('en');
    expect(body.lang_declared).toBe(true);
    // najčastejší prípad tejto inštancie: agent si label priniesol sám a
    // gateway ho nesmie duplikovať ani prepísať (hash `id` je viazaný na tagy)
    expect(pool.publishCalls[0]?.event.tags).toEqual(EN_LABEL);
  });

  it('klient označil sk → label sa poneva, odpoveď hlási sk a declared', async () => {
    const { app, pool } = makeApp();
    const event = sign(KINDS.POST, [['e', ROOT_ID, 'root'], ...SK_LABEL], 'Prispevok po slovensky');
    const res = await postJson(app, event);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishBody;
    expect(body.lang).toBe('sk');
    expect(body.lang_declared).toBe(true);
    expect(pool.publishCalls[0]?.event.tags).toEqual([['e', ROOT_ID, 'root'], ...SK_LABEL]);
  });

  it('neplatný ISO-639-1 kód → 400 s strojovým kódom LANG_INVALID', async () => {
    const { app, pool } = makeApp();
    const event = sign(KINDS.QUESTION, [['l', 'xx', 'ISO-639-1']], 'Obsah s neplatnym kodom');
    const res = await postJson(app, event);
    expect(res.status).toBe(400);
    const body = (await res.json()) as PublishBody;
    expect(body.code).toBe('LANG_INVALID');
    expect(body.reasons?.join(' ')).toContain('ISO-639-1');
    expect(pool.publishCalls).toHaveLength(0);
  });

  it('neplatný kód v kompaktnom tvare L → tiež LANG_INVALID', async () => {
    const { app } = makeApp();
    const event = sign(KINDS.TOPIC, [['d', 'my-topic'], ['L', 'eng', 'ISO-639-1']], 'desc');
    const res = await postJson(app, event);
    expect(res.status).toBe(400);
    expect(((await res.json()) as PublishBody).code).toBe('LANG_INVALID');
  });

  it('kompaktný platný tvar ["L","sk","ISO-639-1"] sa číta a ponevá', async () => {
    const { app } = makeApp();
    const event = sign(KINDS.TOPIC, [['d', 'my-topic'], ['L', 'sk', 'ISO-639-1']], 'Popis topicu');
    const res = await postJson(app, event);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishBody;
    expect(body.lang).toBe('sk');
    expect(body.lang_declared).toBe(true);
  });

  it('GATEWAY_CONTENT_LANGS=en: sk label → 400 LANG_NOT_ACCEPTED', async () => {
    const { app, pool } = makeApp({ contentLang: { defaultLang: 'en', accepted: ['en'] } });
    const event = sign(KINDS.QUESTION, [...SK_LABEL], 'Slovenska otazka');
    const res = await postJson(app, event);
    expect(res.status).toBe(400);
    const body = (await res.json()) as PublishBody;
    expect(body.code).toBe('LANG_NOT_ACCEPTED');
    expect(body.reasons?.join(' ')).toContain('accepted: en');
    expect(pool.publishCalls).toHaveLength(0);
  });

  it('GATEWAY_CONTENT_LANGS=en,sk: sk prejde a neoznačený event dostane default en', async () => {
    const { app } = makeApp({ contentLang: { defaultLang: 'en', accepted: ['en', 'sk'] } });
    const labeled = sign(KINDS.QUESTION, [...SK_LABEL], 'Slovenska otazka');
    expect((await postJson(app, labeled)).status).toBe(200);

    const bare = sign(KINDS.QUESTION, [], 'Unlabeled question');
    const res = await postJson(app, bare);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishBody;
    expect(body.lang).toBe('en');
    expect(body.lang_declared).toBe(false);
  });

  it('vynucovanie len sk: neoznačený event padá, lebo default en nie je povolený', async () => {
    const { app } = makeApp({ contentLang: { defaultLang: 'en', accepted: ['sk'] } });
    const res = await postJson(app, sign(KINDS.QUESTION, [], 'Unlabeled english question'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as PublishBody).code).toBe('LANG_NOT_ACCEPTED');
  });

  it('vypnuté vynucovanie (default): hocijaký platný cudzí kód prejde', async () => {
    const { app } = makeApp();
    const event = sign(KINDS.QUESTION, [['l', 'de', 'ISO-639-1']], 'Eine Frage auf Deutsch');
    const res = await postJson(app, event);
    expect(res.status).toBe(200);
    expect(((await res.json()) as PublishBody).lang).toBe('de');
  });

  it('infra kindy sa neštítujú: 10031 s neplatným labelom prejde a bez lang v odpovedi', async () => {
    const { app } = makeApp({ contentLang: { defaultLang: 'en', accepted: ['en'] } });
    const event = sign(KINDS.FOLLOWS, [['d', 'follows'], ['l', 'xx', 'ISO-639-1']], '[]');
    const res = await postJson(app, event);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishBody;
    expect(body.lang).toBeUndefined();
    expect(body.lang_declared).toBeUndefined();
  });

  it('default jazyk politiky rešpektuje defaultLang z configu (GATEWAY_DEFAULT_CONTENT_LANG)', async () => {
    const { app } = makeApp({ contentLang: { defaultLang: 'sk', accepted: [] } });
    const res = await postJson(app, sign(KINDS.QUESTION, [], 'Neoznacena otazka'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as PublishBody).lang).toBe('sk');
  });
});
