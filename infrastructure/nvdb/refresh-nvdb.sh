#!/usr/bin/env bash
# Daily, cheap NVDB freshness check; bounded, atomic rebuild when warranted.
#
# Thresholds intentionally distinguish material object changes from automatic
# road-network resegmentation. Override them in the systemd service environment
# for an exceptional period without editing the producer:
#   NVDB_CONTENT_CHANGE_THRESHOLD=500
#   NVDB_SEGMENT_CHANGE_THRESHOLD=25000
#   NVDB_MAX_AGE_DAYS=14
set -euo pipefail

DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
NVDB_DIR="$DATA_DIR/nvdb"
CURRENT="$NVDB_DIR/nvdb.sqlite"
CANDIDATE="$NVDB_DIR/nvdb.sqlite.next"
PREVIOUS="$NVDB_DIR/nvdb.sqlite.previous"
STATE="$NVDB_DIR/refresh-state.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_CONTAINER="${ATLAS_BACKEND_CONTAINER:-atlas-backend}"

mkdir -p "$NVDB_DIR"
exec 9>"$NVDB_DIR/.refresh.lock"
if ! flock -n 9; then
  echo "NVDB refresh already running — leaving it alone"
  exit 0
fi

[[ -s "$CURRENT" ]] || {
  echo "missing $CURRENT — an initial manual build is required" >&2
  exit 1
}

if [[ -s "$STATE" ]]; then
  SINCE="$(jq -er '.sourceThrough' "$STATE")"
else
  # Bootstrap an existing hand-built dataset. Its mtime is the most
  # conservative trustworthy watermark available; the first automated build
  # writes an explicit source-through timestamp.
  SINCE="$(date -u -r "$CURRENT" +%Y-%m-%dT%H:%M:%SZ)"
fi

echo ">> Checking NVDB changes since $SINCE"
DECISION="$(node "$SCRIPT_DIR/refresh-check.mjs" --since "$SINCE")"
echo "$DECISION" | jq .
if [[ "$(jq -r '.rebuild' <<<"$DECISION")" != "true" ]]; then
  echo ">> Dataset remains inside refresh thresholds"
  exit 0
fi

BUILD_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ">> Rebuilding because $(jq -r '.reason' <<<"$DECISION")"
rm -f "$CANDIDATE" "$CANDIDATE-journal" "$CANDIDATE-wal" "$CANDIDATE-shm"
trap 'rm -f "$CANDIDATE" "$CANDIDATE-journal" "$CANDIDATE-wal" "$CANDIDATE-shm"' EXIT
node "$SCRIPT_DIR/build-nvdb.mjs" "$CANDIDATE"
VALIDATION="$(node "$SCRIPT_DIR/validate-nvdb.mjs" "$CANDIDATE" "$CURRENT")"
echo "$VALIDATION" | jq .

# Preserve the last good inode, then atomically replace the live path. A
# backend process that has not restarted yet keeps reading its already-open
# old SQLite; new opens can only see the complete candidate.
ln -f "$CURRENT" "$PREVIOUS"
mv -f "$CANDIDATE" "$CURRENT"
trap - EXIT

echo ">> Restarting $BACKEND_CONTAINER so it opens the new SQLite"
docker restart "$BACKEND_CONTAINER"

STATE_NEXT="$STATE.next"
jq -n \
  --arg sourceThrough "$BUILD_STARTED" \
  --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson decision "$DECISION" \
  --argjson validation "$VALIDATION" \
  '{sourceThrough:$sourceThrough,completedAt:$completedAt,decision:$decision,validation:$validation}' \
  > "$STATE_NEXT"
mv -f "$STATE_NEXT" "$STATE"
echo ">> NVDB refresh published; previous dataset: $PREVIOUS"
