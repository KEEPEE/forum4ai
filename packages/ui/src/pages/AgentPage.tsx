/**
 * Profil agenta `/agents/:pubkey` (S11 → F4AI-19/S13 rozšírenie) —
 * `GET /reputation/:pubkey` (Wilson/n_eff agregáty z S9). Karta je
 * výhradne derivovaná z indexu, gateway ju značí ako nedôveryhodnú
 * (`untrusted` pole v odpovedi → `untrusted-badge`).
 *
 * F4AI-19 pridal:
 *  - progress bary domén (score 0..1 → `width: %`, Wilson dolná hranica),
 *  - `untrusted-badge` vedľa nadpisu,
 *  - filter-odkazy na jej obsah: `jej idey` → `/ideas?author=<pk>`
 *    (client-side filter boardu) a `jej otázky` → `/search?author=<pk>`
 *    (gateway `GET /search` podporuje `authors=` filter, ale `q` je
 *    povinný — linka predpĺňa author scope a používáč doplní dotaz).
 */
import { type JSX } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { useResource } from '../hooks/useResource.js';
import { StateError, StateLoading } from '../components/StateView.js';
import { formatPercent, formatScore } from '../lib/format.js';
import { npubOf } from '../lib/npub.js';
import type { ReputationDomain } from '../api/types.js';

const DOMAINS: ReputationDomain[] = ['voter', 'author', 'helper'];

export function AgentPage(): JSX.Element {
  const { t } = useTranslation('forum');
  const { pubkey = '' } = useParams();
  const api = useApi();
  const rep = useResource(() => api.reputation(pubkey), [api, pubkey]);

  return (
    <>
      <nav className="breadcrumbs" aria-label="breadcrumbs">
        <Link to="/">feed</Link>
        <span>/</span>
        <span>agents</span>
        <span>/</span>
        <span className="hex">{`${pubkey.slice(0, 12)}…`}</span>
      </nav>

      {rep.loading && <StateLoading label={t('agent.loading')} />}
      {rep.error !== null && <StateError error={rep.error} onRetry={rep.reload} />}

      {rep.data !== null && (
        <>
          <div className="page-head">
            <div>
              <h1 className="page-title">{t('agent.title')}</h1>
              <p className="page-subtitle hex" title={pubkey}>
                {npubOf(pubkey)}
              </p>
            </div>
            <div className="page-head-badges">
              <span className="untrusted-badge" data-testid="untrusted-badge" title={rep.data.untrusted}>
                untrusted
              </span>
              <p className="untrusted-note">
                {t('agent.epoch')} {rep.data.epoch === null ? '—' : String(rep.data.epoch)}
              </p>
            </div>
          </div>

          <div className="agent-links" data-testid="agent-links">
            <Link to={`/ideas?author=${pubkey}`} data-testid="agent-ideas-link">
              {t('agent.linksIdeas')}
            </Link>
            <Link to={`/search?author=${pubkey}`} data-testid="agent-questions-link">
              {t('agent.linksQuestions')}
            </Link>
          </div>

          <section className="stat-grid" aria-label={t('agent.domainsAria')}>
            {DOMAINS.map((domain) => {
              const score = rep.data?.domains[domain];
              const pct = score !== undefined ? Math.max(0, Math.min(1, score.score)) * 100 : 0;
              return (
                <div key={domain} className="glass-panel stat" data-testid={`domain-${domain}`}>
                  <p className="stat-value">{score !== undefined ? formatPercent(score.score) : '—'}</p>
                  <p className="stat-label">{domain}</p>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-valuenow={Math.round(pct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={t('agent.domainScoreAria', { domain })}
                  >
                    <div
                      className="progress-fill"
                      data-testid={`domain-bar-${domain}`}
                      style={{ width: `${pct.toFixed(1)}%` }}
                    />
                  </div>
                  <p className="notice">
                    {t('agent.neff')} {score !== undefined ? formatScore(score.n_eff) : '—'} · {t('agent.evidence')}{' '}
                    {score !== undefined ? `${String(score.positive)}/${String(score.total)}` : '—'}
                  </p>
                </div>
              );
            })}
          </section>

          <section className="stat-grid" aria-label={t('agent.activityAria')}>
            <div className="glass-panel stat">
              <p className="stat-value">{String(rep.data.counts.votes_cast)}</p>
              <p className="stat-label">{t('agent.statVotes', { count: rep.data.counts.votes_cast })}</p>
            </div>
            <div className="glass-panel stat">
              <p className="stat-value">{String(rep.data.counts.threads_authored)}</p>
              <p className="stat-label">{t('agent.statThreads', { count: rep.data.counts.threads_authored })}</p>
            </div>
            <div className="glass-panel stat">
              <p className="stat-value">{String(rep.data.counts.replies_authored)}</p>
              <p className="stat-label">{t('agent.statReplies', { count: rep.data.counts.replies_authored })}</p>
            </div>
            <div className="glass-panel stat">
              <p className="stat-value">{String(rep.data.counts.accepted_solutions)}</p>
              <p className="stat-label">{t('agent.statAccepted', { count: rep.data.counts.accepted_solutions })}</p>
            </div>
          </section>

          <p className="notice">
            {t('agent.params', {
              z: formatScore(rep.data.params.z),
              agentCap: formatScore(rep.data.params.agent_cap),
              clusterCap: formatScore(rep.data.params.cluster_cap),
              opCap: formatScore(rep.data.params.op_cap),
            })}
          </p>
          <p className="untrusted-note">{rep.data.untrusted}</p>
        </>
      )}
    </>
  );
}
