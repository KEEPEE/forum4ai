/**
 * F4AI-2b2: NIP-32 jazykové označenie obsahu — konvencia tagov, allowlist
 * ISO-639-1, pravidlo "prvý platný tag vyhráva" a odlíšenie NEPLATNÝ
 (gateway → 400) od NEOZNÁMENÝ (indexer → lang null).
 */
import { describe, expect, it } from 'vitest';

import {
  CONTENT_LANG_KINDS,
  DEFAULT_CONTENT_LANG,
  ISO_639_1,
  LANG_NAMESPACE,
  compactLangTag,
  isContentLangKind,
  isInvalidLangHit,
  isKnownLangCode,
  langTags,
  normalizeLangCode,
  parseContentLang,
  readContentLang,
} from '../src/index.js';
import type { NostrTag } from '../src/index.js';

describe('ISO-639-1 allowlist', () => {
  it('obsahuje našu dvojicu jazykov aj bežné cudzie kódy', () => {
    for (const code of ['en', 'sk', 'de', 'cs', 'hu', 'uk', 'zh', 'zu']) {
      expect(isKnownLangCode(code), `${code} by mal byť známy`).toBe(true);
    }
    expect(ISO_639_1.length).toBeGreaterThanOrEqual(180);
  });

  it('nepozná trojpísmenové kódy, zhluky ani empty', () => {
    for (const code of ['eng', 'xxx', 'cz', 'en-US', 'en_us', '', 'e', '12']) {
      expect(isKnownLangCode(code), `${code} by mal byť neznámy`).toBe(false);
    }
    expect(isKnownLangCode(undefined)).toBe(false);
    expect(isKnownLangCode(42)).toBe(false);
  });

  it('normalizuje veľkosť písmen a medzery, inak nič', () => {
    expect(normalizeLangCode('EN')).toBe('en');
    expect(normalizeLangCode(' Sk ')).toBe('sk');
    expect(normalizeLangCode('sk-419')).toBeNull();
    expect(normalizeLangCode(null)).toBeNull();
  });

  it('neobsahuje duplikáty ani neplatné tvary', () => {
    expect(new Set(ISO_639_1).size).toBe(ISO_639_1.length);
    for (const code of ISO_639_1) {
      expect(code).toMatch(/^[a-z]{2}$/);
    }
  });
});

describe('zápis tagov (konvencia)', () => {
  it('langTags vráti kánonickú dvojicu L namespace + l hodnota', () => {
    expect(langTags('en')).toEqual([
      ['L', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ]);
  });

  it('langTags normalizuje kód a pre neplatný vráti prázdny zoznam', () => {
    expect(langTags('SK')[1]).toEqual(['l', 'sk', 'ISO-639-1']);
    expect(langTags('english')).toEqual([]);
    expect(langTags('')).toEqual([]);
  });

  it('compactLangTag je jeden tag L s hodnotou aj namespace', () => {
    expect(compactLangTag('sk')).toEqual(['L', 'sk', 'ISO-639-1']);
    expect(compactLangTag('nope')).toBeNull();
  });

  it('default je en', () => {
    expect(DEFAULT_CONTENT_LANG).toBe('en');
  });
});

describe('čítanie jazyka z tagov', () => {
  it('prečíta kánonickú dvojicu', () => {
    const tags: NostrTag[] = [
      ['d', 'my-topic'],
      ['L', LANG_NAMESPACE],
      ['l', 'sk', LANG_NAMESPACE],
    ];
    expect(readContentLang(tags)).toEqual({ code: 'sk', tag: 'l', raw: 'sk' });
    expect(parseContentLang(tags)).toBe('sk');
  });

  it('prečíta aj kompaktný tvar ["L","sk","ISO-639-1"]', () => {
    const tags: NostrTag[] = [['L', 'sk', 'ISO-639-1']];
    expect(parseContentLang(tags)).toBe('sk');
  });

  it('prečíta l tag bez L namespace tagu (mark staci)', () => {
    expect(parseContentLang([['l', 'de', 'ISO-639-1']])).toBe('de');
  });

  it('prvý platný tag vyhráva', () => {
    const tags: NostrTag[] = [
      ['l', 'sk', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ];
    expect(parseContentLang(tags)).toBe('sk');
  });

  it('cudzie NIP-32 namespacey nie sú jazyk', () => {
    const tags: NostrTag[] = [
      ['L', 'com.example.ontology'],
      ['l', 'VI-hum', 'com.example.ontology'],
      ['L', '#t'],
      ['l', 'permies', '#t'],
    ];
    expect(parseContentLang(tags)).toBeNull();
    expect(readContentLang(tags)).toBeNull();
  });

  it('namespace tag bez hodnoty nie je jazyk (ani neplatný)', () => {
    const tags: NostrTag[] = [['L', 'ISO-639-1']];
    expect(readContentLang(tags)).toBeNull();
    expect(parseContentLang(tags)).toBeNull();
  });

  it('neplatný kód vráti invalid hit — gateway ho odmietne, indexer má null', () => {
    const tags: NostrTag[] = [['l', 'xx', 'ISO-639-1']];
    const hit = readContentLang(tags);
    expect(hit).not.toBeNull();
    expect(isInvalidLangHit(hit)).toBe(true);
    expect(hit?.raw).toBe('xx');
    expect(parseContentLang(tags)).toBeNull();
  });

  it('platný tag predností pred neplatným v tom istom evente', () => {
    const tags: NostrTag[] = [
      ['l', 'not-a-code', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ];
    const hit = readContentLang(tags);
    expect(isInvalidLangHit(hit)).toBe(false);
    expect(hit?.code).toBe('en');
    expect(parseContentLang(tags)).toBe('en');
  });

  it('olerne chýbajúce tags a nerovnake tagy', () => {
    expect(parseContentLang(undefined)).toBeNull();
    expect(parseContentLang([])).toBeNull();
    expect(parseContentLang([['l']] as NostrTag[])).toBeNull();
  });
});

describe('CONTENT_LANG_KINDS', () => {
  it('obsahuje obsahové kindy a žiadne infra', () => {
    // 30023 paper (Phase 4a, dizajn Q4) je obsahový kind — bez jazykového
    // labelu by sa paper nedal filtrovať (`GET /papers?lang=`) ani prekladať
    for (const kind of [1020, 1021, 1022, 1023, 1030, 1031, 1032, 10030, 30020, 30023]) {
      expect(isContentLangKind(kind), `kind ${kind} je obsahový`).toBe(true);
    }
    for (const kind of [0, 3, 1024, 1040, 1051, 10031, 30002, 30028, 27235]) {
      expect(isContentLangKind(kind), `kind ${kind} nie je obsahový`).toBe(false);
    }
    expect(CONTENT_LANG_KINDS.size).toBe(10);
  });
});
