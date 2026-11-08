/**
 * F4AI-2b2: NIP-32 jazykové označenie obsahu v UI.
 *
 * UI si drží VLASTNÚ kópiu parsera (rovnako ako `KIND_LABELS` v
 * `format.ts`): runtime import zo `@forum4ai/shared` by do bundlu ťahal
 * validátory a 184-položkový zoznam kódov — UI pritom potrebuje len
 * prečítať tagy a pripojiť ich pri zápise. Paritu viaže test
 * `test/lang.test.ts`, ktorý porovnáva správanie so shared funkciami.
 *
 * Vedomé rozdiely oproti shared (test ich strážia, aby neperzovali):
 *  1. UI akceptuje hociktorný dvojpísmenový kód (TVAR ISO-639-1), shared
 *     overuje aj prítomnosť v zozname. Dôvod: pri ČÍTANÍ ukazuje štítok to,
 *     čo autor deklaroval — zoznam platí pri ZÁPISE (gateway tam vráti
 *     `LANG_INVALID`). Ak by UI krátil podľa zoznamu, cudzím eventom by
 *     zmizol štítok práve preto, že ich nikto nepozná.
 *  2. UI nerozlišuje platný × neplatný label (`LANG_INVALID` rieši
 *     gateway); neznámy tvar = `null` = žiadny štítok.
 *
 * Konvencia, ktorou PUBLIKUJEME (kánonický tvar z NIP-32, self-reporting
 * na obsahovom evente — samostatný label event 1985 neposielame):
 *
 *     ["L", "ISO-639-1"], ["l", "en", "ISO-639-1"]
 *
 * Kompaktný tvar `["L", "en", "ISO-639-1"]` naopak ČÍTAME (niektorí klienti
 * ho posielajú), len ho nepoužívame pri zápise.
 */

import type { NostrTag } from '@forum4ai/shared';

export const LANG_NAMESPACE_TAG = 'L';
export const LANG_VALUE_TAG = 'l';
export const LANG_NAMESPACE = 'ISO-639-1';
/** default jazyk obsahu inštancie — zhodné so `GATEWAY_DEFAULT_CONTENT_LANG` */
export const DEFAULT_CONTENT_LANG = 'en';
/** text štítku pre event bez labelu (ISO 639-3 "und" = undetermined) */
export const LANG_UNDETERMINED = 'UND';

/** tvar ISO-639-1: práve dve malé písmená (veľkosť sa normalizuje) */
const CODE_SHAPE = /^[a-z]{2}$/;

/** Normalizuje surovú hodnotu na kód, alebo `null` (`EN` → `en`, `en-US` → null). */
export function normalizeLangCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return CODE_SHAPE.test(trimmed) ? trimmed : null;
}

/**
 * Kánonická dvojica tagov pre jazyk — to, čo UI pripája pri zápise.
 * Neplatný kód vráti prázdny zoznam, aby sa nikde neobjavil tag s nezmyslom.
 *
 * Návratkový typ je `NostrTag[]` (type-only import zo shared), aby ho
 * `buildReplyTags`/`buildQuestionTags` mohli pushnúť bez castu.
 */
export function langTags(code: string): NostrTag[] {
  const normalized = normalizeLangCode(code);
  if (normalized === null) return [];
  return [
    [LANG_NAMESPACE_TAG, LANG_NAMESPACE],
    [LANG_VALUE_TAG, normalized, LANG_NAMESPACE],
  ];
}

/**
 * Jazyk z tagov eventu: prvý platný jazykový tag vyhráva, neoznačený aj
 * neznámy tvar → `null`. Rešpektuje pritom namespace — `l`/`L` tag v
 * cudzom namespace (`#t`, `com.example.ontology`) nie je jazyk.
 */
export function readContentLang(tags: string[][] | undefined): string | null {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (!Array.isArray(tag)) continue;
    const name = tag[0];
    if (name === LANG_VALUE_TAG) {
      if (tag[2] !== LANG_NAMESPACE) continue;
      const code = normalizeLangCode(tag[1]);
      if (code !== null) return code;
      continue;
    }
    if (name === LANG_NAMESPACE_TAG) {
      // kánonický namespace tag neobsahuje kód
      if (tag[1] === LANG_NAMESPACE) continue;
      // kompaktný tvar ["L", "<kod>", "ISO-639-1"]
      if (tag[2] === LANG_NAMESPACE) {
        const code = normalizeLangCode(tag[1]);
        if (code !== null) return code;
      }
    }
  }
  return null;
}

/**
 * Jazyk, v ktorom event JE (index ho má v `lang`, thread to má v tagoch).
 * `undefined` = gateway jazyk nehlásil (starý index bez `lang` stĺpca) —
 * volajúci to líši od `null` (= event bol oznámený ako neoznačený).
 */
export function itemLang(item: { lang?: string | null } | undefined, tags?: string[][]): string | null {
  if (item !== undefined && item.lang !== undefined) {
    return item.lang === null ? null : normalizeLangCode(item.lang);
  }
  return readContentLang(tags);
}

/** Text štítku: veľké písmeno kódu, `UND` pre neoznačený obsah. */
export function langBadgeText(lang: string | null | undefined): string {
  const code = lang === null || lang === undefined ? null : normalizeLangCode(lang);
  return code === null ? LANG_UNDETERMINED : code.toUpperCase();
}

/**
 * Pravidlo štítku: cudzí jazyk (≠ jazyk rozhrania) AJ neoznačený obsah.
 * Naopak — rovnaký jazyk ako rozhranie sa neštítku, lebo to je pre
 * čitateľa predvolený stav a štítok by len šumel.
 *
 * `null` × `undefined` tu LÍŠIA význam, ale nie výsledok: `null` says
 * "event nebol označený" (štítok UND), `undefined` says "gateway to
 * nehlásil" (index pred 2b2). Volajúci MUSÍ `undefined` ošetriť pred
 * volaním, ak chce ten rozdiel rešpektovať — `SearchPage` to robí
 * (neoznačený výsledok má UND, výsledok bez poľa `lang` nemá štítok),
 * `EventCard` jazyk vždy pozná z tagov, takže mu to nevadí.
 */
export function shouldShowLangBadge(lang: string | null | undefined, uiLang: string): boolean {
  const normalized = lang === null || lang === undefined ? null : normalizeLangCode(lang);
  const ui = normalizeLangCode(uiLang);
  return normalized !== ui;
}

/**
 * Filter "ostatné jazyky" na vyhľadávacej stránke.
 *
 * Gateway pozná len kladný filter `lang=<kod>` alebo `lang=any` — negáciu
 * (`lang!=sk`) REST nemá. Preto `other` znamená: nechaj server, nech
 * vracia všetky jazyky (`any`), a vylúč jazyk rozhrania v prehliadači.
 * Výsledok je poctivo označený poznámkou, že ide o lokálne triedenie.
 */
export type LangFilter = 'all' | 'ui' | 'other' | string;

/** query parameter pre `GET /search` (`undefined` = parameter sa nepošle) */
export function langFilterParam(filter: LangFilter, uiLang: string): string | undefined {
  if (filter === 'all' || filter === 'other') return undefined;
  if (filter === 'ui') return normalizeLangCode(uiLang) ?? DEFAULT_CONTENT_LANG;
  return normalizeLangCode(filter) ?? undefined;
}

/** Lokálne vylúčenie jazyka rozhrania pre filter `other`. */
export function isOtherThan<T extends { lang?: string | null }>(item: T, uiLang: string): boolean {
  return item.lang !== normalizeLangCode(uiLang);
}
