/**
 * Unit testy čítacích route S5 — Hono app s `registerReadRoutes` a mock
 * poolom, ktorý filtruje vlastnú množinu eventov cez `matchFilters`
 * (nostr-tools), teda simuluje korektný relay bez siete. Eventy sú reálne
 * podpísané, lebo route defaultne spúšťa shared `verifyFull`.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { matchFilters } from 'nostr-tools/filter';
import type { Filter } from 'nostr-tools/filter';

import { KINDS } from '@forum4ai/shared';

import { GATEWAY_PHASE } from '../src/app.js';
import { registerReadRoutes, type ReadPool } from '../src/read-routes.js';

const SK_TOPIC = generateSecretKey();
const PK_TOPIC = getPublicKey(SK_TOPIC);
const SK_AUTHOR = generateSecretKey();
const PK_AUTHOR = getPublicKey(SK_AUTHOR);

function sign(sk: Uint8Array, kind: number, tags: string[][], content: string, created_at: number): Event {
  return finalizeEvent({ kind, created_at, tags, content }, sk);
}

const addrOf = (slug: string, pubkey = PK_TOPIC): string => `30020:${pubkey}:${slug}`;

class MockReadPool implements ReadPool {
  readonly queries: Filter[][] = [];

  constructor(private readonly events: Event[]) {}

  async query(filters: Filter[]): Promise<Event[]> {
    this.queries.push(filters);
    return this.events.filter((event) => matchFilters(filters, event));
  }
}

function makeApp(events: Event[]): { app: Hono; pool: MockReadPool } {
  const pool = new MockReadPool(events);
  const app = new Hono();
  registerReadRoutes(app, { pool, queryTimeoutMs: 100, logger: () => undefined });
  return { app, pool };
}

// ── dataset ───────────────────────────────────────────────────────────────

const T_ROOT = sign(SK_TOPIC, KINDS.TOPIC, [['d', 'koren']], 'root topic', 1_000_000_100);
const T_CHILD = sign(
  SK_TOPIC,
  KINDS.TOPIC,
  [['d', 'podtopic'], ['a', addrOf('koren')]],
  'child topic',
  1_000_000_200,
);
const T_ROOT2 = sign(SK_TOPIC, KINDS.TOPIC, [['d', 'druhy-koren']], 'druhy koren', 1_000_000_150);
const T_ORPHAN = sign(
  SK_TOPIC,
  KINDS.TOPIC,
  [['d', 'sirotok'], ['a', addrOf('neexistuje')]],
  'orphan',
  1_000_000_300,
);
const T_CYCLE_A = sign(
  SK_TOPIC,
  KINDS.TOPIC,
  [['d', 'cyklus-a'], ['a', addrOf('cyklus-b')]],
  'cyk a',
  1_000_000_400,
);
const T_CYCLE_B = sign(
  SK_TOPIC,
  KINDS.TOPIC,
  [['d', 'cyklus-b'], ['a', addrOf('cyklus-a')]],
  'cyk b',
  1_000_000_410,
);

const Q1 = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('koren')]], 'otazka 1', 1_000_000_500);
const Q2 = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('koren')]], 'otazka 2', 1_000_000_600);
// otázka od iného autora v TOM ISTOM topicu — adresový tag musí sedieť na pubkey topicu
const Q3 = sign(SK_TOPIC, KINDS.QUESTION, [['a', addrOf('koren')]], 'otazka 3', 1_000_000_700);
// a-tag so zlým pubkey → nepatrí do topicu
const Q_WRONG = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('koren', PK_AUTHOR)]], 'zlý a-tag', 1_000_000_800);

const IDEA = sign(SK_AUTHOR, KINDS.IDEA_CALL, [], 'napad', 1_000_000_550);
const COLLAB = sign(SK_AUTHOR, KINDS.COLLAB_CALL, [], 'spolupraca', 1_000_000_650);

const R1 = sign(SK_AUTHOR, KINDS.POST, [['e', Q1.id, 'root']], 'odpoved 1', 1_000_000_900);
const R2 = sign(
  SK_AUTHOR,
  KINDS.POST,
  [
    ['e', Q1.id, 'root'],
    ['e', R1.id, 'parent'],
  ],
  'odpoved 2 (zabavena pod R1)',
  1_000_001_000,
);
// R3 nemá root marker — root sa odvodí retiazkou parent markerov (R3 → R1 → Q1)
const R3 = sign(SK_AUTHOR, KINDS.POST, [['e', R1.id, 'parent']], 'odpoved 3 (parent-only)', 1_000_001_100);
// odpoveď patrí do iného vlákna
const R_OTHER = sign(SK_AUTHOR, KINDS.POST, [['e', Q2.id, 'root']], 'inna nitka', 1_000_001_200);
// parent na neznáme id → root neviem odvodiť → vylúčená
const R_UNKNOWN = sign(SK_AUTHOR, KINDS.POST, [['e', 'd'.repeat(64), 'parent']], 'neznamy parent', 1_000_001_300);

const ALL = [
  T_ROOT, T_CHILD, T_ROOT2, T_ORPHAN, T_CYCLE_A, T_CYCLE_B,
  Q1, Q2, Q3, Q_WRONG, IDEA, COLLAB, R1, R2, R3, R_OTHER, R_UNKNOWN,
];

// ── GET /topics ───────────────────────────────────────────────────────────

describe('GET /topics', () => {
  it('strom zoradeny podla aktivity: koren s nitami prv, pocty na uzloch', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/topics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phase: string;
      topic_count: number;
      topics: {
        slug: string;
        children: { slug: string; thread_count?: number }[];
        address: string | null;
        thread_count?: number;
      }[];
      issues: string[];
    };
    expect(body.phase).toBe(GATEWAY_PHASE);

    const koren = body.topics.find((t) => t.slug === 'koren');
    expect(koren?.address).toBe(addrOf('koren'));
    expect(koren?.children.map((c) => c.slug)).toContain('podtopic');
    // Q1, Q2, Q3 viazia na koren — thread_count zahrna aj deti (podtopic 0)
    expect(koren?.thread_count).toBe(3);
    expect(koren?.children.find((c) => c.slug === 'podtopic')?.thread_count).toBe(0);

    // aktivita: koren (3 nite) pred prazdnym druhym-korenom (0), aj ked
    // je starsi created_at — to je presne ten pripad, kvoli ktoremu sme
    // ordering menili (junk bez nit nesmu zakopat vycurenu hierarchiu)
    const slugs = body.topics.filter((t) => t.address !== null).map((t) => t.slug);
    expect(slugs).toEqual(['koren', 'druhy-koren']);
    const counts = body.topics
      .filter((t) => t.address !== null)
      .map((t) => t.thread_count);
    expect(counts).toEqual([3, 0]);

    const unsorted = body.topics[body.topics.length - 1];
    expect(unsorted?.slug).toBe('unsorted');
    expect(unsorted?.children.map((c) => c.slug).sort()).toEqual([
      'cyklus-a',
      'cyklus-b',
      'sirotok',
    ]);
    expect(body.issues.join(' ')).toMatch(/orphan|cycle/);
  });

  it('LWW: staršia verzia topicu zmizne z stromu', async () => {
    const stale = sign(SK_TOPIC, KINDS.TOPIC, [['d', 'koren']], 'stara verzia', 1_000_000_050);
    const { app } = makeApp([stale, T_ROOT]);
    const res = await app.request('/topics');
    const body = (await res.json()) as { topics: { slug: string; event_id: string }[] };
    const koren = body.topics.find((t) => t.slug === 'koren');
    expect(koren?.event_id).toBe(T_ROOT.id);
  });
});

// ── GET /topics — activity ordering (počty nití + descendants) ────────────

describe('GET /topics — activity ordering', () => {
  // samostatny dataset, aby sme nenarusili ocakavania ostatnych testov
  const T_OLD_RICH = sign(SK_TOPIC, KINDS.TOPIC, [['d', 'stary-bohaty']], '3 nite', 1_000_000_000);
  const T_MID = sign(SK_TOPIC, KINDS.TOPIC, [['d', 'stredne']], '1 nit', 1_000_002_000);
  const T_EMPTY_NEW = sign(SK_TOPIC, KINDS.TOPIC, [['d', 'prazdny-novy']], '0 nit, najnovsi cas', 1_000_005_000);
  const T_EMPTY_OLD = sign(SK_TOPIC, KINDS.TOPIC, [['d', 'prazdny-stary']], '0 nit', 1_000_000_050);

  const Q_RICH_1 = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('stary-bohaty')]], 'r1', 1_000_006_000);
  const Q_RICH_2 = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('stary-bohaty')]], 'r2', 1_000_006_010);
  // 3. nit v PODTOPICU stary-bohaty — zapocita sa do poctu korena (descendant)
  const T_RICH_CHILD = sign(
    SK_TOPIC,
    KINDS.TOPIC,
    [['d', 'stary-bohaty-pod'], ['a', addrOf('stary-bohaty')]],
    'podtopic',
    1_000_000_010,
  );
  const Q_RICH_DESC = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('stary-bohaty-pod')]], 'r3 descendant', 1_000_006_020);
  const Q_MID = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('stredne')]], 'm1', 1_000_006_030);
  // idea_call a collab_call su tiez nite (FEED_KINDS 1020/1021/1022)
  const IDEA_MID = sign(SK_AUTHOR, KINDS.IDEA_CALL, [['a', addrOf('stredne')]], 'idea v stredne', 1_000_006_040);

  const ACTIVITY = [
    T_OLD_RICH, T_RICH_CHILD, T_MID, T_EMPTY_NEW, T_EMPTY_OLD,
    Q_RICH_1, Q_RICH_2, Q_RICH_DESC, Q_MID, IDEA_MID,
  ];

  it('korene: pocet niti klesajuco, zhoda rozhoduje novsi created_at', async () => {
    const { app } = makeApp(ACTIVITY);
    const res = await app.request('/topics');
    const body = (await res.json()) as {
      topics: { slug: string; address: string | null; thread_count?: number }[];
    };
    // stary-bohaty 3 (2 vlastne + 1 descendant), stredne 2 (1020+1021),
    // prazdne 0 — pri zhode 0 rozhoduje novsi created_at
    const real = body.topics.filter((t) => t.address !== null);
    expect(real.map((t) => t.slug)).toEqual([
      'stary-bohaty',
      'stredne',
      'prazdny-novy',
      'prazdny-stary',
    ]);
    expect(real.map((t) => t.thread_count)).toEqual([3, 2, 0, 0]);
    // descendant pocet je vidiet aj na podtopicu
    const rich = body.topics.find((t) => t.slug === 'stary-bohaty');
    expect(rich?.children.find((c) => c.slug === 'stary-bohaty-pod')).toBeTruthy();
  });

  it('unsorted ostava posledny aj ked ma nite (invariant buildTopicTree)', async () => {
    // sirotok ma nit — jeho podstrom ma thread_count 1, ale synteticky
    // unsorted uzol nesmie predbehnut realne korene s vyssim poctom
    const orphanThread = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('sirotok')]], 'nit v sirotkovi', 1_000_007_000);
    // T_RICH_CHILD je nutny — Q_RICH_DESC viaza na 'stary-bohaty-pod' a
    // bez topicu s touto adresou by bola nit orphan (nepocitala by sa)
    const { app } = makeApp([T_ORPHAN, T_OLD_RICH, T_RICH_CHILD, Q_RICH_1, Q_RICH_2, Q_RICH_DESC, orphanThread]);
    const res = await app.request('/topics');
    const body = (await res.json()) as {
      topics: { slug: string; thread_count?: number; children: { slug: string; thread_count?: number }[] }[];
    };
    const last = body.topics[body.topics.length - 1];
    expect(last?.slug).toBe('unsorted');
    expect(last?.thread_count).toBe(1);
    expect(last?.children.find((c) => c.slug === 'sirotok')?.thread_count).toBe(1);
    expect(body.topics[0]?.slug).toBe('stary-bohaty');
    expect(body.topics[0]?.thread_count).toBe(3);
  });
});

// ── GET /topics/:slug ─────────────────────────────────────────────────────

describe('GET /topics/:slug', () => {
  it('404 pre neexistujúci slug', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/topics/neexistuje');
    expect(res.status).toBe(404);
  });

  it('400 pre neplatný tvar slugu', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/topics/' + encodeURIComponent('Bad Slug'));
    expect(res.status).toBe(400);
  });

  it('detail: deti, threardy podľa adresy s pubkey autora topicu, počty', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/topics/koren');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      topic: { slug: string; address: string; thread_count?: number };
      children: { slug: string }[];
      threads: { id: string }[];
      thread_count: number;
      limit: number;
    };
    expect(body.topic.slug).toBe('koren');
    expect(body.topic.address).toBe(addrOf('koren'));
    // uzol stromu nesie pocet aktivitu (vlastne + descendants) — Q1/Q2/Q3
    expect(body.topic.thread_count).toBe(3);
    expect(body.children.map((c) => c.slug)).toEqual(['podtopic']);

    // Q1 (autor SK_AUTHOR), Q2, Q3 (autor SK_TOPIC) — obaja v topicu;
    // Q_WRONG má a-tag na adresu s pubkey autora otázky → nepatrí sem
    const ids = body.threads.map((t) => t.id);
    expect(ids.sort()).toEqual([Q1.id, Q2.id, Q3.id].sort());
    expect(ids).not.toContain(Q_WRONG.id);
    expect(body.thread_count).toBe(3);
    expect(body.limit).toBe(20);
  });

  it('deti topicu sú zoradené podľa aktivity (viac nití vyššie)', async () => {
    // pridame druhe dieta s 2 nitami — musi sa zobrazit pred prazdnym
    // podtopicom, aj ked je podtopic starsi (created_at asc by bol opacne)
    const T_CHILD2 = sign(
      SK_TOPIC,
      KINDS.TOPIC,
      [['d', 'podtopic-druhy'], ['a', addrOf('koren')]],
      'druhe dieta',
      1_000_000_250,
    );
    const Q_D1 = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('podtopic-druhy')]], 'd1', 1_000_001_400);
    const Q_D2 = sign(SK_AUTHOR, KINDS.QUESTION, [['a', addrOf('podtopic-druhy')]], 'd2', 1_000_001_410);
    const { app } = makeApp([...ALL, T_CHILD2, Q_D1, Q_D2]);
    const res = await app.request('/topics/koren');
    const body = (await res.json()) as {
      topic: { thread_count?: number };
      children: { slug: string; thread_count?: number }[];
    };
    expect(body.children.map((c) => c.slug)).toEqual(['podtopic-druhy', 'podtopic']);
    expect(body.children.map((c) => c.thread_count)).toEqual([2, 0]);
    // koren = vlastne 3 + deti 2
    expect(body.topic.thread_count).toBe(5);
  });

  it('limit ostrihne threads, thread_count ostáva plný', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/topics/koren?limit=1');
    const body = (await res.json()) as { threads: { id: string; created_at: number }[]; thread_count: number };
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]?.id).toBe(Q3.id); // created_at desc
    expect(body.thread_count).toBe(3);
  });

  it('400 pre limit mimo rozsahu', async () => {
    const { app } = makeApp(ALL);
    for (const bad of ['0', '101', 'abc']) {
      const res = await app.request(`/topics/koren?limit=${bad}`);
      expect(res.status).toBe(400);
    }
  });
});

// ── GET /threads/:id ──────────────────────────────────────────────────────

describe('GET /threads/:id', () => {
  it('404 pre neznáme id', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request(`/threads/${'e'.repeat(64)}`);
    expect(res.status).toBe(404);
  });

  it('404 pre id eventu, ktorý nie je thread root (1024)', async () => {
    const reaction = sign(SK_AUTHOR, KINDS.REACTION, [['e', Q1.id]], ':)', 1_000_002_000);
    const { app } = makeApp([...ALL, reaction]);
    const res = await app.request(`/threads/${reaction.id}`);
    expect(res.status).toBe(404);
  });

  it('400 pre neplatný tvar id', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/threads/nieje-hex');
    expect(res.status).toBe(400);
  });

  it('root + strom odpovedi: R1 pod root, R2/R3 pod R1, iné vlákna vylúčené', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request(`/threads/${Q1.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      root: { id: string; kind: number };
      replies: { id: string; children: { id: string }[] }[];
      reply_count: number;
    };
    expect(body.root.id).toBe(Q1.id);
    expect(body.root.kind).toBe(KINDS.QUESTION);
    expect(body.reply_count).toBe(3);

    expect(body.replies.map((r) => r.id)).toEqual([R1.id]);
    const r1 = body.replies[0] as (typeof body.replies)[number];
    expect(r1.children.map((c) => c.id)).toEqual([R2.id, R3.id]); // created_at asc
  });

  it('1023 môže byť root vlákna (zadanie: 1020/1021/1022/1023)', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request(`/threads/${R1.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: { id: string }; replies: { id: string }[] };
    expect(body.root.id).toBe(R1.id);
    // R2 (root→Q1) nepatrí sem; R3 (parent→R1) áno — root je R1? R3 retiazka:
    // parent R1 → R1 má root marker na Q1 → root Q1 → R3 tiež nepatrí pod R1.
    expect(body.replies).toHaveLength(0);
  });
});

// ── GET /feed ─────────────────────────────────────────────────────────────

describe('GET /feed', () => {
  it('default: všetky 3 koreňové kindy, created_at desc', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/feed');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kinds: number[]; items: { id: string; created_at: number }[]; count: number };
    expect(body.kinds).toEqual([1020, 1021, 1022]);
    // Q_WRONG je 1020 → do feedu patrí (feed nefiltruje podľa topicu)
    expect(body.items.map((i) => i.id)).toEqual([
      Q_WRONG.id, Q3.id, COLLAB.id, Q2.id, IDEA.id, Q1.id,
    ]);
    expect(body.count).toBe(6);
  });

  it('kinds filter vyberí len požadovaný kind', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/feed?kinds=1021');
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual([IDEA.id]);
  });

  it('kinds=1020,1022 vyberie oba', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/feed?kinds=1020,1022');
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id).sort()).toEqual(
      [Q1.id, Q2.id, Q3.id, Q_WRONG.id, COLLAB.id].sort(),
    );
  });

  it('limit ostrihne', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/feed?limit=2');
    const body = (await res.json()) as { items: { id: string }[]; limit: number };
    expect(body.items.map((i) => i.id)).toEqual([Q_WRONG.id, Q3.id]);
    expect(body.limit).toBe(2);
  });

  it('kinds mimo dovolenej množiny → 400', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/feed?kinds=1024');
    expect(res.status).toBe(400);
  });

  it('limit mimo rozsahu → 400', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/feed?limit=101');
    expect(res.status).toBe(400);
  });
});

// ── overovanie podpisu ────────────────────────────────────────────────────

describe('verifyFull nad čítanými eventami', () => {
  it('event s pozmeneným podpisom zahodíme (default verify: true)', async () => {
    const tampered: Event = { ...Q2, sig: '0'.repeat(128) };
    const { app } = makeApp(ALL.map((e) => (e.id === Q2.id ? tampered : e)));
    const res = await app.request('/feed');
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).not.toContain(Q2.id);
  });

  it('verify: false signatúru nekontroluje', async () => {
    const tampered: Event = { ...Q2, sig: '0'.repeat(128) };
    const pool = new MockReadPool(ALL.map((e) => (e.id === Q2.id ? tampered : e)));
    const app = new Hono();
    registerReadRoutes(app, { pool, verify: false, queryTimeoutMs: 100, logger: () => undefined });
    const res = await app.request('/feed');
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toContain(Q2.id);
  });
});

// ── GET /recent (F4AI-12, S6) ─────────────────────────────────────────────

describe('GET /recent', () => {
  it('default kindy 1020/1021/1022/1023 — o 1023 odpovede navyše oproti /feed', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/recent');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phase: string;
      kinds: number[];
      limit: number;
      count: number;
      items: { id: string; kind: number }[];
    };
    expect(body.kinds).toEqual([1020, 1021, 1022, 1023]);
    expect(body.limit).toBe(100);
    // odpovede (1023) tu sú, v /feed nie
    expect(body.items.map((i) => i.id)).toContain(R1.id);
    expect(body.items.map((i) => i.id)).toContain(R_OTHER.id);
    // topics (30020) tu nie sú
    expect(body.items.map((i) => i.id)).not.toContain(T_ROOT.id);
    // triedenie created_at klesajúco
    const times = body.items.map((i) => i.created_at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('kinds parameter smie hociktorý kind registry (30020, 10031)', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/recent?kinds=30020');
    const body = (await res.json()) as { items: { kind: number }[] };
    expect(res.status).toBe(200);
    expect(body.items.every((i) => i.kind === 30020)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);

    const res2 = await app.request('/recent?kinds=10031');
    expect(res2.status).toBe(200);
  });

  it('kinds mimo registry → 400 s reasons', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/recent?kinds=999');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reasons: string[] };
    expect(body.reasons[0]).toContain('shared forum4ai registry');
  });

  it('authors filter vráti len eventy daného pubkey', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request(`/recent?authors=${PK_TOPIC}`);
    const body = (await res.json()) as { authors?: string[]; items: { pubkey: string }[] };
    expect(res.status).toBe(200);
    expect(body.authors).toEqual([PK_TOPIC]);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.pubkey === PK_TOPIC)).toBe(true);
  });

  it('authors v zlom tvare → 400', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/recent?authors=nothex');
    expect(res.status).toBe(400);
  });

  it('limit do 1000 je povolený, 1001 nie (na rozdiel od /feed so stropom 100)', async () => {
    const { app } = makeApp(ALL);
    const ok = await app.request('/recent?limit=500');
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { limit: number };
    expect(okBody.limit).toBe(500);

    const bad = await app.request('/recent?limit=1001');
    expect(bad.status).toBe(400);

    const feedBad = await app.request('/feed?limit=500');
    expect(feedBad.status).toBe(400);
  });

  it('limit ostrihne po zlúčení a triedení', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request('/recent?limit=2');
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.id).toBe(R_UNKNOWN.id); // najnovší created_at
  });
});

// ── GET /threads/:id — rating agregát (F4AI-15, S9) ──────────────────────

describe('GET /threads/:id — rating agregát (S9, backward compatible)', () => {
  const SK_RATER = generateSecretKey();
  const SK_RATER2 = generateSecretKey();
  const RATING_HI = sign(
    SK_RATER,
    KINDS.SOLUTION_RATING,
    [['e', R1.id, ''], ['e', Q1.id, 'root']],
    '{"score":5}',
    1_000_003_000,
  );
  const RATING_LO = sign(
    SK_RATER2,
    KINDS.SOLUTION_RATING,
    [['e', R1.id, ''], ['e', Q1.id, 'root']],
    '{"score":3}',
    1_000_003_010,
  );
  const ACCEPT = sign(
    SK_AUTHOR,
    KINDS.ACCEPTED_SOLUTION,
    [['e', R1.id, ''], ['e', Q1.id, 'root']],
    '',
    1_000_003_020,
  );
  // rating na INÉ vlákno — nesmie pretečť do agregátu Q1
  const RATING_OTHER = sign(
    SK_RATER,
    KINDS.SOLUTION_RATING,
    [['e', R1.id, ''], ['e', Q2.id, 'root']],
    '{"score":1}',
    1_000_003_030,
  );

  it('thread response má additívne pole rating: mean/Wilson/n_eff/accepted', async () => {
    const { app } = makeApp([...ALL, RATING_HI, RATING_LO, ACCEPT, RATING_OTHER]);
    const res = await app.request(`/threads/${Q1.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      root: { id: string };
      reply_count: number;
      rating: {
        count: number;
        mean: number;
        mean15: number;
        n_eff: number;
        wilson: number;
        accepted: boolean;
        accepted_count: number;
      };
    };
    // pôvodné polia nezmenené (backward compat)
    expect(body.root.id).toBe(Q1.id);
    expect(body.reply_count).toBe(3);

    const { rating } = body;
    expect(rating.count).toBe(2); // RATING_OTHER patrí pod Q2
    // cluster stropy: 2 singleton ratingeri → each 0.15*2=0.3;
    // mean = (0.3*1 + 0.3*0.5)/0.6 = 0.75 → mean15 = 4.0
    expect(rating.mean).toBeCloseTo(0.75, 9);
    expect(rating.mean15).toBeCloseTo(4, 9);
    expect(rating.n_eff).toBeCloseTo(2, 9);
    expect(rating.wilson).toBeGreaterThan(0);
    expect(rating.wilson).toBeLessThan(1);
    expect(rating.accepted).toBe(true);
    expect(rating.accepted_count).toBe(1);
  });

  it('thread bez ratingov a acceptov → rating s nulami, nie chyba', async () => {
    const { app } = makeApp(ALL);
    const res = await app.request(`/threads/${Q1.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rating: { count: number; mean: number; wilson: number; accepted: boolean };
    };
    expect(body.rating.count).toBe(0);
    expect(body.rating.mean).toBe(0);
    expect(body.rating.wilson).toBe(0);
    expect(body.rating.accepted).toBe(false);
  });
});

// ── regression A8 + A12 ────────────────────────────────────────────────────

describe('GET /topics/:slug — koreň slugu (regression A8)', () => {
  it('rovnaký slug od dvoch autorov: koreňom je NAJSTARŠIA definícia', async () => {
    const curated = sign(SK_TOPIC, KINDS.TOPIC, [['d', 'kradeny']], 'kurátorská definícia', 1_000_000_500);
    const thief = sign(SK_AUTHOR, KINDS.TOPIC, [['d', 'kradeny']], 'neskorší kradeň', 1_000_000_900);
    const { app } = makeApp([curated, thief]);
    const res = await app.request('/topics/kradeny');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { topic: { pubkey: string; event_id: string } };
    // A8: kurátorská (staršia) definícia vyhráva nad neskoršou kópiou
    expect(body.topic.pubkey).toBe(PK_TOPIC);
    expect(body.topic.event_id).toBe(curated.id);
  });

  it('rovnaký created_at rozhoduje nižšie id', async () => {
    const a = sign(SK_TOPIC, KINDS.TOPIC, [['d', 'dvojka']], 'a', 1_000_000_500);
    const b = sign(SK_AUTHOR, KINDS.TOPIC, [['d', 'dvojka']], 'b', 1_000_000_500);
    const winner = a.id < b.id ? a : b;
    const { app } = makeApp([a, b]);
    const res = await app.request('/topics/dvojka');
    const body = (await res.json()) as { topic: { event_id: string } };
    expect(body.topic.event_id).toBe(winner.id);
  });
});

describe('windowované čítanie (regression A12)', () => {
  /** mock relayu s `maxFilterLimit` — vráti max `limit` NAJNOVŠÍCH eventov */
  class CappedReadPool implements ReadPool {
    readonly queries: Filter[][] = [];
    constructor(private readonly events: Event[], private readonly cap = 500) {}
    async query(filters: Filter[]): Promise<Event[]> {
      this.queries.push(filters);
      const limit = typeof filters[0]?.limit === 'number' ? filters[0].limit : this.cap;
      return this.events
        .filter((event) => matchFilters(filters, event))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Math.min(limit, this.cap));
    }
  }

  it('/topics okná cez `until`: >500 topikov sa neořeže tichým stropom', async () => {
    const many: Event[] = [];
    for (let i = 0; i < 620; i += 1) {
      many.push(
        sign(SK_TOPIC, KINDS.TOPIC, [['d', `t-${String(i).padStart(4, '0')}`]], `t${String(i)}`, 1_000_000_000 + i),
      );
    }
    const pool = new CappedReadPool(many, 500);
    const app = new Hono();
    registerReadRoutes(app, { pool, queryTimeoutMs: 100, logger: () => undefined });

    const res = await app.request('/topics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { topic_count: number; partial?: boolean };
    // 620 > 500: bez windowingu by sme videli len 500 (tichý strop)
    expect(body.topic_count).toBe(620);
    expect(body.partial).toBeUndefined(); // 2. okno neúplné → nie je partial
    // dopyty: 1. okno bez `until`, 2. okno s `until` = min predchádzajúceho
    const topicQueries = pool.queries.filter((fs) => fs.some((f) => f.kinds?.includes(KINDS.TOPIC)));
    expect(topicQueries.length).toBeGreaterThanOrEqual(2);
    expect(topicQueries[0]?.[0]?.until).toBeUndefined();
    expect(typeof topicQueries[1]?.[0]?.until).toBe('number');
  }, 30_000); // 620 schnorr signatures — on a slow CI runner this exceeds the default 5 s
});
