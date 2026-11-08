/**
 * Úplná NIP-01 overovacia funkcia — presunutá zo `packages/relay/src/verify.ts`
 * do shared v rámci F4AI-10, lebo ju potrebuje aj gateway (S4) pri prijímaní
 * predpodepísaných eventov na `POST /events`. Relay ju naďalej reexportuje
 * zo svojho `verify.ts`, verejné API `@forum4ai/relay` sa tým nemení.
 *
 * Pôvodný test logiky: `packages/shared/test/event-signature.test.ts`.
 *
 * DVA zádrhely nostr-tools, ktoré tu riešime explicitne:
 *  1. `verifyEvent` sám o sebe nespoliehame sa na neho bez prepočtu —
 *     preto aj `getEventHash(event) === event.id` (S1 poznámka).
 *  2. nostr-tools 2.x si memoizuje výsledok overenia pod `Symbol`
 *     (`event[verifiedSymbol]`) a `finalizeEvent` ho nastaví na true.
 *     Spread `{ ...event }` symbol prenesie, takže pozmenená kópia by
 *     dostala staré `true` bez akejkoľvek kontroly. Preto staviame
 *     čerstvú kánonickú 7-pole verziu — bez symbolových príznakov.
 *     (Na dráte prichádzajú eventy z `JSON.parse` bez symbolov, ale
 *     volajúci ich môže mať lokálne podpísané — napr. gateway testy.)
 */
import { getEventHash, verifyEvent } from 'nostr-tools';
import type { Event } from 'nostr-tools';

import type { NostrEvent } from './types.js';

export function verifyFull(event: NostrEvent): boolean {
  try {
    const candidate = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    } as Event;
    return verifyEvent(candidate) && getEventHash(candidate) === event.id;
  } catch {
    return false;
  }
}
