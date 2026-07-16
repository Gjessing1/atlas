#!/usr/bin/env bash
# First start: build the Valhalla tileset (admins + timezones + routing tiles
# + a single-file tile extract) from the OSM extract at $VALHALLA_PBF,
# downloading it first if missing. Subsequent starts skip straight to serving.
# To refresh OSM data, replace the .pbf, delete /data/tiles.tar and restart
# (intended as an overnight job — the tile build takes a while for Norway on
# modest hardware; it is disk-backed and runs within the compose memory cap).
#
# No elevation (skadi) tiles for now: ascent/descent and point elevation are
# consciously dropped in the GraphHopper -> Valhalla switch (see ROADMAP).
set -euo pipefail

PBF="${VALHALLA_PBF:-/data/norway.osm.pbf}"
PBF_URL="${VALHALLA_PBF_URL:-https://download.geofabrik.de/europe/norway-latest.osm.pbf}"
DATA_DIR=/data
CONFIG="$DATA_DIR/valhalla.json"
CONCURRENCY="${VALHALLA_CONCURRENCY:-2}"

mkdir -p "$DATA_DIR"

# The config is regenerated every start so image upgrades pick up new defaults;
# everything mutable lives under /data.
valhalla_build_config \
  --mjolnir-tile-dir "$DATA_DIR/tiles" \
  --mjolnir-tile-extract "$DATA_DIR/tiles.tar" \
  --mjolnir-timezone "$DATA_DIR/timezones.sqlite" \
  --mjolnir-admin "$DATA_DIR/admins.sqlite" \
  --mjolnir-concurrency "$CONCURRENCY" \
  > "$CONFIG"

if [ ! -f "$DATA_DIR/tiles.tar" ]; then
  if [ ! -f "$PBF" ]; then
    echo ">> No OSM extract at $PBF - downloading $PBF_URL"
    curl -fL -o "$PBF.part" "$PBF_URL"
    mv "$PBF.part" "$PBF"
  fi
  echo ">> No tile extract at $DATA_DIR/tiles.tar - building tiles from $PBF"
  valhalla_build_timezones > "$DATA_DIR/timezones.sqlite"
  # Admin areas drive country-specific routing rules (driving side, roundabout
  # phrasing); built from the same extract as the tiles.
  valhalla_build_admins -c "$CONFIG" "$PBF"
  valhalla_build_tiles -c "$CONFIG" "$PBF"
  # Single-file tar of all tiles: faster startup (one mmap) and the marker
  # that the build finished — a crashed build leaves no tiles.tar and reruns.
  valhalla_build_extract -c "$CONFIG" -v --overwrite
  echo ">> Tile build finished"
fi

exec valhalla_service "$CONFIG" "$CONCURRENCY"
