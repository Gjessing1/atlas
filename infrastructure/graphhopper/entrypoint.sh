#!/usr/bin/env bash
# First start: build the routing graph (all profiles + landmarks + elevation)
# from the OSM extract at $GRAPHHOPPER_PBF, downloading it first if missing.
# Subsequent starts skip straight to serving. To refresh OSM data, replace the
# .pbf, delete /data/graph-cache and restart (intended as an overnight job —
# the import takes hours for Norway on modest hardware).
set -euo pipefail

PBF="${GRAPHHOPPER_PBF:-/data/norway.osm.pbf}"
PBF_URL="${GRAPHHOPPER_PBF_URL:-https://download.geofabrik.de/europe/norway-latest.osm.pbf}"
DATA_DIR=/data
JAVA_OPTS="${JAVA_OPTS:--Xmx2g}"
# Import needs far more heap than serving; sized separately.
JAVA_OPTS_IMPORT="${JAVA_OPTS_IMPORT:-$JAVA_OPTS}"

mkdir -p "$DATA_DIR"

if [ ! -d "$DATA_DIR/graph-cache" ]; then
  if [ ! -f "$PBF" ]; then
    echo ">> No OSM extract at $PBF - downloading $PBF_URL"
    curl -fL -o "$PBF.part" "$PBF_URL"
    mv "$PBF.part" "$PBF"
  fi
  echo ">> No graph in $DATA_DIR/graph-cache - importing $PBF"
  java $JAVA_OPTS_IMPORT -Ddw.graphhopper.datareader.file="$PBF" \
    -jar /graphhopper/graphhopper.jar import /graphhopper/config.yml
  echo ">> Import finished"
fi

exec java $JAVA_OPTS -Ddw.graphhopper.datareader.file="$PBF" \
  -jar /graphhopper/graphhopper.jar server /graphhopper/config.yml
