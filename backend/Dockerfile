# syntax=docker/dockerfile:1
# Multi-stage build for the Atlas backend + web app (served same-origin).
FROM protomaps/go-pmtiles:v1.31.1 AS pmtiles

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
# Whole packages tree (source only — .dockerignore excludes dist/ + node_modules),
# so a new workspace never needs a hand-added COPY line. dist/ is rebuilt below.
COPY packages ./packages
COPY apps/web/package.json ./apps/web/
COPY backend/package.json ./backend/
# Single deterministic install for every workspace. The npm download cache persists
# across builds via the BuildKit cache mount; the layer only re-runs when
# package-lock.json changes.
RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspaces --include-workspace-root --no-audit --no-fund --prefer-offline
COPY . .
# Quality gate baked into the image build: format, lint, build, types, tests.
# If any fail the build fails, so nothing gets tagged or pushed.
# `build` runs before `typecheck` because web/backend typecheck against @atlas/core's dist.
# `test:all` — not `test` — because this is the run that decides whether a deploy
# happens: the local pre-push gate may skip *.slow.test.ts, this one never does.
RUN npm run format:check && npm run lint && npm run build && npm run typecheck && npm run test:all
# GIT_SHA (CI build-arg; .git is dockerignored so it can't be derived here) is exposed
# by /api/health so the deployed version is identifiable.
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
COPY --from=pmtiles /go-pmtiles /usr/local/bin/pmtiles
COPY --from=build /app/node_modules ./node_modules
# Every workspace package, wholesale (dist + manifest for all of them). The root
# node_modules copy carries an @atlas/* symlink for each package; if a package
# the backend imports isn't copied here that symlink dangles and the server
# crash-loops on import — exactly what @atlas/routing did in v0.75.0. Copying the
# whole tree means a new backend import can never rot this list again. dist was
# built and dev-deps pruned in the build stage; leftover source .ts is harmless.
COPY --from=build /app/packages ./packages
COPY --from=build /app/backend/package.json ./backend/
# Workspace-nested deps (npm nests a package here when the root already holds a
# different version — e.g. @sinclair/typebox 0.34 vs a transitive 0.27): the
# root node_modules copy alone loses them and the server crashes on import.
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
# Completes one upstream's broken TLS chain (kart.miljodirektoratet.no ships its
# leaf twice and omits the signing intermediate). See backend/certs/upstream-cas.pem
# for why this is safe and what the N7 status probe watches for.
COPY --from=build /app/backend/certs ./backend/certs
ENV NODE_EXTRA_CA_CERTS=/app/backend/certs/upstream-cas.pem
# Built web app → backend/public, served same-origin by backend/src/index.ts.
COPY --from=build /app/apps/web/dist ./backend/public
WORKDIR /app/backend
EXPOSE 3100
CMD ["node", "dist/index.js"]
