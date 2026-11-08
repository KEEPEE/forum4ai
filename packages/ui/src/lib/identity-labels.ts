/**
 * Popisky relácie (F4AI-23/24, Phase 1b → Phase 2a i18n) — JEDNO miesto
 * pre text okolo podpisového pozadia, aby header, login modal aj
 * nastavenia nehovorili každá inak.
 *
 * Phase 2a: text je v `locales/{en,sk}/common.json` pod
 * `common:identity.badge.*` / `common:identity.disconnect.*` /
 * `common:identity.sourceHint.*`. Exporty ostávajú objekty, ale polia sú
 * getters → po prepnutí jazyka vrátia aktuálny text.
 */
import type { SignerSource } from '../nostr/signer.js';
import { t } from '../i18n/text.js';

const SOURCES: readonly SignerSource[] = ['nip07', 'bunker', 'nsec', 'anonymous'];

/** krátky odznak pozadia — technická značka, ktorú používáč pozná */
export const SOURCE_BADGES: Record<SignerSource, string> = {
  get nip07(): string {
    return t('common:identity.badge.nip07');
  },
  get bunker(): string {
    return t('common:identity.badge.bunker');
  },
  get nsec(): string {
    return t('common:identity.badge.nsec');
  },
  get anonymous(): string {
    return t('common:identity.badge.anonymous');
  },
};

/** čo sa SKUTOČNE stane po kliku na „odpojiť“ (líši sa podľa pozadia) */
export const DISCONNECT_LABELS: Record<SignerSource, string> = {
  get nip07(): string {
    return t('common:identity.disconnect.nip07');
  },
  get bunker(): string {
    return t('common:identity.disconnect.bunker');
  },
  get nsec(): string {
    return t('common:identity.disconnect.nsec');
  },
  get anonymous(): string {
    return t('common:identity.disconnect.anonymous');
  },
};

/** odznak + vysvetlenie, aby title atribút nepotreboval vlastnú vetu */
export function sourceBadge(source: SignerSource | string): string {
  return SOURCES.includes(source as SignerSource) ? t(`common:identity.badge.${source}`) : String(source);
}

/** popisek tlačidla odpojenia pre dané pozadie */
export function disconnectLabel(source: SignerSource | string): string {
  return SOURCES.includes(source as SignerSource) ? t(`common:identity.disconnect.${source}`) : t('common:actions.disconnect');
}

/** pozadia, ktoré majú vysvetlenie (anonym nič nevysvetľuje) */
const HINT_SOURCES: readonly SignerSource[] = ['nip07', 'bunker', 'nsec'];

/** vysvetlenie, kde kľúč reálne je (title atribút identity) */
export function sourceHint(source: SignerSource | string): string {
  return HINT_SOURCES.includes(source as SignerSource) ? t(`common:identity.sourceHint.${source}`) : '';
}
