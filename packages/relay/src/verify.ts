/**
 * Re-export: implementácia `verifyFull` sídli v `@forum4ai/shared/src/verify.ts`
 * (presunuté v rámci F4AI-10, lebo ju potrebuje aj gateway pri overovaní
 * eventov na `POST /events`). Tento súbor necháva import `./verify.js`
 * funkčný — politika aj testy relay ostávajú bez zmeny a verejné API
 * `@forum4ai/relay` sa nemení.
 *
 * Pôvodné zdôvodnenie (nostr-tools memoizuje overenie pod Symbol +
 * povinný prepočet NIP-01 hashu) je zdokumentované v shared implementácii.
 */
export { verifyFull } from '@forum4ai/shared';
