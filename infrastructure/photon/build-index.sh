#!/usr/bin/env bash
# Build a Photon index for $PHOTON_AREA out of band, then print the swap.
#
# Same discipline as infrastructure/valhalla/build-tiles.sh: the live service
# keeps answering from the old index for the hours this takes, and only the
# final swap is downtime. Importing straight into the served directory would
# instead take search down for the whole import — Photon's importer "always
# creates a new photon database from scratch. Any existing database is
# silently deleted", so there is no in-place upgrade to fall back on.
#
# Two phases, deliberately separate. Fetching the dump and importing it used to
# be one `curl | zstd | java` pipe, which cost more than it looked: the import
# is CPU-bound and pins its cpu cap, so curl spent the whole run blocked on
# write() and reported the *importer's* throughput as a download speed —
# 268 kB/s against a link measured at 17 MB/s, which reads as a broken mirror.
# Worse, the dump only existed in flight, so every retune or failed import paid
# the full download again. Staging it to disk first costs ~12 min for Europe
# and makes every retry free.
#
# Usage:  ./build-index.sh [area]        # default: europe
set -euo pipefail

AREA="${1:-${PHOTON_AREA:-europe}}"
LIVE="${PHOTON_DATA_DIR:-/home/gjessing/docker/productivity/atlas/photon-data}"
STAGE="$LIVE-staging"
IMAGE="${PHOTON_IMAGE:-photon-photon:latest}"
BASE=https://download1.graphhopper.com/public

NAME="${AREA##*/}"
if [ "$AREA" = planet ]; then DIR=""; else DIR="$AREA/"; fi
DUMP_URL="$BASE/${DIR}photon-dump-$NAME-1.0-latest.jsonl.zst"
DUMP_FILE="$(dirname "$LIVE")/photon-dump-$NAME.jsonl.zst"
DUMP_META="$DUMP_FILE.meta"

# Memory is a hard cap so the worst case is an OOM-killed build container,
# never a wedged host — this box also runs unrelated services. The cpu share
# is 3 of 4: measured mid-import, the old cap of 2 left the host 40% idle with
# swap quiet (vmstat si/so at 0) while the import sat pinned at its ceiling for
# an ETA of 13h. Leave one core for everything else.
LIMITS=(--memory 6g --memory-swap 6g --cpus 3)
HEAP="${PHOTON_HEAP:--Xmx4g}"

HEAD=$(curl -sIfL "$DUMP_URL" | tr -d '\r') || {
  echo "no dump published for area '$AREA': $DUMP_URL" >&2
  exit 1
}
REMOTE_SIZE=$(printf '%s\n' "$HEAD" | awk 'BEGIN{IGNORECASE=1} /^content-length:/{n=$2} END{print n+0}')
REMOTE_TAG=$(printf '%s\n' "$HEAD" | awk 'BEGIN{IGNORECASE=1} /^last-modified:/{$1=""; t=$0} END{print t}')
STAMP="$REMOTE_SIZE $REMOTE_TAG"

AVAIL=$(df -BG --output=avail "$(dirname "$LIVE")" | tail -1 | tr -dc '0-9')
echo "==> area=$AREA  staging=$STAGE  free=${AVAIL}G"
# Europe measured ~50 G of index from a 13 G dump; Norway 1.1 G from 299 M.
# The dump now lands on disk beside the index, so budget for both.
if [ "$AVAIL" -lt 95 ]; then
  echo "only ${AVAIL}G free — a continent-sized index needs ~50G plus ~15G of dump. Aborting." >&2
  exit 1
fi

# --- phase 1: stage the dump ------------------------------------------------
# Resume only against the same remote file: these are "-latest" URLs that are
# replaced periodically, and resuming a partial download of last week's dump
# onto this week's byte offsets yields a corrupt archive that only fails deep
# into the import.
if [ -f "$DUMP_FILE" ] && [ "$(cat "$DUMP_META" 2>/dev/null)" = "$STAMP" ] &&
  [ "$(stat -c %s "$DUMP_FILE")" = "$REMOTE_SIZE" ]; then
  echo "==> dump already staged: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"
else
  if [ -f "$DUMP_FILE" ] && [ "$(cat "$DUMP_META" 2>/dev/null)" != "$STAMP" ]; then
    echo "==> remote dump changed since the partial on disk — refetching from scratch"
    rm -f "$DUMP_FILE"
  fi
  printf '%s' "$STAMP" > "$DUMP_META"
  echo "==> fetching $DUMP_URL ($((REMOTE_SIZE / 1024 / 1024)) MB)"
  curl -fL --continue-at - --retry 5 --retry-delay 10 -o "$DUMP_FILE" "$DUMP_URL"
  GOT=$(stat -c %s "$DUMP_FILE")
  if [ "$GOT" != "$REMOTE_SIZE" ]; then
    echo "short download: got $GOT bytes, expected $REMOTE_SIZE. Aborting." >&2
    exit 1
  fi
fi

# --- phase 2: import --------------------------------------------------------
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> importing into $STAGE (hours; the live index keeps serving)"
docker run --rm "${LIMITS[@]}" \
  -v "$STAGE:/photon/data" \
  -v "$DUMP_FILE:/dump.jsonl.zst:ro" \
  --entrypoint bash "$IMAGE" -c "
  set -euo pipefail
  zstd --stdout -d /dump.jsonl.zst | \
    java $HEAP -jar /photon/photon.jar import -data-dir /photon/data -import-file -"

# The marker entrypoint.sh reads to tell a widened PHOTON_AREA from an index
# that was never re-imported.
echo "$AREA" > "$STAGE/imported-area"

echo "==> built $(du -sh "$STAGE" | cut -f1) — swap it in with:"
echo "    docker stop atlas-photon"
echo "    mv $LIVE $LIVE.old && mv $STAGE $LIVE"
echo "    docker start atlas-photon"
echo "    # then, once searches look right: rm -rf $LIVE.old"
echo "    # the staged dump is kept for cheap retries: rm -f $DUMP_FILE{,.meta}"
