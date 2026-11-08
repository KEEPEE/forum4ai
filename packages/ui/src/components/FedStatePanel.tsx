/**
 * Federation state panel (Phase 6b, optional part of the task) — the admin
 * screen `/admin/operators` gets what only a human at the CLI used to know: which
 * upstreams the queue is lagging behind, where the checkpoint is, and what failed.
 *
 * Two rules that hold the scope down:
 *
 *  1. **The panel hides itself.** `GET /fed/state` is an owner route added only
 *     in 6a — an older gateway answers 404, an instance without federation has
 *     it mounted but with no upstreams, and a non-owner gets 403. All
 *     THREE of those states mean "there is nothing to show here", not a page
 *     error — hence no error panel, just `null`. The admin page
 *     therefore stays functional on every gateway.
 *  2. **Resync is NIP-98, not a password.** `buildNip98Auth` hashes the request BODY,
 *     so we must send EXACTLY the string we signed (`payload: {}` → `'{}'`);
 *     `auth.rawBody` is the only allowed source of the body. We sign the path already
 *     with `encodeURIComponent` — `nip98UrlCandidates` tolerates swapping the
 *     scheme/port/`/api` prefix, NOT a path change, so we never sign a URL other
 *     than the one we then call.
 *
 * Deliberate omissions (see the report): charts, auto-polling, editing the
 * checkpoint. The queue is only READ here — the only change the panel allows is
 * resync, because 6a restored it without a risk of duplicates (dedup per
 * event id holds).
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { ApiError } from '../api/client.js';
import { useIdentity } from '../nostr/IdentityContext.js';
import { buildNip98Auth, gatewayUrl } from '../nostr/nip98.js';
import { formatRelativeTime } from '../lib/format.js';
import type { FedStateResponse } from '../api/types.js';

/** ms → relatívny čas (`formatRelativeTime` chce sekundy, fed.db má ms) */
function sinceMs(unixMs: number): string {
  return unixMs > 0 ? formatRelativeTime(Math.floor(unixMs / 1000)) : '—';
}

export function FedStatePanel(): JSX.Element | null {
  const { t } = useTranslation('admin');
  const api = useApi();
  const { signer } = useIdentity();
  const [state, setState] = useState<FedStateResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (signer === null || signer.pubkey === null) return;
    try {
      const auth = await buildNip98Auth(signer, {
        url: gatewayUrl(api.baseUrl, '/fed/state'),
        method: 'GET',
      });
      setState(await api.fedState(auth.authorization));
    } catch {
      // 404 (gateway pred 6a) / 403 (nie sme owner) / 500 — panel zmizne.
      // Admin stránka operátorov nesmie byť nečitateľná preto, že inštancia
      // nefederuje.
      setState(null);
    }
  }, [api, signer]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resync(id: string): Promise<void> {
    if (signer === null) return;
    setBusy(id);
    setFlash(null);
    try {
      const path = `/fed/resync/${encodeURIComponent(id)}`;
      const auth = await buildNip98Auth(signer, {
        url: gatewayUrl(api.baseUrl, path),
        method: 'POST',
        payload: {},
      });
      const done = await api.fedResync(id, auth.rawBody ?? '{}', auth.authorization);
      setFlash(t('fed.resyncDone', { id, checkpoint: done.checkpoint }));
      await load();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'NETWORK';
      setFlash(t('fed.resyncFailed', { code }));
    } finally {
      setBusy(null);
    }
  }

  if (state === null || signer === null) return null;
  const upstreams = state.federation.upstreams ?? [];
  const dead = upstreams.flatMap((u) => u.dead_letters ?? []);

  return (
    <section className="glass-panel" style={{ padding: 20 }} data-testid="fed-state">
      <div className="page-head">
        <p className="side-title" data-testid="fed-state-title">
          {t('fed.title')}
        </p>
        <p className="state-detail" data-testid="fed-state-note">
          {state.federation.enabled ? t('fed.note') : t('fed.disabled')}
        </p>
      </div>

      {flash !== null && (
        <p className="notice" role="status" data-testid="fed-flash">
          {flash}
        </p>
      )}

      {upstreams.length === 0 ? (
        <p className="state-detail" data-testid="fed-state-empty">
          {t('fed.empty')}
        </p>
      ) : (
        <table className="event-card" data-testid="fed-state-table">
          <thead>
            <tr>
              <th>{t('fed.colUpstream')}</th>
              <th>{t('fed.colCheckpoint')}</th>
              <th>{t('fed.colQueue')}</th>
              <th>{t('fed.colPulled')}</th>
              <th>{t('fed.colLastError')}</th>
              <th>{t('fed.colAction')}</th>
            </tr>
          </thead>
          <tbody>
            {upstreams.map((u) => (
              <tr key={u.id} data-testid={`fed-row-${u.id}`}>
                <td className="event-meta network-upstream-label" title={u.base_url}>
                  {u.id}
                </td>
                <td className="event-meta" data-testid={`fed-checkpoint-${u.id}`}>
                  {u.checkpoint}
                  <span className="state-detail"> · {sinceMs(u.last_pull_at)}</span>
                </td>
                <td className="event-meta" data-testid={`fed-queue-${u.id}`}>
                  {t('fed.queue', { pending: u.queue.pending, due: u.queue.due, dead: u.queue.dead })}
                </td>
                <td className="event-meta" data-testid={`fed-pulled-${u.id}`}>
                  {t('fed.pulled', { events: u.remote_events, topics: u.remote_topics })}
                </td>
                <td
                  className={u.last_error === '' ? 'event-meta' : 'event-meta notice error'}
                  data-testid={`fed-error-${u.id}`}
                >
                  {u.last_error === '' ? (
                    t('fed.noError')
                  ) : (
                    <>
                      {u.last_error}
                      <span className="state-detail"> · {sinceMs(u.last_pull_at)}</span>
                    </>
                  )}
                </td>
                <td className="event-meta">
                  <button
                    type="button"
                    className="ghost-btn"
                    data-testid={`fed-resync-${u.id}`}
                    disabled={busy !== null}
                    title={t('fed.resyncHint', { id: u.id })}
                    onClick={() => void resync(u.id)}
                  >
                    {busy === u.id ? t('fed.resyncBusy') : t('fed.resync')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dead.length > 0 && (
        <>
          <p className="side-title">{t('fed.deadTitle')}</p>
          <ul className="state-detail" data-testid="fed-dead-letters">
            {dead.map((d) => (
              <li key={`${d.event_id}:${d.kind}`}>
                {d.event_id.slice(0, 12)}… · kind {d.kind} · {d.attempts}× · {d.last_error}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
