/**
 * `eventTitle` (F4AI-42) — the one rule that decides what a search result is
 * called. Every branch is a real row shape from the live index, including the
 * two that must NOT produce a title.
 */
import { describe, expect, it } from 'vitest';

import { TITLE_MAX_CHARS, eventTitle } from '../src/titles.js';
import { KINDS } from '../src/kinds.js';
import type { NostrTag } from '../src/types.js';

const t = (kind: number, content: string, tags: NostrTag[] = []) => eventTitle({ kind, content, tags });

describe('eventTitle — thread kinds', () => {
  it('the forum convention `# Title\\n\\nbody` yields the title without the markers', () => {
    expect(t(KINDS.QUESTION, '# How do you stop an AI agent from hallucinating?\n\nBody text.')).toBe(
      'How do you stop an AI agent from hallucinating?',
    );
  });

  it('a plain first line is the title (seeded events have no `#`)', () => {
    expect(t(KINDS.QUESTION, 'Reklamačná poistná zmluva — ako podať reklamačný formulár?\n\ntoken 1afokgvl')).toBe(
      'Reklamačná poistná zmluva — ako podať reklamačný formulár?',
    );
  });

  it('a `title` tag wins over the body, a `subject` tag when there is no title', () => {
    expect(t(KINDS.POST, 'body line', [['title', 'From the tag']])).toBe('From the tag');
    expect(t(KINDS.POST, 'body line', [['subject', 'From the subject']])).toBe('From the subject');
    // an empty tag carries no title — the body still decides
    expect(t(KINDS.POST, '# From the body', [['title', '   ']])).toBe('From the body');
  });

  it('leading blank lines are skipped, whitespace inside the title is collapsed', () => {
    expect(t(KINDS.QUESTION, '\n\n  First   real   line  \n\nrest')).toBe('First real line');
  });
});

describe('eventTitle — papers and topics', () => {
  it('a paper is its `title` tag (the validator requires it since Phase 4a)', () => {
    expect(
      t(KINDS.PUBLICATION, '# Negentropy Gates\n\nbody', [['title', 'Negentropy Gates: Replication and LWW']]),
    ).toBe('Negentropy Gates: Replication and LWW');
  });

  it('a legacy paper without the tag falls back to its first markdown heading', () => {
    expect(t(KINDS.PUBLICATION, 'intro line\n\n## Second Heading\n\ntext')).toBe('Second Heading');
    // a heading inside a code fence is code, not a title
    expect(t(KINDS.PUBLICATION, '```\n# not a heading\n```\n\n# The real one')).toBe('The real one');
  });

  it('a topic is its `d` slug — the name the sidebar and the URL use', () => {
    expect(t(KINDS.TOPIC, 'General discussion of technology.', [['d', 'technology']])).toBe('technology');
    // a topic without a `d` tag still gets something readable
    expect(t(KINDS.TOPIC, 'General discussion of technology.')).toBe('General discussion of technology.');
  });
});

describe('eventTitle — what must NOT become a title', () => {
  it('structured content yields the human string inside it, not the braces', () => {
    // the shape a kind 10030 idea-status event really has
    expect(t(10030, '{"status":"claimed","note":"claim confirmed by the agent"}')).toBe(
      'claim confirmed by the agent',
    );
    // no note → the status is still better than an event id
    expect(t(10030, '{"status":"in_progress"}')).toBe('in_progress');
    // a title/name key inside the JSON wins over the rest
    expect(t(10030, '{"title":"Claim confirmed","note":"whatever"}')).toBe('Claim confirmed');
    // escapes are decoded — a heading must not show `\"` and `\n` literally
    expect(t(10030, '{"note":"claim \\"confirmed\\" by the agent"}')).toBe('claim "confirmed" by the agent');
    // the gateway sends only the head of content, so the JSON can arrive cut off
    expect(t(10030, '{"status":"claimed","note":"claim confirmed by the age')).toBe(
      'claim confirmed by the age',
    );
    // an array carries no label
    expect(t(10030, '[1,2,3]')).toBeNull();
    expect(t(10030, '{"a":1}')).toBeNull();
    // ... unless the event carries a real title tag
    expect(t(10030, '{"status":"claimed"}', [['title', 'Claim confirmed']])).toBe('Claim confirmed');
  });

  it('an empty event has no title', () => {
    expect(t(KINDS.QUESTION, '')).toBeNull();
    expect(t(KINDS.QUESTION, '   \n\n  ')).toBeNull();
  });

  it('a missing or malformed tags array does not throw', () => {
    expect(eventTitle({ kind: KINDS.QUESTION, content: '# Only content' })).toBe('Only content');
    expect(eventTitle({ kind: KINDS.QUESTION, content: 'x', tags: undefined })).toBe('x');
  });

  it('a long title is clamped to TITLE_MAX_CHARS with an ellipsis', () => {
    const long = 'x'.repeat(300);
    const title = t(KINDS.QUESTION, long)!;
    expect(title.length).toBe(TITLE_MAX_CHARS);
    expect(title.endsWith('…')).toBe(true);
    // exactly at the limit stays untouched
    const exact = 'y'.repeat(TITLE_MAX_CHARS);
    expect(t(KINDS.QUESTION, exact)).toBe(exact);
  });
});
