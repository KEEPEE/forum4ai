/**
 * Testy HTTP route `GET /search` (F4AI-14, S8) — validácia parametrov,
 * 503 bez indexu (rozhodnutie: ŽIADNY tichý fallback), filter kombinácie,
 * snippet, deadline `partial`, RRF fúzia a zárez konfigurácie
 * (`GATEWAY_INDEX_DB` / `GATEWAY_SEARCH_DEADLINE_MS`) v `buildGateway`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway, type GatewayRuntime } from '../src/config.js';
import {
  Fts5SearchChannel,
  UnavailableIndexChannel,
  createVectorStubChannel,
  type RankedHit,
  type SearchChannel,
  type SearchQueryOptions,
} from '../src/search.js';
import { registerSearchRoutes } from '../src/search-routes.js';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

/** kópia DDL z `packages/indexer/src/db.ts` (pravdivosť schémy strážia
 *  integračné testy v `packages/indexer/test/`, ktoré bežia nad skutočnou
 *  DB indexera) */
const INDEXER_SCHEMA = `
CREATE TABLE events (
  id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL,
  tags_text TEXT NOT NULL DEFAULT '', sig TEXT NOT NULL, addr TEXT NULL,
  inserted_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX events_addr ON events (addr);
CREATE VIRTUAL TABLE events_fts USING fts5(
  content, tags_text, content = 'events', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, content, tags_text)
  VALUES (new.rowid, new.content, new.tags_text);
END;
`;

function seed(path: string): void {
  const writer = new Database(path);
  writer.pragma('journal_mode = WAL');
  writer.exec(INDEXER_SCHEMA);
  const insert = writer.prepare(
    `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at)
     VALUES (?, ?, ?, ?, ?, '[]', '', 'sig', ?, 0)`,
  );
  insert.run('e1'.padEnd(64, '1'), PK_A, 1020, 1_000, 'Reklamačná poistka — ako podať reklamačný formulár?', null);
  insert.run('e2'.padEnd(64, '2'), PK_B, 1023, 2_000, 'reklamacna bola zamietnutá, lebo poistenie trvalo krátko', null);
  insert.run('e3'.padEnd(64, '3'), PK_B, 30023, 3_000, 'Sprievodca poistením a reklamáciami', `30023:${PK_B}:sprievodca`);
  writer.close();
}

const dir = mkdtempSync(join(tmpdir(), 'f4ai-gw-routes-'));
const dbPath = join(dir, 'index.db');

/** ručná Hono app (bez relay poolu) — dosť na izolovanú test route logiky */
function buildApp(
  channels: SearchChannel[],
  options?: { deadlineMs?: number; index?: Fts5SearchChannel },
): Hono {
  const app = new Hono();
  registerSearchRoutes(app, {
    channels,
    ...(options?.index !== undefined ? { index: options.index } : {}),
    ...(options?.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    logger: () => undefined,
  });
  return app;
}

function hit(id: string, extra: Partial<RankedHit> = {}): RankedHit {
  return {
    id,
    kind: 1020,
    pubkey: PK_A,
    created_at: 1_000,
    score: -1,
    snippet: `snippet ${id}`,
    ...extra,
  };
}

function fakeChannel(name: string, hits: RankedHit[]): SearchChannel {
  return {
    name,
    search: () => hits,
  };
}

function slowChannel(name: string, hits: RankedHit[], delayMs: number): SearchChannel {
  return {
    name,
    search: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return hits;
    },
  };
}

type SearchBody = {
  phase?: string;
  query?: string;
  normalized_query?: string;
  took_ms?: number;
  count?: number;
  limit?: number;
  deadline_ms?: number;
  partial?: boolean;
  channels?: string[];
  results?: Array<Record<string, unknown>>;
  filters?: Record<string, unknown>;
  note?: string;
  untrusted?: string;
  error?: string;
  reason?: string;
  reasons?: string[];
};

let channel: Fts5SearchChannel;
let app: Hono;

beforeAll(() => {
  seed(dbPath);
  channel = new Fts5SearchChannel({ path: dbPath, logger: () => undefined });
  // app až po seednutí — channel sa inak dostane do route ako undefined
  app = buildApp([channel, createVectorStubChannel()], { index: channel });
});

afterAll(() => {
  channel?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /search — validácia a chybové kódy', () => {
  it('bez q → 400 s dôvodom', async () => {
    const res = await app.request('/search');
    expect(res.status).toBe(400);
    const body = (await res.json()) as SearchBody;
    expect(body.error).toBe('missing q');
    expect(body.reasons?.[0]).toContain('q');
  });

  it('prázdne q → 400', async () => {
    const res = await app.request('/search?q=%20%20');
    expect(res.status).toBe(400);
  });

  it('zlé kinds / authors / since / until / limit → 400 s konkrétnym dôvodom', async () => {
    const cases: Array<[string, string]> = [
      ['?q=x&kinds=abc', 'invalid kinds'],
      ['?q=x&kinds=-1', 'invalid kinds'],
      ['?q=x&kinds=1020,99.5', 'invalid kinds'],
      ['?q=x&authors=nope', 'invalid authors'],
      ['?q=x&authors=' + 'a'.repeat(63), 'invalid authors'],
      ['?q=x&since=abc', 'invalid since'],
      ['?q=x&until=-5', 'invalid until'],
      ['?q=x&limit=0', 'invalid limit'],
      ['?q=x&limit=51', 'invalid limit'],
      ['?q=x&limit=2.5', 'invalid limit'],
    ];
    for (const [qs, expected] of cases) {
      const res = await app.request(`/search${qs}`);
      expect(res.status, qs).toBe(400);
      const body = (await res.json()) as SearchBody;
      expect(body.error, qs).toBe(expected);
      expect(body.reasons?.[0], qs).toBeTruthy();
    }
  });

  it('since > until → 400 (preklep v intervale)', async () => {
    const res = await app.request('/search?q=x&since=2000&until=1000');
    expect(res.status).toBe(400);
    const body = (await res.json()) as SearchBody;
    expect(body.error).toBe('invalid since/until');
  });

  it('index nenastavený (GATEWAY_INDEX_DB chýba) → 503 index unavailable', async () => {
    const off = buildApp([new UnavailableIndexChannel('GATEWAY_INDEX_DB nie je nastavená')]);
    const res = await off.request('/search?q=reklamacna');
    expect(res.status).toBe(503);
    const body = (await res.json()) as SearchBody;
    expect(body.error).toBe('index unavailable');
    expect(body.reason).toContain('GATEWAY_INDEX_DB');
  });

  it('index nastavený, ale DB neexistuje → 503 s dôvodom a bez tichého fallbacku', async () => {
    const missing = new Fts5SearchChannel({
      path: join(dir, 'zzz.db'),
      logger: () => undefined,
    });
    const off = buildApp([missing, createVectorStubChannel()]);
    const res = await off.request('/search?q=reklamacna');
    expect(res.status).toBe(503);
    const body = (await res.json()) as SearchBody;
    expect(body.error).toBe('index unavailable');
    expect(body.reason).toContain('does not exist');
    // žiadne `results` — klient si nesmie mýliť 503 s „našli sme nula vecí“
    expect(body.results).toBeUndefined();
    missing.close();
  });

  it('503 nevznikne zlyhaním sekundárneho kanála (vector kanál padá → 200 z FTS5)', async () => {
    const broken = buildApp([
      channel,
      {
        name: 'vector',
        search: () => {
          throw new Error('sqlite-vec nie je nahrané');
        },
      },
    ]);
    const res = await broken.request('/search?q=reklamacna');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.count).toBeGreaterThan(0);
    expect(body.channels).toEqual(['fts5']);
  });
});

describe('GET /search — úspešná odpoveď', () => {
  it('shape: query, normalized_query, took_ms, count, results[], untrusted, partial', async () => {
    const res = await app.request('/search?q=reklamacna');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.phase).toBe('S8');
    expect(body.query).toBe('reklamacna');
    expect(body.normalized_query).toBe('reklamacna');
    expect(typeof body.took_ms).toBe('number');
    expect(body.count).toBe(body.results?.length);
    expect(body.count).toBeGreaterThan(0);
    expect(body.limit).toBe(20);
    // A5 (P1): default deadline klesol z 2000 na 300 ms — SQLite blokuje
    // event loop a 300 ms stačí aj na 8-tokenový dotaz
    expect(body.deadline_ms).toBe(300);
    expect(body.partial).toBe(false);
    expect(body.channels).toEqual(['fts5']);
    expect(body.untrusted).toContain('untrusted');
    const first = body.results?.[0];
    expect(Object.keys(first ?? {})).toEqual(
      expect.arrayContaining(['id', 'kind', 'pubkey', 'created_at', 'snippet', 'score']),
    );
  });

  it('snippet obsahuje zvýraznenie a result má addr len pre adresovaný kind', async () => {
    const res = await app.request('/search?q=reklamacna');
    const body = (await res.json()) as SearchBody;
    const snippets = (body.results ?? []).map((r) => String(r['snippet']));
    expect(snippets.some((s) => s.includes('[reklamacna]'))).toBe(true);
    const addressed = await app.request('/search?q=sprievodca');
    const addressedBody = (await addressed.json()) as SearchBody;
    expect(addressedBody.results?.[0]?.['addr']).toBe(`30023:${PK_B}:sprievodca`);
    const plain = (await (await app.request('/search?q=poistka')).json()) as SearchBody;
    expect(plain.results?.[0]?.['addr']).toBeUndefined();
  });

  it('BM25 poradie je súčasťou HTTP odpovede (kratší dokument s rovnakým tf vyhráva)', async () => {
    const res = await app.request('/search?q=reklamacna');
    const body = (await res.json()) as SearchBody;
    const ids = (body.results ?? []).map((r) => String(r['id']));
    // e1 aj e2 obsahujú `reklamacna` raz (e1 cez zrážanie diakritiky
    // „Reklamačná“ → „reklamacna“); e1 je kratší → bm25 ho hodnotí lepšie
    expect(ids).toEqual(['e1'.padEnd(64, '1'), 'e2'.padEnd(64, '2')]);
    const scores = (body.results ?? []).map((r) => Number(r['score']));
    expect(scores.every((s) => s < 0)).toBe(true); // FTS5 rank: lepší = zápornejší
    expect(ids.every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
  });

  it('kinds filter', async () => {
    const all = (await (await app.request('/search?q=reklamacna')).json()) as SearchBody;
    const only = (await (await app.request('/search?q=reklamacna&kinds=1023')).json()) as SearchBody;
    expect((only.results ?? []).map((r) => r['kind'])).toEqual([1023]);
    expect((only.results ?? []).length).toBeLessThan((all.results ?? []).length);
    expect(only.filters).toEqual({ kinds: [1023] });
  });

  // Phase 4a (dizajn Q4): `type=` je čitateľský alias na kindy — agent ani
  // UI si nemusia pamätať, že papier je 30023. Sčíta sa s `kinds=` (union),
  // nikdy nie naopak, a každý výsledok nesie `type`.
  describe('type= alias druhov (Phase 4a)', () => {
    it('type=paper vyberie kind 30023 a každý výsledok nesie `type`', async () => {
      const body = (await (await app.request('/search?q=sprievodca&type=paper')).json()) as SearchBody;
      const results = body.results ?? [];
      expect(results.length).toBeGreaterThan(0);
      expect(results.map((r) => r['kind'])).toEqual([30023]);
      expect(results.map((r) => r['type'])).toEqual(['paper']);
      // `filters` echo vracia EFEKTÍVNY filter: `kinds` už obsahuje
      // preložené `type=`, aby klient videl, čomu server naozaj verí
      expect(body.filters).toEqual({ kinds: [30023], types: ['paper'] });
    });

    it('type= csv vyberie viac druhov a výsledky majú správne mená', async () => {
      const body = (await (await app.request('/search?q=reklamacna&type=question,post')).json()) as SearchBody;
      const kinds = (body.results ?? []).map((r) => r['kind']);
      expect(kinds).toEqual(expect.arrayContaining([1020, 1023]));
      expect(kinds.includes(30023)).toBe(false);
      const typeByKind = new Map(body.results?.map((r) => [r['kind'], r['type']]));
      expect(typeByKind.get(1020)).toBe('question');
      expect(typeByKind.get(1023)).toBe('post');
    });

    it('type= sa SCÍTAVA s kinds= (union, nie prienik) a nerobí duplikáty', async () => {
      // `kinds=1020` samo o sebe tu nenájde NIČ (e3 je 30023) — ak sa
      // výsledok objaví, `type=paper` kind do filteru PRIDAL (union)
      const alone = (await (await app.request('/search?q=sprievodca&kinds=1020')).json()) as SearchBody;
      expect(alone.results ?? []).toEqual([]);

      const body = (await (await app.request('/search?q=sprievodca&kinds=1020&type=paper')).json()) as SearchBody;
      const kinds = (body.results ?? []).map((r) => r['kind']).sort((a, b) => a - b);
      expect(kinds).toEqual([30023]);
      expect(body.filters).toEqual({ kinds: [1020, 30023], types: ['paper'] });

      const dupe = (await (await app.request('/search?q=sprievodca&kinds=30023&type=paper')).json()) as SearchBody;
      expect((dupe.results ?? []).map((r) => r['id'])).toEqual(['e3'.padEnd(64, '3')]);
    });

    it('400 na neznámy druh — odpoveď menuje povolené hodnoty', async () => {
      const res = await app.request('/search?q=reklamacna&type=blog');
      expect(res.status).toBe(400);
      const body = (await res.json()) as SearchBody;
      expect(body.error).toBe('invalid type');
      const reason = String((body.reasons ?? [])[0]);
      for (const name of ['question', 'idea', 'collab', 'post', 'paper', 'topic']) {
        expect(reason).toContain(name);
      }
      // prázdna hodnota = žiadny filter (rovnaká semantika ako `lang=`)
      expect((await app.request('/search?q=reklamacna&type=')).status).toBe(200);
    });

    it('type= funguje aj s ostatnými filtrami (authors, since)', async () => {
      const wrongAuthor = (await (
        await app.request(`/search?q=sprievodca&type=paper&authors=${PK_A}`)
      ).json()) as SearchBody;
      expect(wrongAuthor.results ?? []).toEqual([]); // e3 je od PK_B

      const ok = (await (
        await app.request(`/search?q=sprievodca&type=paper&authors=${PK_B}&since=2000`)
      ).json()) as SearchBody;
      expect((ok.results ?? []).map((r) => r['id'])).toEqual(['e3'.padEnd(64, '3')]);
      expect(ok.filters).toEqual({ kinds: [30023], types: ['paper'], authors: [PK_B], since: 2000 });
    });
  });

  it('authors filter (vrátane csv dvoch pubkey)', async () => {
    const onlyB = (await (
      await app.request(`/search?q=reklamacna&authors=${PK_B}`)
    ).json()) as SearchBody;
    expect((onlyB.results ?? []).every((r) => r['pubkey'] === PK_B)).toBe(true);
    const both = (await (
      await app.request(`/search?q=reklamacna&authors=${PK_A},${PK_B}`)
    ).json()) as SearchBody;
    expect((both.results ?? []).length).toBeGreaterThanOrEqual((onlyB.results ?? []).length);
  });

  it('since/until filter a ich kombinácia s kinds a limitom', async () => {
    const window = (await (
      await app.request('/search?q=reklamacna&since=1000&until=2000')
    ).json()) as SearchBody;
    // poradie robí bm25 (e1 kratší), created_at rozhoduje len pri zhode ranku
    expect((window.results ?? []).map((r) => r['created_at'])).toEqual([1_000, 2_000]);
    const outside = (await (
      await app.request('/search?q=reklamacna&since=2500')
    ).json()) as SearchBody;
    expect(outside.results ?? []).toEqual([]);
    const combo = (await (
      await app.request(`/search?q=reklamacna&kinds=1020,1023&authors=${PK_A}&since=500&limit=1`)
    ).json()) as SearchBody;
    expect(combo.results ?? []).toHaveLength(1);
    expect(combo.filters).toEqual({ kinds: [1020, 1023], authors: [PK_A], since: 500 });
  });

  it('limit omedzuje výsledky a default je 20', async () => {
    const one = (await (await app.request('/search?q=reklamacna&limit=1')).json()) as SearchBody;
    expect(one.results ?? []).toHaveLength(1);
    expect(one.limit).toBe(1);
    const many = (await (await app.request('/search?q=reklamacna')).json()) as SearchBody;
    expect(many.limit).toBe(20);
  });

  it('dotaz s FTS5 syntaxou nepadá (normalizácia pred MATCH)', async () => {
    for (const qs of ['?q=NEAR%20%2F%203', '?q=%22', '?q=x:y:z', '?q=%28%28%28%28']) {
      const res = await app.request(`/search${qs}`);
      expect(res.status, qs).toBe(200);
    }
  });

  it('diakritika: `reklamacna` nájde `Reklamačná`', async () => {
    const res = await app.request('/search?q=reklamacna');
    const body = (await res.json()) as SearchBody;
    expect((body.results ?? []).length).toBeGreaterThan(0);
  });
});

describe('GET /search — deadline a partial', () => {
  it('prerušený dopyt → 200 s partial:true a poznámkou (nie 500)', async () => {
    const slow = slowChannel('fts5', [hit('x1')], 25);
    const timed = buildApp([slow], { deadlineMs: 1 });
    // slow kanál nedokáže prerušiť SQL, ale route ho stihne odmerať:
    // took_ms > deadline → partial
    const res = await timed.request('/search?q=x');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.partial).toBe(true);
    expect(body.note).toContain('deadline');
    expect(body.count).toBe(1);
  });

  it('FTS5 dopyt s deadline v minulosti → partial:true a count 0', async () => {
    const timed = buildApp([channel, createVectorStubChannel()], {
      index: channel,
      deadlineMs: 0,
    });
    const res = await timed.request('/search?q=reklamacna');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.partial).toBe(true);
    expect(body.count).toBe(0);
    expect(body.results).toEqual([]);
    expect(body.note).toContain('interrupted');
  });

  it('štandardný dopyt v within-deadline má partial:false a note žiadne', async () => {
    const res = await app.request('/search?q=reklamacna');
    const body = (await res.json()) as SearchBody;
    expect(body.partial).toBe(false);
    expect(body.note).toBeUndefined();
    expect((body.took_ms ?? 0)).toBeLessThan(2000);
  });
});

describe('GET /search — hybridná fúzia (RRF)', () => {
  it('dva kanály s výsledkami → channels obsahuje rrf a fúzia spojí kandidátov', async () => {
    const fts = fakeChannel('fts5', [hit('a1'), hit('a2')]);
    const vec = fakeChannel('vector', [hit('a2', { score: 0.9 }), hit('a3', { score: 0.8 })]);
    const fused = buildApp([fts, vec]);
    const res = await fused.request('/search?q=x');
    const body = (await res.json()) as SearchBody;
    expect(body.channels).toEqual(['rrf', 'fts5', 'vector']);
    expect((body.results ?? []).map((r) => r['id'])).toEqual(['a2', 'a1', 'a3']);
    expect(body.count).toBe(3);
    // RRF skóre je kladné a klesajúce
    const scores = (body.results ?? []).map((r) => Number(r['score']));
    expect(scores.every((s) => s > 0)).toBe(true);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i] ?? 0).toBeLessThanOrEqual(scores[i - 1] ?? 0);
    }
  });

  it('len jeden kanál má výsledky → passthrough bez rrf', async () => {
    const fts = fakeChannel('fts5', [hit('b1'), hit('b2')]);
    const single = buildApp([fts, createVectorStubChannel()]);
    const res = await single.request('/search?q=x');
    const body = (await res.json()) as SearchBody;
    expect(body.channels).toEqual(['fts5']);
    expect((body.results ?? []).map((r) => r['id'])).toEqual(['b1', 'b2']);
  });

  it('žiadny kanál nemá výsledky → 200 z prázdnym poľom (nie 503)', async () => {
    const empty = buildApp([
      fakeChannel('fts5', []),
      createVectorStubChannel(),
    ]);
    const res = await empty.request('/search?q=nic');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.count).toBe(0);
    expect(body.results).toEqual([]);
    expect(body.channels).toEqual([]);
  });

  it('RRF rešpektuje limit', async () => {
    const fts = fakeChannel('fts5', [hit('c1'), hit('c2'), hit('c3')]);
    const vec = fakeChannel('vector', [hit('c3'), hit('c4'), hit('c5')]);
    const fused = buildApp([fts, vec]);
    const res = await fused.request('/search?q=x&limit=2');
    const body = (await res.json()) as SearchBody;
    expect(body.results ?? []).toHaveLength(2);
    expect(body.count).toBe(2);
  });
});

describe('buildGateway — zárez konfigurácie searchu', () => {
  let runtime: GatewayRuntime | null = null;

  afterAll(() => {
    runtime?.search?.close();
    runtime?.pool.close();
    runtime = null;
  });

  it('bez GATEWAY_INDEX_DB → /search 503 a /health povie prečo', async () => {
    const built = buildGateway(
      { GATEWAY_QUIET: '1' },
      { disableWebsocket: true, disableReadRoutes: true, indexDb: null },
    );
    const res = await built.app.request('/search?q=reklamacna');
    expect(res.status).toBe(503);
    const body = (await res.json()) as SearchBody;
    expect(body.error).toBe('index unavailable');

    const health = (await (await built.app.request('/health')).json()) as {
      index?: { available: boolean; reason?: string };
    };
    expect(health.index?.available).toBe(false);
    expect(health.index?.reason).toContain('503');
    built.pool.close();
  });

  it('s GATEWAY_INDEX_DB → /search 200 a /health hlási dostupný index', async () => {
    runtime = buildGateway(
      { GATEWAY_QUIET: '1', GATEWAY_INDEX_DB: dbPath, GATEWAY_SEARCH_DEADLINE_MS: '1500' },
      { disableWebsocket: true, disableReadRoutes: true },
    );
    expect(runtime.search?.path).toBe(dbPath);
    const res = await runtime.app.request('/search?q=reklamacna&limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.deadline_ms).toBe(1500);
    expect((body.results ?? []).length).toBeGreaterThan(0);

    const health = (await (await runtime.app.request('/health')).json()) as {
      index?: { available: boolean; path: string };
    };
    expect(health.index?.available).toBe(true);
    expect(health.index?.path).toBe(dbPath);
  });

  it('DB sa otvára len read-only — gateway nezapisuje do indexu', async () => {
    const before = new Database(dbPath);
    const countBefore = (
      before.prepare('SELECT count(*) AS n FROM events').get() as { n: number }
    ).n;
    before.close();
    await runtime?.app.request('/search?q=reklamacna');
    const after = new Database(dbPath);
    const countAfter = (after.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;
    after.close();
    expect(countAfter).toBe(countBefore);
  });
});

/**
 * F4AI-2b2: parameter `lang=` na `GET /search` — normalizácia, `any`,
 * 400 pri neznámom kóde, echo v `filters` a prenos `lang` do výsledkov.
 */
describe('GET /search — lang parameter (F4AI-2b2)', () => {
  /** kanál, ktorý si pamätá opts: route MUSÍ poslať normalizovaný kód */
  function recording(hits: RankedHit[]): { channel: SearchChannel; calls: SearchQueryOptions[] } {
    const calls: SearchQueryOptions[] = [];
    return {
      calls,
      channel: {
        name: 'recording',
        search: (_query, opts) => {
          calls.push(opts);
          return hits;
        },
      },
    };
  }

  it('lang=en sa posiela kanálu a echo v filters; výsledok nesie lang', async () => {
    const rec = recording([hit('a'.repeat(64), { lang: 'en' }), hit('b'.repeat(64), { lang: null })]);
    const app = buildApp([rec.channel]);
    const res = await app.request('/search?q=x&lang=en');
    expect(res.status).toBe(200);
    expect(rec.calls[0]?.lang).toBe('en');
    const body = (await res.json()) as SearchBody & { filters?: Record<string, unknown> };
    expect(body.filters?.['lang']).toBe('en');
    const results = (body['results'] ?? []) as Array<Record<string, unknown>>;
    expect(results[0]?.['lang']).toBe('en');
    expect(results[1]?.['lang']).toBeNull();
  });

  it('lang=any aj vynechaný parameter = žiadny filter (a žiadne filters.lang)', async () => {
    const rec = recording([hit('a'.repeat(64))]);
    const app = buildApp([rec.channel]);
    for (const url of ['/search?q=x&lang=any', '/search?q=x', '/search?q=x&lang=']) {
      const res = await app.request(url);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SearchBody & { filters?: Record<string, unknown> };
      expect(body.filters?.['lang']).toBeUndefined();
    }
    expect(rec.calls.every((call) => call.lang === undefined)).toBe(true);
    // kanál bez `lang` v hite → výsledok pole `lang` neobsahuje vôbec
    const res = await app.request('/search?q=x&lang=any');
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(Object.prototype.hasOwnProperty.call(body.results[0] ?? {}, 'lang')).toBe(false);
  });

  it('VEĽKÉ písmeno sa normalizuje (lang=EN → en)', async () => {
    const rec = recording([]);
    const app = buildApp([rec.channel]);
    const res = await app.request('/search?q=x&lang=EN');
    expect(res.status).toBe(200);
    expect(rec.calls[0]?.lang).toBe('en');
  });

  it('neznámy kód → 400 s dôvodom (nie tichá prázdna odpoveď)', async () => {
    const rec = recording([]);
    const app = buildApp([rec.channel]);
    for (const bad of ['xx', 'english', 'en-US', '1']) {
      const res = await app.request(`/search?q=x&lang=${bad}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string; reasons?: string[] };
      expect(body.error).toBe('invalid lang');
      expect(body.reasons?.join(' ')).toContain('ISO-639-1');
    }
    expect(rec.calls).toHaveLength(0);
  });
});
