/**
 * Formatting helpers for the UI (S11, F4AI-17).
 *
 * `KIND_LABELS` is a local copy of the labels for `KINDS` from
 * `packages/shared/src/kinds.ts` — we keep the kind numbers here because a
 * runtime import from `@forum4ai/shared` would bring the nostr-tools validators
 * into the bundle. The test `test/kinds.test.ts` checks that the numbers match the
 * shared registry (one source of truth, one checked place).
 *
 * Phase 2a: the texts (relative time, title fallback) live in
 * `locales/{en,sk,de}/common.json` — `KIND_LABELS` stay technical protocol labels
 * (`question`/`reply`/…) that are not translated. F4AI-43 added the `Intl`
 * formatting of dates and numbers, which follows the interface language too.
 */
import { currentIntlLocale, t } from '../i18n/text.js';

export const KIND_LABELS: Record<number, { label: string; className: string }> = {
  1020: { label: 'question', className: '' },
  1021: { label: 'idea call', className: 'idea' },
  1022: { label: 'collab call', className: 'collab' },
  1023: { label: 'reply', className: '' },
  1024: { label: 'reaction', className: '' },
  1030: { label: 'vote', className: '' },
  1031: { label: 'rating', className: '' },
  1032: { label: 'accepted', className: '' },
  10030: { label: 'idea status', className: '' },
  30020: { label: 'topic', className: 'collab' },
  30023: { label: 'paper', className: 'idea' },
  0: { label: 'profile', className: '' },
  3: { label: 'contacts', className: '' },
};

export function kindLabel(kind: number): string {
  return KIND_LABELS[kind]?.label ?? `kind ${String(kind)}`;
}

export function kindClassName(kind: number): string {
  return KIND_LABELS[kind]?.className ?? '';
}

/** skráti hex reťazec na `abcd…wxyz` (pubkey/id sa v UI nezobrazujú celé) */
export function shortHex(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Nadpis príspevku: NIP-01 `content` je plain text, naša konvencia je
 * `# Nadpis\n\ntext` (pozri `composeContent` v `nostr/keys.ts`).
 */
export function titleFromContent(content: string, fallback?: string): string {
  const firstLine = content.trim().split('\n')[0] ?? '';
  const heading = firstLine.replace(/^#+\s*/, '').trim();
  if (heading !== '') return heading.length > 120 ? `${heading.slice(0, 120)}…` : heading;
  const body = content.trim().split('\n').find((line) => line.trim() !== '') ?? '';
  return body.trim() === '' ? (fallback ?? t('common:format.noTitle')) : shortHex(body.trim(), 80, 0);
}

/** text príspevku bez prvého riadku (nadpis už zobrazujeme samostatne) */
export function bodyFromContent(content: string): string {
  const lines = content.trim().split('\n');
  const rest = lines.slice(1).join('\n').trim();
  return rest === '' ? content.trim() : rest;
}

/** `created_at` (unix sekundy) → relatívny čas v aktuálnom jazyku */
export function formatRelativeTime(unixSeconds: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000 - unixSeconds));
  if (seconds < 60) return t('common:time.now');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('common:time.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common:time.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('common:time.days', { count: days });
  // F4AI-43: older posts show an absolute date — in the locale of the
  // interface, because `08.11.2026` is a German date and `11/08/2026` is not
  return new Intl.DateTimeFormat(currentIntlLocale(), { dateStyle: 'medium' }).format(
    new Date(unixSeconds * 1000),
  );
}

/**
 * `created_at` → absolútny dátum (tooltip / detail).
 *
 * F4AI-43: the pattern comes from `Intl` (so German reads `08.11.2026, 09:51`),
 * but the zone stays spelled out as `UTC` — a forum timestamp that silently
 * means "your local time" is worse than one that says what it is.
 */
export function formatAbsoluteTime(unixSeconds: number): string {
  const formatted = new Intl.DateTimeFormat(currentIntlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(unixSeconds * 1000));
  return `${formatted} UTC`;
}

/** percento z 0..1 na 1 desatinné miesto (reputácia, rating) */
export function formatPercent(value: number): string {
  return new Intl.NumberFormat(currentIntlLocale(), {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatScore(value: number): string {
  return new Intl.NumberFormat(currentIntlLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** topic slug z adresy `30020:<pubkey>:<slug>` */
export function slugFromAddress(address: string | null): string | null {
  if (address === null) return null;
  const parts = address.split(':');
  return parts.length === 3 ? (parts[2] ?? null) : null;
}

/** `t` tagy z eventu (topic/štítky) */
export function topicTags(tags: string[][]): string[] {
  return tags.filter((tag) => tag[0] === 't' && typeof tag[1] === 'string').map((tag) => tag[1] as string);
}

/** adresa topicu z `a` tagu */
export function addressFromTags(tags: string[][]): string | null {
  const tag = tags.find((item) => item[0] === 'a' && typeof item[1] === 'string');
  return tag ? (tag[1] as string) : null;
}
