/**
 * Page state panels (S11, F4AI-17): loading / error / empty.
 * Every page uses them uniformly, so the skeleton behaves the same
 * everywhere (spinner, the error reason sentence from `ApiError.reasons`, retry).
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiError } from '../api/client.js';

export function StateLoading({ label }: { label?: string }): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <section className="glass-panel state" data-testid="state-loading" aria-busy="true">
      <div className="spinner" />
      <p className="state-title">{label ?? t('states.loading')}</p>
    </section>
  );
}

export function StateError({
  error,
  onRetry,
}: {
  error: ApiError;
  onRetry?: () => void;
}): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <section className="glass-panel state state-error" data-testid="state-error" role="alert">
      <p className="state-title">{t('states.gatewayError')}</p>
      <p className="state-detail">
        <code>{error.code}</code>
        {error.status > 0 ? t('states.httpStatus', { status: String(error.status) }) : t('states.offline')}
      </p>
      <ul className="state-detail">
        {error.reasons.map((reason, index) => (
          <li key={index}>{reason}</li>
        ))}
      </ul>
      {onRetry !== undefined && (
        <button type="button" className="retry-btn" onClick={onRetry}>
          {t('actions.retry')}
        </button>
      )}
    </section>
  );
}

export function StateEmpty({
  title,
  hint = '',
}: {
  title?: string;
  hint?: string;
}): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <section className="glass-panel state" data-testid="state-empty">
      <p className="state-title">{title ?? t('states.empty')}</p>
      {hint !== '' && <p className="state-detail">{hint}</p>}
    </section>
  );
}
