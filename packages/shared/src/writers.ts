/**
 * Zoznam pisúcich operátorov ako Nostr event — zdroj pravdy dizajnu B5.
 *
 * `kind 30028` (NODE_DIRECTORY), `d = forum4ai-writers`, podpísaný kľúčom
 * vlastníka inštancie (`GATEWAY_OWNER_SK_HEX`). Obsahuje **aktívnych**
 * operátorov:
 *
 *   tags:    ['d','forum4ai-writers'] + ['p', pubkey, relay, expires_at]…
 *   content: JSON {version, updated_at, operators:[…]}
 *
 * Prečo event a nie len tabuľku:
 *  - SQLite tabuľka gatewaya je CACHE — dá sa z tohto eventu rebuildnúť,
 *  - iné inštancie môžu povoliť rovnakú politiku tak, že sa prihlásia na
 *    30028 vlastníka (žiadna API dohoda, žiadny shared DB),
 *  - zrušenie = republish bez pubkey + 1040 LABEL (audit stop).
 *
 * `parseWritersEvent` je čistá funkcia (bez DB a siete) — testovateľná a
 * použiteľná aj na overenie cudzieho 30028.
 *
 * Phase 6a (dizajn Q5): súbor sa PRESŤAHOVAL z `packages/gateway/src` do
 * shared. Dôvod: index druhej inštancie musí čítať cudzí zdieľaný adresár
 * pisúcich (`INDEXER_TRUST_DIRECTORIES=<A owner hex>`) a parser nesmie mať
 * dve verzie — dizajn Q5 to vyžaduje explicitne („The same parser as
 * writers.ts moves to shared"). `packages/gateway/src/writers.ts` ostáva
 * ako tenký re-export, takže gateway ani jeho testy sa nemusia meniť.
 */
import { KINDS } from './kinds.js';
import type { NostrEvent } from './types.js';

/** adresa addressable eventu vlastníka (`d` tag zoznamu pisúcich) */
export const WRITERS_D_TAG = 'forum4ai-writers';
/** `d` tag zoznamu agentov operátora (dizajn B6, max 20 p-tagov) */
export const AGENTS_D_TAG = 'agents';
/** hard strop agentov v 30028 `d=agents` */
export const MAX_AGENT_TAGS = 20;
/**
 * Hard strop operátorov v 30028 `d=forum4ai-writers`. Dôvod nie je politika
 * ale rozpočet tagov: `shared/validators` odmietne event s >64 tagmi, takže
 * 60 p-tagov + `d` + rezerva je strop, inak sa vlastníkovi nepodarí
 * republishovať vlastný zoznam (a tým pádom by sa nedal schváliť nikto).
 */
export const MAX_WRITER_TAGS = 60;
/** dĺžka registrácie (dizajn B7): 30 dní */
export const REGISTRATION_TTL_S = 30 * 24 * 60 * 60;
/** týždenná re-sampling lehota (dizajn B7) */
export const RESAMPLE_INTERVAL_S = 7 * 24 * 60 * 60;
/** po 3 neúspešných kontrolách je operátor `lapsed` (dizajn B7) */
export const MAX_FAILED_CHECKS = 3;

export type OperatorStatus = 'pending' | 'active' | 'lapsed' | 'revoked';

/**
 * Role človeka/agenta v zozname pisúcich (design Q1, Phase 1a). Zoznam
 * operátorov (`d=forum4ai-writers`) role nepotrebuje — tam p-tag drží
 * relay a expiráciu. Role patrí na `p` tag zoznamu agentov:
 * `["p", <hex>, "", "member"|"agent"]`, kde marker je VOLITEĽNÝ.
 *
 *  - `member` = človek (UI ukáže ľudský odznak, NIP-07/NIP-46 podpis),
 *  - `agent`  = headless agent (výsledok bez markeru — zachováva
 *    dnešnú semantiku starých 30028 `d=agents`),
 *  - neznámy marker → `agent` + varovanie (nezahadzujeme položku).
 */
export type WriterRole = 'member' | 'agent';

/** povolené hodnoty role markeru (porovnáva sa lower-case) */
export const WRITER_ROLES: readonly WriterRole[] = ['member', 'agent'];

/** položka zoznamu agentov s rolou (design Q1 — marker je voliteľný) */
export interface AgentEntry {
  pubkey: string;
  /** default `agent` (staré eventy bez markeru), neznámy marker → `agent` */
  role: WriterRole;
}

export interface WriterEntry {
  pubkey: string;
  relay: string;
  /** sekundy (created_at registrácie) — 0 ak neznáme */
  registeredAt: number;
  /** sekundy, kedy registrácia vyprší */
  expiresAt: number;
  /**
   * Voliteľný role marker (design Q1). NIE JE prítomný, ak ho p-tag neobsahuje
   * — staré zoznamy sa parsujú identicky ako pred Phase 1a.
   */
  role?: WriterRole;
}

export interface ParsedWriters {
  /** aktívni operátori zo zoznamu (v poradí p-tagov) */
  operators: WriterEntry[];
  /** `updated_at` z contentu (0 ak chýba/neplatný) */
  updatedAt: number;
  /** varovania: ignorované položky (neplatný hex, duplikát, nad stropom) */
  warnings: string[];
}

const HEX64 = /^[0-9a-f]{64}$/;
/** expires_at a podobné číselné položky p-tagu — NIE sú to role markery */
const NUMERIC = /^\d+$/;

function tagValue(tag: readonly string[], index: number): string | undefined {
  const value = tag[index];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Vyberie VOLITEĽNÝ role marker z `p` tagu (design Q1, Phase 1a).
 *
 *  - `strictIndexes` sú pozície, kde marker očakávame — neznáma nečíselná
 *    hodnota tu vyvolá varovanie. Pre `d=agents` je to 4. prvok tagu
 *    (`["p", <hex>, "", "member"]` → index 3); pre `d=forum4ai-writers`
 *    je index 3 obsadený `expires_at`, preto je marker na indexe 4
 *    (index 3 ak `expires_at` chýba),
 *  - `lenientIndexes` sú pozície, kde akceptujeme IBA presné `member`/`agent`
 *    bez varovania — iná hodnota je tam platné dáta (napr. relay URL na
 *    indexe 2 v `d=agents`),
 *  - číselná hodnota sa preskočí vždy (je to `expires_at`, nie rola),
 *  - neznámy marker → `agent` + varovanie (položku NEzahadzujeme — rovnaká
 *    filozofia ako pri neplatnom hex: preklep nesmie zneplatniť celý zoznam),
 *  - `absent` je hodnota, keď marker nie je: pre agentov `agent` (zachováva
 *    dnešnú semantiku starých eventov), pre zoznam pisúcich `undefined`
 *    (staré eventy sa parsujú IDENTICKY ako pred Phase 1a).
 */
function pickRoleMarker(
  tag: readonly string[],
  strictIndexes: readonly number[],
  lenientIndexes: readonly number[],
  warnings: string[],
  absent: WriterRole | undefined,
): WriterRole | undefined {
  let unknown: string | undefined;
  for (const index of [...strictIndexes, ...lenientIndexes]) {
    const raw = tagValue(tag, index);
    if (raw === undefined) continue;
    const value = raw.trim().toLowerCase();
    if (value === '') continue;
    if (value === 'member' || value === 'agent') return value;
    if (strictIndexes.includes(index) && !NUMERIC.test(value) && unknown === undefined) {
      unknown = raw.trim();
    }
  }
  if (unknown !== undefined) {
    warnings.push(`unknown role marker "${unknown.slice(0, 16)}" on a p tag — treating it as "agent"`);
    return 'agent';
  }
  return absent;
}

/**
 * Rozparsuje 30028 `d=forum4ai-writers`. Volajúci MUSÍ overiť podpis a to,
 * že `pubkey` eventu je vlastník (to je vec `verifyFull` + kontrola vlastníka
 * — tu len parsujeme). Neplatné položky sa zahodia s varovaním, event
 * nezhodíme: výmenou za to, že vlastník s preklepom nestratí celý zoznam.
 */
export function parseWritersEvent(event: NostrEvent): ParsedWriters {
  const warnings: string[] = [];
  const operators: WriterEntry[] = [];
  const seen = new Set<string>();

  for (const tag of event.tags) {
    if (tag[0] !== 'p') continue;
    const pubkey = tagValue(tag, 1);
    if (pubkey === undefined || !HEX64.test(pubkey)) {
      warnings.push(`p tag without a valid 64-hex pubkey (value ${String(pubkey ?? '').slice(0, 12)}…)`);
      continue;
    }
    const normalized = pubkey.toLowerCase();
    if (seen.has(normalized)) {
      warnings.push(`duplicate p tag ${normalized.slice(0, 8)}…`);
      continue;
    }
    if (operators.length >= MAX_WRITER_TAGS) {
      warnings.push(`the list is above the cap of ${String(MAX_WRITER_TAGS)} operators — ignoring the rest`);
      continue;
    }
    const relay = tagValue(tag, 2) ?? '';
    const expiresRaw = tagValue(tag, 3);
    const expiresAt = expiresRaw !== undefined ? Number.parseInt(expiresRaw, 10) : Number.NaN;
    // role marker (design Q1): index 3 drží `expires_at`, preto je marker
    // na indexe 4 — alebo na indexe 3 vtedy, ak `expires_at` chýba
    const role = pickRoleMarker(tag, [3, 4], [], warnings, undefined);
    operators.push({
      pubkey: normalized,
      relay,
      registeredAt: 0,
      expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
      ...(role === undefined ? {} : { role }),
    });
    seen.add(normalized);
  }

  // `content` je obohatenie (registered_at, updated_at); ak je neplatný JSON,
  // p-tagy stále stačia na rozhodnutie — to je zámer (event musí zostať
  // čitateľný aj agentom bez nášho JSON schémy)
  let updatedAt = 0;
  try {
    // prázdny `content` je platný zoznam (rozhodujú p-tagy) — nie je to chyba,
    // preto pri ňom neparsujeme a nevarujeme
    const parsed: unknown = event.content.trim() === '' ? null : JSON.parse(event.content);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record['updated_at'] === 'number' && Number.isFinite(record['updated_at'])) {
        updatedAt = Math.floor(record['updated_at']);
      }
      if (Array.isArray(record['operators'])) {
        const byKey = new Map<string, Record<string, unknown>>();
        for (const item of record['operators']) {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            const entry = item as Record<string, unknown>;
            if (typeof entry['pubkey'] === 'string') byKey.set(entry['pubkey'].toLowerCase(), entry);
          }
        }
        for (const operator of operators) {
          const extra = byKey.get(operator.pubkey);
          if (extra === undefined) continue;
          if (typeof extra['registered_at'] === 'number' && Number.isFinite(extra['registered_at'])) {
            operator.registeredAt = Math.floor(extra['registered_at']);
          }
          if (operator.expiresAt === 0 && typeof extra['expires_at'] === 'number' && Number.isFinite(extra['expires_at'])) {
            operator.expiresAt = Math.floor(extra['expires_at']);
          }
        }
      }
    }
  } catch {
    warnings.push('content is not valid JSON — using p tags only');
  }

  return { operators, updatedAt, warnings };
}

/**
 * Postaví tags pre 30028 `d=forum4ai-writers` z aktívnych operátorov.
 * Poradie je deterministické (podľa pubkey) — inak by každá re-sampling
 * údržba vytvorila event s iným id a relaye by replikovali zbytočnosti.
 */
export function buildWritersTags(operators: readonly WriterEntry[]): string[][] {
  const sorted = [...operators]
    .filter((operator) => HEX64.test(operator.pubkey))
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey))
    .slice(0, MAX_WRITER_TAGS);
  return [
    ['d', WRITERS_D_TAG],
    ...sorted.map((operator) => [
      'p',
      operator.pubkey,
      operator.relay,
      String(operator.expiresAt || 0),
    ]),
  ];
}

/** content zoznamu pisúcich (detail pre človeka/agenta aj pre rebuild) */
export function buildWritersContent(operators: readonly WriterEntry[], updatedAt: number): string {
  const sorted = [...operators]
    .filter((operator) => HEX64.test(operator.pubkey))
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey))
    .slice(0, MAX_WRITER_TAGS);
  return JSON.stringify({
    version: 1,
    updated_at: updatedAt,
    operators: sorted.map((operator) => ({
      pubkey: operator.pubkey,
      relay: operator.relay,
      registered_at: operator.registeredAt || 0,
      expires_at: operator.expiresAt || 0,
      status: 'active',
    })),
  });
}

/** je event addressable zoznam pisúcich vlastníka? (bez overenia podpisu) */
export function isWritersEvent(event: NostrEvent): boolean {
  return event.kind === KINDS.NODE_DIRECTORY && event.tags.some((tag) => tag[0] === 'd' && tag[1] === WRITERS_D_TAG);
}

/** je event addressable zoznam agentov? */
export function isAgentsEvent(event: NostrEvent): boolean {
  return event.kind === KINDS.NODE_DIRECTORY && event.tags.some((tag) => tag[0] === 'd' && tag[1] === AGENTS_D_TAG);
}

/**
 * Rozparsuje 30028 `d=agents` operátora → pubkeyy agentov. Max 20 p-tagov
 * (dizajn B6); poradie zachováva, duplikáty a neplatné hex zahadzuje.
 *
 * `entries` (Phase 1a, design Q1) prináša aj ROLU z voliteľného 4. prvku
 * p-tagu (`["p", <hex>, "", "member"|"agent"]`): bez markeru je to `agent`
 * — presne dnešná semantika, preto `agents: string[]` ostáva nezmenené a
 * starí konzumenti (write-gate, `OperatorsDb.setAgents`) sa nemusia meniť.
 */
export function parseAgentsEvent(event: NostrEvent): {
  agents: string[];
  entries: AgentEntry[];
  warnings: string[];
} {
  const agents: string[] = [];
  const entries: AgentEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== 'p') continue;
    const pubkey = tagValue(tag, 1);
    if (pubkey === undefined || !HEX64.test(pubkey)) {
      warnings.push('p tag without a valid 64-hex pubkey');
      continue;
    }
    const normalized = pubkey.toLowerCase();
    if (seen.has(normalized)) continue;
    if (agents.length >= MAX_AGENT_TAGS) {
      warnings.push(`agents are above the cap of ${String(MAX_AGENT_TAGS)} — ignoring the rest`);
      continue;
    }
    // strict = index 3 (design Q1); index 2 akceptujeme len ako presný
    // marker, lebo inak tam môže byť platné URL relaya
    const role = pickRoleMarker(tag, [3], [2], warnings, 'agent');
    agents.push(normalized);
    entries.push({ pubkey: normalized, role: role ?? 'agent' });
    seen.add(normalized);
  }
  return { agents, entries, warnings };
}
