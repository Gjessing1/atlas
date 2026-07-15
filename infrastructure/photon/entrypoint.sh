#!/usr/bin/env bash
# First start: import the Photon JSONL dump for $PHOTON_REGION/$PHOTON_COUNTRY
# (weekly exports from download1.graphhopper.com) into the mounted data dir.
# Subsequent starts skip straight to serving. Delete the photon_data dir to
# force a re-import with a fresh dump.
set -euo pipefail

REGION="${PHOTON_REGION:-europe}"
COUNTRY="${PHOTON_COUNTRY:-norway}"
DATA_DIR=/photon/data
JAVA_OPTS="${JAVA_OPTS:--Xmx2g}"

mkdir -p "$DATA_DIR"

if [ ! -d "$DATA_DIR/photon_data" ]; then
  DUMP_URL="https://download1.graphhopper.com/public/$REGION/$COUNTRY/photon-dump-$COUNTRY-1.0-latest.jsonl.zst"
  echo ">> No index in $DATA_DIR - importing $DUMP_URL"
  curl -fL "$DUMP_URL" | zstd --stdout -d | \
    java $JAVA_OPTS -jar /photon/photon.jar import -data-dir "$DATA_DIR" -import-file -
  echo ">> Import finished"
fi

exec java $JAVA_OPTS -jar /photon/photon.jar serve \
  -data-dir "$DATA_DIR" -listen-ip 0.0.0.0 -listen-port 2322
