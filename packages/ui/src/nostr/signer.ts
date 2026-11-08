/**
 * Signer — JEDNO rozhranie pre všetky podpisovateľské pozadia
 * (F4AI-18/S12 → F4AI-23/24, Phase 1b).
 *
 * Dizajn Q1 (`claude-publish-answer.md`): návštevník bez kľúča je plnohodnotný
 * stav, NIP-07 je default, NIP-46 (bunker) je cesta pre vlastníka a mobil,
 * nsec je LEN dev. Rozhranie preto musí vedieť vrátiť aj „žiadny kľúč“:
 *
 *   { source: 'nip07' | 'bunker' | 'nsec' | 'anonymous',
 *     getPublicKey(): Promise<string | null>,
 *     signEvent(template): Promise<NostrEvent> }
 *
 * `pubkey` je navyše synchronný getter — React komponenty (header chip,
 * write-status) potrebujú pubkey renderovať ihneď, nie v promise. Platí
 * pravidlo: `pubkey === null` práve vtedy, keď `source === 'anonymous'`.
 *
 * Implementácie:
 *  - **NIP-07** (`window.nostr`): `getPublicKey()` + `signEvent()` — súkromný
 *    kľúč nikdy neopustí extension. `created_at`/id počítame my, extension
 *    doplní `id`+`sig`; výsledok overujeme `verifyEvent`, aby rozhranie
 *    nemohlo prekvapiť polovičným eventom.
 *  - **NIP-46** (`bunker://…`): `nostr-tools/nip46` `BunkerSigner` —
 *    VZDIALENÝ podpis, lokálne ostáva len kľúč KONZUMENTA (nie koreňový kľúč
 *    bunkra). Import je dynamický, aby relay/WebSocket kód nesmel do
 *    primárneho bundle (rovnaké pravidlo ako pri `nostr-tools/pure`).
 *  - **nsec**: `finalizeEvent` z `nostr-tools/pure` — čistá synchronná
 *    funkcia, žiadna sieť. Dev cesta (`VITE_ALLOW_NSEC=true`).
 *  - **anonymous**: žiadny kľúč. `signEvent` hodí chybu, ktorú UI ukáže
 *    ako „prihlás sa“ — nikdy nepodpíše polovičným kľúčom.
 */
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';

import type { NostrEvent, NostrTag } from '@forum4ai/shared';
import { t } from '../i18n/text.js';

/** odkiaľ podpisovateľ pochádza (dizajn Q1) */
export type SignerSource = 'nip07' | 'bunker' | 'nsec' | 'anonymous';

/** šablóna bez `id`/`sig`/`pubkey` — to, čo dodáva volajúci (Composer) */
export interface EventTemplate {
  kind: number;
  content: string;
  tags: NostrTag[] | string[][];
  created_at: number;
}

/** podpisovateľ cez ktorékoľvek pozadie — to, čo ujíma Composer aj NIP-98 */
export interface Signer {
  readonly source: SignerSource;
  /** 64-hex x-only pubkey, alebo `null` (anonymous — žiadny kľúč) */
  readonly pubkey: string | null;
  /** jednotný prístup k pubkey (pre pozadia, kde prichádza async) */
  getPublicKey(): Promise<string | null>;
  /** podpis šablóny → kánonických 7 polí (teliesko `POST /events`) */
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

/** chyba, ktorú UI ukáže, keď sa skúsi podpísať bez prihlásenia */
/** chyba, ktorú UI ukáže, keď sa skúsi podpísať bez prihlásenia (text: `auth:errors.noSigner`) */
export function noSignerMessage(): string {
  return t('auth:errors.noSigner');
}

// ── NIP-07 ────────────────────────────────────────────────────────────────

/**
 * NIP-07 provider (`window.nostr`) — len to, čo skutočne voláme.
 * `signEvent` dostane event bez `id`/`sig` (niektoré implementácie
 * vyžadujú aj `pubkey`, preto ho posielame) a vráti ho doplnené o
 * `id`+`sig` — nie všetky vracajú aj `pubkey`.
 */
export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** nájde `window.nostr`, ak v prostredí existuje a vyzerá byť použiteľný */
export function getNip07Provider(): Nip07Provider | null {
  const scope = globalThis as { window?: { nostr?: Partial<Nip07Provider> } };
  const nostr = scope.window?.nostr;
  if (
    nostr !== undefined &&
    nostr !== null &&
    typeof nostr.getPublicKey === 'function' &&
    typeof nostr.signEvent === 'function'
  ) {
    return nostr as Nip07Provider;
  }
  return null;
}

export interface DetectNip07Options {
  /** ako dlho čakať na extension, default 1 200 ms */
  timeoutMs?: number;
  /** ako často skúšať, default 100 ms */
  intervalMs?: number;
  /** injectnute prostredie (testy); default: live `window.nostr` */
  provider?: Nip07Provider | null;
  /** injectnute `setTimeout` (testy s fake časom) */
  delay?: (ms: number) => Promise<void>;
}

/**
 * Zisti, či prehliadač ponúka NIP-07. Extension sa vstrekuje do stránky
 * ASYNCHRONNE (obsah script beží skôr, než extension stihne nasadiť
 * `window.nostr`), preto — ako to robí alpubkit — krátko POLLUJEME a až po
 * lehote povieme „extension nie je nainštalovaný“. Vracia `null`, nie chybu:
 * anonymné čítanie je platný stav, nie zlyhanie.
 */
export async function detectNip07(options: DetectNip07Options = {}): Promise<Nip07Provider | null> {
  if (options.provider !== undefined) return options.provider;
  const immediate = getNip07Provider();
  if (immediate !== null) return immediate;

  const timeoutMs = options.timeoutMs ?? 1_200;
  const intervalMs = options.intervalMs ?? 100;
  const delay =
    options.delay ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    const found = getNip07Provider();
    if (found !== null) return found;
  }
  return null;
}

/**
 * Signer cez NIP-07 extension. `getPublicKey()` voláme raz pri vytvorení —
 * pubkey potrebujeme pred podpisom (id hash ho obsahuje).
 */
export async function createNip07Signer(provider: Nip07Provider): Promise<Signer> {
  const raw = await provider.getPublicKey();
  const pubkey = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!HEX_64.test(pubkey)) {
    throw new Error(t('auth:errors.nip07BadPubkey', { raw: String(raw).slice(0, 16) }));
  }

  async function signEvent(template: EventTemplate): Promise<NostrEvent> {
    const unsigned = {
      pubkey,
      created_at: template.created_at,
      kind: template.kind,
      tags: template.tags as string[][],
      content: template.content,
    };
    const expectedId = getEventHash(unsigned);
    const signed = await provider.signEvent({ ...unsigned });

    const returnedId = typeof signed['id'] === 'string' ? (signed['id'] as string) : expectedId;
    if (returnedId !== expectedId) {
      throw new Error(
        t('auth:errors.nip07IdMismatch', {
          returned: returnedId.slice(0, 12),
          expected: expectedId.slice(0, 12),
        }),
      );
    }
    const sig = typeof signed['sig'] === 'string' ? (signed['sig'] as string) : '';
    if (!HEX_128.test(sig)) {
      throw new Error(t('auth:errors.nip07NoSignature'));
    }
    const returnedPubkey = typeof signed['pubkey'] === 'string' ? (signed['pubkey'] as string) : pubkey;
    if (returnedPubkey !== pubkey) {
      throw new Error(t('auth:errors.nip07OtherPubkey'));
    }

    const event: NostrEvent = {
      id: expectedId,
      pubkey,
      created_at: template.created_at,
      kind: template.kind,
      tags: template.tags as NostrTag[],
      content: template.content,
      sig,
    };
    if (!verifyEvent(event as unknown as Parameters<typeof verifyEvent>[0])) {
      throw new Error(t('auth:errors.nip07Verify'));
    }
    return event;
  }

  return { source: 'nip07', pubkey, getPublicKey: async () => pubkey, signEvent };
}

// ── nsec (dev, sessionStorage) ────────────────────────────────────────────

/** Signer cez `finalizeEvent` so secret key (dev cesta, `forum4ai_nsec`). */
export function createNsecSigner(secretKey: Uint8Array): Signer {
  const pubkey = getPublicKey(secretKey);
  async function signEvent(template: EventTemplate): Promise<NostrEvent> {
    const signed = finalizeEvent(
      {
        kind: template.kind,
        content: template.content,
        tags: template.tags as string[][],
        created_at: template.created_at,
      },
      secretKey,
    );
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
  return { source: 'nsec', pubkey, getPublicKey: async () => pubkey, signEvent };
}

/**
 * Dev gate: nsec smie v UI existovať LEN keď to build povie
 * (`VITE_ALLOW_NSEC=true`). V produkcii je vloženie súkromného kľúča do
 * stránky nebezpečné a žiadny používáč ho nepotrebuje — má NIP-07 alebo
 * bunker. `env` je parameter len pre testy (rovnaký vzor ako
 * `gatewayBaseUrl`).
 */
export const ALLOW_NSEC_ENV = 'VITE_ALLOW_NSEC';

export function nsecAllowed(env: Record<string, string | undefined> = import.meta.env): boolean {
  return env[ALLOW_NSEC_ENV] === 'true';
}

// ── anonymous ─────────────────────────────────────────────────────────────

/**
 * Anonymné pozadie: žiadny kľúč, žiadne `localStorage`. Čítanie funguje,
 * podpis zmysluplně zlyhá na vete, ktorú UI ukáže ako výzvu na prihlásenie.
 */
export function createAnonymousSigner(): Signer {
  async function signEvent(): Promise<NostrEvent> {
    throw new Error(noSignerMessage());
  }
  return { source: 'anonymous', pubkey: null, getPublicKey: async () => null, signEvent };
}

// ── NIP-46 (bunker) ───────────────────────────────────────────────────────

/**
 * Minimálna plocha `nostr-tools/nip46`, ktorú potrebujeme — vlastné typy,
 * aby sme (a) neťahali typový zbytok do UI a (b) mohli testom injectnúť
 * falošný modul bez siete a WebSocketov.
 */
export interface BunkerPointerLike {
  relays: string[];
  pubkey: string;
  secret: string | null;
}

export interface BunkerRemoteSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: {
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
  }): Promise<{ id: string; sig: string; pubkey?: string }>;
  connect?(metadata?: { name?: string; url?: string }): Promise<void>;
  close?(): Promise<void>;
}

export interface BunkerModuleLike {
  parseBunkerInput(input: string): Promise<BunkerPointerLike | null>;
  BunkerSigner: {
    fromBunker(
      clientSecretKey: Uint8Array,
      pointer: BunkerPointerLike,
      params?: { onauth?: (url: string) => void },
    ): BunkerRemoteSigner;
  };
}

/** default: dynamický import — relay/pool kód ostáva mimo primárny bundle */
export async function loadNip46(): Promise<BunkerModuleLike> {
  const mod = await import('nostr-tools/nip46');
  return mod as unknown as BunkerModuleLike;
}

export interface BunkerConnectOptions {
  /** `bunker://<pubkey>?relay=…&secret=…` alebo `nip05@domain` */
  uri: string;
  /** lokálny kľúč KONZUMENTA (nie koreňový kľúč bunkra); nový = nový pár */
  clientSecretKey?: Uint8Array;
  /** injectnutý modul (testy); default `loadNip46()` */
  module?: BunkerModuleLike;
  /** callback s `nostrconnect://` URL, ak bunker vyžiada potvrdenie */
  onauth?: (url: string) => void;
  /** metadata, ktoré bunker ukazuje v zozname povolení */
  clientMetadata?: { name?: string; url?: string };
}

export interface BunkerSession {
  signer: Signer;
  /** hex lokálneho kľúča konzumenta — ukladá sa, aby reconnect nepýtal znova */
  clientSecretKeyHex: string;
  /** normalizovaný bunker pointer, ako ho poslal používáč */
  uri: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Pripoj NIP-46 bunker. Kľúč ostáva VZDIALEN — lokálne máme iba kľúč
 * konzumenta, ktorým rozprávame s bunkrom. `connect()` voláme hneď, aby
 * bunker ukázal žiadosť o povolenie skôr, než používáč čaká na podpis.
 */
export async function connectBunker(options: BunkerConnectOptions): Promise<BunkerSession> {
  const uri = options.uri.trim();
  if (uri === '') throw new Error(t('auth:errors.bunkerUriMissing'));
  const mod = options.module ?? (await loadNip46());
  const pointer = await mod.parseBunkerInput(uri);
  if (pointer === null) {
    throw new Error(t('auth:errors.bunkerUriBad', { uri: uri.slice(0, 24) }));
  }
  const clientSecretKey = options.clientSecretKey ?? randomClientSecretKey();
  const remote = mod.BunkerSigner.fromBunker(clientSecretKey, pointer, {
    ...(options.onauth !== undefined ? { onauth: options.onauth } : {}),
  });
  if (typeof remote.connect === 'function') {
    await remote.connect(options.clientMetadata ?? { name: 'forum4Ai' });
  }
  const raw = await remote.getPublicKey();
  const pubkey = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!HEX_64.test(pubkey)) {
    throw new Error(t('auth:errors.bunkerBadPubkey', { raw: String(raw).slice(0, 16) }));
  }

  async function signEvent(template: EventTemplate): Promise<NostrEvent> {
    const signed = await remote.signEvent({
      kind: template.kind,
      content: template.content,
      tags: template.tags as string[][],
      created_at: template.created_at,
    });
    const event: NostrEvent = {
      id: signed.id,
      pubkey,
      created_at: template.created_at,
      kind: template.kind,
      tags: template.tags as NostrTag[],
      content: template.content,
      sig: signed.sig,
    };
    if (!verifyEvent(event as unknown as Parameters<typeof verifyEvent>[0])) {
      throw new Error(t('auth:errors.bunkerVerify'));
    }
    return event;
  }

  return {
    signer: { source: 'bunker', pubkey, getPublicKey: async () => pubkey, signEvent },
    clientSecretKeyHex: bytesToHex(clientSecretKey),
    uri,
  };
}

/** lokálny kľúč konzumenta (32 B) — nie kľúč, pod ktorým niečo podpisujeme */
function randomClientSecretKey(): Uint8Array {
  const bytes = new Uint8Array(32);
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webcrypto !== undefined && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** obnova bunkra z uloženej session (žiadne nové `connect()` povolenie) */
export async function restoreBunker(
  session: { uri: string; clientSecretKeyHex: string },
  options: { module?: BunkerModuleLike } = {},
): Promise<Signer> {
  if (!/^[0-9a-f]{64}$/.test(session.clientSecretKeyHex)) {
    throw new Error(t('auth:errors.bunkerSessionKey'));
  }
  const connected = await connectBunker({
    uri: session.uri,
    clientSecretKey: hexToBytes(session.clientSecretKeyHex),
    ...(options.module !== undefined ? { module: options.module } : {}),
  });
  return connected.signer;
}

// ── voľba signera ─────────────────────────────────────────────────────────

export interface ResolveSignerOptions {
  /** explicitný provider (testy); default: live `window.nostr` */
  nip07?: Nip07Provider | null;
  /** secret key pre nsec fallback (dev identita); null = zakázaný */
  secretKey?: Uint8Array | null;
}

/**
 * Jednoduché pravidlo „čo použiť, ak nič nie je prihlásené“: NIP-07 má
 * prednosť (kľúč mimo stránky), inak dev nsec, inak anonymous. Session
 * provider tohto rozhrania nepoužíva — tam si pozadie vyberá používáč.
 */
export async function resolveSigner(options: ResolveSignerOptions = {}): Promise<Signer> {
  const provider = options.nip07 !== undefined ? options.nip07 : getNip07Provider();
  if (provider !== null && provider !== undefined) {
    return createNip07Signer(provider);
  }
  const secretKey = options.secretKey ?? null;
  if (secretKey !== null) {
    return createNsecSigner(secretKey);
  }
  return createAnonymousSigner();
}
