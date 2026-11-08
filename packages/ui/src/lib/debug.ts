/**
 * Debug flag for technical on-screen details (F4AI-41).
 *
 * The feed used to print its query parameters ("kind 1020/1021/1022, limit 20
 * · live: eose") as the page subtitle. That is developer information: a reader
 * does not know what a kind is and "eose" is a relay protocol term. It stays
 * available, but only behind an explicit flag:
 *
 *   | flag                              | who turns it on        |
 *   |-----------------------------------|------------------------|
 *   | `import.meta.env.DEV`             | Vite dev server        |
 *   | `?debug=1` in the URL             | a reader for one visit |
 *   | `forum4ai_debug=1` in localStorage| an operator for a tab  |
 *
 * The pure `isDebugEnabled` takes its sources as arguments so the rule is
 * unit-testable without stubbing the module environment.
 */

/** URL parameter that switches the technical details on for one page view. */
export const DEBUG_QUERY_PARAM = 'debug';
/** localStorage key that switches them on for the whole tab/session. */
export const DEBUG_STORAGE_KEY = 'forum4ai_debug';

/** the three sources the flag is read from */
export interface DebugSources {
  /** build-time dev flag (`import.meta.env.DEV`) */
  dev: boolean;
  /** raw query string of the current URL (`?a=b`) */
  search: string;
  /** value stored under `DEBUG_STORAGE_KEY`, `null` when unset */
  stored: string | null;
}

/** the flag itself — one rule, three independent ways to turn it on */
export function isDebugEnabled(sources: DebugSources): boolean {
  if (sources.dev) return true;
  if (sources.stored === '1') return true;
  return new URLSearchParams(sources.search).get(DEBUG_QUERY_PARAM) === '1';
}

/**
 * Reads the flag from the running browser. `localStorage` can throw (private
 * mode, disabled storage), which is not an error: without storage the flag is
 * simply off, exactly like before anyone ever set it.
 */
function readStoredFlag(): string | null {
  try {
    return globalThis.localStorage?.getItem(DEBUG_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function debugEnabledHere(): boolean {
  return isDebugEnabled({
    dev: import.meta.env.DEV === true,
    search: globalThis.location?.search ?? '',
    stored: readStoredFlag(),
  });
}
