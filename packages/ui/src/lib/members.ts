/**
 * Parser zoznamov 30028 z pohľadu UI (F4AI-24, Phase 1b).
 *
 * Gateway drží zoznam pisúcich a agentov ako addressable eventy
 * `kind 30028` (`gateway/src/writers.ts`):
 *
 *   `d = forum4ai-writers`  → p-taggy `["p", pubkey, relay, expires_at]`
 *   `d = agents`            → p-taggy `["p", pubkey, "", "member"|"agent"]`
 *
 * UI neimportuje gateway kód (len `@forum4ai/shared` typy), preto tu
 * parsujeme to isté RUČNE — ale podľa rovnakej štruktúry, aby sa UI
 * neukázalo niečo, čo gateway nepoužíva. Kľúčové zhody:
 *  - `WRITERS_D_TAG` / `AGENTS_D_TAG` sú tie isté reťazce,
 *  - role marker je VOLITEĽNÝ a neznámy marker znamená `agent` +
 *    varovanie (presne ako `parseAgentsEvent`),
 *  - addressable event má len JEDNO `d` — ak ich author pošle viac
 *    (republish), berieme najnovší `created_at`.
 *
 * Všetko sú čisté funkcie nad `EventSummary` (cudzí data), takže žiadna
 * domnienka, že event je podpísaný správne — to overuje gateway/indexer,
 * UI len zobrazuje, čo dostal.
 */
import type { EventSummary } from '../api/types.js';
import { t } from '../i18n/text.js';

/** `d` tag zoznamu pisúcich (zdroj: `gateway/src/writers.ts`) */
export const WRITERS_D_TAG = 'forum4ai-writers';
/** `d` tag zoznamu agentov (zdroj: `gateway/src/writers.ts`) */
export const AGENTS_D_TAG = 'agents';

export type WriterRole = 'member' | 'agent';

export interface MemberEntry {
  pubkey: string;
  /** `agent` je default (staré eventy bez markeru) */
  role: WriterRole;
  /** relay z p-tagu (len writers zoznam) */
  relay?: string;
  /** sekundy expirácie (len writers zoznam), 0 = neznáme */
  expiresAt?: number;
}

export interface ParsedList {
  entries: MemberEntry[];
  /** varovania, ktoré UI ukáže — nikdy nič netlмíme */
  warnings: string[];
  /** event, z ktorého sme parsowali (pre zobrazenie `created_at`) */
  event: EventSummary | null;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** nájdi `d` tag */
export function dTagOf(event: EventSummary): string | null {
  for (const tag of event.tags) {
    if (tag[0] === 'd') return tag[1] ?? '';
  }
  return null;
}

/**
 * Vyber najnovší addressable event s daným `d`. Addressable event je
 * per `d` jeden — viac rovníkov znamená republish, nie zoznam.
 */
export function latestByD(items: EventSummary[], d: string): EventSummary | null {
  let best: EventSummary | null = null;
  for (const item of items) {
    if (item.kind !== 30028) continue;
    if (dTagOf(item) !== d) continue;
    if (best === null || item.created_at > best.created_at) best = item;
  }
  return best;
}

/**
 * `d=forum4ai-writers`: `["p", pubkey, relay, expires_at]`.
 * `expires_at` je reťazec sekúnd — nedá sa parsovať → 0 (UI ukáže
 * „neznáma expirácia“, nevyrobí z toho rok 1970).
 */
export function parseWritersEvent(event: EventSummary | null): ParsedList {
  const warnings: string[] = [];
  const entries: MemberEntry[] = [];
  if (event === null) return { entries, warnings, event: null };
  const seen = new Map<string, MemberEntry>();
  for (const tag of event.tags) {
    if (tag[0] !== 'p') continue;
    const pubkey = (tag[1] ?? '').toLowerCase();
    if (!HEX_64.test(pubkey)) {
      warnings.push(t('settings:warnings.badPTag', { pubkey: (tag[1] ?? t('settings:warnings.empty')).slice(0, 16) }));
      continue;
    }
    const relay = tag[2] ?? '';
    const rawExpiry = tag[3] ?? '';
    const parsedExpiry = Number.parseInt(rawExpiry, 10);
    const expiresAt = Number.isFinite(parsedExpiry) && rawExpiry !== '' ? parsedExpiry : 0;
    if (rawExpiry !== '' && !Number.isFinite(parsedExpiry)) {
      warnings.push(t('settings:warnings.badExpiry', { pubkey: pubkey.slice(0, 8), raw: rawExpiry.slice(0, 12) }));
    }
    seen.set(pubkey, { pubkey, role: 'member', ...(relay !== '' ? { relay } : {}), expiresAt });
  }
  return { entries: [...seen.values()], warnings, event };
}

/**
 * `d=agents`: `["p", pubkey, "", "member"|"agent"]`. Marker je voliteľný;
 * neznána hodnota → `agent` + varovanie (rovnaké pravidlo ako
 * `parseAgentsEvent` v gatewayi, aby sa UI a gate nezhodovali inak).
 */
export function parseAgentsEvent(event: EventSummary | null): ParsedList {
  const warnings: string[] = [];
  const entries: MemberEntry[] = [];
  if (event === null) return { entries, warnings, event: null };
  const seen = new Map<string, MemberEntry>();
  for (const tag of event.tags) {
    if (tag[0] !== 'p') continue;
    const pubkey = (tag[1] ?? '').toLowerCase();
    if (!HEX_64.test(pubkey)) {
      warnings.push(t('settings:warnings.badPTag', { pubkey: (tag[1] ?? t('settings:warnings.empty')).slice(0, 16) }));
      continue;
    }
    const marker = (tag[3] ?? '').toLowerCase();
    let role: WriterRole;
    if (marker === 'member') role = 'member';
    else if (marker === 'agent' || marker === '') role = 'agent';
    else {
      role = 'agent';
      warnings.push(t('settings:warnings.unknownMarker', { marker, pubkey: pubkey.slice(0, 8) }));
    }
    seen.set(pubkey, { pubkey, role });
  }
  return { entries: [...seen.values()], warnings, event };
}

/** oboje naraz — `SettingsPage` potrebuje obe listy z jedného fetchu */
export function parseMemberLists(items: EventSummary[]): {
  writers: ParsedList;
  agents: ParsedList;
} {
  return {
    writers: parseWritersEvent(latestByD(items, WRITERS_D_TAG)),
    agents: parseAgentsEvent(latestByD(items, AGENTS_D_TAG)),
  };
}
