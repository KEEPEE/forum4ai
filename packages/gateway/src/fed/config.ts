/**
 * Parsing `GATEWAY_UPSTREAM_GATEWAYS` (Phase 6a, design Q5).
 *
 * Design Q5 defines upstreams as **static configuration** (no discovery kind):
 * `GATEWAY_UPSTREAM_GATEWAYS` is a comma-separated list of base URLs of other
 * instances' gateways and each instance's id is the host of its URL. That is
 * also the value that `origin` carries in `/search` results — the UI draws the
 * chip "from aiforum.myhood.sk" from it.
 *
 * Tolerated item forms:
 *   `https://aiforum.myhood.sk/api`   a public instance behind Caddy (the default
 *                                     form from the design)
 *   `http://127.0.0.1:18081`          a dev instance without TLS (the port is part
 *                                     of the id — `127.0.0.1:18081`)
 *   `aiforum.myhood.sk`               a bare host → we prepend `https://`
 *                                     (a safe default: a public instance is
 *                                     always TLS; dev must write `http://`
 *                                     explicitly, so it does not rely on this)
 *
 * `GATEWAY_UPSTREAM_IDS` overrides ids BY POSITION (the first id belongs to the
 * first URL). What for: two instances behind the same reverse proxy (e.g.
 * `localhost:3001` and `localhost:3002` in tests/E2E) have the same host:port,
 * and without the override their `origin` could not be told apart.
 */
import { upstreamIdFromUrl } from '@forum4ai/shared';

export interface FedUpstreamConfig {
  id: string;
  baseUrl: string;
}

export interface ParsedUpstreams {
  upstreams: FedUpstreamConfig[];
  /** čo sme zahodili a prečo — ide do logu, nie do ticha */
  warnings: string[];
}

/** položky zoznamu delíme čiarkou aj bielym znakom (compose to vie tak aj tak) */
function splitList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** doplní schému, ak chýba (default `https://`) */
function withScheme(entry: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) return entry;
  return `https://${entry}`;
}

export function parseUpstreamGateways(
  gatewaysRaw: string,
  idsRaw = '',
): ParsedUpstreams {
  const entries = splitList(gatewaysRaw);
  const idOverrides = splitList(idsRaw);
  const warnings: string[] = [];
  const byId = new Map<string, string>();

  entries.forEach((entry, index) => {
    const url = withScheme(entry);
    const parsed = upstreamIdFromUrl(url);
    if (parsed === null) {
      warnings.push(`upstream #${String(index + 1)} ${JSON.stringify(entry)}: not an http(s) URL — ignored`);
      return;
    }
    const override = idOverrides[index];
    const id = override !== undefined && override !== '' ? override.trim().toLowerCase() : parsed;
    if (byId.has(id)) {
      warnings.push(`upstream id ${id} is duplicated — keeping ${JSON.stringify(byId.get(id) ?? '')}`);
      return;
    }
    byId.set(id, url.replace(/\/+$/, ''));
  });

  if (idOverrides.length > entries.length) {
    warnings.push(
      `GATEWAY_UPSTREAM_IDS has ${String(idOverrides.length)} ids but only ${String(entries.length)} gateways — extra ids ignored`,
    );
  }

  return {
    upstreams: [...byId.entries()].map(([id, baseUrl]) => ({ id, baseUrl })),
    warnings,
  };
}
