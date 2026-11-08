/**
 * i18n konfigurácia (Phase 2a).
 *
 * Dve veci, ktoré sa tu strážia, sa bežným testom uniknú:
 *  1. **default jazyk aplikácie je EN** — testy bežia so `lng: 'sk'`
 *     (`test/setup.ts`), takže default by sa v suite nikde neoveril.
 *     Test preto volá `initI18n` na ČERSTVOM inštancii `i18next` a
 *     detekcia musí spadnúť na `en` (prázdny localStorage → navigator).
 *  2. **SK nie je v bundle** — `partialBundledLanguages: true` znamená,
 *     že EN resource je v bundle a slovenčina si vyžiada backend
 *     (`i18next-resources-to-backend`) → v buildu je to lazy chunk.
 *     `hasResourceBundle('sk', …) === false` pred `changeLanguage` je
 *     priamy dôkaz, že sa nezačal baliť SK.
 *
 * `Intl.PluralRules` test nie je dekorácia: bez `key_one/_few/_other`
 * by i18next siahol po základnom kľúči a slovenčina by dostala jeden
 * tvar pre 1, 2 aj 5 (overené naživo v `i18next` zdrojáku).
 */
import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';

import { i18n, initI18n } from '../src/i18n/index.js';
import {
  DEFAULT_LANG,
  LANGUAGE_STORAGE_KEY,
  NAMESPACES,
  SUPPORTED_LANGS,
} from '../src/i18n/config.js';
import { operatorStatusLabel, writeGateCopy } from '../src/lib/write-codes.js';

/** ploché zoznamy kľúčov (`a.b`) — porovnáva sa SHAPE, nie texty */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix];
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([key, value]) => leafKeys(value, prefix === '' ? key : `${prefix}.${key}`))
    .sort();
}

describe('i18n config (Phase 2a)', () => {
  it('default aplikácie je en a slovenčina sa načítava lazy backendom', async () => {
    globalThis.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    const fresh = createInstance();
    await initI18n(fresh);

    expect(SUPPORTED_LANGS).toEqual(['en', 'sk']);
    expect(DEFAULT_LANG).toBe('en');
    expect(fresh.resolvedLanguage).toBe('en');
    expect(fresh.t('common:states.loading')).toBe('loading from the gateway');

    // SK v bundle nie je → bez tohto by build nemal samostatný lazy chunk
    expect(fresh.hasResourceBundle('sk', 'common')).toBe(false);

    await fresh.changeLanguage('sk');
    expect(fresh.t('common:states.loading')).toBe('načítavam z gateway');
    // `<html lang>` patrí i18n, nie `index.html` (statický default je en)
    expect(document.documentElement.getAttribute('lang')).toBe('sk');

    await fresh.changeLanguage('en');
    expect(fresh.t('common:states.loading')).toBe('loading from the gateway');
  });

  it('en a sk majú rovnakú štruktúru kľúčov vo všetkých namespace-och', async () => {
    const fresh = createInstance();
    await initI18n(fresh);
    await fresh.changeLanguage('sk');

    for (const ns of NAMESPACES) {
      const en = fresh.getResourceBundle('en', ns);
      const sk = fresh.getResourceBundle('sk', ns);
      expect(en, `chýba en/${ns}.json`).toBeTypeOf('object');
      expect(sk, `chýba sk/${ns}.json`).toBeTypeOf('object');
      expect(leafKeys(sk), `sk/${ns} sa líši od en/${ns}`).toEqual(leafKeys(en));
    }
  });

  it('slovenčina má tri plural tvary (one / few / other)', () => {
    expect(new Intl.PluralRules('sk').select(1)).toBe('one');
    expect(new Intl.PluralRules('sk').select(2)).toBe('few');
    expect(new Intl.PluralRules('sk').select(5)).toBe('other');
    // angličtina má len dva tvary — _few by sa v en nikde nepoužil
    expect(new Intl.PluralRules('en').select(1)).toBe('one');
    expect(new Intl.PluralRules('en').select(2)).toBe('other');

    // test setup drží jazyk = sk, takže tu platia slovenské tvary
    expect(i18n.t('forum:thread.replies', { count: 1 })).toBe('1 odpoveď');
    expect(i18n.t('forum:thread.replies', { count: 2 })).toBe('2 odpovede');
    expect(i18n.t('forum:thread.replies', { count: 5 })).toBe('5 odpovedí');
  });

  it('copy write-gate kodov renderuje v sk aj v en', async () => {
    const values = { claimId: 'a'.repeat(64), relay: 'wss://relay.example' };

    const sk = writeGateCopy('WG_PENDING', values);
    expect(sk.headline).toBe('Registrácia čaká na schválenie');
    expect(sk.detail).toContain('vlastník inštancie');
    expect(sk.detail).not.toContain('{{');
    expect(operatorStatusLabel('pending')).toBe('čaká');
    // fallback bez hodnôt musí mať vetu bez interpolácie (inak by v UI
    // zostal `{{claimId}}`)
    expect(writeGateCopy('WG_PENDING', {}).detail).toContain('fronte');

    await i18n.changeLanguage('en');
    const en = writeGateCopy('WG_PENDING', values);
    expect(en.headline).toBe('Registration is waiting for approval');
    expect(en.detail).toContain('instance owner');
    expect(en.detail).not.toContain('{{');
    expect(operatorStatusLabel('pending')).toBe('pending');
    expect(writeGateCopy('WG_PENDING', {}).detail).toContain('queue');
    // afterEach v `test/setup.ts` vracia jazyk späť na sk
  });
});
