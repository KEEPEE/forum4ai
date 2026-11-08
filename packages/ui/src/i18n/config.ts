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
 *    (Slovak needs `one`/`few`/`other`, German and English need `one`/`other`),
 *  - F4AI-43: `SUPPORTED_LANGUAGES` is the ONE registry of interface languages.
 *    A component never lists languages itself — it maps over the registry, so
 *    adding a language is one entry here + one `locales/<code>/` directory.
 */
import type { InitOptions } from 'i18next';
import type { DetectorOptions } from 'i18next-browser-languagedetector';

/**
 * One interface language, everything a menu or a formatter needs to know
 * about it (F4AI-43).
 */
export interface LanguageDescriptor {
  /** i18next code = the locale directory name (`locales/<code>/`) */
  readonly code: string;
  /**
   * The name in its own language (endonym). Deliberately NOT an i18n key: a
   * language menu lists languages under the name their speakers recognise, so
   * "Deutsch" must read "Deutsch" in an English menu too.
   */
  readonly nativeName: string;
  /** English name — what a screen reader set to English can pronounce */
  readonly englishName: string;
  /** flag emoji, decorative only (rendered `aria-hidden`) */
  readonly flag: string;
  /** BCP-47 tag for `Intl` date/number formatting (`de` → `de-DE`) */
  readonly intlLocale: string;
}

/**
 * The registry — the order is also the fallback chain (`en` first). Adding a
 * fourth language: append the entry, add `locales/<code>/*.json`, done.
 *
 * Two limits worth knowing before adding one (F4AI-43 review):
 *  - the detector runs with `load: 'languageOnly'`, so a region-carrying code
 *    (`pt-BR`) is not addressable — register the LANGUAGE (`pt`) and keep the
 *    region in `intlLocale`, which is only what `Intl` formats with;
 *  - `flag` is an emoji and Windows draws no flag glyphs at all, so the flag is
 *    decoration (`aria-hidden`) — the code and the endonym carry the meaning.
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', nativeName: 'English', englishName: 'English', flag: '🇬🇧', intlLocale: 'en-GB' },
  { code: 'sk', nativeName: 'slovenčina', englishName: 'Slovak', flag: '🇸🇰', intlLocale: 'sk-SK' },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German', flag: '🇩🇪', intlLocale: 'de-DE' },
] as const satisfies readonly LanguageDescriptor[];

export type AppLang = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/** podporované jazyky — odvodené z registry (jeden zdroj pravdy, F4AI-43) */
export const SUPPORTED_LANGS: readonly AppLang[] = SUPPORTED_LANGUAGES.map((entry) => entry.code);

/** registry entry for a code; `null` for an unsupported one */
export function languageByCode(code: unknown): LanguageDescriptor | null {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toLowerCase();
  return SUPPORTED_LANGUAGES.find((entry) => entry.code === normalized) ?? null;
}

/** is this a supported interface language? */
export function isSupportedLang(code: unknown): code is AppLang {
  return languageByCode(code) !== null;
}

/**
 * BCP-47 tag for `Intl` formatting in the UI language (`de` → `de-DE`).
 * Unknown code → the locale of the default language; `Intl` never throws.
 */
export function intlLocaleFor(code: unknown): string {
  return languageByCode(code)?.intlLocale ?? languageByCode(DEFAULT_LANG)?.intlLocale ?? 'en-GB';
}

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
