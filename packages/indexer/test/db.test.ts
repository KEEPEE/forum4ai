/**
 * Unit testy DB vrstvy indexera (F4AI-13, S7) — bez siete.
 *
 * Pokrývajú: dedup regular kindov, LWW per adresa (replaceable 10030/10031,
 * addressable 30020, NIP-01 0/3), tie-break nižšie id, FTS5 dotazy vrátane
 * DIAKRITIKY (merané správanie `unicode61` + kontrast s
 * `remove_diacritics 0`), prefixové hľadanie, absencia stemingu, indexy
 * (EXPLAIN QUERY PLAN), konzistenciu FTS5 triggerov po LWW sekvencii a
 * perzistenciu po reopen.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

import {
  IndexerDb,
  addressFor,
  buildMatchQuery,
  openIndexerDb,
  tagsTextFromJson,
  tagsToText,
} from '../src/db.js';

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const BASE = 1_700_000_000;

function mk(
  kind: number,
  created_at: number,
  tags: string[][],
  content: string,
  secret: Uint8Array = sk,
): NostrEvent {
  return finalizeEvent({ kind, created_at, tags, content }, secret) as NostrEvent;
}

/** Event s ľubovoľným id/pubkey — DB vrstva podpis neoveruje. */
function raw(id: string, kind: number, created_at: number, content = '', tags: string[][] = []): NostrEvent {
  return { id, pubkey: pk, created_at, kind, tags, content, sig: 'sig' };
}

describe('indexer db — schéma a LWW semantika', () => {
  let db: IndexerDb;

  beforeAll(() => {
    db = openIndexerDb(':memory:');
  });

  it('vytvorí tabuľku, indexy a FTS5 tabuľku', () => {
    const objects = db.db
      .prepare("SELECT name, type FROM sqlite_master WHERE tbl_name IN ('events','events_fts') ORDER BY name")
      .all() as Array<{ name: string; type: string }>;
    const names = objects.map((o) => o.name);
    expect(names).toContain('events');
    expect(names).toContain('events_addr');
    expect(names).toContain('events_kind');
    expect(names).toContain('events_pubkey');
    expect(names).toContain('events_created_at');
    expect(names).toContain('events_fts');
    expect(names.filter((n) => n.startsWith('events_fts_ai'))).toHaveLength(1);
    expect(objects.some((o) => o.type === 'trigger')).toBe(true);
  });

  it('regular kindy: dedup per id (INSERT OR IGNORE)', () => {
    const local = openIndexerDb(':memory:');
    try {
      const post = mk(KINDS.POST, BASE + 10, [['e', 'a'.repeat(64), 'root']], 'prvy post');
      expect(local.upsertEvent(post)).toBe('inserted');
      expect(local.upsertEvent(post)).toBe('ignored');
      expect(local.count()).toBe(1);
      // druhy event toho isteho kindu sa uloži
      const post2 = mk(KINDS.POST, BASE + 11, [['e', 'b'.repeat(64), 'root']], 'druhy post');
      expect(local.upsertEvent(post2)).toBe('inserted');
      expect(local.count()).toBe(2);
    } finally {
      local.close();
    }
  });

  it('replaceable 10030: LWW per author, novší created_at vyhráva', () => {
    const local = openIndexerDb(':memory:');
    try {
      const v1 = mk(KINDS.IDEA_CALL_STATUS, BASE + 100, [['d', 'status']], 'verzia jedna');
      const v2 = mk(KINDS.IDEA_CALL_STATUS, BASE + 200, [['d', 'status']], 'verzia dva');
      const starsi = mk(KINDS.IDEA_CALL_STATUS, BASE + 150, [['d', 'status']], 'starsi text');
      expect(local.upsertEvent(v1)).toBe('inserted');
      expect(local.upsertEvent(v2)).toBe('replaced');
      expect(local.upsertEvent(starsi)).toBe('ignored');
      const row = local.getEvent(v2.id);
      expect(row?.content).toBe('verzia dva');
      expect(local.idsOfKind(KINDS.IDEA_CALL_STATUS)).toEqual([v2.id]);
      expect(local.count()).toBe(1);
    } finally {
      local.close();
    }
  });

  it('LWW tie-break: pri rovnakom created_at vyhráva nižšie id', () => {
    const a = raw('a'.repeat(64), KINDS.FOLLOWS, BASE + 500, 'follows A', [['d', 'follows']]);
    const b = raw('f'.repeat(64), KINDS.FOLLOWS, BASE + 500, 'follows B', [['d', 'follows']]);
    const lowerId = a.id < b.id ? a : b;
    const higherId = a.id < b.id ? b : a;
    const local = openIndexerDb(':memory:');
    try {
      // vyssie id prv, potom nizsie — nizsie musi nahradit
      expect(local.upsertEvent(higherId)).toBe('inserted');
      expect(local.upsertEvent(lowerId)).toBe('replaced');
      expect(local.upsertEvent(higherId)).toBe('ignored');
      expect(local.idsOfKind(KINDS.FOLLOWS)).toEqual([lowerId.id]);
      expect(local.getEvent(lowerId.id)?.content).toBe(lowerId.content);
    } finally {
      local.close();
    }
  });

  it('addressable 30020: jedna riadka na adresu kind:pubkey:d', () => {
    const local = openIndexerDb(':memory:');
    try {
      const t1 = mk(KINDS.TOPIC, BASE + 10, [['d', 'slovensko']], 'topic slovensko');
      const t1b = mk(KINDS.TOPIC, BASE + 20, [['d', 'slovensko']], 'topic slovensko v2');
      const t2 = mk(KINDS.TOPIC, BASE + 15, [['d', 'cesko']], 'topic cesko');
      expect(local.upsertEvent(t1)).toBe('inserted');
      expect(local.upsertEvent(t1b)).toBe('replaced');
      expect(local.upsertEvent(t2)).toBe('inserted');
      expect(local.count()).toBe(2);
      expect(local.stats().replaceable_rows).toBe(2);
      expect(addressFor(t1)).toBe(`30020:${pk}:slovensko`);
      expect(local.getEvent(t1b.id)?.content).toBe('topic slovensko v2');
      expect(local.getEvent(t2.id)?.content).toBe('topic cesko');
    } finally {
      local.close();
    }
  });

  it('NIP-01 replaceable kindy 0 a 3 maju adresu kind:pubkey:', () => {
    expect(addressFor(raw('a'.repeat(64), 0, BASE, '', []))).toBe(`0:${pk}:`);
    expect(addressFor(raw('a'.repeat(64), 3, BASE, '', [])).startsWith(`3:${pk}:`)).toBe(true);
    expect(addressFor(raw('a'.repeat(64), KINDS.POST, BASE, '', []))).toBeNull();
    expect(addressFor(raw('a'.repeat(64), 27235, BASE, '', []))).toBeNull();
    const local = openIndexerDb(':memory:');
    try {
      const p1 = mk(0, BASE + 10, [], '{"name":"stary"}');
      const p2 = mk(0, BASE + 30, [], '{"name":"novy"}');
      expect(local.upsertEvent(p1)).toBe('inserted');
      expect(local.upsertEvent(p2)).toBe('replaced');
      expect(local.count()).toBe(1);
      expect(local.getEvent(p2.id)?.content).toBe('{"name":"novy"}');
    } finally {
      local.close();
    }
  });

  it('upsertMany beží v transakcii a vráti počty', () => {
    const local = openIndexerDb(':memory:');
    try {
      const events = [
        mk(KINDS.QUESTION, BASE + 1, [['a', `30020:${pk}:t`]], 'otazka 1'),
        mk(KINDS.QUESTION, BASE + 2, [['a', `30020:${pk}:t`]], 'otazka 2'),
        mk(KINDS.POST, BASE + 3, [['e', 'c'.repeat(64), 'root']], 'odpoved'),
      ];
      expect(local.upsertMany(events)).toEqual({ inserted: 3, replaced: 0, ignored: 0 });
      expect(local.upsertMany(events)).toEqual({ inserted: 0, replaced: 0, ignored: 3 });
      expect(local.count()).toBe(3);
    } finally {
      local.close();
    }
  });

  it('indexy sa pri dotazoch skutočne používajú', () => {
    const plans = [
      db.queryPlan('SELECT id FROM events WHERE kind = ?', KINDS.POST),
      db.queryPlan('SELECT id FROM events WHERE pubkey = ?', pk),
      db.queryPlan('SELECT id FROM events WHERE created_at >= ?', BASE),
      db.queryPlan('SELECT id FROM events WHERE addr = ?', `30020:${pk}:x`),
    ];
    for (const [i, plan] of plans.entries()) {
      expect(plan.join(' '), `dotaz ${String(i)}`).toMatch(/USING (INDEX|COVERING INDEX)|USING ROWID SEARCH/);
    }
  });

  it('recentIds vracia posledné zápisy a maxCreatedAt sedí', () => {
    const local = openIndexerDb(':memory:');
    try {
      const e1 = mk(KINDS.POST, BASE + 100, [['e', 'd'.repeat(64), 'root']], 'prvy');
      const e2 = mk(KINDS.POST, BASE + 200, [['e', 'e'.repeat(64), 'root']], 'druhy');
      local.upsertEvent(e1, { insertedAt: 10 });
      local.upsertEvent(e2, { insertedAt: 20 });
      expect(local.recentIds(1)).toEqual([e2.id]);
      expect(local.recentIds(5)).toEqual([e2.id, e1.id]);
      expect(local.maxCreatedAt()).toBe(BASE + 200);
    } finally {
      local.close();
    }
  });

  // regression B1: ridok s created_at ďaleko v budúcnosti (junk z relaya)
  // nesmie ukotviť anti-entropický since-sweep nad všetkým skutočným obsahom
  it('maxCreatedAt s hornou hranicou ignoruje buduce created_at (B1)', () => {
    const local = openIndexerDb(':memory:');
    try {
      const real = mk(KINDS.POST, BASE + 100, [['e', 'd'.repeat(64), 'root']], 'realny');
      const junk = mk(KINDS.POST, 4_294_967_295, [['e', 'e'.repeat(64), 'root']], 'junk');
      local.upsertEvent(real, { insertedAt: 10 });
      local.upsertEvent(junk, { insertedAt: 20 });
      // bez hranice: junk vyhrava (presne to, co sposobilo bug)
      expect(local.maxCreatedAt()).toBe(4_294_967_295);
      // s hranicou now+slack: ukotvenie ide za realnym obsahom
      expect(local.maxCreatedAt(BASE + 1000)).toBe(BASE + 100);
    } finally {
      local.close();
    }
  });
});

describe('indexer db — FTS5 vrátane diakritiky', () => {
  let db: IndexerDb;

  beforeAll(() => {
    db = openIndexerDb(':memory:');
    db.upsertMany([
      mk(KINDS.QUESTION, BASE + 1, [['t', 'databazy'], ['d', 'sqlite-fts5']], 'pridana reklamacia ziadost o ucet v databaze'),
      mk(KINDS.POST, BASE + 2, [['e', 'f'.repeat(64), 'root']], 'diskusia o kvantovej fyzike a indexoch'),
      mk(KINDS.IDEA_CALL, BASE + 3, [['t', 'pocitac'], ['d', 'lww']], 'navrh: LWW semantika v SQLite'),
    ]);
  });

  it('nájdi content aj hodnoty tagov (slug, hashtag)', () => {
    expect(db.search('reklamacia').map((h) => h.kind)).toEqual([KINDS.QUESTION]);
    expect(db.search('kvantovej').map((h) => h.kind)).toEqual([KINDS.POST]);
    // tag hodnoty su vyskytovatelne: d-slug aj t-hashtag
    expect(db.search('sqlite-fts5').map((h) => h.kind)).toEqual([KINDS.QUESTION]);
    expect(db.search('databazy').map((h) => h.kind)).toEqual([KINDS.QUESTION]);
    expect(db.search('pocitac').map((h) => h.kind)).toEqual([KINDS.IDEA_CALL]);
  });

  it('DIAKRITIKA: default unicode61 v SQLite 3.53 stripne diakritiku — náš pin to zaručuje', () => {
    // content bol uložený BEZ diakritiky; dotaz S diakritikou musí sedieť
    const q = mk(KINDS.QUESTION, BASE + 40, [['t', 'ucet']], 'pridaná reklamačná žiadosť o účet');
    const local = openIndexerDb(':memory:');
    try {
      local.upsertEvent(q);
      expect(local.search('reklamacna').map((h) => h.id)).toEqual([q.id]);
      expect(local.search('žiadost').map((h) => h.id)).toEqual([q.id]);
      expect(local.search('UCET').map((h) => h.id)).toEqual([q.id]); // case folding
      expect(local.search('účet').map((h) => h.id)).toEqual([q.id]);
      // a obrátene: content s diakritikou, dotaz bez nej
      expect(local.search('ziadost').map((h) => h.id)).toEqual([q.id]);
    } finally {
      local.close();
    }
  });

  it('kontrast: remove_diacritics 0 by diakritiku NESPároval (preto pinujeme 2)', () => {
    const probe = new Database(':memory:');
    try {
      probe.exec(`CREATE VIRTUAL TABLE d0 USING fts5(c, tokenize="unicode61 remove_diacritics 0");
                  CREATE VIRTUAL TABLE d2 USING fts5(c, tokenize="unicode61 remove_diacritics 2");`);
      const doc = 'pridaná reklamačná žiadosť o účet';
      probe.prepare('INSERT INTO d0(c) VALUES (?)').run(doc);
      probe.prepare('INSERT INTO d2(c) VALUES (?)').run(doc);
      const hit0 = probe.prepare("SELECT count(*) n FROM d0 WHERE d0 MATCH 'reklamacna'").get() as { n: number };
      const hit2 = probe.prepare("SELECT count(*) n FROM d2 WHERE d2 MATCH 'reklamacna'").get() as { n: number };
      expect(hit0.n).toBe(0); // bez pinu by "reklamacna" na "reklamačná" nenašlo
      expect(hit2.n).toBe(1);
    } finally {
      probe.close();
    }
  });

  it('steming default NIE je — "fyzika" nenájde "fyzike" (S8: porter stemmer)', () => {
    expect(db.search('fyzika').length).toBe(0);
    expect(db.search('fyzike').length).toBe(1);
    // prefixové hľadanie funguje a je to jedná náhrada za steming
    expect(db.search('fyzik*').map((h) => h.kind)).toEqual([KINDS.POST]);
  });

  it('BM25 poradie, snippet, filter kindu a času', () => {
    const hits = db.search('databaze', { snippet: true });
    expect(hits.length).toBe(1);
    expect(hits[0]?.snippet).toMatch(/\[databaze\]/);
    expect(db.search('ziadost', { kinds: [KINDS.POST] }).length).toBe(0);
    expect(db.search('ziadost', { kinds: [KINDS.QUESTION] }).length).toBe(1);
    expect(db.search('ziadost', { since: BASE + 2 }).length).toBe(0);
    expect(db.search('ziadost', { until: BASE + 1 }).length).toBe(1);
    expect(db.search('databaze', { limit: 1 })).toHaveLength(1);
  });

  it('buildMatchQuery je odolný voči FTS5 syntax a rawMatch ju ponecháva', () => {
    for (const nasty of ['"', '(', 'AND', 'a:b', "' OR ", '*', 'databaze NEBO']) {
      expect(() => db.search(nasty)).not.toThrow();
    }
    expect(buildMatchQuery('dva tokeny')).toBe('dva AND tokeny');
    expect(buildMatchQuery('databaze*')).toBe('databaze*');
    expect(buildMatchQuery('"lww semantika"')).toBe('"""lww" AND "semantika"""');
    expect(buildMatchQuery('a:b')).toBe('"a:b"');
    expect(buildMatchQuery('*')).toBe('');
    expect(db.search('*')).toHaveLength(0);
    // raw FTS5: explicitná OR dostane viac zásahov ako implicitné AND
    const raw = db.search('databaze OR fyzike', { rawMatch: true });
    expect(raw).toHaveLength(2);
    expect(db.search('databaze fyzike')).toHaveLength(0);
  });

  it('triggery držia FTS5 v konzistencii aj po LWW sekvencii (integrity-check)', () => {
    const local = openIndexerDb(':memory:');
    try {
      const v1 = mk(KINDS.TOPIC, BASE + 10, [['d', 'konzistencia']], 'povodny text topicu');
      const v2 = mk(KINDS.TOPIC, BASE + 20, [['d', 'konzistencia']], 'novy text topicu');
      local.upsertEvent(v1);
      expect(local.search('povodny').map((h) => h.id)).toEqual([v1.id]);
      local.upsertEvent(v2);
      expect(local.search('povodny').length).toBe(0); // stará verzia už nie v indexe
      expect(local.search('novy').map((h) => h.id)).toEqual([v2.id]);
      local.ftsIntegrityCheck(); // nevyhodí výnimku = index sedí s tabuľkou
      expect(local.stats().fts_rows).toBe(1);
      // LWW nahradenie nemení rowid → FTS záznam zostáva priradený k tej istej riadke
      const row = local.db.prepare('SELECT rowid, id FROM events WHERE addr = ?').get(addressFor(v2)) as {
        rowid: number;
        id: string;
      };
      expect(row.id).toBe(v2.id);
    } finally {
      local.close();
    }
  });

  it('uložený tags_text je presne projekcia tagsToText (zdroj pravdy je tags_json)', () => {
    const samples: NostrTag[][] = [
      [['e', 'a'.repeat(64), 'root'], ['t', 'slovensko'], ['d', 'slug-1']],
      [['d', 'x'], ['a', `30020:${pk}:t`], [''], ['client', 'relay', 'w']],
      [],
      [['k', 'hashtag', 'extra', 'hodnota']],
    ];
    const local = openIndexerDb(':memory:');
    try {
      samples.forEach((tags, i) => {
        const event = raw(String(i + 1).padStart(64, '0'), KINDS.POST, BASE + 900 + i, 'text', tags);
        local.upsertEvent(event);
        const row = local.getEvent(event.id);
        expect(row?.tags_text, `vzorka ${String(i)}`).toBe(tagsToText(tags));
        expect(JSON.parse(String(row?.tags_json))).toEqual(tags);
      });
      // FTS5 trigger indexuje práve túto projekciu → slug/hashtag su vyskytovatelne
      expect(local.search('slug-1').map((h) => h.id)).toEqual([samples[0] ? String(1).padStart(64, '0') : '']);
      expect(local.search('hashtag').length).toBe(1);
    } finally {
      local.close();
    }
    for (const [json, expected] of [['[]', ''], ['', ''], [null, ''], ['{', '']] as const) {
      expect(tagsTextFromJson(json)).toBe(expected);
    }
  });
});

describe('indexer db — perzistencia po reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f4ai13-db-'));
  const file = join(dir, 'indexer.db');
  let events: NostrEvent[] = [];

  beforeAll(() => {
    events = [
      mk(KINDS.QUESTION, BASE + 1, [['t', 'perzistencia']], 'otazka ulozena na disk'),
      mk(KINDS.TOPIC, BASE + 2, [['d', 'trvanlivost']], 'topic na disk'),
    ];
    const db = openIndexerDb(file);
    try {
      db.upsertMany(events);
    } finally {
      db.close();
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('druhým otvorením sú data aj FTS index dostupné', () => {
    const db = openIndexerDb(file);
    try {
      expect(db.count()).toBe(2);
      expect(db.search('perzistencia').map((h) => h.id)).toEqual([events[0]?.id]);
      expect(db.search('trvanlivost').map((h) => h.id)).toEqual([events[1]?.id]);
      db.ftsIntegrityCheck();
    } finally {
      db.close();
    }
  });

  it('readonly pripojenie číta, ale nemeň schému', () => {
    const ro = openIndexerDb(file, { readonly: true });
    try {
      expect(ro.count()).toBe(2);
      expect(ro.search('disk').length).toBe(2);
      expect(() => ro.db.prepare('INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, sig, inserted_at) VALUES (?,?,?,?,?,?,?,?)').run('x'.repeat(64), pk, 1023, BASE, '', '[]', 'sig', 0)).toThrow();
    } finally {
      ro.close();
    }
  });
});

/**
 * F4AI-2b2: NIP-32 jazyk ako samostatný stĺpec `lang` (nie součástka
 * `tags_text`) — filter `lang=en` musí byť indexovateľný a nesmie sa
 * spoliehať na FTS, lebo `en` je bežné slovo v obsahu.
 */
describe('indexer db — lang stĺpec a filter (F4AI-2b2)', () => {
  const EN_LABEL: string[][] = [
    ['L', 'ISO-639-1'],
    ['l', 'en', 'ISO-639-1'],
  ];
  const SK_LABEL: string[][] = [
    ['L', 'ISO-639-1'],
    ['l', 'sk', 'ISO-639-1'],
  ];

  let db: IndexerDb;
  let enId: string;
  let skId: string;
  let bareId: string;
  let bogusId: string;

  beforeAll(() => {
    db = openIndexerDb(':memory:');
    const seed = (kind: number, created_at: number, tags: string[][], content: string): string => {
      const event = mk(kind, created_at, tags, content);
      db.upsertEvent(event);
      return event.id;
    };
    enId = seed(KINDS.POST, BASE + 1, [['e', 'a'.repeat(64), 'root'], ...EN_LABEL], 'english post about caching');
    skId = seed(KINDS.POST, BASE + 2, [['e', 'a'.repeat(64), 'root'], ...SK_LABEL], 'slovensky prispevok o caching');
    bareId = seed(KINDS.POST, BASE + 3, [['e', 'a'.repeat(64), 'root']], 'unlabeled post caching');
    // neplatný kód: indexer NEMAZEME (cudzie eventy), len má lang null
    bogusId = seed(KINDS.POST, BASE + 4, [['l', 'xxx', 'ISO-639-1']], 'bogus language code caching');
  });

  it('uloží lang z kánonických tagov aj z kompaktného tvaru', () => {
    expect(db.getEvent(enId)?.lang).toBe('en');
    expect(db.getEvent(skId)?.lang).toBe('sk');
    const compact = mk(KINDS.QUESTION, BASE + 20, [['L', 'de', 'ISO-639-1']], 'ein deutscher Beitrag');
    db.upsertEvent(compact);
    expect(db.getEvent(compact.id)?.lang).toBe('de');
  });

  it('bez labelu a s neplatným kódom má lang null', () => {
    expect(db.getEvent(bareId)?.lang).toBeNull();
    expect(db.getEvent(bogusId)?.lang).toBeNull();
  });

  it('search vráti lang a filter lang=en vráti len en', () => {
    const all = db.search('caching', { limit: 50 });
    expect(all.length).toBeGreaterThanOrEqual(4);
    const byId = new Map(all.map((hit) => [hit.id, hit.lang]));
    expect(byId.get(enId)).toBe('en');
    expect(byId.get(skId)).toBe('sk');
    expect(byId.get(bareId)).toBeNull();

    const onlyEn = db.search('caching', { limit: 50, lang: 'en' });
    expect(onlyEn.map((hit) => hit.id)).toEqual([enId]);
    const onlySk = db.search('caching', { limit: 50, lang: 'sk' });
    expect(onlySk.map((hit) => hit.id)).toEqual([skId]);
  });

  it('lang=any, lang=null a vynechaný filter sú všetky jazyky', () => {
    const plain = db.search('caching', { limit: 50 }).length;
    expect(db.search('caching', { limit: 50, lang: 'any' }).length).toBe(plain);
    expect(db.search('caching', { limit: 50, lang: null }).length).toBe(plain);
    // neznámy kód nie je chyba — len žiadny zásah
    expect(db.search('caching', { limit: 50, lang: 'zz' })).toEqual([]);
  });

  it('LWW replace prepíše aj lang (starý label nepretrvá)', () => {
    const first = mk(KINDS.TOPIC, BASE + 30, [['d', 'lang-swap'], ...SK_LABEL], 'povodny popis');
    db.upsertEvent(first);
    expect(db.getEvent(first.id)?.lang).toBe('sk');
    const second = mk(KINDS.TOPIC, BASE + 31, [['d', 'lang-swap'], ...EN_LABEL], 'new english description');
    expect(db.upsertEvent(second)).toBe('replaced');
    const row = db.getEvent(second.id);
    expect(row?.lang).toBe('en');
    expect(db.getEvent(first.id)).toBeNull();
  });
});

/**
 * Migrácia: DB založená pred 2b2 nemá stĺpec `lang`. Indexer sa otvára na
 * tej istej ceste, takže migrácia MUSÍ stĺpec pridať, jednorazovo ho
 * zaplniť z `tags_json` a nepoškodiť FTS index.
 */
describe('indexer db — migrácia lang na DB z pred-2b2', () => {
  const OLD_SCHEMA = `
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  kind        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  content     TEXT NOT NULL,
  tags_json   TEXT NOT NULL,
  tags_text   TEXT NOT NULL DEFAULT '',
  sig         TEXT NOT NULL,
  addr        TEXT NULL,
  inserted_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_addr ON events (addr);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content, tags_text, content = 'events', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, content, tags_text) VALUES (new.rowid, new.content, new.tags_text);
END;
`;

  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'f4ai-indexer-migrate-'));
    file = join(dir, 'indexer.db');
    const legacy = new Database(file);
    legacy.exec(OLD_SCHEMA);
    const insert = legacy.prepare(
      'INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, inserted_at) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const labeled = mk(KINDS.POST, BASE + 40, [['l', 'sk', 'ISO-639-1']], 'starsi slovensky prispevok');
    insert.run(labeled.id, labeled.pubkey, labeled.kind, labeled.created_at, labeled.content, JSON.stringify(labeled.tags), tagsToText(labeled.tags), labeled.sig, 0);
    const plain = mk(KINDS.POST, BASE + 41, [], 'stary bez jazyka');
    insert.run(plain.id, plain.pubkey, plain.kind, plain.created_at, plain.content, JSON.stringify(plain.tags), tagsToText(plain.tags), plain.sig, 0);
    // jeden ridik s rozbitým JSON — migrácia nesmie spadnúť
    insert.run('f'.repeat(64), pk, 1023, BASE + 42, 'poskodeny', 'not-json', '', 'sig', 0);
    legacy.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('pridá stĺpec, zaplní ho z tags_json a FTS ostáva konzistentný', () => {
    const db = openIndexerDb(file);
    const columns = db.db.pragma('table_info(events)') as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'lang')).toBe(true);
    const rows = db.db.prepare('SELECT id, lang FROM events ORDER BY created_at').all() as Array<{
      id: string;
      lang: string | null;
    }>;
    expect(rows[0]?.lang).toBe('sk');
    expect(rows[1]?.lang).toBeNull();
    expect(rows[2]?.lang).toBeNull();
    // FTS index z pred-2b2 stále funguje a migrácia ho neposunula
    expect(db.search('starsi').map((hit) => hit.lang)).toEqual(['sk']);
    db.ftsIntegrityCheck();
    db.close();

    // druhotné otvorenie: migrácia už nebeží, dáta ostávajú
    const again = openIndexerDb(file);
    try {
      expect(again.search('starsi').map((hit) => hit.lang)).toEqual(['sk']);
      expect(again.search('starsi', { lang: 'en' })).toEqual([]);
    } finally {
      again.close();
    }
  });
});
