/**
 * Phase 6b: federation in the UI (design Q5, backend phase 6a).
 *
 * Same convention as `lib/lang.ts`: the UI keeps ITS OWN copy of these small
 * helpers, because a runtime import from `@forum4ai/shared` would drag into the
 * bundle things the UI does not need. The one thing the UI MUST respect to the
 * letter is the shape of an upstream id — that is `url.host` from
 * `upstreamIdFromUrl` in `packages/shared/src/federation.ts` (lowercase `host[:port]`).
 *
 * Two trees, one address space (Q5): foreign 30020 roots have their own tree and
 * their own section ( NETWORK ), and are never joined as children of a domestic
 * root. That is why every decision in this file works with `origin` — not with
 * "mine/foreign" decided by pubkey.
 *
 * The key asymmetry the UI must not break: the `origin` field on hits IS MISSING
 * when the gateway runs on a pre-6a index. A missing field does not mean
 * "domestic" — it means "we do not know", and then nothing is drawn.
 */
import type { FedRemoteTopic, FedTopicsResponse, FedUpstreamTopics } from '../api/types.js';

/** hodnotu `origin` pre domáce eventy posiela gateway ako `self` */
export const ORIGIN_SELF = 'self';
/** `origin=any` = explicitne bez filtra (gateway pole `filters.origin` nespomína) */
export const ORIGIN_ANY = 'any';
/**
 * Sentinel UI-čka pre "bez filtra". Gateway ho NEPOZNÁ (ten má `any`),
 * preto sa nikdy neposieme — a preto aj NESMIE byť považovaný za id
 * upstreamu, inak by select pridal voľbu `all` medzi inštancie.
 */
export const ORIGIN_ALL = 'all';

/**
 * Filter pôvodu na vyhľadávacej stránke. `all` = parameter sa nepošle
 * (gateway default `any`), `self` = len domáce stromy, inak presné
 * id upstreamu. Rovnaký tvar ako `LangFilter` v `lib/lang.ts`, lebo aj
 * ovládanie je rovnaké — select vedľa jazykového filtru.
 */
export type OriginFilter = 'all' | 'self' | string;

/** normalizácia id podľa `upstreamIdFromUrl` (lowercase, bez medzier) */
export function normalizeOriginId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Je hit z cudzej inštancie? `false` pre `'self'` AJ pre chýbajúce pole
 * (gateway pred 6a) — stipok sa vtedy nekreslí, nie sa kreslí "self".
 *
 * Vylučujeme aj `any`/`all`: to sú hodnoty FILTRA, nie pôvodu hitu, ale
 * tento predikát používame na oboch miestach (stipok aj select), takže
 * musí sedieť na oboch. Teoretické hostname `all` by sa v id objaviť
 * mohol, ale filter by aj tak potreboval vlastný sentinel.
 */
export function isRemoteOrigin(origin: string | undefined | null): boolean {
  const id = normalizeOriginId(origin);
  return id !== null && id !== ORIGIN_SELF && id !== ORIGIN_ANY && id !== ORIGIN_ALL;
}

/**
 * Krátky label stipku: host bez portu (`b.example:18081` → `b.example`,
 * `[::1]:18081` → `[::1]`). Port na stipku nič nehovorí a zaberá miesto;
 * plné id je v title/tip. Ak by po orezaní ostalo prázdne, vraciame id
 * celé (radšej dlhý štítok ako prázdny).
 */
export function originShortLabel(origin: string | undefined | null): string {
  const id = normalizeOriginId(origin);
  if (id === null) return '';
  if (id.startsWith('[')) {
    const end = id.indexOf(']');
    if (end > 0) return id.slice(0, end + 1);
    return id;
  }
  const colon = id.lastIndexOf(':');
  if (colon <= 0) return id;
  const host = id.slice(0, colon);
  return host === '' ? id : host;
}

/**
 * Varovanie: autor NIE JE v adresári pisúcich tejto inštancie. Gateway
 * posiela boolean (`row.trusted === 1`), read-only DB vracia 0/1 — preto
 * počítame obe falsy hodnoty. `undefined` (pole chýba) nie je varovanie:
 * nevieme, a "nevieme" neznamená "nedôveryhodný".
 */
export function isUntrustedOrigin(trusted: boolean | number | undefined): boolean {
  return trusted === false || trusted === 0;
}

/** query parameter pre `GET /search` (`undefined` = parameter sa nepošle) */
export function originFilterParam(filter: OriginFilter): string | undefined {
  if (filter === ORIGIN_ALL) return undefined;
  if (filter === ORIGIN_SELF) return ORIGIN_SELF;
  const id = normalizeOriginId(filter);
  // `any` z URL sa správa ako "bez filtra" (gateway default), nikdy ho
  // neposieme ako id — inak by `origin=any` mohol znamenať hostname `any`
  if (id === null || id === ORIGIN_ANY) return undefined;
  return id;
}

/** filter z URL paramu — prázdny/neznamý tvar je `all`, nikdy nie chyba */
export function readOriginParam(raw: string | null | undefined): OriginFilter {
  if (raw === null || raw === undefined) return ORIGIN_ALL;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === ORIGIN_ANY) return ORIGIN_ALL;
  if (trimmed === ORIGIN_SELF) return ORIGIN_SELF;
  return normalizeOriginId(trimmed) ?? ORIGIN_ALL;
}

/**
 * Upstreamy objavené vo výsledkoch (bez `self`, dedup, abecedne). Select
 * ich ponúka ako filter — a keďže id pochádza od gatewaya, `origin=`
 * filter s ním nepadne na 400 `invalid origin`.
 */
export function collectOrigins(results: readonly { origin?: string }[] | undefined): string[] {
  if (!Array.isArray(results)) return [];
  const found = new Set<string>();
  for (const hit of results) {
    if (!isRemoteOrigin(hit.origin)) continue;
    const id = normalizeOriginId(hit.origin);
    if (id !== null) found.add(id);
  }
  return [...found].sort();
}

/**
 * Options selectu: objavené id + práve vybrané id, aj keď ho výsledky
 * neobsahujú (inak by select po prvom presnom zásahu ticho skočil na
 * `all` — rovnaké pravidlo ako `seenLangs` pri jazykovom filtry).
 */
export function originFilterOptions(results: readonly { origin?: string }[] | undefined, selected: OriginFilter): string[] {
  const options = collectOrigins(results);
  if (isRemoteOrigin(selected)) {
    const id = normalizeOriginId(selected);
    if (id !== null && !options.includes(id)) options.push(id);
  }
  return options;
}

/** koreň + jeho upstream, dokopy pre navigáciu aj hlavičku cudzieho topiku */
export interface RemoteTopicMatch {
  upstream: FedUpstreamTopics;
  root: FedRemoteTopic;
}

/**
 * Jediná cesta, ktorou UI (6b) rozlišuje CUDZÍ koreňový topic:
 * `GET /fed/topics` (verejné, per-upstream korene 30020).
 *
 * Prečo nie `GET /search?kinds=30020&a=<addr>`: gateway REST nemá filter
 * podľa adresy (`a=`) vôbec — `q` je povinné a tokenizovaný by bol aj
 * `tags_text`, takže by to bol heuristický dopyt, nie presné čítanie.
 * `/fed/events` zase vráca LOKÁLNY obsah (relay pool), nie cudzie eventy.
 *
 * Pravidlo výberu je presné, nie heuristické:
 *  1. upstream s `id === origin` (normalizované),
 *  2. koreň s `slug === slug`; ak ich je viac (A8: dva korene môžu mať
 *     rovnaký slug od rôznych autorov), vyhráva NAJSTARŠÍ `created_at`,
 *     čo je rovnaké poradie ako `remoteRootTopics()` v `fed/db.ts`.
 *
 * `null` = not found → volajúci ukáže own empty/error stav, nie 404
 * domácej route (cudzí topic na našom gatewayi jednoducho ešte nie je).
 */
export function findRemoteTopicRoot(
  response: FedTopicsResponse | null | undefined,
  origin: string,
  slug: string,
): RemoteTopicMatch | null {
  const id = normalizeOriginId(origin);
  if (response === null || response === undefined || id === null) return null;
  const upstream = response.upstreams.find((entry) => normalizeOriginId(entry.id) === id);
  if (upstream === undefined) return null;
  let best: FedRemoteTopic | null = null;
  for (const root of upstream.roots) {
    if (root.slug !== slug) continue;
    if (best === null || root.created_at < best.created_at) best = root;
  }
  return best === null ? null : { upstream, root: best };
}
