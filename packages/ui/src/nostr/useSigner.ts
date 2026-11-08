/**
 * `useSigner` — podpisovateľ a pubkey aktuálnej RELÁCIE (D1/D5, F4AI-19 →
 * F4AI-23/24 Phase 1b).
 *
 * Kľúčové pravidlo ostáva: kdekoľvek UI potrebuje pubkey (claimant do `a`
 * tagu, kontrola autorstva, write-status), pýta sa SIGNERA, nie nejakej
 * „uloženej identity“. Phase 1b mení len to, že signer už nie je
 * automaticky vybraný z `localStorage` — vyberá ho používáč (login modal) a
 * hook je tenký priechod na reláciu.
 *
 * `pubkey === null` je platná hodnota: anonym bez kľúča. Volajúci musia
 * riešiť null vetvu (zamknutý composer, skryté akcie), nie predpokladať,
 * že nejaky kľúč vždy je.
 */
import { useIdentity, type SessionIdentity } from './IdentityContext.js';
import type { Signer } from './signer.js';

export interface SignerState {
  /** null, kým neprebehne obnova relácie */
  signer: Signer | null;
  /** 64-hex pubkey podpisovateľa, alebo `null` (anonym) */
  pubkey: string | null;
  /** shortcut na `identity.npub` (zobrazenie), alebo `null` */
  npub: string | null;
  error: string | null;
  loading: boolean;
}

export function useSigner(): SignerState {
  const { signer, identity, error, status } = useIdentity();
  return {
    signer,
    pubkey: identity?.pubkey ?? null,
    npub: identity?.npub ?? null,
    error,
    loading: status === 'connecting',
  };
}

/** typ skôr pre dokumentáciu — to, čo volajúci dostane z `useSigner()` */
export type { SessionIdentity, Signer };
