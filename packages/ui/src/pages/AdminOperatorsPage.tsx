/**
 * Stránka operátorov (F4AI-24, Phase 1b) — `/admin/operators`.
 *
 * Vlastník inštancie tu vidí VŠETKÝCH operátorov (pending, aktívnych,
 * vypršaných, zrušených) a môže ich schváliť alebo vyradiť priamo z
 * prehliadača. Dve veci, ktoré to drží pri rozume:
 *
 *  1. **Rozhoduje gateway, nie UI.** Zoznam je `GET /api/register/pending`
 *     (NIP-98, owner-only) a schválenie je `POST /api/register/approve` —
 *     TÁ ISTÁ funkcia ako CLI `operator approve` (`operator-actions.ts`),
 *     takže sa UI a CLI nemôžu rozísť. Tlačidlo preto nemôže „marknúť“
 *     riadok lokálne; po akcii sa zoznam NECHÁ prečítať znova.
 *  2. **200 nie je vždy úplný úspech.** approve prepíše 30028
 *     `d=forum4ai-writers` a pri revokácii pridá 1040 LABEL — oba publishy
 *     sú best-effort. Ak sa nepodarili, riadok je v DB správne, ale relays
 *     o tom nevedia. Preto ukážeme `writers`/`label` a `warnings` TAK, ako
 *     prišli, nie green checkmark.
 *
 * Prístup: stránku ukážeme len keď `GET /api/register/owner` povie, že
 * aktuálny podpisovateľ JE vlastník. `owner === null` (inštancia bez
 * `GATEWAY_OWNER_SK_HEX`) je vlastný stav — povieme prečo nikto neschvaľuje.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { ApiError } from '../api/client.js';
import { useIdentity } from '../nostr/IdentityContext.js';
import { useOwner } from '../hooks/useOwner.js';
import { buildNip98Auth, gatewayUrl } from '../nostr/nip98.js';
import { npubShort } from '../lib/npub.js';
import { FedStatePanel } from '../components/FedStatePanel.js';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/format.js';
import { OPERATOR_STATUS_COPY, operatorStatusLabel, shortHex } from '../lib/write-codes.js';
import { t as tr } from '../i18n/text.js';
import type { OperatorRecord, OperatorActionResultResponse, RegisterPendingResponse } from '../api/types.js';

/**
 * chybové kódy owner route → veta (zdroj kódu: `gateway/src/owner-auth.ts`).
 * Gettery → text sa pýta i18n v aktuálnom jazyku (`admin:errors.*`).
 */
export const OWNER_ERROR_COPY: Record<string, string> = {
  get OWNER_NOT_CONFIGURED(): string {
    return tr('admin:errors.OWNER_NOT_CONFIGURED');
  },
  get AUTH_NIP98_INVALID(): string {
    return tr('admin:errors.AUTH_NIP98_INVALID');
  },
  get NOT_OWNER(): string {
    return tr('admin:errors.NOT_OWNER');
  },
  get BAD_REQUEST(): string {
    return tr('admin:errors.BAD_REQUEST');
  },
  get BODY_TOO_LARGE(): string {
    return tr('admin:errors.BODY_TOO_LARGE');
  },
  get OPERATOR_NOT_FOUND(): string {
    return tr('admin:errors.OPERATOR_NOT_FOUND');
  },
};

type PageState = 'loading' | 'ready' | 'error' | 'no-signer' | 'not-owner' | 'no-owner';

interface Flash {
  tone: 'ok' | 'warn' | 'error';
  text: string;
  detail?: string;
}

export function AdminOperatorsPage(): JSX.Element {
  const { t } = useTranslation(['admin', 'common']);
  const api = useApi();
  const { signer, identity } = useIdentity();
  const owner = useOwner();
  const [pageState, setPageState] = useState<PageState>('loading');
  const [body, setBody] = useState<RegisterPendingResponse | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async (): Promise<void> => {
    if (signer === null || signer.pubkey === null) {
      setPageState('no-signer');
      return;
    }
    setBody(null);
    try {
      const auth = await buildNip98Auth(signer, {
        url: gatewayUrl(api.baseUrl, '/register/pending'),
        method: 'GET',
      });
      const response = await api.registerPending(auth.authorization);
      setBody(response);
      // owner overujeme až TU, lebo gateway je autorita: jeho teliesko
      // obsahuje `owner` a ten musi sedieť s podpisovateľom
      const ownerPk = response.owner;
      if (ownerPk === '' || ownerPk === null) setPageState('no-owner');
      else if (ownerPk !== signer.pubkey) setPageState('not-owner');
      else setPageState('ready');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'NETWORK';
      setFlash({
        tone: 'error',
        text: OWNER_ERROR_COPY[code] ?? t('errors.loadFailed', { code }),
        detail: err instanceof ApiError ? err.reasons.join('; ') : err instanceof Error ? err.message : String(err),
      });
      setPageState(code === 'OWNER_NOT_CONFIGURED' ? 'no-owner' : 'error');
    }
  }, [api, signer]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: 'approve' | 'revoke', row: OperatorRecord, noteText?: string): Promise<void> {
    if (signer === null) return;
    setBusy(`${action}:${row.pubkey}`);
    setFlash(null);
    const payload: Record<string, unknown> = { pubkey: row.pubkey };
    if (action === 'revoke' && (noteText ?? '').trim() !== '') payload.note = (noteText ?? '').trim();
    try {
      const path = action === 'approve' ? '/register/approve' : '/register/revoke';
      const auth = await buildNip98Auth(signer, {
        url: gatewayUrl(api.baseUrl, path),
        method: 'POST',
        payload,
      });
      const result =
        action === 'approve'
          ? await api.registerApprove(auth.rawBody ?? '', auth.authorization)
          : await api.registerRevoke(auth.rawBody ?? '', auth.authorization);
      setFlash(describeAction(action, result));
      setRevoking(null);
      setNote('');
      await load();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'NETWORK';
      setFlash({
        tone: 'error',
        text: OWNER_ERROR_COPY[code] ?? t('errors.actionFailed', { code }),
        detail: err instanceof ApiError ? err.reasons.join('; ') : err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  // ── stavy pred tabuľkou ────────────────────────────────────────────────
  if (pageState === 'no-signer') {
    return (
      <section className="glass-panel state" data-testid="admin-no-signer">
        <p className="state-title">{t('states.noSignerTitle')}</p>
        <p className="state-detail">{t('states.noSignerDetail')}</p>
      </section>
    );
  }
  if (pageState === 'not-owner') {
    return (
      <section className="glass-panel state" data-testid="admin-not-owner">
        <p className="state-title">{t('states.notOwnerTitle')}</p>
        <p className="state-detail">
          {t('states.notOwnerDetail', { owner: shortHex(owner.owner ?? '') })}{' '}
          <Link to="/settings">{t('common:nav.members')}</Link>.
        </p>
      </section>
    );
  }
  if (pageState === 'no-owner') {
    return (
      <section className="glass-panel state" data-testid="admin-no-owner">
        <p className="state-title">{t('states.noOwnerTitle')}</p>
        <p className="state-detail">{t('states.noOwnerDetail')}</p>
      </section>
    );
  }
  if (pageState === 'error') {
    return (
      <section className="glass-panel state state-error" data-testid="admin-error">
        <p className="state-title">{t('states.errorTitle')}</p>
        {flash !== null && <p className="state-detail" data-testid="admin-error-detail">{flash.text}</p>}
        <button type="button" className="retry-btn" data-testid="admin-retry" onClick={() => void load()}>
          {t('common:actions.retry')}
        </button>
      </section>
    );
  }
  if (pageState === 'loading' || body === null) {
    return (
      <section className="glass-panel state" data-testid="admin-loading">
        <p className="state-title">{t('states.loading')}</p>
      </section>
    );
  }

  const rows = body.operators;
  return (
    <section className="stack" data-testid="admin-operators">
      <div className="page-head">
        <h1 className="page-title">{t('page.title')}</h1>
        <p className="page-subtitle" data-testid="admin-owner">
          {t('page.ownerLabel')} {npubShort(owner.owner ?? identity?.pubkey ?? '')} · {summaryText(body)}
        </p>
      </div>

      {flash !== null && (
        <p className={flash.tone === 'error' ? 'notice error' : 'notice'} role="status" data-testid="admin-flash">
          {flash.text}
          {flash.detail !== undefined && <span className="state-detail"> {flash.detail}</span>}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="state-detail" data-testid="admin-empty">
          {t('page.emptyPrefix')} <Link to="/register">/register</Link> {t('page.emptySuffix')}
        </p>
      ) : (
        <table className="event-card" data-testid="operators-table">
          <thead>
            <tr>
              <th>{t('table.operator')}</th>
              <th>{t('table.relay')}</th>
              <th>{t('table.claim')}</th>
              <th>{t('table.status')}</th>
              <th>{t('table.expires')}</th>
              <th>{t('table.agents')}</th>
              <th>{t('table.action')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <OperatorRowView
                key={row.pubkey}
                row={row}
                busy={busy}
                revoking={revoking === row.pubkey}
                note={note}
                onNote={setNote}
                onApprove={() => void act('approve', row)}
                onRevokeRequest={() => {
                  setRevoking(row.pubkey);
                  setNote('');
                }}
                onRevokeCancel={() => {
                  setRevoking(null);
                  setNote('');
                }}
                onRevoke={() => void act('revoke', row, note)}
              />
            ))}
          </tbody>
        </table>
      )}

      {/*
        Phase 6b: stav federácie. Panel je SOUČÁSTI len tohto stavu
        (`pageState === 'ready'` = sme owner), lebo `/fed/state` je
        owner route. Na gatewayi bez 6a sa sám odhlási (404 → `null`),
        takže stránka vyzerá presne ako pred 6b.
      */}
      <FedStatePanel />
    </section>
  );
}

function OperatorRowView({
  row,
  busy,
  revoking,
  note,
  onNote,
  onApprove,
  onRevokeRequest,
  onRevokeCancel,
  onRevoke,
}: {
  row: OperatorRecord;
  busy: string | null;
  revoking: boolean;
  note: string;
  onNote: (value: string) => void;
  onApprove: () => void;
  onRevokeRequest: () => void;
  onRevokeCancel: () => void;
  onRevoke: () => void;
}): JSX.Element {
  const { t } = useTranslation(['admin', 'common']);
  const status = OPERATOR_STATUS_COPY[row.status] ?? {
    label: operatorStatusLabel(row.status),
    hint: '',
    tone: 'info' as const,
  };
  const approveBusy = busy === `approve:${row.pubkey}`;
  const revokeBusy = busy === `revoke:${row.pubkey}`;

  return (
    <tr data-testid={`operator-row-${row.pubkey}`}>
      <td>
        <span className="pubkey-chip" title={row.pubkey} data-testid={`operator-npub-${row.pubkey}`}>
          {npubShort(row.pubkey)}
        </span>
        {row.note !== '' && <span className="tag-chip" title={row.note}>{row.note}</span>}
      </td>
      <td className="event-meta" title={row.relay}>{shortHex(row.relay.replace(/^wss?:\/\//, ''))}</td>
      <td className="event-meta" title={row.claim_id}>
        <span data-testid={`operator-claim-${row.pubkey}`}>{row.claim_id === '' ? '—' : shortHex(row.claim_id)}</span>
        {row.fail_count > 0 && (
          <span
            className="tag-chip"
            data-testid={`operator-fails-${row.pubkey}`}
            title={t('row.failTitle')}
          >
            fail {String(row.fail_count)}
          </span>
        )}
      </td>
      <td>
        <span className={`kind-badge ${status.tone}`} data-testid={`operator-status-${row.pubkey}`} title={status.hint}>
          {status.label}
        </span>
      </td>
      <td className="event-meta" data-testid={`operator-expiry-${row.pubkey}`} title={formatAbsoluteTime(row.expires_at)}>
        {formatRelativeTime(row.expires_at)}
      </td>
      <td className="event-meta" data-testid={`operator-agents-${row.pubkey}`}>
        {row.agents.length === 0 ? (
          '—'
        ) : (
          <>
            {String(row.agents.length)}{' '}
            {row.agents.map((agent) => (
              <span key={agent} className="tag-chip" title={t('row.agentTitle', { agent })}>
                {npubShort(agent)}
              </span>
            ))}
          </>
        )}
      </td>
      <td>
        {revoking ? (
          <div className="stack">
            <input
              value={note}
              maxLength={120}
              placeholder={t('row.notePlaceholder')}
              data-testid={`operator-note-${row.pubkey}`}
              onChange={(event) => {
                onNote(event.target.value);
              }}
            />
            <button type="button" className="ghost-btn" data-testid={`operator-revoke-confirm-${row.pubkey}`} disabled={revokeBusy} onClick={onRevoke}>
              {revokeBusy ? t('actions.revoking') : t('actions.revoke')}
            </button>
            <button type="button" className="ghost-btn" onClick={onRevokeCancel}>
              {t('common:actions.cancel')}
            </button>
          </div>
        ) : (
          <>
            {row.status !== 'active' && (
              <button
                type="button"
                className="primary-btn"
                data-testid={`operator-approve-${row.pubkey}`}
                disabled={approveBusy}
                onClick={onApprove}
              >
                {approveBusy ? t('actions.approving') : t('actions.approve')}
              </button>
            )}
            {row.status !== 'revoked' && (
              <button
                type="button"
                className="ghost-btn"
                data-testid={`operator-revoke-${row.pubkey}`}
                disabled={revokeBusy}
                onClick={onRevokeRequest}
              >
                {revokeBusy ? t('actions.revoking') : t('actions.revoke')}
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

/** súhrn pre titulek: počty podľa statusu (z `counts`, nie z rows) */
function summaryText(body: RegisterPendingResponse): string {
  const { counts } = body;
  return tr('admin:page.summary', {
    pending: String(counts.pending),
    active: String(counts.active),
    lapsed: String(counts.lapsed),
    revoked: String(counts.revoked),
  });
}

/**
 * 200 s varovaniami: akcia prebehla, ale publish 30028/1040 mohol zlyhať.
 * Text povieme TAK, ako to gateway popísal — UI nič nepridáva.
 */
function describeAction(action: 'approve' | 'revoke', result: OperatorActionResultResponse): Flash {
  const who = npubShort(result.operator.pubkey);
  const head =
    action === 'approve' ? tr('admin:flash.approved', { who }) : tr('admin:flash.revoked', { who });
  const problems: string[] = [];
  if (result.writers !== null && result.writers.ok !== true) {
    problems.push(
      tr('admin:flash.writersFailed', { reason: result.writers.reason ?? tr('admin:flash.noReason') }),
    );
  }
  if (result.label !== null && result.label.ok !== true) {
    problems.push(
      tr('admin:flash.labelFailed', { reason: result.label.reason ?? tr('admin:flash.noReason') }),
    );
  }
  problems.push(...result.warnings);
  if (problems.length === 0) {
    const delivered = result.writers?.delivered ?? 0;
    const total = result.writers?.relay_count ?? 0;
    return {
      tone: 'ok',
      text: tr('admin:flash.published', {
        head,
        delivered: String(delivered),
        total: String(total),
        relays: tr('admin:table.relaysCount', { count: total }),
      }),
    };
  }
  return { tone: 'warn', text: tr('admin:flash.problems', { head, problems: problems.join('; ') }) };
}
