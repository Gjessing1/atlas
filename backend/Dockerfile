# syntax=docker/dockerfile:1
# Multi-stage build for the Atlas backend + web app (served same-origin).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/conditions/package.json ./packages/conditions/
COPY packages/gpx/package.json ./packages/gpx/
COPY packages/storage/package.json ./packages/storage/
COPY packages/routing/package.json ./packages/routing/
COPY packages/navigation/package.json ./packages/navigation/
COPY packages/app-hooks/package.json ./packages/app-hooks/
COPY packages/sync/package.json ./packages/sync/
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
RUN npm run format:check && npm run lint && npm run build && npm run typecheck && npm test
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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/core/dist ./packages/core/dist
# @atlas/conditions currently only lends the backend types, but ship its dist
# so a future value import can't crash the runtime image.
COPY --from=build /app/packages/conditions/package.json ./packages/conditions/
COPY --from=build /app/packages/conditions/dist ./packages/conditions/dist
# @atlas/sync is a runtime import of the backend (LWW + protocol helpers).
COPY --from=build /app/packages/sync/package.json ./packages/sync/
COPY --from=build /app/packages/sync/dist ./packages/sync/dist
COPY --from=build /app/backend/package.json ./backend/
# Workspace-nested deps (npm nests a package here when the root already holds a
# different version — e.g. @sinclair/typebox 0.34 vs a transitive 0.27): the
# root node_modules copy alone loses them and the server crashes on import.
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
# Built web app → backend/public, served same-origin by backend/src/index.ts.
COPY --from=build /app/apps/web/dist ./backend/public
WORKDIR /app/backend
EXPOSE 3100
CMD ["node", "dist/index.js"]
