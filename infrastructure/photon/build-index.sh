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
# Usage:  ./build-index.sh [area]        # default: europe
set -euo pipefail

AREA="${1:-${PHOTON_AREA:-europe}}"
LIVE="${PHOTON_DATA_DIR:-/home/gjessing/docker/atlas/photon-data}"
STAGE="$LIVE-staging"
IMAGE="${PHOTON_IMAGE:-photon-photon:latest}"
BASE=https://download1.graphhopper.com/public

NAME="${AREA##*/}"
if [ "$AREA" = planet ]; then DIR=""; else DIR="$AREA/"; fi
DUMP_URL="$BASE/${DIR}photon-dump-$NAME-1.0-latest.jsonl.zst"

# Hard cap so the worst case is an OOM-killed build container, never a wedged
# host — this box also runs unrelated services and its swap is already full.
LIMITS=(--memory 6g --memory-swap 6g --cpus 2)
HEAP="${PHOTON_HEAP:--Xmx4g}"

if ! curl -sIfL -o /dev/null "$DUMP_URL"; then
  echo "no dump published for area '$AREA': $DUMP_URL" >&2
  exit 1
fi

AVAIL=$(df -BG --output=avail "$(dirname "$LIVE")" | tail -1 | tr -dc '0-9')
echo "==> area=$AREA  staging=$STAGE  free=${AVAIL}G"
# Europe measured ~50 G of index from a 13 G dump; Norway 1.1 G from 299 M.
if [ "$AVAIL" -lt 80 ]; then
  echo "only ${AVAIL}G free — a continent-sized index needs ~50G. Aborting." >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> importing $DUMP_URL (hours; the live index keeps serving)"
docker run --rm "${LIMITS[@]}" -v "$STAGE:/photon/data" --entrypoint bash "$IMAGE" -c "
  set -euo pipefail
  curl -fL '$DUMP_URL' | zstd --stdout -d | \
    java $HEAP -jar /photon/photon.jar import -data-dir /photon/data -import-file -"

# The marker entrypoint.sh reads to tell a widened PHOTON_AREA from an index
# that was never re-imported.
echo "$AREA" > "$STAGE/imported-area"

echo "==> built $(du -sh "$STAGE" | cut -f1) — swap it in with:"
echo "    docker stop atlas-photon"
echo "    mv $LIVE $LIVE.old && mv $STAGE $LIVE"
echo "    docker start atlas-photon"
echo "    # then, once searches look right: rm -rf $LIVE.old"
