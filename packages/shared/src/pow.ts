/**
 * NIP-13 proof-of-work — čistý helper bez I/O (Phase 6a add-on).
 *
 * Prečo v shared: rovnakú ťažbu potrebujú tri miesta a žiadne z nich nesmie
 * implementovať vlastnú verziu počtu bitov:
 *   1. `packages/gateway/src/pow.ts` — republish 30028 a `operator approve`
 *      (verejná inštancia má `RELAY_POW_MIN=18` bez výnimiek),
 *   2. `scripts/seed-paper.mjs --pow N` — seed musí ísť publishnúť aj na
 *      verejnú inštanciu, inak ho relay odmietne,
 *   3. testy, ktoré chcú dokázať, že vyťažený id má skutočne N bitov.
 *
 * Počet vedúcich nulových bitov počíta vlastná funkcia
 * (`countLeadingZeroBits`) — ekvivalent nostr-tools `nip13.getPow`, krížovo
 * overený testom v `test/pow.test.ts`. Rovnaký algoritmus drží
 * `packages/relay/src/pow.ts` (politika relaya), takže obe strany počítajú
 * bitov TO ISTO a vyťažený event relay nepodradí.
 *
 * Determinizmus: nonce začína na 1 a inkrementuje, `created_at` je pevný →
 * pri rovnakom vstupe je výsledok VŽDY ten istý event (idempotentný re-run;
 * addressable kindy sa LWW nahradia samy seba).
 */
import { finalizeEvent, getEventHash, verifyEvent } from 'nostr-tools/pure';
import type { Event, UnsignedEvent } from 'nostr-tools';

/**
 * Poistka proti nekonečnej slučke: 18 bitov je ~260 k pokusov,
 * 26 miliónov je 20 bitov (dizajn P1 — gateway produkuje 30028 s `powMin`
 * z `GATEWAY_PUBLISH_POW_MIN`).
 */
export const MAX_POW_NONCE = 50_000_000;

const HEX_ONLY = /^[0-9a-f]*$/;

/**
 * Počet vedúcich nulových bitov hex reťazca (prázdny reťazec → 0).
 * TypeError pri ne-hex vstupe — volajúci overí tvar pred volaním.
 */
export function countLeadingZeroBits(hex: string): number {
  const lower = hex.toLowerCase();
  if (!HEX_ONLY.test(lower)) {
    throw new TypeError('countLeadingZeroBits: expected a hex string');
  }
  let bits = 0;
  for (const ch of lower) {
    if (ch === '0') {
      bits += 4;
      continue;
    }
    const nibble = parseInt(ch, 16);
    if (nibble === 1) bits += 3;
    else if (nibble <= 3) bits += 2;
    else if (nibble <= 7) bits += 1;
    return bits;
  }
  return bits; // samé nuly → 4 bity na znak
}

/** vstup na vyťaženie — `nonce` tag sa pridáva automaticky */
export interface PowInput {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Nájdi prvý nonce, pri ktorom má hash `powMin` vedúcich nulových bitov.
 * `nonce` tag má NIP-13 tvar `["nonce", <nonce>, <powMin>]`.
 *
 * Vráti aj hotový `id` (hash bez podpisu), aby volajúci vedel, čo ťažil,
 * skôr než to podpíše. Vyhodí RangeError pri neuskutočniteľnej obtiažnosti
 * (nonce > `MAX_POW_NONCE`).
 */
export function minePowNonce(
  input: PowInput,
  pubkey: string,
  powMin: number,
  maxNonce: number = MAX_POW_NONCE,
): { nonce: number; tags: string[][]; id: string; bits: number } {
  if (!Number.isInteger(powMin) || powMin < 0) {
    throw new RangeError(`minePowNonce: powMin must be a non-negative integer, got ${String(powMin)}`);
  }
  if (powMin === 0) {
    const tags = input.tags.map((tag) => [...tag]);
    const candidate: Omit<UnsignedEvent, 'id' | 'sig'> & { pubkey: string } = {
      pubkey,
      kind: input.kind,
      created_at: input.created_at,
      tags,
      content: input.content,
    };
    const id = getEventHash(candidate);
    return { nonce: 0, tags, id, bits: countLeadingZeroBits(id) };
  }
  let nonce = 0;
  for (;;) {
    nonce += 1;
    const tags = [...input.tags.map((tag) => [...tag]), ['nonce', String(nonce), String(powMin)]];
    const candidate: Omit<UnsignedEvent, 'id' | 'sig'> & { pubkey: string } = {
      pubkey,
      kind: input.kind,
      created_at: input.created_at,
      tags,
      content: input.content,
    };
    const id = getEventHash(candidate);
    const bits = countLeadingZeroBits(id);
    if (bits >= powMin) return { nonce, tags, id, bits };
    if (nonce >= maxNonce) {
      throw new RangeError(`minePowNonce: PoW ${String(powMin)} not mined after ${String(nonce)} nonces`);
    }
  }
}

/**
 * Yield to the event loop. `setImmediate` where it exists (Node), a
 * `setTimeout(0)` fallback in a browser bundle — the async miner below must
 * not block the UI thread while it hashes.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const schedule =
      (globalThis as { setImmediate?: (cb: () => void) => unknown }).setImmediate ??
      ((cb: () => void) => setTimeout(cb, 0));
    schedule(resolve);
  });
}

/**
 * Async variant of {@link minePowNonce}: identical search order (deterministic
 * nonce from 1), but it yields to the event loop every `yieldEvery` hashes.
 *
 * A gateway that announces itself (kind 30026) mines at the relay's PoW
 * difficulty once a minute. At difficulty 18 that is ~262k hashes — a few
 * hundred milliseconds of pure CPU, which on the main thread would stall
 * every in-flight request. Yielding keeps the loop responsive without the
 * cost of booting a worker per heartbeat.
 */
export async function minePowNonceAsync(
  input: PowInput,
  pubkey: string,
  powMin: number,
  maxNonce: number = MAX_POW_NONCE,
  yieldEvery: number = 20_000,
): Promise<{ nonce: number; tags: string[][]; id: string; bits: number }> {
  if (powMin === 0) return minePowNonce(input, pubkey, 0, maxNonce);
  let nonce = 0;
  for (;;) {
    nonce += 1;
    const tags = [...input.tags.map((tag) => [...tag]), ['nonce', String(nonce), String(powMin)]];
    const candidate: Omit<UnsignedEvent, 'id' | 'sig'> & { pubkey: string } = {
      pubkey,
      kind: input.kind,
      created_at: input.created_at,
      tags,
      content: input.content,
    };
    const id = getEventHash(candidate);
    const bits = countLeadingZeroBits(id);
    if (bits >= powMin) return { nonce, tags, id, bits };
    if (nonce >= maxNonce) {
      throw new RangeError(`minePowNonceAsync: PoW ${String(powMin)} not mined after ${String(nonce)} nonces`);
    }
    if (yieldEvery > 0 && nonce % yieldEvery === 0) await yieldToEventLoop();
  }
}

/**
 * Async variant of {@link signWithPow} (same guarantees: verified signature,
 * id matching the hash, mined difficulty). Use it on any path that must keep
 * serving requests while it mines.
 */
export async function signWithPowAsync(
  input: PowInput,
  secretKey: Uint8Array,
  powMin: number,
  pubkey: string,
  yieldEvery: number = 20_000,
): Promise<Event> {
  if (powMin <= 0) return signWithPow(input, secretKey, 0, pubkey);
  const mined = await minePowNonceAsync(input, pubkey, powMin, MAX_POW_NONCE, yieldEvery);
  const event = finalizeEvent({ ...input, tags: mined.tags }, secretKey);
  if (!verifyEvent(event)) throw new Error('signWithPowAsync: signature mismatch');
  if (getEventHash(event) !== event.id) throw new Error('signWithPowAsync: id does not match the hash');
  if (countLeadingZeroBits(event.id) < powMin) {
    throw new Error(
      `signWithPowAsync: mined id has only ${String(countLeadingZeroBits(event.id))} bits (wanted ${String(powMin)})`,
    );
  }
  return event;
}

/**
 * Vyťaží nonce a podpíše. `powMin = 0` je priama cesta — vtedy `nonce` tag
 * nepridávame vôbec, aby event nebol iný ako pred zavedením PoW.
 *
 * Kontrola po podpise: podpis platí, `id` sedí na hash a id má skutočne
 * vyťaženú obtiažnosť. Ak nie, hodí Error (nikdy nevráti ticho slabý event).
 */
export function signWithPow(
  input: PowInput,
  secretKey: Uint8Array,
  powMin: number,
  pubkey: string,
): Event {
  if (powMin <= 0) {
    const event = finalizeEvent({ ...input }, secretKey);
    if (!verifyEvent(event)) throw new Error('signWithPow: signature mismatch (powMin=0)');
    return event;
  }
  const mined = minePowNonce(input, pubkey, powMin);
  const event = finalizeEvent({ ...input, tags: mined.tags }, secretKey);
  if (!verifyEvent(event)) throw new Error('signWithPow: signature mismatch');
  if (getEventHash(event) !== event.id) throw new Error('signWithPow: id does not match the hash');
  if (countLeadingZeroBits(event.id) < powMin) {
    throw new Error(
      `signWithPow: mined id has only ${String(countLeadingZeroBits(event.id))} bits (wanted ${String(powMin)})`,
    );
  }
  return event;
}
