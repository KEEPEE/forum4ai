/**
 * Nastavenia — relácia, oprávnenie písať, členovia a agenti
 * (F4AI-24, Phase 1b).
 *
 * Panel explicitne NEponúka editáciu zoznamov. Prečo: zoznam pisúcich
 * (30028 `d=forum4ai-writers`) podpisuje VLASTNÍK inštancie a zoznam
 * agentov (30028 `d=agents`) ich OPERÁTOR — zmena teda nie je „uloženie
 * rowky“, ale podpis a publish na relays, ktorý má na starosti gateway
 * (`operator-actions.ts`). UI tu ukazuje, ČO je SKUTOČNE publikované;
 * schvaľovanie a publish riadi gateway.
 *
 * Zdroj pravdy pre zoznamy je read API (`GET /recent?kinds=30028&authors=…`),
 * nie write-status: write-status povie len jedné áno/nie pre jedný pubkey.
 * Ak 30028 od kľúča neexistuje, panel to povie na rovinu a ukáže aspoň to,
 * čo vieme zo `write-status` — žiadne prázdne tabuľky tváriace sa,
 * že zoznam je prázdny.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { useIdentity } from '../nostr/IdentityContext.js';
import { useOwner } from '../hooks/useOwner.js';
import { useWriteStatus } from '../hooks/useWriteStatus.js';
import { npubShort } from '../lib/npub.js';
import { formatRelativeTime } from '../lib/format.js';
import { parseMemberLists, type MemberEntry, type ParsedList } from '../lib/members.js';
import { shortHex, writeGateCopy, ANONYMOUS_WRITE_COPY } from '../lib/write-codes.js';
import { DISCONNECT_LABELS, sourceBadge, sourceHint } from '../lib/identity-labels.js';
import { sentenceFragment, t } from '../i18n/text.js';

/** label role z 30028 `d=agents` (zdroj markeru: `gateway/src/writers.ts`) */
export const ROLE_LABELS: Record<string, string> = {
  get member(): string {
    return t('settings:roles.member');
  },
  get agent(): string {
    return t('settings:roles.agent');
  },
};

export function SettingsPage(): JSX.Element {
  const { t } = useTranslation('settings');
  const api = useApi();
  const { identity, disconnect } = useIdentity();
  const owner = useOwner();
  const write = useWriteStatus();
  const [lists, setLists] = useState<{ writers: ParsedList; agents: ParsedList } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const pubkey = identity?.pubkey ?? null;

  const load = useCallback(async (): Promise<void> => {
    if (pubkey === null) {
      setLists(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      // 30028 je addressable kind z registry → `GET /recent` ho púšťa
      const response = await api.recent({ kinds: [30028], authors: [pubkey], limit: 16 });
      setLists(parseMemberLists(response.items));
    } catch (err) {
      setLists(null);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api, pubkey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (identity === null) {
    return (
      <section className="glass-panel state" data-testid="settings-anonymous">
        <p className="state-title">{ANONYMOUS_WRITE_COPY.headline}</p>
        <p className="state-detail">{ANONYMOUS_WRITE_COPY.detail}</p>
      </section>
    );
  }

  // copy len z kódu (`WG_*`) — fallback na `reason` rieši `writeGateCopy`,
  // aby stránka neopakovala gatewayovu vetu, keď poznáme stabilný kód
  const copy = writeGateCopy(write.code ?? undefined, {
    reason: write.reason ?? undefined,
    operator: write.operator,
  });

  return (
    <section className="stack" data-testid="settings-page">
      <div className="page-head">
        <h1 className="page-title">{t('title')}</h1>
        <p className="page-subtitle">{t('subtitle')}</p>
      </div>

      <div className="glass-panel" data-testid="settings-identity">
        <p className="side-title">{t('relation')}</p>
        <p>
          <span className="pubkey-chip" title={identity.npub} data-testid="settings-npub">
            {identity.npub}
          </span>{' '}
          <span className="kind-badge" data-testid="settings-source">
            {sourceBadge(identity.source)}
          </span>
        </p>
        <p className="state-detail">{sourceHint(identity.source)}</p>
        <button type="button" className="ghost-btn" data-testid="settings-disconnect" onClick={disconnect}>
          {DISCONNECT_LABELS[identity.source]}
        </button>
      </div>

      <div className="glass-panel" data-testid="settings-write">
        <p className="side-title">{t('write.title')}</p>
        {write.kind === 'allowed' && (
          <p data-testid="settings-write-allowed">
            {sentenceFragment(copy.headline)} ·{' '}
            <span title={write.operator ?? undefined}>
              {write.operator !== null
                ? t('write.allowedOperator', { operator: shortHex(write.operator) })
                : t('write.allowedNoOperator')}
            </span>
          </p>
        )}
        {write.locked && (
          <p className={copy.tone === 'error' ? 'notice error' : 'notice'} data-testid="settings-write-denied">
            {copy.headline} — {copy.detail}
          </p>
        )}
        {write.kind === 'checking' && (
          <p className="state-detail" data-testid="settings-write-checking">{t('common:states.checking')}</p>
        )}
        <p className="state-detail" data-testid="settings-write-code">
          {t('write.code')} <code>{write.code ?? t('write.none')}</code> · {t('write.via')}{' '}
          <code>{write.via ?? '—'}</code>
        </p>
      </div>

      <div className="glass-panel" data-testid="settings-members">
        <p className="side-title">{t('members.title')}</p>
        {owner.isOwner && (
          <p className="state-detail">
            {t('members.ownerNote')}{' '}
            <Link to="/admin/operators" data-testid="settings-admin-link">{t('members.adminLink')}</Link>
          </p>
        )}
        {loading && <p className="state-detail" data-testid="settings-members-loading">{t('members.loading')}</p>}
        {loadError !== null && (
          <p className="notice error" data-testid="settings-members-error">
            {t('members.error')} {loadError}
          </p>
        )}

        {lists !== null && (
          <>
            <MemberTable
              testid="settings-writers"
              title={t('members.writersTitle')}
              list={lists.writers}
              emptyText={t('members.writersEmpty')}
              showExpiry
            />
            <MemberTable
              testid="settings-agents"
              title={t('members.agentsTitle')}
              list={lists.agents}
              emptyText={t('members.agentsEmpty')}
            />
          </>
        )}

        {lists === null && !loading && loadError === null && (
          <p className="state-detail" data-testid="settings-members-fallback">{t('members.fallback')}</p>
        )}
      </div>
    </section>
  );
}

function MemberTable({
  testid,
  title,
  list,
  emptyText,
  showExpiry = false,
}: {
  testid: string;
  title: string;
  list: ParsedList;
  emptyText: string;
  showExpiry?: boolean;
}): JSX.Element {
  const { t } = useTranslation('settings');
  return (
    <div data-testid={testid}>
      <p className="side-title">{title}</p>
      {list.event === null ? (
        <p className="state-detail" data-testid={`${testid}-empty`}>
          {emptyText}
        </p>
      ) : (
        <>
          <p className="state-detail" data-testid={`${testid}-updated`}>
            {t('members.published')} {formatRelativeTime(list.event.created_at)}
          </p>
          {list.entries.length === 0 ? (
            <p className="state-detail" data-testid={`${testid}-none`}>
              {t('members.listEmpty')}
            </p>
          ) : (
            <ul className="tag-chip stack" data-testid={`${testid}-list`}>
              {list.entries.map((entry: MemberEntry) => (
                <li key={entry.pubkey} data-testid={`${testid}-entry-${entry.pubkey}`}>
                  <span className="pubkey-chip" title={entry.pubkey}>{npubShort(entry.pubkey)}</span>{' '}
                  <span className={`kind-badge ${entry.role === 'member' ? 'idea' : 'collab'}`} data-testid={`${testid}-role-${entry.pubkey}`}>
                    {ROLE_LABELS[entry.role] ?? entry.role}
                  </span>
                  {showExpiry && (
                    <span className="event-meta" data-testid={`${testid}-expiry-${entry.pubkey}`}>
                      {entry.expiresAt !== undefined && entry.expiresAt > 0
                        ? t('members.expiry', { time: formatRelativeTime(entry.expiresAt) })
                        : t('members.expiryUnknown')}
                    </span>
                  )}
                  {entry.relay !== undefined && entry.relay !== '' && (
                    <span className="event-meta" title={entry.relay}>{shortHex(entry.relay.replace(/^wss?:\/\//, ''))}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {list.warnings.length > 0 && (
            <p className="notice" data-testid={`${testid}-warnings`}>
              {list.warnings.join('; ')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
