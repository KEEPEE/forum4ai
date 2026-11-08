/**
 * Parsing markdown fence metadata (the fence info string) — moved from
 * `packages/ui/src/components/RichContent.tsx` into shared in Phase 4a.
 *
 * Reason: the gateway paper lint (Phase 4a) must read `fig=<id>` from the
 * info string ` ```mermaid fig=arch caption="…" `, but the gateway CANNOT
 * import the UI (the UI is a React/Vite package, and it would also be a
 * workspace package cycle). Moving it to one place keeps the logic from
 * being copied — the UI keeps its re-export from `RichContent.tsx`, so its
 * public API (and 452 tests) stay unchanged.
 *
 * Format (design Q3 / Q4):
 *   ```mermaid fig=arch caption="Replication topology"
 *   ```chart   fig=lat caption='p95 latency' tbl=x
 * The info string carries `key=value` pairs; a value may be unspaced, in
 * double or in single quotes. We DELIBERATELY LEAVE unknown keys PARSEABLE
 * (parseFenceAttrs), but the typed projection (`FenceMeta`) takes only what
 * the UI actually renders — metadata is decoration, not validated input.
 */

/** metadata zárezu, ktoré UI renderuje: `fig=arch caption="Replication topology"` */
export interface FenceMeta {
  fig?: string;
  caption?: string;
}

/** všetky `kľúč=hodnota` páry info reťazca (kľúče lowercase) */
export function parseFenceAttrs(meta: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (meta === undefined || meta.trim() === '') return out;
  const pattern = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match = pattern.exec(meta);
  while (match !== null) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (key !== undefined && key !== '' && value !== '') out[key] = value;
    match = pattern.exec(meta);
  }
  return out;
}

/**
 * Parciuj fence metadata. Hodnoty môžu byť bez medzier alebo v úvodzovkách;
 * neznáme kľúče ignorujeme (metadata sú dekorácia, nie validovaný vstup).
 * Dĺžkové strihy (`fig` 64, `caption` 240) sú súčasťou kontraktu — UI ich
 * renderuje bez ďalšieho orezávania.
 */
export function parseFenceMeta(meta: string | undefined): FenceMeta {
  const attrs = parseFenceAttrs(meta);
  const out: FenceMeta = {};
  const fig = attrs['fig'];
  const caption = attrs['caption'];
  if (fig !== undefined && fig !== '') out.fig = fig.slice(0, 64);
  if (caption !== undefined && caption !== '') out.caption = caption.slice(0, 240);
  return out;
}
