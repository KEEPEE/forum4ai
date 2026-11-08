/**
 * Relay endpoints for the live integration suites.
 *
 * Default: the dev stack from `docker/docker-compose.yml` — our relay on :18080
 * plus strfry on :18008, published on loopback. Every suite probes these
 * endpoints and skips itself when they are unreachable, so a plain
 * `pnpm -r test` needs no infrastructure at all.
 *
 * To run the live suites for real, point them at any reachable relay pair:
 *
 *   F4AI_DEV_RELAY_URLS="ws://host:18080,ws://host:18008" pnpm -r test
 */
import { DEFAULT_DEV_RELAY_URLS } from '../src/relay-pool.js';

function resolveDevRelayUrls(): readonly string[] {
  const raw = process.env['F4AI_DEV_RELAY_URLS'] ?? '';
  const urls = raw
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return urls.length > 0 ? urls : DEFAULT_DEV_RELAY_URLS;
}

export const DEV_RELAY_URLS: readonly string[] = resolveDevRelayUrls();
