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

    expect(SUPPORTED_LANGS).toEqual(['en', 'sk', 'de']);
    expect(DEFAULT_LANG).toBe('en');
    expect(fresh.resolvedLanguage).toBe('en');
    expect(fresh.t('common:states.loading')).toBe('loading from the gateway');

    // SK v bundle nie je → bez tohto by build nemal samostatný lazy chunk
    expect(fresh.hasResourceBundle('sk', 'common')).toBe(false);
    // F4AI-43: nemčina je na tom rovnako (jen `<html lang>` staticky ostáva en)
    expect(fresh.hasResourceBundle('de', 'common')).toBe(false);

    await fresh.changeLanguage('sk');
    expect(fresh.t('common:states.loading')).toBe('načítavam z gateway');
    // `<html lang>` patrí i18n, nie `index.html` (statický default je en)
    expect(document.documentElement.getAttribute('lang')).toBe('sk');

    // F4AI-43: the detector path reaches German the same lazy way
    await fresh.changeLanguage('de');
    expect(fresh.t('common:states.loading')).toBe('Lädt vom Gateway');
    expect(document.documentElement.getAttribute('lang')).toBe('de');

    await fresh.changeLanguage('en');
    expect(fresh.t('common:states.loading')).toBe('loading from the gateway');
  });

  it('every supported language has the same key structure as en in every namespace', async () => {
    const fresh = createInstance();
    await initI18n(fresh);
    // F4AI-43: one loop over the registry — a new language is checked without
    // touching this test (that is the whole point of the registry)
    for (const code of SUPPORTED_LANGS.filter((code) => code !== 'en')) {
      await fresh.changeLanguage(code);
      for (const ns of NAMESPACES) {
        const en = fresh.getResourceBundle('en', ns);
        const other = fresh.getResourceBundle(code, ns);
        expect(en, `chýba en/${ns}.json`).toBeTypeOf('object');
        expect(other, `chýba ${code}/${ns}.json`).toBeTypeOf('object');
        expect(leafKeys(other), `${code}/${ns} sa líši od en/${ns}`).toEqual(leafKeys(en));
      }
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

  // F4AI-43: nemčina má pravidlá `one`/`other` (Intl.PluralRules), nie `few` —
  // `_few` kľúče v de sú len kópiou `_other`, aby zostala množina kľúčov
  // identická s en/sk (test vyššie); vybraný nikdy nebudú
  it('nemčina má dva plural tvary (one / other) a tie sa renderujú', () => {
    expect(new Intl.PluralRules('de').select(1)).toBe('one');
    expect(new Intl.PluralRules('de').select(2)).toBe('other');
    expect(new Intl.PluralRules('de').select(5)).toBe('other');

    expect(i18n.t('forum:thread.replies', { count: 1, lng: 'de' })).toBe('1 Antwort');
    expect(i18n.t('forum:thread.replies', { count: 2, lng: 'de' })).toBe('2 Antworten');
    expect(i18n.t('forum:thread.replies', { count: 5, lng: 'de' })).toBe('5 Antworten');
    expect(i18n.t('forum:search.results', { count: 1, lng: 'de' })).toBe('1 Ergebnis');
    expect(i18n.t('forum:search.results', { count: 12, lng: 'de' })).toBe('12 Ergebnisse');
    // the dead `_few` copy must never win: German 2 is `other`
    expect(i18n.t('forum:ideas.count', { count: 2, lng: 'de' })).toBe('2 Ideen');
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
