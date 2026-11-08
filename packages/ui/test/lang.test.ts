/**
 * F4AI-2b2: parita lokálneho NIP-32 parsera UI so shared `languages.ts`.
 *
 * UI si drží vlastnú kópiu (runtime import zo shared by do bundlu ťahal
 * validátory), takže test je jediné miesto, kde sa zadrží rozjazd
 * správania. Porovnáva sa so shared pre VŠETKY kódy shared zoznamu —
 * nie po vzorkách.
 */
import { describe, expect, it } from 'vitest';

import {
  ISO_639_1,
  LANG_NAMESPACE as SHARED_NAMESPACE,
  LANG_NAMESPACE_TAG as SHARED_NAMESPACE_TAG,
  LANG_VALUE_TAG as SHARED_VALUE_TAG,
  langTags as sharedLangTags,
  parseContentLang,
} from '@forum4ai/shared';

import {
  DEFAULT_CONTENT_LANG,
  LANG_NAMESPACE,
  LANG_NAMESPACE_TAG,
  LANG_UNDETERMINED,
  LANG_VALUE_TAG,
  isOtherThan,
  itemLang,
  langBadgeText,
  langFilterParam,
  langTags,
  normalizeLangCode,
  readContentLang,
  shouldShowLangBadge,
} from '../src/lib/lang.js';

describe('konštanty UI vs shared (F4AI-2b2)', () => {
  it('tagy aj namespace sú zhodné so shared', () => {
    expect(LANG_NAMESPACE_TAG).toBe(SHARED_NAMESPACE_TAG);
    expect(LANG_VALUE_TAG).toBe(SHARED_VALUE_TAG);
    expect(LANG_NAMESPACE).toBe(SHARED_NAMESPACE);
    expect(DEFAULT_CONTENT_LANG).toBe('en');
  });

  it('kánonická dvojica tagov je presne konvencia 2b2', () => {
    expect(langTags('en')).toEqual([
      ['L', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ]);
    expect(langTags('sk')).toEqual([
      ['L', 'ISO-639-1'],
      ['l', 'sk', 'ISO-639-1'],
    ]);
    expect(langTags('english')).toEqual([]);
  });
});

describe('parita parsera so shared', () => {
  it('zhoda so shared pre každý kód shared zoznamu (kánonický tvar)', () => {
    for (const code of ISO_639_1) {
      const tags = langTags(code);
      expect(readContentLang(tags), `UI zlyhal na ${code}`).toBe(code);
      expect(parseContentLang(tags), `shared zlyhal na ${code}`).toBe(code);
    }
  });

  it('zhoda so shared pre kompaktný tvar ["L", kod, ISO-639-1]', () => {
    for (const code of ISO_639_1) {
      const compact: string[][] = [['L', code, 'ISO-639-1']];
      expect(readContentLang(compact), `UI zlyhal na ${code}`).toBe(code);
      expect(parseContentLang(compact), `shared zlyhal na ${code}`).toBe(code);
    }
  });

  it('UI produkuje rovnaké tagy ako shared', () => {
    for (const code of ISO_639_1) {
      expect(langTags(code), `tagy sa líšia na ${code}`).toEqual(sharedLangTags(code));
    }
  });

  it('cudzie namespacey ignorujú oba implementáče', () => {
    const foreign: string[][] = [
      ['L', 'com.example.ontology'],
      ['l', 'VI-hum', 'com.example.ontology'],
      ['l', 'sk', '#t'],
    ];
    expect(readContentLang(foreign)).toBeNull();
    expect(parseContentLang(foreign)).toBeNull();
  });

  it('namespace tag bez kódy nie je jazyk (oba)', () => {
    expect(readContentLang([['L', 'ISO-639-1']])).toBeNull();
    expect(parseContentLang([['L', 'ISO-639-1']])).toBeNull();
  });

  it('prvý platný tag vyhráva v oboch', () => {
    const tags: string[][] = [
      ['l', 'sk', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ];
    expect(readContentLang(tags)).toBe('sk');
    expect(parseContentLang(tags)).toBe('sk');
  });

  it('VEDOMÝ rozdiel: UI akceptuje tvar, shared vyžaduje zoznam', () => {
    // `qq` je well-formed dvojpísmenový kód, ale v shared zozname nie je.
    // Pri čítaní UI ukáže štítok (autor niečo deklaroval), shared vráti
    // null — a práve to je dôvod, prečo UI nemá zdieľať zoznam.
    expect(ISO_639_1).not.toContain('qq');
    expect(readContentLang([['l', 'qq', 'ISO-639-1']])).toBe('qq');
    expect(parseContentLang([['l', 'qq', 'ISO-639-1']])).toBeNull();
    // nezmyselný tvar (nie dve písmená) zamietnu oba
    expect(readContentLang([['l', 'eng', 'ISO-639-1']])).toBeNull();
    expect(parseContentLang([['l', 'eng', 'ISO-639-1']])).toBeNull();
  });

  it('normalizácia: veľké písmená a medzery, `en-US` nie je kód', () => {
    expect(normalizeLangCode('EN')).toBe('en');
    expect(normalizeLangCode('  sk ')).toBe('sk');
    expect(normalizeLangCode('en-US')).toBeNull();
    expect(normalizeLangCode(undefined)).toBeNull();
    expect(readContentLang([['l', 'SK', 'ISO-639-1']])).toBe('sk');
  });
});

describe('štítok a filter jazyka v UI', () => {
  it('text štítku: veľké písmeno, UND pre neoznačené', () => {
    expect(langBadgeText('sk')).toBe('SK');
    expect(langBadgeText('EN')).toBe('EN');
    expect(langBadgeText(null)).toBe(LANG_UNDETERMINED);
    expect(langBadgeText(undefined)).toBe(LANG_UNDETERMINED);
  });

  it('štítok sa ukáže pri cudzom jazyku aj pri neoznačenom obsahu', () => {
    expect(shouldShowLangBadge('sk', 'sk')).toBe(false);
    expect(shouldShowLangBadge('SK', 'sk')).toBe(false);
    expect(shouldShowLangBadge('en', 'sk')).toBe(true);
    expect(shouldShowLangBadge(null, 'sk')).toBe(true);
    expect(shouldShowLangBadge(undefined, 'sk')).toBe(true);
  });

  it('itemLang: `lang` z API má prednosť pred tagmi, chýbajúce pole padá na tagy', () => {
    expect(itemLang({ lang: 'sk' }, [['l', 'en', 'ISO-639-1']])).toBe('sk');
    expect(itemLang({ lang: null }, [['l', 'en', 'ISO-639-1']])).toBeNull();
    expect(itemLang({}, [['l', 'en', 'ISO-639-1']])).toBe('en');
    expect(itemLang(undefined, [])).toBeNull();
  });

  it('langFilterParam: all/other neposielajú parameter, ui posiela jazyk rozhrania', () => {
    expect(langFilterParam('all', 'sk')).toBeUndefined();
    expect(langFilterParam('other', 'sk')).toBeUndefined();
    expect(langFilterParam('ui', 'sk')).toBe('sk');
    expect(langFilterParam('en', 'sk')).toBe('en');
    expect(langFilterParam('english', 'sk')).toBeUndefined();
  });

  it('isOtherThan vylúči jazyk rozhrania a ponechá neoznačené aj cudzie', () => {
    expect(isOtherThan({ lang: 'sk' }, 'sk')).toBe(false);
    expect(isOtherThan({ lang: 'en' }, 'sk')).toBe(true);
    expect(isOtherThan({ lang: null }, 'sk')).toBe(true);
    expect(isOtherThan({}, 'sk')).toBe(true);
  });
});
