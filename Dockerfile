# syntax=docker/dockerfile:1
#
# forum4ai — multi-stage build for the dev stack (F4AI-9, extended in S15 with
# gateway + indexer, F4AI-21):
#
#   relay    → `node packages/relay/dist/cli.js`   (CMD default, port 8080)
#   gateway  → `node packages/gateway/dist/cli.js` (compose command, 3001)
#   indexer  → `node packages/indexer/dist/cli.js` (compose command)
#   ui       → nginx serving the web UI dist       (compose service `web`, 80)
#
# UI build (F4AI-21): stage `ui-build` runs `pnpm --filter @forum4ai/ui build`
# with ARG `VITE_GATEWAY_URL` (default http://127.0.0.1:18081 — Vite bakes the
# value into the bundle at build time); stage `ui` deploys the dist onto nginx.
# The host's node modules never get dragged in — the UI is built inside Docker.
#
# Build (context = the repository root) — CAREFUL: since F4AI-21 the last stage
# is `ui`, so a build without --target tags the nginx image:
#   docker build --target runtime -t forum4ai-relay:dev .   # relay/gateway/indexer
#   docker build --target ui      -t forum4ai-web:dev .     # nginx + UI dist
# or through compose (recommended — both targets have an explicit `target:`):
#   docker compose -f docker/docker-compose.yml up -d --build
#
# Starting the relay: configured with the env vars
# RELAY_HOST / RELAY_PORT / RELAY_POW_MIN / RELAY_RATE_MAX /
# RELAY_RATE_WINDOW_MS (see packages/relay/src/cli.ts).
# The NIP-11 information document is served at GET / with the header
# `Accept: application/nostr+json` (packages/relay/src/server.ts).

# ── 1) build stage: TypeScript build shared + relay + gateway + indexer ──────
FROM node:22-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# dependency-only layer — the cache is not invalidated by a source code change
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/relay/package.json ./packages/relay/
COPY packages/gateway/package.json ./packages/gateway/
COPY packages/indexer/package.json ./packages/indexer/
COPY packages/ui/package.json ./packages/ui/
RUN corepack enable && \
    pnpm install --frozen-lockfile \
      --filter "@forum4ai/relay..." --filter "@forum4ai/gateway..." --filter "@forum4ai/indexer..."

COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm --filter @forum4ai/shared build && \
    pnpm --filter @forum4ai/relay build && \
    pnpm --filter @forum4ai/gateway build && \
    pnpm --filter @forum4ai/indexer build

# ── 2) runtime stage: production deps of all three packages + dist ────────────
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="forum4ai-relay" \
      org.opencontainers.image.description="forum4ai — tenký NIP-01 relay + gateway + indexer (Node 22)" \
      org.opencontainers.image.source="https://github.com/KEEPEE/forum4ai"

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8080

WORKDIR /app

# install of the production dependencies (nostr-tools, ws, hono, better-sqlite3, ...)
# for relay + gateway + indexer plus their workspace dependency shared — without
# devDependencies (typescript, vitest, eslint, testing-library, ...)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/relay/package.json ./packages/relay/
COPY packages/gateway/package.json ./packages/gateway/
COPY packages/indexer/package.json ./packages/indexer/
COPY packages/ui/package.json ./packages/ui/
RUN corepack enable && \
    pnpm install --frozen-lockfile --prod \
      --filter "@forum4ai/relay..." --filter "@forum4ai/gateway..." --filter "@forum4ai/indexer..."

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/relay/dist ./packages/relay/dist
COPY --from=build /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=build /app/packages/indexer/dist ./packages/indexer/dist
# live test (docker/test-ws.mjs is a wrapper for it) — ideal for testing from inside the network
COPY packages/relay/test-live ./packages/relay/test-live
# /data for the indexer SQLite — a named volume inherits this directory's
# ownership on first creation (otherwise it is root-owned and USER node cannot create the DB file)
RUN mkdir -p /data && chown node:node /data

EXPOSE 8080 3001
USER node
CMD ["node", "packages/relay/dist/cli.js"]

# ── 3) ui-build stage: Vite build of the web UI (F4AI-21) ────────────────────
#
# A separate stage — the UI dependencies (vite, react, testing-library) stay out
# of the relay's runtime image. `--filter "@forum4ai/ui..."` also installs the
# workspace dependency `@forum4ai/shared` (type imports from it; tsc needs its dist).
#
# ARG VITE_GATEWAY_URL is set as an ENV right before the build RUN — so the
# `pnpm install` layer is not rebuilt when the URL changes. Vite reads `VITE_*`
# env vars at build time and bakes them into the bundle (packages/ui/src/api/client.ts).
#
# `ARG VITE_ALLOW_NSEC` (F4AI-31, Phase 7) is a dev gate for putting a private key
# into the page (`nsecAllowed` in `packages/ui/src/nostr/signer.ts`). The value
# MUST be the string `true` — no other value (not even `1`) opens the gate; the
# test `packages/ui/test/signer.test.ts` is what holds that. The production stage
# leaves it undefined → the ENV stays empty and the UI does not show the `nsec`
# tab. The dev stack is built with `--build-arg VITE_ALLOW_NSEC=true`.
FROM node:22-bookworm-slim AS ui-build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
RUN corepack enable && \
    pnpm install --frozen-lockfile --filter "@forum4ai/ui..."

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui

ARG VITE_GATEWAY_URL=http://127.0.0.1:18081
ENV VITE_GATEWAY_URL=${VITE_GATEWAY_URL}
# An empty default = the gate stays closed (Vite injects `""`, `nsecAllowed` tests
# `=== 'true'`). Dev stack: `--build-arg VITE_ALLOW_NSEC=true`.
# The ENV is set only here, so changing the gate does not rebuild the `pnpm install` layer.
ARG VITE_ALLOW_NSEC=
ENV VITE_ALLOW_NSEC=${VITE_ALLOW_NSEC}
RUN pnpm --filter @forum4ai/shared build && \
    pnpm --filter @forum4ai/ui build

# ── 4) ui stage: nginx serving the dist (compose service `web`, F4AI-21) ─────
#
# Pin to the major: `nginx:1.30-alpine` = the newest STABLE nginx branch (the
# `stable-alpine` tag points at 1.30.x too — verified through the Docker Hub API
# hub.docker.com/v2/repositories/library/nginx/tags, 2026-10-29: 1.30.6-alpine;
# the mainline/`alpine` tag is 1.31.8 = an odd-minor branch with new features).
# nginx:alpine ships busybox `wget` → a healthcheck without installing curl.
FROM nginx:1.30-alpine AS ui

LABEL org.opencontainers.image.title="forum4ai-web" \
      org.opencontainers.image.description="forum4ai — nginx s Vite dist webového UI" \
      org.opencontainers.image.source="https://github.com/KEEPEE/forum4ai"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=ui-build /app/packages/ui/dist /usr/share/nginx/html

EXPOSE 80

