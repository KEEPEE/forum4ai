/**
 * Relay endpoints for the live integration suites (see the same file in
 * `packages/gateway/test`). Default is the dev stack from
 * `docker/docker-compose.yml`; the suites skip themselves when the relays are
 * unreachable. Override with
 * `F4AI_DEV_RELAY_URLS="ws://host:18080,ws://host:18008" pnpm -r test`.
 */
import { DEFAULT_DEV_RELAY_URLS } from '@forum4ai/gateway';

function resolveDevRelayUrls(): readonly string[] {
  const raw = process.env['F4AI_DEV_RELAY_URLS'] ?? '';
  const urls = raw
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return urls.length > 0 ? urls : DEFAULT_DEV_RELAY_URLS;
}

export const DEV_RELAY_URLS: readonly string[] = resolveDevRelayUrls();
