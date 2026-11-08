/**
 * Phase 6b-deploy: **backfill** — read-only relay si musí vedieť naplniť
 * obsah, inak by bol prázdny (naše relay pole sú `MemoryStore`, bez disku:
 * `store.ts`, komentár v `docker-compose.vps.yml`).
 *
 * `RELAY_BACKFILL_URL` preto povie: „stiahni eventy z iného relayu (zvyčajne
 * `ws://strfry:7777`, ktoré je durable LMDB) a vlož ich priamo do store".
 * Vklad obchádza politiku (a teda aj `readOnly`) — to je zámer: read-only
 * rezim zakazuje **klientsky** zápis (`EVENT` správy po WS), nie to, že by
 * relay nemal čo odpovedať na `REQ`. Pred vložením sa podpis + hash overia
 * `verifyFull`, takže backfill neprináša neoverené eventy.
 *
 * Stránkovanie: **spätné okná** cez `until` (filter `{kinds, until, limit}`),
 * teda presne rovnaká technika ako `fetchVerifiedWindowed` v gatewayi — relay
 * (naše `MemoryStore.query` aj strfry) vracia NAJNOVŠÍCH `limit` eventov,
 * takže sa posúvame `until = min(created_at okna) - 1` dozadu. Dopredné
 * okná cez `since` by pri viacerých eventoch s rovnakým `created_at` uviazli
 * na tej istej stránke. Duplikáty sú neškodné: `MemoryStore.add` ich vráti
 * ako `duplicate`.
 */
import { Relay } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools';
import type { NostrEvent } from '@forum4ai/shared';

import type { MemoryStore } from './store.js';
import { verifyFull } from './verify.js';

export interface BackfillConfig {
  /** ws:// alebo wss:// zdrojového relayu */
  url: string;
  /** kindy, ktoré sa stiahnu (default: allowed kinds relaya) */
  kinds: number[];
  /** spodná hranica okna (0 = od začiatku; pri periodicite = kurzor) */
  since: number;
  /** horná hranica prvého okna (undefined = bez horného medzníka) */
  until?: number;
  /** strop `limit`u jedného filteru — strfry aj naše relay majú 500 */
  limit: number;
  /** max stránok v jednom behu (brána proti nekonečnému behu) */
  maxPages: number;
}

export const BACKFILL_DEFAULTS = {
  since: 0,
  limit: 500,
  maxPages: 20,
} satisfies Partial<BackfillConfig>;

export interface BackfillResult {
  scanned: number;
  inserted: number;
  replaced: number;
  duplicate: number;
  invalid: number;
  /** najvyšší videnej `created_at` — kurzor pre ďalší beh */
  cursor: number;
  pages: number;
  error?: string;
}

/** Stiahni jedno okno a počkaj na EOSE (nostr-tools `Relay.subscribe`). */
function fetchPage(
  relay: Relay,
  config: BackfillConfig,
  until: number | undefined,
): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const events: Event[] = [];
    const timeout = setTimeout(
      () => reject(new Error(`backfill: EOSE neprišlo do 30 s (${config.url})`)),
      30_000,
    );
    const filter: Record<string, unknown> = { kinds: config.kinds, limit: config.limit };
    if (config.since > 0) filter['since'] = config.since;
    if (until !== undefined) filter['until'] = until;
    relay.subscribe([filter as never], {
      onevent: (event) => events.push(event),
      oneose: () => {
        clearTimeout(timeout);
        resolve(events);
      },
      onclose: (reason) => {
        clearTimeout(timeout);
        reject(new Error(`backfill: subscripcia zavretá (${reason})`));
      },
    });
  });
}

/**
 * Jeden beh backfillu: stránkuj od `since`, over podpis, vlož do store.
 * Vracia štatistiky — volajúci (cli) si uchová kurzor pre periodicitu.
 */
export async function backfillOnce(
  store: MemoryStore,
  config: BackfillConfig,
  log: (message: string) => void = () => {},
): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    inserted: 0,
    replaced: 0,
    duplicate: 0,
    invalid: 0,
    cursor: config.since,
    pages: 0,
  };
  let relay: Relay | null = null;
  try {
    relay = await Relay.connect(config.url);
    const seen = new Set<string>();
    let until = config.until;
    for (let page = 0; page < config.maxPages; page += 1) {
      const events = await fetchPage(relay, config, until);
      result.pages += 1;
      result.scanned += events.length;
      let fresh = 0;
      let minTs = Number.POSITIVE_INFINITY;
      for (const event of events) {
        if (event.created_at < minTs) minTs = event.created_at;
        if (event.created_at > result.cursor) result.cursor = event.created_at;
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        fresh += 1;
        if (!verifyFull(event as NostrEvent)) {
          result.invalid += 1;
          continue;
        }
        const outcome = store.add(event as NostrEvent);
        if (outcome === 'stored') result.inserted += 1;
        else if (outcome === 'replaced') result.replaced += 1;
        else if (outcome === 'duplicate') result.duplicate += 1;
      }
      if (events.length < config.limit) break; // neúplné okno = koniec histórie
      if (fresh === 0) break; // plné okno samých duplicítov — ďalšie nepomôže
      if (!Number.isFinite(minTs)) break;
      until = minTs - 1; // posun okna dozadu (rovnako ako gateway)
    }
    relay.close();
    relay = null;
    log(
      `backfill: scanned=${String(result.scanned)} inserted=${String(result.inserted)} ` +
        `replaced=${String(result.replaced)} duplicate=${String(result.duplicate)} ` +
        `invalid=${String(result.invalid)} cursor=${String(result.cursor)} pages=${String(result.pages)}`,
    );
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`backfill: zlyhalo (${result.error}) — skúsim znova neskôr`);
  } finally {
    if (relay !== null) {
      try {
        relay.close();
      } catch {
        /* už zavreté */
      }
    }
  }
  return result;
}

/**
 * Backfill v slučke: prvý beh hneď pri štarte, potom každých `intervalMs`.
 * Vracia close() funkciu, aby server vedel slučku zastaviť.
 */
export function startBackfillLoop(
  store: MemoryStore,
  config: BackfillConfig,
  intervalMs: number,
  log: (message: string) => void = () => {},
): () => void {
  let cursor = config.since;
  let stopped = false;
  const run = async (): Promise<void> => {
    if (stopped) return;
    const result = await backfillOnce(store, { ...config, since: cursor }, log);
    if (result.error === undefined) cursor = result.cursor;
  };
  void run();
  const timer = intervalMs > 0 ? setInterval(() => void run(), intervalMs) : null;
  return () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
  };
}
