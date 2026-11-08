/**
 * In-memory NIP-01 store s polodisťovou storage semantikou:
 *  - regular 1000–9999      → append-only, dedup podľa id
 *  - ephemeral 20000–29999  → neukladá sa (len forward, OK bez uloženia)
 *  - replaceable 10000–19999→ LWW per (pubkey, kind)
 *  - addressable 30000+     → LWW per (pubkey, kind, d-tag)
 *
 * LWW pravidlo NIP-01: novší `created_at` vyhráva; pri rovnosti vyhráva
 * lexikograficky nižšie id.
 */
import { matchFilter } from 'nostr-tools/filter';
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools';
import type { NostrEvent } from '@forum4ai/shared';

export type StoreResult = 'stored' | 'replaced' | 'duplicate' | 'ephemeral';

/** NIP-11 `limitation.max_limit` — strop `limit`u jedného filteru. */
export const STORE_MAX_LIMIT = 1000;

function compareEvents(a: NostrEvent, b: NostrEvent): number {
  return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Vyhráva NOVŠÍ `created_at`; pri rovnosti lexikograficky NIŽŠIE id
 * (NIP-01). `compareEvents(event, current) >= 0` by znamenalo, že
 * novší event sa hodí ako duplicate — to bola chyba A1 (LWW obrátene),
 * preto explicitné porovnanie.
 */
function isNewerThan(event: NostrEvent, current: NostrEvent): boolean {
  return (
    event.created_at > current.created_at ||
    (event.created_at === current.created_at && event.id < current.id)
  );
}

export class MemoryStore {
  private readonly byId = new Map<string, NostrEvent>();
  /** adresa replaceable/addressable eventu → id aktuálneho eventu */
  private readonly byAddress = new Map<string, string>();
  private readonly maxLimit: number;

  constructor(maxLimit: number = STORE_MAX_LIMIT) {
    this.maxLimit = maxLimit;
  }

  static addressOf(event: NostrEvent): string | null {
    if (event.kind >= 10000 && event.kind < 20000) {
      // NIP-01 default je (pubkey, kind) bez `d`. Naša schéma však definuje
      // replaceable 10030 `idea_call_status` s `d` = id idea_callu a
      // kanonický status myšlienky je LWW per (autor, idea) — read-model
      // gatewayu aj LWW guard indexera (`addressFor`) počítajú s `d`
      // (rozhodnutie manažéra S10 v `gateway/src/ideas.ts`). Bez `d` v
      // adrese by relay zahodil status jednej myšlienky, keď autor publishne
      // status inej (code-review A3). Preto: `d` tag sa do adresy
      // replaceable kindu ZARÁTA, ak event `d` nesie.
      const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
      if (typeof d === 'string' && d !== '') {
        return `r:${event.pubkey}:${String(event.kind)}:${d}`;
      }
      return `r:${event.pubkey}:${String(event.kind)}`;
    }
    if (event.kind >= 30000) {
      const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
      return `a:${event.pubkey}:${String(event.kind)}:${d}`;
    }
    return null;
  }

  add(event: NostrEvent): StoreResult {
    if (event.kind >= 20000 && event.kind < 30000) return 'ephemeral';
    if (this.byId.has(event.id)) return 'duplicate';

    const address = MemoryStore.addressOf(event);
    if (address !== null) {
      const currentId = this.byAddress.get(address);
      const current = currentId !== undefined ? this.byId.get(currentId) : undefined;
      if (current !== undefined) {
        if (!isNewerThan(event, current)) return 'duplicate'; // starší/rovnaký LWW
        this.byId.delete(current.id);
        this.byAddress.set(address, event.id);
        this.byId.set(event.id, event);
        return 'replaced';
      }
      this.byAddress.set(address, event.id);
    }

    this.byId.set(event.id, event);
    return 'stored';
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /**
   * NIP-01 dotaz: zhoda s ľubovoľným filterom, `limit` aplikovaný per
   * filter (najnovšie), výsledok dedupnutý a zoradený podľa created_at
   * asc (požiadavka NIP-01 pre odosielanie EVENT správ).
   */
  query(filters: Filter[]): NostrEvent[] {
    const effective = filters.length > 0 ? filters : [{} as Filter];
    const out = new Map<string, NostrEvent>();
    for (const filter of effective) {
      let matched = [...this.byId.values()].filter((event) =>
        matchFilter(filter, event as Event),
      );
      matched.sort(compareEvents);
      // NIP-11 max_limit: filter bez `limit`u nesmie vrátiť celý store a
      // filter s obrovským limitom sa taktiež viaže na strop (A13).
      // Používame len EXPLICITNÝ `filter.limit` — `getFilterLimit()` z
      // nostr-tools odvodzuje viazanie aj z `authors`×replaceable kind
      // (1 event na autora+kind), čo náš per-`d` model 10030 (A3) zámerne
      // porušuje: jeden autor má N statusov, jeden na myšlienku.
      const requested = typeof filter.limit === 'number' ? Math.max(0, filter.limit) : this.maxLimit;
      const limit = Math.min(requested, this.maxLimit);
      matched = matched.slice(-limit);
      for (const event of matched) out.set(event.id, event);
    }
    return [...out.values()].sort(compareEvents);
  }

  matchesAnyFilter(event: NostrEvent, filters: Filter[]): boolean {
    return filters.some((filter) => matchFilter(filter, event as Event));
  }
}
