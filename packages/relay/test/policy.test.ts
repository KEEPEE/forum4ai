import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { getPow } from 'nostr-tools/nip13';
import { KINDS } from '@forum4ai/shared';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

import {
  DEFAULT_ALLOWED_KINDS,
  DEFAULT_POLICY,
  RelayPolicy,
  okMessage,
} from '../src/policy.js';
import type { PolicyDecision } from '../src/policy.js';
import { countLeadingZeroBitsHex } from '../src/pow.js';
import { SlidingWindowRateLimiter } from '../src/rate-limit.js';

const SK = generateSecretKey();
const PUBKEY = getPublicKey(SK);
const ROOT_ID = 'e'.repeat(64);
const CREATED_AT = 1_793_174_400;

function sign(kind: number, tags: NostrTag[] = [], content = 'test event'): NostrEvent {
  return finalizeEvent({ kind, created_at: CREATED_AT, tags, content }, SK) as unknown as NostrEvent;
}

/** Podpísaný event s aspoň `difficulty` vedúcimi nulovými bitmi (nonce mining). */
function mineEvent(kind: number, difficulty: number): NostrEvent {
  for (let nonce = 0; nonce < 1_000_000; nonce += 1) {
    const candidate = sign(kind, [['nonce', String(nonce)]], 'pow test');
    if (countLeadingZeroBitsHex(candidate.id) >= difficulty) return candidate;
  }
  throw new Error(`nedenie PoW ${String(difficulty)} bitov zlyhalo`);
}

/** Nový policy na test — inak by sa skúmali zdieľané rate limit okná. */
function policy(config?: Partial<ConstructorParameters<typeof RelayPolicy>[0]>, now?: () => number): RelayPolicy {
  return new RelayPolicy(config, now !== undefined ? { now } : undefined);
}

function expectReject(decision: PolicyDecision): Extract<PolicyDecision, { ok: false }> {
  expect(decision.ok).toBe(false);
  if (decision.ok) throw new Error('čakali sme zamietnutie');
  return decision;
}

describe('allowed kinds (default politika)', () => {
  it('akceptuje všetky kindy zo zoznamu 0, 3, 1020–1059, 10030, 10031, 27235, 30002, 30020–30029, 30400, 30401', () => {
    const relayPolicy = policy();
    const kinds = [0, 3, 1020, 1023, 1059, 10030, 10031, 27235, 30002, 30020, 30029, 30400, 30401];
    for (const kind of kinds) {
      const tags: NostrTag[] =
        kind === KINDS.POST
          ? [['e', ROOT_ID, 'root']]
          : kind >= 30000
            ? [['d', 'slug-01']]
            : [];
      expect(relayPolicy.evaluate(sign(kind, tags))).toEqual({ ok: true });
    }
  });

  it('odmietne kindy mimo zoznamu (4, 1, 1019, 1060, 20001, 27234, 30030, 10002)', () => {
    const relayPolicy = policy();
    for (const kind of [1, 4, 1019, 1060, 20001, 27234, 30030, 10002]) {
      const decision = expectReject(relayPolicy.evaluate(sign(kind)));
      expect(decision.code).toBe('kind');
      expect(okMessage(decision)).toMatch(/^rejected: kind /);
    }
  });

  // F4AI-35 (node mesh): kind 5 (NIP-09) je povolený, inak sa announcement
  // nedá stiahnúť a adresár drží uzol do TTL. Zvyšok pravidiel (adresát v
  // `e` tagu, podpis) nechať na klientoch — relay je dumb pipe.
  it('povolí kind 5 (NIP-09 deletion request, F4AI-35)', () => {
    const relayPolicy = policy();
    expect(relayPolicy.evaluate(sign(5, [['e', ROOT_ID]]))).toEqual({ ok: true });
    expect(DEFAULT_ALLOWED_KINDS.has(5)).toBe(true);
  });

  it('konfigurovateľný allowedKinds prepíše default', () => {
    const relayPolicy = policy({ allowedKinds: new Set([4]) });
    expect(relayPolicy.evaluate(sign(4))).toEqual({ ok: true });
    expect(expectReject(relayPolicy.evaluate(sign(KINDS.QUESTION))).code).toBe('kind');
    expect(DEFAULT_ALLOWED_KINDS.has(KINDS.QUESTION)).toBe(true);
  });
});

describe('kind 1023 — práve jeden root marker (zdieľané s shared validátorom)', () => {
  it('0 root markerov → rejected root_marker', () => {
    const decision = expectReject(
      policy().evaluate(sign(KINDS.POST, [['e', ROOT_ID, 'parent']])),
    );
    expect(decision.code).toBe('root_marker');
  });

  it('1 root marker s 64-hex id → akceptuj', () => {
    expect(policy().evaluate(sign(KINDS.POST, [['e', ROOT_ID, 'root']]))).toEqual({ ok: true });
  });

  it('2 root markery → rejected root_marker', () => {
    const tags: NostrTag[] = [
      ['e', ROOT_ID, 'root'],
      ['e', 'a'.repeat(64), 'root'],
    ];
    expect(expectReject(policy().evaluate(sign(KINDS.POST, tags))).code).toBe('root_marker');
  });

  it('root marker s ne-hex id → rejected root_marker', () => {
    const decision = expectReject(
      policy().evaluate(sign(KINDS.POST, [['e', 'nieje-hex', 'root']])),
    );
    expect(decision.code).toBe('root_marker');
  });
});

describe('addressable d-tag a topic 30020 pravidlá', () => {
  it('addressable 30002 bez d tagu → rejected d_tag', () => {
    expect(expectReject(policy().evaluate(sign(KINDS.OUTBOX))).code).toBe('d_tag');
  });

  it('topic 30020 s platným d slugom a parent a-tagom → akceptuj', () => {
    const tags: NostrTag[] = [
      ['d', 'rust-tokio'],
      ['a', `30020:${PUBKEY}:lang-rust`],
    ];
    expect(policy().evaluate(sign(KINDS.TOPIC, tags))).toEqual({ ok: true });
  });

  it('topic 30020 s neplatným slugom → rejected topic', () => {
    expect(expectReject(policy().evaluate(sign(KINDS.TOPIC, [['d', 'Bad Slug!']]))).code).toBe(
      'topic',
    );
  });

  it('topic 30020 s neplatným parent a-tagom → rejected topic', () => {
    const decision = expectReject(
      policy().evaluate(sign(KINDS.TOPIC, [['d', 'ok-slug'], ['a', '30023:abc:x']])),
    );
    expect(decision.code).toBe('topic');
  });
});

describe('NIP-13 PoW — výpočet vedúcich nulových bitov', () => {
  it('countLeadingZeroBitsHex sedí na hraničné prípady', () => {
    expect(countLeadingZeroBitsHex('f'.repeat(64))).toBe(0);
    expect(countLeadingZeroBitsHex('8' + '0'.repeat(63))).toBe(0);
    expect(countLeadingZeroBitsHex('7' + '0'.repeat(63))).toBe(1);
    expect(countLeadingZeroBitsHex('3' + '0'.repeat(63))).toBe(2);
    expect(countLeadingZeroBitsHex('1' + '0'.repeat(63))).toBe(3);
    expect(countLeadingZeroBitsHex('0' + 'f' + '0'.repeat(62))).toBe(4);
    expect(countLeadingZeroBitsHex('00' + 'f'.repeat(62))).toBe(8);
    expect(countLeadingZeroBitsHex('0'.repeat(63) + '1')).toBe(255);
    expect(countLeadingZeroBitsHex('0'.repeat(64))).toBe(256);
  });

  it('krížová kontrola s nostr-tools nip13.getPow na reálnych id', () => {
    for (const kind of [KINDS.QUESTION, KINDS.POST, KINDS.REACTION]) {
      const event = sign(kind, kind === KINDS.POST ? [['e', ROOT_ID, 'root']] : []);
      expect(countLeadingZeroBitsHex(event.id)).toBe(getPow(event.id));
    }
    const mined = mineEvent(KINDS.QUESTION, 8);
    expect(countLeadingZeroBitsHex(mined.id)).toBe(getPow(mined.id));
    expect(getPow(mined.id)).toBeGreaterThanOrEqual(8);
  });

  it('default prah 0 akceptuje aj event bez PoW', () => {
    expect(DEFAULT_POLICY.powMinDifficulty).toBe(0);
    expect(policy().evaluate(sign(KINDS.QUESTION))).toEqual({ ok: true });
  });

  it('prah >0 odmietne slabé id (pow:) a akceptuje nedený event', () => {
    const strict = policy({ powMinDifficulty: 8 });
    const weak = expectReject(strict.evaluate(sign(KINDS.QUESTION)));
    expect(weak.code).toBe('pow');
    expect(okMessage(weak)).toMatch(/^pow: /);
    expect(strict.evaluate(mineEvent(KINDS.QUESTION, 8))).toEqual({ ok: true });
  });
});

describe('rate limit per pubkey — klzacie okno', () => {
  it('SlidingWindowRateLimiter: max výplň, retryAfter, uvoľnenie po okne', () => {
    let nowMs = 1_000_000;
    const limiter = new SlidingWindowRateLimiter({
      maxEventsPerWindow: 3,
      windowMs: 60_000,
      now: () => nowMs,
    });
    expect(limiter.check('pk')).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(limiter.check('pk')).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(limiter.check('pk')).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(limiter.check('pk')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 60_000 });

    nowMs += 30_000; // uprostred okna — stále plné
    expect(limiter.check('pk').allowed).toBe(false);

    nowMs += 30_000; // prvý úder presne vypadol z okna (ts > cutoff)
    expect(limiter.check('pk').allowed).toBe(true);

    nowMs += 60_000; // celé okno vyprázdnené
    expect(limiter.check('pk')).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
  });

  it('okná sú per pubkey — vyčerpaný pubkey neovplyvní ostatné', () => {
    const nowMs = 0;
    const limiter = new SlidingWindowRateLimiter({
      maxEventsPerWindow: 1,
      windowMs: 1_000,
      now: () => nowMs,
    });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('policy: default 30/min, 31. správa je rate-limited; iný pubkey prejde', () => {
    let nowMs = 5_000_000;
    const relayPolicy = policy({ rateLimit: { maxEventsPerWindow: 2, windowMs: 60_000 } }, () => nowMs);
    expect(relayPolicy.evaluate(sign(KINDS.QUESTION, [], 'e1'))).toEqual({ ok: true });
    expect(relayPolicy.evaluate(sign(KINDS.QUESTION, [], 'e2'))).toEqual({ ok: true });
    const limited = expectReject(relayPolicy.evaluate(sign(KINDS.QUESTION, [], 'e3')));
    expect(limited.code).toBe('rate_limited');
    expect(okMessage(limited)).toMatch(/^rate-limited: /);

    const otherSk = generateSecretKey();
    const other = finalizeEvent(
      { kind: KINDS.QUESTION, created_at: CREATED_AT, tags: [], content: 'iný autor' },
      otherSk,
    ) as unknown as NostrEvent;
    expect(relayPolicy.evaluate(other)).toEqual({ ok: true });

    nowMs += 60_001; // okno vyprší
    expect(relayPolicy.evaluate(sign(KINDS.QUESTION, [], 'e4'))).toEqual({ ok: true });
    expect(DEFAULT_POLICY.rateLimit).toEqual({ maxEventsPerWindow: 30, windowMs: 60_000 });
  });

  it('rate limit počítá aj odmietnuté správy (guard prebehne pred ním)', () => {
    const nowMs = 0;
    const relayPolicy = policy({ rateLimit: { maxEventsPerWindow: 1, windowMs: 60_000 } }, () => nowMs);
    expect(expectReject(relayPolicy.evaluate(sign(4))).code).toBe('kind'); // započítané
    const second = expectReject(relayPolicy.evaluate(sign(KINDS.QUESTION)));
    expect(second.code).toBe('rate_limited');
  });
});

describe('podpis + prepočet hashu (verifyFull) a štruktúra', () => {
  it('pozmenený obsah: podpis sedí na staré id, ale id ≠ hash → rejected signature', () => {
    const event = sign(KINDS.QUESTION, [], 'pôvodný obsah');
    const tampered = { ...event, content: 'pozmenený obsah' };
    const decision = expectReject(policy().evaluate(tampered));
    expect(decision.code).toBe('signature');
  });

  it('pozmenený sig aj pozmenené id → rejected signature', () => {
    const event = sign(KINDS.QUESTION);
    expect(expectReject(policy().evaluate({ ...event, sig: '0'.repeat(128) })).code).toBe(
      'signature',
    );
    expect(expectReject(policy().evaluate({ ...event, id: '1'.repeat(64) })).code).toBe(
      'signature',
    );
  });

  it('created_at v milisekundách → rejected structure (A11 E1)', () => {
    const event = sign(KINDS.QUESTION);
    const decision = expectReject(policy().evaluate({ ...event, created_at: CREATED_AT * 1000 }));
    expect(decision.code).toBe('structure');
  });

  it('negramotný vstup → rejected structure, bez rate limit počtu', () => {
    const relayPolicy = policy({ rateLimit: { maxEventsPerWindow: 1, windowMs: 60_000 } });
    expect(expectReject(relayPolicy.evaluate('reťazec')).code).toBe('structure');
    expect(expectReject(relayPolicy.evaluate(null)).code).toBe('structure');
    expect(expectReject(relayPolicy.evaluate({ ...sign(KINDS.QUESTION), pubkey: 'xx' })).code).toBe(
      'structure',
    );
    // ani jeden z troch pokusov nezaplnil okno → platný event stále prejde
    expect(relayPolicy.evaluate(sign(KINDS.QUESTION))).toEqual({ ok: true });
  });

  it('PUBKEY sedí so shared typom (64 hex) — sanity', () => {
    expect(PUBKEY).toMatch(/^[0-9a-f]{64}$/);
    expect(sign(KINDS.QUESTION).pubkey).toBe(PUBKEY);
  });
});

describe('read-only rezim (Phase 6b-deploy, RELAY_READ_ONLY=1)', () => {
  it('default politika NIE je read-only — bežný event prejde', () => {
    expect(DEFAULT_POLICY.readOnly).toBe(false);
    expect(policy().evaluate(sign(KINDS.QUESTION))).toEqual({ ok: true });
  });

  it('readOnly zamietne každý kind kódom read_only (vrátane zakázaného kindu)', () => {
    const relayPolicy = policy({ readOnly: true });
    for (const kind of [0, 3, KINDS.QUESTION, KINDS.POST, KINDS.TOPIC, 30023, 9999]) {
      const decision = expectReject(relayPolicy.evaluate(sign(kind)));
      expect(decision.code).toBe('read_only');
    }
  });

  it('OK správa read-only relaya je `rejected: read-only relay`', () => {
    const decision = expectReject(policy({ readOnly: true }).evaluate(sign(KINDS.QUESTION)));
    expect(okMessage(decision)).toBe('rejected: read-only relay');
  });

  it('read-only rozhoduje PRVÉ — pred štruktúrou, kindom, PoW aj podpisom', () => {
    const relayPolicy = policy({ readOnly: true, powMinDifficulty: 18 });
    // negramotný vstup: aj tak read_only (nie structure)
    expect(expectReject(relayPolicy.evaluate('reťazec')).code).toBe('read_only');
    expect(expectReject(relayPolicy.evaluate(null)).code).toBe('read_only');
    // pubkey mimo hex: aj tak read_only (nie structure)
    expect(
      expectReject(relayPolicy.evaluate({ ...sign(KINDS.QUESTION), pubkey: 'xx' })).code,
    ).toBe('read_only');
    // event bez PoW pod práh 18: read_only, nie `pow`
    expect(expectReject(relayPolicy.evaluate(sign(KINDS.QUESTION))).code).toBe('read_only');
    // pokazene ID: read_only, nie `signature`
    expect(
      expectReject(relayPolicy.evaluate({ ...sign(KINDS.QUESTION), id: '1'.repeat(64) })).code,
    ).toBe('read_only');
  });

  it('read-only nečerpá rate-limit okno (dve odmietnutia ≠ rate_limited)', () => {
    const relayPolicy = policy({
      readOnly: true,
      rateLimit: { maxEventsPerWindow: 1, windowMs: 60_000 },
    });
    for (let i = 0; i < 3; i += 1) {
      expect(expectReject(relayPolicy.evaluate(sign(KINDS.QUESTION))).code).toBe('read_only');
    }
  });

  it('read-only relay stále pozná svoje allowed kinds (NIP-11 sa tým nemení)', () => {
    expect(policy({ readOnly: true }).config.allowedKinds).toBe(DEFAULT_ALLOWED_KINDS);
  });
});
