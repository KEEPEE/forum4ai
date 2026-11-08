/**
 * Testy `GET /search?origin=` a `origin`/`trusted` polí (Phase 6a, dizajn Q5).
 *
 * Testuje SA TU:
 *  1. filter `origin=self|<id>|any` a to, že VYNECHANÝ parameter znamená
 *     `any` (dizajn Q5: `B /search?q=<uuid>` musí nájsť cudzie vlákno bez
 *     ďalších parametrov),
 *  2. KAŽDÝ výsledok nesie `origin` + `trusted` (UI z prvého kreslí čip
 *     „from …", druhé je príznak cudzieho autora),
 *  3. kompozibilita s `lang=` a `type=` (žiadny filter nesmie druhý zrušiť),
 *  4. neznáma hodnota → **400 so zoznamom povolených id** (nie tichá
 *     prázdna odpoveď — preklep v id by vyzeral ako „inštancia je prázdna"),
 *  5. id známe LEN z indexu je povolené (inštancia kŕmená `strfry router`
 *     stream-down, ktorá sama nič nepulluje),
 *  6. index PRED 6a (bez stĺpcov) → polia sa vo výsledkoch NEOBJAVIA vôbec
 *     (aditívne pole, ktoré tvrdí `origin: 'self'`, by bolo klamstvo) a
 *     `origin=self` sa ticho ignoruje namiesto 500 z `no such column`.
 *
 * DDL je kópia schémy indexera vrátane `origin`/`trusted` (pravdivosť
 * strážia integračné testy indexera); `originsRefreshMs: 0` aby test
 * nevidel starý cache DISTINCT množiny.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Fts5SearchChannel, type SearchChannel } from '../src/search.js';
import { registerSearchRoutes } from '../src/search-routes.js';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
/** id upstreamov v tvaru zo dizajnu Q5 (host gateway URL s portom / bez) */
const ORIGIN_DEV = '127.0.0.1:18081';
const ORIGIN_PROD = 'aiforum.myhood.sk';

/** 6a schéma indexera (`origin` + `trusted` + `lang`) */
const INDEX_SCHEMA_6A = `
CREATE TABLE events (
  id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL,
  tags_text TEXT NOT NULL DEFAULT '', sig TEXT NOT NULL, addr TEXT NULL,
  inserted_at INTEGER NOT NULL, lang TEXT NULL,
  origin TEXT NOT NULL DEFAULT 'self', trusted INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX events_addr ON events (addr);
CREATE INDEX events_origin ON events (origin);
CREATE VIRTUAL TABLE events_fts USING fts5(
  content, tags_text, content = 'events', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, content, tags_text)
  VALUES (new.rowid, new.content, new.tags_text);
END;
`;

/** pred-6a schéma (bez `origin`/`trusted`) — platný stav, nie chyba */
const INDEX_SCHEMA_PRE_6A = `
CREATE TABLE events (
  id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL,
  tags_text TEXT NOT NULL DEFAULT '', sig TEXT NOT NULL, addr TEXT NULL,
  inserted_at INTEGER NOT NULL, lang TEXT NULL
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

interface SeedRow {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  addr: string | null;
  lang: string | null;
  origin: string;
  trusted: number;
}

/** štyri riadky: domáce vlákno + domáci papier + cudzie vlákno + cudzí papier */
const ROWS: SeedRow[] = [
  {
    id: 'e1'.padEnd(64, '1'),
    pubkey: PK_A,
    kind: 1023,
    created_at: 1_000,
    content: 'federation canary — domace vlakno tejto inštancie',
    addr: null,
    lang: 'sk',
    origin: 'self',
    trusted: 1,
  },
  {
    id: 'e2'.padEnd(64, '2'),
    pubkey: PK_A,
    kind: 30023,
    created_at: 2_000,
    content: 'federation canary — domaci papier',
    addr: `30023:${PK_A}:domaci`,
    lang: 'en',
    origin: 'self',
    trusted: 1,
  },
  {
    id: 'e3'.padEnd(64, '3'),
    pubkey: PK_B,
    kind: 1023,
    created_at: 3_000,
    content: 'federation canary — vlakno z aiforum.myhood.sk',
    addr: null,
    lang: 'sk',
    origin: ORIGIN_PROD,
    trusted: 0,
  },
  {
    id: 'e4'.padEnd(64, '4'),
    pubkey: PK_B,
    kind: 30023,
    created_at: 4_000,
    content: 'federation canary — papier z aiforum.myhood.sk',
    addr: `30023:${PK_B}:cudzi`,
    lang: 'en',
    origin: ORIGIN_PROD,
    trusted: 0,
  },
];

function seed(path: string, schema: string, withOriginColumns: boolean): void {
  const writer = new Database(path);
  writer.pragma('journal_mode = WAL');
  writer.exec(schema);
  const insert = withOriginColumns
    ? writer.prepare(
        `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang, origin, trusted)
         VALUES (?, ?, ?, ?, ?, '[]', '', 'sig', ?, 0, ?, ?, ?)`,
      )
    : writer.prepare(
        `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang)
         VALUES (?, ?, ?, ?, ?, '[]', '', 'sig', ?, 0, ?)`,
      );
  for (const row of ROWS) {
    if (withOriginColumns) {
      insert.run(row.id, row.pubkey, row.kind, row.created_at, row.content, row.addr, row.lang, row.origin, row.trusted);
    } else {
      insert.run(row.id, row.pubkey, row.kind, row.created_at, row.content, row.addr, row.lang);
    }
  }
  writer.close();
}

const dir = mkdtempSync(join(tmpdir(), 'f4ai-gw-fed-search-'));
const db6a = join(dir, 'index-6a.db');
const dbPre = join(dir, 'index-pre.db');

type ResultRow = Record<string, unknown>;
type SearchBody = {
  ok?: boolean;
  error?: string;
  reasons?: string[];
  count?: number;
  results?: ResultRow[];
  filters?: Record<string, unknown>;
  channels?: string[];
};

/**
 * Ručná Hono app (bez relay poolu) — presne tá istá wiring ako
 * `buildGateway`, len s kontrolovaným `knownOrigins`.
 */
function buildApp(
  index: Fts5SearchChannel,
  knownOrigins?: () => string[],
): { app: Hono; index: Fts5SearchChannel } {
  const app = new Hono();
  const channels: SearchChannel[] = [index];
  registerSearchRoutes(app, {
    channels,
    index,
    logger: () => undefined,
    ...(knownOrigins !== undefined ? { knownOrigins } : {}),
  });
  return { app, index };
}

function channel(path: string): Fts5SearchChannel {
  return new Fts5SearchChannel({ path, originsRefreshMs: 0, logger: () => undefined });
}

async function search(app: Hono, query: string): Promise<{ status: number; body: SearchBody }> {
  const res = await app.request(`http://localhost/search?${query}`);
  return { status: res.status, body: (await res.json()) as SearchBody };
}

const idsOf = (body: SearchBody): string[] => (body.results ?? []).map((row) => String(row['id']));
/** poradie v výsledkoch robí BM25, nie test — porovnávame množinu id */
const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const idsSorted = (body: SearchBody): string[] => sorted(idsOf(body));

beforeAll(() => {
  seed(db6a, INDEX_SCHEMA_6A, true);
  seed(dbPre, INDEX_SCHEMA_PRE_6A, false);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /search?origin= — filter pôvodu (dizajn Q5)', () => {
  it('bez parametra a `any` vrátia všetky zdroje (default NIE je self)', async () => {
    const { app } = buildApp(channel(db6a), () => [ORIGIN_PROD]);
    const omitted = await search(app, 'q=federation');
    expect(omitted.status).toBe(200);
    expect(omitted.body.count).toBe(4);
    // dizajn Q5 (E2E krok 5): cudzie vlákno musí byť v výsledku bez parametra
    expect(idsOf(omitted.body)).toContain('e3'.padEnd(64, '3'));

    const any = await search(app, 'q=federation&origin=any');
    expect(any.status).toBe(200);
    expect(idsOf(any.body)).toEqual(idsOf(omitted.body));
    // `any` je to isté ako vynechať → v `filters` sa neobjaví
    expect(any.body.filters ?? {}).not.toHaveProperty('origin');
    expect(omitted.body.filters ?? {}).not.toHaveProperty('origin');
  });

  it('origin=self vráti len domáci obsah a echo v filters', async () => {
    const { app } = buildApp(channel(db6a), () => [ORIGIN_PROD]);
    const res = await search(app, 'q=federation&origin=self');
    expect(res.status).toBe(200);
    expect(idsSorted(res.body)).toEqual(sorted(['e1'.padEnd(64, '1'), 'e2'.padEnd(64, '2')]));
    expect(res.body.filters?.['origin']).toBe('self');
  });

  it('origin=<id> vráti len obsah tej ktorej inštancie', async () => {
    const { app } = buildApp(channel(db6a), () => [ORIGIN_PROD, ORIGIN_DEV]);
    const remote = await search(app, `q=federation&origin=${encodeURIComponent(ORIGIN_PROD)}`);
    expect(remote.status).toBe(200);
    expect(idsSorted(remote.body)).toEqual(sorted(['e3'.padEnd(64, '3'), 'e4'.padEnd(64, '4')]));
    expect(remote.body.filters?.['origin']).toBe(ORIGIN_PROD);

    // id, ktoré konfigurácia pozná ale index ho neobsahuje → 200 a prázdne
    const dev = await search(app, `q=federation&origin=${encodeURIComponent(ORIGIN_DEV)}`);
    expect(dev.status).toBe(200);
    expect(dev.body.results).toEqual([]);
  });

  it('každý výsledok nesie origin + trusted (UI čip a cudzí autor)', async () => {
    const { app } = buildApp(channel(db6a), () => [ORIGIN_PROD]);
    const res = await search(app, 'q=federation');
    const byId = new Map((res.body.results ?? []).map((row) => [String(row['id']), row]));
    expect(byId.get('e1'.padEnd(64, '1'))).toMatchObject({ origin: 'self', trusted: true });
    expect(byId.get('e2'.padEnd(64, '2'))).toMatchObject({ origin: 'self', trusted: true });
    expect(byId.get('e3'.padEnd(64, '3'))).toMatchObject({ origin: ORIGIN_PROD, trusted: false });
    expect(byId.get('e4'.padEnd(64, '4'))).toMatchObject({ origin: ORIGIN_PROD, trusted: false });
  });

  it('je kombinovateľné s lang= a type= (žiadny filter druhý nezruší)', async () => {
    const { app } = buildApp(channel(db6a), () => [ORIGIN_PROD]);

    const remotePapers = await search(
      app,
      `q=federation&origin=${encodeURIComponent(ORIGIN_PROD)}&type=paper`,
    );
    expect(remotePapers.status).toBe(200);
    expect(idsOf(remotePapers.body)).toEqual(['e4'.padEnd(64, '4')]);
    expect(remotePapers.body.results?.[0]).toMatchObject({ type: 'paper', origin: ORIGIN_PROD });
    expect(remotePapers.body.filters).toEqual({
      kinds: [30023],
      types: ['paper'],
      origin: ORIGIN_PROD,
    });

    const localSk = await search(app, 'q=federation&origin=self&lang=sk');
    expect(idsOf(localSk.body)).toEqual(['e1'.padEnd(64, '1')]);

    const remoteSk = await search(app, `q=federation&origin=${encodeURIComponent(ORIGIN_PROD)}&lang=sk`);
    expect(idsOf(remoteSk.body)).toEqual(['e3'.padEnd(64, '3')]);

    const kindsAndOrigin = await search(app, 'q=federation&origin=self&kinds=30023');
    expect(idsOf(kindsAndOrigin.body)).toEqual(['e2'.padEnd(64, '2')]);
  });

  it('neznáme id → 400 so zoznamom povolených hodnôt', async () => {
    const { app } = buildApp(channel(db6a), () => [ORIGIN_PROD, ORIGIN_DEV]);
    const res = await search(app, 'q=federation&origin=aiforum.myhod.sk');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid origin');
    const reason = res.body.reasons?.[0] ?? '';
    expect(reason).toContain("'self'");
    expect(reason).toContain("'any'");
    expect(reason).toContain(ORIGIN_PROD);
    expect(reason).toContain(ORIGIN_DEV);
    expect(reason).toContain('aiforum.myhod.sk');
  });

  it('bez knownOrigins sú povolené len self a any (single-instance inštancia)', async () => {
    const { app } = buildApp(channel(db6a));
    expect((await search(app, 'q=federation&origin=self')).status).toBe(200);
    expect((await search(app, 'q=federation&origin=any')).status).toBe(200);
    const unknown = await search(app, `q=federation&origin=${encodeURIComponent(ORIGIN_PROD)}`);
    expect(unknown.status).toBe(400);
    expect(unknown.body.reasons?.[0]).toContain('none — no upstreams configured');
  });

  it('id známe LEN z indexu je povolené (router-fed inštancia bez upstreamu)', async () => {
    const index = channel(db6a);
    // `buildGateway` dáva dohromady id upstreamov AJ `index.origins()` —
    // tu je len origins(), lebo táto inštancia sama nič nepulluje
    const { app } = buildApp(index, () => index.origins());
    expect(index.origins()).toEqual([ORIGIN_PROD]);
    const res = await search(app, `q=federation&origin=${encodeURIComponent(ORIGIN_PROD)}`);
    expect(res.status).toBe(200);
    expect(idsSorted(res.body)).toEqual(sorted(['e3'.padEnd(64, '3'), 'e4'.padEnd(64, '4')]));
  });

  it('veľkosť písmen a medzery v hodnote neublížia (id sa normalizuje)', async () => {
    const { app } = buildApp(channel(db6a), () => [ORIGIN_PROD]);
    const res = await search(app, `q=federation&origin=${encodeURIComponent(` ${ORIGIN_PROD.toUpperCase()} `)}`);
    expect(res.status).toBe(200);
    expect(idsSorted(res.body)).toEqual(sorted(['e3'.padEnd(64, '3'), 'e4'.padEnd(64, '4')]));
  });
});

describe('index pred 6a (bez origin/trusted stĺpcov) — aditívnosť', () => {
  it('výsledky polia neobsahujú vôbec (prítomnosť = signát podpory)', async () => {
    const { app } = buildApp(channel(dbPre), () => []);
    const res = await search(app, 'q=federation');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(4);
    for (const row of res.body.results ?? []) {
      expect(row).not.toHaveProperty('origin');
      expect(row).not.toHaveProperty('trusted');
    }
  });

  it('origin=self sa ticho ignoruje (žiadne 500 z `no such column`)', async () => {
    const { app } = buildApp(channel(dbPre), () => []);
    const res = await search(app, 'q=federation&origin=self');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(4);
  });

  it('cudzie id na pred-6a indexe je 400, nie prázdny výsledok', async () => {
    const { app } = buildApp(channel(dbPre), () => []);
    const res = await search(app, `q=federation&origin=${encodeURIComponent(ORIGIN_PROD)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid origin');
  });

  it('origins() je na pred-6a indexe prázdne a `self` sa do zoznamu nedostane', () => {
    const index = channel(dbPre);
    expect(index.origins()).toEqual([]);
    const sixA = channel(db6a);
    expect(sixA.origins()).not.toContain('self');
  });
});

describe('origins() cache', () => {
  it('s TTL cache sa nová hodnota javí až po vypršaní, s TTL 0 ihneď', () => {
    const path = join(dir, 'cache.db');
    seed(path, INDEX_SCHEMA_6A, true);
    const cached = new Fts5SearchChannel({ path, logger: () => undefined });
    expect(cached.origins()).toEqual([ORIGIN_PROD]);

    const writer = new Database(path);
    writer
      .prepare(
        `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang, origin, trusted)
         VALUES (?, ?, 1023, 5000, 'federation cache row', '[]', '', 'sig', NULL, 0, 'sk', ?, 0)`,
      )
      .run('e5'.padEnd(64, '5'), PK_B, ORIGIN_DEV);
    writer.close();

    // cache drží (default 30 s) — volanie je lacné a stabilné
    expect(cached.origins()).toEqual([ORIGIN_PROD]);
    // TTL 0 = bez cache: test a operátor vidia aktuálny stav hneď
    const fresh = new Fts5SearchChannel({ path, originsRefreshMs: 0, logger: () => undefined });
    expect(fresh.origins()).toEqual([ORIGIN_DEV, ORIGIN_PROD].sort());
  });
});
