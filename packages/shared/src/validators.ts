/**
 * Validátory L2 politiky pre forum4ai eventy.
 * Pravidiá sú prevzaté zo schémy (wiki4ai forum4Ai →
 * "Datovy model a synchronizacia", kap. 3, 4):
 *  - povolené sú iba kindy našej registry,
 *  - post (1023) nesie práve jeden `e` tag s markerom `root`,
 *  - topic (30020) vyžaduje `d` tag (slug) a voliteľný parent tag `a`
 *    s adresou predka `30020:<pubkey>:<slug>`,
 *  - addressable kindy (30000+) vyžadujú `d` tag,
 *  - `created_at` je sekundy (ms timestamp = chyba, A11 E1).
 */
import { KINDS, isAddressableKind, isAllowedKind } from './kinds.js';
import { failIssues, ok } from './types.js';
import type { NostrEvent, NostrTag, ValidationIssue, ValidationResult } from './types.js';

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

/**
 * Horná hranica `created_at` (sekundy): event nesmie siahať ďalej než
 * `now + CREATED_AT_MAX_FUTURE_S`. Dôvod (code-review A9/B1): bez nej jeden
 * event s ľubovoľne veľkým časom (napr. 2^32) (a) predlňuje okno backfillu
 * a (b) v indexeri ukotví anti-entropický since-sweep nad všetok skutočný
 * obsah — ten sa potom nikdy nedočíta. 900 s toleruje hodiny autorov,
 * ktoré mierne predbiehajú (rovnaká logika ako `slack` v indexeri).
 */
export const CREATED_AT_MAX_FUTURE_S = 900;

/**
 * A7 (security review, P0): spodná hranica `created_at` = 2024-01-01T00:00:00Z.
 * Bez nej hociktorý junk event s `created_at: 1` prejde (a (a) rozhádže
 * backfill indexera — prvé okno je potom od roku 1970, (b) pri replay-i
 * NIP-98 auth eventov ±300 s nebráni nič opätovnému použitiu starých
 * eventov). Naš obsah vznikol v roku 2026, spodná hranica je teda
 * konzervatívna a nič existujúce nelámie.
 */
export const CREATED_AT_MIN_S = 1_704_067_200; // 2024-01-01T00:00:00Z

/**
 * A7 (security review, P0): zdieľané veľkostné stropy. Jediný zdroj pravdy
 * pre gateway (`POST /events`) aj relay (politika) — bez nich by 256 KB
 * strop tela dovolil jeden 250 KB `content` alebo 100 000 trojprvkových
 * tagov, čo je lacný CPU/pamäťový DoS (každý tag sa indexuje a serializuje).
 *
 * Phase 4a (dizajn Q4): číselné hodnoty presídlili do `limits.ts`, lebo ich
 * potrebuje aj UI (subpath import bez `nostr-tools`) a gateway lint papiera.
 * Tu ostáva **re-export** — verejné API `@forum4ai/shared` (a 995 testov) sa
 * nemění. `contentLimitForKind`/`tagsLimitForKind` pridávajú per-kind
 * výnimky: 30023 paper má 160 KiB / 128 tagov, všetko ostatné ostáva pri
 * 32 KiB / 64.
 */
import {
  MAX_CONTENT_BYTES,
  MAX_TAGS,
  MAX_TAG_ELEMENT_BYTES,
  contentLimitForKind,
  tagsLimitForKind,
} from './limits.js';

export { MAX_CONTENT_BYTES, MAX_TAGS, MAX_TAG_ELEMENT_BYTES };
export {
  MAX_CONTENT_BYTES_BY_KIND,
  MAX_TAGS_BY_KIND,
  contentLimitForKind,
  tagsLimitForKind,
} from './limits.js';

const encoder = new TextEncoder();
/** dĺžka reťazca v UTF-8 bajtoch (nie znakoch) — pre stropy obsahu/tagov */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

/** slug topicu: malé písmená, číslice, pomlčky, bodky (nesmie začínať koncovkou) */
const SLUG = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
/** adresa addressable eventu kind:pubkey:d */
const ADDRESS_30020 = /^30020:[0-9a-f]{64}:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Nájdi všetky tagy so skratkou `name`. */
export function findTags(tags: NostrTag[], name: string): NostrTag[] {
  return tags.filter((tag) => tag[0] === name);
}

/** `e` tagy s markerom `root` (marker je tretí prvok, NIP-10). */
export function rootMarkers(tags: NostrTag[]): NostrTag[] {
  return tags.filter((tag) => tag[0] === 'e' && tag[2] === 'root');
}

/** Kind musí byť v našej registry (iný odmietneme — inak by relay nevedel, čo s ním).
 *  Registry je `KINDS` v `kinds.ts`; od F4AI-14 (S8) obsahuje aj NIP-01 core
 *  kindy 0 (set-metadata) a 3 (contacts) — tie nemajú žiadne L2 pravidlo
 *  navyše (nie sú addressable, nemajú root marker), passujú cez štruktúru. */
export function validateKind(kind: number): ValidationResult {
  if (!Number.isInteger(kind) || kind < 0) {
    return failIssues({
      message: `kind ${kind} is not a non-negative integer`,
      code: 'KIND_INVALID',
    });
  }
  if (!isAllowedKind(kind)) {
    // F4AI-2b2: indexer (ingest.ts) na tomto kóde rozhoduje, či event s
    // kindom mimo registry smie skončiť v indexe — preto kód, nie veta.
    return failIssues({
      message: `kind ${kind} is not in the forum4ai kind registry`,
      code: 'KIND_NOT_REGISTERED',
    });
  }
  return ok();
}

/**
 * Pravidlo pre post (1023): práve jeden `e` tag s markerom `root`.
 * NIP-10 heuristiku tak meníme na pravidlom overenú konvenciu —
 * relay s viac root markermi alebo bez neho event odmietne.
 */
export function validatePostRootMarker(tags: NostrTag[]): ValidationResult {
  const roots = rootMarkers(tags);
  if (roots.length === 0) {
    return failIssues({
      message: 'post (1023) must have exactly one e tag with a root marker',
      code: 'POST_ROOT_MARKER_MISSING',
    });
  }
  if (roots.length > 1) {
    return failIssues({
      message: `post (1023) has ${roots.length} root markers, exactly one is expected`,
      code: 'POST_ROOT_MARKER_MULTIPLE',
    });
  }
  const rootId = roots[0]?.[1];
  if (rootId === undefined || !HEX_64.test(rootId)) {
    return failIssues({
      message: 'root marker must reference a 64-hex event id',
      code: 'POST_ROOT_MARKER_ID_INVALID',
    });
  }
  return ok();
}

/**
 * Pravidlo pre topic (30020): povinný `d` tag (slug) a voliteľný
 * parent tag `a` s adresou `30020:<parent-pubkey>:<parent-slug>`.
 */
export function validateTopic(tags: NostrTag[]): ValidationResult {
  const issues = topicIssues(tags);
  return issues.length > 0 ? failIssues(...issues) : ok();
}

/** L2 pravidlá topicu ako issues (zdieľané s `validateEvent`, aby kódy sedeli). */
function topicIssues(tags: NostrTag[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const dTags = findTags(tags, 'd');
  if (dTags.length === 0) {
    issues.push({ message: 'topic (30020) requires a d tag with a slug', code: 'TOPIC_D_TAG_MISSING' });
  } else {
    const slug = dTags[0]?.[1];
    if (slug === undefined || !SLUG.test(slug)) {
      issues.push({
        message:
          'the slug in the d tag must consist of lowercase letters, digits, hyphens and dots (not at the edges)',
        code: 'TOPIC_SLUG_INVALID',
      });
    }
  }

  const parentTags = findTags(tags, 'a');
  if (parentTags.length > 1) {
    issues.push({
      message: 'topic may have at most one parent and one tag',
      code: 'TOPIC_PARENT_MULTIPLE',
    });
  } else if (parentTags.length === 1) {
    const addr = parentTags[0]?.[1];
    if (addr === undefined || !ADDRESS_30020.test(addr)) {
      issues.push({
        message: 'parent and tag must have the form of a 30020:<64hex-pubkey>:<slug> address',
        code: 'TOPIC_PARENT_ADDRESS_INVALID',
      });
    }
  }

  return issues;
}

/** Štrukturálna kontrola kánonického NIP-01 eventu (bez overenia podpisu). */
export function validateEventStructure(
  event: NostrEvent,
  options?: { nowSeconds?: number },
): ValidationResult {
  const issues = structureIssues(event, options);
  return issues.length > 0 ? failIssues(...issues) : ok();
}

/** Štrukturálne chyby ako issues — zdieľané s `validateEvent` (kvôli kódom). */
function structureIssues(event: NostrEvent, options?: { nowSeconds?: number }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!HEX_64.test(event.id)) {
    issues.push({ message: 'id must be 64 hex characters', code: 'EVENT_ID_INVALID' });
  }
  if (!HEX_64.test(event.pubkey)) {
    issues.push({
      message: 'pubkey must be 64 hex characters (x-only secp256k1)',
      code: 'EVENT_PUBKEY_INVALID',
    });
  }
  if (!HEX_128.test(event.sig)) {
    issues.push({
      message: 'sig must be 128 hex characters (BIP-340 Schnorr)',
      code: 'EVENT_SIG_INVALID',
    });
  }
  if (!Number.isInteger(event.created_at) || event.created_at <= 0) {
    issues.push({
      message: 'created_at must be a positive integer (Unix seconds)',
      code: 'CREATED_AT_INVALID',
    });
  } else if (event.created_at >= 1_000_000_000_000) {
    issues.push({
      message: 'created_at is in milliseconds — NIP-01 requires seconds',
      code: 'CREATED_AT_MILLISECONDS',
    });
  } else if (event.created_at < CREATED_AT_MIN_S) {
    // A7 (P0): spodná hranica — junk s created_at z roku 1970 by rozhádzal
    // backfill okná indexera a dovolil neobmedzený replay starých eventov
    issues.push({
      message:
        `created_at is before the lower bound ${CREATED_AT_MIN_S} (2024-01-01), ` +
        `got ${String(event.created_at)}`,
      code: 'CREATED_AT_TOO_OLD',
    });
  } else {
    // horná hranica (A9/B1): ďaleká budúcnos = junk, ktorý rozhádže
    // backfill aj anti-entropiu — odmietame už pri validácii
    const nowS = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (event.created_at > nowS + CREATED_AT_MAX_FUTURE_S) {
      issues.push({
        message:
          `created_at is more than ${String(CREATED_AT_MAX_FUTURE_S)} s in the future ` +
          `(created_at=${String(event.created_at)}, now=${String(nowS)})`,
        code: 'CREATED_AT_TOO_NEW',
      });
    }
  }
  if (!Array.isArray(event.tags)) {
    issues.push({ message: 'tags must be an array', code: 'TAGS_NOT_ARRAY' });
  } else {
    // A7 (P0): stropy tagov — 256 KB strop tela sám o sebe neobmedzuje
    // POČET tagov ani ich dĺžku, a každý tag sa indexuje a serializuje.
    // Phase 4a: strop je per-kind (paper 30023 nosí autorov a topicie v
    // tagoch → 128), default 64 pre všetky ostatné kindy sa nemení.
    const maxTags = tagsLimitForKind(event.kind);
    if (event.tags.length > maxTags) {
      issues.push({
        message: `tags may have at most ${String(maxTags)} entries for kind ${String(event.kind)}, got ${String(event.tags.length)}`,
        code: 'TAGS_TOO_MANY',
      });
    }
    for (const [i, tag] of event.tags.entries()) {
      if (!Array.isArray(tag) || tag.length === 0 || typeof tag[0] !== 'string') {
        issues.push({
          message: `tag[${i}] must be a non-empty array of strings`,
          code: 'TAG_SHAPE_INVALID',
        });
        continue;
      }
      for (const [j, element] of tag.entries()) {
        if (typeof element !== 'string') {
          issues.push({
            message: `tag[${i}][${String(j)}] must be a string`,
            code: 'TAG_ELEMENT_NOT_STRING',
          });
        } else if (utf8ByteLength(element) > MAX_TAG_ELEMENT_BYTES) {
          issues.push({
            message:
              `tag[${i}][${String(j)}] is longer than ${String(MAX_TAG_ELEMENT_BYTES)} bytes ` +
              `(${String(utf8ByteLength(element))})`,
            code: 'TAG_ELEMENT_TOO_LONG',
          });
        }
      }
    }
  }
  if (typeof event.content !== 'string') {
    issues.push({ message: 'content must be a string', code: 'CONTENT_NOT_STRING' });
  } else {
    // A7 (P0): strop obsahu — NIP-01 event má reálne ~1 KB, bez stropu je
    // jeden veľký event drahý na podpis, uloženie aj prenos.
    // Phase 4a (dizajn Q4): strop je per-kind — 30023 paper má 160 KiB,
    // ostatné kindy ostávajú pri 32 KiB (`MAX_CONTENT_BYTES_BY_KIND`).
    const limit = contentLimitForKind(event.kind);
    const bytes = utf8ByteLength(event.content);
    if (bytes > limit) {
      issues.push({
        message:
          `content is larger than ${String(limit)} bytes for kind ${String(event.kind)} ` +
          `(${String(bytes)})`,
        code: 'CONTENT_TOO_LARGE',
      });
    }
  }

  return issues;
}

/**
 * Kompletná L2 validácia eventu: štruktúra + kind politika +
 * kind-špecifické pravidlá (1023 root marker, addressable d-tag,
 * topic 30020 slug/parent). Podpis overuje volajúci cez
 * nostr-tools `verifyEvent` (ID = hash obsahu, BIP-340).
 */
export function validateEvent(
  event: NostrEvent,
  options?: { nowSeconds?: number },
): ValidationResult {
  const issues: ValidationIssue[] = [...structureIssues(event, options)];

  const kindResult = validateKind(event.kind);
  issues.push(...kindIssuesOf(kindResult));

  if (kindResult.valid) {
    if (event.kind === KINDS.POST) {
      issues.push(...kindIssuesOf(validatePostRootMarker(event.tags)));
    }
    if (isAddressableKind(event.kind) && findTags(event.tags, 'd').length === 0) {
      issues.push({
        message: `addressable kind ${event.kind} requires a d tag`,
        code: 'ADDRESSABLE_D_TAG_MISSING',
      });
    }
    if (event.kind === KINDS.TOPIC) {
      issues.push(...topicIssues(event.tags));
    }
  }

  return issues.length > 0 ? failIssues(...issues) : ok();
}

/** Spätná projekcia ValidationResult na issues (poradie message ↔ code sedí). */
function kindIssuesOf(result: ValidationResult): ValidationIssue[] {
  return result.errors.map((message, i): ValidationIssue => ({
    message,
    code: result.codes[i] ?? 'VALIDATION_ERROR',
  }));
}
