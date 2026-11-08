/**
 * The language registry (F4AI-43) — one source of truth for what the app can
 * speak, checked from four directions:
 *
 *  1. SHAPE: every entry has a code, an endonym, an English name, a flag and a
 *     BCP-47 tag, and `Intl` accepts that tag (a typo would otherwise throw at
 *     the first formatted date in production),
 *  2. DERIVATION: `SUPPORTED_LANGS`, `AppLang` and the detector's supported list
 *     all come from the registry, so a component cannot drift from it,
 *  3. FILES: every registry code has a locale file for every namespace — an
 *     entry without `locales/<code>/` would offer a language that renders keys
 *     instead of text,
 *  4. NO SECOND LIST: no component names a language code by itself.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LANG,
  NAMESPACES,
  SUPPORTED_LANGS,
  SUPPORTED_LANGUAGES,
  intlLocaleFor,
  isSupportedLang,
  languageByCode,
} from '../src/i18n/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const localesRoot = join(packageRoot, 'src', 'locales');
const componentsRoot = join(packageRoot, 'src', 'components');

describe('SUPPORTED_LANGUAGES registry (F4AI-43)', () => {
  it('every entry is complete and its Intl locale is real', () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(1);
    for (const entry of SUPPORTED_LANGUAGES) {
      // ISO-639-1 shape: two lowercase letters = the locale directory name
      expect(entry.code).toMatch(/^[a-z]{2}$/);
      expect(entry.nativeName.trim()).not.toBe('');
      expect(entry.englishName.trim()).not.toBe('');
      // a flag emoji is a pair of regional-indicator code points
      expect(entry.flag).toMatch(/^[\u{1F1E6}-\u{1F1FF}]{2}$/u);
      // BCP-47 `language-REGION`, and the language part must be the code itself
      expect(entry.intlLocale).toMatch(new RegExp(`^${entry.code}-[A-Z]{2}$`));
      // a bad tag throws here, i.e. at the first formatted date in the UI
      expect(() => new Intl.DateTimeFormat(entry.intlLocale)).not.toThrow();
      expect(() => new Intl.NumberFormat(entry.intlLocale)).not.toThrow();
      expect(() => new Intl.PluralRules(entry.intlLocale)).not.toThrow();
    }
  });

  it('codes are unique, en is first and the default is in the registry', () => {
    const codes = SUPPORTED_LANGUAGES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes[0]).toBe('en');
    expect(codes).toContain(DEFAULT_LANG);
    expect(SUPPORTED_LANGS).toEqual(codes);
  });

  it('the lookup helpers agree with the registry', () => {
    for (const entry of SUPPORTED_LANGUAGES) {
      expect(languageByCode(entry.code)).toBe(entry);
      expect(isSupportedLang(entry.code)).toBe(true);
      expect(intlLocaleFor(entry.code)).toBe(entry.intlLocale);
    }
    // the detector hands us `sk-SK`/`DE` shapes — normalised, never invented
    expect(languageByCode('DE')).toBe(languageByCode('de'));
    expect(languageByCode(' de ')).toBe(languageByCode('de'));
    expect(languageByCode('cs')).toBeNull();
    expect(isSupportedLang('cs')).toBe(false);
    expect(isSupportedLang(undefined)).toBe(false);
    // unknown code → the locale of the default language, never a throw
    expect(intlLocaleFor('cs')).toBe(intlLocaleFor(DEFAULT_LANG));
    expect(intlLocaleFor(undefined)).toBe('en-GB');
  });

  it('every registry code has a locale file for every namespace', () => {
    for (const entry of SUPPORTED_LANGUAGES) {
      for (const ns of NAMESPACES) {
        const file = join(localesRoot, entry.code, `${ns}.json`);
        expect(existsSync(file), `chýba locales/${entry.code}/${ns}.json`).toBe(true);
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        expect(parsed, `${entry.code}/${ns}.json is not an object`).toBeTypeOf('object');
      }
    }
    // and the other way round: a locale directory nobody offers is dead weight
    const onDisk = readdirSync(localesRoot).sort();
    expect(onDisk).toEqual([...SUPPORTED_LANGS].sort());
  });

  it('no component lists languages by itself', () => {
    // the registry is the only place a code is written down; a component that
    // spells one out has re-invented the list F4AI-43 removed
    for (const file of readdirSync(componentsRoot)) {
      const source = readFileSync(join(componentsRoot, file), 'utf8');
      expect(source, `${file} names a language code`).not.toMatch(/['"](en|sk|de)['"]\s*[,\]]/);
    }
  });
});
