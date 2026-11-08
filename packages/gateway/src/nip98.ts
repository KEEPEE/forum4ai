/**
 * NIP-98 — signed HTTP auth (kind 27235) for the gateway (F4AI-10).
 *
 * The client sends `Authorization: Nostr <base64(event JSON)>`, where the event is
 * kind 27235 with the `u` (request URL), `method` and optional `payload`
 * (hex SHA-256 of the body) tags. We verify:
 *   1. the header form and base64 → JSON (no functions, plain data),
 *   2. kind === 27235 and the NIP-01 structure (shared validators),
 *   3. signature + recomputed id (`verifyFull` from shared — resistant to
 *      nostr-tools memoizing the verification under a Symbol),
 *   4. `created_at` inside a ±300 s window (default; nostr-tools `validateEvent`
 *      uses a strict 60 s, which is too little for slower clients),
 *   5. the URL match (the `u` tag — nostr-tools convention; we also accept a
 *      `t` tag with a base64 URL per the NIP-98 text) and the `method` tag,
 *   6. with a non-empty body also the `payload` tag against the body hash.
 *
 * Helper functions for 4./5./6. are called from `nostr-tools/nip98` where they
 * fit (unpack, `u`/`method` tag, hashPayload); the timestamp and the signature
 * are done by us because of the 300 s window and `verifyFull`.
 */
import { createHash } from 'node:crypto';

import { createMiddleware } from 'hono/factory';
import {
  hashPayload,
  unpackEventFromToken,
  validateEventKind,
  validateEventMethodTag,
  validateEventUrlTag,
} from 'nostr-tools/nip98';
import type { Event } from 'nostr-tools';

import { KINDS, validateEventStructure, verifyFull } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

export const NIP98_DEFAULT_MAX_SKEW_SECONDS = 300;

export interface Nip98VerifyOptions {
  /** presná URL požiadavky (protokol://host:port/ceste+query), ako ju vidí server */
  url: string;
  /**
   * Ďalšie URL, ktoré `u` tag môže spĺňať (F4AI-23). Reverzná proxy mení
   * adresu, ktorú klient podpisuje: Caddy strháva `/api` prefix a TLS končí
   * pred gatewayom, takže `https://host/api/register/approve` prichádza ako
   * `http://host:3001/register/approve`. Volajúci smie pridať LEN varianty
   * tej istej cesty (schéma/port/prefix) — iná cesta by dovolila replay
   * auth eventu na inú route.
   */
  altUrls?: readonly string[];
  /** HTTP metóda požiadavky */
  method: string;
  /** surové telo požiadavky (GET/HEAD → undefined) */
  rawBody?: string;
  /** tolerancia `created_at` voči súčasnosti, default ±300 s */
  maxSkewSeconds?: number;
  /** injectable "teraz" v sekundách (testy expirácie) */
  nowSeconds?: number;
}

export type Nip98Verification =
  | { ok: true; pubkey: string; event: Event }
  | { ok: false; reason: string };

function sha256Hex(input: string): string {
  // Node-only gateway — node:crypto stačí, netreba priamu závislosť
  // od @noble/hashes (je to transitive dependency nostr-tools)
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function asEvent(unknown: unknown): Event | null {
  if (typeof unknown !== 'object' || unknown === null || Array.isArray(unknown)) return null;
  return unknown as Event;
}

/** `u` tag (nostr-tools konvencia) alebo `t` tag s base64 URL (text NIP-98). */
function urlTagMatches(event: Event, url: string): boolean {
  try {
    if (validateEventUrlTag(event, url)) return true;
  } catch {
    return false;
  }
  const tTag = event.tags.find((tag) => tag[0] === 't');
  const encoded = tTag?.[1];
  if (typeof encoded !== 'string' || encoded.length === 0) return false;
  try {
    return Buffer.from(encoded, 'base64').toString('utf8') === url;
  } catch {
    return false;
  }
}

function payloadTagMatches(event: Event, rawBody: string): boolean {
  const payloadTag = event.tags.find((tag) => tag[0] === 'payload');
  const claimed = payloadTag?.[1];
  if (typeof claimed !== 'string' || claimed.length === 0) return false;
  if (claimed === sha256Hex(rawBody)) return true;
  // nostr-tools `hashPayload` hashuje JSON.stringify(payload) — ak je
  // telo platné JSON, akceptujeme aj túto variantu (kľúče v rovnakom
  // poradí, ako ich klient serializoval)
  try {
    return claimed === hashPayload(JSON.parse(rawBody));
  } catch {
    return false;
  }
}

/**
 * Over NIP-98 token z Authorization hlavičky. Vracia pubkey overený
 * podpisom, alebo dôvod zamietnutia (middleware z neho robí 401).
 */
export async function verifyNip98Authorization(
  header: string | undefined | null,
  options: Nip98VerifyOptions,
): Promise<Nip98Verification> {
  if (typeof header !== 'string' || header.trim().length === 0) {
    return { ok: false, reason: 'missing Authorization header (Nostr <base64 event>)' };
  }
  if (!/^\s*nostr\s+/i.test(header)) {
    return { ok: false, reason: 'Authorization must have the form "Nostr <base64 event>"' };
  }
  const token = header.replace(/^\s*nostr\s+/i, '').trim();

  let unpacked: unknown;
  try {
    unpacked = await unpackEventFromToken(token);
  } catch {
    return { ok: false, reason: 'the token is not a decodable base64 JSON event' };
  }

  const event = asEvent(unpacked);
  if (event === null) return { ok: false, reason: 'the token does not contain an event object' };

  if (event.kind !== KINDS.AUTH_NIP98) {
    return { ok: false, reason: `kind must be ${KINDS.AUTH_NIP98} (NIP-98), got ${String(event.kind)}` };
  }
  // poistka navyše: nostr-tools `validateEventKind` kontroluje presne
  // kind 27235 — nech bežia obe kontroly, aby sme pri upgradene
  // dependency nespli kind
  if (!validateEventKind(event)) {
    return { ok: false, reason: `kind must be ${KINDS.AUTH_NIP98}` };
  }

  const structure = validateEventStructure(event as unknown as NostrEvent);
  if (!structure.valid) {
    return { ok: false, reason: `the event is not canonical NIP-01: ${structure.errors.join('; ')}` };
  }

  if (!verifyFull(event as unknown as NostrEvent)) {
    return { ok: false, reason: 'the signature is not valid or the id does not match the content hash' };
  }

  const maxSkew = options.maxSkewSeconds ?? NIP98_DEFAULT_MAX_SKEW_SECONDS;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = Math.abs(nowSeconds - event.created_at);
  if (!Number.isFinite(event.created_at) || skew > maxSkew) {
    return {
      ok: false,
      reason: `created_at outside the ±${String(maxSkew)} s window (skew ${String(skew)} s)`,
    };
  }

  const urls = [options.url, ...(options.altUrls ?? [])];
  if (!urls.some((candidate) => urlTagMatches(event, candidate))) {
    return { ok: false, reason: 'the u tag (URL) does not match the request target' };
  }

  try {
    if (!validateEventMethodTag(event, options.method)) {
      return { ok: false, reason: `the method tag does not match the method ${options.method}` };
    }
  } catch {
    return { ok: false, reason: 'the method tag is missing or invalid' };
  }

  const rawBody = options.rawBody ?? '';
  const hasPayloadTag = event.tags.some((tag) => tag[0] === 'payload');
  if (rawBody.length > 0) {
    if (!hasPayloadTag) {
      return { ok: false, reason: 'the payload tag with the request body hash is missing' };
    }
    if (!payloadTagMatches(event, rawBody)) {
      return { ok: false, reason: 'the payload tag does not match the request body hash' };
    }
  } else if (hasPayloadTag && !payloadTagMatches(event, '')) {
    return { ok: false, reason: 'the payload tag does not match an empty request body' };
  }

  return { ok: true, pubkey: event.pubkey, event };
}

/** Premenná, ktorú middleware nastavuje na overený pubkey. */
export type Nip98Variables = { pubkey: string };

export interface Nip98MiddlewareOptions {
  maxSkewSeconds?: number;
}

/**
 * Hono middleware: odmietne požiadavku so 401, ak NIP-98 token
 * neprejde; po úspechu je `c.get('pubkey')` overený podpisom.
 */
export function nip98Auth(options: Nip98MiddlewareOptions = {}) {
  return createMiddleware<{ Variables: Nip98Variables }>(async (c, next) => {
    const method = c.req.method;
    let rawBody: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      rawBody = await c.req.text();
    }
    const result = await verifyNip98Authorization(c.req.header('authorization'), {
      url: c.req.url,
      method,
      rawBody,
      maxSkewSeconds: options.maxSkewSeconds,
    });
    if (!result.ok) {
      return c.json({ error: 'unauthorized', reason: result.reason }, 401);
    }
    c.set('pubkey', result.pubkey);
    await next();
  });
}
