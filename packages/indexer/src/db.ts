/**
 * Indexer SQLite layer (F4AI-13, S7) — `better-sqlite3` 13.0.3 (SQLite
 * 3.53.4, which has FTS5 built in; version verified on npm, behavior
 * measured with local probes and tests in `test/db.test.ts`).
 *
 * Schema:
 *   events(id PRIMARY KEY, pubkey, kind, created_at, content, tags_json,
 *          tags_text, sig, addr TEXT NULL, inserted_at)
 *   + FTS5 external-content table `events_fts(content, tags_text)`
 *     attached to `events` (`content='events', content_rowid='rowid'`)
 *     with INSERT/UPDATE/DELETE triggers.
 *
 * Why `events` has an extra `tags_text` column beyond the task brief:
 *   an FTS5 external-content table reads its columns with
 *   `SELECT rowid, <fts_columns> FROM events AS T WHERE rowid = ?` — EVERY
 *   indexed column MUST exist as a real column of the content table.
 *   Measured: without `events.tags_text`, `SELECT rowid FROM events_fts` and
 *   `snippet()` fail with "no such column: T.tags_text"; with a real column,
 *   `count(*)`, `snippet()` and `integrity-check` all work. `tags_json` stays
 *   the single source of truth; `tags_text` is a derived search projection
 *   (computed by the TS function `tagsToText` at write time).
 *
 * Why triggers and not manual synchronization on upsert:
 *   our ingest is ONE SQL statement — `INSERT ... ON CONFLICT(id) DO NOTHING
 *   ON CONFLICT(addr) ... DO UPDATE SET ... WHERE <LWW guard>` (SQLite 3.53
 *   accepts two ON CONFLICT clauses, verified by a probe). The triggers fire
 *   correctly on it: INSERT path → AFTER INSERT, DO UPDATE path
 *   → AFTER UPDATE (delete the old + insert the new FTS entry), DO NOTHING
 *   → no trigger. Manual synchronization would require reading the old
 *   version before the upsert (the `('delete', …)` command needs the old
 *   values), and telling insert/update/no-op apart from `changes()` is
 *   ambiguous — triggers are cleaner, and the FTS index stays consistent even
 *   under direct SQL edits (`ftsIntegrityCheck()` passes after an LWW
 *   sequence, tested).
 *
 * LWW semantics (identical to `packages/gateway/src/read-model.ts` and
 * `packages/relay/src/store.ts`):
 *   - regular kinds (addr NULL)          → dedup per `id` (DO NOTHING),
 *   - replaceable (0, 3, 10000–19999)    → one row per address `kind:pubkey:d`,
 *   - addressable (30000+)               → one row per address `kind:pubkey:d`,
 *   - newer `created_at` wins; on a tie the lexicographically LOWER id
 *     (on replacement the row's `id` is rewritten too — otherwise the DB
 *     would carry the new text under the old id, tested).
 *
 * FTS5 diacritics (MEASURED, not an assumption): the default `unicode61`
 * tokenizer in SQLite 3.53.4 STRIPS diacritics (the amalgamation defaults to
 * `pNew->eRemoveDiacritic = 1`) and case-folds — tokens from
 * 'Pridaná ŽIADOSŤ o účet' are `pridana | ucet | ziadost`. With an explicit
 * `remove_diacritics 0`, "reklamacna" would NOT find "reklamačná" (the
 * `kontrast:` test documents this), so we PIN the tokenizer to
 * `unicode61 remove_diacritics 2` — behavior is deterministic across SQLite
 * versions. Stemming is NOT on by default ('fyzika' ≠ 'fyzike'); S8 can
 * improve it (`stemmer`, `prefix` indexes, ICU) — details in the README.
 */
import Database from 'better-sqlite3';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

type SqliteDb = Database.Database;
type Statement = Database.Statement;

/** Výsledok jedného zápisu do tabuľky events. */
export type UpsertOutcome = 'inserted' | 'replaced' | 'ignored';

/** Kánonický záznam v tabuľke events (tags ako JSON + vyhledávacia projekcia). */
export interface EventRow {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags_json: string;
  tags_text: string;
  sig: string;
  addr: string | null;
  inserted_at: number;
  /**
   * F4AI-2b2: ISO-639-1 kód z NIP-32 labelu eventu (`["l","sk","ISO-639-1"]`
   * alebo kompaktný `["L","sk","ISO-639-1"]`), alebo `null` — event label
   * nemá, prípadne má neplatný kód (ten gateway odmieta pri zápise, ale
   * cudzie eventy z relays sa indexujú aj tak).
   */
  lang: string | null;
  /**
   * Phase 4a (dizajn Q4): materializované stĺpce papiera (kind 30023), inak
   * `null`. `paper_authors` je JSON pole normalizovaných autorov
   * `[{name, affiliation?, pubkey?, orcid?}]` — pri legacy riadkoch pred 4a
   * môže byť `paper_title` fallback z prvého markdown nadpisu (`papers.ts`).
   */
  paper_title: string | null;
  paper_authors: string | null;
  paper_abstract: string | null;
  paper_doi: string | null;
  /**
   * Phase 6a (dizajn Q5): `'self'` = lokálny obsah inštancie, inak id
   * upstreamu (host jeho gateway URL). Pridáva sa k výsledkom `GET /search`
   * a je to filterovateľné pole (`/search?origin=`).
   */
  origin: string;
  /**
   * Phase 6a: 1 = autor je PÍŠUCI tejto inštancie (domáci obsah), 0 =
   * autor pochádza z cudzieho adresára (`INDEXER_TRUST_DIRECTORIES`) alebo
   * z PULLu upstreamu (`fed.ts`). Prázdny env + žiadny sweep = VŠETKO je 1,
   * teda správanie pred 6a. Príznak mení LEN index (dôveryhodnosť pre
   * vyhľadávanie), NIKDY write-gate — to Q5 zakazuje. Rozhoduje o tom INGEST
   * (jediný writer), gateway stĺpec len číta — single source of truth.
   */
  trusted: number;
}

/** Výsledok FTS5 dotazu — kanonické polia + BM25 skóre a voliteľný snippet. */
export interface SearchHit {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: NostrTag[];
  /**
   * BM25 skóre FTS5 (`rank`). NAMERANé 2026-10-28 (SQLite 3.53.4 v
   * better-sqlite3 13.0.3): hodnoty sú **záporné** a **lepší kandidát má
   * nižšiu (viac zápornú) hodnotu** — preto `ORDER BY events_fts.rank` ASC.
   * (Pozor, bežné tvrdenie "bližšie k 0 = lepšie" je u bm25() vo FTS5
   * nepravdivé; overené na troch udalostiach s rôznou frekvenciou termínu.)
   */
  score: number;
  snippet?: string;
  /** F4AI-2b2: jazyk eventu z NIP-32 labelu, `null` = neoznačený */
  lang: string | null;
  /**
   * Phase 6a (dizajn Q5): `'self'` alebo id upstreamu. Vždy prítomné —
   * aj pri DB založenej pred 6a, kde migrácia ešte nebehla, je hodnota
   * `'self'` (indexer je writer a migruje pri otvorení; read-only čítač
   * dostane fallback, nie chybu).
   */
  origin: string;
  /** Phase 6a: `false` = autor nie je pisúci tejto inštancie (cudzí obsah) */
  trusted: boolean;
}

export interface SearchOptions {
  limit?: number;
  kinds?: number[];
  since?: number;
  until?: number;
  /**
   * F4AI-2b2: filter podľa jazyka (`lang=en`). `undefined` = všetky jazyky;
   * `null`/`'any'` volajúci normalizuje na `undefined` — DB vráti všetko.
   */
  lang?: string | null;
  /**
   * Phase 6a (dizajn Q5): filter pôvodu. `'self'` = len lokálny obsah,
   * iná hodnota = id upstreamu (napr. `127.0.0.1:18081`).
   * `undefined`/`null`/`'any'` = bez filtra — dizajn Q5 chce, aby
   * `GET /search?q=…` bez parametrov našlo aj vlákno druhej inštancie.
   */
  origin?: string | null;
  /** pridať `snippet()` z content stĺpca (stred nájdeného výskytu) */
  snippet?: boolean;
  /** `true` = `match` berieme ako surový FTS5 výraz (prefixy, AND/OR, phrase) */
  rawMatch?: boolean;
}

export interface IndexerStats {
  events: number;
  by_kind: Array<{ kind: number; count: number }>;
  replaceable_rows: number;
  max_created_at: number;
  fts_rows: number;
  /**
   * Phase 6a (dizajn Q5): rozloženie podľa pôvodu (`self` + each upstream
   * id) — diagnostika, ktorou operátor overí, že PULL/PUSH a sweep do
   * indexu skutočne tečú. Chýba pri DB pred 6a (read-only bez stĺpca).
   */
  by_origin?: Array<{ origin: string; count: number; trusted: number }>;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
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
  lang        TEXT NULL,
  -- Phase 4a (dizajn Q4): materializovaná projekcia papiera (kind 30023).
  -- NULL pre všetky iné kindy. Odvodené z tags_json/content — source of
  -- truth ostáva event, stĺpce sa dajú kedykoľvek prepočítať migráciou.
  -- (Pozor: v tomto template literáli sú backtick-y ukončujú reťazec,
  --  preto tu mená stĺpcov píšeme bez nich.)
  paper_title    TEXT NULL,
  paper_authors  TEXT NULL,
  paper_abstract TEXT NULL,
  paper_doi      TEXT NULL,
  -- Phase 6a (dizajn Q5): odkiaľ event je. 'self' = lokálny obsah tejto
  -- inštancie, inak id upstreamu (host jeho gateway URL) — presne tá
  -- hodnota, ktorú UI zobrazuje ako čip „from aiforum.myhood.sk".
  -- trusted je 0/1 príznak pôvodu AUTORA: 1 = pisúci tejto inštancie,
  -- 0 = cudzí adresár (INDEXER_TRUST_DIRECTORIES) alebo PULL z upstreamu.
  -- Dizajn Q5 zakazuje, aby adresár pisúcich slúžil ako ZAPORA zápisu,
  -- preto príznak ovplyvňuje LEN index (dôveryhodnosť pre vyhľadávanie a
  -- budúce hodnotenie), nikdy write-gate. (Bez backtick-ov: v tomto
  -- template literáli by ukončili reťazec.)
  origin        TEXT    NOT NULL DEFAULT 'self',
  trusted       INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS events_addr       ON events (addr);
CREATE        INDEX IF NOT EXISTS events_kind       ON events (kind);
CREATE        INDEX IF NOT EXISTS events_pubkey     ON events (pubkey);
CREATE        INDEX IF NOT EXISTS events_created_at ON events (created_at);
CREATE        INDEX IF NOT EXISTS events_lang       ON events (lang);
CREATE        INDEX IF NOT EXISTS events_origin     ON events (origin);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content,
  tags_text,
  content = 'events',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, content, tags_text)
  VALUES (new.rowid, new.content, new.tags_text);
END;

CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts (events_fts, rowid, content, tags_text)
  VALUES ('delete', old.rowid, old.content, old.tags_text);
END;

CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts (events_fts, rowid, content, tags_text)
  VALUES ('delete', old.rowid, old.content, old.tags_text);
  INSERT INTO events_fts (rowid, content, tags_text)
  VALUES (new.rowid, new.content, new.tags_text);
END;

-- Phase 6a: kurzory vlastných procesov indexera (napr. sweep gateway
-- fed.db). Indexer je jediný writer tejto DB, preto kurzor patrí SEM a
-- nie do fed.db — tu by sme ho nevedeli zapísať (čítame ju read-only).
CREATE TABLE IF NOT EXISTS indexer_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Odvodenie vyhledávacieho textu tagov: z každého tagu vynecháme skratku
 * (prvý prvok) a zvyšné hodnoty spojíme medzerou. Tagy teda robia
 * vyskytovateľnými topic slugy (`d`), hashtagy (`t`), adresy predkov (`a`)
 * aj id referencií (`e`) — markerové hodnoty (`root`/`parent`/`mention`) sú
 * vedľajší šum, S8 ich môže filtrovať.
 */
export function tagsToText(tags: NostrTag[]): string {
  const parts: string[] = [];
  if (!Array.isArray(tags)) return '';
  for (const tag of tags) {
    if (!Array.isArray(tag)) continue;
    for (let i = 1; i < tag.length; i += 1) {
      const value = tag[i];
      if (typeof value === 'string' && value !== '') parts.push(value);
    }
  }
  return parts.join(' ');
}

/** JSON → vyhledávací text tagov (olerčný voči neplatnému JSONu). */
export function tagsTextFromJson(tagsJson: string | null): string {
  if (typeof tagsJson !== 'string' || tagsJson === '') return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(tagsJson);
  } catch {
    return '';
  }
  if (!Array.isArray(parsed)) return '';
  return tagsToText(parsed as NostrTag[]);
}

/**
 * Adresa pre LWW dedup: `kind:pubkey:d` (NIP-01). Replaceable sú kindy 0, 3
 * a 10000–19999, addressable 30000+; `d` bez `d` tagu je prázdny reťazec.
 * Regular a ephemeral kindy (20000–29999) adresu nemajú → dedup len per id.
 */
export function addressFor(event: NostrEvent): string | null {
  const kind = event.kind;
  if (kind >= 20000 && kind < 30000) return null; // ephemeral range
  const replaceable = kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
  if (!replaceable && kind < 30000) return null;
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
  return `${kind}:${event.pubkey}:${d}`;
}

/**
 * FTS5 match-query builder — od S8 (F4AI-14) sídli v `@forum4ai/shared`
 * (`search.ts`), lebo ho potrebuje aj gateway čítajúci túto DB read-only.
 * Tu ho len **re-exportujeme**, aby sa verejné API balíka `@forum4ai/indexer`
 * (a jeho testy) nezmenilo. Pravidlá buildu aj dôvod presunu sú v dokumentácii
 * shared modulu; `nekopírovať` je súčasť story — jeden zdroj pravdy.
 */
import { buildMatchQuery, KINDS, ORIGIN_SELF, parseContentLang } from '@forum4ai/shared';

import { paperColumnsFor } from './papers.js';

export { buildMatchQuery };

/** Otvorená indexer databáza + pripravené príkazy. */
export class IndexerDb {
  readonly db: SqliteDb;
  readonly path: string;

  private readonly stmtById: Statement;
  private readonly stmtByAddr: Statement;
  private readonly stmtUpsert: Statement;
  private readonly stmtCount: Statement;
  private readonly stmtMaxCreated: Statement;
  private readonly stmtMaxCreatedBounded: Statement;
  private readonly stmtRecentIds: Statement;
  private readonly stmtIdsOfKind: Statement;
  private readonly stmtGet: Statement;
  private readonly stmtStats: Statement;
  private readonly stmtStatsKinds: Statement;
  private readonly stmtStatsFts: Statement;
  private readonly searchCache = new Map<string, Statement>();
  /** Phase 6a: či tabuľka `events` má stĺpce `origin`/`trusted` (read-only pred 6a nie) */
  private hasOriginColumns = false;

  constructor(path: string, opts?: { readonly?: boolean }) {
    this.path = path;
    const readonly = opts?.readonly === true;
    this.db = new Database(path, readonly ? { readonly: true } : {});
    // WAL = čítač (S8 gateway) sa neblokuje s writerom; busy_timeout istota.
    // Na readonly pripojení pragmá nemeňme a schému nevytvárajme (SQLite by
    // na zmenu odpovedal chybou).
    if (!readonly) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 5000');
      // F4AI-2b2: DB založená pred 2b2 má `events` BEZ stĺpca `lang` a
      // `CREATE TABLE IF NOT EXISTS` ju neprepíše. Migrácia preto beží
      // PRED schéme — inak by `CREATE INDEX ... events_lang` na pred-2b2
      // DB padol na `no such column: lang`.
      this.migrateLangColumn();
      // Phase 4a: papiere (30023) — rovnaké poradie ako pri `lang`, lebo
      // migrácia musí stĺpce pridať PRED `CREATE ... IF NOT EXISTS` (nová DB
      // ich už má v SCHEMA_SQL, stará ich dostane ALTERom + backfillom).
      this.migratePaperColumns();
      // Phase 6a: `origin`/`trusted` — poradie rovnako PRED schéme
      // (voli index `events_origin`).
      this.migrateOriginColumns();
      this.db.exec(SCHEMA_SQL);
    }

    // Phase 6a: read-only pripojenie (gateway, `indexer query`) NEMÔŽE
    // migrovať. Ak by sme vtedy siahli po `e.origin`, SQLite by hodil
    // `no such column` a celý search by spadol — preto detekcia tvaru
    // tabuľky a fallback na 'self'/true. Rovnaký vzorec ako `langColumn`
    // v gateway `search.ts` (2b2) a `paperColumns` (4a).
    this.hasOriginColumns = (this.db.pragma('table_info(events)') as Array<{ name: string }>).some(
      (column) => column.name === 'origin',
    );

    this.stmtById = this.db.prepare('SELECT id, addr FROM events WHERE id = @id');
    this.stmtByAddr = this.db.prepare('SELECT id, addr FROM events WHERE addr = @addr');
    // Jeden INSERT pokryje dedup (id) aj LWW náhradu (addr) — dva konfliktne
    // klaúzuly. Guard v WHERE implementuje NIP-01 LWW: novší created_at,
    // pri rovnosti nižšie id (zhodné s read-model a relay MemoryStore).
    // `id = excluded.id` je nevyhnutné: bez neho by riadok niesol nový text
    // pod starým event id.
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO events (id, pubkey, kind, created_at, content, tags_json, tags_text, sig, addr, inserted_at, lang,
                          paper_title, paper_authors, paper_abstract, paper_doi, origin, trusted)
      VALUES (@id, @pubkey, @kind, @created_at, @content, @tags_json, @tags_text, @sig, @addr, @inserted_at, @lang,
              @paper_title, @paper_authors, @paper_abstract, @paper_doi, @origin, @trusted)
      ON CONFLICT(id) DO NOTHING
      ON CONFLICT(addr) WHERE addr IS NOT NULL DO UPDATE SET
        id             = excluded.id,
        pubkey         = excluded.pubkey,
        kind           = excluded.kind,
        created_at     = excluded.created_at,
        content        = excluded.content,
        tags_json      = excluded.tags_json,
        tags_text      = excluded.tags_text,
        sig            = excluded.sig,
        addr           = excluded.addr,
        inserted_at    = excluded.inserted_at,
        lang           = excluded.lang,
        paper_title    = excluded.paper_title,
        paper_authors  = excluded.paper_authors,
        paper_abstract = excluded.paper_abstract,
        paper_doi      = excluded.paper_doi,
        origin         = excluded.origin,
        trusted        = excluded.trusted
      WHERE excluded.created_at > events.created_at
         OR (excluded.created_at = events.created_at AND excluded.id < events.id)
    `);
    this.stmtCount = this.db.prepare('SELECT count(*) AS n FROM events');
    this.stmtMaxCreated = this.db.prepare('SELECT COALESCE(max(created_at), 0) AS m FROM events');
    this.stmtMaxCreatedBounded = this.db.prepare(
      'SELECT COALESCE(max(created_at), 0) AS m FROM events WHERE created_at <= @max',
    );
    this.stmtRecentIds = this.db.prepare(
      'SELECT id FROM events ORDER BY inserted_at DESC, id ASC LIMIT @limit',
    );
    this.stmtIdsOfKind = this.db.prepare(
      'SELECT id FROM events WHERE kind = @kind ORDER BY created_at ASC, id ASC',
    );
    this.stmtGet = this.db.prepare('SELECT * FROM events WHERE id = @id');
    this.stmtStats = this.db.prepare(`
      SELECT
        (SELECT count(*) FROM events) AS events,
        (SELECT COALESCE(max(created_at), 0) FROM events) AS max_created_at,
        (SELECT count(*) FROM events WHERE addr IS NOT NULL) AS replaceable_rows
    `);
    this.stmtStatsKinds = this.db.prepare(
      'SELECT kind, count(*) AS count FROM events GROUP BY kind ORDER BY kind ASC',
    );
    this.stmtStatsFts = this.db.prepare('SELECT count(*) AS n FROM events_fts');
  }

  /**
   * F4AI-2b2: pridá stĺpec `lang` do DB založenej pred 2b2 a jednorazovo
   * ho zaplní z `tags_json` (jazyk sa odvodzuje z tagov, nie z obsahu).
   *
   * Prečo len pri pridaní stĺpca: `lang IS NULL` je aj platný stav (event
   * bez NIP-32 labelu), takže podmienený backfill `WHERE lang IS NULL` by
   * pri každom štarte prechádzal celý index. Po purge+reseed (Phase 2c)
   * migrácia vôbec nebeží — DB vzniká so správnou schémou.
   */
  private migrateLangColumn(): void {
    const columns = this.db.pragma('table_info(events)') as Array<{ name: string }>;
    // nová DB: `events` ešte neexistuje, vytvorí ju SCHEMA_SQL už s `lang`
    if (columns.length === 0) return;
    if (columns.some((column) => column.name === 'lang')) return;
    this.db.exec('ALTER TABLE events ADD COLUMN lang TEXT NULL');
    const rows = this.db.prepare('SELECT rowid AS rowid, tags_json FROM events').all() as Array<{
      rowid: number;
      tags_json: string;
    }>;
    const update = this.db.prepare('UPDATE events SET lang = @lang WHERE rowid = @rowid');
    const backfill = this.db.transaction(() => {
      for (const row of rows) {
        let tags: NostrTag[] = [];
        try {
          const parsed: unknown = JSON.parse(row.tags_json);
          if (Array.isArray(parsed)) tags = parsed as NostrTag[];
        } catch {
          continue; // neplatný JSON: lang ostane NULL, rovnako ako pri new ingest
        }
        const lang = parseContentLang(tags);
        if (lang !== null) update.run({ rowid: row.rowid, lang });
      }
    });
    backfill();
  }

  /**
   * Phase 4a (dizajn Q4): pridá materializované stĺpce papiera do DB založenej
   * pred 4a a jednorazovo ich zaplní z `tags_json`/`content`.
   *
   * Rovnaký vzorec ako `migrateLangColumn` (2b2): `CREATE TABLE IF NOT EXISTS`
   * neprepíše existujúcu tabuľku, takže stará DB potrebuje ALTER. Na rozdiel
   * od `lang` backfill NIE JE podmienený `WHERE ... IS NULL` — `paper_title`
   * je NULL aj platne (cudzí 30023 bez title tagu aj bez nadpisu) a po
   * migrácii chceme všetky papiere čitateľné naraz. Beží raz, lebo ho spúšťa
   * práve pridanie stĺpcov (po purge+reseed vôbec).
   */
  private migratePaperColumns(): void {
    const columns = this.db.pragma('table_info(events)') as Array<{ name: string }>;
    if (columns.length === 0) return; // nová DB: vytvorí ju SCHEMA_SQL už s nimi
    const have = new Set(columns.map((column) => column.name));
    let added = 0;
    for (const [name, ddl] of [
      ['paper_title', 'TEXT NULL'],
      ['paper_authors', 'TEXT NULL'],
      ['paper_abstract', 'TEXT NULL'],
      ['paper_doi', 'TEXT NULL'],
    ] as const) {
      if (have.has(name)) continue;
      this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${ddl}`);
      added += 1;
    }
    if (added === 0) return;
    this.backfillPaperColumns();
  }

  /**
   * Phase 6a (dizajn Q5): pridá stĺpce `origin`/`trusted` do DB založenej
   * pred 6a a jednorazovo ich zaplní.
   *
   * Rovnaký vzorec ako `migrateLangColumn` (2b2) a `migratePaperColumns` (4a):
   * `CREATE TABLE IF NOT EXISTS` neprepíše existujúcu tabuľku, takže stará
   * DB potrebuje ALTER — a migrácia musí bežať PRED `SCHEMA_SQL`, inak by
   * `CREATE INDEX ... events_origin` na pred-6a DB padol na
   * `no such column: origin`.
   *
   * Backfill je EXPLICITNÝ `UPDATE` aj keď SQLite pri `ADD COLUMN ... DEFAULT`
   * hodnotu doplní sám: jednak je to čitateľné v diff-e migrácie, jednak tým
   * ošetríme aj `NULL`/prázdne hodnoty, ktoré by do tabuľky dostala staršia
   * verzia. Význam oboch hodnôt je konzervatívny —
   * `'self'` a `trusted = 1` znamenajú „nic sme nevedeli iné", teda
   * správanie pred 6a (žiadne vylúčenie, žiadny cudzí pôvod).
   */
  private migrateOriginColumns(): void {
    const columns = this.db.pragma('table_info(events)') as Array<{ name: string }>;
    if (columns.length === 0) return; // nová DB: vytvorí ju SCHEMA_SQL už s nimi
    const have = new Set(columns.map((column) => column.name));
    let added = 0;
    for (const [name, ddl] of [
      ['origin', `TEXT NOT NULL DEFAULT 'self'`],
      ['trusted', 'INTEGER NOT NULL DEFAULT 1'],
    ] as const) {
      if (have.has(name)) continue;
      this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${ddl}`);
      added += 1;
    }
    if (added === 0) return;
    this.db.exec(`UPDATE events SET origin = 'self' WHERE origin IS NULL OR origin = ''`);
    this.db.exec('UPDATE events SET trusted = 1 WHERE trusted IS NULL');
  }

  /** Prepíš paper stĺpce všetkých 30023 riadkov zo stored tagov/obsahu. */
  private backfillPaperColumns(): void {
    const rows = this.db
      .prepare('SELECT rowid AS rowid, content, tags_json FROM events WHERE kind = @kind')
      .all({ kind: KINDS.PUBLICATION }) as Array<{
      rowid: number;
      content: string;
      tags_json: string;
    }>;
    if (rows.length === 0) return;
    const update = this.db.prepare(`
      UPDATE events
      SET paper_title    = @paper_title,
          paper_authors  = @paper_authors,
          paper_abstract = @paper_abstract,
          paper_doi      = @paper_doi
      WHERE rowid = @rowid
    `);
    const backfill = this.db.transaction(() => {
      for (const row of rows) {
        let tags: NostrTag[] = [];
        try {
          const parsed: unknown = JSON.parse(row.tags_json);
          if (Array.isArray(parsed)) tags = parsed as NostrTag[];
        } catch {
          continue; // neplatný JSON: stĺpce ostanú NULL, rovnako ako pri new ingest
        }
        const columns = paperColumnsFor({
          kind: KINDS.PUBLICATION,
          tags,
          content: row.content,
        } as NostrEvent);
        if (columns === null) continue;
        update.run({ rowid: row.rowid, ...columns });
      }
    });
    backfill();
  }

  /**
   * Vloží jeden event. Dedup/replace volí jeden SQL príkaz; rozlíšenie
   * `inserted` vs `replaced` robíme lacným predčítaním (1 SELECT + 1 INSERT
   * na event, ingest nie je tepelne kritická cesta).
   */
  upsertEvent(
    event: NostrEvent,
    opts?: { insertedAt?: number; origin?: string; trusted?: boolean },
  ): UpsertOutcome {
    const addr = addressFor(event);
    const tags = Array.isArray(event.tags) ? event.tags : [];
    const params = {
      id: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      created_at: event.created_at,
      content: event.content,
      tags_json: JSON.stringify(tags),
      tags_text: tagsToText(tags),
      sig: event.sig,
      addr,
      inserted_at: opts?.insertedAt ?? Math.floor(Date.now() / 1000),
      // F4AI-2b2: jazyk z NIP-32 labelu (prvý platný ISO-639-1 tag vyhráva);
      // neplatný kód aj chýbajúci label → NULL (indexer neodmieta)
      lang: parseContentLang(tags),
      // Phase 4a (dizajn Q4): materializovaná projekcia papiera. Vždy
      // prítomné kľúče — pre iné kindy všetky NULL, aby SQL dostal predvídateľný
      // tvar a `q=` filter nad ne-papiermi netrefil náhodné hodnoty.
      ...(paperColumnsFor(event) ?? {
        paper_title: null,
        paper_authors: null,
        paper_abstract: null,
        paper_doi: null,
      }),
      // Phase 6a (dizajn Q5): pôvod a dôvera. Volá to INGEST (explicitné
      // zadanie > mapovanie z dôveryhodného adresára > 'self'), DB je len
      // úložisko. Defaulty sú konzervatívne = správanie pred 6a.
      origin: opts?.origin ?? ORIGIN_SELF,
      trusted: opts?.trusted === false ? 0 : 1,
    };
    const existing =
      addr === null
        ? (this.stmtById.get({ id: event.id }) as { id: string } | undefined)
        : (this.stmtByAddr.get({ addr }) as { id: string } | undefined);
    const info = this.stmtUpsert.run(params);
    if (info.changes === 0) return 'ignored';
    return existing === undefined ? 'inserted' : 'replaced';
  }

  /** Dávka v jednej transakcii — vráti počty podľa výsledku. */
  upsertMany(
    events: NostrEvent[],
    opts?: { insertedAt?: number },
  ): { inserted: number; replaced: number; ignored: number } {
    const counters = { inserted: 0, replaced: 0, ignored: 0 };
    const tx = this.db.transaction((list: NostrEvent[]) => {
      for (const event of list) {
        counters[this.upsertEvent(event, opts)] += 1;
      }
    });
    tx(events);
    return counters;
  }

  count(): number {
    return (this.stmtCount.get() as { n: number }).n;
  }

  maxCreatedAt(maxBoundS?: number): number {
    // B1: s hornou hranicou ignorujeme ridky s `created_at` ďaleko v
    // budúcnosti (junk), ktoré by inak ukotvili anti-entropický
    // since-sweep nad všetkým skutočným obsahom. Bez hranice = doslovné
    // maximum (štatistiky).
    if (maxBoundS === undefined) {
      return (this.stmtMaxCreated.get() as { m: number }).m;
    }
    return (this.stmtMaxCreatedBounded.get({ max: maxBoundS }) as { m: number }).m;
  }

  /** Posledných `limit` id podľa zápisu do DB (pre anti-entropiu). */
  recentIds(limit: number): string[] {
    const rows = this.stmtRecentIds.all({ limit: Math.max(1, Math.floor(limit)) }) as Array<{
      id: string;
    }>;
    return rows.map((row) => row.id);
  }

  idsOfKind(kind: number): string[] {
    const rows = this.stmtIdsOfKind.all({ kind }) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getEvent(id: string): EventRow | null {
    const row = this.stmtGet.get({ id }) as EventRow | undefined;
    return row === undefined ? null : row;
  }

  /** Event rekonštruovaný pre čítanie (tags z JSONu), null ak neexistuje. */
  getNostrEvent(id: string): NostrEvent | null {
    const row = this.getEvent(id);
    if (row === null) return null;
    return {
      id: row.id,
      pubkey: row.pubkey,
      created_at: row.created_at,
      kind: row.kind,
      tags: JSON.parse(row.tags_json) as NostrTag[],
      content: row.content,
      sig: row.sig,
    };
  }

  hasEvent(id: string): boolean {
    return this.stmtById.get({ id }) !== undefined;
  }

  /**
   * FTS5 dotaz: `match` sa bezpečne naženie cez `buildMatchQuery` (ak nie je
   * `rawMatch`), triedenie BM25 (`rank`), voliteľný filter kind/čas a
   * `snippet()` zo stĺpca content.
   */
  search(match: string, opts?: SearchOptions): SearchHit[] {
    const query = opts?.rawMatch === true ? match : buildMatchQuery(match);
    if (query === '') return [];
    const limit = Math.max(1, Math.min(500, opts?.limit ?? 25));
    const withSnippet = opts?.snippet === true;
    const kinds = opts?.kinds !== undefined && opts.kinds.length > 0 ? [...opts.kinds] : undefined;
    // F4AI-2b2: `lang` filter — prázdne/`any` = všetky jazyky (žiadny WHERE)
    const lang = opts?.lang !== undefined && opts.lang !== null && opts.lang !== 'any' ? opts.lang : undefined;
    // Phase 6a (dizajn Q5): `origin` filter — `'any'`/undefined = bez filtra.
    // Default MUSÍ byť „bez filtra": E2E zo dizajnu Q5 očakáva, že
    // `GET /search?q=<uuid>` bez parametrov nájde vlákno druhej inštancie.
    const origin =
      opts?.origin !== undefined && opts.origin !== null && opts.origin !== 'any' ? opts.origin : undefined;
    // DB pred 6a nemá stĺpec `origin` a read-only pripojenie nemôže
    // migrovať. Význam je jasný: v takom indexe je LEN vlastný obsah,
    // takže `origin=self` je pravda pre všetky riadky a cudzie id nemá
    // žiadny zásah — vrátime prázdny výsledok namiesto chyby.
    if (origin !== undefined && !this.hasOriginColumns && origin !== ORIGIN_SELF) return [];
    const cacheKey = JSON.stringify([
      withSnippet,
      kinds ?? null,
      opts?.since ?? null,
      opts?.until ?? null,
      lang ?? null,
      origin ?? null,
      this.hasOriginColumns,
    ]);
    let statement = this.searchCache.get(cacheKey);
    if (statement === undefined) {
      const where: string[] = ['events_fts MATCH ?'];
      if (kinds !== undefined) where.push(`e.kind IN (${kinds.map(() => '?').join(', ')})`);
      if (opts?.since !== undefined) where.push('e.created_at >= ?');
      if (opts?.until !== undefined) where.push('e.created_at <= ?');
      if (lang !== undefined) where.push('e.lang = ?');
      if (origin !== undefined && this.hasOriginColumns) where.push('e.origin = ?');
      const projection = this.hasOriginColumns ? ', e.origin, e.trusted' : '';
      const sql = `
        SELECT e.id, e.pubkey, e.kind, e.created_at, e.content, e.tags_json, e.lang${projection},
               events_fts.rank AS score
               ${withSnippet ? ", snippet(events_fts, 0, '[', ']', ' … ', 12) AS snippet" : ''}
        FROM events_fts
        JOIN events e ON e.rowid = events_fts.rowid
        WHERE ${where.join(' AND ')}
        ORDER BY events_fts.rank
        LIMIT ?
      `;
      statement = this.db.prepare(sql);
      this.searchCache.set(cacheKey, statement);
    }
    const bind: Array<string | number> = [query];
    if (kinds !== undefined) bind.push(...kinds);
    if (opts?.since !== undefined) bind.push(opts.since);
    if (opts?.until !== undefined) bind.push(opts.until);
    if (lang !== undefined) bind.push(lang);
    if (origin !== undefined && this.hasOriginColumns) bind.push(origin);
    bind.push(limit);
    const rows = statement.all(...bind) as Array<{
      id: string;
      pubkey: string;
      kind: number;
      created_at: number;
      content: string;
      tags_json: string;
      lang: string | null;
      origin?: string;
      trusted?: number;
      score: number;
      snippet?: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      pubkey: row.pubkey,
      kind: row.kind,
      created_at: row.created_at,
      content: row.content,
      tags: JSON.parse(row.tags_json) as NostrTag[],
      score: row.score,
      lang: typeof row.lang === 'string' ? row.lang : null,
      // Phase 6a: fallback na 'self'/true je pre read-only DB pred 6a —
      // indexer (writer) migroval a má skutočné hodnoty
      origin: typeof row.origin === 'string' ? row.origin : ORIGIN_SELF,
      trusted: typeof row.trusted === 'number' ? row.trusted === 1 : true,
      ...(row.snippet !== undefined ? { snippet: row.snippet } : {}),
    }));
  }

  /**
   * Diagnostika: počty, rozloženie kindov, stav FTS indexu. `fts_rows` sa
   * má rovnať `events` — rozdiel signalizuje rozpad triggerov (na istotu je
   * tu `ftsIntegrityCheck()`).
   */
  stats(): IndexerStats {
    const base = this.stmtStats.get() as {
      events: number;
      max_created_at: number;
      replaceable_rows: number;
    };
    const byKind = this.stmtStatsKinds.all() as Array<{ kind: number; count: number }>;
    const fts = this.stmtStatsFts.get() as { n: number };
    // Phase 6a: rozloženie pôvodu — len keď stĺpec existuje (read-only DB
    // pred 6a ho nemá a `stats()` sa volá aj z `indexer status`)
    const byOrigin = this.hasOriginColumns
      ? (this.db
          .prepare(
            `SELECT origin, count(*) AS count, MAX(trusted) AS trusted
             FROM events GROUP BY origin ORDER BY count DESC, origin ASC`,
          )
          .all() as Array<{ origin: string; count: number; trusted: number }>)
      : undefined;
    return {
      events: base.events,
      by_kind: byKind,
      replaceable_rows: base.replaceable_rows,
      max_created_at: base.max_created_at,
      fts_rows: fts.n,
      ...(byOrigin !== undefined ? { by_origin: byOrigin } : {}),
    };
  }

  /**
   * FTS5 `integrity-check` — overí, že index sedí s obsahom `events`
   * (triggery neodpadli). Pri probleme hodí SqliteError.
   */
  ftsIntegrityCheck(): void {
    this.db.prepare("INSERT INTO events_fts(events_fts) VALUES('integrity-check')").run();
  }

  /** Plný prebuild FTS indexu (pre S8; pri malých DB zbytočné). */
  ftsRebuild(): void {
    this.db.prepare("INSERT INTO events_fts(events_fts) VALUES('rebuild')").run();
  }

  /** EXPLAIN QUERY PLAN — testy dokladujú, že sa používajú indexy. */
  queryPlan(sql: string, ...bind: Array<string | number>): string[] {
    const rows = this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bind) as Array<{
      detail: string;
    }>;
    return rows.map((row) => row.detail);
  }

  /**
   * Phase 6a: kurzor/voliteľná hodnota v `indexer_meta`. Read-only pripojenie
   * DB založenej pred 6a nemá tabuľku `indexer_meta` — vrátime null namiesto
   * chyby, aby `indexer status` nespadol na starej DB.
   */
  getMeta(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM indexer_meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row === undefined ? null : row.value;
    } catch {
      return null;
    }
  }

  /** Phase 6a: uloží kurzor (writer — indexer je jediný writer tejto DB). */
  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO indexer_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  close(): void {
    if (!this.db.open) return;
    this.db.close();
  }
}

/** Otvorí (alebo vytvorí) indexer DB — helper pre CLI aj testy. */
export function openIndexerDb(path: string, opts?: { readonly?: boolean }): IndexerDb {
  return new IndexerDb(path, opts);
}
