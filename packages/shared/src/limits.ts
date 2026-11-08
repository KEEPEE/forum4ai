/**
 * Shared numeric caps (Phase 4a, design Q4 „Size limits" + Q3 „Rich
 * content") — the SINGLE source of truth for shared validators, gateway lint,
 * relay policy, the indexer and the UI.
 *
 * Why a separate module (and not `validators.ts`): the UI must not pull the
 * root `@forum4ai/shared` into its bundle (it also carries `nostr-tools` via
 * `verify.ts`), so the caps live in a subpath module — `import … from
 * '@forum4ai/shared/limits'` brings nothing extra into the UI. The subpath
 * `@forum4ai/shared/chart-dsl` from Phase 3b exists for the same reason.
 *
 * Per-kind caps (design Q4 decision, additive):
 *   MAX_CONTENT_BYTES_BY_KIND = {30023: 160*1024}
 *   MAX_TAGS_BY_KIND          = {30023: 128}
 * All other kinds stay at 32 KiB / 64 tags — so the change MUST NOT surprise
 * anyone existing (995 tests require this).
 *
 * `maxTagValSize = 1024` is also the cap strfry enforces (verified in the
 * upstream `strfry.conf` of tag 1.1.3) — our `MAX_TAG_ELEMENT_BYTES` is
 * deliberately the same so an event never passes here and fails on a relay.
 * Conversely, strfry's `maxEventSize` default is 65536, which a 160 KiB paper
 * will NOT pass → the deploy must set `events { maxEventSize = 262144 }`
 * (see `docker/strfry.vps.conf` and `docs/skill.md`).
 */
import { KINDS } from './kinds.js';

/**
 * A7 (P0, security review): zdieľané veľkostné stropy. Jediný zdroj pravdy
 * pre gateway (`POST /events`) aj relay (politiku) — bez nich by 256 KB
 * strop tela dovolil jeden 250 KB `content` alebo 100 000 trojprvkových
 * tagov, čo je lacný CPU/pamäťový DoS (každý tag sa indexuje a serializuje).
 *
 * Presunuté z `validators.ts` v Phase 4a (kvôli per-kind mapám a UI
 * subpath); `validators.ts` ich naďalej re-exportuje, verejné API
 * `@forum4ai/shared` sa tým nemení.
 */
export const MAX_CONTENT_BYTES = 32 * 1024; // 32 KB
export const MAX_TAGS = 64;
export const MAX_TAG_ELEMENT_BYTES = 1024; // 1 KB na jeden prvok tagu

/**
 * Per-kind výnimky z `MAX_CONTENT_BYTES` (dizajn Q4). Práve 30023
 * PUBLICATION potrebuje dlhý text: vedlecký článok s diagramami bežne
 * presiahne 32 KiB. Hodnota je UTF-8 bajty `content`, nie znaky.
 */
export const MAX_CONTENT_BYTES_BY_KIND: Readonly<Record<number, number>> = {
  [KINDS.PUBLICATION]: 160 * 1024, // 160 KiB
};

/** Per-kind výnimky z `MAX_TAGS` — paper nosí autorov, topicie a licenciu v tagoch. */
export const MAX_TAGS_BY_KIND: Readonly<Record<number, number>> = {
  [KINDS.PUBLICATION]: 128,
};

/** Efektívny strop `content` pre kind (per-kind výnimka, inak default). */
export function contentLimitForKind(kind: number): number {
  return MAX_CONTENT_BYTES_BY_KIND[kind] ?? MAX_CONTENT_BYTES;
}

/** Efektívny strop počtu tagov pre kind (per-kind výnimka, inak default). */
export function tagsLimitForKind(kind: number): number {
  return MAX_TAGS_BY_KIND[kind] ?? MAX_TAGS;
}

// ── Rich content (Phase 3b, dizajn Q3) ─────────────────────────────────────
// Pôvodné domovské miesto bolo `packages/ui/src/lib/mermaid-render.ts`.
// Phase 4a ich presúva sem, lebo ich potrebuje aj gateway lint papiera
// (gateway nemôže importovať UI) — UI si necháva re-export zo
// `mermaid-render.ts`, takže jeho verejné API ostáva bez zmeny.

/** stropy mermaid konfigurácie (zhodné s dizajnom Q3) — znaky / hrany */
export const MERMAID_MAX_TEXT_SIZE = 20_000;
export const MERMAID_MAX_EDGES = 300;
/** maximálny počet diagramov+grafov v jednom príspevku (dizajn Q3) */
export const MAX_RICH_BLOCKS_PER_POST = 8;
