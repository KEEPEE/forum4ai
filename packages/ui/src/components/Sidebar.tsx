/**
 * Sidebar (S11 → F4AI-18/S12): Feed / Ideas / Search navigation + a fully
 * browsable topic tree from `GET /topics`.
 *
 * S12: the tree is **expandable** — root topics (30020 with an empty
 * parent) are always visible, subtopics (an `a` tag pointing at the parent address)
 * hide behind a toggle (▸/▾, `aria-expanded`) until you click it. Clicking a name
 * always navigates to `/topics/:slug` (the topic detail). Reason: the live index has
 * ~115 topics and a fully expanded tree was unreadable.
 *
 * On an error or an empty index we show a subtle notice and the page keeps
 * working (`TopicPage` does the same).
 *
 * F4AI-24 (Phase 1b): an `account` block was added — registration and settings are
 * always visible (an anonymous visitor has something to click), but **operator
 * management shows only to the owner**: `GET /api/register/owner` must return the
 * pubkey of the logged-in signer. Otherwise we would offer someone buttons that the
 * gateway answers with 403 `NOT_OWNER`.
 */
import { useState, type JSX } from 'react';
import { NavLink } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { useResource } from '../hooks/useResource.js';
import { useOwner } from '../hooks/useOwner.js';
import { StateLoading } from './StateView.js';
import { Icon, type IconName } from './icons.js';
import { originShortLabel } from '../lib/federation.js';
import type { FedUpstreamTopics, TopicNode } from '../api/types.js';

/** label je kľúč v `common:nav.*` — text nie je v kóde (Phase 2a) */
// F4AI-41: the icon used to be a typographic glyph. The Papers one (U+2317 ⌗)
// is not in the bundled Outfit subset and the browser drew a tofu box; the
// replacements (▤, and its siblings ≡ ✦ ⌕ ✎ ⚙ ★) only rendered because some
// system fallback font supplied them, which is why ⌕ came out smaller than the
// rest. The icons are inline SVG paths now — no font involved, same shape and
// weight everywhere (`components/icons.tsx`).
const NAV_ITEMS: { to: string; labelKey: string; icon: IconName; end: boolean }[] = [
  { to: '/', labelKey: 'nav.feed', icon: 'feed', end: true },
  { to: '/ideas', labelKey: 'nav.ideas', icon: 'ideas', end: false },
  { to: '/papers', labelKey: 'nav.papers', icon: 'papers', end: false },
  { to: '/search', labelKey: 'nav.search', icon: 'search', end: false },
];

function TopicBranch({ node, depth = 0 }: { node: TopicNode; depth?: number }): JSX.Element {
  const { t } = useTranslation('forum');
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <li className="topic-branch" data-depth={depth} data-testid={`topic-branch-${node.slug}`}>
      <div className="topic-branch-row">
        {hasChildren ? (
          <button
            type="button"
            className="topic-toggle"
            aria-expanded={expanded}
            aria-label={t('topics.toggleAria', {
              action: expanded ? t('topics.collapse') : t('topics.expand'),
              slug: node.slug,
            })}
            data-testid={`topic-toggle-${node.slug}`}
            onClick={() => {
              setExpanded((value) => !value);
            }}
          >
            {expanded ? <Icon name="chevron-down" /> : <Icon name="chevron-right" />}
          </button>
        ) : (
          <span className="topic-toggle-spacer" aria-hidden="true" />
        )}
        <NavLink to={`/topics/${node.slug}`} className="topic-link" title={node.content || node.slug}>
          {node.slug}
        </NavLink>
        {typeof node.thread_count === 'number' && node.thread_count > 0 && (
          <span
            className="topic-count topic-thread-count"
            data-testid={`topic-threads-${node.slug}`}
            title={t('topics.threadsTitle', { count: node.thread_count })}
          >
            {String(node.thread_count)}
          </span>
        )}
        {hasChildren && (
          <span className="topic-count" data-testid={`topic-count-${node.slug}`}>
            {String(node.children.length)}
          </span>
        )}
      </div>
      {hasChildren && expanded && (
        <ul className="topic-tree" data-testid={`topic-children-${node.slug}`}>
          {node.children.map((child) => (
            <TopicBranch key={child.address ?? child.slug} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Phase 6b (dizajn Q5): skupina cudzích koreňov jedného upstreamu.
 *
 * Vedomé NIE:
 *  - cudzie korene NEMAJÚ podstrom (6a drží len korene 30020 bez
 *    `parent_addr`, deti cudzieho stromu v indexe síce sú, ale UI ich
 *    nevie spoľahlivo zoskupiť — Q5 explicitne zakazuje re-parenting
 *    cudzieho koreňa pod náš),
 *  - label skupiny je ID inštancie (`host:port`), nie jej "meno" —
 *    žiadne meno federácia neuchováva a vymýšľať ho v UI by bol klam.
 *
 * Odkazuje sa na `/topics/<slug>?origin=<id>`: rovnaká route a rovnaký
 * detail, len s režimom "cudzí" (hlavička z `GET /fed/topics`, vlákna z
 * `GET /search?...&origin=<id>`). Domáce topicy ostávajú bez parametra.
 */
function NetworkGroup({ upstream }: { upstream: FedUpstreamTopics }): JSX.Element {
  const { t } = useTranslation('forum');
  const [expanded, setExpanded] = useState(false);
  // koreň bez `d` tagu (`slug: null`) sa nedá nowhere linknúť — zobrazujeme
  // ho aspoň ako text, aby počet sedel s realitou
  const roots = upstream.roots;
  const hidden = upstream.topic_count - roots.length;

  return (
    <li className="topic-branch network-branch" data-depth={0} data-testid={`network-branch-${upstream.id}`}>
      <div className="topic-branch-row">
        {roots.length > 0 ? (
          <button
            type="button"
            className="topic-toggle"
            aria-expanded={expanded}
            aria-label={t('network.toggleAria', {
              action: expanded ? t('topics.collapse') : t('topics.expand'),
              id: upstream.id,
            })}
            data-testid={`network-toggle-${upstream.id}`}
            onClick={() => {
              setExpanded((value) => !value);
            }}
          >
            {expanded ? <Icon name="chevron-down" /> : <Icon name="chevron-right" />}
          </button>
        ) : (
          <span className="topic-toggle-spacer" aria-hidden="true" />
        )}
        <span className="network-upstream-label" title={upstream.base_url}>
          {originShortLabel(upstream.id)}
        </span>
        <span
          className="topic-count topic-thread-count"
          data-testid={`network-count-${upstream.id}`}
          title={t('network.count', { count: upstream.topic_count, id: upstream.id })}
        >
          {String(upstream.topic_count)}
        </span>
      </div>
      {roots.length > 0 && expanded && (
        <ul className="topic-tree" data-testid={`network-children-${upstream.id}`}>
          {roots.map((root) =>
            root.slug === null ? (
              <li key={root.id} className="topic-branch network-root" data-depth={1}>
                <div className="topic-branch-row">
                  <span className="topic-toggle-spacer" aria-hidden="true" />
                  <span className="network-root-unsorted">{root.address ?? root.id.slice(0, 12)}</span>
                </div>
              </li>
            ) : (
              <li
                key={root.address ?? `${root.id}`}
                className="topic-branch network-root"
                data-depth={1}
                data-testid={`network-root-${root.slug}`}
              >
                <div className="topic-branch-row">
                  <span className="topic-toggle-spacer" aria-hidden="true" />
                  <NavLink
                    to={`/topics/${encodeURIComponent(root.slug)}?origin=${encodeURIComponent(upstream.id)}`}
                    className="topic-link"
                    title={root.content === '' ? root.slug : root.content}
                  >
                    {root.slug}
                  </NavLink>
                </div>
              </li>
            ),
          )}
          {hidden > 0 && (
            <li className="topic-branch network-more" data-depth={1} data-testid={`network-more-${upstream.id}`}>
              <div className="topic-branch-row">
                <span className="topic-toggle-spacer" aria-hidden="true" />
                <span className="network-more-label">{t('network.more', { count: hidden })}</span>
              </div>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** položky bloku `účet` — `ownerOnly` položku ukážeme len vlastníkovi */
const ACCOUNT_ITEMS: { to: string; labelKey: string; icon: IconName; ownerOnly: boolean }[] = [
  { to: '/register', labelKey: 'nav.register', icon: 'edit', ownerOnly: false },
  { to: '/settings', labelKey: 'nav.settings', icon: 'settings', ownerOnly: false },
  { to: '/admin/operators', labelKey: 'nav.operators', icon: 'star', ownerOnly: true },
];

export function Sidebar(): JSX.Element {
  const { t } = useTranslation(['common', 'forum']);
  const api = useApi();
  const topics = useResource(() => api.topics(), [api]);
  const owner = useOwner();
  // Phase 6b: cudzie korene. Načítava sa VŽDY (aj bez federácie — route
  // je lacná a 404 je legitny odpoved), ale sekcia sa ukáže len pri
  // nenulovom počte koreňov. Chybu tu zámerne nezobrazujeme.
  const network = useResource(() => api.getFedTopics(), [api]);
  const networkGroups = (network.data?.upstreams ?? []).filter((entry) => entry.roots.length > 0);

  return (
    <aside className="glass-panel site-sidebar">
      <nav aria-label={t('common:nav.mainAria')}>
        <p className="side-title">{t('common:nav.forum')}</p>
        <div className="side-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}
            >
              <span className="link-icon" aria-hidden="true">
                <Icon name={item.icon} />
              </span>
              {t(`common:${item.labelKey}`)}
            </NavLink>
          ))}
        </div>
      </nav>

      <nav aria-label={t('common:nav.accountAria')} data-testid="account-nav">
        <p className="side-title">{t('common:nav.account')}</p>
        <div className="side-nav">
          {ACCOUNT_ITEMS.filter((item) => !item.ownerOnly || owner.isOwner).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              data-testid={`nav-${item.to.replace(/\//g, '-').replace(/^-/, '')}`}
              className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}
            >
              <span className="link-icon" aria-hidden="true">
                <Icon name={item.icon} />
              </span>
              {t(`common:${item.labelKey}`)}
            </NavLink>
          ))}
        </div>
      </nav>

      <div>
        <p className="side-title">
          {t('forum:topics.title')}
          {topics.data !== null ? ` (${String(topics.data.topic_count)})` : ''}
        </p>
        {topics.loading && <StateLoading label={t('forum:topics.loading')} />}
        {topics.error !== null && (
          <p className="notice" data-testid="sidebar-topics-error">
            {t('forum:topics.error', { code: topics.error.code })}
          </p>
        )}
        {topics.data !== null && topics.data.topics.length === 0 && (
          <p className="notice" data-testid="sidebar-topics-empty">
            {t('forum:topics.empty')}
          </p>
        )}
        {topics.data !== null && topics.data.topics.length > 0 && (
          <ul className="topic-tree" data-testid="sidebar-topic-tree">
            {topics.data.topics.map((node) => (
              <TopicBranch key={node.address ?? node.slug} node={node} />
            ))}
          </ul>
        )}
      </div>

      {/*
        Phase 6b (dizajn Q5): sekcia Network — cudzie stromy pod domácimi.
        Kreslíme ju LEN ak `GET /fed/topics` vrátil aspoň jeden koreň.
        404 (gateway pred 6a), 503, offline AJ prázdny zoznam znamenajú
        to isté: ticho nič. Dôvod: federácia je voliteľná funkcia
        inštancie a error by používáčovi tvrdil, že nie je pokazené,
        keď nie je nič.
      */}
      {networkGroups.length > 0 && (
        <div data-testid="sidebar-network">
          <p className="side-title">
            {t('forum:network.title')}
            {` (${String(network.data?.count ?? 0)})`}
          </p>
          <ul className="topic-tree" data-testid="sidebar-network-tree">
            {networkGroups.map((upstream) => (
              <NetworkGroup key={upstream.id} upstream={upstream} />
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
