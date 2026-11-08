/**
 * Testy materializovaných stĺpcov papiera v indexeri (Phase 4a, dizajn Q4).
 *
 * Indexer už kind 30023 ingestoval (`DEFAULT_INDEXER_KINDS` pokrýva
 * 30020–30029) — práca 4a je PROJEKCIA: `paper_title`, `paper_authors`,
 * `paper_abstract`, `paper_doi` pre `GET /papers` a jej migrácia. Testy
 * preto dokladujú tri veci, ktoré sa ľahko pokazia:
 *   1. projekcia sa napíše pri ingeste a pri LWW náhrade revízie,
 *   2. NEplatí pre iné kindy (post s `# ` nadpisom nie je papier),
 *   3. stará DB (pred 4a) dostane stĺpce ALTERom a BACKFILLOM z tagov,
 *      pričom legacy papier bez `title` tagu dostane nadpis z prvého H1.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import { IndexerDb, openIndexerDb } from '../src/db.js';
import { firstMarkdownHeading, paperColumnsFor } from '../src/papers.js';

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const BASE = 1_700_000_000;

function mk(kind: number, created_at: number, tags: string[][], content: string): NostrEvent {
  return finalizeEvent({ kind, created_at, tags, content }, sk) as NostrEvent;
}

/** kánonický papier dizajnu Q4 (title/summary/author/t/doi tagy) */
function paperTags(slug: string, title: string, extra: string[][] = []): string[][] {
  return [
    ['d', slug],
    ['title', title],
    ['summary', 'We replicate gated nostr forums with negentropy sets.'],
    ['published_at', '1793836800'],
    ['t', 'distributed-systems'],
    ['author', 'Jana Novakova', 'Comenius University', pk, '0000-0002-1825-0097'],
    ['author', 'agent:research-bot', '', '', ''],
    ['p', pk, '', 'author'],
    ['license', 'CC-BY-4.0'],
    ['doi', '10.5281/zenodo.1234567'],
    ['L', 'ISO-639-1'],
    ['l', 'en', 'ISO-639-1'],
    ...extra,
  ];
}

const PAPER_BODY = [
  '# Ignored heading',
  '',
  '## Introduction',
  '',
  'We build @fig:arch and cite [@novak2026].',
  '',
  '```',
  '# not a heading inside a fence',
  '```',
].join('\n');

describe('indexer — paper stĺpce pri ingeste (30023)', () => {
  let db: IndexerDb;

  beforeAll(() => {
    db = openIndexerDb(':memory:');
  });

  afterAll(() => {
    db.close();
  });

  it('napíše title/authors/abstract/doi z tagov papiera', () => {
    const event = mk(KINDS.PUBLICATION, BASE, paperTags('negentropy-replication', 'Negentropy Replication'), PAPER_BODY);
    expect(db.upsertEvent(event)).toBe('inserted');
    const row = db.getEvent(event.id);
    expect(row?.paper_title).toBe('Negentropy Replication');
    expect(row?.paper_abstract).toBe('We replicate gated nostr forums with negentropy sets.');
    expect(row?.paper_doi).toBe('10.5281/zenodo.1234567');
    expect(row?.lang).toBe('en');
    const authors = JSON.parse(String(row?.paper_authors)) as Array<Record<string, string>>;
    expect(authors).toHaveLength(2);
    expect(authors[0]).toEqual({
      name: 'Jana Novakova',
      affiliation: 'Comenius University',
      pubkey: pk,
      orcid: '0000-0002-1825-0097',
    });
    // normalizovaný tvar, nie surový tag: chýbajúce časti NEsú empty stringy
    expect(authors[1]).toEqual({ name: 'agent:research-bot' });
  });

  it('iný kind ostáva bez paper stĺpcov (post s # nadpisom nie je papier)', () => {
    const post = mk(KINDS.POST, BASE + 1, [['e', 'a'.repeat(64), 'root']], '# A post heading\n\nbody');
    db.upsertEvent(post);
    const row = db.getEvent(post.id);
    expect(row?.paper_title).toBeNull();
    expect(row?.paper_authors).toBeNull();
    expect(row?.paper_abstract).toBeNull();
    expect(row?.paper_doi).toBeNull();
  });

  it('LWW revízia prepíše aj paper stĺpce (adresa ostáva)', () => {
    const first = mk(KINDS.PUBLICATION, BASE + 10, paperTags('revisioned', 'First Title'), 'body v1');
    db.upsertEvent(first);
    const second = mk(KINDS.PUBLICATION, BASE + 20, paperTags('revisioned', 'Second Title'), 'body v2');
    expect(db.upsertEvent(second)).toBe('replaced');
    const row = db.db
      .prepare('SELECT * FROM events WHERE addr = ?')
      .get(`${String(KINDS.PUBLICATION)}:${pk}:revisioned`) as { id: string; paper_title: string };
    expect(row.id).toBe(second.id);
    expect(row.paper_title).toBe('Second Title');
  });

  it('cudzí 30023 bez title tagu dostane fallback z prvého H1', () => {
    const legacy = mk(
      KINDS.PUBLICATION,
      BASE + 30,
      [['d', 'legacy-no-title'], ['t', 'nostr'], ['author', 'Someone']],
      '```python\n# comment, not a heading\n```\n\n# Legacy Paper Heading\n\nprose',
    );
    db.upsertEvent(legacy);
    const row = db.getEvent(legacy.id);
    expect(row?.paper_title).toBe('Legacy Paper Heading');
    expect(row?.paper_abstract).toBeNull();
    expect(row?.paper_doi).toBeNull();
    expect(JSON.parse(String(row?.paper_authors))).toEqual([{ name: 'Someone' }]);
  });

  it('30023 bez akéhokoľvek nadpisu má paper_title NULL (nie zlyhanie)', () => {
    const bare = mk(KINDS.PUBLICATION, BASE + 40, [['d', 'bare'], ['t', 'nostr']], 'just prose');
    db.upsertEvent(bare);
    expect(db.getEvent(bare.id)?.paper_title).toBeNull();
  });

  it('abstrakt cudzieho papiera sa oreže na 1024 UTF-8 bajtov (strop prvku tagu)', () => {
    const long = mk(
      KINDS.PUBLICATION,
      BASE + 50,
      [['d', 'long-abstract'], ['t', 'nostr'], ['title', 'T'], ['summary', 'ä'.repeat(600)]],
      'body',
    );
    db.upsertEvent(long);
    const abstract = String(db.getEvent(long.id)?.paper_abstract);
    expect(Buffer.byteLength(abstract, 'utf8')).toBeLessThanOrEqual(1024);
    expect(abstract.length).toBeGreaterThan(0);
  });
});

describe('indexer — migrácia a backfill paper stĺpcov', () => {
  const dirs: string[] = [];

  function tempFile(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'f4ai-indexer-'));
    dirs.push(dir);
    return join(dir, name);
  }

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** DB s schémou PRED Phase 4a (2b2: s `lang`, bez `paper_*`) */
  function makePrePhase4aDb(path: string, rows: Array<{ id: string; kind: number; content: string; tags: string[][] }>): void {
    const raw = new Database(path);
    raw.exec(`
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
        inserted_at INTEGER NOT NULL,
        lang        TEXT NULL
      );
    `);
    const insert = raw.prepare(
      `INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang)
       VALUES (?, ?, ?, ?, ?, ?, '', 'sig', ?, ?, ?)`,
    );
    for (const [i, row] of rows.entries()) {
      const addr = row.kind >= 30000 ? `${String(row.kind)}:${pk}:${row.tags.find((t) => t[0] === 'd')?.[1] ?? ''}` : null;
      insert.run(
        row.id,
        pk,
        row.kind,
        BASE + i,
        row.content,
        JSON.stringify(row.tags),
        addr,
        BASE + i,
        null,
      );
    }
    raw.close();
  }

  it('pridá stĺpce ALTERom a zaplní ich z tagov existujúcich papierov', () => {
    const file = tempFile('pre4a.db');
    makePrePhase4aDb(file, [
      {
        id: 'b'.repeat(64),
        kind: KINDS.PUBLICATION,
        content: '## Intro\n\nprose',
        tags: paperTags('migrated-paper', 'Migrated Paper Title'),
      },
      {
        id: 'c'.repeat(64),
        kind: KINDS.POST,
        content: '# Post heading',
        tags: [['e', 'a'.repeat(64), 'root']],
      },
    ]);

    const db = openIndexerDb(file);
    const columns = db.db.pragma('table_info(events)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['paper_title', 'paper_authors', 'paper_abstract', 'paper_doi']),
    );

    const paper = db.getEvent('b'.repeat(64));
    expect(paper?.paper_title).toBe('Migrated Paper Title');
    expect(paper?.paper_abstract).toBe('We replicate gated nostr forums with negentropy sets.');
    expect(paper?.paper_doi).toBe('10.5281/zenodo.1234567');
    expect(JSON.parse(String(paper?.paper_authors))[0]?.name).toBe('Jana Novakova');

    // backfill siaha len na 30023 — iné kindy ostávajú NULL
    expect(db.getEvent('c'.repeat(64))?.paper_title).toBeNull();
    db.close();
  });

  it('legacy papier bez title tagu dostane nadpis z H1 (fallback len pri backfilli)', () => {
    const file = tempFile('pre4a-h1.db');
    makePrePhase4aDb(file, [
      {
        id: 'd'.repeat(64),
        kind: KINDS.PUBLICATION,
        content: '```python\n# comment\n```\n\n# Heading From The Body\n\nprose',
        tags: [['d', 'legacy'], ['t', 'nostr'], ['author', 'Someone']],
      },
    ]);
    const db = openIndexerDb(file);
    expect(db.getEvent('d'.repeat(64))?.paper_title).toBe('Heading From The Body');
    db.close();
  });

  it('druhý otvorenie už backfill neopakuje a hodnoty nestratí', () => {
    const file = tempFile('pre4a-reopen.db');
    makePrePhase4aDb(file, [
      {
        id: 'e'.repeat(64),
        kind: KINDS.PUBLICATION,
        content: 'body',
        tags: paperTags('stable', 'Stable Title'),
      },
    ]);
    const first = openIndexerDb(file);
    first.close();
    const second = openIndexerDb(file);
    expect(second.getEvent('e'.repeat(64))?.paper_title).toBe('Stable Title');
    second.close();
  });

  it('nová DB (4a) má stĺpce už v schéme a ingest ich napíše bez migrácie', () => {
    const file = tempFile('fresh.db');
    const db = openIndexerDb(file);
    const event = mk(KINDS.PUBLICATION, BASE + 60, paperTags('fresh', 'Fresh Title'), 'body');
    db.upsertEvent(event);
    expect(db.getEvent(event.id)?.paper_title).toBe('Fresh Title');
    db.close();
  });
});

describe('indexer — čisté funkcie projekcie', () => {
  it('firstMarkdownHeading preskočí fence a berie prvý nadpis', () => {
    expect(firstMarkdownHeading('```js\n# not this\n```\n\n# Real')).toBe('Real');
    expect(firstMarkdownHeading('## Level two')).toBe('Level two');
    expect(firstMarkdownHeading('no heading here')).toBeNull();
    expect(firstMarkdownHeading('')).toBeNull();
    expect(firstMarkdownHeading('~~~\n# fenced\n~~~\n\n# After tilde fence')).toBe('After tilde fence');
  });

  it('oreže nadpis na 300 znakov (strop title tagu)', () => {
    expect((firstMarkdownHeading(`# ${'x'.repeat(400)}`) ?? '').length).toBe(300);
  });

  it('paperColumnsFor vráti null pre iný kind', () => {
    const post: NostrEvent = {
      id: 'f'.repeat(64),
      pubkey: pk,
      created_at: BASE,
      kind: KINDS.POST,
      tags: [['title', 'a post with a title tag']],
      content: '# heading',
      sig: 'sig',
    };
    expect(paperColumnsFor(post)).toBeNull();
  });

  it('paperColumnsFor normalizuje autorov a spracuje string-only author', () => {
    const paper: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: pk,
      created_at: BASE,
      kind: KINDS.PUBLICATION,
      tags: [['d', 'x'], ['title', 'T'], ['author', 'Solo Author']],
      content: 'body',
      sig: 'sig',
    };
    const columns = paperColumnsFor(paper);
    expect(columns?.paper_title).toBe('T');
    expect(columns?.paper_authors).toBe('[{"name":"Solo Author"}]');
    expect(columns?.paper_abstract).toBeNull();
    expect(columns?.paper_doi).toBeNull();
  });
});
