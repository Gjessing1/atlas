#!/usr/bin/env bash
# First start: build the Valhalla tileset (timezones + routing tiles + a
# single-file tile extract) from the OSM extracts in $VALHALLA_PBF_URLS,
# downloading any that are missing. Subsequent starts skip straight to serving.
# To refresh OSM data (or after changing the extract list), delete the .pbf
# files to refresh / add the new ones, delete /data/tiles.tar and restart
# (intended as an overnight job — the tile build takes a while on modest
# hardware; it is disk-backed and runs within the compose memory cap).
#
# Cross-border routing: the graph only covers what the extracts cover, so the
# default is Norway + neighbouring Sweden (Oslo→Stockholm works). Add more
# Geofabrik URLs to VALHALLA_PBF_URLS (space-separated) to widen coverage —
# every listed extract is passed to one combined tile build.
#
# No elevation (skadi) tiles for now: ascent/descent and point elevation are
# consciously dropped in the GraphHopper -> Valhalla switch (see ROADMAP).
set -euo pipefail

PBF_URLS="${VALHALLA_PBF_URLS:-https://download.geofabrik.de/europe/norway-latest.osm.pbf https://download.geofabrik.de/europe/sweden-latest.osm.pbf}"
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
  --mjolnir-data-processing-use-admin-db false \
  --mjolnir-concurrency "$CONCURRENCY" \
  > "$CONFIG"

if [ ! -f "$DATA_DIR/tiles.tar" ]; then
  PBFS=()
  for url in $PBF_URLS; do
    pbf="$DATA_DIR/$(basename "$url")"
    if [ ! -f "$pbf" ]; then
      # The Norway-only era stored the extract as norway.osm.pbf — reuse it
      # rather than re-downloading ~1.5 GB.
      if [ "$(basename "$url")" = "norway-latest.osm.pbf" ] && [ -f "$DATA_DIR/norway.osm.pbf" ]; then
        ln "$DATA_DIR/norway.osm.pbf" "$pbf"
      else
        echo ">> No OSM extract at $pbf - downloading $url"
        curl -fL -o "$pbf.part" "$url"
        mv "$pbf.part" "$pbf"
      fi
    fi
    PBFS+=("$pbf")
  done
  echo ">> No tile extract at $DATA_DIR/tiles.tar - building tiles from: ${PBFS[*]}"
  valhalla_build_timezones > "$DATA_DIR/timezones.sqlite"
  # A regional Geofabrik extract clips the country-boundary relation. Building
  # admins from it produced county rows with no country parents, so Valhalla
  # assigned the dummy left-driving admin to every Norwegian and Swedish road.
  # Both covered countries drive on the right: leave the incomplete admin DB
  # disabled and retain Valhalla's per-way right-driving default. This matters
  # to roundabout exit counting, which inspects only the driving-side branch.
  # If coverage gains a left-driving country, supply a complete country-level
  # admin dataset before enabling the admin DB again.
  valhalla_build_tiles -c "$CONFIG" "${PBFS[@]}"
  # Single-file tar of all tiles: faster startup (one mmap) and the marker
  # that the build finished — a crashed build leaves no tiles.tar and reruns.
  valhalla_build_extract -c "$CONFIG" -v --overwrite
  echo ">> Tile build finished"
fi

exec valhalla_service "$CONFIG" "$CONCURRENCY"
