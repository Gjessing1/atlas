#!/bin/sh
# Production-shaped server for the e2e suite: build everything, serve the web
# bundle from the backend same-origin (exactly like the Docker image), with
# in-memory auth/sync stores so account journeys work without Postgres.
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
npm run build
rm -rf backend/public
cp -r apps/web/dist backend/public
PORT="${E2E_PORT:-3199}"
export PORT
export DATABASE_URL=memory
export JWT_SECRET=e2e-secret
export ATLAS_DATA_DIR="${ATLAS_E2E_DATA_DIR:-/tmp/atlas-e2e-data}"
mkdir -p "$ATLAS_DATA_DIR"
exec node backend/dist/index.js
