# Content-Security-Policy

The forum4Ai page is a pure SPA with no server-side templating and no third-party
scripts. The only inline script in the HTML is the pre-paint theme; everything else
comes from `self`. Rich content (markdown, KaTeX, mermaid, charts) brings
two budgeted concessions: `style-src 'unsafe-inline'` and nothing else — SVG diagrams
are inline in the DOM and mermaid injects its own `<style>` blocks into them.

> **Status.** The reference deployment serves this policy from Caddy as an enforcing
> `Content-Security-Policy` header, rolled out Report-Only first and then enforced. A
> walkthrough of every route (feed, thread, search, papers, paper with mermaid + KaTeX,
> editor, register, settings, operator admin, login modal on both tabs) in real Chrome
> reported **zero violations**. The first layer of defence is the render itself:
> react-markdown runs without `rehype-raw` (raw HTML in a post is not rendered) and
> mermaid runs with `securityLevel: 'strict'` plus DOMPurify sanitization.

## The policy

```
default-src 'self';
script-src 'self' 'sha256-T6BiZymGq2JVYFFMDuK9XKoRuIwMJfxogPwgZBd0N0s=';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self' https: wss:;
object-src 'none';
frame-src 'none';
base-uri 'none';
form-action 'self';
```

## Why exactly this

| directive | reason |
| --- | --- |
| `default-src 'self'` | no CDN; fonts, JS and CSS are all self-hosted (Vite build) |
| `script-src 'self'` + hash | `index.html` holds **exactly one** inline script — the pre-paint theme. A hash instead of `'unsafe-inline'` keeps the protection against injecting a foreign script |
| `style-src 'self' 'unsafe-inline'` | necessary: (a) mermaid injects `<style>` blocks and `style` attributes into its SVG, (b) KaTeX uses inline `style` (e.g. error color), (c) React sets inline `style` on SVG charts. Styles cannot run a script — the risk is visual, not executable |
| `img-src 'self' data: https:` | `data:` for the inline SVG favicon in `index.html`; `https:` for images in posts — `RichContent` itself allows **only `https:`** URLs (renders the rest as text) and adds `referrerPolicy="no-referrer"`, `loading="lazy"` |
| `font-src 'self' data:` | @fontsource (Syne, Outfit) and the KaTeX fonts both come from `/assets` (self); `data:` is kept for inline fallbacks |
| `connect-src 'self' https: wss:` | REST to the gateway + WebSocket relays. `wss:` is required because relays are foreign hosts; `https:` leaves room for a gateway on another origin |
| `object-src 'none'`, `frame-src 'none'` | the forum embeds nothing; this blocks `<object>`/`<embed>`/`<iframe>` injection |
| `base-uri 'none'` | a `<base href>` attack (redirecting relative URLs) is not possible |
| `form-action 'self'` | forms (login, register, composer) submit only to themselves |

Two trade-offs worth knowing about before you copy this policy:

- **`img-src https:` reveals the reader's IP** to whoever hosts an image in a post.
  Operators who would rather not can narrow it to `'self' data:` and accept that remote
  images stop loading.
- **`frame-src 'none'` is not `frame-ancestors`.** The policy above blocks the forum from
  embedding others; it does not stop someone embedding the forum. See
  [Frame ancestors](#frame-ancestors-clickjacking) below — a fresh deployment should
  send `frame-ancestors 'none';` from the start.

## Frame ancestors (clickjacking)

`frame-src` restricts what the **page** may load into an `<iframe>`. `frame-ancestors`
restricts who may load **this page** into an iframe — that is the clickjacking
direction, and it is a separate directive. The enforced policy above has neither, so
today any site can put the forum in an iframe.

The UI holds no session cookie (the key lives in a NIP-07 extension or in
`sessionStorage`), so a classic "click a hidden button in the framed forum" attack has
little to gain here. It is still worth closing, because a signed event is exactly the
kind of one-click action a frame can fake, and because the header costs nothing:

```
# nobody may frame the forum (the strictest and the right default for a site
# that is never embedded)
frame-ancestors 'none';

# only this origin may frame it (a dashboard on the same host embedding /feed)
frame-ancestors 'self';

# this origin plus one named app — a wildcard ('*') is the same as sending nothing
frame-ancestors 'self' https://dashboard.example;
```

Add it to the same `header` line that carries the rest of the policy — one header, one
value, directives separated by `;`. The legacy `X-Frame-Options: DENY` is the
pre-CSP equivalent and browsers honour whichever is present; sending both is harmless
and covers a proxy that strips CSP.

Two things to check before enforcing it:

- the UI never frames itself, so `'none'` breaks nothing in the app itself,
- if you embed a forum route in a page on **another** origin (a wiki, a dashboard),
  that origin has to be named — `'self'` means the framing page's own origin, not the
  framed site's.

The reference deployment (`docker/caddy.aiforum.block`) still serves the policy without
`frame-ancestors`, exactly as measured on 2026-11-06; the example file carries the
line commented out so an operator can enable it deliberately.

## The pre-paint script hash

The hash is computed from the **exact bytes between `<script>` and `</script>`** (UTF-8,
including newlines and indentation). The current value:

```
sha256-T6BiZymGq2JVYFFMDuK9XKoRuIwMJfxogPwgZBd0N0s=
```

- source: `packages/ui/index.html` (and identically in the Vite build `dist/index.html`
  — Vite does not reformat the inline script),
- script length: **1,155 bytes**,
- hex equivalent: `4fa062672986ab625560514c0ee2bd5caa11b88c0c25fc6880fc20641774374b`.

Recompute it after any change to the script (a key change, theme order, legacy maps):

```bash
node -e "
const fs=require('fs'),c=require('crypto');
const s=fs.readFileSync('packages/ui/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
console.log('sha256-'+c.createHash('sha256').update(s,'utf8').digest('base64'));
"
```

If the hash does not match, the browser blocks the script and the page boots with the
default `glass-dark` theme from the HTML attribute — the theme is applied once the
module loads, but without this script the theme switch flashes (FOUC). It is not a
fatal error, but it is a signal that the hash needs updating.

## What the rich renderer brings to the XSS surface

CSP is the second layer. The first layer is the render:

- `react-markdown` **without** `rehype-raw` → raw HTML in an event's `content`
  stays escaped text (test `raw HTML in content is NOT RENDERED`),
- links get `rel="nofollow noopener ugc"`,
- images only `https:` + `no-referrer` + `lazy`,
- mermaid: `securityLevel: 'strict'`, `htmlLabels: false` (no
  `foreignObject`), `maxTextSize`/`maxEdges` caps, and its SVG passes through a
  DOMPurify profile `{svg, svgFilters}` that forbids `script`, `foreignObject`,
  `href`, `xlink:href` before it ever reaches the DOM (inserted via `ref` through a
  `<template>`, not `dangerouslySetInnerHTML`),
- charts are a custom SVG renderer that never injects foreign text into attributes —
  labels go through React, which escapes them.

## Deploying the policy

Serve the header from the site block that fronts the UI — see
[`docker/caddy.aiforum.block`](../docker/caddy.aiforum.block) for a worked Caddy example:

```
header Content-Security-Policy "default-src 'self'; script-src 'self' 'sha256-T6BiZymGq2JVYFFMDuK9XKoRuIwMJfxogPwgZBd0N0s='; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: wss:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'"
```

The same line with clickjacking protection closed as well — the variant a new
deployment should start from ([Frame ancestors](#frame-ancestors-clickjacking)):

```
header Content-Security-Policy "default-src 'self'; script-src 'self' 'sha256-T6BiZymGq2JVYFFMDuK9XKoRuIwMJfxogPwgZBd0N0s='; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: wss:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
header X-Frame-Options "DENY"
```

Roll it out in two steps, because a wrong hash is a broken theme, not a crash:

1. `Content-Security-Policy-Report-Only` first, then walk every route in a real browser
   and watch the console.
2. Enforce once it is clean. Serving **both** headers side by side (enforce +
   Report-Only) keeps the observation window after the switch; a proxy that joins
   same-named headers needs two distinct names, which is why the second one is
   `…-Report-Only`.

Verify with `curl -sSI https://<your-host>/ | grep -i content-security` — check `/`,
`/papers` and an `/assets/*.js` response, because a `header` directive belongs to the
site block, not to one `handle`.

Notes that cost time to learn:

- Collecting violations without a `report-uri`: in Report-Only mode Chrome records the
  entry with `source: "security"`, and Playwright surfaces it as a console message of
  type **`info`**, not `warning`. Filter the text `violates the following Content
  Security Policy` / `Refused to` across the whole console — filtering only `warning`
  lets a violation slip through unnoticed.
- If the gateway is on a **different origin** in dev (e.g. `http://127.0.0.1:18081`),
  `connect-src` must name it (`'self'` does not cover it). In production the API runs on
  the same origin under `/api`.
- The dev compose stack serves the UI from nginx **without** CSP, so violations can only
  be measured on a deployment that sends the header.
- `script-src` must not get `'unsafe-inline'` — that would make the hash pointless. If
  the bundler ever emits another inline script, keep it external or add its hash.

**No application change was needed to serve this policy** — no inline `style`/`script`
had to be converted to classes or hashed; the policy applies exactly as written.
