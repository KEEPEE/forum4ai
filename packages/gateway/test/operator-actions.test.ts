/**
 * Unit testy `operator-actions.ts` (F4AI-23/24, Phase 1a) — ZDIEĽANÉho
 * jadra schvaľovania a zrušenia, ktoré volá CLI (`operator approve|revoke`)
 * AJ HTTP (`POST /register/approve|revoke`).
 *
 * Prečo samostatný súbor: identita správania CLI a UI je CELÝ ZMYSEL tohto
 * refaktoringu. Testy tu držia kontrakt funkcie (návratové tvary, ktoré si
 * obe strany čítajú) — HTTP vrstvu cvičí `register-routes.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';

import { KINDS } from '@forum4ai/shared';

import {
  LABEL_NOTE_MAX_CHARS,
  approveOperator,
  normalizeOperatorPubkey,
  revokeOperator,
  type OperatorActionDeps,
} from '../src/operator-actions.js';
import { openOperatorsDb } from '../src/operators-db.js';
import { WRITERS_D_TAG } from '../src/writers.js';
import type { PublishResult, RelayStatus } from '../src/relay-pool.js';

const T0 = 1_730_000_000;
const OWNER_SK = generateSecretKey();
const OWNER_PK = getPublicKey(OWNER_SK).toLowerCase();
const OWNER_SK_HEX = Buffer.from(OWNER_SK).toString('hex');
const OPERATOR_PK = getPublicKey(generateSecretKey()).toLowerCase();

class FakePool {
  readonly published: Event[] = [];
  ok = true;

  async publish(event: Event): Promise<PublishResult[]> {
    this.published.push(event);
    return [{ url: 'ws://relay.test:7777', ok: this.ok, message: this.ok ? 'OK accepted' : 'OK rejected' }];
  }

  async query(): Promise<Event[]> {
    return [];
  }

  status(): RelayStatus[] {
    return [
      { url: 'ws://relay.test:7777', connected: true, attempts: 0, nextAttemptAt: 0, lastError: null, lastConnectedAt: 0 },
    ];
  }

  byKind(kind: number): Event[] {
    return this.published.filter((event) => event.kind === kind);
  }
}

interface Options {
  ownerSkHex?: string;
  ownerPubkey?: string;
  publishOk?: boolean;
  republishOk?: boolean;
  publishPowMin?: number;
}

function makeDeps(options: Options = {}): OperatorActionDeps & { pool: FakePool; db: ReturnType<typeof openOperatorsDb> } {
  const db = openOperatorsDb(':memory:', { now: () => T0 });
  const pool = new FakePool();
  if (options.publishOk === false) pool.ok = false;
  return {
    db,
    pool,
    republishWriters: async () =>
      options.republishOk === false
        ? { ok: false, reason: 'relay odmietol 30028' }
        : { ok: true, event: { id: 'e1'.repeat(31) + 'e', kind: KINDS.NODE_DIRECTORY } as Event },
    ownerSkHex: options.ownerSkHex ?? OWNER_SK_HEX,
    ownerPubkey: options.ownerPubkey ?? OWNER_PK,
    ...(options.publishPowMin !== undefined ? { publishPowMin: options.publishPowMin } : {}),
    logger: () => undefined,
    now: () => T0,
  };
}

describe('normalizeOperatorPubkey', () => {
  it('normalizuje hex (aj VEĽKÝ) a odmietne čokoľvek iné', () => {
    expect(normalizeOperatorPubkey(OPERATOR_PK.toUpperCase())).toBe(OPERATOR_PK);
    expect(normalizeOperatorPubkey(`  ${OPERATOR_PK}  `)).toBe(OPERATOR_PK);
    expect(normalizeOperatorPubkey('npub1abc')).toBeNull();
    expect(normalizeOperatorPubkey('')).toBeNull();
    expect(normalizeOperatorPubkey('a'.repeat(63))).toBeNull();
  });
});

describe('approveOperator (jadro CLI `operator approve` aj HTTP)', () => {
  it('zlý tvar pubkey = bad_pubkey a žiadny publish', async () => {
    const deps = makeDeps();
    const result = await approveOperator(deps, 'npub1xy');
    expect(result).toMatchObject({ ok: false, reason: 'bad_pubkey', operator: null });
    expect(deps.pool.published).toHaveLength(0);
  });

  it('neznámy pubkey = not_found (404 pre route) a žiadny publish', async () => {
    const deps = makeDeps();
    const result = await approveOperator(deps, OPERATOR_PK);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(result.warnings.join(' ')).toContain('is not in the operator table');
    expect(deps.pool.published).toHaveLength(0);
  });

  it('pending → active + práve jeden republish 30028', async () => {
    const deps = makeDeps();
    deps.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1' });
    const result = await approveOperator(deps, OPERATOR_PK);
    expect(result.ok).toBe(true);
    expect(result.operator?.status).toBe('active');
    expect(result.writers.ok).toBe(true);
    expect(result.label).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(deps.db.get(OPERATOR_PK)?.status).toBe('active');
  });

  it('republish zlyhá → ok true s varovaním (rovnaké ako staré CLI)', async () => {
    const deps = makeDeps({ republishOk: false });
    deps.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1' });
    const result = await approveOperator(deps, OPERATOR_PK);
    expect(result.ok).toBe(true);
    expect(result.writers).toMatchObject({ ok: false, reason: 'relay odmietol 30028' });
    expect(result.warnings.join(' ')).toContain('other instances will not see the change');
  });

  it('idempotentné: opakované approve nechá active a znova republishne', async () => {
    const deps = makeDeps();
    deps.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
    const first = await approveOperator(deps, OPERATOR_PK);
    const second = await approveOperator(deps, OPERATOR_PK);
    expect(first.ok && second.ok).toBe(true);
    expect(second.operator?.status).toBe('active');
  });
});

describe('revokeOperator (jadro CLI `operator revoke` aj HTTP)', () => {
  it('revoked + 1040 LABEL podpísaný vlastníkom (L/l/p tagy, content = poznámka)', async () => {
    const deps = makeDeps();
    deps.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
    const result = await revokeOperator(deps, OPERATOR_PK, 'prestal replikovať');
    expect(result.ok).toBe(true);
    expect(result.operator?.status).toBe('revoked');
    expect(result.label?.ok).toBe(true);

    const labels = deps.pool.byKind(KINDS.LABEL);
    expect(labels).toHaveLength(1);
    const label = labels[0] as Event;
    expect(label.pubkey).toBe(OWNER_PK);
    expect(label.kind).toBe(KINDS.LABEL);
    expect(label.tags).toContainEqual(['L', OPERATOR_PK, 'forum4ai-writers']);
    expect(label.tags).toContainEqual(['l', 'forum4ai-writers']);
    expect(label.tags).toContainEqual(['p', OPERATOR_PK]);
    expect(label.content).toBe('prestal replikovať');
    expect(verifyEvent(label)).toBe(true);
  });

  it('bez owner škály = label null + varovanie (status aj tak prejde)', async () => {
    const deps = makeDeps({ ownerSkHex: '', ownerPubkey: '' });
    deps.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
    const result = await revokeOperator(deps, OPERATOR_PK);
    expect(result.ok).toBe(true);
    expect(result.label).toBeNull();
    expect(result.warnings.join(' ')).toContain('GATEWAY_OWNER_SK_HEX');
    expect(deps.pool.byKind(KINDS.LABEL)).toHaveLength(0);
  });

  it('LABEL bez poznámky = content "revoked" a dlhá poznámka sa oreže na 120', async () => {
    const deps = makeDeps();
    deps.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
    await revokeOperator(deps, OPERATOR_PK);
    expect(deps.pool.byKind(KINDS.LABEL)[0]?.content).toBe('revoked');

    const deps2 = makeDeps();
    deps2.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
    await revokeOperator(deps2, OPERATOR_PK, 'z'.repeat(500));
    expect(deps2.pool.byKind(KINDS.LABEL)[0]?.content).toHaveLength(LABEL_NOTE_MAX_CHARS);
  });

  it('PoW obtiažnosť sa aplikuje aj na LABEL (relay vyžaduje NIP-13)', async () => {
    const deps = makeDeps({ publishPowMin: 2 });
    deps.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
    const result = await revokeOperator(deps, OPERATOR_PK);
    const label = deps.pool.byKind(KINDS.LABEL)[0] as Event;
    expect(result.label?.ok).toBe(true);
    expect(label.tags.some((tag) => tag[0] === 'nonce')).toBe(true);
  });

  it('publish LABELu zlyhá → label.ok false s varovaním, status ostáva revoked', async () => {
    const deps = makeDeps({ publishOk: false });
    deps.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1', status: 'active' });
    const result = await revokeOperator(deps, OPERATOR_PK);
    expect(result.ok).toBe(true);
    expect(result.label?.ok).toBe(false);
    expect(result.warnings.join(' ')).toContain('audit trail');
    expect(deps.db.get(OPERATOR_PK)?.status).toBe('revoked');
  });

  it('neznámy pubkey = not_found', async () => {
    const deps = makeDeps();
    const result = await revokeOperator(deps, OPERATOR_PK, 'x');
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('30028 republish (zdroj pravdy cudzích inštancií)', () => {
  it('republish je zdieľaný — approve aj revoke ho volajú práve raz', async () => {
    let calls = 0;
    const deps = makeDeps();
    deps.republishWriters = async () => {
      calls += 1;
      return { ok: true, event: { id: 'f1'.repeat(31) + 'f', kind: KINDS.NODE_DIRECTORY } as Event };
    };
    deps.db.upsertClaim({ pubkey: OPERATOR_PK, relay: 'wss://op.example/', claimId: 'c1' });
    await approveOperator(deps, OPERATOR_PK);
    expect(calls).toBe(1);
    await revokeOperator(deps, OPERATOR_PK);
    expect(calls).toBe(2);
    // d-tag zoznamu pisúcich je konštanta, nie voľné slovo
    expect(WRITERS_D_TAG).toBe('forum4ai-writers');
  });
});
