/**
 * Testy mapovania WG_* → slovenské copy (F4AI-23, Phase 1b).
 *
 * Prečo samostatný súbor s čistými funkciami: copy je KONTRAKT voči
 * gatewayu (tabuľka kódov v `docs/skill.md`) a voči Phase 2 (i18n) —
 * testy držia, že
 *  1. KAŽDÝ kód z `WriteGateCode` má hlavičku aj detail (žiadny kód
 *     neskončí s prázdnu bublinu),
 *  2. žiadne copy neobsahuje nezasypaný placeholder `{claimId}`,
 *  3. neznámy kód nesklame — ukáže `reason` gatewayu, nie našu domnienku,
 *  4. `WG_AGENT_OPERATOR_INACTIVE` sa nesmie stať jedinou cestou, ktorú
 *     UI potrebuje (gateway ho s reálnym OperatorsDb takmer nikdy nepoužíva).
 */
import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_WRITE_COPY,
  OPERATOR_STATUS_COPY,
  UNKNOWN_WRITE_GATE_COPY,
  WRITE_GATE_COPY,
  operatorStatusLabel,
  shortHex,
  writeGateCopy,
  type WriteGateCopy,
} from '../src/lib/write-codes.js';
import type { WriteGateCode } from '../src/api/types.js';
import { TEST_PUBKEY, hexId } from './fixtures.js';

/** všetky kódy, ktoré typ pripúšťa — ak pribudne nový, test zlyhá a pripomenie copy */
const ALL_CODES: WriteGateCode[] = [
  'WG_GATE_OFF',
  'WG_BOOTSTRAP',
  'WG_OPERATOR',
  'WG_AGENT',
  'WG_NOT_REGISTERED',
  'WG_PENDING',
  'WG_LAPSED',
  'WG_REVOKED',
  'WG_AGENT_OPERATOR_INACTIVE',
];

describe('WRITE_GATE_COPY (WG_* → slovenčina)', () => {
  it('každý kód má hlavičku, detail a tón — žiadna prázdna bublina', () => {
    for (const code of ALL_CODES) {
      const copy: WriteGateCopy = WRITE_GATE_COPY[code];
      expect(copy, `chýba copy pre ${code}`).toBeDefined();
      expect(copy.headline.length, `hlavička pre ${code}`).toBeGreaterThan(8);
      expect(copy.detail.length, `detail pre ${code}`).toBeGreaterThan(8);
      expect(['ok', 'info', 'warn', 'error']).toContain(copy.tone);
    }
  });

  it('typový zoznam kódov sedí s gateway `WriteGateCode` (9 položiek)', () => {
    expect(Object.keys(WRITE_GATE_COPY).sort()).toEqual([...ALL_CODES].sort());
  });

  it('WG_NOT_REGISTERED je jediná CTA na registráciu (F4AI-22)', () => {
    const copy = writeGateCopy('WG_NOT_REGISTERED');
    expect(copy.cta).toBeDefined();
    expect(copy.to).toBe('/register');
    expect(copy.headline).toContain('prístup');
  });

  it('WG_PENDING povie, že schvaľuje VLASTNÍK — nie automat', () => {
    const copy = writeGateCopy('WG_PENDING');
    expect(copy.headline).toContain('čaká');
    expect(copy.detail).toContain('vlastník inštancie');
  });

  it('WG_LAPSED vedie k obnove, WG_REVOKED k vysvetleniu', () => {
    expect(writeGateCopy('WG_LAPSED').to).toBe('/register');
    const revoked = writeGateCopy('WG_REVOKED');
    expect(revoked.tone).toBe('error');
    expect(revoked.detail).toContain('príspevky');
  });

  it('povolené stavy (bootstrap/operator/agent) majú tón `ok`', () => {
    // `WG_GATE_OFF` je v ALLOWING_CODES (write-gate je vypnutý → zápis
    // neposudzuje sa), ale pre návštevníka to nie je dobrá správa → warn
    for (const code of ['WG_BOOTSTRAP', 'WG_OPERATOR', 'WG_AGENT'] as const) {
      expect(WRITE_GATE_COPY[code].tone, `tón pre ${code}`).toBe('ok');
    }
    expect(WRITE_GATE_COPY.WG_GATE_OFF.tone).toBe('warn');
  });
});

describe('writeGateCopy (interpolácia a fallback)', () => {
  it('WG_PENDING zasype claim_id a relay', () => {
    const copy = writeGateCopy('WG_PENDING', { claimId: 'ab'.repeat(32), relay: 'wss://relay.example' });
    expect(copy.detail).toContain('abababab…');
    expect(copy.detail).toContain('wss://relay.example');
    expect(copy.detail ?? '').not.toContain('{claimId');
  });

  it('bez hodnoty nepoužije placeholder — sľúbi len to, čo vieme', () => {
    const copy = writeGateCopy('WG_PENDING', {});
    expect(copy.detail ?? '').not.toContain('{');
    expect(copy.detail).toContain('vo fronte');
  });

  it('WG_AGENT zasype skráteného operátora', () => {
    const copy = writeGateCopy('WG_AGENT', { operator: TEST_PUBKEY });
    expect(copy.detail).toContain(shortHex(TEST_PUBKEY));
  });

  it('neznámy kód → reason gatewayu ako detail (naša veta je len hlavička)', () => {
    const copy = writeGateCopy('WG_ZBUDNA' as WriteGateCode, { reason: 'dôvod, ktorý nepoznáme' });
    expect(copy.headline).toBe(UNKNOWN_WRITE_GATE_COPY.headline);
    expect(copy.detail).toBe('dôvod, ktorý nepoznáme');
  });

  it('neznámy kód bez reasonu aspoň neodkazuje na prázdno', () => {
    const copy = writeGateCopy(undefined, {});
    expect(copy.headline).toBe(UNKNOWN_WRITE_GATE_COPY.headline);
    expect(copy.detail.length).toBeGreaterThan(8);
  });

  it('anonym nie je chyba write-gate — má vlastné copy bez sľubu zápisu', () => {
    expect(ANONYMOUS_WRITE_COPY.headline).toContain('prihlás');
    expect(ANONYMOUS_WRITE_COPY.detail).toContain('kľúč');
    // anonym nemá `to`, lebo CTA je login dialóg, nie route
    expect(ANONYMOUS_WRITE_COPY.to).toBeUndefined();
  });
});

describe('OPERATOR_STATUS_COPY (stav operátora v tabuľke, F4AI-24)', () => {
  it('štyri stavy, krátke štítky', () => {
    expect(Object.keys(OPERATOR_STATUS_COPY).sort()).toEqual(['active', 'lapsed', 'pending', 'revoked']);
    expect(operatorStatusLabel('pending')).toBe('čaká');
    expect(operatorStatusLabel('active')).toBe('aktívny');
    expect(operatorStatusLabel('lapsed')).toBe('vypršaný');
    expect(operatorStatusLabel('revoked')).toBe('zrušený');
  });

  it('neznámy status nespadne — ukáže sa surová hodnota', () => {
    expect(operatorStatusLabel('boottt')).toBe('boottt');
  });
});

describe('shortHex', () => {
  it('skráti 64-hex na čitateľný útržok', () => {
    expect(shortHex(hexId('a'))).toBe('aaaaaaaa…');
  });

  it('prázdny reťazec nezhodí', () => {
    expect(shortHex('')).toBe('');
  });
});
