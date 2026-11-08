/**
 * NIP-32 content language tagging (F4AI-2b2).
 *
 * ── Convention (approved decision of the "publish-ready" campaign) ─────────────
 * A content event carries its language as **self-reporting** NIP-32 tags right
 * on itself — we send no separate label event (kind 1985), which saves one
 * event+signature per content item and readers (other clients included) have
 * the language immediately available:
 *
 *   tags: [ ..., ["L", "ISO-639-1"], ["l", "en", "ISO-639-1"] ]
 *
 * `L` is the namespace (NIP-32: "L tag SHOULD use a well-defined namespace such
 * as an ISO standard"), `l` is the value tagged with `mark`, which must equal
 * the `L` tag value in the same event. Verified directly in the NIP-32 text
 * (github.com/nostr-protocol/nips/blob/master/32.md).
 *
 * The parser tolerantly accepts the **compact form** `["L", "en", "ISO-639-1"]`
 * (value + namespace in one tag) used by the campaign brief — but we publish
 * the canonical `L` + `l` pair, because it is NIP-32-compatible and by itself
 * says what language the content is in.
 *
 * Reading rules (indexer, gateway, UI — one source of truth):
 *  - the language is taken from the first **valid** language tag (order in the event),
 *  - valid = a 2-letter ISO-639-1 code from the `ISO_639_1` allowlist
 *    (letter case is ignored, we normalize to lowercase),
 *  - the namespace must be `ISO-639-1` — otherwise the tag is not a language
 *    tag (e.g. `["L", "com.example.ontology"]` is a foreign ontology),
 *  - none or invalid → `null` (language not tagged).
 *
 * Writing rules (the gateway is the writer of record):
 *  - client sent a language tag → check it (invalid = 400 `LANG_INVALID`),
 *  - client sent nothing → the effective language is the default from
 *    `GATEWAY_DEFAULT_CONTENT_LANG` (default `en`); the gateway actually
 *    attaches it where the event is not yet signed (MCP drafts, seed),
 *    because a tag cannot be added to a signed NIP-01 event without breaking
 *    `id`/`sig` — there it only reports the effective language in the response,
 *  - `GATEWAY_CONTENT_LANGS` (default off) → effective language outside the
 *    list = 400 `LANG_NOT_ACCEPTED`.
 */
import type { NostrTag } from './types.js';

/** NIP-32 namespace tag (skratka). */
export const LANG_NAMESPACE_TAG = 'L';
/** NIP-32 label tag (skratka). */
export const LANG_VALUE_TAG = 'l';
/** Namespace, ktorý používame pre jazyk obsahu. */
export const LANG_NAMESPACE = 'ISO-639-1';
/** Default jazyk obsahu, ak si klient nevyberie (GATEWAY_DEFAULT_CONTENT_LANG). */
export const DEFAULT_CONTENT_LANG = 'en';

/**
 * Allowlist známych ISO-639-1 kódov (plná sada 184 kódov normy).
 * Držíme ju ako `Set` — kontrola je O(1) a beží pri každom zapísanom evente.
 * `bh`, `iw`/`he`, `in`/`id`, `ji`/`yi`, `mo`/`ro` sú deprecated/alternatívne
 * varianty, ktoré norma naďalej uvádza; prijímame ich, aby cudzie eventy
 * neskončili s `lang: null` zbytočne.
 */
export const ISO_639_1: readonly string[] = [
  'aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az',
  'ba', 'be', 'bg', 'bh', 'bi', 'bm', 'bn', 'bo', 'br', 'bs', 'ca', 'ce',
  'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy', 'da', 'de', 'dv', 'dz', 'ee',
  'el', 'en', 'eo', 'es', 'et', 'eu', 'fa', 'ff', 'fi', 'fj', 'fo', 'fr',
  'fy', 'ga', 'gd', 'gl', 'gn', 'gu', 'gv', 'ha', 'he', 'hi', 'ho', 'hr',
  'ht', 'hu', 'hy', 'hz', 'ia', 'id', 'ie', 'ig', 'ii', 'ik', 'io', 'is',
  'it', 'iu', 'ja', 'jv', 'ka', 'kg', 'ki', 'kj', 'kk', 'kl', 'km', 'kn',
  'ko', 'kr', 'ks', 'ku', 'kv', 'kw', 'ky', 'la', 'lb', 'lg', 'li', 'ln',
  'lo', 'lt', 'lu', 'lv', 'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms',
  'mt', 'my', 'na', 'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv',
  'ny', 'oc', 'oj', 'om', 'or', 'os', 'pa', 'pi', 'pl', 'ps', 'pt', 'qu',
  'rm', 'rn', 'ro', 'ru', 'rw', 'sa', 'sc', 'sd', 'se', 'sg', 'si', 'sk',
  'sl', 'sm', 'sn', 'so', 'sq', 'sr', 'ss', 'st', 'su', 'sv', 'sw', 'ta',
  'te', 'tg', 'th', 'ti', 'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt', 'tw',
  'ty', 'ug', 'uk', 'ur', 'uz', 've', 'vi', 'vo', 'wa', 'wo', 'xh', 'yi',
  'yo', 'za', 'zh', 'zu',
];

const ISO_639_1_SET = new Set<string>(ISO_639_1);

/** Je `code` známy ISO-639-1 kód? (porovnáva sa case-insensitívne) */
export function isKnownLangCode(code: unknown): code is string {
  return typeof code === 'string' && ISO_639_1_SET.has(code.trim().toLowerCase());
}

/**
 * Normalizuje surovú hodnotu na ISO-639-1 kód, alebo `null`.
 * Veľkosť písmen sa ignoruje (ISO kódy sú lowercase), medzery okolo hodnoty
 * tiež — `EN` a ` en ` sú `en`. `en-US` nie je ISO-639-1 → `null`.
 */
export function normalizeLangCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return ISO_639_1_SET.has(trimmed) ? trimmed : null;
}

/**
 * Kánonická dvojica tagov pre jazyk `code` — to, čo publikujeme (seed,
 * drafty, composer). `code` musí byť ISO-639-1; inak vrátime prázdny
 * zoznam, aby volajúci nepridal tag s nezmyslom.
 */
export function langTags(code: string): NostrTag[] {
  const normalized = normalizeLangCode(code);
  if (normalized === null) return [];
  return [
    [LANG_NAMESPACE_TAG, LANG_NAMESPACE],
    [LANG_VALUE_TAG, normalized, LANG_NAMESPACE],
  ];
}

/** Kompaktný tvar (jeden tag): `["L", "<code>", "ISO-639-1"]`. */
export function compactLangTag(code: string): NostrTag | null {
  const normalized = normalizeLangCode(code);
  return normalized === null ? null : [LANG_NAMESPACE_TAG, normalized, LANG_NAMESPACE];
}

/** Nájdený jazykový tag: normalizovaný kód + skutočná hodnota z eventu. */
export interface LangTagHit {
  /** normalizovaný ISO-639-1 kód (lowercase) */
  code: string;
  /** skratka tagu, z ktorej sme čítali (`l` alebo `L`) */
  tag: string;
  /** surová hodnota z eventu (pred normalizáciou) */
  raw: string;
}

/**
 * Prečíta jazyk z tagov eventu. Prvý **platný** jazykový tag vyhráva;
 * neplatný (kód mimo ISO-639-1) sa vráti ako `invalid`, aby ho gateway
 * mohol odmietnuť (`LANG_INVALID`) — indexer z neho má `lang: null`.
 *
 * `invalid` je prvá nájdená jazyková hodnota, ktorú nepoznáme; ak je
 * v evente platný tag aj neplatný, platný vyhráva (nedáme 400 pre
 * event, ktorého jazyk vieme).
 *
 * Parameter je ŠIRŠÍ ako `NostrTag[]` (ľubovoľné pole reťazcových polí):
 * čitatelia dostávajú tagy z JSONu (`string[][]` z REST `GET /recent`,
 * z `tags_json` v indexeri) a oddeňovať ich na tuple len preto, aby
 * prešiel typ, by znamenalo cast na každom volaní. Implementácia si
 * overí tvar za behu (`Array.isArray` na tag).
 */
export function readContentLang(
  tags: readonly (readonly string[])[] | undefined,
): LangTagHit | null {
  if (!Array.isArray(tags)) return null;
  let invalid: LangTagHit | null = null;
  for (const tag of tags) {
    if (!Array.isArray(tag)) continue;
    const name = tag[0];
    if (name === LANG_VALUE_TAG) {
      // ["l", "<code>", "ISO-639-1"] — hodnota s markom na náš namespace
      if (tag[2] !== LANG_NAMESPACE) continue;
      const hit = classify(tag[1], LANG_VALUE_TAG);
      if (hit !== null) return hit;
      invalid ??= { code: '', tag: LANG_VALUE_TAG, raw: String(tag[1] ?? '') };
      continue;
    }
    if (name === LANG_NAMESPACE_TAG) {
      // kanonický namespace tag ["L", "ISO-639-1"] neobsahuje kód
      if (tag[1] === LANG_NAMESPACE) continue;
      // kompaktný tvar ["L", "<code>", "ISO-639-1"]
      if (tag[2] === LANG_NAMESPACE) {
        const hit = classify(tag[1], LANG_NAMESPACE_TAG);
        if (hit !== null) return hit;
        invalid ??= { code: '', tag: LANG_NAMESPACE_TAG, raw: String(tag[1] ?? '') };
      }
    }
  }
  return invalid;
}

/** Je nájdený tag neplatný (hodnota mimo ISO-639-1)? */
export function isInvalidLangHit(hit: LangTagHit | null): boolean {
  return hit !== null && hit.code === '';
}

function classify(value: unknown, tagName: string): LangTagHit | null {
  const code = normalizeLangCode(value);
  if (code === null) return null;
  return { code, tag: tagName, raw: typeof value === 'string' ? value : '' };
}

/**
 * Jazyk obsahu pre indexovanie/UI: normalizovaný kód, alebo `null`
 * (neoznačené aj neplatné — to je rozdiel oproti gatewayu, ktorý
 * neplatné odmieta už pri zápise).
 */
export function parseContentLang(
  tags: readonly (readonly string[])[] | undefined,
): string | null {
  const hit = readContentLang(tags);
  return hit !== null && hit.code !== '' ? hit.code : null;
}
