/**
 * i18n setup (Phase 2a) — initializing i18next for the app and for the tests.
 *
 * The app (`main.tsx`) calls `setupI18n()` before the first render:
 *  - EN resources are in the bundle (a static import in `resources.ts`),
 *  - SK is requested by the backend (`i18next-resources-to-backend` + dynamic
 *    `import()`), so the language switches without a reload and the SK text
 *    arrives as a separate chunk,
 *  - the detector honours `?lng=` → `localStorage.forum4ai_lang` →
 *    `navigator`, and the choice is persisted to that same key.
 *
 * Tests (`test/setup.ts`) call THE SAME `setupI18n` with `lng: 'sk'` and
 * resources for EN and SK inline — the backend is not called for bundled
 * languages (i18next skips the load once the bundle already has them), so the
 * tests are synchronous and deterministic.
 */
import i18n from 'i18next';
import type { i18n as I18nInstance, InitOptions } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';

import { BASE_OPTIONS, DEFAULT_LANG, DETECTOR_OPTIONS, LANGUAGE_STORAGE_KEY } from './config.js';
import { enResources, localeResource } from './resources.js';

/** nastaví `<html lang>` — dizajn Q2 (switcher ho musí meniť tiež) */
function syncHtmlLang(instance: I18nInstance): void {
  if (typeof document === 'undefined') return;
  const apply = (lng: string): void => {
    document.documentElement.setAttribute('lang', lng || DEFAULT_LANG);
  };
  apply(instance.resolvedLanguage ?? instance.language ?? DEFAULT_LANG);
  instance.on('languageChanged', apply);
}

/**
 * Inicializuje ĽUBOVOĽNú inštanciu (default globálna). `overrides`
 * používajú testy (inline resources, `lng`) a budúce SSR/varianty.
 */
export async function initI18n(
  instance: I18nInstance = i18n,
  overrides: InitOptions = {},
): Promise<I18nInstance> {
  instance.use(LanguageDetector).use(resourcesToBackend(localeResource)).use(initReactI18next);
  await instance.init({
    ...BASE_OPTIONS,
    detection: DETECTOR_OPTIONS,
    resources: enResources,
    ...overrides,
  });
  syncHtmlLang(instance);
  return instance;
}

/**
 * Init pre entry point. `isInitialized` poistka je pre testy, ktoré
 * majú i18n predpripravené z `test/setup.ts` — main.tsx ich nesmie
 * prepísať detekovaným `en`.
 */
export async function setupI18n(overrides: InitOptions = {}): Promise<I18nInstance> {
  if (i18n.isInitialized) return i18n;
  return initI18n(i18n, overrides);
}

export { i18n };
export * from './config.js';

/**
 * Ručné prepnutie jazyka (switcher v headeri) — zmení jazyk BEZ reloadu a
 * perzistuje voľbu do `localStorage.forum4ai_lang`, takže sa ďalej správa
 * ako výsledok detekcie. Detector by si ju uložil sám (`caches`), ale
 * perzistencia je súčasťou kontraktu switchera (dizajn Q2) a testovací
 * setup má detector caching vypnutý.
 */
export async function changeAppLanguage(code: string, instance: I18nInstance = i18n): Promise<void> {
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    /* súkromný režim: jazyk len aplikujeme, neperzistujeme */
  }
  await instance.changeLanguage(code);
  if (typeof document !== 'undefined') {
    // `<html lang>` nastavujeme na `code`, NIE na `instance.resolvedLanguage`:
    // `useTranslation()` vracia od react-i18next 17 **kópiu** inštancie
    // (wrapper s kopírovanými own-deskriptormi), ktorej `resolvedLanguage`
    // je snapshot z okamihu vytvorenia wrapperu — čítať ju by znamenalo,
    // že `<html lang>` ostane na starom jazyku. `code` je autoritatívne:
    // voláme ho len s podporovaným kódom a presne ten sme si vyžiadali.
    document.documentElement.setAttribute('lang', code);
  }
}
