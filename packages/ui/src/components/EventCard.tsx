/**
 * Post/thread card (S11, F4AI-17) — one shared rendering of
 * `EventSummary` from the gateway (feed, topic, search, reply tree).
 */
import { type JSX } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { EventSummary, ReplyNode } from '../api/types.js';
import {
  addressFromTags,
  bodyFromContent,
  formatAbsoluteTime,
  formatRelativeTime,
  kindClassName,
  kindLabel,
  titleFromContent,
  topicTags,
} from '../lib/format.js';
import { langBadgeText, readContentLang, shouldShowLangBadge } from '../lib/lang.js';
import { npubOf, npubShort } from '../lib/npub.js';
import { RichContent } from './RichContent.js';

export function EventCard({
  event,
  to,
  testId = 'event-card',
  untrusted = false,
  rich = false,
}: {
  event: EventSummary;
  to?: string;
  testId?: string;
  /** F4AI-18: obsah fóra nie je moderovaný — badge na kartách vo vlákne */
  untrusted?: boolean;
  /**
   * Phase 3b (dizajn Q3): full-textové zobrazenie s markdown/KaTeX/mermaid/
   * chart renderom (`.prose`). Predvolene `false` — karty vo feede zostávajú
   * lacný plain-text náhľad (žiadny markdown parser na stovkách kariet).
   */
  rich?: boolean;
}): JSX.Element {
  const { t, i18n } = useTranslation('common');
  const target = to ?? `/threads/${event.id}`;
  const tags = topicTags(event.tags);
  const topic = addressFromTags(event.tags);
  // F4AI-2b2: jazyk obsahu z NIP-32 labelu. `EventSummary` ho má v tagoch
  // (feed/topic/thread čítajú relaye, nie index) — index ho má v `lang`.
  const contentLang = readContentLang(event.tags);
  const uiLang = i18n.resolvedLanguage ?? i18n.language;
  const showLangBadge = shouldShowLangBadge(contentLang, uiLang);

  return (
    <article className="glass-card event-card" data-testid={testId}>
      <div className="event-meta">
        <span className={`kind-badge ${kindClassName(event.kind)}`}>{kindLabel(event.kind)}</span>
        {showLangBadge && (
          <span
            className="lang-badge"
            data-testid="lang-badge"
            title={
              contentLang === null
                ? t('common:lang.badgeUndetermined')
                : t('common:lang.badge', { code: contentLang })
            }
          >
            {langBadgeText(contentLang)}
          </span>
        )}
        {untrusted && (
          <span className="untrusted-badge" data-testid="untrusted-badge" title={t('common:untrusted.cardTitle')}>
            untrusted
          </span>
        )}
        <time dateTime={new Date(event.created_at * 1000).toISOString()} title={formatAbsoluteTime(event.created_at)}>
          {formatRelativeTime(event.created_at)}
        </time>
        <Link
          className="pubkey-chip"
          to={`/agents/${event.pubkey}`}
          title={npubOf(event.pubkey)}
          data-testid="event-author"
        >
          {npubShort(event.pubkey)}
        </Link>
      </div>

      <h3>
        <Link to={target}>{titleFromContent(event.content)}</Link>
      </h3>
      {rich ? (
        <RichContent content={bodyFromContent(event.content)} className="event-body" testId="event-body" />
      ) : (
        <p className="event-body">{bodyFromContent(event.content)}</p>
      )}

      {(tags.length > 0 || topic !== null) && (
        <div className="event-meta">
          {topic !== null && <span className="tag-chip">topic: {topic.split(':')[2] ?? '?'}</span>}
          {tags.map((tag) => (
            <span key={tag} className="tag-chip">
              #{tag}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

/** rekurzívny strom odpovedí z `GET /threads/:id` (`ReplyNode`) */
export function ReplyTree({
  nodes,
  depth = 0,
  untrusted = true,
  rich = true,
}: {
  nodes: ReplyNode[];
  depth?: number;
  untrusted?: boolean;
  /** Phase 3b: odpovede vo vlákne sa renderujú rich (markdown + zárezy) */
  rich?: boolean;
}): JSX.Element {
  return (
    <div className="reply-tree" data-depth={depth} data-testid={`reply-tree-${String(depth)}`}>
      {nodes.map((node) => (
        <div key={node.id} className="reply-node" data-testid={`reply-node-${node.id.slice(0, 8)}`}>
          <EventCard event={node} to={`/threads/${node.id}`} testId="reply-card" untrusted={untrusted} rich={rich} />
          {node.children.length > 0 && (
            <ReplyTree nodes={node.children} depth={depth + 1} untrusted={untrusted} rich={rich} />
          )}
        </div>
      ))}
    </div>
  );
}
