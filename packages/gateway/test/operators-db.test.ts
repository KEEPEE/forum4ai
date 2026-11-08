/**
 * Unit testy `operators-db.ts` (dizajn B5/B7, P1) — CACHE tabuľka, ktorú
 * vlastní gateway. Testy injectnú hodiny, takže expirácia (30 dní) aj
 * re-sampling lehota (7 dní) sa dajú skúmať bez spánku.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OperatorsDb, openOperatorsDb } from '../src/operators-db.js';
import { MAX_FAILED_CHECKS, REGISTRATION_TTL_S, RESAMPLE_INTERVAL_S } from '../src/writers.js';

const DAY_S = 24 * 60 * 60;
const T0 = 1_730_000_000;

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const AGENT = 'd'.repeat(64);

let clock = T0;
let db: OperatorsDb;

beforeEach(() => {
  clock = T0;
  db = openOperatorsDb(':memory:', { now: () => clock });
});

afterEach(() => {
  db.close();
});

describe('schema a základné zápisy', () => {
  it('schéma drží CHECK na stavoch a meta kurzory', () => {
    expect(db.get(A)).toBeNull();
    db.setMeta('writers_event_id', 'f'.repeat(64));
    expect(db.getMeta('writers_event_id')).toBe('f'.repeat(64));
    db.setMeta('writers_event_id', 'e'.repeat(64));
    expect(db.getMeta('writers_event_id')).toBe('e'.repeat(64));
    expect(db.getMeta('neexistuje')).toBeNull();
    expect(() =>
      db.db.prepare("INSERT INTO operators (pubkey, status) VALUES (?, 'blbost')").run('1'.repeat(64)),
    ).toThrow();
  });

  it('upsertClaim → pending s 30-dňovou expiráciou a nulovým fail_count', () => {
    const row = db.upsertClaim({ pubkey: A.toUpperCase(), relay: 'wss://a.example/', claimId: 'c'.repeat(64) });
    expect(row.pubkey).toBe(A);
    expect(row.status).toBe('pending');
    expect(row.registeredAt).toBe(T0);
    expect(row.expiresAt).toBe(T0 + REGISTRATION_TTL_S);
    expect(row.failCount).toBe(0);
    expect(row.lastCheck).toBe(T0);
  });

  it('upsertClaim nad existujúcim pubkey resetuje fail_count a prepíše relay', () => {
    db.upsertClaim({ pubkey: A, relay: 'wss://a.example/', claimId: 'c'.repeat(64) });
    db.recordCheck(A, false);
    const row = db.upsertClaim({ pubkey: A, relay: 'wss://novy.example/', claimId: 'd'.repeat(64) });
    expect(row.relay).toBe('wss://novy.example/');
    expect(row.failCount).toBe(0);
    expect(row.claimId).toBe('d'.repeat(64));
  });

  it('setStatus neznáme pubkey → null (nikoho nevymyslíme)', () => {
    expect(db.setStatus(A, 'active')).toBeNull();
  });
});

describe('write-gate rozhranie (OperatorSource)', () => {
  it('active s expiráciou v minulosti → lapsed a prepíše sa natrvalo', () => {
    db.upsertClaim({ pubkey: A, relay: 'wss://a.example/', claimId: 'c'.repeat(64), status: 'active' });
    expect(db.operatorStatus(A)).toBe('active');
    clock = T0 + REGISTRATION_TTL_S + 1;
    expect(db.operatorStatus(A)).toBe('lapsed');
    // trvalé: aj ke hodiny vrátime späť, riadok už je lapsed
    clock = T0;
    expect(db.get(A)?.status).toBe('lapsed');
  });

  it('agent patrí len aktívnemu operátorovi', () => {
    db.upsertClaim({ pubkey: A, relay: 'wss://a.example/', claimId: 'c'.repeat(64), status: 'active' });
    db.setAgents(A, [AGENT.toUpperCase(), 'bad', AGENT]);
    expect(db.agentOf(AGENT)).toEqual({ operator: A });
    expect(db.agentOf(B)).toBeNull();
    db.setStatus(A, 'revoked');
    expect(db.agentOf(AGENT)).toBeNull();
  });

  it('setAgents zahodí neplatný hex a deduplikuje', () => {
    db.upsertClaim({ pubkey: A, relay: '', claimId: 'c'.repeat(64), status: 'active' });
    db.setAgents(A, [AGENT, AGENT, 'xy', 'e'.repeat(64)]);
    expect(db.get(A)?.agents).toEqual([AGENT, 'e'.repeat(64)]);
  });
});

describe('recordCheck — 3 zlyhania → lapsed (dizajn B7)', () => {
  beforeEach(() => {
    db.upsertClaim({ pubkey: A, relay: 'wss://a.example/', claimId: 'c'.repeat(64), status: 'active' });
  });

  it('zlýhanie počítá, úspech resetuje', () => {
    expect(db.recordCheck(A, false)).toBe('active');
    expect(db.get(A)?.failCount).toBe(1);
    expect(db.recordCheck(A, true)).toBe('active');
    expect(db.get(A)?.failCount).toBe(0);
  });

  it(`po ${String(MAX_FAILED_CHECKS)} zlýhaniach je operátor lapsed`, () => {
    for (let i = 1; i < MAX_FAILED_CHECKS; i += 1) {
      expect(db.recordCheck(A, false)).toBe('active');
    }
    expect(db.recordCheck(A, false)).toBe('lapsed');
    expect(db.get(A)?.status).toBe('lapsed');
    expect(db.activeWriters()).toEqual([]);
  });

  it('neznáme pubkey → null', () => {
    expect(db.recordCheck('9'.repeat(64), true)).toBeNull();
  });
});

describe('dueForResample (týždenná lehota)', () => {
  it('berie len active s last_check starším ako 7 dní', () => {
    db.upsertClaim({ pubkey: A, relay: 'wss://a.example/', claimId: 'c'.repeat(64), status: 'active' });
    db.upsertClaim({ pubkey: B, relay: 'wss://b.example/', claimId: 'd'.repeat(64), status: 'pending' });
    expect(db.dueForResample()).toEqual([]);
    clock = T0 + RESAMPLE_INTERVAL_S;
    expect(db.dueForResample().map((row) => row.pubkey)).toEqual([A]);
    // úspešná kontrola posunie last_check → operátor opäť nie je due
    db.recordCheck(A, true);
    expect(db.dueForResample()).toEqual([]);
  });
});

describe('applyWriters — tabuľka je cache 30028 (dizajn B5)', () => {
  it('aktivuje vypísaných a vypne (lapsed) tých, čo zoznam neobsahuje', () => {
    db.upsertClaim({ pubkey: A, relay: 'wss://a.example/', claimId: 'c'.repeat(64), status: 'active' });
    db.upsertClaim({ pubkey: B, relay: 'wss://b.example/', claimId: 'd'.repeat(64), status: 'pending' });
    const result = db.applyWriters([
      { pubkey: B, relay: 'wss://b.example/', registeredAt: T0 - 10, expiresAt: T0 + 100 },
    ]);
    expect(result).toEqual({ activated: 1, deactivated: 1 });
    expect(db.get(B)?.status).toBe('active');
    expect(db.get(B)?.expiresAt).toBe(T0 + 100);
    expect(db.get(A)?.status).toBe('lapsed');
  });

  it('revoked zostáva revoked (k tomu patrí 1040 LABEL, nie tichá zmena)', () => {
    db.upsertClaim({ pubkey: A, relay: 'wss://a.example/', claimId: 'c'.repeat(64), status: 'active' });
    db.setStatus(A, 'revoked', 'odisiel');
    db.applyWriters([]);
    expect(db.get(A)?.status).toBe('revoked');
    expect(db.get(A)?.note).toBe('odisiel');
  });

  it('activeWriters má tvar pre republish 30028', () => {
    db.upsertClaim({
      pubkey: A,
      relay: 'wss://a.example/',
      claimId: 'c'.repeat(64),
      status: 'active',
      registeredAt: T0 - DAY_S,
      expiresAt: T0 + DAY_S,
    });
    expect(db.activeWriters()).toEqual([
      { pubkey: A, relay: 'wss://a.example/', registeredAt: T0 - DAY_S, expiresAt: T0 + DAY_S },
    ]);
  });

  it('countByStatus súhrn pre `operator list`', () => {
    db.upsertClaim({ pubkey: A, relay: '', claimId: '1'.repeat(64), status: 'active' });
    db.upsertClaim({ pubkey: B, relay: '', claimId: '2'.repeat(64), status: 'pending' });
    expect(db.countByStatus()).toEqual({ active: 1, pending: 1, lapsed: 0, revoked: 0 });
  });
});
