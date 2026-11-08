/**
 * `useOwner` — is the current signer the instance OWNER? (F4AI-24)
 *
 * The owner is the only one who can approve or remove operators
 * (`gateway/src/owner-auth.ts` → 403 `NOT_OWNER` for anyone else). The UI
 * needs to know this BEFORE it shows someone the operators page, otherwise it
 * would offer them buttons that answer with 403.
 *
 * Source: `GET /api/register/owner` — a PUBLIC route (the owner pubkey is
 * written into 30028 `d=forum4ai-writers`, it is no secret), so it can be
 * called without a signature. `owner === null` means the instance has no owner
 * (`GATEWAY_OWNER_SK_HEX` unset) → no UI approval at all, and the
 * admin page shows the reason.
 *
 * Fail-closed: a network error → `isOwner: false`. The operators page is
 * shown only on a positive confirmation; the owner gets it anyway because the
 * gateway is the authority (only someone who forces the page with a direct URL
 * gets a 403 — and there the page shows it with a truthful state).
 */
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api/ApiContext.js';
import { useIdentity } from '../nostr/IdentityContext.js';

export interface OwnerState {
  /** owner pubkey z `GET /register/owner`, alebo `null` (nenastavený / nezistený) */
  owner: string | null;
  /** `true` len keď poznáme owner AJ podpisovateľa a sú tí istí */
  isOwner: boolean;
  /** prebieha prvé meranie */
  loading: boolean;
  /** chybový stav (gateway neodpovedal) — `isOwner` je vtedy false */
  error: string | null;
  refresh: () => void;
}

export function useOwner(): OwnerState {
  const api = useApi();
  const { identity } = useIdentity();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Omit<OwnerState, 'refresh' | 'isOwner'>>({
    owner: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    api
      .registerOwner()
      .then((response) => {
        if (cancelled) return;
        setState({ owner: response.owner ?? null, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          owner: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api, nonce]);

  const pubkey = identity?.pubkey ?? null;
  return {
    ...state,
    isOwner: state.owner !== null && pubkey !== null && state.owner === pubkey,
    refresh,
  };
}
