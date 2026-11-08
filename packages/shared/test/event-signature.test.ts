import { describe, expect, it } from 'vitest';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools';

import { KINDS, validateEvent } from '../src/index.js';
import type { NostrEvent } from '../src/index.js';

const ROOT_ID = 'e'.repeat(64);

/**
 * Úplná overovacia funkcia podľa NIP-01: podpis musí sedieť na id
 * (nostr-tools `verifyEvent`) A id sa musí rovnať hashu obsahu
 * (`getEventHash` = SHA-256 zo [0,pubkey,created_at,kind,tags,content]).
 */
function verifyFull(event: NostrEvent): boolean {
  return verifyEvent(event) && getEventHash(event) === event.id;
}

function signQuestion(content: string): NostrEvent {
  const sk = generateSecretKey();
  const template = {
    kind: KINDS.QUESTION,
    created_at: 1_793_174_400,
    tags: [['d', 'tokio-graceful-shutdown'], ['t', 'lang/rust/tokio']],
    content,
  };
  // finalizeEvent dopočíta id a pripojí BIP-340 Schnorr podpis
  return finalizeEvent(template, sk) as unknown as NostrEvent;
}

describe('podpis NIP-01 eventu (nostr-tools verifyEvent + getEventHash)', () => {
  it('vygeneruje kľúč, podpíše event a overí podpis', () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);

    const signed = finalizeEvent(
      {
        kind: KINDS.POST,
        created_at: 1_793_174_400,
        tags: [['e', ROOT_ID, 'root']],
        content: 'odpoved',
      },
      sk,
    );
    expect(signed.pubkey).toBe(pubkey);
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyEvent(signed)).toBe(true);
    expect(getEventHash(signed)).toBe(signed.id);
    expect(verifyFull(signed as unknown as NostrEvent)).toBe(true);
  });

  it('overí podpis aj cez našu validáciu (validateEvent + verifyEvent)', () => {
    const event = signQuestion('Ako správne ukončiť Tokio runtime?');
    expect(verifyFull(event)).toBe(true);
    const result = validateEvent(event);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('odmietne event s pozmeneným obsahom (id už nie je hash obsahu)', () => {
    const event = signQuestion('povodny obsah');
    const tampered = { ...event, content: 'pozmeneny obsah' };
    // podpis sám o sebe sedí na staré id, ale id nesedí na obsah
    expect(getEventHash(tampered)).not.toBe(tampered.id);
    expect(verifyFull(tampered)).toBe(false);
  });

  it('odmietne event s pozmeneným pubkey a rozlíši cudzí podpis', () => {
    const event = signQuestion('obsah');
    const wrongKey = { ...event, pubkey: 'f'.repeat(64) };
    expect(verifyFull(wrongKey)).toBe(false);

    const otherSk = generateSecretKey();
    const forged = finalizeEvent(
      {
        kind: KINDS.QUESTION,
        created_at: event.created_at,
        tags: event.tags,
        content: event.content,
      },
      otherSk,
    ) as unknown as NostrEvent;
    expect(verifyFull(forged)).toBe(true);
    expect(forged.pubkey).not.toBe(event.pubkey);
    expect(forged.id).not.toBe(event.id);
  });

  it('odmietne ms created_at (poruší hash aj našu štrukturálnu validáciu)', () => {
    const event = signQuestion('sekundovy created_at');
    expect(event.created_at).toBe(1_793_174_400);
    expect(validateEvent(event).valid).toBe(true);

    const msEvent = { ...event, created_at: event.created_at * 1000 };
    expect(verifyFull(msEvent)).toBe(false);
    expect(validateEvent(msEvent).valid).toBe(false);
  });

  it('F4AI-14: reálne podpísaný kind 0 (a 3) prejde shared validátorom aj verifyFull', () => {
    // publish kind 0 cez shared validátor musí po zaradení PROFILE/CONTACTS
    // do registry prejsť — to je rozhodnutie manažéra (a) v F4AI-14
    const sk = generateSecretKey();
    const profile = finalizeEvent(
      {
        kind: KINDS.PROFILE,
        created_at: 1_793_174_400,
        tags: [],
        content: JSON.stringify({ name: 'jano', display_name: 'Jano', about: 'nostr' }),
      },
      sk,
    ) as unknown as NostrEvent;
    expect(verifyFull(profile)).toBe(true);
    expect(validateEvent(profile).valid).toBe(true);

    const contacts = finalizeEvent(
      {
        kind: KINDS.CONTACTS,
        created_at: 1_793_174_401,
        tags: [['p', profile.pubkey, 'wss://relay.example', 'follows']],
        content: JSON.stringify([[profile.pubkey, 'wss://relay.example', 'follows']]),
      },
      sk,
    ) as unknown as NostrEvent;
    expect(verifyFull(contacts)).toBe(true);
    expect(validateEvent(contacts).valid).toBe(true);

    // kind 4 (encrypted DM) v registry stále nie je
    const dm = finalizeEvent(
      { kind: 4, created_at: 1_793_174_402, tags: [], content: 'sifrovana sprava' },
      sk,
    ) as unknown as NostrEvent;
    expect(verifyFull(dm)).toBe(true);
    expect(validateEvent(dm).valid).toBe(false);
  });
});
