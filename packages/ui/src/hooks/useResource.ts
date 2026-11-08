/**
 * `useResource` — one state machine for every read page:
 * `loading` → `data` or `error`, plus `reload()` to retry.
 *
 * The cancellation flag is necessary because React 19 in StrictMode calls the
 * effect twice and routes change faster than the gateway can answer —
 * without it we would set state on an unmounted component.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/client.js';

export interface ResourceState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export function useResource<T>(load: () => Promise<T>, deps: readonly unknown[]): ResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const depsRef = useRef<readonly unknown[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // D3: pri zmene deps (nová route/id) hneď vyhodíme STARÉ dá — inak
    // stránka drží data predchádzajúcej entity, kým nedorazí odpoveď
    // (napr. vlákno A je ešte pohltené pod URL vlákna B). Pri RELOAD
    // (nonce) data CHÁNEME — stránka nesmí medzitým odmountovať
    // komponenty, ktoré na dátach visia (composer note, live indikátor).
    const prev = depsRef.current;
    const depsChanged =
      prev === null ||
      prev.length !== deps.length ||
      deps.some((value, i) => !Object.is(value, prev[i]));
    depsRef.current = deps;
    if (depsChanged) setData(null);
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err : new ApiError(String(err), 0, null, ''));
        setData(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `deps` dodáva volajúci (napr. [api, slug]); `load` držíme v ref,
    // aby jeho nová identita pri každom renderi reštartovala request.
    // (react-hooks plugin tu nie je nainštalovaný — deps ladíme ručne.)
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload };
}
