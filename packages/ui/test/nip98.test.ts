/**
 * Testy NIP-98 auth tokenu (F4AI-24, Phase 1b) — to, čo vyžaduje
 * `packages/gateway/src/owner-auth.ts`:
 *  - `Authorization: Nostr <base64 kind-27235>`
 *  - tagy `u` (presne tá URL, na ktorú voláme), `method`, `payload`
 *  - `payload` = hex sha256 EXAKTNÉHO tela, ktoré putuje na drôt
 *    (gateway hashuje prijaté bajty, nie parse-nutý objekt)
 *  - GET telo NEMÁ → žiadny `payload` tag (inak by gateway hashoval
 *    „undefined“)
 *
 * Hash počítame nezávisle cez `node:crypto`, aby test nemohol prejsť
 * len vďaka tomu, že UI a test použijú tú istú funkciu.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { verifyEvent } from 'nostr-tools/pure';

import { KIND_AUTH_NIP98, base64FromJson, buildNip98Auth, describeNip98Auth, gatewayUrl } from '../src/nostr/nip98.js';
import { createAnonymousSigner, createNsecSigner } from '../src/nostr/signer.js';
import { identityFromNsec } from '../src/nostr/keys.js';
import { TEST_NSEC, TEST_PUBKEY } from './fixtures.js';
import type { NostrEvent } from '@forum4ai/shared';

const SECRET = identityFromNsec(TEST_NSEC).secretKey;
const signer = createNsecSigner(SECRET);

function decodeEvent(authorization: string): NostrEvent {
  expect(authorization.startsWith('Nostr ')).toBe(true);
  const json = Buffer.from(authorization.slice('Nostr '.length), 'base64').toString('utf8');
  return JSON.parse(json) as NostrEvent;
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name).map((tag) => String(tag[1] ?? ''));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('gatewayUrl', () => {
  it('nezdvojí `/api`, keď ho `baseUrl` už obsahuje (Caddy to strihá)', () => {
    expect(gatewayUrl('http://gateway.test/api', '/register/pending')).toBe('http://gateway.test/api/register/pending');
    expect(gatewayUrl('http://gateway.test/', 'register/pending')).toBe('http://gateway.test/register/pending');
  });
});

describe('buildNip98Auth (POST s telom)', () => {
  const url = 'http://gateway.test/api/register/approve';
  const payload = { pubkey: 'b'.repeat(64), note: 'povoliť' };

  it('token je `Nostr <base64>` a event je kind 27235 podpisovaný owner kľúčom', async () => {
    const auth = await buildNip98Auth(signer, { url, method: 'POST', payload });
    const event = decodeEvent(auth.authorization);
    expect(event.kind).toBe(KIND_AUTH_NIP98);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(event.content).toBe('');
    expect(verifyEvent(event as never)).toBe(true);
    // `created_at` musí byť čerstvé (< 300 s), inak gateway vráti 401
    expect(Math.abs(Math.floor(Date.now() / 1000) - event.created_at)).toBeLessThan(300);
  });

  it('tagy `u`/`method`/`payload` sedia s requestom', async () => {
    const auth = await buildNip98Auth(signer, { url, method: 'POST', payload });
    const event = decodeEvent(auth.authorization);
    expect(tagValues(event, 'u')).toEqual([url]);
    expect(tagValues(event, 'method')).toEqual(['POST']);
    expect(tagValues(event, 'payload')).toHaveLength(1);
  });

  it('`payload` tag = sha256 EXAKTNÉHO raw tela (to gateway hashuje)', async () => {
    const auth = await buildNip98Auth(signer, { url, method: 'POST', payload });
    const event = decodeEvent(auth.authorization);
    const rawBody = auth.rawBody;
    expect(typeof rawBody).toBe('string');
    expect(tagValues(event, 'payload')[0]).toBe(sha256Hex(rawBody as string));
    // telo je JSON toho istého objektu — žiadne navyše medzery
    expect(JSON.parse(rawBody as string)).toEqual(payload);
  });

  it('používáčom zadaný `created_at` sa rešpektuje (testovateľná čerstvosť)', async () => {
    const auth = await buildNip98Auth(signer, { url, method: 'POST', payload, createdAt: 1_700_000_000 });
    expect(decodeEvent(auth.authorization).created_at).toBe(1_700_000_000);
  });
});

describe('buildNip98Auth (GET bez tela)', () => {
  it('GET nemá `payload` tag ani `rawBody`', async () => {
    const auth = await buildNip98Auth(signer, {
      url: 'http://gateway.test/api/register/pending',
      method: 'GET',
    });
    const event = decodeEvent(auth.authorization);
    expect(tagValues(event, 'method')).toEqual(['GET']);
    expect(tagValues(event, 'payload')).toEqual([]);
    expect(auth.rawBody).toBeUndefined();
    expect(verifyEvent(event as never)).toBe(true);
  });

  it('prázdny POST objekt má telo `{}` a jeho hash (nie „undefined“)', async () => {
    const auth = await buildNip98Auth(signer, { url: 'http://gateway.test/api/register/revoke', method: 'POST' });
    expect(auth.rawBody).toBe('{}');
    const event = decodeEvent(auth.authorization);
    expect(tagValues(event, 'payload')[0]).toBe(sha256Hex('{}'));
  });
});

describe('buildNip98Auth (bez podpisovateľa)', () => {
  it('anonym nemá kto podpísať — veta, ktorú UI ukáže', async () => {
    await expect(
      buildNip98Auth(createAnonymousSigner(), { url: 'http://gateway.test/api/register/pending', method: 'GET' }),
    ).rejects.toThrow(/prihlásen/);
  });
});

describe('base64FromJson + describeNip98Auth', () => {
  it('base64 prenesie diakritiku (UTF-8, nie latin1)', () => {
    const text = JSON.stringify({ note: 'povoliť — žloutky' });
    expect(Buffer.from(base64FromJson(text), 'base64').toString('utf8')).toBe(text);
  });

  it('describe nikdy neukáže celý token (je to podpis)', async () => {
    const auth = await buildNip98Auth(signer, { url: 'http://gateway.test/api/register/pending', method: 'GET' });
    const line = describeNip98Auth(auth);
    expect(line).toContain('27235');
    expect(line).toContain(TEST_PUBKEY.slice(0, 8));
    expect(line).not.toContain(auth.authorization);
  });
});
