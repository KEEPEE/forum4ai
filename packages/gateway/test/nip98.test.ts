/**
 * Unit testy NIP-98 validátora — platný token, expirácia, zlý podpis,
 * zlá URL/metóda, kind, payload hash a alternatívny `t` tag (base64 URL
 * podľa textu NIP-98). Tokeny generujeme `nostr-tools/nip98` `getToken`,
 * teda rovnako ako ich generuje klientská strana.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { EventTemplate } from 'nostr-tools';
import { getToken } from 'nostr-tools/nip98';

import { verifyNip98Authorization } from '../src/nip98.js';

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const URL_OK = 'https://gateway.example/me';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

async function tokenFor(
  url = URL_OK,
  method = 'GET',
  options?: {
    payload?: Record<string, unknown>;
    createdAt?: number;
    kind?: number;
    secret?: Uint8Array;
  },
): Promise<string> {
  const secret = options?.secret ?? sk;
  return getToken(
    url,
    method,
    async (template: EventTemplate) =>
      finalizeEvent(
        {
          ...template,
          kind: options?.kind ?? template.kind,
          created_at: options?.createdAt ?? template.created_at,
        },
        secret,
      ),
    false,
    options?.payload,
  );
}

describe('NIP-98 — platné tokeny', () => {
  it('platný GET token vráti pubkey overený podpisom', async () => {
    const token = await tokenFor();
    const result = await verifyNip98Authorization(`Nostr ${token}`, {
      url: URL_OK,
      method: 'GET',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pubkey).toBe(pubkey);
  });

  it('hlavička je case-insensitive na schéme a toleruje medzery', async () => {
    const token = await tokenFor();
    const result = await verifyNip98Authorization(`  NOSTR  ${token}`, {
      url: URL_OK,
      method: 'GET',
    });
    expect(result.ok).toBe(true);
  });

  it('POST s payload tagom sedí na telo požiadavky', async () => {
    const body = { content: 'ahoj', kind: 1023 };
    const token = await tokenFor('https://gateway.example/events', 'POST', { payload: body });
    const result = await verifyNip98Authorization(`Nostr ${token}`, {
      url: 'https://gateway.example/events',
      method: 'POST',
      rawBody: JSON.stringify(body),
    });
    expect(result.ok).toBe(true);
  });

  it('akceptuje aj `t` tag s base64 URL (text NIP-98, nie konvencia nostr-tools)', async () => {
    const event = finalizeEvent(
      {
        kind: 27235,
        created_at: nowSeconds(),
        tags: [
          ['t', b64(URL_OK)],
          ['method', 'GET'],
        ],
        content: '',
      },
      sk,
    );
    const result = await verifyNip98Authorization(`Nostr ${b64(JSON.stringify(event))}`, {
      url: URL_OK,
      method: 'GET',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pubkey).toBe(pubkey);
  });

  it('created_at 400 s starý prejde pri wider okne (600 s)', async () => {
    const token = await tokenFor(URL_OK, 'GET', { createdAt: nowSeconds() - 400 });
    const result = await verifyNip98Authorization(`Nostr ${token}`, {
      url: URL_OK,
      method: 'GET',
      maxSkewSeconds: 600,
    });
    expect(result.ok).toBe(true);
  });
});

describe('NIP-98 — zamietnuté tokeny', () => {
  it('chýbajúca alebo nesprávna hlavička', async () => {
    const missingHeader = await verifyNip98Authorization(undefined, { url: URL_OK, method: 'GET' });
    expect(missingHeader.ok).toBe(false);
    if (!missingHeader.ok) expect(missingHeader.reason).toMatch(/Authorization/);
    const bearer = await tokenFor();
    const res = await verifyNip98Authorization(`Bearer ${bearer}`, { url: URL_OK, method: 'GET' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/Nostr/);
  });

  it('token, ktorý nie je base64 JSON', async () => {
    const res = await verifyNip98Authorization('Nostr !!!!!not base64!!!!!', {
      url: URL_OK,
      method: 'GET',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/base64|dekód/i);
  });

  it('expírovaný created_at mimo ±300 s', async () => {
    const token = await tokenFor(URL_OK, 'GET', { createdAt: nowSeconds() - 301 });
    const res = await verifyNip98Authorization(`Nostr ${token}`, { url: URL_OK, method: 'GET' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/created_at/);
  });

  it('created_at v milisekundách → nekánonický event', async () => {
    const token = await tokenFor(URL_OK, 'GET', { createdAt: Date.now() });
    const res = await verifyNip98Authorization(`Nostr ${token}`, { url: URL_OK, method: 'GET' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/milliseconds|canonical/i);
  });

  it('podpis nezodpovedá (pozmenený sig po podpise)', async () => {
    const token = await tokenFor();
    const event = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as { sig: string };
    event.sig = 'f'.repeat(128);
    const res = await verifyNip98Authorization(`Nostr ${b64(JSON.stringify(event))}`, {
      url: URL_OK,
      method: 'GET',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/signature/i);
  });

  it('zlý pubkey (event podpísaný iným kľúčom, pubkey prepísaný)', async () => {
    const token = await tokenFor();
    const event = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as { pubkey: string };
    event.pubkey = 'e'.repeat(64);
    const res = await verifyNip98Authorization(`Nostr ${b64(JSON.stringify(event))}`, {
      url: URL_OK,
      method: 'GET',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/signature/i);
  });

  it('zlá URL (u tag sedí na inú adresu)', async () => {
    const token = await tokenFor();
    const res = await verifyNip98Authorization(`Nostr ${token}`, {
      url: 'https://gateway.example/ine',
      method: 'GET',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/u tag/);
  });

  it('URL s query sa musí zhodovať vrátane query', async () => {
    const token = await tokenFor(`${URL_OK}?x=1`);
    const res = await verifyNip98Authorization(`Nostr ${token}`, { url: URL_OK, method: 'GET' });
    expect(res.ok).toBe(false);
  });

  it('zlá metóda (method tag GET, požiadavka POST)', async () => {
    const token = await tokenFor();
    const res = await verifyNip98Authorization(`Nostr ${token}`, {
      url: URL_OK,
      method: 'POST',
      rawBody: '{}',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/method/);
  });

  it('metóda sa porovnáva case-insensitive', async () => {
    const token = await tokenFor(URL_OK, 'get');
    const res = await verifyNip98Authorization(`Nostr ${token}`, { url: URL_OK, method: 'GET' });
    expect(res.ok).toBe(true);
  });

  it('iný kind ako 27235', async () => {
    const token = await tokenFor(URL_OK, 'GET', { kind: 1 });
    const res = await verifyNip98Authorization(`Nostr ${token}`, { url: URL_OK, method: 'GET' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/kind/);
  });

  it('POST bez payload tagu → zamietnuté', async () => {
    const token = await tokenFor('https://gateway.example/events', 'POST');
    const res = await verifyNip98Authorization(`Nostr ${token}`, {
      url: 'https://gateway.example/events',
      method: 'POST',
      rawBody: '{"a":1}',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/payload/);
  });

  it('POST s nesúhlasiacim telom → payload tag nesedí', async () => {
    const body = { a: 1 };
    const token = await tokenFor('https://gateway.example/events', 'POST', { payload: body });
    const res = await verifyNip98Authorization(`Nostr ${token}`, {
      url: 'https://gateway.example/events',
      method: 'POST',
      rawBody: '{"a":2}',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/payload/);
  });
});
