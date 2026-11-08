/**
 * Composer (S11 → F4AI-18/S12): signing + the REAL submit to the gateway.
 *
 * Two modes (`mode`):
 *  - `reply` (default): a reply of kind 1023 to the `replyTo` root — tags are built
 *    by `buildReplyTags` (exactly one `e` tag with the `root` marker, the L2 rule
 *    from `packages/shared/src/validators.ts`), optionally linked to a topic
 *  - `question`: a new question of kind 1020 into a fixed topic (the `topic` prop from
 *    `/topics/:slug`) — tags `['a', <adresa 30020>]` + `['t', <slug>]`,
 *    so that `GET /topics/:slug` (filter `#a`) actually lists it
 *
 * Signing runs through the RELATION (`useIdentity`): the user picked the signing
 * source (NIP-07 extension, NIP-46 bunker, dev nsec) and the composer works with it
 * through ONE interface, `signEvent()`. Anonymous (no source) is a valid state —
 * the composer is locked and says what to do about it (design Q1), no
 * "identity unavailable".
 *
 * We do not submit a locked field: the gateway would return 403 anyway, and we take
 * the lock copy from the `WG_*` code (`lib/write-codes.ts`), not from the gateway's sentence.
 *
 * Buttons:
 *  - "publish" (primary) — signs and submits to `POST /events`; on
 *    success it calls `onPublished` (the page invalidates + refetches what the
 *    user is looking at) and clears the text
 *  - "sign" — signs in place + previews the canonical 7-field event
 *  - "send to gateway" — publishes an already-signed event
 *
 * A publish error → inline error with `reasons` from `ApiError` (400 validation,
 * 424 quorum, network).
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { ApiError } from '../api/client.js';
import { useIdentity } from '../nostr/IdentityContext.js';
import { buildReplyTags, composeContent } from '../nostr/keys.js';
import type { EventTemplate, SignerSource } from '../nostr/signer.js';
import { npubShort } from '../lib/npub.js';
import { sourceBadge } from '../lib/identity-labels.js';
import { ANONYMOUS_WRITE_COPY, writeGateCopy } from '../lib/write-codes.js';
import { currentUiLang, tp } from '../i18n/text.js';
import { useResource } from '../hooks/useResource.js';
import { useWriteStatus } from '../hooks/useWriteStatus.js';
import { slugFromAddress } from '../lib/format.js';
import { langTags } from '../lib/lang.js';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';
import type { PublishResponse, TopicNode } from '../api/types.js';

/** mock root, na ktorý demo odpovede na feede reagujú (reálne id má vlákno) */
export const MOCK_REPLY_ROOT_ID = 'e'.repeat(64);

/**
 * Šablóny toolbaru (Phase 3b, dizajn Q3). Kód, nie text — preto nie sú
 * v i18n; popisky tlačidiel áno (`composer.toolbar.*`, en+sk).
 */
export const COMPOSER_TEMPLATES = {
  mermaid: '\n```mermaid\ngraph TD\n  A[client] --> B[relay]\n  B --> C[gateway]\n```\n',
  chart:
    '\n```chart\n{"v":1,"type":"line","x":{"label":"cas"},"y":{"label":"p95","unit":"ms"},"series":[{"name":"relay","data":[1,2,3]}]}\n```\n',
  math: '\n$$E = mc^2$$\n',
} as const;

/** kind 1020 = otázka (`packages/shared/src/kinds.ts`) */
export const KIND_QUESTION = 1020;

export interface ComposerTopicRef {
  address: string;
  slug: string;
}

interface TopicOption {
  address: string;
  slug: string;
}

function flattenTopics(nodes: TopicNode[], depth = 0, out: TopicOption[] = []): TopicOption[] {
  for (const node of nodes) {
    if (node.address !== null) out.push({ address: node.address, slug: node.slug });
    if (node.children.length > 0) flattenTopics(node.children, depth + 1, out);
  }
  return out;
}

/**
 * tagy otázky 1020 do topicu: `a` adresa + `t` slug (konvencia read-routes)
 * + NIP-32 jazykový label (F4AI-2b2, default jazyk rozhrania).
 */
export function buildQuestionTags(topic: ComposerTopicRef, lang?: string): NostrTag[] {
  return [
    ['a', topic.address],
    ['t', topic.slug],
    ...langTags(lang ?? currentUiLang()),
  ];
}

export function Composer({
  mode = 'reply',
  replyTo = MOCK_REPLY_ROOT_ID,
  parentId = null,
  topic = null,
  topics: topicsProp,
  heading,
  submitLabel,
  testId = 'composer',
  onPublished,
}: {
  mode?: 'reply' | 'question';
  replyTo?: string;
  /**
   * C1: priama odpoveď na KONKÉTNÚ odpoveď (1023) — `parentId` ide do
   * `e` tagu s markerom `parent`, `replyTo` ostáva root vlákna (otázka).
   * L2 pravidlo (práve jeden root marker) tak zostáva splnené a vlákno
   * sa nerozštiepí na nový strom s root markerom na odpovedi.
   */
  parentId?: string | null;
  /** fixný topic pre `question` režim (z `/topics/:slug`) */
  topic?: ComposerTopicRef | null;
  topics?: TopicNode[];
  heading?: string;
  submitLabel?: string;
  testId?: string;
  /** callback po úspešnom publishi — stránka invaliduje + refetchne data */
  onPublished?: (event: NostrEvent, response: PublishResponse) => void;
}): JSX.Element {
  const { t } = useTranslation('forum');
  const api = useApi();
  const { identity, signer, status, disconnect } = useIdentity();
  // pripájame pozadie (NIP-07/bunker) — podpis ešte nie je possible
  const connecting = status === 'connecting';
  const topicsResource = useResource(() => api.topics(), [api]);
  // B10: write-gate — composer je zamknutý pre neregistrovaných. Server
  // vráti 403 tak či tak, tu len zbytočne neposielame event, ktorý poznáme.
  const write = useWriteStatus();
  const locked = write.locked;
  // copy zámku podľa stabilného kódu; `reason` gatewayu je fallback
  const lockCopy = writeGateCopy(write.code ?? undefined, {
    reason: write.reason ?? undefined,
    operator: write.operator,
  });
  const lockTitle = locked
    ? t('composer.title.locked', { reason: write.reason ?? t('composer.unavailable') })
    : undefined;
  // title tlačidiel: gate dôvod > pripájanie > odomknuté
  const actionTitle = connecting ? t('composer.title.connecting') : lockTitle;

  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [topicAddress, setTopicAddress] = useState('');
  const [signed, setSigned] = useState<NostrEvent | null>(null);
  const [published, setPublished] = useState<PublishResponse | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isQuestion = mode === 'question';

  // A11: podepísaný event je SNAPSHOT vstupu v čase podpisu. Ak používáč
  // po podpise siahne na text/nadpis/topic (alebo zamení identitu),
  // náhľad aj tlačidlo „pošli na gateway“ musia zhasnúť — inak publish
  // pošle STARÝ event, ktorý nezodpovedá tomu, čo je v poliach.
  function invalidateSigned(): void {
    setSigned(null);
    setPublished(null);
    setNote(null);
  }

  // Phase 3b (dizajn Q3): toolbar vkladá šablóny zárezov do textu. Žiadny
  // preview — composer zostáva textové pole (render robí RichContent pri
  // čítaní), takže vklad je čisté work-around pre pisateľa, nie renderer.
  const textRef = useRef<HTMLTextAreaElement>(null);

  function insertTemplate(template: string): void {
    const el = textRef.current;
    if (el === null) {
      setText((prev) => `${prev}${template}`);
      invalidateSigned();
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${text.slice(0, start)}${template}${text.slice(end)}`;
    setText(next);
    invalidateSigned();
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + template.length;
      el.setSelectionRange(caret, caret);
    });
  }

  const identityPubkey = identity?.pubkey ?? null;
  useEffect(() => {
    // zmena identity (reset / nová identita) → podpis patrí inej osobe
    setSigned(null);
    setPublished(null);
    setNote(null);
  }, [identityPubkey]);

  const options = useMemo<TopicOption[]>(() => {
    if (topicsProp !== undefined) return flattenTopics(topicsProp);
    return topicsResource.data !== null ? flattenTopics(topicsResource.data.topics) : [];
  }, [topicsProp, topicsResource.data]);

  /** skontroluje vstupy a vráti podpísaný event + pozadie signera, alebo chybovú vetu */
  async function prepare(): Promise<{ event: NostrEvent; signer: SignerSource } | { error: string }> {
    if (identity === null || signer === null) {
      return { error: `${ANONYMOUS_WRITE_COPY.headline.toLowerCase()} — ${ANONYMOUS_WRITE_COPY.detail}` };
    }

    // validácia + šablóna v jednom branchi, aby TS zužovanie `topic`
    // nepretrhalo cez samostatnú booleans `isQuestion`
    const now = Math.floor(Date.now() / 1000);
    let template: EventTemplate;
    if (mode === 'question') {
      if (topic === null) return { error: t('composer.error.needTopic') };
      if (title.trim() === '') return { error: t('composer.error.needTitle') };
      if (text.trim() === '') return { error: t('composer.error.needText') };
      template = {
        kind: KIND_QUESTION,
        content: composeContent(title, text),
        tags: buildQuestionTags(topic),
        created_at: now,
      };
    } else {
      if (text.trim() === '') {
        return { error: t('composer.error.needReplyText') };
      }
      template = {
        kind: 1023,
        content: composeContent(title, text),
        tags: buildReplyTags(replyTo, {
          parentId,
          topicAddress: topicAddress === '' ? null : topicAddress,
          topicSlug: topicAddress === '' ? null : slugFromAddress(topicAddress),
          // F4AI-2b2: jazyk odpovede = jazyk rozhrania (label sa musí
          // pripojiť PRED podpisom, v `buildReplyTags`)
          lang: currentUiLang(),
        }),
        created_at: now,
      };
    }

    try {
      const event = await signer.signEvent(template);
      return { event, signer: signer.source };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** podpis na mieste (bez siete) — náhľad kánonického eventu */
  async function onSign(form?: FormEvent<HTMLFormElement>): Promise<void> {
    form?.preventDefault();
    setError(null);
    setPublished(null);
    setBusy(true);
    try {
      const prepared = await prepare();
      if ('error' in prepared) {
        setSigned(null);
        setError(prepared.error);
        return;
      }
      setSigned(prepared.event);
      setNote(
        t('composer.note.signed', {
          kind: String(prepared.event.kind),
          signer: prepared.signer,
          id: prepared.event.id.slice(0, 12),
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function publishEvent(event: NostrEvent): Promise<void> {
    if (locked) {
      // B10: zamknutý composer — nedosielame event, o ktorom vieme, že
      // dostane 403; dôvod gatewayu ukážeme v tom istom error riadku
      setError(t('composer.title.denied', { reason: write.reason ?? t('composer.unavailable') }));
      return;
    }
    try {
      const result = await api.publish(event);
      setPublished(result);
      setNote(
        result.quorum_met
          ? t('composer.note.published', {
              ok: String(result.results.filter((r) => r.ok).length),
              total: String(result.results.length),
            })
          : t('composer.note.quorum', { error: result.error ?? t('composer.relaysUnanswered') }),
      );
      if (result.quorum_met) {
        onPublished?.(event, result);
        setText('');
        setTitle('');
      }
    } catch (err) {
      setPublished(null);
      // ApiError nesie gateway reasons (400 validácia / 424 quorum) —
      // používáč musí vidieť PREČO, nie len „publish zlyhal“
      setError(err instanceof ApiError ? err.reasons.join('; ') : err instanceof Error ? err.message : String(err));
    }
  }

  async function onPublish(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      let event = signed;
      if (event === null) {
        const prepared = await prepare();
        if ('error' in prepared) {
          setError(prepared.error);
          return;
        }
        event = prepared.event;
        setSigned(event);
      }
      await publishEvent(event);
    } finally {
      setBusy(false);
    }
  }

  /** primárne tlačidlo: podpis + publish v jednom kroku, potom invalidácia */
  async function onSubmit(form: FormEvent<HTMLFormElement>): Promise<void> {
    form.preventDefault();
    setError(null);
    setPublished(null);
    setBusy(true);
    try {
      const prepared = await prepare();
      if ('error' in prepared) {
        setSigned(null);
        setError(prepared.error);
        return;
      }
      setSigned(prepared.event);
      await publishEvent(prepared.event);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="glass-card composer" onSubmit={onSubmit} data-testid={testId}>
      <p className="side-title">{heading ?? t('composer.heading.reply')}</p>

      {identity !== null ? (
        <p className="notice" data-testid="composer-identity">
          {t('composer.signingAs')} <code title={identity.npub}>{npubShort(identity.pubkey)}</code>
          {' · '}
          {t('composer.background')} <code data-testid="composer-signer">{sourceBadge(identity.source)}</code>
        </p>
      ) : (
        <p className="notice" data-testid="composer-anonymous">
          {ANONYMOUS_WRITE_COPY.headline.toLowerCase()} — {ANONYMOUS_WRITE_COPY.detail}
        </p>
      )}

      {locked && (
        <p className="notice" data-testid="composer-locked" title={lockTitle}>
          {lockCopy.headline} — {lockCopy.detail}
        </p>
      )}

      {isQuestion && topic !== null && (
        <p className="notice" data-testid="composer-topic-fixed">
          {t('composer.topicFixedLabel')} <code>{topic.slug}</code> — {t('composer.topicFixed')}{' '}
          <code>{`${topic.address.slice(0, 24)}…`}</code>
        </p>
      )}

      <div className="field">
        <label htmlFor="composer-title">{t('composer.label.title')}</label>
        <input
          id="composer-title"
          name="title"
          value={title}
          disabled={locked}
          title={lockTitle}
          onChange={(event) => {
            setTitle(event.target.value);
            invalidateSigned();
          }}
          placeholder={isQuestion ? t('composer.placeholder.titleQuestion') : t('composer.placeholder.titleOptional')}
        />
      </div>

      <div className="field">
        <label htmlFor="composer-text">{t('composer.label.text')}</label>
        <textarea
          ref={textRef}
          id="composer-text"
          name="text"
          value={text}
          disabled={locked}
          title={lockTitle}
          onChange={(event) => {
            setText(event.target.value);
            invalidateSigned();
          }}
          placeholder={t('composer.placeholder.body')}
        />
        {/* Phase 3b: toolbar formátovania — vloží šablónu zárezu, nič
            nerenderuje (preview robí RichContent až pri čítaní). */}
        <div className="composer-toolbar" data-testid="composer-toolbar" role="group" aria-label={t('composer.toolbar.label')}>
          <button
            type="button"
            className="ghost-btn"
            data-testid="toolbar-mermaid"
            disabled={locked}
            title={t('composer.toolbar.mermaidTitle')}
            onClick={() => {
              insertTemplate(COMPOSER_TEMPLATES.mermaid);
            }}
          >
            {t('composer.toolbar.mermaid')}
          </button>
          <button
            type="button"
            className="ghost-btn"
            data-testid="toolbar-chart"
            disabled={locked}
            title={t('composer.toolbar.chartTitle')}
            onClick={() => {
              insertTemplate(COMPOSER_TEMPLATES.chart);
            }}
          >
            {t('composer.toolbar.chart')}
          </button>
          <button
            type="button"
            className="ghost-btn"
            data-testid="toolbar-math"
            disabled={locked}
            title={t('composer.toolbar.mathTitle')}
            onClick={() => {
              insertTemplate(COMPOSER_TEMPLATES.math);
            }}
          >
            {t('composer.toolbar.math')}
          </button>
        </div>
        <details className="composer-help" data-testid="composer-help">
          <summary>{t('composer.help.summary')}</summary>
          <p className="composer-help-body">{t('composer.help.body')}</p>
        </details>
      </div>

      {!isQuestion && (
        <div className="field">
          <label htmlFor="composer-topic">{t('composer.label.topic')}</label>
          <select
            id="composer-topic"
            name="topic"
            value={topicAddress}
            disabled={locked}
            title={lockTitle}
            onChange={(event) => {
              setTopicAddress(event.target.value);
              invalidateSigned();
            }}
            data-testid="composer-topic"
          >
            <option value="">{t('composer.option.noTopic')}</option>
            {options.map((option) => (
              <option key={option.address} value={option.address}>
                {option.slug}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="composer-actions">
        <button
          type="submit"
          className="primary-btn"
          disabled={busy || locked || connecting}
          title={actionTitle}
          data-testid="composer-submit-btn"
        >
          {isQuestion ? t('composer.submit.publishQuestion') : t('composer.submit.publish')}
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={busy || locked || connecting}
          title={actionTitle}
          onClick={() => {
            void onSign();
          }}
          data-testid="composer-sign-btn"
        >
          {submitLabel ?? t('composer.submit.sign')}
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            void onPublish();
          }}
          disabled={signed === null || busy || locked || connecting}
          title={actionTitle}
          data-testid="composer-publish-btn"
        >
          {t('composer.submit.send')}
        </button>
        <button type="button" className="ghost-btn" onClick={disconnect} data-testid="composer-reset-btn">
          {t('common:actions.disconnect')}
        </button>
      </div>

      {error !== null && (
        <p className="notice error" role="alert" data-testid="composer-error">
          {error}
        </p>
      )}
      {note !== null && error === null && (
        <p className="notice" data-testid="composer-note">
          {note}
        </p>
      )}

      {signed !== null && (
        <details className="signed-event" open data-testid="composer-signed-event">
          <summary>{t('composer.signed.summary')}</summary>
          <pre>{JSON.stringify(signed, null, 2)}</pre>
          <p className="notice">
            {isQuestion
              ? t('composer.signed.topic', { slug: topic?.slug ?? '' })
              : t('composer.signed.root', { root: replyTo.slice(0, 16) })}{' '}
            · {t('composer.signed.content')}{' '}
            {tp('composer.signed.chars', composeContent(title, text).length)}
            {published !== null && (
              <>
                {' · '}
                {t('composer.signed.publish')}
                <code>{JSON.stringify(published)}</code>
              </>
            )}
          </p>
        </details>
      )}
    </form>
  );
}
