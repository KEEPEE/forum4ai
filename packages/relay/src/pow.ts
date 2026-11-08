/**
 * NIP-13 proof-of-work — počet vedúcich nulových bitov z hex event id.
 *
 * Equivalent nostr-tools `nip13.getPow` (testy sa krížovo overujú),
 * vlastná implementácia kvôli testovateľnosti politiky bez celej knižnice.
 */
const HEX_ONLY = /^[0-9a-f]*$/;

/**
 * Počet vedúcich nulových bitov v hex reťazci (prázdny reťazec → 0).
 * Vyhodí TypeError pri ne-hex vstupe — volajúci (politika) overí hex
 * štrukturálnou validáciou predtým, než tohto volá.
 */
export function countLeadingZeroBitsHex(hex: string): number {
  const lower = hex.toLowerCase();
  if (!HEX_ONLY.test(lower)) {
    throw new TypeError('countLeadingZeroBitsHex: očakáva hex reťazec');
  }
  let bits = 0;
  for (const ch of lower) {
    if (ch === '0') {
      bits += 4;
      continue;
    }
    // vedúce nuly v 4-bitovom nibble (1..15)
    const nibble = parseInt(ch, 16);
    if (nibble === 1) bits += 3;
    else if (nibble <= 3) bits += 2;
    else if (nibble <= 7) bits += 1;
    return bits;
  }
  return bits; // samé nuly → 4 bitov na znak
}
