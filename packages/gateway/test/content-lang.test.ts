/**
 * F4AI-2b2: jazyková politika obsahu — čisté unit testy (bez Hono app):
 * parsovanie env, verdikt `checkContentLang` a pripojenie tagu na draft.
 * Route správanie (400 kódy, odpoveď) cvičí `app.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { KINDS } from '@forum4ai/shared';

import {
  CONTENT_LANG_POLICY_DEFAULT,
  checkContentLang,
  contentLangPolicy,
  parseContentLangs,
  stampDraftLangTags,
} from '../src/content-lang.js';
import { resolveGatewayConfig } from '../src/config.js';

const EN_LABEL = [
  ['L', 'ISO-639-1'],
  ['l', 'en', 'ISO-639-1'],
];

describe('parseContentLangs / contentLangPolicy (GATEWAY_CONTENT_LANGS)', () => {
  it('nenastavená premenná = žiadne vynucovanie', () => {
    expect(parseContentLangs(undefined)).toEqual([]);
    expect(parseContentLangs('   ')).toEqual([]);
    expect(CONTENT_LANG_POLICY_DEFAULT.accepted).toEqual([]);
    expect(CONTENT_LANG_POLICY_DEFAULT.defaultLang).toBe('en');
  });

  it('csv normalizuje, deduplikuje a neznáme kódy zahodí', () => {
    expect(parseContentLangs('en,sk')).toEqual(['en', 'sk']);
    expect(parseContentLangs(' EN , sk ,en')).toEqual(['en', 'sk']);
    expect(parseContentLangs('english,xx,de')).toEqual(['de']);
    // všetko neznáme = prázdny zoznam = žiadne vynucovanie (zdokumentované)
    expect(parseContentLangs('english')).toEqual([]);
  });

  it('default jazyka: neznámy kód → fallback na en', () => {
    expect(contentLangPolicy('sk', undefined).defaultLang).toBe('sk');
    expect(contentLangPolicy('EN', undefined).defaultLang).toBe('en');
    expect(contentLangPolicy('slovencina', undefined).defaultLang).toBe('en');
    expect(contentLangPolicy(undefined, 'en,sk')).toEqual({
      defaultLang: 'en',
      accepted: ['en', 'sk'],
    });
  });

  it('resolveGatewayConfig má defaulty en + žiadne vynucovanie', () => {
    const config = resolveGatewayConfig({});
    expect(config.contentLang).toEqual({ defaultLang: 'en', accepted: [] });
    const forced = resolveGatewayConfig({
      GATEWAY_DEFAULT_CONTENT_LANG: 'sk',
      GATEWAY_CONTENT_LANGS: 'sk,en',
    });
    expect(forced.contentLang).toEqual({ defaultLang: 'sk', accepted: ['sk', 'en'] });
  });
});

describe('checkContentLang — verdikt pre jeden event', () => {
  it('neobsahové kindy sa vôbec neštítujú (applies false)', () => {
    for (const kind of [KINDS.PROFILE, KINDS.CONTACTS, KINDS.FOLLOWS, KINDS.AUTH_NIP98, KINDS.NODE_DIRECTORY]) {
      const verdict = checkContentLang({ kind, tags: [['l', 'xx', 'ISO-639-1']] });
      expect(verdict, `kind ${kind}`).toEqual({
        ok: true,
        applies: false,
        lang: 'en',
        declared: false,
      });
    }
  });

  it('obsahový event bez labelu → efektívny default, declared false', () => {
    expect(checkContentLang({ kind: KINDS.QUESTION, tags: [] })).toEqual({
      ok: true,
      applies: true,
      lang: 'en',
      declared: false,
    });
    expect(
      checkContentLang({ kind: KINDS.TOPIC, tags: [['d', 'slug']] }, { defaultLang: 'sk', accepted: [] }),
    ).toMatchObject({ lang: 'sk', declared: false });
  });

  it('kánonická dvojica aj kompaktný tvar sú deklarovaný jazyk', () => {
    expect(checkContentLang({ kind: KINDS.POST, tags: EN_LABEL })).toMatchObject({
      lang: 'en',
      declared: true,
    });
    expect(
      checkContentLang({ kind: KINDS.POST, tags: [['L', 'sk', 'ISO-639-1']] }),
    ).toMatchObject({ lang: 'sk', declared: true });
  });

  it('namespace tag bez hodnoty nie je deklarovaný jazyk', () => {
    expect(checkContentLang({ kind: KINDS.POST, tags: [['L', 'ISO-639-1']] })).toMatchObject({
      lang: 'en',
      declared: false,
    });
  });

  it('cudzie NIP-32 namespacey nerazia do jazykovej politiky', () => {
    const verdict = checkContentLang({
      kind: KINDS.POST,
      tags: [
        ['L', 'com.example.ontology'],
        ['l', 'VI-hum', 'com.example.ontology'],
      ],
    });
    expect(verdict).toMatchObject({ ok: true, declared: false, lang: 'en' });
  });

  it('neplatný kód → LANG_INVALID (l aj L tvar)', () => {
    const l = checkContentLang({ kind: KINDS.QUESTION, tags: [['l', 'xxx', 'ISO-639-1']] });
    expect(l.ok).toBe(false);
    expect(!l.ok && l.code).toBe('LANG_INVALID');
    const upper = checkContentLang({ kind: KINDS.QUESTION, tags: [['l', 'EN', 'ISO-639-1']] });
    expect(upper).toMatchObject({ ok: true, lang: 'en', declared: true });
    const compact = checkContentLang({ kind: KINDS.TOPIC, tags: [['L', 'de-DE', 'ISO-639-1']] });
    expect(!compact.ok && compact.code).toBe('LANG_INVALID');
  });

  it('vynucovanie: efektívny jazyk mimo zoznamu → LANG_NOT_ACCEPTED', () => {
    const policy = { defaultLang: 'en', accepted: ['en'] };
    const declared = checkContentLang({ kind: KINDS.QUESTION, tags: [['l', 'sk', 'ISO-639-1']] }, policy);
    expect(!declared.ok && declared.code).toBe('LANG_NOT_ACCEPTED');
    expect(!declared.ok && declared.reason).toContain('accepted: en');

    const undeclared = checkContentLang(
      { kind: KINDS.QUESTION, tags: [] },
      { defaultLang: 'en', accepted: ['sk'] },
    );
    expect(!undeclared.ok && undeclared.code).toBe('LANG_NOT_ACCEPTED');
    expect(!undeclared.ok && undeclared.reason).toContain('defaults to "en"');
  });

  it('prvý platný label vyhráva (zhodné s indexerom)', () => {
    const verdict = checkContentLang({
      kind: KINDS.QUESTION,
      tags: [
        ['l', 'sk', 'ISO-639-1'],
        ['l', 'en', 'ISO-639-1'],
      ],
    });
    expect(verdict).toMatchObject({ lang: 'sk', declared: true });
  });
});

describe('stampDraftLangTags — drafty (NEzapodpísaný tvar)', () => {
  it('pripojí default en, ak draft žiadny label nemá', () => {
    expect(stampDraftLangTags([['e', 'a'.repeat(64)]], 'en')).toEqual([['e', 'a'.repeat(64)], ...EN_LABEL]);
  });

  it('nepridá druhý label, ak už jeden klient poslal', () => {
    const tags = [['d', 'x'], ['l', 'sk', 'ISO-639-1']];
    expect(stampDraftLangTags(tags, 'en')).toEqual(tags);
  });

  it('neznámy kód nepridá nič (langTags vráti prázdny zoznam)', () => {
    expect(stampDraftLangTags([['d', 'x']], 'english')).toEqual([['d', 'x']]);
  });

  it('vráti kópiu — originál draft tagov sa nemutuje', () => {
    const tags = [['d', 'x']];
    const out = stampDraftLangTags(tags, 'en');
    expect(out.length).toBe(3);
    expect(tags).toEqual([['d', 'x']]);
  });
});
