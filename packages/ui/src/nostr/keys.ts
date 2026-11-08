/**
 * Nostr kľúče a signing (S11, F4AI-17).
 *
 * Postup podľa zadania: NIP-04 nepoužívame (nie je čo šifrovať), podpis ide
 * čisto NIP-01 — `finalizeEvent` z `nostr-tools/pure` dopočíta `id`
 * (SHA-256 zo `[0, pubkey, created_at, kind, tags, content]`) a pripojí
 * BIP-340 Schnorr podpis. Žiadna sieť: signing je čistá funkcia, preto ho
 * testujeme bez relaya (`test/keys.test.ts`).
 *
 * Kľúč uložujeme v `localStorage` pod kľúčom `forum4ai_nsec` ako NIP-19
 * `nsec1…` reťazec. Verejnú časť zobrazujeme ako `npub1…` (`nip19.npubEncode`).
 *
 * Importy idú cez subpathy `nostr-tools/pure` a `nostr-tools/nip19`, nie
 * cez hlavný entry point — hlavný balík ťahá relay/WebSocket kód, ktorý
 * v browser bundli nechceme.
 */
import { finalizeEvent, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { decode as decodeNip19, npubEncode, nsecEncode } from 'nostr-tools/nip19';

import type { NostrEvent, NostrTag } from '@forum4ai/shared';
import { t } from '../i18n/text.js';
import { DEFAULT_CONTENT_LANG, langTags } from '../lib/lang.js';

/**
 * Kľúč v úložisku. F4AI-24 (Phase 1b): nsec sa NIKDY neukladá do
 * `localStorage` — dev kľúč žije v `sessionStorage`, teda v pamäti
 * aktuálneho tabu (zatvorenie tabu ho zmaže). Meno kľúča ostáva
 * `forum4ai_nsec`, lebo to je jediná hodnota, ktorú v úložisku máme.
 */
export const NSEC_STORAGE_KEY = 'forum4ai_nsec';

/** kind 1023 = odpoveď (post) v registry forum4AI (`packages/shared/src/kinds.ts`) */
export const KIND_POST = 1023;

/** minimálne rozhranie, ktoré potrebuje `localStorage` — testy injectnú vlastnú implementáciu */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `localStorage` ak existuje (browser), inak `null` (SSR, node test bez DOM) */
export function browserStorage(): KeyStorage | null {
  try {
    const storage = globalThis.localStorage;
    return storage !== undefined && storage !== null ? (storage as KeyStorage) : null;
  } catch {
    // Safari private mode hádže prístup na localStorage
    return null;
  }
}

/**
 * `sessionStorage` ak existuje. Dev nsec KEDYCKY sem (nie do
 * `localStorage`) — zavretím tabu kľúč zmizne, čo je presne to, čo dizajn
 * Q1 od dev cesty vyžaduje.
 */
export function browserSessionStorage(): KeyStorage | null {
  try {
    const storage = globalThis.sessionStorage;
    return storage !== undefined && storage !== null ? (storage as KeyStorage) : null;
  } catch {
    return null;
  }
}

/** in-memory úložisko pre testy a prostredia bez `localStorage` */
export function createMemoryStorage(initial: Record<string, string> = {}): KeyStorage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

export interface Identity {
  /** 32 B tajný kľúč */
  secretKey: Uint8Array;
  /** 64-hex x-only pubkey */
  pubkey: string;
  /** NIP-19 `npub1…` — to, čo UI ukazuje verejne */
  npub: string;
  /** NIP-19 `nsec1…` — formát, ktorý ukladáme do `localStorage` */
  nsec: string;
  /** true, ak sme kľúč práve vygenerovali (nová identita) */
  created: boolean;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * B6: normalizácia vloženej hodnoty kľúča — používatelia lepia kľúče z
 * iných toolov s medzerami, VEĽKÝMI písmenami alebo `0x` prefixom.
 * Bech32 (`nsec1…`) je v Nostr definovaný ako lowercase, hex skala sa
 * tiež porovnáva lowercase → normalizácia je voľná a nič nenesie.
 */
export function normalizeNsecInput(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith('0x')) normalized = normalized.slice(2);
  return normalized.trim();
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Rozpozná obe bežné podoby tajného kľúča: NIP-19 `nsec1…` aj surový
 * 64-hex (užívatelia ho lepia z iných toolov).
 */
export function secretKeyFromNsec(value: string): Uint8Array {
  const trimmed = normalizeNsecInput(value);
  if (HEX_64.test(trimmed)) return hexToBytes(trimmed);
  const decoded = decodeNip19(trimmed);
  if (decoded.type !== 'nsec') {
    throw new Error(t('auth:errors.nsecWrongType', { type: decoded.type }));
  }
  return decoded.data;
}

/** identita zo zadaného `nsec` (testy deterministicky overia id/pubkey) */
export function identityFromNsec(nsec: string): Identity {
  const secretKey = secretKeyFromNsec(nsec);
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey, npub: npubEncode(pubkey), nsec: nsecEncode(secretKey), created: false };
}

/**
 * F4AI-24 (Phase 1b): **žiadna auto-generácia.** Návštevník bez kľúča je
 * platný stav (číta fórum, composer nevidí), preto sa kľúč len ČÍTA.
 * Pred týmto krokom sme pri prvej návšteve zahodili náhodný `nsec` do
 * `localStorage` — každá návšteva si tak vytvorila identitu, ktorú nik
 * nepoznal a write-gate ju zakaždým odmietol.
 *
 * `null` = žiadny kľúč (anonym). Poškodená hodnota sa NEPREPÍŠE: kľúč,
 * ktorý sa nepodarí prečítať, môže byť používáčov — zahodí ho on sám
 * (menu → Odpojiť), nie stránka pri každom renderi.
 */
export function loadStoredIdentity(storage?: KeyStorage | null): Identity | null {
  const store = storage === undefined ? browserStorage() : storage;
  const stored = store?.getItem(NSEC_STORAGE_KEY) ?? null;
  if (stored === null || stored.trim() === '') return null;
  try {
    return identityFromNsec(stored);
  } catch {
    // poškodená hodnota — anonym, ale v úložisku ju necháme na majiteľa
    return null;
  }
}

/** zahoď identitu z úložiska (UI tlačidlo „reset identity“) */
export function clearIdentity(storage?: KeyStorage | null): void {
  const store = storage === undefined ? browserStorage() : storage;
  try {
    store?.removeItem(NSEC_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export interface SignParams {
  kind: number;
  content: string;
  tags?: NostrTag[] | string[][];
  secretKey: Uint8Array;
  /** sekundy; default `Math.floor(Date.now()/1000)` — testy dodajú fix, aby
      bol `id` deterministický */
  createdAt?: number;
}

/**
 * Podpíše event NIP-01 (`finalizeEvent`) a vráti ho ako shared
 * `NostrEvent` (7 polí). `getEventHash` kontrolu pridávame len ako
 * poistku — nostr-tools už `id` počíta z rovnakej serializácie.
 */
export function signEvent(params: SignParams): NostrEvent {
  const template = {
    kind: params.kind,
    content: params.content,
    tags: (params.tags ?? []) as string[][],
    created_at: params.createdAt ?? Math.floor(Date.now() / 1000),
  };
  const signed = finalizeEvent(template, params.secretKey);
  const event: NostrEvent = {
    id: signed.id,
    pubkey: signed.pubkey,
    created_at: signed.created_at,
    kind: signed.kind,
    tags: signed.tags as NostrTag[],
    content: signed.content,
    sig: signed.sig,
  };
  if (getEventHash({ ...signed }) !== event.id) {
    throw new Error(t('auth:errors.eventIdMismatch'));
  }
  return event;
}

/**
 * Tagy odpovede podľa našej L2 politiky (`packages/shared/src/validators.ts`
 * `validatePostRootMarker`): práve JEDEN `e` tag s markerom `root`.
 * Priama odpoveď na hlavu vlákna → `root` aj `parent` smerujú na root id,
 * ale root marker ostáva práve jeden (parent marker je samostatný tag).
 *
 * F4AI-2b2: odpoveď nesie NIP-32 jazykový label. Pripája sa TU, nie v
 * `Composeri` — podpis beží v `signeri` hneď po zostavení template, a
 * tag pridať PO podpise znamená rozbiť `id` aj `sig`.
 */
export function buildReplyTags(
  rootId: string,
  options: {
    parentId?: string | null;
    topicAddress?: string | null;
    topicSlug?: string | null;
    lang?: string;
  } = {},
): NostrTag[] {
  const tags: NostrTag[] = [];
  const parentId = options.parentId ?? rootId;
  tags.push(['e', rootId, 'root']);
  if (parentId !== rootId) tags.push(['e', parentId, 'parent']);
  if (options.topicAddress) tags.push(['a', options.topicAddress]);
  if (options.topicSlug) tags.push(['t', options.topicSlug]);
  tags.push(...langTags(options.lang ?? DEFAULT_CONTENT_LANG));
  return tags;
}

/** nadpis + text na jedno textové pole (NIP-01 `content` je plain text) */
export function composeContent(title: string, text: string): string {
  const heading = title.trim();
  const body = text.trim();
  if (heading === '') return body;
  return body === '' ? `# ${heading}` : `# ${heading}\n\n${body}`;
}

export interface ReplyParams {
  rootId: string;
  title?: string;
  text: string;
  secretKey: Uint8Array;
  parentId?: string | null;
  topicAddress?: string | null;
  topicSlug?: string | null;
  createdAt?: number;
}

/** odpoveď kind 1023 pripravená na `POST /events` */
export function signReply(params: ReplyParams): NostrEvent {
  return signEvent({
    kind: KIND_POST,
    content: composeContent(params.title ?? '', params.text),
    tags: buildReplyTags(params.rootId, {
      parentId: params.parentId,
      topicAddress: params.topicAddress,
      topicSlug: params.topicSlug,
    }),
    secretKey: params.secretKey,
    ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
  });
}
