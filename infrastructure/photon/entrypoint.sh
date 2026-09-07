#!/usr/bin/env bash
# First start: import the Photon JSONL dump for $PHOTON_AREA into the mounted
# data dir. Subsequent starts skip straight to serving. Delete the photon_data
# dir to force a re-import with a fresh dump.
#
# PHOTON_AREA names a dump on the GraphHopper export server, which publishes
# three path shapes:
#
#   planet         -> /public/photon-dump-planet-1.0-latest.jsonl.zst
#   europe         -> /public/europe/photon-dump-europe-1.0-latest.jsonl.zst
#   europe/norway  -> /public/europe/norway/photon-dump-norway-1.0-latest.jsonl.zst
#
# All three follow one rule: the dump sits in the area's own directory, named
# after the area's last segment, and the planet's directory is the server root.
# So a single variable covers a country, a continent or the world, and widening
# coverage is an edit here rather than a second URL scheme.
#
# Note the "DB dump" column on those download pages describes the prebuilt
# database tarballs, NOT these JSON dumps: british-islands is marked absent
# there and still publishes a daily JSONL dump, which is the one we import.
set -euo pipefail

AREA="${PHOTON_AREA:-europe/norway}"
DATA_DIR=/photon/data
JAVA_OPTS="${JAVA_OPTS:--Xmx2g}"
BASE=https://download1.graphhopper.com/public
MARKER="$DATA_DIR/imported-area"

mkdir -p "$DATA_DIR"

NAME="${AREA##*/}"
if [ "$AREA" = planet ]; then DIR=""; else DIR="$AREA/"; fi
DUMP_URL="$BASE/${DIR}photon-dump-$NAME-1.0-latest.jsonl.zst"

if [ -d "$DATA_DIR/photon_data" ]; then
  # An index built for a different area is the failure mode this marker exists
  # to catch: widening PHOTON_AREA and restarting looks like it worked, but the
  # import is skipped and the old, narrower index keeps answering — which is
  # indistinguishable from "the new dump is missing my country". Serving on is
  # still the right call (a working narrow index beats a container that will
  # not start), so this warns loudly rather than aborting.
  PREV="$(cat "$MARKER" 2>/dev/null || echo unknown)"
  if [ "$PREV" != "$AREA" ]; then
    echo ">> WARNING: the index in $DATA_DIR was imported for '$PREV', not '$AREA'."
    echo ">> WARNING: serving '$PREV'. Delete $DATA_DIR/photon_data to re-import."
  fi
else
  echo ">> No index in $DATA_DIR - importing $DUMP_URL"
  curl -fL "$DUMP_URL" | zstd --stdout -d | \
    java $JAVA_OPTS -jar /photon/photon.jar import -data-dir "$DATA_DIR" -import-file -
  echo "$AREA" > "$MARKER"
  echo ">> Import finished"
fi

exec java $JAVA_OPTS -jar /photon/photon.jar serve \
  -data-dir "$DATA_DIR" -listen-ip 0.0.0.0 -listen-port 2322
