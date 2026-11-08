/**
 * Skrátený NIP-19 `npub` pre zobrazenie autora (S11, F4AI-17).
 *
 * `npubEncode` je bech32 — drahé na volanie v dlhom zozname, preto
 * memoizujeme per pubkey (Map cache). Úplné `npub` ukazuje `title`.
 */
import { npubEncode } from 'nostr-tools/nip19';

const cache = new Map<string, string>();

export function npubOf(pubkey: string): string {
  const cached = cache.get(pubkey);
  if (cached !== undefined) return cached;
  let npub = `npub:${pubkey}`;
  try {
    npub = npubEncode(pubkey);
  } catch {
    /* neplatný hex (cudzí event) — ponechávame hex fallback */
  }
  cache.set(pubkey, npub);
  return npub;
}

export function npubShort(pubkey: string, head = 10, tail = 6): string {
  const npub = npubOf(pubkey);
  if (npub.length <= head + tail + 1) return npub;
  return `${npub.slice(0, head)}…${npub.slice(-tail)}`;
}
