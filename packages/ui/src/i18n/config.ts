/**
 * i18n configuration (Phase 2a) — ONE place for which languages and namespaces
 * the app has and how the language is picked.
 *
 * Decisions (design Q2 in `claude-publish-answer.md`):
 *  - `en` is the DEFAULT and sits statically in the bundle (no request),
 *    `sk` is loaded on demand only (`i18next-resources-to-backend`
 *    + dynamic `import()` → Vite turns it into a separate lazy chunk),
 *  - `partialBundledLanguages: true` is what tells i18next that some
 *    languages live in the bundle and the rest come through the backend (without
 *    it the backend would not be called for bundled languages at all),
 *  - detection: `?lng=` → `localStorage.forum4ai_lang` → `navigator`,
 *    fallback `en`; `nonExplicitSupportedLngs` so that `sk-SK` falls back to `sk`,
 *  - no ICU plugin — JSON v4 plurals go through `Intl.PluralRules`
 *    (Slovak needs `one`/`few`/`other`, English needs `one`/`other`).
 */
import type { InitOptions } from 'i18next';
import type { DetectorOptions } from 'i18next-browser-languagedetector';

/** podporované jazyky — poradie určuje fallback reťazec */
export const SUPPORTED_LANGS = ['en', 'sk'] as const;
export type AppLang = (typeof SUPPORTED_LANGS)[number];

/** výchozí jazyk, keď používáč nič nenastavil a prehliadač nerozumieme */
export const DEFAULT_LANG: AppLang = 'en';

/** kľúč v `localStorage`, do ktorého detector píše voľbu jazyka */
export const LANGUAGE_STORAGE_KEY = 'forum4ai_lang';

/** namespacey — rozdelené podľa oblasti UI, nie podľa stránky */
export const NAMESPACES = ['common', 'forum', 'write', 'auth', 'admin', 'settings', 'register', 'paper'] as const;
export type AppNamespace = (typeof NAMESPACES)[number];

/** defaultný namespace (t() bez prefixu) */
export const DEFAULT_NAMESPACE: AppNamespace = 'common';

/**
 * Spoločné init options. `resources` sem nepatria — tie dodáva
 * `setupI18n` (app) alebo testovací setup, ktorý má oba jazyky inline.
 */
export const BASE_OPTIONS = {
  fallbackLng: DEFAULT_LANG,
  supportedLngs: [...SUPPORTED_LANGS],
  // 'sk-SK'/'en-GB' sa mapujú na podporované 'sk'/'en' (nie sú zamietnuté)
  nonExplicitSupportedLngs: true,
  load: 'languageOnly',
  defaultNS: DEFAULT_NAMESPACE,
  ns: [...NAMESPACES],
  // EN je v bundle, SK chýba → i18next si pre neho zavolá backend
  partialBundledLanguages: true,
  // React si own-uje escaping own, i18next tu nesmie double-escapovať
  interpolation: { escapeValue: false },
  // pri prepnutí na SK sa renderuje hneď (EN fallback) a text sa
  // prekreslí, keď dorazí chunk — bez Suspense hranice v strome
  react: { useSuspense: false },
} satisfies Partial<InitOptions>;

/** detector: query → localStorage → navigator (žiadny cookie, žiadny htmlTag read) */
export const DETECTOR_OPTIONS = {
  order: ['querystring', 'localStorage', 'navigator'],
  lookupQuerystring: 'lng',
  lookupLocalStorage: LANGUAGE_STORAGE_KEY,
  caches: ['localStorage'],
  excludeCacheFor: ['cimode'],
} satisfies DetectorOptions;
