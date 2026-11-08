/**
 * Testy zdieľaných federáčnych konštánt (Phase 6a, dizajn Q5).
 *
 * Držia tri veci, na ktorých visí gateway aj indexer:
 *  1. `origin` má práve dve rodiny hodnôt — `'self'` a id upstreamu;
 *     normalizácia nikdy nevymyslí upstream z prázdneho vstupu,
 *  2. `FED_SYNC_KINDS` je presne obsahový overlay zo zadania
 *     (1020–1032, 10030, 30020, 30023) a infra kindy v ňom NIE SU,
 *  3. id upstreamu je host URL (s portom, bez schémy/cesty) — presne tá
 *     hodnota, ktorú očakáva E2E (`origin=127.0.0.1:18081`) aj čip UI.
 */
import { describe, expect, it } from 'vitest';

import {
  FED_SYNC_KINDS,
  FED_SYNC_KIND_SET,
  NETWORK_ROOT_SLUG,
  ORIGIN_SELF,
  addressOf,
  isFedSyncKind,
  isSelfOrigin,
  normalizeOrigin,
  parseAddress,
  topicAddress,
  upstreamIdFromUrl,
} from '../src/federation.js';
import { KINDS } from '../src/kinds.js';

describe('origin (dizajn Q5: jeden adresový priestor, dve rodiny hodnôt)', () => {
  it('self je jediná kľúčová konštanta', () => {
    expect(ORIGIN_SELF).toBe('self');
    expect(isSelfOrigin('self')).toBe(true);
    // neznáme = domáce (rovnaká konvencia ako default stĺpca v indexeri)
    expect(isSelfOrigin(null)).toBe(true);
    expect(isSelfOrigin(undefined)).toBe(true);
    expect(isSelfOrigin('aiforum.myhood.sk')).toBe(false);
  });

  it('normalizácia: prázdny a neplatný vstup → self, inak trim', () => {
    expect(normalizeOrigin('')).toBe(ORIGIN_SELF);
    expect(normalizeOrigin('   ')).toBe(ORIGIN_SELF);
    expect(normalizeOrigin(null)).toBe(ORIGIN_SELF);
    expect(normalizeOrigin(42)).toBe(ORIGIN_SELF);
    expect(normalizeOrigin(' 127.0.0.1:18081 ')).toBe('127.0.0.1:18081');
    expect(normalizeOrigin(ORIGIN_SELF)).toBe(ORIGIN_SELF);
  });
});

describe('FED_SYNC_KINDS — federovaný overlay (zadanie 6a)', () => {
  it('obsahuje presne obsahové kindy zo zadania', () => {
    for (const kind of [1020, 1021, 1022, 1023, 1030, 1031, 1032, 10030, 30020, 30023]) {
      expect(isFedSyncKind(kind), `kind ${String(kind)}`).toBe(true);
    }
    expect(FED_SYNC_KINDS).toEqual([...FED_SYNC_KIND_SET].sort((a, b) => a - b));
  });

  it('infra a moderácia sa neposielajú (zdroj pravdy je relay, nie gateway)', () => {
    for (const kind of [
      KINDS.NODE_DIRECTORY, // 30028 writers
      KINDS.OUTBOX, // 30002
      KINDS.OPERATOR_CLAIM, // 1055
      KINDS.AUTH_NIP98, // 27235
      KINDS.LABEL, // 1040
      KINDS.WITHDRAW, // 1033 — mimo rozsahu 1020–1032 zo zadania
      KINDS.FOLLOWS, // 10031 — sledovanie je domáci vzťah
      KINDS.PROFILE, // 0
    ]) {
      expect(isFedSyncKind(kind), `kind ${String(kind)}`).toBe(false);
    }
  });

  it('každý kind je v shared registry (žiadne voľné číslo)', () => {
    const registry = new Set<number>(Object.values(KINDS));
    for (const kind of FED_SYNC_KINDS) expect(registry.has(kind), `kind ${String(kind)}`).toBe(true);
  });
});

describe('upstreamIdFromUrl — id inštancie je host (Q5)', () => {
  it('necháva port, stripuje schému, cestu a /api prefix', () => {
    expect(upstreamIdFromUrl('http://127.0.0.1:18081')).toBe('127.0.0.1:18081');
    expect(upstreamIdFromUrl('https://aiforum.myhood.sk/api')).toBe('aiforum.myhood.sk');
    expect(upstreamIdFromUrl(' https://Aiforum.MyHood.sk/api/ ')).toBe('aiforum.myhood.sk');
    expect(upstreamIdFromUrl('https://example.com:8443/api/events')).toBe('example.com:8443');
  });

  it('neplatná URL alebo schéma → null (config then položku vynechá)', () => {
    expect(upstreamIdFromUrl('')).toBeNull();
    expect(upstreamIdFromUrl('127.0.0.1:18081')).toBeNull();
    expect(upstreamIdFromUrl('ws://relay.test:8080')).toBeNull();
    expect(upstreamIdFromUrl('ftp://x.test')).toBeNull();
  });
});

describe('adresy (jeden adresový priestor, Q5)', () => {
  it('topic adresa je 30020:<pubkey>:<slug> a dá sa späť parse-núť', () => {
    const pk = 'a'.repeat(64);
    const addr = topicAddress(pk, 'ai-agents');
    expect(addr).toBe(`30020:${pk}:ai-agents`);
    expect(parseAddress(addr)).toEqual({ kind: KINDS.TOPIC, pubkey: pk, d: 'ai-agents' });
  });

  it('rovnaký slug od dvoch autorov sú dve adresy (koexistencia)', () => {
    const a = topicAddress('a'.repeat(64), 'general');
    const b = topicAddress('b'.repeat(64), 'general');
    expect(a).not.toBe(b);
  });

  it('parseAddress odmietne čokoľvek, čomu nerozumieme', () => {
    expect(parseAddress('')).toBeNull();
    expect(parseAddress('30020')).toBeNull();
    expect(parseAddress('30020:zzz:slug')).toBeNull();
    expect(parseAddress(`x:${'a'.repeat(64)}:slug`)).toBeNull();
    // `d` tag môže byť prázdny (replaceable bez d) — to je platná adresa
    expect(parseAddress(`0:${'c'.repeat(64)}:`)).toEqual({ kind: 0, pubkey: 'c'.repeat(64), d: '' });
  });

  it('NETWORK_ROOT_SLUG je oddelená sekcia, nie adresa topiku', () => {
    expect(NETWORK_ROOT_SLUG).toBe('network');
    expect(NETWORK_ROOT_SLUG).not.toBe('self');
  });

  it('addressOf drží ten istý formát ako addressFor() v indexeri', () => {
    expect(addressOf(KINDS.TOPIC, 'd'.repeat(64), 'x')).toBe(`30020:${'d'.repeat(64)}:x`);
    expect(addressOf(10030, 'd'.repeat(64), '')).toBe(`10030:${'d'.repeat(64)}:`);
  });
});
