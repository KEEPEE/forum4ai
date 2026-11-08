/**
 * Unit testy `registration.ts` (dizajn B2–B4, P1) — challenge bez store
 * (HMAC + exp), SSRF pravidlá cudzieho relaya a proof-of-replication
 * probe s fake relayom. Integrácia route je v `register-routes.test.ts`.
 *
 * Dôraz na dve veci, ktoré sú bezprostredne bezpečnostné:
 *  1. `wss://` + port 443 + verejná IP — inak by registrácia slúžila ako
 *     port-scanner vnútornej siete (A2),
 *  2. verdict vráti LEN kód — text chyby cudzieho relaya sa nesmie
 *     dostať ani do logu klientovi (rovnaké pravidlo ako pri publishi).
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

import { KINDS } from '@forum4ai/shared';

import {
  CHALLENGE_TTL_S,
  ProbeBudget,
  REPLICATION_MIN_OK,
  REPLICATION_SAMPLE_SIZE,
  UsedNonces,
  assertSafeRelayUrl,
  createChallenge,
  probeOperatorRelay,
  sampleIds,
  verifyChallenge,
  type RelayLike,
  type Resolver,
  type SubscribeHandlers,
  type SubscriptionLike,
} from '../src/registration.js';
import type { ProbeDeps } from '../src/registration.js';

const SECRET = 'test-reg-secret';
const T0 = 1_730_000_000;
const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const privateResolver: Resolver = async () => [{ address: '10.0.0.5', family: 4 }];

// ── challenge ──────────────────────────────────────────────────────────────

describe('challenge (HMAC nonce, 10 min, bez store)', () => {
  const claimant = getPublicKey(generateSecretKey());

  it('nonce je deterministická z (secret, pubkey, exp) a overí sa bez store', () => {
    const challenge = createChallenge(SECRET, claimant, T0);
    expect(challenge.exp).toBe(T0 + CHALLENGE_TTL_S);
    expect(challenge.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(createChallenge(SECRET, claimant, T0).nonce).toBe(challenge.nonce);
    expect(verifyChallenge(SECRET, claimant, challenge.nonce, challenge.exp, T0).ok).toBe(true);
  });

  it('ine IP / iný pubkey / iný secret / tamper exp = neplatné', () => {
    const challenge = createChallenge(SECRET, claimant, T0);
    const other = getPublicKey(generateSecretKey());
    expect(verifyChallenge(SECRET, other, challenge.nonce, challenge.exp, T0).ok).toBe(false);
    expect(verifyChallenge('iny-secret', claimant, challenge.nonce, challenge.exp, T0).ok).toBe(false);
    // nonce je HMAC — well-shaped, ale cudzí reťazec je `bad_hmac` (nie shape)
    expect(verifyChallenge(SECRET, claimant, 'f'.repeat(64), challenge.exp, T0).reason).toBe('bad_hmac');
    // exp je súčasťou HMAC — posunutý exp bez nového nonce neobstojí
    expect(verifyChallenge(SECRET, claimant, challenge.nonce, challenge.exp + 1, T0).ok).toBe(false);
  });

  it('expirácia: v okne platí, za oknom zamietneme (interný kód, nie detail)', () => {
    const challenge = createChallenge(SECRET, claimant, T0);
    expect(verifyChallenge(SECRET, claimant, challenge.nonce, challenge.exp, T0 + CHALLENGE_TTL_S).ok).toBe(true);
    expect(verifyChallenge(SECRET, claimant, challenge.nonce, challenge.exp, T0 + CHALLENGE_TTL_S + 1).reason).toBe('expired');
    // klient si nesmie nastaviť vlastný dlhý exp
    expect(verifyChallenge(SECRET, claimant, challenge.nonce, challenge.exp + 10_000, T0).reason).toBe('exp_too_far');
  });

  it('bez GATEWAY_REG_SECRET je challenge nepoužiteľný (no_secret)', () => {
    const challenge = createChallenge(SECRET, claimant, T0);
    expect(verifyChallenge('', claimant, challenge.nonce, challenge.exp, T0).reason).toBe('no_secret');
  });

  it('UsedNonces: nonce sa dá spotrebovať raz a po expirácii zmizne', () => {
    const used = new UsedNonces(() => T0);
    const challenge = createChallenge(SECRET, claimant, T0);
    expect(used.consume(challenge.nonce, challenge.exp)).toBe(true);
    expect(used.consume(challenge.nonce, challenge.exp)).toBe(false);
    expect(used.size).toBe(1);
    expect(used.prune()).toBe(0);
    expect(used.consume(challenge.nonce, challenge.exp)).toBe(false);
    // po expirácii nonce uvoľníme (nie je replay — challenge už neplatí)
    const later = new UsedNonces(() => T0 + CHALLENGE_TTL_S + 10);
    expect(later.consume(challenge.nonce, challenge.exp)).toBe(true);
  });

  it('UsedNonces má strop, inak by útok rastom pamäte zabil gateway', () => {
    const used = new UsedNonces(() => T0);
    for (let i = 0; i < 10_500; i += 1) used.consume(i.toString(16).padStart(64, '0'), T0 + 600);
    expect(used.size).toBeLessThanOrEqual(10_000);
  });
});

// ── SSRF pravidlá ──────────────────────────────────────────────────────────

describe('assertSafeRelayUrl (wss + 443 + verejná IP)', () => {
  it('wss bez portu a wss://host:443 sú ok', async () => {
    expect(await assertSafeRelayUrl('wss://relay.example', publicResolver)).toMatchObject({ ok: true });
    expect(await assertSafeRelayUrl('wss://relay.example:443', publicResolver)).toMatchObject({ ok: true });
  });

  it('ws:// (nešifrované) odmietneme', async () => {
    expect((await assertSafeRelayUrl('ws://relay.example', publicResolver)).ok).toBe(false);
  });

  it('ľubovoľný iný port odmietneme (inak by wss://host:6379 bol port-scanner)', async () => {
    const verdict = await assertSafeRelayUrl('wss://relay.example:8443', publicResolver);
    expect(verdict).toEqual({ ok: false, reason: 'bad_port' });
  });

  it('schéma iná ako ws/wss je bad_url (žiadne ftp/http presmerovanie)', async () => {
    expect(await assertSafeRelayUrl('ftp://relay.example', publicResolver)).toEqual({ ok: false, reason: 'bad_url' });
    expect(await assertSafeRelayUrl('totálne-nie-url', publicResolver)).toEqual({ ok: false, reason: 'bad_url' });
  });

  it('DNS na súkromnú IP odmietneme; zmiešané odpovede prejdú (stačí jedna verejná)', async () => {
    expect(await assertSafeRelayUrl('wss://relay.example', privateResolver)).toEqual({
      ok: false,
      reason: 'not_public_ip',
    });
    const mixed: Resolver = async () => [
      { address: '172.18.0.9', family: 4 },
      { address: '203.0.113.7', family: 4 },
    ];
    expect((await assertSafeRelayUrl('wss://relay.example', mixed)).ok).toBe(true);
  });

  it('priama IP v URL sa hodnotí bez DNS (wss://10.0.0.5 nesmie prejsť)', async () => {
    expect(await assertSafeRelayUrl('wss://10.0.0.5', publicResolver)).toEqual({ ok: false, reason: 'not_public_ip' });
    expect(await assertSafeRelayUrl('wss://[::1]', publicResolver)).toEqual({ ok: false, reason: 'not_public_ip' });
    expect((await assertSafeRelayUrl('wss://93.184.216.34', publicResolver)).ok).toBe(true);
  });

  it('DNS zlyhanie = dns_failed (a nie pád)', async () => {
    const broken: Resolver = async () => {
      throw new Error('EAI_AGAIN');
    };
    expect(await assertSafeRelayUrl('wss://relay.example', broken)).toEqual({ ok: false, reason: 'dns_failed' });
    const empty: Resolver = async () => [];
    expect(await assertSafeRelayUrl('wss://relay.example', empty)).toEqual({ ok: false, reason: 'dns_failed' });
  });
});

describe('ProbeBudget (max 2 súbežné probe, dizajn B4)', () => {
  it('tretia kontrola nedostane rozpočet a uvoľnenie ju pustí', () => {
    const budget = new ProbeBudget();
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
    expect(budget.active).toBe(2);
    budget.release();
    expect(budget.tryAcquire()).toBe(true);
  });
});

describe('sampleIds (Fisher–Yates bez mutácie vstupu)', () => {
  it('vráti presne count id, nemutuje vstup a je deterministická s fixným random', () => {
    const ids = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(64, '0'));
    const copy = [...ids];
    const picked = sampleIds(ids, REPLICATION_SAMPLE_SIZE, () => 0.5);
    expect(picked).toHaveLength(REPLICATION_SAMPLE_SIZE);
    expect(ids).toEqual(copy);
    expect(new Set(picked).size).toBe(REPLICATION_SAMPLE_SIZE);
    expect(sampleIds(ids, REPLICATION_SAMPLE_SIZE, () => 0.5)).toEqual(picked);
    expect(sampleIds(ids, 0)).toEqual([]);
    expect(sampleIds([], 5)).toEqual([]);
  });
});

// ── proof of replication ───────────────────────────────────────────────────

const ownerSk = generateSecretKey();
const owner = getPublicKey(ownerSk);

function signed(kind: number, tags: string[][], content = ''): Event {
  return finalizeEvent({ kind, created_at: T0, tags, content }, ownerSk);
}

/** fake relay: odpovie len na `ids` filter, veci v `store` */
class StubRelay implements RelayLike {
  readonly url: string;
  connected = true;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(
    url: string,
    private readonly store: readonly Event[],
    private readonly opts: { hang?: boolean } = {},
  ) {
    this.url = url;
  }

  async publish(): Promise<string> {
    return 'OK: accepted';
  }

  subscribe(filters: Filter[], params: SubscribeHandlers): SubscriptionLike {
    for (const filter of filters) {
      const ids = (filter as { ids?: string[] }).ids ?? [];
      for (const event of this.store) {
        if (ids.includes(event.id)) params.onevent?.(event);
      }
      if (this.opts.hang !== true) params.oneose?.();
    }
    return { close: () => undefined };
  }

  close(): void {
    this.closed = true;
  }
}

function depsFor(relay: RelayLike | null, info: Record<string, unknown> | null, samples: readonly string[]): ProbeDeps {
  return {
    connect: async () => {
      if (relay === null) throw new Error('connect ECONNREFUSED 203.0.113.7:443');
      return relay;
    },
    fetchInfo: async () => info,
    resolve: publicResolver,
    timeoutMs: 200,
    sampleIds: samples,
  };
}

describe('probeOperatorRelay (B4: 4 kontroly, žiadne cudzie chyby von)', () => {
  const claim = signed(KINDS.OPERATOR_CLAIM, [['challenge', 'a'.repeat(64)]]);
  const samples = Array.from({ length: REPLICATION_SAMPLE_SIZE }, (_, i) => signed(KINDS.POST, [['d', `s${String(i)}`]]));
  const sampleIdsList = samples.map((event) => event.id);

  it('happy path: NIP-11 pubkey sedí, claim served, ≥4 z 5 replikovaných', async () => {
    const relay = new StubRelay('wss://relay.example/', [claim, ...samples]);
    const verdict = await probeOperatorRelay(
      'wss://relay.example/',
      { claimant: owner, claimId: claim.id },
      depsFor(relay, { pubkey: owner, name: 'moje relay' }, sampleIdsList),
    );
    expect(verdict).toEqual({ ok: true, replicated: REPLICATION_SAMPLE_SIZE });
    expect(relay.closed).toBe(true);
  });

  it('NIP-11 bez pubkey → nip11_no_pubkey; cudzí pubkey → nip11_pubkey_mismatch', async () => {
    const relay = new StubRelay('wss://relay.example/', [claim, ...samples]);
    const claimRef = { claimant: owner, claimId: claim.id };
    const deps = depsFor(relay, { name: 'damus' }, sampleIdsList);
    expect(await probeOperatorRelay('wss://relay.example/', claimRef, deps)).toEqual({
      ok: false,
      reason: 'nip11_no_pubkey',
    });
    const other = getPublicKey(generateSecretKey());
    expect(await probeOperatorRelay('wss://relay.example/', claimRef, depsFor(relay, { pubkey: other }, sampleIdsList))).toEqual({
      ok: false,
      reason: 'nip11_pubkey_mismatch',
    });
    expect(await probeOperatorRelay('wss://relay.example/', claimRef, depsFor(relay, null, sampleIdsList))).toEqual({
      ok: false,
      reason: 'nip11_unreachable',
    });
  });

  it('claim nie je served → claim_not_served (claimant len tvrdil)', async () => {
    const relay = new StubRelay('wss://relay.example/', samples);
    const verdict = await probeOperatorRelay(
      'wss://relay.example/',
      { claimant: owner, claimId: claim.id },
      depsFor(relay, { pubkey: owner }, sampleIdsList),
    );
    expect(verdict).toEqual({ ok: false, reason: 'claim_not_served' });
  });

  it(`replikácia < ${String(REPLICATION_MIN_OK)} z 5 → replication_insufficient (aj s neplatným podpisom)`, async () => {
    const partial = samples.slice(0, REPLICATION_MIN_OK - 1);
    const relay = new StubRelay('wss://relay.example/', [claim, ...partial]);
    const verdict = await probeOperatorRelay(
      'wss://relay.example/',
      { claimant: owner, claimId: claim.id },
      depsFor(relay, { pubkey: owner }, sampleIdsList),
    );
    expect(verdict).toEqual({ ok: false, reason: 'replication_insufficient' });

    // 5 id prítomných, ale jeden má POŠKODENÝ podpis → počíta sa len 4 → ok;
    // dva poškodené už stačia na zamietnutie
    const broken = samples.map((event, index) => (index === 0 ? { ...event, content: 'pozmeneny obsah' } : event));
    const relayBroken = new StubRelay('wss://relay.example/', [claim, ...broken]);
    expect(
      await probeOperatorRelay('wss://relay.example/', { claimant: owner, claimId: claim.id }, depsFor(relayBroken, { pubkey: owner }, sampleIdsList)),
    ).toEqual({ ok: true, replicated: REPLICATION_SAMPLE_SIZE - 1 });

    const twoBroken = samples.map((event, index) => (index < 2 ? { ...event, content: 'pozmeneny obsah' } : event));
    const relayTwo = new StubRelay('wss://relay.example/', [claim, ...twoBroken]);
    expect(
      await probeOperatorRelay('wss://relay.example/', { claimant: owner, claimId: claim.id }, depsFor(relayTwo, { pubkey: owner }, sampleIdsList)),
    ).toEqual({ ok: false, reason: 'replication_insufficient' });
  });

  it('relay nedosiahnuteľný → unreachable; relay, ktorý nedá EOSE → replication_insufficient (timeout)', async () => {
    const claimRef = { claimant: owner, claimId: claim.id };
    expect(await probeOperatorRelay('wss://relay.example/', claimRef, depsFor(null, { pubkey: owner }, sampleIdsList))).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    const hanging = new StubRelay('wss://relay.example/', [claim, ...samples], { hang: true });
    const verdict = await probeOperatorRelay('wss://relay.example/', claimRef, depsFor(hanging, { pubkey: owner }, sampleIdsList));
    expect(verdict).toEqual({ ok: false, reason: 'claim_not_served' });
  });

  it('nebezpečná URL → unsafe_url a na relay sa vôbec nepokúsime pripojiť', async () => {
    let connected = false;
    const deps: ProbeDeps = {
      connect: async () => {
        connected = true;
        return new StubRelay('wss://x/', []);
      },
      fetchInfo: async () => ({ pubkey: owner }),
      resolve: privateResolver,
      timeoutMs: 200,
      sampleIds: sampleIdsList,
    };
    const verdict = await probeOperatorRelay('wss://internal.local/', { claimant: owner, claimId: claim.id }, deps);
    expect(verdict).toEqual({ ok: false, reason: 'unsafe_url' });
    expect(connected).toBe(false);
  });

  it('verdict neobsahuje cudzí text chyby (ECONNREFUSED / host:port)', async () => {
    const verdict = await probeOperatorRelay(
      'wss://relay.example/',
      { claimant: owner, claimId: claim.id },
      depsFor(null, { pubkey: owner }, sampleIdsList),
    );
    expect(JSON.stringify(verdict)).not.toMatch(/ECONNREFUSED|203\.0\.113\.7|:443/);
  });
});
