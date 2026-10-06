# syntax=docker/dockerfile:1.7
# One Dockerfile builds every app.
#   api / worker / smoke:  docker build --build-arg APP=api --target runtime .
#   web (Next.js):         docker build --build-arg APP=web --target runtime-web .
# Local development does NOT use this file: `pnpm dev` runs apps on the host with hot reload.
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS base
RUN npm install -g pnpm@12.9.1
WORKDIR /repo

# Layer 1: dependency download, cached until pnpm-lock.yaml changes.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm fetch

# Layer 2: install + build one app.
FROM fetch AS build
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile
ARG APP
RUN pnpm --filter @bananagig/${APP} build

# Minimal runtime base: Node only. npm/corepack/yarn are removed (not needed at runtime, and they ship
# their own vulnerable dependency trees).
FROM ${NODE_IMAGE} AS runtime-base
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=dev
ARG BUILD_TIME=unknown
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA} BUILD_TIME=${BUILD_TIME}
WORKDIR /app
EXPOSE 3000

# api / worker / smoke: single bundled file, no node_modules, non-root.
FROM runtime-base AS runtime
ARG APP
COPY --from=build --chown=node:node /repo/apps/${APP}/dist/index.js ./index.js
USER node
CMD ["node", "index.js"]

# web: Next.js standalone output. Needs a writable .next/cache -> mount a tmpfs there (read-only root fs).
FROM runtime-base AS runtime-web
ENV PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
CMD ["node", "apps/web/server.js"]
