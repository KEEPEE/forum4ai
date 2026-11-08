/**
 * Testy kľúčov a signingu (S11, F4AI-17) — NIP-01 `finalizeEvent` bez siete.
 *
 * Dva smery:
 *  1. determinizmus — zo známej `nsec` musí vzísť presný pubkey/npub/id
 *     (vektory spočítané `nostr-tools`, pevné v `fixtures.ts`),
 *  2. zhoda s L2 politikou — podpísanú 1023 musí prijať `validateEvent`
 *     a `verifyFull` zo `@forum4ai/shared` (rovnaké funkcie bežia na
 *     relayi a v gateway `POST /events`, takže UI nemôže poslať event,
 *     ktorý by relay zahodil).
 */
import { describe, expect, it } from 'vitest';
import { getEventHash } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import { validateEvent, verifyFull } from '@forum4ai/shared';

import {
  NSEC_STORAGE_KEY,
  buildReplyTags,
  clearIdentity,
  composeContent,
  createMemoryStorage,
  identityFromNsec,
  loadStoredIdentity,
  secretKeyFromNsec,
  signEvent,
  signReply,
} from '../src/nostr/keys.js';
import { TEST_NPUB, TEST_NSEC, TEST_PUBKEY, TEST_SIGNED_REPLY_ID, hexId } from './fixtures.js';

const ROOT_ID = 'e'.repeat(64);
const TOPIC_ADDRESS = `30020:${hexId('c3')}:rust`;

describe('identita a úložisko kľúča (F4AI-24: žiadna auto-generácia)', () => {
  it('prázdne úložisko = ŽIADNY kľúč (anonym), nič sa nevygeneruje ani nezapíše', () => {
    const storage = createMemoryStorage();
    expect(loadStoredIdentity(storage)).toBeNull();
    // kľúčové: pred Phase 1b tu volanie zapísalo náhodný nsec
    expect(storage.getItem(NSEC_STORAGE_KEY)).toBeNull();
    expect(NSEC_STORAGE_KEY).toBe('forum4ai_nsec');
  });

  it('chýbajúce úložisko (SSR) je tiež anonym, nie chyba', () => {
    expect(loadStoredIdentity(null)).toBeNull();
  });

  it('uložená nsec sa obnoví presne (druhé čítanie = tá istá identita)', () => {
    const storage = createMemoryStorage({ [NSEC_STORAGE_KEY]: TEST_NSEC });
    const first = loadStoredIdentity(storage);
    const second = loadStoredIdentity(storage);
    expect(first).not.toBeNull();
    expect(second?.pubkey).toBe(first?.pubkey);
    expect(second?.nsec).toBe(first?.nsec);
    expect(first?.created).toBe(false);
    expect(first?.npub).toBe(TEST_NPUB);
  });

  it('poškodená hodnota vráti null a NEPREPÍŠE sa — kľúč je majetok používáča', () => {
    const broken = 'nsec1tomneniplatnykluc';
    const storage = createMemoryStorage({ [NSEC_STORAGE_KEY]: broken });
    expect(loadStoredIdentity(storage)).toBeNull();
    expect(storage.getItem(NSEC_STORAGE_KEY)).toBe(broken);
  });

  it('clearIdentity odstráni kľúč z úložiska', () => {
    const storage = createMemoryStorage({ [NSEC_STORAGE_KEY]: TEST_NSEC });
    clearIdentity(storage);
    expect(storage.getItem(NSEC_STORAGE_KEY)).toBeNull();
    expect(loadStoredIdentity(storage)).toBeNull();
  });

  it('identityFromNsec vráti známy pubkey a npub (nip-19 vektor)', () => {
    const identity = identityFromNsec(TEST_NSEC);
    expect(identity.pubkey).toBe(TEST_PUBKEY);
    expect(identity.npub).toBe(TEST_NPUB);
    expect(decode(identity.npub).type).toBe('npub');
    expect(decode(identity.npub).data).toBe(TEST_PUBKEY);
  });

  it('stráví aj surový 64-hex tajný kľúč (lepí ho z iných toolov)', () => {
    const rawHex = `${'0'.repeat(62)}03`;
    const identity = identityFromNsec(rawHex);
    expect(identity.pubkey).toBe(TEST_PUBKEY);
    expect(secretKeyFromNsec(rawHex)).toHaveLength(32);
  });

  // regression B6: normalizácia vstupu — medzery, VELKE pismena, 0x prefix
  it('normalizuje vstup kľúča (trim, lowercase, 0x prefix) na tú istú identitu', () => {
    const rawHex = `${'0'.repeat(62)}03`;
    const variants = [
      `  ${rawHex}  `,
      rawHex.toUpperCase(),
      `0x${rawHex}`,
      ` 0X${rawHex.toUpperCase()} `,
    ];
    for (const variant of variants) {
      expect(identityFromNsec(variant).pubkey, `variant ${JSON.stringify(variant)}`).toBe(TEST_PUBKEY);
    }
    // nsec1… prejde tiež (lowercase bech32 ostáva platné)
    expect(identityFromNsec(` ${TEST_NSEC} `).pubkey).toBe(TEST_PUBKEY);
  });

  it('odmietne npub namiesto nsec', () => {
    expect(() => secretKeyFromNsec(TEST_NPUB)).toThrow(/nsec/);
  });
});

describe('signing NIP-01 (finalizeEvent, bez siete)', () => {
  const identity = identityFromNsec(TEST_NSEC);

  it('vyprodukuje deterministickú 1023 s presným id a pubkey', () => {
    const event = signReply({
      rootId: ROOT_ID,
      title: 'Titulok',
      text: 'telo odpovede',
      secretKey: identity.secretKey,
      createdAt: 1_700_000_000,
      topicAddress: TOPIC_ADDRESS,
      topicSlug: 'rust',
    });
    expect(event.kind).toBe(1023);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(event.id).toBe(TEST_SIGNED_REPLY_ID);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(event.content).toBe('# Titulok\n\ntelo odpovede');
    expect(getEventHash(event)).toBe(event.id);
  });

  it('event prejde shared validátorom L2 politiky aj verifyFull', () => {
    const event = signReply({
      rootId: ROOT_ID,
      title: 'Titulok',
      text: 'telo odpovede',
      secretKey: identity.secretKey,
      // A7 (P0): shared validátor odmieta `created_at` pred 2024-01-01,
      // preto tu nie je starý 1_700_000_000 (2023) — testuje podpis, nie
      // spodnú hranicu času (tú má vlastný test v shared/validators)
      createdAt: 1_710_000_000,
      topicAddress: TOPIC_ADDRESS,
      topicSlug: 'rust',
    });
    const validation = validateEvent(event);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(verifyFull(event)).toBe(true);
  });

  it('1023 bez root markera politika odmietne (rovnako ako relay)', () => {
    const event = signEvent({ kind: 1023, content: 'odpoveď bez referencie', secretKey: identity.secretKey, createdAt: 1_700_000_000 });
    const validation = validateEvent(event);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(' ')).toContain('root');
  });

  it('root marker je práve jeden aj pri odpovedi na inú odpoveď', () => {
    const tags = buildReplyTags(ROOT_ID, { parentId: hexId('a3') });
    const roots = tags.filter((tag) => tag[0] === 'e' && tag[2] === 'root');
    const parents = tags.filter((tag) => tag[0] === 'e' && tag[2] === 'parent');
    expect(roots).toHaveLength(1);
    expect(parents).toHaveLength(1);
    expect(parents[0]?.[1]).toBe(hexId('a3'));
  });

  it('topic sa zapíše do `a` aj `t` tagu', () => {
    const event = signReply({
      rootId: ROOT_ID,
      text: 'len text',
      secretKey: identity.secretKey,
      createdAt: 1_700_000_001,
      topicAddress: TOPIC_ADDRESS,
      topicSlug: 'rust',
    });
    expect(event.tags).toContainEqual(['a', TOPIC_ADDRESS]);
    expect(event.tags).toContainEqual(['t', 'rust']);
    expect(verifyFull(event)).toBe(true);
  });

  it('bez createdAt dosadí aktuálny čas (sekundy, nie ms)', () => {
    const before = Math.floor(Date.now() / 1000);
    const event = signEvent({ kind: 1023, content: 'x', tags: [['e', ROOT_ID, 'root']], secretKey: identity.secretKey });
    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(event.created_at).toBeLessThan(Date.now());
  });
});

describe('formátovanie obsahu', () => {
  it('composeContent dá nadpis do prvého riadku', () => {
    expect(composeContent('A', 'B')).toBe('# A\n\nB');
    expect(composeContent('A', '')).toBe('# A');
    expect(composeContent('', 'B')).toBe('B');
  });
});
