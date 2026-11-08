/**
 * `t()` for NON-React modules (Phase 2a).
 *
 * React components use `useTranslation()` (react-i18n), which handles the
 * re-render when the language changes. Modules outside React —
 * `lib/write-codes.ts`, `lib/format.ts`, `nostr/signer.ts`, `api/client.ts`
 * — call this function; that is why they MUST keep text in a getter/function and
 * not in a module-scope constant, or it would freeze in the language of import.
 */
import { i18n } from './index.js';
import { DEFAULT_CONTENT_LANG, normalizeLangCode } from '../lib/lang.js';

/** preklad kľúča v aktuálnom jazyku (interpolation values bez pluralu) */
export function t(key: string, options?: Record<string, unknown>): string {
  // `i18n.t` má preťažený typ (plural / returnObjects / returnDetails);
  // bez týchto volieb vráti reťazec, tu to len nedokážeme vysledovať
  return String(i18n.t(key, options));
}

/** preklad s pluralom — `Intl.PluralRules` rozhodne `one`/`few`/`other` */
export function tp(key: string, count: number, options?: Record<string, unknown>): string {
  return String(i18n.t(key, { count, ...options }));
}

/**
 * Aktuálny jazyk rozhrania ako ISO-639-1 kód (F4AI-2b2).
 *
 * Používa sa na PUBLICHOVANIE: človek píše v jazyku, v ktorom mu je
 * rozhranie nastavené, a NIP-32 label musí byť dvojpísmenový kód. Preto
 * sa hodnota normalizuje (`sk-SK` → `sk` zlyhá → default), aby podpis
 * nikdy nevznikol s tagom, ktorý gateway odmietne (`LANG_INVALID`).
 * Volá sa VOLANE (nie module-scope), inak by sa jazyk zamrzol v čase importu.
 */
export function currentUiLang(): string {
  const raw = i18n.resolvedLanguage ?? i18n.language;
  return normalizeLangCode(raw) ?? DEFAULT_CONTENT_LANG;
}
