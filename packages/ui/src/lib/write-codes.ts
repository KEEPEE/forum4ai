/**
 * Copy write-gate (F4AI-23, Phase 1b → Phase 2a i18n) — JEDNA mapa
 * kódu → copy, ale text už nežije tu: žije v `locales/{en,sk}/write.json`
 * pod kľúčmi `write:codes.WG_*`.
 *
 * Prečo mapu kódu a nie text gatewayu: `GET /write-status` vracia aj
 * `reason` (vetu, ktorou gateway OPÍSALE rozhodnutie), ale ten sa mení so
 * kódom a Phase 2b ho prepne na angličtinu (agenti čítajú server).
 * Stabilný kontrakt je `code` (`WG_*`, zdroj pravdy:
 * `gateway/src/write-gate.ts` + tabuľka v `docs/skill.md`). Banner preto
 * píše VLASTNÚ vetu podľa kódu a `reason` ukáže ako drobný fallback, keď
 * kód nepoznáme (starší gateway alebo nový kód, ktorý tu ešte nie je).
 *
 * Pravidlo úprimnosti: text nesmie sľubovať to, čo backend nerobí.
 * Napríklad `WG_PENDING` nehovorí „čakaj, schválime to do hodiny“ —
 * gateway nemanuálnej SLA; povieme len KTO rozhoduje a ČO má čakať.
 *
 * Phase 2a: exporty `WRITE_GATE_COPY` / `OPERATOR_STATUS_COPY` /
 * `ANONYMOUS_WRITE_COPY` zostávajú (testy a stránky ich čítajú ako
 * objekt), ale ich textové polia sú GETTERY → vždy v aktuálnom jazyku.
 * Interpolácia prešla z `{claimId}` na i18next `{{claimId}}`;
 * `requires` v metadate hovorí, ktoré hodnoty veta potrebuje — ak
 * chýbajú, vezmeme `detail_no_value` (žiadny nezasypaný placeholder).
 */
import { t as translate } from '../i18n/text.js';
import type { WriteGateCode } from '../api/types.js';

export type CopyTone = 'ok' | 'info' | 'warn' | 'error';

export interface WriteGateCopy {
  /** nadpis banneru / composer note */
  headline: string;
  /** prečo — jedna-dve vety, bez žargónu */
  detail: string;
  /**
   * `detail` bez dosadenia, keď sa placeholder nepodarí naplniť (gateway
   * nevrátil `operator`). Bez tohto pola by banner ukázal `{{operator}}`.
   */
  detailNoValue?: string;
  /** ak existuje užitočná akcia, jej popisek */
  cta?: string;
  /** kam akcia vedie (route v rámci appky) */
  to?: string;
  tone: CopyTone;
}

/**
 * Kódy, pri ktorých zápis PRECHÁDZA — banner sa pri nich vôbec neukáže,
 * preto majú copy len pre prípad, že ho UI chce ukázať ako info.
 */
export const ALLOWING_CODES: readonly WriteGateCode[] = ['WG_GATE_OFF', 'WG_BOOTSTRAP', 'WG_OPERATOR', 'WG_AGENT'];

/** placeholder, ktorý veta potrebuje — bez neho sa berie `detail_no_value` */
type CopyValue = 'claimId' | 'relay' | 'operator';

interface CodeMeta {
  tone: CopyTone;
  /** kód má CTA (text je v locale pod `codes.<kod>.cta`) */
  cta?: boolean;
  /** route, kam CTA vedie — to nie je text, takže zostáva v kóde */
  to?: string;
  requires?: CopyValue[];
}

/** statická časť kontraktu (tón, route) — text je výhradne v locale */
const CODE_META: Record<WriteGateCode, CodeMeta> = {
  WG_GATE_OFF: { tone: 'warn' },
  WG_BOOTSTRAP: { tone: 'ok' },
  WG_OPERATOR: { tone: 'ok' },
  WG_AGENT: { tone: 'ok', requires: ['operator'] },
  WG_NOT_REGISTERED: { tone: 'info', cta: true, to: '/register' },
  WG_PENDING: { tone: 'info', cta: true, to: '/register', requires: ['claimId', 'relay'] },
  WG_LAPSED: { tone: 'warn', cta: true, to: '/register' },
  WG_REVOKED: { tone: 'error', cta: true, to: '/about-this-forum' },
  WG_AGENT_OPERATOR_INACTIVE: { tone: 'warn', cta: true, to: '/register' },
};

/** všetky kódy, ktoré mapa pozná (test drží, že sedí s `WriteGateCode`) */
const CODES = Object.keys(CODE_META) as WriteGateCode[];

/** copy kódu v AKTUÁLONOM jazyku (getter → rešpektuje prepnutie jazyka) */
function gateCopy(code: WriteGateCode): WriteGateCopy {
  const meta = CODE_META[code] as CodeMeta;
  const key = (field: string): string => `write:codes.${code}.${field}`;
  const copy: Record<string, unknown> = { tone: meta.tone };
  if (meta.to !== undefined) copy['to'] = meta.to;
  Object.defineProperty(copy, 'headline', { enumerable: true, get: () => translate(key('headline')) });
  Object.defineProperty(copy, 'detail', { enumerable: true, get: () => translate(key('detail')) });
  if (meta.requires !== undefined && meta.requires.length > 0) {
    Object.defineProperty(copy, 'detailNoValue', {
      enumerable: true,
      get: () => translate(key('detail_no_value')),
    });
  }
  if (meta.cta === true) {
    Object.defineProperty(copy, 'cta', { enumerable: true, get: () => translate(key('cta')) });
  }
  return copy as unknown as WriteGateCopy;
}

/**
 * `WG_*` → copy. Polia sú lazy getters, aby `WRITE_GATE_COPY[code].headline`
 * vrátil text v aktuálnom jazyku aj po prepnutí prepínačom.
 */
export const WRITE_GATE_COPY: Record<WriteGateCode, WriteGateCopy> = Object.fromEntries(
  CODES.map((code) => [code, gateCopy(code)]),
) as Record<WriteGateCode, WriteGateCopy>;

/** copy pre NEZNÁMY kód (starší gateway bez `code`, alebo nový kód) */
export const UNKNOWN_WRITE_GATE_COPY: WriteGateCopy = {
  get headline(): string {
    return translate('write:codes.UNKNOWN.headline');
  },
  get detail(): string {
    return translate('write:codes.UNKNOWN.detail');
  },
  tone: 'warn',
};

/**
 * Anonym (žiadny kľúč) nie je chyba write-gate — to je stav, kým sa
 * návštevník neprihlási. Copy patrí sem, lebo banner aj composer hovoria
 * tú istú vec a preklad je na jednom mieste (`write:anonymous.*`).
 */
export const ANONYMOUS_WRITE_COPY: WriteGateCopy = {
  get headline(): string {
    return translate('write:anonymous.headline');
  },
  get detail(): string {
    return translate('write:anonymous.detail');
  },
  get cta(): string {
    return translate('write:anonymous.cta');
  },
  tone: 'info',
};

/**
 * Vyber copy pre kód. `reason` z gatewayu je fallback do detailu, ak kód
 * nepoznáme — nikdy nie ako hlavná veta, lebo gateway píše technickejšie
 * a prekladaná je práve táto mapa.
 *
 * `claimId` / `relay` / `operator` voliteľné: write-status ich nevracia
 * (vracia len `operator`), dopĺňa ich stránka registrácie / admin, kde ich
 * naozaj máme. Chýbajúca hodnota NESPÔSOBÍ, že by text ukázal `{{claimId}}`
 * — na to je `detail_no_value`.
 */
export function writeGateCopy(
  code: WriteGateCode | undefined,
  options: { reason?: string; claimId?: string; relay?: string; operator?: string | null } = {},
): WriteGateCopy & { reason?: string } {
  const meta = code !== undefined ? CODE_META[code] : undefined;
  const values: Record<CopyValue, string> = {
    // 64-hex claim sa do bubliny nezmestí — skrátime ho rovnako ako kľúč
    claimId: options.claimId !== undefined && options.claimId !== '' ? shortHex(options.claimId) : '',
    relay: options.relay ?? '',
    operator: options.operator !== undefined && options.operator !== null ? shortHex(options.operator) : '',
  };

  if (meta === undefined || code === undefined) {
    // neznámy kód / chýbajúci kód: ukážeme dôvod gatewayu tak, ako prišiel
    const base: WriteGateCopy = { ...UNKNOWN_WRITE_GATE_COPY };
    const reason = options.reason ?? '';
    return reason === '' ? base : { ...base, detail: reason, reason };
  }

  const key = `write:codes.${code}`;
  const required = meta.requires ?? [];
  const missing = required.some((field) => values[field] === '');
  const detail = missing
    ? translate(`${key}.detail_no_value`)
    : translate(`${key}.detail`, values);
  const base = gateCopy(code);
  return { ...base, detail };
}

/** 64-hex → `abcd1234…` (nikdy nezobrazujeme celý kľúč) */
export function shortHex(hex: string): string {
  return hex.length <= 12 ? hex : `${hex.slice(0, 8)}…`;
}

// ── status operátora (admin tabuľka, F4AI-24) ─────────────────────────────

export type OperatorStatus = 'pending' | 'active' | 'lapsed' | 'revoked';

export interface StatusCopy {
  label: string;
  /** vysvetlenie pre tooltip / detail riadka */
  hint: string;
  tone: CopyTone;
}

const OPERATOR_STATUSES: readonly OperatorStatus[] = ['pending', 'active', 'lapsed', 'revoked'];

/** status → copy (getters, aby sa text menil s jazykom) */
export const OPERATOR_STATUS_COPY: Record<OperatorStatus, StatusCopy> = Object.fromEntries(
  OPERATOR_STATUSES.map((status) => [
    status,
    {
      tone: ({ pending: 'info', active: 'ok', lapsed: 'warn', revoked: 'error' } as const)[status],
      get label(): string {
        return translate(`write:operator.${status}.label`);
      },
      get hint(): string {
        return translate(`write:operator.${status}.hint`);
      },
    },
  ]),
) as Record<OperatorStatus, StatusCopy>;

/** label pre status s fallbackom (neznámy status sa nepokazí) */
export function operatorStatusLabel(status: string): string {
  return OPERATOR_STATUSES.includes(status as OperatorStatus)
    ? translate(`write:operator.${status}.label`)
    : status;
}
