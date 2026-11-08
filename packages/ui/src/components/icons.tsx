/**
 * Inline SVG icons (F4AI-41).
 *
 * The sidebar used to put typographic glyphs in a span (≡ ✦ ⌗ ▤ ⌕ ✎ ⚙ ★ ▸ ▾).
 * None of those codepoints is in the bundled font files — they are subset to
 * `outfit-latin` / `outfit-latin-ext` — so every icon was drawn by whatever
 * fallback font the operating system happened to supply. That is how "Papers"
 * ended up as an empty box (U+2317 has no fallback everywhere) and why ⌕ came
 * out visibly smaller than its neighbours: same span, different font, different
 * metrics.
 *
 * A path stroked with `currentColor` needs no font at all: identical shape,
 * size and colour on every machine, and it follows the theme (and the active
 * link's accent colour) for free.
 *
 * The grid is 24×24 with a 1.8 stroke, drawn on the optical centre so all
 * icons carry the same visual weight.
 */
import type { JSX } from 'react';

export type IconName =
  | 'feed'
  | 'ideas'
  | 'papers'
  | 'search'
  | 'edit'
  | 'settings'
  | 'star'
  | 'chevron-right'
  | 'chevron-down';

/** one `d` per icon — deliberately short, these are line icons, not illustrations */
const PATHS: Record<IconName, string> = {
  // three rows of dot + line: a feed is a list, and the dots keep it from
  // reading as a hamburger menu toggle (the dots are drawn as filled circles,
  // see DOTS below — a stroked zero-length segment is too small to survive)
  feed: 'M8 6h12M8 12h12M8 18h11',
  ideas: 'M12 3.5l2 5.6 5.6 2-5.6 2-2 5.6-2-5.6-5.6-2 5.6-2z',
  papers: 'M6 3.5h9l3.5 3.5V20.5H6zM9.5 9.5h7M9.5 13h7M9.5 16.5h4.5',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.4 15.4L20 20',
  edit: 'M4.5 19.5h4L20 8l-4-4L4.5 15.5zM14.5 5.5l4 4',
  settings: 'M4 8h8M16.5 8H20M4 16h3.5M12 16H20M14.2 5.6v4.8M9.8 13.6v4.8',
  star: 'M12 3.6l2.7 5.4 5.9.9-4.3 4.2 1 5.9-5.3-2.8-5.3 2.8 1-5.9L3.4 9.9l5.9-.9z',
  'chevron-right': 'M9.5 5.5L16 12l-6.5 6.5',
  'chevron-down': 'M5.5 9.5L12 16l6.5-6.5',
};

/**
 * Filled dots an icon needs in addition to its stroke. A stroked zero-length
 * segment is the usual trick, but at 16 px it disappears; a real circle with a
 * radius survives every size.
 */
const DOTS: Partial<Record<IconName, [number, number][]>> = {
  feed: [
    [4, 6],
    [4, 12],
    [4, 18],
  ],
};

export interface IconProps {
  name: IconName;
  /** extra class for sizing/colour when the icon sits somewhere unusual */
  className?: string;
}

/**
 * Decorative by definition: the label next to it carries the meaning, so the
 * icon is hidden from assistive technology (`aria-hidden`) and never given a
 * title of its own.
 */
export function Icon({ name, className }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? 'icon'}
      role="presentation"
      aria-hidden="true"
      focusable="false"
      data-testid={`icon-${name}`}
    >
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {(DOTS[name] ?? []).map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.15" fill="currentColor" />
      ))}
    </svg>
  );
}
