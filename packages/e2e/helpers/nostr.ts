/**
 * E2E helpery (F4AI-31, Phase 7) — to, čo potrebuje test a čo UI nerobí
 * za nás: podpisovanie v Node, registrácia operátora, falošná NIP-07
 * extenzia a zber CSP porušení.
 *
 * Dve veci, ktoré je potrebné poznať:
 *
 *  1. **Falošná NIP-07 extenzia** (`installFakeExtension`) je jediný
 *     spôsob, ako prihlásiť VLASTNÍKA do produkčnej inštancie. Produkčný
 *     build nemá `VITE_ALLOW_NSEC=true`, takže tab s nsec sa v UI vôbec
 *     nevykreslí a `sessionStorage` nsec by sa neobnovil (gate). NIP-07 je
 *     naopak default pozadie dizajnu Q1 — stačí `window.nostr` a aplikácia
 *     sa sama prihlási. Podpis počíta Node cez `exposeBinding`, takže
 *     súkromný kľúč nikdy nevstúpi do stránky (rovnako ako pri skutočnej
 *     extenzii) a CSP mu nestojí v ceste (viaže sa cez CDP, nie cez
 *     `<script>`).
 *  2. **PITS z `nostr-tools`**: podpis je randomizovaný (`auxRand`), preto
 *     každý event pred odoslaním overíme `verifyEvent` + prepočtom
 *     `getEventHash`. `finalizeEvent` navyše nesmie dostať `id`/`sig` —
 *     posielame čisté šablóny.
 */
import { readFileSync } from 'node:fs';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decode, npubEncode, nsecEncode } from 'nostr-tools/nip19';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import type { Page } from '@playwright/test';

/** kľúčové slová, podľa ktorých Chrome hlási CSP porušenie v konzole */
const CSP_MARKERS = ['violates the following Content Security Policy', 'Refused to '];

export interface WriteStatus {
  ok: boolean;
  pubkey: string;
  allowed: boolean;
  code: string;
  reason?: string;
}

export interface RegisterAttempt {
  status: number;
  body: Record<string, unknown>;
  claim: VerifiedEvent;
  pubkey: string;
}

/** čisté šablóny bez `id`/`sig` — inak `finalizeEvent` odmietne vstup */
function templateOf(kind: number, content: string, tags: string[][], createdAt: number): EventTemplate {
  return { kind, content, tags, created_at: createdAt };
}

/** podpis + kontrola, že `id` sedí na obsah a podpis je platný (PITS auxRand) */
export function sign(kind: number, content: string, tags: string[][], sk: Uint8Array, createdAt = Math.floor(Date.now() / 1000)): VerifiedEvent {
  const event = finalizeEvent(templateOf(kind, content, tags, createdAt), sk);
  if (!verifyEvent(event)) throw new Error(`e2e: event kind ${String(kind)} neprešiel verifyEvent`);
  if (getEventHash({ ...event }) !== event.id) throw new Error(`e2e: id nesedí na hash (kind ${String(kind)})`);
  return event;
}

// ── identity ───────────────────────────────────────────────────────────────

export interface OwnerIdentity {
  sk: Uint8Array;
  pubkey: string;
  npub: string;
}

/**
 * Vlastnícky kľúč sa číta z `E2E_OWNER_NSEC` alebo zo súboru
 * `E2E_OWNER_NSEC_FILE` (hex alebo `nsec1…`). Nikdy sa nevkladá do
 * stránky a nikde sa netlačí — test ukazuje iba pubkey.
 */
export function ownerIdentityFromEnv(): OwnerIdentity {
  const raw = process.env['E2E_OWNER_NSEC'] ?? (process.env['E2E_OWNER_NSEC_FILE'] !== undefined ? readTrimmedFile(process.env['E2E_OWNER_NSEC_FILE']) : undefined);
  if (raw === undefined || raw === '') {
    throw new Error('e2e: chýba E2E_OWNER_NSEC alebo E2E_OWNER_NSEC_FILE (owner nsec pre VPS flow)');
  }
  return decodeSecret(raw);
}

function readTrimmedFile(file: string): string {
  return readFileSync(file, 'utf8').trim();
}

export function decodeSecret(raw: string): OwnerIdentity {
  const value = raw.trim();
  let sk: Uint8Array;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    sk = hexToBytes(value.toLowerCase());
  } else if (value.startsWith('nsec1')) {
    const decoded = decode(value);
    if (decoded.type !== 'nsec') throw new Error('e2e: nsec1… sa nepodarilo dekódovať ako nsec');
    sk = decoded.data as Uint8Array;
  } else {
    throw new Error('e2e: owner kľúč musí byť 64-hex alebo nsec1…');
  }
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: npubEncode(pubkey) };
}

export function randomIdentity(): OwnerIdentity {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: npubEncode(pubkey) };
}

/** `nsec1…` pre dev login — UI prijíma aj 64-hex, ale toto je to, čo skúša čitateľ */
export function nsecOf(identity: OwnerIdentity): string {
  return nsecEncode(identity.sk);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ── falošná NIP-07 extenzia ────────────────────────────────────────────────

/**
 * Vloží do stránky `window.nostr` s podpisom v Node. Volá sa PRED
 * `goto` — `addInitScript` beží pred kódom aplikácie a `detectNip07`
 * tak provider nájde hneď pri prvom pokuse (žiadne 1,2 s čakanie).
 */
export async function installFakeExtension(page: Page, identity: OwnerIdentity): Promise<void> {
  await page.exposeBinding('__f4aiE2eSign', (_source, unsigned: Record<string, unknown>) => {
    const kind = typeof unsigned['kind'] === 'number' ? (unsigned['kind'] as number) : 0;
    const content = typeof unsigned['content'] === 'string' ? (unsigned['content'] as string) : '';
    const tags = Array.isArray(unsigned['tags']) ? (unsigned['tags'] as string[][]) : [];
    const createdAt = typeof unsigned['created_at'] === 'number' ? (unsigned['created_at'] as number) : Math.floor(Date.now() / 1000);
    return finalizeEvent(templateOf(kind, content, tags, createdAt), identity.sk);
  });
  await page.addInitScript((pubkey: string) => {
    const w = window as unknown as Record<string, unknown>;
    w['nostr'] = {
      getPublicKey: async (): Promise<string> => pubkey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- signEvent dostáva záznam, nie triedu
      signEvent: async (event: any): Promise<Record<string, unknown>> =>
        (await (w['__f4aiE2eSign'] as (e: unknown) => Promise<Record<string, unknown>>)(event)),
    };
  }, identity.pubkey);
}

// ── registrácia operátora ──────────────────────────────────────────────────

/**
 * `GET /register/challenge` → kind 1055 claim → `POST /register`.
 * Presne to isté, čo robí `operator claim` z CLI (docs/skill.md).
 * Odpoveď vracíme celú — test potrebuje `reasons` probe, nie len status.
 */
export async function registerOperator(
  api: string,
  gatewayHost: string,
  relayUrl: string,
  identity: OwnerIdentity,
  note = 'e2e phase 7',
): Promise<RegisterAttempt> {
  const challenge = await fetch(`${api}/register/challenge?pubkey=${identity.pubkey}`, { signal: AbortSignal.timeout(15_000) });
  const challengeBody = (await challenge.json()) as { ok: boolean; nonce?: string; exp?: number };
  if (!challengeBody.ok || challengeBody.nonce === undefined || challengeBody.exp === undefined) {
    throw new Error(`e2e: challenge zlyhal (${String(challenge.status)}): ${JSON.stringify(challengeBody)}`);
  }
  const claim = sign(
    1055,
    note,
    [
      ['challenge', challengeBody.nonce],
      ['exp', String(challengeBody.exp)],
      ['relay', relayUrl],
      ['gateway', gatewayHost],
    ],
    identity.sk,
  );
  const res = await fetch(`${api}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(claim),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body, claim, pubkey: identity.pubkey };
}

/** `GET /write-status?pubkey=` — verejná route, bez auth */
export async function writeStatus(api: string, pubkey: string): Promise<WriteStatus> {
  const res = await fetch(`${api}/write-status?pubkey=${pubkey}`, { signal: AbortSignal.timeout(15_000) });
  return (await res.json()) as WriteStatus;
}

// ── CSP ────────────────────────────────────────────────────────────────────

/**
 * Chrome hlási CSP porušenie (enforce AJ Report-Only) cez `Log.entryAdded`
 * so `source: "security"` a Playwright z toho urobí konzolovú správu typu
 * **`info`** — preto sa filtruje TEXT, nie level. (Sonda: vložený
 * `<script src>` mimo `script-src` sa nahlásil ako info, varovanie nie.)
 */
export function watchCsp(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (CSP_MARKERS.some((marker) => text.includes(marker))) violations.push(text);
  });
  return violations;
}

/** krátky suffix pre per-beh unikátne tokeny (live dáta rastú → test nesmie závisieť na predchádzajúcich behoch) */
export function token(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}
