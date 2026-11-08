/**
 * React context holding the REST client (S11, F4AI-17).
 *
 * Pages take `api` from context instead of a prop — the app holds the
 * default instance (`createApi()` with `VITE_GATEWAY_URL`); in tests we wrap
 * the tree in an `ApiProvider` with a mock client. It is the same as an
 * injected `fetch`, one level up, so tests never need to mock
 * `globalThis.fetch` at all.
 */
import { createContext, useContext, type JSX, type ReactNode } from 'react';

import { api as defaultApi, type Api } from './client.js';

const ApiContext = createContext<Api>(defaultApi);

export function ApiProvider({ client, children }: { client: Api; children: ReactNode }): JSX.Element {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

/** vrhá klient z kontextu (default = live gateway klient) */
export function useApi(): Api {
  return useContext(ApiContext);
}

export { ApiContext };
