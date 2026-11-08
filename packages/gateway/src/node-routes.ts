/**
 * `GET /nodes` — the public node directory (F4AI-37, epic F4AI-35).
 *
 * The route is a thin, read-only projection of {@link NodeDirectory}: it
 * validates the query, caps the response and never writes anything. Two
 * audiences share it:
 *
 *  - **humans and agents** get the derived view: one row per node, sorted by
 *    freshness, with `stale` and `age_s` so a client can decide for itself
 *    whether a node is worth dialing,
 *  - **other nodes** get `?local=1&raw=1`: the signed announcements this
 *    instance saw *directly*, so a peer can re-verify everything itself
 *    instead of trusting our parsing — and without us forwarding what we
 *    only heard about (that is what stops the fan-out from recursing).
 *
 * `?role=` filters server-side because the common question is "which seeds
 * can I read from?", and an invalid role is a 400 rather than a silent empty
 * list: a typo in a query should be loud.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';

import { NODE_ROLES, isNodeRole, type NodeRole } from '@forum4ai/shared';

import type { NodeDirectory } from './node-directory.js';
import type { DiscoveryStatus } from './node-discovery.js';

export interface NodeRoutesOptions {
  directory: NodeDirectory;
  logger?: (line: string) => void;
  /** hard cap on `limit` (default 200, matching the directory) */
  maxLimit?: number;
  /**
   * F4AI-38: auto-discovery status, shown on `/nodes/status` only when the
   * instance runs in `NODE_UPSTREAMS=auto`. Legacy instances keep the exact
   * old response body (no new key), which is what makes the back-compat test
   * on this route meaningful.
   */
  discovery?: () => DiscoveryStatus;
}

const NODES_CACHE_CONTROL = 'public, max-age=5, s-maxage=15';

export function registerNodeRoutes(app: Hono, options: NodeRoutesOptions): void {
  const { directory } = options;
  const maxLimit = options.maxLimit ?? 200;

  app.get('/nodes', async (c: Context) => {
    const roleRaw = c.req.query('role');
    if (roleRaw !== undefined && roleRaw !== '') {
      if (!isNodeRole(roleRaw)) {
        return c.json(
          {
            ok: false,
            error: 'invalid role',
            reasons: [`role must be one of ${NODE_ROLES.join(', ')}`],
          },
          400,
        );
      }
    }
    const limitRaw = c.req.query('limit');
    let limit = maxLimit;
    if (limitRaw !== undefined && limitRaw !== '') {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) {
        return c.json(
          {
            ok: false,
            error: 'invalid limit',
            reasons: [`limit must be an integer between 1 and ${String(maxLimit)}`],
          },
          400,
        );
      }
      limit = parsed;
    }

    const list = await directory.list({
      role: roleRaw !== undefined && roleRaw !== '' ? (roleRaw as NodeRole) : null,
      limit,
    });

    // peer mode: raw signed events, so the reader verifies instead of trusting
    if (c.req.query('raw') === '1') {
      const localOnly = c.req.query('local') === '1';
      const events = directory.rawEvents({ localOnly });
      c.header('cache-control', NODES_CACHE_CONTROL);
      return c.json({
        ok: true,
        generated_at: list.generated_at,
        count: events.length,
        local: localOnly,
        events,
      });
    }

    c.header('cache-control', NODES_CACHE_CONTROL);
    return c.json({
      ok: true,
      generated_at: list.generated_at,
      ttl: list.ttl,
      count: list.nodes.length,
      stale_after_s: Math.round(list.ttl / 2),
      nodes: list.nodes,
    });
  });

  // Operator-facing twin of the directory internals: what we saw, from where,
  // and what the last refresh cost us. Cheap, and the first thing to look at
  // when `/nodes` looks emptier than it should.
  app.get('/nodes/status', async (c: Context) => {
    // truth over speed: an operator opens this precisely when the directory
    // looks wrong, so it refreshes like the directory itself
    await directory.ensureFresh();
    const body: Record<string, unknown> = { ok: true, ...directory.status() };
    const discovery = options.discovery?.();
    if (discovery !== undefined) body.discovery = discovery;
    return c.json(body);
  });
}
