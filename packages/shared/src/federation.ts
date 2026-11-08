/**
 * Federation (Phase 6a, design Q5) — shared constants and shapes.
 *
 * The model from the design (Q5, binding): **separate topic trees, one shared
 * address space, local writes, federated reads.** Nothing is merged or
 * spliced, because a topic address already carries its author
 * (`30020:<pubkey>:<slug>`) — the same slug from two instances means two
 * different addresses, and they coexist.
 *
 * What is HERE (and what is not):
 *  - `origin` — where an event comes from: `'self'` (local) or the id of an
 *    upstream instance. The instance id is the **host** of its gateway (with
 *    port if explicit), e.g. `127.0.0.1:18081` or `aiforum.myhood.sk`.
 *    The UI draws a „from …" chip from it (6b); search returns it for EVERY
 *    result (local = `'self'`).
 *  - `NETWORK_ROOT_SLUG` — slug of the „Network" section under which the UI
 *    shows the roots of REMOTE instances. Remote trees are never linked into
 *    the local tree (Q5: „never re-parented").
 *  - `FED_SYNC_KINDS` — kinds that are exchanged between instances
 *    (the content overlay). Infra kinds (30028 writers, 30002 outbox,
 *    1055 claim) are not sent — their source of truth is the relay, not the gateway.
 *
 * **No `instance-info` kind.** Design Q5 defines no instance announcement via
 * a kind (no relay/service discovery of any sort): the list of upstream
 * instances is **static configuration** (`GATEWAY_UPSTREAM_GATEWAYS`), and
 * the upstream identity is the host of its URL. That is also why the `origin`
 * string does not look like a pubkey — it is a host, not a key.
 */
import { KINDS } from './kinds.js';

/**
 * Hodnota `origin` pre eventy tejto inštancie. Je to JEDINÁ reťazcová
 * konštanta tohto typu — ostatné hodnoty sú id upstream inštancie
 * (host), ktoré prichádzajú z konfigurácie.
 */
export const ORIGIN_SELF = 'self';

/**
 * Tvár `origin`: `'self'` alebo id upstream inštancie (host gatewaya).
 * Typovo je to reťazec, lebo množina upstreamov nie je známa v čase
 * kompilácie — `isSelfOrigin()` je jediný spoľahlivý test na domácosť.
 */
export type EventOrigin = string;

/** `true` = event patrí tejto inštancii (nie je to kópija z upstreamu). */
export function isSelfOrigin(origin: string | null | undefined): boolean {
  return origin === null || origin === undefined || origin === ORIGIN_SELF;
}

/**
 * Normalizácia `origin` hodnoty na uloženie/vrátenie. Prázdny reťazec a
 * neplatné vstupy znamenajú „nevieme" → `'self'` (rovnaká konvencia ako
 * default stĺpca `origin TEXT DEFAULT 'self'` v indexeri).
 */
export function normalizeOrigin(origin: unknown): EventOrigin {
  if (typeof origin !== 'string') return ORIGIN_SELF;
  const trimmed = origin.trim();
  return trimmed === '' ? ORIGIN_SELF : trimmed;
}

/**
 * Slug sekcie „Network" — korene vzdialených inštancií. NIE je to adresa
 * topiku: je to identifikátor UI sekcie, pod ktorou remote stromy žijú
 * (Q5: „Remote instances' roots appear under **Network** as separate
 * trees"). Domáci strom je `INSTANCE_ROOT_TOPIC`, nikdy sa s ním nemiešajú.
 */
export const NETWORK_ROOT_SLUG = 'network';
/** čitateľný názov sekcie (UI ho prekladá, toto je technický label) */
export const NETWORK_SECTION_LABEL = 'Network';

/**
 * Kindy, ktoré sa federujú (push + pull overlay obsahu).
 *
 * Dizajn Q5 + zadanie 6a: `1020–1032` (thread roots, odpovede, reakcie,
 * hlasovanie a reputačné kindy), `10030` (kanonický status idea_callu),
 * `30020` (topiky — bez nich by vzdialený strom nemal uzly) a `30023`
 * (papiere). `1021`/`1022` sú už v rozsahu 1020–1032.
 *
 * ZÁMERNE mimo: `30028` (zoznam pisúcich — ten sa šíri relaymi, nie
 * gatewayom, a je to politika inej inštancie), `30002` (outbox markers),
 * `1055` (registračný claim), `27235` (NIP-98 auth) a `1040` LABEL
 * (auditný záznam domácej moderácie).
 */
export const FED_SYNC_KINDS: readonly number[] = [
  KINDS.QUESTION, // 1020
  KINDS.IDEA_CALL, // 1021
  KINDS.COLLAB_CALL, // 1022
  KINDS.POST, // 1023
  KINDS.REACTION, // 1024
  KINDS.VOTE, // 1030
  KINDS.SOLUTION_RATING, // 1031
  KINDS.ACCEPTED_SOLUTION, // 1032
  KINDS.IDEA_CALL_STATUS, // 10030
  KINDS.TOPIC, // 30020
  KINDS.PUBLICATION, // 30023
];

/** rýchly test príslušnosti kindu do federovaného overlaya */
export const FED_SYNC_KIND_SET: ReadonlySet<number> = new Set<number>(FED_SYNC_KINDS);

/** Smie sa tento kind posielať medzi inštanciami? */
export function isFedSyncKind(kind: number): boolean {
  return FED_SYNC_KIND_SET.has(kind);
}

/**
 * Id upstream inštancie z jej gateway URL. Default pravidlo (dizajn Q5:
 * „Results get `origin` (the host from the trusted directory's
 * `["gateway",…]`)"): **host vrátane explicitného portu**, bez schémy a
 * bez cesty. `/api` suffix sa stripuje, lebo verejné inštancie exposeujú
 * gateway za Caddy pod `https://host/api`.
 *
 * Vracia `null` pri neplatnej URL — volajúci (config) then položku vynechá
 * a hlási to, nie tichý fallback na reťazec.
 */
export function upstreamIdFromUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.host.trim().toLowerCase();
  return host === '' ? null : host;
}

/**
 * Adresa addressable kindu (`kind:pubkey:d`) — used by the federation
 * topic view and the `origin` chip to point at a remote tree. Kánonický
 * tvar zhodný s `addressFor()` v indexeri a `lwwByAddress()` v gateway
 * read-model (jeden formát adresy v celom stacke).
 */
export function addressOf(kind: number, pubkey: string, dTagValue: string): string {
  return `${String(kind)}:${pubkey}:${dTagValue}`;
}

/** adresa topiku `30020:<pubkey>:<slug>` (Q5: adresný priestor je jeden) */
export function topicAddress(pubkey: string, slug: string): string {
  return addressOf(KINDS.TOPIC, pubkey, slug);
}

/**
 * Rozparsuje adresu `kind:pubkey:d`. Vracia `null` pri neplatnom tvare —
 * volajúci then položku preskočí (adresa sa nikdy nepoužije na niečo,
 * čomu nerozumieme).
 */
export function parseAddress(
  addr: string,
): { kind: number; pubkey: string; d: string } | null {
  if (typeof addr !== 'string') return null;
  const first = addr.indexOf(':');
  const second = addr.indexOf(':', first + 1);
  if (first <= 0 || second <= first) return null;
  const kind = Number(addr.slice(0, first));
  const pubkey = addr.slice(first + 1, second);
  if (!Number.isInteger(kind) || kind < 0) return null;
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
  return { kind, pubkey, d: addr.slice(second + 1) };
}
