/**
 * "New idea" modal (F4AI-19, S13) — kind 1021 with a `title` tag, `t`
 * tags of the topics and an optional `t` tag `agent` (the "publish
 * as agent" checkbox — the F1 heuristic behind the author-kind filter, see `lib/ideas.ts`).
 *
 * Signing goes through the RELATION like the Composer — the user chose the
 * source, the modal only calls `signEvent()`. Publish → `POST /events`; on success
 * the `onPublished` callback runs (the page invalidates + refetches the board) and the
 * modal closes. An error → inline error with `reasons` from `ApiError`.
 *
 * Validation ask: title is required (the gateway would have created
 * "(bez názvu)", but a board entry without a title is useless), the text may be
 * empty (description is an optional field of the row).
 */
import { useState, type FormEvent, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { ApiError } from '../api/client.js';
import { useIdentity } from '../nostr/IdentityContext.js';
import { useWriteStatus } from '../hooks/useWriteStatus.js';
import { buildNewIdeaTemplate } from '../lib/ideas.js';
import { currentUiLang } from '../i18n/text.js';

export function NewIdeaModal({
  onClose,
  onPublished,
}: {
  onClose: () => void;
  onPublished: () => void;
}): JSX.Element {
  const { t } = useTranslation(['forum', 'common']);
  const api = useApi();
  const { identity, signer } = useIdentity();
  // B10: write-gate — modal je zamknutý pre neregistrovaných (403 by
  // prišiel od servera tak či tak, len zbytočne neposielame event)
  const write = useWriteStatus();
  const locked = write.locked;
  const lockTitle = locked
    ? t('composer.title.locked', { reason: write.reason ?? t('composer.unavailable') })
    : undefined;
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [topicsRaw, setTopicsRaw] = useState('');
  const [asAgent, setAsAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(form: FormEvent<HTMLFormElement>): Promise<void> {
    form.preventDefault();
    setError(null);
    if (identity === null || signer === null) {
      setError(t('newIdea.errorNotSigned'));
      return;
    }
    if (title.trim() === '') {
      setError(t('newIdea.errorNeedTitle'));
      return;
    }
    if (locked) {
      setError(t('composer.title.denied', { reason: write.reason ?? t('composer.unavailable') }));
      return;
    }
    setBusy(true);
    try {
      const template = buildNewIdeaTemplate({
        title,
        text,
        topics: topicsRaw.split(/[,\s]+/),
        asAgent,
        createdAt: Math.floor(Date.now() / 1000),
        // F4AI-2b2: NIP-32 label patrí pod podpis, preto tu (nie v signeri)
        lang: currentUiLang(),
      });
      const event = await signer.signEvent(template);
      const result = await api.publish(event);
      if (result.quorum_met) {
        onPublished();
        onClose();
      } else {
        setError(result.error ?? t('newIdea.errorQuorum'));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.reasons.join('; ') : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" data-testid="new-idea-modal" role="dialog" aria-modal="true">
      <form className="glass-card glass-modal" onSubmit={(e) => void onSubmit(e)}>
        <div className="modal-head">
          <p className="side-title">{t('newIdea.title')}</p>
          <button
            type="button"
            className="modal-close"
            aria-label={t('common:actions.close')}
            data-testid="new-idea-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="field">
          <label htmlFor="idea-title">{t('newIdea.labelTitle')}</label>
          <input
            id="idea-title"
            name="idea-title"
            value={title}
            disabled={locked}
            title={lockTitle}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
            placeholder={t('newIdea.placeholderTitle')}
            data-testid="new-idea-title"
          />
        </div>

        <div className="field">
          <label htmlFor="idea-text">{t('newIdea.labelText')}</label>
          <textarea
            id="idea-text"
            name="idea-text"
            value={text}
            disabled={locked}
            title={lockTitle}
            onChange={(e) => {
              setText(e.target.value);
            }}
            placeholder={t('newIdea.placeholderText')}
            data-testid="new-idea-text"
          />
        </div>

        <div className="field">
          <label htmlFor="idea-topics">{t('newIdea.labelTopics')}</label>
          <input
            id="idea-topics"
            name="idea-topics"
            value={topicsRaw}
            disabled={locked}
            title={lockTitle}
            onChange={(e) => {
              setTopicsRaw(e.target.value);
            }}
            placeholder={t('newIdea.placeholderTopics')}
            data-testid="new-idea-topics"
          />
        </div>

        <label className="agent-check-row" htmlFor="idea-agent">
          <input
            id="idea-agent"
            type="checkbox"
            checked={asAgent}
            disabled={locked}
            title={lockTitle}
            onChange={(e) => {
              setAsAgent(e.target.checked);
            }}
            data-testid="new-idea-agent-check"
          />
          {t('newIdea.agentCheck')}
        </label>

        <div className="composer-actions">
          <button
            type="submit"
            className="primary-btn"
            disabled={busy || locked}
            title={lockTitle}
            data-testid="new-idea-submit"
          >
            {busy ? t('newIdea.submitting') : t('newIdea.submit')}
          </button>
          <button
            type="button"
            className="ghost-btn"
            data-testid="new-idea-cancel"
            onClick={onClose}
          >
            {t('common:actions.cancel')}
          </button>
        </div>

        {locked && (
          <p className="notice" data-testid="new-idea-locked" title={lockTitle}>
            {t('newIdea.locked', { reason: write.reason ?? t('composer.unavailable') })}
          </p>
        )}

        {error !== null && (
          <p className="notice error" role="alert" data-testid="new-idea-error">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
