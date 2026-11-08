/**
 * Typy NIP-01 eventov podľa schémy forum4ai
 * (wiki4ai forum4Ai → "Datovy model a synchronizacia").
 */

/** Tag NIP-01: prvý prvok je skratka tagu, ďalšie ľubovoľné reťazce. */
export type NostrTag = [tag: string, ...values: string[]];

/** Kánonický NIP-01 event — práve 7 polí, žiadne navyše (id sa počíta z 5). */
export interface NostrEvent {
  /** hex SHA-256 serializácie [0, pubkey, created_at, kind, tags, content] */
  id: string;
  /** hex x-only secp256k1 verejný kľúč autora (32 B, 64 hex znakov) */
  pubkey: string;
  /** Unix čas v sekundách (hodiny autora) */
  created_at: number;
  kind: number;
  tags: NostrTag[];
  content: string;
  /** hex BIP-340 Schnorr podpis nad id (64 B, 128 hex znakov) */
  sig: string;
}

/** Event bez id/sig pred podpísaním (finalizeEvent v nostr-tools). */
export type UnsignedNostrEvent = Omit<NostrEvent, 'id' | 'pubkey' | 'sig'> & {
  pubkey?: string;
};

/** Marker referencie v `e`/`a` tagu (NIP-10). */
export type ReferenceMarker = 'root' | 'parent' | 'mention';

/**
 * Stabilný strojový kód chyby validátora (F4AI-2b2).
 *
 * `errors[]` je človečiteľná veta (English, Phase 2b1) a mení sa, keď sa
 * text zlepšuje — kto na nej visuje typom, ten sa rozbije. `codes[]` je
 * kontrakt: ostatné balíky (indexer `ingest.ts`) a UI rozlišujú príčinu
 * podľa kódu, nie podľa vety. Kódy sú additive — pribudnúť smie nový kód,
 * nikdy sa nemení význam existujúceho, a `VALIDATION_ERROR` je fallback
 * pre chybu bez špecifickejšieho kódu.
 */
export type ValidationCode =
  | 'VALIDATION_ERROR'
  // kind politika
  | 'KIND_INVALID'
  | 'KIND_NOT_REGISTERED'
  // post (1023) root marker
  | 'POST_ROOT_MARKER_MISSING'
  | 'POST_ROOT_MARKER_MULTIPLE'
  | 'POST_ROOT_MARKER_ID_INVALID'
  // topic (30020) + addressable kindy
  | 'TOPIC_D_TAG_MISSING'
  | 'TOPIC_SLUG_INVALID'
  | 'TOPIC_PARENT_MULTIPLE'
  | 'TOPIC_PARENT_ADDRESS_INVALID'
  | 'ADDRESSABLE_D_TAG_MISSING'
  // štruktúra NIP-01
  | 'EVENT_ID_INVALID'
  | 'EVENT_PUBKEY_INVALID'
  | 'EVENT_SIG_INVALID'
  | 'CREATED_AT_INVALID'
  | 'CREATED_AT_MILLISECONDS'
  | 'CREATED_AT_TOO_OLD'
  | 'CREATED_AT_TOO_NEW'
  | 'TAGS_NOT_ARRAY'
  | 'TAGS_TOO_MANY'
  | 'TAG_SHAPE_INVALID'
  | 'TAG_ELEMENT_NOT_STRING'
  | 'TAG_ELEMENT_TOO_LONG'
  | 'CONTENT_NOT_STRING'
  | 'CONTENT_TOO_LARGE';

/** Chyba validátora: človečiteľná veta + stabilný kód. */
export interface ValidationIssue {
  message: string;
  code: ValidationCode;
}

/**
 * Vrcholné výsledky validátorov.
 *
 * `codes` indexovo zodpovedá `errors` (rovnaká dĺžka, rovnaké poradie):
 * `errors[i]` je vysvetlenie kódu `codes[i]`. Starší volajúci čítajú len
 * `errors`, takže rozšírenie nič neláme — ale kódy sú to, na čom visuje
 * cross-package logika (indexer: „kind mimo registry smiem tolerovať“).
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  codes: ValidationCode[];
}

export function ok(): ValidationResult {
  return { valid: true, errors: [], codes: [] };
}

/** Výsledok zostavený z issues — veta aj kód vzniknú na jednom mieste. */
export function failIssues(...issues: ValidationIssue[]): ValidationResult {
  return {
    valid: false,
    errors: issues.map((issue) => issue.message),
    codes: issues.map((issue) => issue.code),
  };
}

/** Kompatibilitný skratovací tvar: vety bez vlastného kódu. */
export function fail(...errors: string[]): ValidationResult {
  return failIssues(
    ...errors.map((message): ValidationIssue => ({ message, code: 'VALIDATION_ERROR' })),
  );
}
