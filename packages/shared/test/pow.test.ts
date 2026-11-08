/**
 * Testy NIP-13 PoW helpera (Phase 6a).
 *
 * Dôvod, prečo sa testuje samostatne: `scripts/seed-paper.mjs --pow N` a
 * gateway republish 30028 jedia z TOHOTO istého helpera a verejná inštancia
 * má `RELAY_POW_MIN=18` bez výnimiek — ak by počet bitov sedel len
 * „približne", relay event odmietne a seed zmizne ticho.
 *
 * Krížová kontrola: `countLeadingZeroBits` sa porovnáva s nostr-tools
 * `nip13.getPow` (na ktorom stojí politika relaya aj naše testy) na
 * náhodných id, nielen na ručne vybraných hex reťazcoch.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { getPow } from 'nostr-tools/nip13';

import {
  MAX_POW_NONCE,
  countLeadingZeroBits,
  minePowNonce,
  signWithPow,
} from '../src/pow.js';

const T0 = 1_730_000_000;

describe('countLeadingZeroBits', () => {
  it('počíta bity po nibble-och (4, 3, 2, 1, 0)', () => {
    expect(countLeadingZeroBits('')).toBe(0);
    expect(countLeadingZeroBits('0000')).toBe(16);
    // prvý nenulový nibble prispie svojimi vedúcimi nulami: 1 = 0001 → 3 bity
    expect(countLeadingZeroBits('0001')).toBe(15);
    expect(countLeadingZeroBits('0002')).toBe(14);
    expect(countLeadingZeroBits('0004')).toBe(13);
    expect(countLeadingZeroBits('0008')).toBe(12);
    expect(countLeadingZeroBits('000f')).toBe(12);
    expect(countLeadingZeroBits('f')).toBe(0);
    // samé nuly → 4 bity na znak
    expect(countLeadingZeroBits('00')).toBe(8);
  });

  it('je jednoľahkostný voči veľkým písmenám', () => {
    expect(countLeadingZeroBits('000A')).toBe(countLeadingZeroBits('000a'));
  });

  it('nehex vstup hodí TypeError (volajúci overí tvar pred volaním)', () => {
    expect(() => countLeadingZeroBits('xyz')).toThrow(TypeError);
    expect(() => countLeadingZeroBits('0g')).toThrow('expected a hex string');
  });

  it('krížovo sedí s nostr-tools getPow na 20 náhodných id', () => {
    const sk = generateSecretKey();
    for (let i = 0; i < 20; i += 1) {
      const event = finalizeEvent(
        { kind: 1023, created_at: T0 + i, tags: [], content: `cross-check ${String(i)}` },
        sk,
      );
      expect(countLeadingZeroBits(event.id), `id ${event.id}`).toBe(getPow(event.id));
    }
  });
});

describe('minePowNonce', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  it('powMin=0 nepridáva nonce tag vôbec', () => {
    const mined = minePowNonce({ kind: 30023, created_at: T0, tags: [['d', 'x']], content: 'a' }, pk, 0);
    expect(mined.nonce).toBe(0);
    expect(mined.tags).toEqual([['d', 'x']]);
    expect(mined.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('vyťaží požadovanú obtiažnosť a nonce tag má NIP-13 tvar', () => {
    const powMin = 8; // ~256 pokusov — lacné a spoľahlivé
    const input = { kind: 30023, created_at: T0, tags: [['d', 'pow-demo']], content: 'body' };
    const mined = minePowNonce(input, pk, powMin);
    expect(mined.bits).toBeGreaterThanOrEqual(powMin);
    expect(countLeadingZeroBits(mined.id)).toBeGreaterThanOrEqual(powMin);
    expect(mined.tags.at(-1)).toEqual(['nonce', String(mined.nonce), String(powMin)]);
    expect(mined.tags.slice(0, 1)).toEqual([['d', 'pow-demo']]);
  });

  it('je deterministický — rovnaký vstup dá rovnaké id (idempotentný re-run)', () => {
    const input = { kind: 30023, created_at: T0, tags: [['d', 'stable']], content: 'same' };
    const first = minePowNonce(input, pk, 6);
    const second = minePowNonce(input, pk, 6);
    expect(second.id).toBe(first.id);
    expect(second.nonce).toBe(first.nonce);
  });

  it('mutuje len svoju kópiu tagov — originál input.tagov ostáva nedotknutý', () => {
    const tags = [['d', 'immutable']];
    minePowNonce({ kind: 1023, created_at: T0, tags, content: 'x' }, pk, 4);
    expect(tags).toEqual([['d', 'immutable']]);
  });

  it('neuskutočniteľná obtiažnosť v stropu pokusov → RangeError', () => {
    const input = { kind: 1023, created_at: T0, tags: [] as string[][], content: 'hard' };
    expect(() => minePowNonce(input, pk, 24, 5)).toThrow(/not mined after/);
  });

  it('záporná alebo neceločíselná obtiažnosť → RangeError (nie tichý fallback)', () => {
    const input = { kind: 1023, created_at: T0, tags: [] as string[][], content: 'x' };
    expect(() => minePowNonce(input, pk, -1)).toThrow(RangeError);
    expect(() => minePowNonce(input, pk, 1.5)).toThrow(RangeError);
  });

  it('MAX_POW_NONCE je dostatočný strop pre 20 bitov', () => {
    expect(MAX_POW_NONCE).toBeGreaterThan(1_000_000);
  });
});

describe('signWithPow', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  it('podpíše a id má skutočne vyťaženú obtiažnosť', () => {
    const event = signWithPow(
      { kind: 30028, created_at: T0, tags: [['d', 'forum4ai-writers']], content: '{}' },
      sk,
      7,
      pk,
    );
    expect(getPow(event.id)).toBeGreaterThanOrEqual(7);
    expect(event.pubkey).toBe(pk);
    expect(event.tags.at(-1)?.[0]).toBe('nonce');
  });

  it('dve ťaženia rovnakého vstupu majú rovnaké id (nonce je deterministický)', () => {
    const input = { kind: 30028, created_at: T0, tags: [['d', 'writers']], content: '{"a":1}' };
    const a = signWithPow(input, sk, 6, pk);
    const b = signWithPow(input, sk, 6, pk);
    // `id` je hash obsahu → deterministický (na ňom visí LWW idempotencia
    // seedu). `sig` NIE JE deterministický: BIP-340 podpis mieša aux-entropy
    // (RFC6979 + prídavná entropia), takže rovnaký event má vždy iný podpis.
    expect(b.id).toBe(a.id);
    expect(b.tags).toEqual(a.tags);
    expect(b.created_at).toBe(a.created_at);
  });

  it('powMin=0 = priama cesta bez nonce tagu (rovnaké správanie pred PoW)', () => {
    const event = signWithPow({ kind: 1023, created_at: T0, tags: [], content: 'plain' }, sk, 0, pk);
    expect(event.tags).toEqual([]);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
  });
});
