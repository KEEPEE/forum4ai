/**
 * Operator approval/revocation as a SHARED function (F4AI-23/24, Phase 1a).
 *
 * Before Phase 1a only the CLI had it (`operator approve|revoke`). The UI needs
 * the same over HTTP (`POST /register/approve`, `POST /register/revoke` with an
 * owner NIP-98 signature), and both paths MUST behave identically — otherwise an
 * approval from the browser could forget the 30028 republish or the audit 1040
 * LABEL. That is why the logic lives here and the CLI and the route only call it.
 *
 * Semantics (design B5/B7, P1):
 *   approve  `pending|lapsed|revoked` → `active` + republish 30028
 *            `d=forum4ai-writers` (the source of truth for foreign instances),
 *   revoke   → `revoked` + republish 30028 WITHOUT the pubkey + kind 1040 LABEL
 *            (`L <pubkey> forum4ai-writers`), so the removal stays auditable
 *            even after reading foreign relays. Old events remain readable.
 *
 * The republish and the LABEL are best-effort: if a relay rejects the publish, the
 * state in the table stays changed (the gateway writes from the table) and the
 * caller gets `ok: true` with a warning — this is deliberate, the CLI behaved the
 * same way. The publish result is in `writers`/`label`, not in the return value.
 */
import type { Event } from 'nostr-tools';

import { KINDS } from '@forum4ai/shared';

import { signWithPow } from './pow.js';
import type { OperatorsDb, OperatorRow } from './operators-db.js';
import type { PublishResult } from './relay-pool.js';

/** pool, ktorú akcia potrebuje (publish LABELu); `RelayPool` ju spĺňa */
export interface OperatorActionPool {
  publish(event: Event, relays?: string[]): Promise<PublishResult[]>;
}

export interface OperatorActionDeps {
  db: OperatorsDb;
  pool: OperatorActionPool;
  /** republish 30028 `d=forum4ai-writers` z aktuálneho stavu tabuľky */
  republishWriters(): Promise<{ ok: boolean; reason?: string; event?: Event }>;
  /** 64-hex skala vlastníka (`GATEWAY_OWNER_SK_HEX`); prázdna = bez LABELu */
  ownerSkHex: string;
  /** owner pubkey; prázdny bez škály — LABEL sa neposiela (nie je kto) */
  ownerPubkey: string;
  /** NIP-13 obtiažnosť eventov gatewaya (VPS: 18) */
  publishPowMin?: number;
  logger?: (line: string) => void;
  /** injectable "teraz" v sekundách (testy) */
  now?: () => number;
}

/** výsledok publishu 30028 / 1040 — `null` = akcia nebola vôbec pokusená */
export interface OperatorActionPublish {
  ok: boolean;
  event_id?: string;
  /** doručené na N/M relayov (pre log a UI varovanie) */
  delivered?: number;
  relay_count?: number;
  reason?: string;
}

export interface OperatorActionResult {
  ok: boolean;
  /** `'not_found'` = pubkey nie je v tabuľke operátorov (404 pre HTTP) */
  reason?: string;
  /** aktualizovaný záznam, alebo `null` pri `not_found` */
  operator: OperatorRow | null;
  writers: OperatorActionPublish;
  /** `null` = bez owner škály (LABEL sa nedá podpísať) */
  label: OperatorActionPublish | null;
  /** čitateľné varovania pre UI/CLI (republish či LABEL zlyhali) */
  warnings: string[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** max dĺžka poznámky v 1040 LABEL (rovnaká ako mal CLI) */
export const LABEL_NOTE_MAX_CHARS = 120;

/** normalizácia vstupu: hex (case-insensitive); iný tvar → null */
export function normalizeOperatorPubkey(value: string): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  return HEX64.test(trimmed) ? trimmed : null;
}

function describePublish(
  results: PublishResult[],
  event: Event,
  reason?: string,
): OperatorActionPublish {
  const delivered = results.filter((result) => result.ok).length;
  return {
    ok: delivered > 0,
    event_id: event.id,
    delivered,
    relay_count: results.length,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * `pending|lapsed|revoked` → `active` + republish 30028. Identické s
 * `operator approve <npub|hex>` (CLI) — obe cesty volajú túto funkciu.
 */
export async function approveOperator(
  deps: OperatorActionDeps,
  pubkey: string,
): Promise<OperatorActionResult> {
  const log = deps.logger ?? (() => undefined);
  const normalized = normalizeOperatorPubkey(pubkey);
  if (normalized === null) {
    return {
      ok: false,
      reason: 'bad_pubkey',
      operator: null,
      writers: { ok: false, reason: 'skipped' },
      label: null,
      warnings: ['pubkey must be 64 hex characters'],
    };
  }

  const row = deps.db.setStatus(normalized, 'active');
  if (row === null) {
    return {
      ok: false,
      reason: 'not_found',
      operator: null,
      writers: { ok: false, reason: 'skipped' },
      label: null,
      warnings: [`${normalized.slice(0, 16)}… is not in the operator table`],
    };
  }

  const warnings: string[] = [];
  const republished = await deps.republishWriters();
  const writers: OperatorActionPublish = republished.event
    ? {
        ok: republished.ok,
        event_id: republished.event.id,
        ...(republished.reason !== undefined ? { reason: republished.reason } : {}),
      }
    : { ok: false, reason: republished.reason ?? 'publish_failed' };
  if (!republished.ok) {
    warnings.push(
      `failed to republish 30028 d=forum4ai-writers (${republished.reason ?? '?'}) — other instances will not see the change`,
    );
  }
  log(`approve: ${row.pubkey.slice(0, 16)}… active (relay=${row.relay || '-'}, expires=${String(row.expiresAt)})`);
  return { ok: true, operator: row, writers, label: null, warnings };
}

/**
 * → `revoked` + republish 30028 bez pubkey + kind 1040 LABEL. Identické s
 * `operator revoke <npub|hex> [--note TEXT]` (CLI).
 */
export async function revokeOperator(
  deps: OperatorActionDeps,
  pubkey: string,
  note = '',
): Promise<OperatorActionResult> {
  const log = deps.logger ?? (() => undefined);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const publishPowMin = deps.publishPowMin ?? 0;
  const normalized = normalizeOperatorPubkey(pubkey);
  if (normalized === null) {
    return {
      ok: false,
      reason: 'bad_pubkey',
      operator: null,
      writers: { ok: false, reason: 'skipped' },
      label: null,
      warnings: ['pubkey must be 64 hex characters'],
    };
  }

  const row = deps.db.setStatus(normalized, 'revoked', note);
  if (row === null) {
    return {
      ok: false,
      reason: 'not_found',
      operator: null,
      writers: { ok: false, reason: 'skipped' },
      label: null,
      warnings: [`${normalized.slice(0, 16)}… is not in the operator table`],
    };
  }

  const warnings: string[] = [];
  const republished = await deps.republishWriters();
  const writers: OperatorActionPublish = republished.event
    ? {
        ok: republished.ok,
        event_id: republished.event.id,
        ...(republished.reason !== undefined ? { reason: republished.reason } : {}),
      }
    : { ok: false, reason: republished.reason ?? 'publish_failed' };
  if (!republished.ok) {
    warnings.push(
      `30028 republish failed (${republished.reason ?? '?'}) — other instances will not see the change`,
    );
  }
  log(`revoke: ${row.pubkey.slice(0, 16)}… revoked`);

  // B7: auditný LABEL — staré eventy ostávajú čitateľné, ale je vidno,
  // KEDY a PREČO bol operátor vyradený. Bez owner škály ho nedáme podpísať.
  const ownerSk = deps.ownerSkHex.trim();
  if (deps.ownerPubkey === '' || !HEX64.test(ownerSk)) {
    return {
      ok: true,
      operator: row,
      writers,
      label: null,
      warnings: [...warnings, 'GATEWAY_OWNER_SK_HEX is not set — we will not sign the 1040 LABEL'],
    };
  }
  let label: OperatorActionPublish;
  try {
    const event = signWithPow(
      {
        kind: KINDS.LABEL,
        created_at: now(),
        tags: [
          ['L', row.pubkey, 'forum4ai-writers'],
          ['l', 'forum4ai-writers'],
          ['p', row.pubkey],
        ],
        content: note !== '' ? note.slice(0, LABEL_NOTE_MAX_CHARS) : 'revoked',
      },
      Uint8Array.from(Buffer.from(ownerSk, 'hex')),
      publishPowMin,
      deps.ownerPubkey,
    );
    const results = await deps.pool.publish(event as Event);
    label = describePublish(results, event);
    log(
      `1040 LABEL "revoked" for ${row.pubkey.slice(0, 12)}…: delivered ${String(label.delivered ?? 0)}/${String(label.relay_count ?? 0)}`,
    );
    if (!label.ok) warnings.push('the 1040 LABEL could not be published — the audit trail is not on the relay');
  } catch (err) {
    label = { ok: false, reason: err instanceof Error ? err.message : 'label_failed' };
    warnings.push(`1040 LABEL failed (${label.reason ?? '?'})`);
  }
  return { ok: true, operator: row, writers, label, warnings };
}
