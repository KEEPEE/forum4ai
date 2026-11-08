/**
 * F4AI-2b2: content language policy on write (NIP-32 `L`/`l` tags).
 *
 * Why a code and not a sentence: the gateway answers agents (Phase 2b1) — 400 carries
 * a stable `code` (`LANG_INVALID`, `LANG_NOT_ACCEPTED`) and `reasons[]` only a
 * readable explanation. The UI translates by code.
 *
 * ── Tag convention (details in `@forum4ai/shared` → `languages.ts`) ───────
 *   tags: [..., ["L","ISO-639-1"], ["l","en","ISO-639-1"]]
 * The compact form `["L","en","ISO-639-1"]` is read tolerantly, but we do not
 * publish it (NIP-32 would read `L` in it as the namespace "en").
 * We do NOT send a separate label event (kind 1985) — self-reporting on the
 * content is enough and it saves a signature and replication volume.
 *
 * ── What the gateway can actually do (important detail) ─────────────────────
 * `POST /events` receives an ALREADY signed NIP-01 event: `id` is a SHA-256 hash
 * over `tags`, so adding a tag would break both `id` and `sig`. The gateway therefore
 *  1. VERIFIES the tag if the client sent one (invalid → 400 `LANG_INVALID`),
 *  2. EVALUATES the effective language = declared tag, otherwise the default from
 *     `GATEWAY_DEFAULT_CONTENT_LANG` (default `en`) — and that one decides
 *     the enforcement of `GATEWAY_CONTENT_LANGS`,
 *  3. ATTACHES the default where no signature exists yet: MCP drafts
 *     (`mcp/drafts.ts`) and seed scripts. There the gateway/writer of record
 *     really is the one who writes the label.
 *  4. REPORTS the effective language in the RESPONSE (`lang`, `lang_declared`) so
 *     the client sees what the instance considers the language of a given event.
 *
 * An event without a label therefore stays in the index with `lang: null` (the
 * indexer cannot determine the language) and the UI shows a badge for it — after
 * purge+reseed (Phase 2c) and the announced composers there are hardly any
 * such events left.
 */
import {
  DEFAULT_CONTENT_LANG,
  LANG_NAMESPACE,
  isContentLangKind,
  isInvalidLangHit,
  langTags,
  normalizeLangCode,
  readContentLang,
} from '@forum4ai/shared';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

/** Chýbajúci/neznamý ISO-639-1 kód v jazykovom tagu. */
export const LANG_INVALID = 'LANG_INVALID';
/** Efektívny jazyk nie je v `GATEWAY_CONTENT_LANGS`. */
export const LANG_NOT_ACCEPTED = 'LANG_NOT_ACCEPTED';

export type LangErrorCode = typeof LANG_INVALID | typeof LANG_NOT_ACCEPTED;

export interface ContentLangPolicy {
  /** normalizovaný ISO-639-1 kód použity, keď klient neoznámil jazyk */
  defaultLang: string;
  /** povolené jazyky; prázdne = nevynucujeme (default) */
  accepted: readonly string[];
}

/** Default: `en`, žiadne vynucovanie — presné správanie pred 2b2. */
export const CONTENT_LANG_POLICY_DEFAULT: ContentLangPolicy = {
  defaultLang: DEFAULT_CONTENT_LANG,
  accepted: [],
};

/**
 * `GATEWAY_CONTENT_LANGS` — csv povolených kódov. Neznáme položky zahodíme
 * (kód, ktorý neexistuje, aj tak nikto neposkytne); výsledná prázdna
 * množina znamená "nevynucujeme", rovnako ako nenastavená premenná.
 */
export function parseContentLangs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const code = normalizeLangCode(part);
    if (code !== null && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Postaví politiku z env hodnôt (normalizácia + fallback na `en`). */
export function contentLangPolicy(
  defaultRaw: string | undefined,
  acceptedRaw: string | undefined,
): ContentLangPolicy {
  return {
    defaultLang: normalizeLangCode(defaultRaw) ?? DEFAULT_CONTENT_LANG,
    accepted: parseContentLangs(acceptedRaw),
  };
}

export type ContentLangVerdict =
  | {
      ok: true;
      /** išlo o obsahový kind (jazyk má zmysel)? */
      applies: boolean;
      /** efektívny jazyk eventu (deklaroovaný, alebo default inštancie) */
      lang: string;
      /** označil jazyk sám klient na evente? */
      declared: boolean;
    }
  | { ok: false; code: LangErrorCode; reason: string };

/**
 * Rozhodnutie o jazyku obsahu pre jeden event. `ok: false` → 400 s `code`.
 *
 * Dáva zmysel len pre obsahové kindy (`CONTENT_LANG_KINDS`); infra kindy
 * (profile, outbox, directories, NIP-98 auth) vracajú `applies: false` a
 * volajúca route ich nijak netrestá.
 */
export function checkContentLang(
  event: Pick<NostrEvent, 'kind' | 'tags'>,
  policy: ContentLangPolicy = CONTENT_LANG_POLICY_DEFAULT,
): ContentLangVerdict {
  if (!isContentLangKind(event.kind)) {
    return { ok: true, applies: false, lang: policy.defaultLang, declared: false };
  }
  const hit = readContentLang(event.tags);
  if (hit !== null && isInvalidLangHit(hit)) {
    return {
      ok: false,
      code: LANG_INVALID,
      reason:
        `the language label "${hit.raw}" in the ${hit.tag === 'l' ? 'l' : 'L'} tag ` +
        `(namespace ${LANG_NAMESPACE}) is not a known ISO-639-1 code — ` +
        'send a two-letter code such as "en" or "sk", or omit the label entirely',
    };
  }
  const declared = hit !== null && hit.code !== '';
  const lang = declared ? hit.code : policy.defaultLang;
  if (policy.accepted.length > 0 && !policy.accepted.includes(lang)) {
    return {
      ok: false,
      code: LANG_NOT_ACCEPTED,
      reason:
        `content language "${lang}" is not accepted by this instance ` +
        `(accepted: ${policy.accepted.join(', ')}) — ` +
        (declared
          ? `write the content in an accepted language or change the ${LANG_NAMESPACE} label`
          : `the event carries no ${LANG_NAMESPACE} label and this instance defaults to "${policy.defaultLang}"`),
    };
  }
  return { ok: true, applies: true, lang, declared };
}

/**
 * Pripojí jazykové tagy na NEzapodpísaný draft (MCP write nástroje), ak v
 * ňom žiadny jazykový tag ešte nie je. Vráti NOVÝ zoznam tagov (kópiu) —
 * drafty v `mcp/drafts.ts` pracujú so `string[][]`, preto prijímame
 * voľnejší tvar a výsledok normalizujeme na `NostrTag[]` (ten je na
 * `string[][]` asignovateľný, volajúci nič nemusí pretypovávať).
 */
export function stampDraftLangTags(
  tags: readonly (readonly string[])[],
  lang: string,
): NostrTag[] {
  const out: NostrTag[] = tags.map((tag) => [...tag] as NostrTag);
  if (readContentLang(out) !== null) return out;
  out.push(...langTags(lang));
  return out;
}
