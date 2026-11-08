/**
 * `useWriteStatus` — the write-gate state of the current signer (design B10).
 *
 * The backend allows writing to `POST /events` only for registered operators /
 * agents; the UI asks up front so it does not send events that will get a
 * 403. `GET {gateway}/write-status?pubkey=<hex>` returns
 * `{ok, pubkey, allowed, reason, via, operator}` (the route lives in
 * `gateway/src/register-routes.ts`, `write-gate.ts` makes the call).
 *
 * We take the pubkey from the ACTUAL signer (`useSigner`, NIP-07 outranks the
 * `nsec` identity) — the gateway judges the gate by the signature's `pubkey`, not by
 * `identity.pubkey`. The identity fallback keeps the UI working while the NIP-07
 * resolve is in flight; once it finishes, the state is measured again
 * automatically (`pubkey` is in deps).
 *
 * Fail-closed:
 *  - the fetch fails (offline / 4xx / 5xx) → `allowed=false`, `kind='unavailable'`
 *    and a NEUTRAL reason (`WRITE_STATUS_UNAVAILABLE`) — the banner must not claim
 *    that the user is not an operator when we merely do not know;
 *  - `kind='checking'` does not unblock the composer (it would flicker on every
 *    refetch and disturb typing); the server decides anyway, and the 403 reason
 *    comes from the response body (`ApiError.reasons`).
 */
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api/ApiContext.js';
import { useIdentity } from '../nostr/IdentityContext.js';
import { useSigner } from '../nostr/useSigner.js';
import type { WriteGateCode, WriteStatusResponse } from '../api/types.js';

/**
 * Úvodný topic inštancie — banner naň ukazuje ako „ako sa pripojiť“.
 * MUSÍ sedieť s `TOPIC_SLUG` v `scripts/seed-about.mjs` (F4AI-2b2: seed je
 * English-first, slug sa presunul z `o-com-funguje-forum`).
 */
export const HOW_IT_WORKS_SLUG = 'about-this-forum';

/**
 * neutrálny reason pri zlyhaní — od Phase 2a JAZYKOVNE NEUTRÁLNY technický
 * marker, nie veta. Veta patrí do locale (`write:status.unavailable`) a
 * renderuje ju UI; testy porovnávajú tento marker.
 */
export const WRITE_STATUS_UNAVAILABLE = 'write status unavailable';

export type WriteStatusKind = 'anonymous' | 'checking' | 'allowed' | 'denied' | 'unavailable';

export interface WriteStatusState {
  /** pubkey podpisovateľa, alebo null kým nejaky nie je */
  pubkey: string | null;
  kind: WriteStatusKind;
  /** fail-closed: `true` len keď gateway povedal `allowed: true` */
  allowed: boolean;
  /** composer je zamknutý a banner sa ukáže: `denied` alebo `unavailable` */
  locked: boolean;
  /** reason z gatewayu, `WRITE_STATUS_UNAVAILABLE`, alebo null */
  reason: string | null;
  /**
   * Stabilný kód rozhodnutia (`WG_*`) — F4AI-23. UI na ňom visuje copy
   * (`lib/write-codes.ts`); `null` = starší gateway kód neposlal, alebo
   * status sme nezistili.
   */
  code: WriteGateCode | null;
  /** `via` z gatewayu (bootstrap/operator/agent/none) — pre kontext UI */
  via: WriteStatusResponse['via'] | null;
  /** pubkey operátora, pod ktorého zápis spadá (agent → operátor) */
  operator: string | null;
  /** vynúti nové meranie (napr. po publishi, ktorý dostal 403) */
  refresh: () => void;
}

export function useWriteStatus(): WriteStatusState {
  const api = useApi();
  const { identity } = useIdentity();
  const { signer } = useSigner();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Omit<WriteStatusState, 'refresh'>>({
    pubkey: null,
    kind: 'anonymous',
    allowed: false,
    locked: false,
    reason: null,
    code: null,
    via: null,
    operator: null,
  });

  // podpisovateľ (NIP-07) má prednosť pred nsec identitou — presne tento
  // pubkey uvidí gateway na POST /events
  const pubkey = signer?.pubkey ?? identity?.pubkey ?? null;

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (pubkey === null) {
      setState({
        pubkey: null,
        kind: 'anonymous',
        allowed: false,
        locked: false,
        reason: null,
        code: null,
        via: null,
        operator: null,
      });
      return;
    }
    let cancelled = false;
    // `checking` NEMENÍ `locked` — composer zostáva v stave, v akom bol,
    // kým nedorazí odpoveď (žiadne blikanie tlačidiel pri refetci)
    setState((prev) => ({ ...prev, pubkey, kind: 'checking' }));
    api
      .writeStatus(pubkey)
      .then((status) => {
        if (cancelled) return;
        setState({
          pubkey,
          kind: status.allowed ? 'allowed' : 'denied',
          allowed: status.allowed === true,
          locked: status.allowed !== true,
          reason: status.reason,
          code: status.code ?? null,
          via: status.via ?? null,
          operator: status.operator ?? null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          pubkey,
          kind: 'unavailable',
          allowed: false,
          locked: true,
          reason: WRITE_STATUS_UNAVAILABLE,
          code: null,
          via: null,
          operator: null,
        });
      });
    return () => {
      cancelled = true;
    };
    // `pubkey` v deps = refresh po zmene identity / signera
  }, [api, pubkey, nonce]);

  return { ...state, refresh };
}
