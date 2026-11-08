/**
 * Unit testy čistej agregačnej vrstvy reputácie (F4AI-15, S9) —
 * `packages/gateway/src/reputation.ts`, bez siete a IO.
 *
 * Krytie podľa zadania + referenčných prípadov modelu (§6):
 *  - Wilson hranice: 0/0, 1/1, 50/100, záporná bilancia, žiadne >1,
 *    „1 hlas s váhou 3 neporazí 50 hlasov s váhou 1“
 *  - Kish n_eff: 5× váha 3 → 5 (nie 15)
 *  - cap škrtanie: 10 hlasov 1 agentu → váha max 0.5 z celku; cluster
 *    s `op` tagmi; prefix-cluster bez `op`; op_cap viazateľný samostatne
 *  - epoch filtr: staršia epocha → váha 0, aktuálna = max viditeľná
 *  - determinizmus ×10 pri zmene poradia vstupu (seeded PRNG)
 *  - per-doménová karta voter/author/helper + counts
 *  - parsovanie 1030 dir / 1031 skóre (1..5 aj 0..1)
 */
import { describe, expect, it } from 'vitest';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

import {
  AGENT_CAP_DEFAULT,
  CLUSTER_CAP_DEFAULT,
  OP_CAP_DEFAULT,
  WILSON_Z_DEFAULT,
  aggregateRatings,
  aggregateThreadRating,
  aggregateVotesPerTarget,
  capWeights,
  clusterKey,
  computeReputation,
  currentEpochOf,
  epochWeight,
  isReputationDomain,
  kishNEff,
  parseRatingScore,
  parseVoteDir,
  signalEpoch,
  signalOp,
  signalRootRef,
  signalTarget,
  toSignalItem,
  wilsonLowerBound,
  type SignalItem,
} from '../src/reputation.js';

// ── helpery ────────────────────────────────────────────────────────────────

function ev(
  id: string,
  pubkey: string,
  kind: number,
  tags: NostrTag[],
  content = '',
  created_at = 1_000,
): NostrEvent {
  return { id, pubkey, created_at, kind, tags, content, sig: '' };
}

/** deterministický shuffle (mulberry32) — testy musia byť replikovateľné */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const swap = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = swap;
  }
  return copy;
}

const PK1 = 'a'.repeat(64);
const PK2 = 'b'.repeat(64);
const PK3 = 'c'.repeat(64);
const PK4 = 'd'.repeat(64);
/** PK5/PK6 zdieľajú prvých 8 hex znakov → rovnaký prefix-cluster bez `op` */
const PK5 = 'eeeeeeeef'.padEnd(64, '0');
const PK6 = 'eeeeeeeef'.padEnd(64, '1');

function vote(
  id: string,
  pubkey: string,
  target: string,
  dir: 1 | -1,
  extra: { op?: string; epoch?: number } = {},
): SignalItem & { dir: 1 | -1; target: string } {
  return {
    id,
    pubkey,
    op: extra.op ?? null,
    epoch: extra.epoch ?? null,
    weight: 1,
    dir,
    target,
  };
}

// ── Wilson lower bound ─────────────────────────────────────────────────────

describe('wilsonLowerBound', () => {
  it('default z je 1.96 a parametre sedí so zadaním', () => {
    expect(WILSON_Z_DEFAULT).toBe(1.96);
    expect(AGENT_CAP_DEFAULT).toBe(0.5);
    expect(CLUSTER_CAP_DEFAULT).toBe(0.15);
    expect(OP_CAP_DEFAULT).toBe(0.25);
  });

  it('0 hlasov → 0 (model §6: nie na vrchole, ani pod nulou)', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 10)).toBe(0);
  });

  it('1/1 → ≈0.2065 (malá istota, nie 1)', () => {
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.20654, 4);
  });

  it('50/100 → ≈0.40383', () => {
    expect(wilsonLowerBound(50, 100)).toBeCloseTo(0.40383, 4);
  });

  it('záporná bilancia (0 kladných z 5) → 0, nikdy záporné', () => {
    expect(wilsonLowerBound(0, 5)).toBe(0);
    expect(wilsonLowerBound(-3, 5)).toBe(0);
  });

  it('nikdy >1 (Lobsters „confidence > 1“ chyba)', () => {
    const all = wilsonLowerBound(100, 100);
    expect(all).toBeGreaterThan(0.9);
    expect(all).toBeLessThan(1);
    // necelé pos nad total → p sa clampa na 1, výsledok stále ≤ 1
    expect(wilsonLowerBound(150, 100)).toBeLessThanOrEqual(1);
  });

  it('monotónnosť v pos aj total', () => {
    expect(wilsonLowerBound(3, 10)).toBeLessThan(wilsonLowerBound(4, 10));
    expect(wilsonLowerBound(4, 10)).toBeLessThan(wilsonLowerBound(5, 10));
    // rovnaký pomer, viac dôkazov → istota rastie (model §6 „všetky hlasy
    // rovnaké: C rastie s n_eff, nie s pomerom 100 %“)
    expect(wilsonLowerBound(50, 100)).toBeGreaterThan(wilsonLowerBound(5, 10));
  });

  it('1 hlas s váhou 3 neporazí 50 hlasov s váhou 1 (model §6)', () => {
    expect(wilsonLowerBound(3, 3)).toBeLessThan(wilsonLowerBound(50, 50));
  });

  it('neplatné vstupy → 0', () => {
    expect(wilsonLowerBound(Number.NaN, 10)).toBe(0);
    expect(wilsonLowerBound(5, Number.POSITIVE_INFINITY)).toBe(0);
    expect(wilsonLowerBound(5, 10, 0)).toBe(0);
  });
});

// ── Kish n_eff ─────────────────────────────────────────────────────────────

describe('kishNEff', () => {
  it('prázdny vstup → 0', () => {
    expect(kishNEff([])).toBe(0);
  });

  it('rovnaké váhy 1 → počet', () => {
    expect(kishNEff([1, 1, 1])).toBe(3);
  });

  it('5 hlasov s váhou 3 → n_eff 5, nie 15 (model §2.2)', () => {
    expect(kishNEff([3, 3, 3, 3, 3])).toBeCloseTo(5, 10);
  });

  it('45 hlasov s váhou 1/3 → n_eff 45 (istota je v počte, nie v súčte)', () => {
    expect(kishNEff(Array.from({ length: 45 }, () => 1 / 3))).toBeCloseTo(45, 6);
  });

  it('ne-kladné a ne-konečné váhy sa ignorujú', () => {
    expect(kishNEff([2, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])).toBeCloseTo(1, 10);
  });
});

// ── epoch watermark ────────────────────────────────────────────────────────

describe('epoch', () => {
  it('currentEpochOf = max viditeľná hodnota, null bez epochovaných eventov', () => {
    const events = [
      ev('e1', PK1, KINDS.VOTE, [['e', 't1'], ['epoch', '3']]),
      ev('e2', PK2, KINDS.VOTE, [['e', 't1'], ['epoch', '7']]),
      ev('e3', PK3, KINDS.VOTE, [['e', 't1']]),
    ];
    expect(currentEpochOf(events)).toBe(7);
    expect(currentEpochOf([ev('e3', PK3, KINDS.VOTE, [['e', 't1']])])).toBeNull();
  });

  it('staršia epocha → váha 0; aktuálna a bez-epochová → 1', () => {
    expect(epochWeight(6, 7)).toBe(0);
    expect(epochWeight(7, 7)).toBe(1);
    expect(epochWeight(null, 7)).toBe(1);
    expect(epochWeight(3, null)).toBe(1);
  });

  it('ne-parsovateľná epoch hodnota = bez epochy (tolerancia zdokumentovaná)', () => {
    expect(signalEpoch([['epoch', 'abc']])).toBeNull();
    expect(signalEpoch([['epoch', '-1']])).toBeNull();
    expect(signalEpoch([['epoch', '42']])).toBe(42);
  });

  it('toSignalItem uplatní epoch filter na raw váhe', () => {
    const old = ev('e1', PK1, KINDS.VOTE, [['e', 't1'], ['epoch', '1']]);
    const fresh = ev('e2', PK2, KINDS.VOTE, [['e', 't1'], ['epoch', '2']]);
    expect(toSignalItem(old, 2).weight).toBe(0);
    expect(toSignalItem(fresh, 2).weight).toBe(1);
  });
});

// ── tag parsovanie ─────────────────────────────────────────────────────────

describe('signál tagy', () => {
  it('cieľ = e tag bez root markera, rootRef = root marker', () => {
    const tags: NostrTag[] = [
      ['e', 'target1', ''],
      ['e', 'root1', 'root'],
      ['op', 'operater-x'],
      ['epoch', '5'],
    ];
    expect(signalTarget(tags)).toBe('target1');
    expect(signalRootRef(tags)).toBe('root1');
    expect(signalOp(tags)).toBe('operater-x');
    expect(signalEpoch(tags)).toBe(5);
  });

  it('ak existuje len root marker, cieľom je jeho hodnota (fallback)', () => {
    expect(signalTarget([['e', 'root1', 'root']])).toBe('root1');
    expect(signalTarget([])).toBeNull();
    expect(signalRootRef([['e', 'x', '']])).toBeNull();
  });

  it('clusterKey: op má prednosť, inak 8-hex prefix pubkey', () => {
    expect(clusterKey(PK1, 'opX')).toBe('op:opX');
    expect(clusterKey(PK1, null)).toBe(`pfx:${PK1.slice(0, 8)}`);
    expect(clusterKey(PK5, null)).toBe(clusterKey(PK6, null));
    expect(clusterKey(PK1, null)).not.toBe(clusterKey(PK2, null));
  });
});

// ── parsovanie contentu ────────────────────────────────────────────────────

describe('parseVoteDir', () => {
  it('textové aj JSON formy', () => {
    expect(parseVoteDir('+1')).toBe(1);
    expect(parseVoteDir('-1')).toBe(-1);
    expect(parseVoteDir('+')).toBe(1);
    expect(parseVoteDir('-')).toBe(-1);
    expect(parseVoteDir('{"dir":1,"credits_spent":4}')).toBe(1);
    expect(parseVoteDir('{"dir":-1}')).toBe(-1);
    expect(parseVoteDir('{"dir":0}')).toBe(0);
  });

  it('nečitateľný content → 0 (počíta sa do váhy, nie do súhlasu)', () => {
    expect(parseVoteDir('')).toBe(0);
    expect(parseVoteDir('super')).toBe(0);
    expect(parseVoteDir('{broken')).toBe(0);
  });
});

describe('parseRatingScore', () => {
  it('škála 1..5 (zo zadania) → normalizácia (s-1)/4', () => {
    expect(parseRatingScore('{"score":5}')).toBeCloseTo(1, 10);
    expect(parseRatingScore('{"score":4}')).toBeCloseTo(0.75, 10);
    expect(parseRatingScore('{"score":1}')).toBeCloseTo(0, 10);
  });

  it('škála 0..1 (modelový dokument) → priamo', () => {
    expect(parseRatingScore('{"score":0.86,"rationale":"x"}')).toBeCloseTo(0.86, 10);
    expect(parseRatingScore('{"score":0}')).toBeCloseTo(0, 10);
  });

  it('mimo rozsah / nečitateľné → null', () => {
    expect(parseRatingScore('{"score":6}')).toBeNull();
    expect(parseRatingScore('{"score":-0.5}')).toBeNull();
    expect(parseRatingScore('{"nope":1}')).toBeNull();
    expect(parseRatingScore('')).toBeNull();
  });

  it('holé číslo v contente prejde (tolerancia)', () => {
    expect(parseRatingScore('4')).toBeCloseTo(0.75, 10);
  });
});

// ── cap škrtanie ───────────────────────────────────────────────────────────

describe('capWeights', () => {
  it('10 hlasov jedného agentu → súčet váh max 0.5 z celkovej váhy', () => {
    // bez `op` tagu je agent sám clusterom → cluster_cap 0.15 je prísnejší
    // než agent_cap 0.5 a škrtí prv; zadanie vyžaduje „max 0.5 z celku“,
    // čo je splnené (0.15 ≤ 0.5). S vlastnými op tagmi viaže agent_cap.
    const items: SignalItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `v${String(i).padStart(2, '0')}`,
      pubkey: PK1,
      op: null,
      epoch: null,
      weight: 1,
    }));
    const result = capWeights(items);
    expect(result.totalRaw).toBeCloseTo(10, 10);
    expect(result.totalCapped).toBeLessThanOrEqual(0.5 * result.totalRaw + 1e-9);
    expect(result.totalCapped).toBeCloseTo(1.5, 9); // cluster strop 0.15 * 10
    for (const item of result.items) expect(item.capped).toBeCloseTo(0.15, 9);

    // 10 hlasov toho istého pubkey, ale každý pod iným operátorom →
    // cluster/operátor stropy neviažu a rozhoduje agent_cap 0.5
    const perOp: SignalItem[] = items.map((item, i) => ({ ...item, op: `op-${String(i)}` }));
    const cappedPerOp = capWeights(perOp);
    expect(cappedPerOp.totalCapped).toBeCloseTo(5, 9); // 0.5 * 10
    for (const item of cappedPerOp.items) expect(item.capped).toBeCloseTo(0.5, 9);
  });

  it('cluster s op tagmi (4 identity, 1 op) → cluster max 0.15 z celku', () => {
    const items: SignalItem[] = [PK1, PK2, PK3, PK4].map((pk, i) => ({
      id: `v${String(i)}`,
      pubkey: pk,
      op: 'opX',
      epoch: null,
      weight: 1,
    }));
    const result = capWeights(items);
    expect(result.totalRaw).toBeCloseTo(4, 10);
    // cluster (op:opX) má 4 identity dokopy → strop 0.15 * 4 = 0.6
    expect(result.totalCapped).toBeCloseTo(0.6, 9);
    for (const item of result.items) expect(item.capped).toBeCloseTo(0.15, 9);
  });

  it('cluster bez op tagu = 8-hex prefix pubkey', () => {
    const items: SignalItem[] = [
      { id: 'v1', pubkey: PK5, op: null, epoch: null, weight: 1 },
      { id: 'v2', pubkey: PK6, op: null, epoch: null, weight: 1 },
    ];
    const result = capWeights(items);
    // oba patria do jedného prefix-clusteru → 0.15 * 2 = 0.3
    expect(result.totalCapped).toBeCloseTo(0.3, 9);
  });

  it('op_cap je samostatne viazateľný (clusterCap voľnejší → op_cap rozhoduje)', () => {
    const items: SignalItem[] = [PK1, PK2, PK3, PK4].map((pk, i) => ({
      id: `v${String(i)}`,
      pubkey: pk,
      op: 'opY',
      epoch: null,
      weight: 1,
    }));
    const result = capWeights(items, { clusterCap: 0.3, opCap: 0.25 });
    // cluster pass: 0.3*4 = 1.2; op pass: 0.25*4 = 1.0 → prísnejší vyhráva
    expect(result.totalCapped).toBeCloseTo(1.0, 9);
  });

  it('agent_cap + cluster_cap spolu: 2 identity jedného operátora', () => {
    const items: SignalItem[] = [
      { id: 'v1', pubkey: PK1, op: 'opZ', epoch: null, weight: 1 },
      { id: 'v2', pubkey: '1'.repeat(64), op: 'opZ', epoch: null, weight: 1 },
      { id: 'v3', pubkey: '2'.repeat(64), op: null, epoch: null, weight: 1 },
      { id: 'v4', pubkey: '3'.repeat(64), op: null, epoch: null, weight: 1 },
    ];
    const result = capWeights(items);
    const byOp = result.items
      .filter((item) => item.op === 'opZ')
      .reduce((sum, item) => sum + item.capped, 0);
    // cluster opZ: 2 identity → 0.15 * 4 = 0.6 (agent_cap 0.5 na identitu
    // je voľnejší, lebo každá identita má len 1 hlas)
    expect(byOp).toBeCloseTo(0.6, 9);
    // sekvencia priechodov len znižuje — súčet sedí
    expect(result.totalCapped).toBeLessThanOrEqual(result.totalRaw);
  });

  it('epoch signály s váhou 0 sa stropmi nedvihnú a nenulové skupiny neovplyvnia', () => {
    const items: SignalItem[] = [
      { id: 'v1', pubkey: PK1, op: null, epoch: 1, weight: 0 }, // stará epocha
      { id: 'v2', pubkey: PK2, op: null, epoch: 2, weight: 1 },
    ];
    const result = capWeights(items);
    expect(result.items.find((item) => item.id === 'v1')?.capped).toBe(0);
    // PK2 je jediná kladná váha: cluster strop 0.15 * 1 = 0.15
    expect(result.items.find((item) => item.id === 'v2')?.capped).toBeCloseTo(0.15, 9);
  });

  it('determinizmus: shuffle vstupu → zhodné váhy (poradie id)', () => {
    const items: SignalItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `v${String(i).padStart(2, '0')}`,
      pubkey: [PK1, PK2, PK3][i % 3] as string,
      op: i % 4 === 0 ? 'opW' : null,
      epoch: null,
      weight: 1,
    }));
    const base = capWeights(items);
    const rand = mulberry32(42);
    for (let round = 0; round < 10; round += 1) {
      const shuffled = shuffle(items, rand);
      const again = capWeights(shuffled);
      expect(JSON.stringify(again.items)).toBe(JSON.stringify(base.items));
      expect(again.totalCapped).toBeCloseTo(base.totalCapped, 15);
    }
  });
});

// ── agregácia hlasov per cieľ ──────────────────────────────────────────────

describe('aggregateVotesPerTarget', () => {
  it('10 hlasov 1 agentu na rovnaký cieľ → weightTotal max 0.5 z 10', () => {
    const votes = Array.from({ length: 10 }, (_, i) =>
      vote(`v${String(i).padStart(2, '0')}`, PK1, 'target1', 1),
    );
    const [agg] = aggregateVotesPerTarget(votes, null);
    expect(agg).toBeDefined();
    expect(agg?.votes).toBe(10);
    // bez op tagu viaže cluster_cap 0.15 → 1.5 z 10 (≤ 0.5 zo zadania)
    expect(agg?.weightTotal).toBeCloseTo(1.5, 9);
    expect(agg?.weightTotal).toBeLessThanOrEqual(0.5 * agg!.weightRaw + 1e-9);
    expect(agg?.pHat).toBeCloseTo(1, 9);
    expect(agg?.consensus).toBeCloseTo(wilsonLowerBound(1.5, 1.5), 9);
    expect(agg?.n_eff).toBeCloseTo(10, 9); // 10× váha 0.15 → n_eff 10
  });

  it('epoch filtr: hlas zo staršej epochy má váhu 0', () => {
    const votes = [
      vote('v1', PK1, 'target1', 1, { epoch: 1 }),
      vote('v2', PK2, 'target1', 1, { epoch: 2 }),
      vote('v3', PK3, 'target1', -1, { epoch: 2 }),
    ];
    const epoch = 2;
    const [agg] = aggregateVotesPerTarget(votes, epoch);
    expect(agg?.votes).toBe(3);
    // v1 váha 0; PK2/PK3 samostatné clustery → strop 0.15 * 2 = 0.3 each
    expect(agg?.weightTotal).toBeCloseTo(0.6, 9);
    expect(agg?.positiveWeight).toBeCloseTo(0.3, 9);
    expect(agg?.pHat).toBeCloseTo(0.5, 9);
  });

  it('output je zoradený podľa target (total order)', () => {
    const votes = [
      vote('v1', PK1, 'zzz', 1),
      vote('v2', PK2, 'aaa', 1),
      vote('v3', PK3, 'mmm', -1),
    ];
    const aggs = aggregateVotesPerTarget(votes, null);
    expect(aggs.map((agg) => agg.target)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('determinizmus ×10 pri zmene poradia vstupu', () => {
    const votes = Array.from({ length: 20 }, (_, i) =>
      vote(
        `v${String(i).padStart(2, '0')}`,
        [PK1, PK2, PK3, PK4][i % 4] as string,
        i % 2 === 0 ? 'targetA' : 'targetB',
        i % 3 === 0 ? -1 : 1,
        i % 5 === 0 ? { op: 'opV' } : {},
      ),
    );
    const base = JSON.stringify(aggregateVotesPerTarget(votes, null));
    const rand = mulberry32(7);
    for (let round = 0; round < 10; round += 1) {
      const shuffled = shuffle(votes, rand);
      expect(JSON.stringify(aggregateVotesPerTarget(shuffled, null))).toBe(base);
    }
  });
});

// ── agregácia ratingov ─────────────────────────────────────────────────────

describe('aggregateRatings', () => {
  it('3 ratingy skóre 5 od 3 identít → mean 1.0, mean15 5, Wilson malý', () => {
    const ratings = [PK1, PK2, PK3].map((pk, i) => ({
      id: `r${i}`,
      pubkey: pk,
      op: null,
      epoch: null,
      score: 1,
    }));
    const agg = aggregateRatings(ratings);
    expect(agg.count).toBe(3);
    expect(agg.mean).toBeCloseTo(1, 9);
    expect(agg.mean15).toBeCloseTo(5, 9);
    // cluster strop 0.15 * 3 = 0.45 na identitu → weightTotal 1.35
    expect(agg.weightTotal).toBeCloseTo(1.35, 9);
    expect(agg.n_eff).toBeCloseTo(3, 9);
    // Wilson nad 1.35/1.35 je nízky — malá vzorka nie je istota
    expect(agg.wilson).toBeCloseTo(wilsonLowerBound(1.35, 1.35), 9);
    expect(agg.wilson).toBeLessThan(0.3);
  });

  it('vážený priemer rešpektuje stropy (cluster s op tagmi)', () => {
    const ratings = [
      { id: 'r1', pubkey: PK1, op: 'opQ', epoch: null, score: 1 },
      { id: 'r2', pubkey: PK2, op: 'opQ', epoch: null, score: 0 },
      { id: 'r3', pubkey: PK3, op: null, epoch: null, score: 1 },
    ];
    const agg = aggregateRatings(ratings);
    // PK1/PK2 v clusteri opQ: 0.15*3=0.45 → each 0.225; PK3 singleton 0.45
    // weighted mean = (0.225*1 + 0.225*0 + 0.45*1) / 0.9 = 0.675/0.9 = 0.75
    expect(agg.mean).toBeCloseTo(0.75, 9);
  });

  it(' prázdny vstup → nula voľby, epoch null', () => {
    const agg = aggregateRatings([]);
    expect(agg.count).toBe(0);
    expect(agg.mean).toBe(0);
    expect(agg.mean15).toBe(0);
    expect(agg.wilson).toBe(0);
    expect(agg.epoch).toBeNull();
  });

  it('null skóre sa vynechá; epoch watermark z ratingov', () => {
    const agg = aggregateRatings([
      { id: 'r1', pubkey: PK1, op: null, epoch: 4, score: null },
      { id: 'r2', pubkey: PK2, op: null, epoch: 4, score: 0.5 },
      { id: 'r3', pubkey: PK3, op: null, epoch: 3, score: 1 }, // stará epocha
    ]);
    expect(agg.count).toBe(2);
    expect(agg.epoch).toBe(4);
    // r3 má váhu 0 → počítaný priemer len z r2
    expect(agg.mean).toBeCloseTo(0.5, 9);
  });
});

// ── rating agregát vlákna ──────────────────────────────────────────────────

describe('aggregateThreadRating', () => {
  const rootId = 'f'.repeat(64);
  const solutionId = '1'.repeat(64);

  it('ratingy viazané na root (rootRef aj priamy e tag) sa započítajú, cudzie nie', () => {
    const ratings = [
      ev('r1', PK1, KINDS.SOLUTION_RATING, [
        ['e', solutionId, ''],
        ['e', rootId, 'root'],
      ], '{"score":4}'),
      ev('r2', PK2, KINDS.SOLUTION_RATING, [['e', rootId]], '{"score":5}'),
      ev('r3', PK3, KINDS.SOLUTION_RATING, [
        ['e', '2'.repeat(64), ''],
        ['e', '9'.repeat(64), 'root'],
      ], '{"score":1}'), // iné vlákno
    ];
    const agg = aggregateThreadRating(rootId, ratings, []);
    expect(agg.count).toBe(2);
    expect(agg.accepted).toBe(false);
    expect(agg.accepted_count).toBe(0);
    // cluster stropy: 2 singleton clustery → each 0.15, mean = (0.15*0.75+0.15*1)/0.3 = 0.875
    expect(agg.mean).toBeCloseTo(0.875, 9);
    expect(agg.mean15).toBeCloseTo(4.5, 9);
  });

  it('accepted flag z 1032 (rootRef cieľa aj priamy e na root)', () => {
    const accepted = [
      ev('a1', PK4, KINDS.ACCEPTED_SOLUTION, [
        ['e', solutionId, ''],
        ['e', rootId, 'root'],
      ]),
    ];
    const agg = aggregateThreadRating(rootId, [], accepted);
    expect(agg.accepted).toBe(true);
    expect(agg.accepted_count).toBe(1);
    expect(agg.count).toBe(0);
  });

  it('1032 na iné vlákno accepted nedá', () => {
    const accepted = [
      ev('a1', PK4, KINDS.ACCEPTED_SOLUTION, [
        ['e', solutionId, ''],
        ['e', '8'.repeat(64), 'root'],
      ]),
    ];
    expect(aggregateThreadRating(rootId, [], accepted).accepted).toBe(false);
  });

  // regression A6: 1032 musí podpísať AUTOR OTÁZKY (skill.md:152/225) —
  // cudzie "accepted" nesmie na vlákne nastaviť accepted=true
  it('s rootAuthor parametrom počíta 1032 len od autora koreňa (A6)', () => {
    const accepted = [
      ev('a1', PK4, KINDS.ACCEPTED_SOLUTION, [
        ['e', solutionId, ''],
        ['e', rootId, 'root'],
      ]),
    ];
    const foreign = aggregateThreadRating(rootId, [], accepted, undefined, PK1);
    expect(foreign.accepted).toBe(false);
    expect(foreign.accepted_count).toBe(0);
    const own = aggregateThreadRating(rootId, [], accepted, undefined, PK4);
    expect(own.accepted).toBe(true);
    // bez parametra zostáva správanie zachované (zpätná kompatibilita)
    expect(aggregateThreadRating(rootId, [], accepted).accepted).toBe(true);
  });
});

// ── per-doménová karta ─────────────────────────────────────────────────────

describe('computeReputation', () => {
  const qPk = '1'.repeat(64); // autor otázky
  const a1Pk = '2'.repeat(64); // autor akceptovanej odpovede
  const a2Pk = '3'.repeat(64); // autor odpovede s +1 bez acceptu
  const a3Pk = '4'.repeat(64); // autor odpovede len s -1
  const v1Pk = '5'.repeat(64); // volič +1 na akceptovanú (správne)
  const v2Pk = '6'.repeat(64); // volič -1 na neakceptovanú (správne)
  const v3Pk = '7'.repeat(64); // volič +1 na neakceptovanú (nesprávne)
  const r1Pk = '8'.repeat(64); // ratingovateľ
  const threadId = 'a1'.padEnd(64, '0');
  const reply1 = 'b1'.padEnd(64, '0');
  const reply2 = 'b2'.padEnd(64, '0');
  const reply3 = 'b3'.padEnd(64, '0');

  const dataset: NostrEvent[] = [
    ev(threadId, qPk, KINDS.QUESTION, [['t', 'lang/rust']], 'ako na tokio drain?'),
    ev(reply1, a1Pk, KINDS.POST, [['e', threadId, 'root']], 'timeout na drain fázu'),
    ev(reply2, a2Pk, KINDS.POST, [['e', threadId, 'root']], 'skús channel'),
    ev(reply3, a3Pk, KINDS.POST, [['e', threadId, 'root']], 'skús spawn_blocking'),
    ev('vote1', v1Pk, KINDS.VOTE, [['e', reply1, ''], ['e', threadId, 'root'], ['epoch', '2']], '+1'),
    ev('vote2', v2Pk, KINDS.VOTE, [['e', reply2, ''], ['e', threadId, 'root'], ['epoch', '2']], '-1'),
    ev('vote3', v3Pk, KINDS.VOTE, [['e', reply2, ''], ['e', threadId, 'root'], ['epoch', '2']], '+1'),
    ev('vote4', v2Pk, KINDS.VOTE, [['e', reply3, ''], ['e', threadId, 'root'], ['epoch', '2']], '-1'),
    ev('vote-old', v3Pk, KINDS.VOTE, [['e', reply1, ''], ['e', threadId, 'root'], ['epoch', '1']], '+1'),
    ev('rating1', r1Pk, KINDS.SOLUTION_RATING, [
      ['e', reply1, ''],
      ['e', threadId, 'root'],
      ['epoch', '2'],
    ], '{"score":4}'),
    ev('accept1', qPk, KINDS.ACCEPTED_SOLUTION, [
      ['e', reply1, ''],
      ['e', threadId, 'root'],
    ]),
  ];

  it('domény sú voter/author/helper a filter funkcia sedí', () => {
    const card = computeReputation(qPk, dataset);
    expect(Object.keys(card.domains).sort()).toEqual(['author', 'helper', 'voter']);
    expect(isReputationDomain('voter')).toBe(true);
    expect(isReputationDomain('bogus')).toBe(false);
  });

  it('epoch = max viditeľná (2), stará epocha do voliča nevstúpi', () => {
    const card = computeReputation(v3Pk, dataset);
    expect(card.epoch).toBe(2);
    // v3: vote3 (+1 na reply2, neakceptovaná → nesprávny) + vote-old (epoch 1 → váha 0,
    // do totalu nevstúpi) → total 1, positive 0
    expect(card.domains.voter.total).toBe(1);
    expect(card.domains.voter.positive).toBe(0);
    expect(card.domains.voter.score).toBe(0);
    expect(card.counts.votes_cast).toBe(2);
  });

  it('voter: +1 na akceptovaný cieľ = správny; -1 na neakceptovaný = správny', () => {
    const c1 = computeReputation(v1Pk, dataset);
    expect(c1.domains.voter.total).toBe(1);
    expect(c1.domains.voter.positive).toBe(1);
    expect(c1.domains.voter.score).toBeCloseTo(wilsonLowerBound(1, 1), 12);
    // v2 dal dva -1 hlasy na neakceptované odpovede → oba správne
    const c2 = computeReputation(v2Pk, dataset);
    expect(c2.domains.voter.total).toBe(2);
    expect(c2.domains.voter.positive).toBe(2);
  });

  it('author: 1020 s 1032 → positive 1; counts sedí', () => {
    const card = computeReputation(qPk, dataset);
    expect(card.domains.author.total).toBe(1);
    expect(card.domains.author.positive).toBe(1);
    expect(card.counts.threads_authored).toBe(1);
    expect(card.counts.accepted_solutions).toBe(1);
  });

  it('author bez acceptu: soft signál = normalizovaný priemer 1031', () => {
    // Q2 má otázku bez acceptu, ale s ratingom skóre 3 → norm 0.5
    const q2 = '8'.repeat(64);
    const t2 = 'a2'.padEnd(64, '1');
    const local = [
      ev(t2, q2, KINDS.QUESTION, []),
      ev('r-x', r1Pk, KINDS.SOLUTION_RATING, [['e', t2, 'root']], '{"score":3}'),
    ];
    const card = computeReputation(q2, local);
    expect(card.domains.author.total).toBe(1);
    expect(card.domains.author.positive).toBeCloseTo(0.5, 12);
    expect(card.domains.author.score).toBeCloseTo(wilsonLowerBound(0.5, 1), 12);
    expect(card.counts.ratings_received).toBe(1);
  });

  it('helper: +1 hlas alebo 1032 = kladná odpoveď', () => {
    const h1 = computeReputation(a1Pk, dataset);
    expect(h1.domains.helper.total).toBe(1);
    expect(h1.domains.helper.positive).toBe(1); // +1 aj accept
    const h2 = computeReputation(a2Pk, dataset);
    expect(h2.domains.helper.total).toBe(1);
    expect(h2.domains.helper.positive).toBe(1); // reply2 dostala +1 od v3
    expect(h2.counts.replies_authored).toBe(1);
    // reply3 (len -1 hlas, žiadny accept) → helper doména klesne na 0
    const h3 = computeReputation(a3Pk, dataset);
    expect(h3.domains.helper.total).toBe(1);
    expect(h3.domains.helper.positive).toBe(0);
    expect(h3.domains.helper.score).toBe(0);
  });

  it('neznámy pubkey → všetky domény 0/0 so score 0', () => {
    const card = computeReputation('9'.repeat(64), dataset);
    for (const domain of Object.values(card.domains)) {
      expect(domain.total).toBe(0);
      expect(domain.score).toBe(0);
      expect(domain.n_eff).toBe(0);
    }
  });

  it('untrusted konvencia je v karte', () => {
    expect(computeReputation(qPk, dataset).untrusted).toContain('untrusted');
  });

  it('determinizmus ×10 pri zmene poradia eventov', () => {
    const base = JSON.stringify(computeReputation(qPk, dataset));
    const rand = mulberry32(1234);
    for (let round = 0; round < 10; round += 1) {
      const shuffled = shuffle(dataset, rand);
      expect(JSON.stringify(computeReputation(qPk, shuffled))).toBe(base);
    }
  });

  // ── regression A6 ────────────────────────────────────────────────────────

  it('1032 od cudzieho pubkey sa nezapočíta (author/helper accept ignorovaný)', () => {
    const foreign = dataset.filter((e) => e.id !== 'accept1').concat(
      ev('accept-kradnuté', a2Pk, KINDS.ACCEPTED_SOLUTION, [
        ['e', reply1, ''],
        ['e', threadId, 'root'],
      ]),
    );
    // autor otázky stratí accept positive (žiadny 1032 od neho)
    const q = computeReputation(qPk, foreign);
    expect(q.counts.accepted_solutions).toBe(0);
    // autor akceptovanej odpovede stratí accept v helper doméne (klesne
    // na +1 hlas od v1 — ten ostáva, accept nie)
    const h1 = computeReputation(a1Pk, foreign);
    expect(h1.counts.accepted_solutions).toBe(0);
    // a autor otázky sa z cudzieho acceptu neteší v author doméne
    expect(q.domains.author.positive).toBeLessThan(
      computeReputation(qPk, dataset).domains.author.positive,
    );
  });

  it('sebahlas +1 pod vlastnú odpoveď nefarmuje helper doménu', () => {
    const selfVote = dataset.concat(
      ev('vote-self', a3Pk, KINDS.VOTE, [
        ['e', reply3, ''],
        ['e', threadId, 'root'],
        ['epoch', '2'],
      ], '+1'),
    );
    const h3 = computeReputation(a3Pk, selfVote);
    // reply3 má len VLASTNÝ +1 hlas → helper positive ostáva 0 (pred fixom 1)
    expect(h3.domains.helper.total).toBe(1);
    expect(h3.domains.helper.positive).toBe(0);
  });

  it('hlas na neexistujúci cieľ sa do voter domény nepočíta', () => {
    const junkVotes = dataset.concat(
      ev('vote-junk1', v3Pk, KINDS.VOTE, [
        ['e', 'ee'.padEnd(64, '0'), ''],
        ['epoch', '2'],
      ], '-1'),
      ev('vote-junk2', v3Pk, KINDS.VOTE, [
        ['e', 'dd'.padEnd(64, '0'), ''],
        ['epoch', '2'],
      ], '-1'),
    );
    const v3 = computeReputation(v3Pk, junkVotes);
    const base = computeReputation(v3Pk, dataset);
    // obe −1 na vymyslené id by sa pred fixom počítali ako "správne"
    expect(v3.domains.voter.total).toBe(base.domains.voter.total);
    expect(v3.domains.voter.positive).toBe(base.domains.voter.positive);
    expect(v3.counts.votes_cast).toBe(base.counts.votes_cast + 2); // počítadlo ostáva
  });
});
