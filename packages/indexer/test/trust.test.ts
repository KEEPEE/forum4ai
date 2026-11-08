/**
 * Testy `INDEXER_TRUST_DIRECTORIES` (Phase 6a, dizajn Q5) — dôvera cudzím
 * adresárom pisúcich.
 *
 * Kľúčová semantika, ktorú tento test zamyká (dizajn Q5 je záväzný):
 *  1. cudzí adresár rozšíri **indexový** allowlist (cudzí obsah sa MUSÍ
 *     dať nájsť), ale NIKDY nie write-gate gatewaya (A-owner nesmie písať
 *     do B — E2E krok 7 to cvičí na 403),
 *  2. author z cudzieho adresára dostane v indexe `origin = <id inštancie>`
 *     a `trusted = 0`; domáci author ostáva `self` / `trusted = 1`,
 *  3. bez nastaveného env sa indexer správa BYTE-IDENTICKY ako pred 6a
 *     (`enabled === false`, žiadne siete, všetky eventy `self`/`trusted=1`),
 *  4. id inštancie sa volí v poradi explicitný config > `["gateway", …]`
 *     tag adresára > `dir:<prvých 8 hex>` — nikdy to nie je relay URL.
 *
 * `originFor` je súkromné, preto sa id overuje cez verejné `lookup()` /
 * `originOf()` — presne tak, ako to číta ingest.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import { describe, expect, it } from 'vitest';

import { AGENTS_D_TAG, KINDS, WRITERS_D_TAG } from '@forum4ai/shared';

import { resolveIndexerConfig, type IndexerConfig } from '../src/config.js';
import { IndexerDb } from '../src/db.js';
import { IndexerIngestor, type IngestPool } from '../src/ingest.js';
import { WriterAllowlist } from '../src/operators.js';
import {
  hostFromGatewayTag,
  parseTrustDirectories,
  TrustDirectories,
  TRUST_REFRESH_MS_DEFAULT,
} from '../src/trust.js';

/** `NOW` MUSÍ byť relatívne k reálnemu času: `refresh()` porovnáva
 *  `expires_at` s `Date.now()/1000`, takže fixný timestamp z roku 2024 by
 *  bol „expirovaný" aj pre operátora s budúcou platnosťou */
const NOW = Math.floor(Date.now() / 1000) - 3_600;
/** `expires_at` MUSÍ byť v budúcnosti IN REÁLNOM ČASE, inak `refresh()`
 *  označí operátora za expirovaného a jeho agenti sa nedôverujú */
const FUTURE = Math.floor(Date.now() / 1000) + 3_600;

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function secretOf(hex: string): Uint8Array {
  return Buffer.from(hex, 'hex');
}

// PUBLKEYY musia ODPOVEDAŤ svojim secretom — `pickLatest` filtruje
// `event.pubkey === owner`, takže podpis cudzím kľúčom by sa tváril ako
// „žiadny adresár" a test by meral niečo iné
const KEY_A = secretOf(HEX_A);
const KEY_B = generateSecretKey();
const KEY_EXPIRED = generateSecretKey();
const KEY_HOME = generateSecretKey();

const OWNER_A = getPublicKey(KEY_A).toLowerCase();
const OPERATOR_B = getPublicKey(KEY_B).toLowerCase();
const OPERATOR_EXPIRED = getPublicKey(KEY_EXPIRED).toLowerCase();
const AGENT_C = getPublicKey(generateSecretKey()).toLowerCase();
const UNKNOWN_D = getPublicKey(generateSecretKey()).toLowerCase();

/** 30028 `d=forum4ai-writers` podpísaný vlastníkom adresára */
function writersEvent(
  ownerKey: Uint8Array,
  tags: string[][],
  created_at: number = NOW - 100,
): Event {
  return finalizeEvent(
    { kind: KINDS.NODE_DIRECTORY, created_at, tags: [['d', WRITERS_D_TAG], ...tags], content: '' },
    ownerKey,
  ) as unknown as Event;
}

function agentsEvent(operatorKey: Uint8Array, agents: string[]): Event {
  return finalizeEvent(
    {
      kind: KINDS.NODE_DIRECTORY,
      created_at: NOW - 90,
      tags: [['d', AGENTS_D_TAG], ...agents.map((agent) => ['p', agent])],
      content: '',
    },
    operatorKey,
  ) as unknown as Event;
}

/** falošné relays: odpovedá na filtre mapou `author+d-tag → event` */
function queryOf(index: Map<string, Event[]>) {
  return async (filters: Filter[]): Promise<Event[]> => {
    const filter = filters[0];
    if (filter === undefined) return [];
    const author = filter.authors?.[0] ?? '';
    const dTag = filter['#d']?.[0] ?? '';
    const found = index.get(`${author}|${dTag}`) ?? [];
    if (filter.kinds !== undefined && !filter.kinds.includes(KINDS.NODE_DIRECTORY)) return [];
    return found;
  };
}

// ── parseTrustDirectories ──────────────────────────────────────────────────

describe('parseTrustDirectories — tvar `INDEXER_TRUST_DIRECTORIES`', () => {
  it('bare hex = odvodené id, `id=hex` = explicitné id (lowercase)', () => {
    const parsed = parseTrustDirectories(`${HEX_A}  aiforum.myhood.sk=${HEX_B}`);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.directories).toEqual([
      { id: '', idExplicit: false, owner: HEX_A },
      { id: 'aiforum.myhood.sk', idExplicit: true, owner: HEX_B },
    ]);
  });

  it('oddeľovače sú čiarka, medzera aj newline (kvôli compose súborm)', () => {
    const parsed = parseTrustDirectories(`${HEX_A},${HEX_B}\n  ${'c'.repeat(64)}`);
    expect(parsed.directories).toHaveLength(3);
  });

  it('preklep zahodí LEN tú ktorú položku — zvyšok dôvery pretrvá', () => {
    const parsed = parseTrustDirectories(`${HEX_A} zle-tu aiforum.myhood.sk=modra`);
    expect(parsed.directories.map((dir) => dir.owner)).toEqual([HEX_A]);
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[0]).toContain('"zle-tu"');
  });

  it('duplicitný owner sa ponechá prvýkrát (dve id na tú istú adresu = nejednoznačný pôvod)', () => {
    const parsed = parseTrustDirectories(`${HEX_A} druhe.example=${HEX_A}`);
    expect(parsed.directories).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('duplicated');
  });

  it('prázdny env = žiadne adresáre, žiadne varovania (pred 6a)', () => {
    expect(parseTrustDirectories(undefined)).toEqual({ directories: [], warnings: [] });
    expect(parseTrustDirectories('   ')).toEqual({ directories: [], warnings: [] });
  });
});

describe('hostFromGatewayTag — normalizácia `["gateway", …]`', () => {
  it('oberie schému, cestu a lomenítko; large- a small-case jednotne', () => {
    expect(hostFromGatewayTag('https://AiForum.MyHood.sk/api/')).toBe('aiforum.myhood.sk');
    expect(hostFromGatewayTag('ws://127.0.0.1:18081')).toBe('127.0.0.1:18081');
    expect(hostFromGatewayTag('gateway.example')).toBe('gateway.example');
    expect(hostFromGatewayTag('')).toBe('');
    expect(hostFromGatewayTag(undefined)).toBe('');
  });
});

// ── TrustDirectories.refresh ───────────────────────────────────────────────

describe('TrustDirectories — adresáre, pôvod a throttle', () => {
  it('bez adresárov je vypnutý a `refresh()` nesľubuje nič (žiadna sieť)', async () => {
    const trust = new TrustDirectories();
    expect(trust.enabled).toBe(false);
    expect(await trust.refresh()).toMatchObject({ skipped: 'disabled', pubkeys: 0 });
    expect(await trust.maybeRefresh()).toBeNull();
  });

  it('s adresármi ale bez `query` = skipped `no-query` (test bez siete)', async () => {
    const trust = new TrustDirectories({ directories: [{ id: '', idExplicit: false, owner: HEX_A }] });
    expect(trust.enabled).toBe(true);
    expect(await trust.refresh()).toMatchObject({ skipped: 'no-query' });
  });

  it('mapuje owner → operator → agent a priradí IM ORIGIN adresára', async () => {
    const index = new Map<string, Event[]>([
      [
        `${OWNER_A}|${WRITERS_D_TAG}`,
        [
          writersEvent(KEY_A, [
            ['gateway', 'https://aiforum.myhood.sk/api'],
            ['p', OPERATOR_B, 'ws://127.0.0.1:18080', String(FUTURE), 'member'],
          ]),
        ],
      ],
      [`${OPERATOR_B}|${AGENTS_D_TAG}`, [agentsEvent(KEY_B, [AGENT_C])]],
    ]);
    const trust = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: OWNER_A }],
      query: queryOf(index),
    });

    const summary = await trust.refresh();
    expect(summary).toMatchObject({ directories: 1, pubkeys: 3, warnings: [] });
    expect(trust.lookup(OWNER_A)).toMatchObject({ origin: 'aiforum.myhood.sk', role: 'owner' });
    expect(trust.lookup(OPERATOR_B)).toMatchObject({ origin: 'aiforum.myhood.sk', role: 'operator' });
    expect(trust.lookup(AGENT_C)).toMatchObject({ origin: 'aiforum.myhood.sk', role: 'agent' });
    // domáceho pisúceho adresár nepozná → ingest z neho urobí 'self'
    expect(trust.lookup(UNKNOWN_D)).toBeNull();
    expect(trust.originOf(UNKNOWN_D)).toBeNull();
    expect([...trust.pubkeys()].sort()).toEqual([AGENT_C, OPERATOR_B, OWNER_A].sort());
  });

  it('pôvod: explicitné id > gateway tag > `dir:<8hex>`', async () => {
    const index = new Map<string, Event[]>([
      [`${OWNER_A}|${WRITERS_D_TAG}`, [writersEvent(KEY_A, [['gateway', 'http://inokde.example:18081'], ['p', OPERATOR_B]])]],
    ]);
    const withExplicit = new TrustDirectories({
      directories: [{ id: 'Muj.Domena.SK', idExplicit: true, owner: OWNER_A }],
      query: queryOf(index),
    });
    await withExplicit.refresh();
    expect(withExplicit.originOf(OPERATOR_B)).toBe('muj.domena.sk');

    const fromTag = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: OWNER_A }],
      query: queryOf(index),
    });
    await fromTag.refresh();
    expect(fromTag.originOf(OPERATOR_B)).toBe('inokde.example:18081');

    const noTag = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: OWNER_A }],
      query: queryOf(new Map([[`${OWNER_A}|${WRITERS_D_TAG}`, [writersEvent(KEY_A, [['p', OPERATOR_B]])]]])),
    });
    await noTag.refresh();
    // bez gateway tagu MUSÍ zostať deterministické id — nikdy to nie je
    // relay URL (peer by si z nej pomýlil inštanciu s relayom)
    expect(noTag.originOf(OPERATOR_B)).toBe(`dir:${OWNER_A.slice(0, 8)}`);
  });

  it('expirovaný operátor sa INDEXUJE, ale jeho agenti už nedôverujú', async () => {
    const index = new Map<string, Event[]>([
      [
        `${OWNER_A}|${WRITERS_D_TAG}`,
        [writersEvent(KEY_A, [['gateway', 'gateway.example'], ['p', OPERATOR_EXPIRED, '', String(NOW - 10), 'member']])],
      ],
      [`${OPERATOR_EXPIRED}|${AGENTS_D_TAG}`, [agentsEvent(KEY_EXPIRED, [AGENT_C])]],
    ]);
    const trust = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: OWNER_A }],
      query: queryOf(index),
    });
    await trust.refresh();
    expect(trust.has(OPERATOR_EXPIRED)).toBe(true);
    expect(trust.has(AGENT_C)).toBe(false);
  });

  it('chýbajúci 30028 = varovanie s napovedou (router stream-down), nie ticho', async () => {
    const trust = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: HEX_A }],
      query: async () => [],
    });
    const summary = await trust.refresh();
    expect(summary.directories).toBe(0);
    expect(summary.pubkeys).toBe(0);
    expect(summary.warnings[0]).toContain('strfry router');
    expect(trust.currentWarnings()).toEqual(summary.warnings);
  });

  it('`maybeRefresh()` rešpektuje `refreshMs` (ingest kolečko nesmie šliapať relay)', async () => {
    let clock = 1_000_000;
    let calls = 0;
    const trust = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: HEX_A }],
      query: async () => {
        calls += 1;
        return [];
      },
      refreshMs: 60_000,
      now: () => clock,
    });
    expect(await trust.maybeRefresh()).not.toBeNull(); // prvý raz vždy
    expect(calls).toBe(1);
    clock += 59_000;
    expect(await trust.maybeRefresh()).toBeNull(); // ešte nie je čas
    expect(calls).toBe(1);
    clock += 2_000;
    expect(await trust.maybeRefresh()).not.toBeNull();
    expect(calls).toBe(2);
    // default je 5 minút — nie každé kolečko
    expect(TRUST_REFRESH_MS_DEFAULT).toBe(300_000);
  });

  it('zlyhanie `query` neshodí mapu — varovanie a predchádzajúca mapa ostáva', async () => {
    const index = new Map<string, Event[]>([
      [`${OWNER_A}|${WRITERS_D_TAG}`, [writersEvent(KEY_A, [['gateway', 'gateway.example'], ['p', OPERATOR_B]])]],
    ]);
    const trust = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: OWNER_A }],
      query: queryOf(index),
    });
    await trust.refresh();
    expect(trust.has(OPERATOR_B)).toBe(true);

    const broken = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: OWNER_A }],
      query: async () => {
        throw new Error('relay timeout');
      },
    });
    const summary = await broken.refresh();
    expect(summary.warnings[0]).toContain('relay timeout');
    // mapa tohto objektu je prázdna (nikto ju neuspisal), ale `refresh()`
    // NEHAĐE — ingest by inak zastavil na jednej mŕtvej relays
    expect(summary.pubkeys).toBe(0);
  });
});

// ── WriterAllowlist: index áno, write-gate nie ─────────────────────────────

describe('WriterAllowlist — cudzí adresár rozšíri LEN index', () => {
  function allowlistWith(trust: TrustDirectories | null): WriterAllowlist {
    return new WriterAllowlist({
      allow: [HEX_A],
      operatorsDbPath: null,
      ...(trust === null ? {} : { trust }),
    });
  }

  it('pubkey z adresára prejde indexovým filtrom a počítava sa ako trust hit', async () => {
    const index = new Map<string, Event[]>([
      [`${OWNER_A}|${WRITERS_D_TAG}`, [writersEvent(KEY_A, [['gateway', 'gateway.example'], ['p', OPERATOR_B]])]],
    ]);
    const trust = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: OWNER_A }],
      query: queryOf(index),
    });
    await trust.refresh();

    const allow = allowlistWith(trust);
    expect(allow.isAllowed(OPERATOR_B)).toBe(true);
    expect(allow.trustHitCount).toBe(1);
    // neznámy pubkey neschytá ani bootstrap, ani trust
    expect(allow.isAllowed(UNKNOWN_D)).toBe(false);
    expect(allow.trustHitCount).toBe(1);
  });

  it('bez trust zdroja je allowlist presne ten, čo pred 6a (žiadne cudzie pubkeyy)', () => {
    const allow = allowlistWith(null);
    expect(allow.isAllowed(HEX_A)).toBe(true);
    expect(allow.isAllowed(OPERATOR_B)).toBe(false);
    expect(allow.trustHitCount).toBe(0);
  });
});

// ── ingest: origin / trusted stĺpce ────────────────────────────────────────

describe('ingest — `origin` a `trusted` v indexe', () => {
  class FakePool implements IngestPool {
    readonly urls = ['ws://fake-a'];
    readonly events: Event[] = [];

    publish(event: Event): void {
      this.events.push(event);
    }

    connectAll(): Promise<unknown> {
      return Promise.resolve([]);
    }

    close(): void {
      /* test */
    }

    async query(filters: Filter[]): Promise<Event[]> {
      const out: Event[] = [];
      for (const filter of filters) {
        for (const event of this.events) {
          if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) continue;
          if (filter.since !== undefined && event.created_at < filter.since) continue;
          if (filter.until !== undefined && event.created_at > filter.until) continue;
          if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) continue;
          out.push(event);
        }
      }
      return out;
    }

    subscribe(): () => void {
      return () => undefined;
    }
  }

  function testConfig(overrides: Record<string, string> = {}): IndexerConfig {
    return resolveIndexerConfig({
      INDEXER_DB: ':memory:',
      INDEXER_RELAY_URLS: 'ws://fake-a',
      INDEXER_BACKFILL_BATCH: '5',
      INDEXER_ANTI_ENTROPY_INTERVAL_S: '0',
      INDEXER_LIVE_OVERLAP_S: '7200',
      INDEXER_QUERY_TIMEOUT_MS: '500',
      INDEXER_QUIET: '1',
      ...overrides,
    });
  }

  function post(authorKey: Uint8Array, content: string, created_at: number): Event {
    return finalizeEvent({ kind: KINDS.QUESTION, created_at, tags: [], content }, authorKey) as unknown as Event;
  }

  it('cudzí author = `origin = <id>` a `trusted = 0`; domáci = `self` / `1`', async () => {
    const index = new Map<string, Event[]>([
      [`${OWNER_A}|${WRITERS_D_TAG}`, [writersEvent(KEY_A, [['gateway', 'aiforum.myhood.sk'], ['p', OPERATOR_B]])]],
    ]);
    const trust = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: OWNER_A }],
      query: queryOf(index),
    });
    await trust.refresh();

    const pool = new FakePool();
    pool.publish(post(KEY_B, 'cudzia otazka z A-instances', NOW - 50));
    pool.publish(post(KEY_HOME, 'domaca otazka', NOW - 40));

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig(), trust, fed: null });
    await ingestor.start();

    const foreign = db.getEvent(post(KEY_B, 'cudzia otazka z A-instances', NOW - 50).id);
    expect(foreign).not.toBeNull();
    expect(foreign?.origin).toBe('aiforum.myhood.sk');
    expect(foreign?.trusted).toBe(0);

    const home = db.getEvent(post(KEY_HOME, 'domaca otazka', NOW - 40).id);
    expect(home?.origin).toBe('self');
    expect(home?.trusted).toBe(1);

    expect(ingestor.snapshot().remoteIndexed).toBe(1);
    expect(ingestor.trustStatus()).toMatchObject({ enabled: true, directories: 1, pubkeys: 2 });
    ingestor.stop();
    db.close();
  });

  it('bez `INDEXER_TRUST_DIRECTORIES` = byte-identické správanie pred 6a', async () => {
    const pool = new FakePool();
    const foreign = post(KEY_B, 'otazka od niekoho', NOW - 30);
    pool.publish(foreign);

    const db = new IndexerDb(':memory:');
    const config = testConfig();
    expect(config.trustDirectories).toEqual([]);
    const ingestor = new IndexerIngestor({ db, pool, config });
    await ingestor.start();

    const row = db.getEvent(foreign.id);
    expect(row?.origin).toBe('self');
    expect(row?.trusted).toBe(1);
    expect(ingestor.snapshot().remoteIndexed).toBe(0);
    expect(ingestor.trustStatus()).toMatchObject({ enabled: false, directories: 0, pubkeys: 0 });
    ingestor.stop();
    db.close();
  });

  it('`by_origin` agreguje cudzí obsah podľa inštancie (diag. a filter pre UI)', async () => {
    const index = new Map<string, Event[]>([
      [`${OWNER_A}|${WRITERS_D_TAG}`, [writersEvent(KEY_A, [['gateway', 'aiforum.myhood.sk'], ['p', OPERATOR_B]])]],
    ]);
    const trust = new TrustDirectories({
      directories: [{ id: '', idExplicit: false, owner: OWNER_A }],
      query: queryOf(index),
    });
    await trust.refresh();

    const pool = new FakePool();
    pool.publish(post(KEY_B, 'cudzia 1', NOW - 20));
    pool.publish(post(KEY_B, 'cudzia 2', NOW - 19));
    pool.publish(post(KEY_HOME, 'domaca', NOW - 18));

    const db = new IndexerDb(':memory:');
    const ingestor = new IndexerIngestor({ db, pool, config: testConfig(), trust, fed: null });
    await ingestor.start();
    const rows = db.stats().by_origin ?? [];
    expect(rows.find((row) => row.origin === 'aiforum.myhood.sk')).toMatchObject({ count: 2, trusted: 0 });
    expect(rows.find((row) => row.origin === 'self')).toMatchObject({ count: 1, trusted: 1 });
    ingestor.stop();
    db.close();
  });
});
