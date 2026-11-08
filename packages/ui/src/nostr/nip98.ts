/**
 * NIP-98 — signed HTTP auth z prehliadača (kind 27235, F4AI-23/24).
 *
 * Gateway overuje `Authorization: Nostr <base64(event JSON)>` v
 * `packages/gateway/src/nip98.ts` a pri owner akciách navyše vyžaduje, aby
 * podpisujúci pubkey bol pubkey vlastníka (`owner-auth.ts`). Toto je druhá
 * polovica toho kontraktu — stavba tokenu z aktívneho signera:
 *
 *   kind 27235, created_at čerstvý (< 300 s),
 *   tags: ["u", <URL>, "method", "POST"|"GET", "payload", <hex sha256 tela>]
 *
 * Dve veci, ktoré sa ľahko pokazia a obe tu sú zámerne za istým miestom:
 *  1. **`u` tag musí sedieť na CESTU, ktorú voláme.** Preto token stavia
 *     rovnaká adresa, ktorou klient request posiela (`api.baseUrl`), nie
 *     `window.location.origin` — UI beží na inom porte než gateway a
 *     gateway akceptuje len zámennu schémy/portu/`/api` prefixu, nie hosta.
 *  2. **`payload` tag je hash PRESNÝCH bajtov tela.** Preto `buildNip98Auth`
 *     telo SÁMO serializuje a vracia ho ako `rawBody` — volajúci musí
 *     poslať presne tento reťazec (žiadne druhé `JSON.stringify`, inak sa
 *     hash rozijde a gateway vráti 401).
 */
import { hashPayload } from 'nostr-tools/nip98';

import type { NostrEvent } from '@forum4ai/shared';

import type { Signer } from './signer.js';
import { t } from '../i18n/text.js';

/** kind 27235 — NIP-01 `AUTH` (zdroj: `packages/shared/src/kinds.ts`) */
export const KIND_AUTH_NIP98 = 27235;

export interface Nip98Request {
  /** absolútna URL požiadavky (presne tá, ktorou klient volá gateway) */
  url: string;
  method: 'GET' | 'POST';
  /**
   * Teliesko ako objekt. Pri POST ho funkcia serializuje a vráti hotový
   * `rawBody`; pri GET sa ignoruje (gateway pri GET `payload` tag
   * NEakceptuje s iným než prázdnym telom, preto ho neposielame).
   */
  payload?: Record<string, unknown>;
  /** sekundy; default `Date.now()/1000` — testy dodajú fix */
  createdAt?: number;
}

export interface Nip98Auth {
  /** hodnota hlavičky `Authorization` (`Nostr <base64>`) */
  authorization: string;
  /** SUROVÉ telo, ktoré sa MUSÍ poslať ako `rawBody` (GET → undefined) */
  rawBody?: string;
  /** podpísaný auth event (pre náhled / testy) */
  event: NostrEvent;
}

/** `base64(utf8(json))` — bez Bufferu (browser aj jsdom majú `btoa`) */
export function base64FromJson(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Adresa, ktorou klient volá gateway — `api.baseUrl` už obsahuje `/api`
 * prefix, ak ho inštancia má (Caddy). Cesta sa nesmie poskladať dvakrát.
 */
export function gatewayUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Postav a podpíš NIP-98 auth. `signer.pubkey` MUSÍ byť owner pubkey,
 * inak gateway odpovie 403 `NOT_OWNER` (to už rieši volajúci UI).
 */
export async function buildNip98Auth(signer: Signer, request: Nip98Request): Promise<Nip98Auth> {
  if (signer.pubkey === null) {
    throw new Error(t('auth:errors.noSignerNip98'));
  }
  const rawBody = request.method === 'GET' ? undefined : JSON.stringify(request.payload ?? {});
  const tags: string[][] = [
    ['u', request.url],
    ['method', request.method],
  ];
  if (rawBody !== undefined) {
    // `hashPayload` hashuje `JSON.stringify(payload)` — a práve ten reťazec
    // posielame ako telo, takže hash sedí s podpísanými bajtmi
    tags.push(['payload', hashPayload(request.payload ?? {})]);
  }

  const event = await signer.signEvent({
    kind: KIND_AUTH_NIP98,
    content: '',
    tags,
    created_at: request.createdAt ?? Math.floor(Date.now() / 1000),
  });

  return {
    authorization: `Nostr ${base64FromJson(JSON.stringify(event))}`,
    ...(rawBody !== undefined ? { rawBody } : {}),
    event,
  };
}

/**
 * Skrátené zobrazenie tokenu pre logy/UI — nikdy nezobrazujeme celý
 * base64 (je to podpis, nie identifikátor).
 */
export function describeNip98Auth(auth: Nip98Auth): string {
  return `NIP-98 kind ${String(KIND_AUTH_NIP98)} · ${auth.event.pubkey.slice(0, 8)}… · id ${auth.event.id.slice(0, 8)}…`;
}
