#!/usr/bin/env bash
# First start: build the Valhalla tileset (timezones + routing tiles + a
# single-file tile extract) from the OSM extracts in $VALHALLA_PBF_URLS,
# using the admin database built separately by build-admins.sh,
# downloading any that are missing. Subsequent starts skip straight to serving.
# To refresh OSM data (or after changing the extract list), delete the .pbf
# files to refresh / add the new ones, delete /data/tiles.tar and restart
# (intended as an overnight job — the tile build takes a while on modest
# hardware; it is disk-backed and runs within the compose memory cap).
#
# Cross-border routing: the graph only covers what the extracts cover. Add more
# Geofabrik URLs to VALHALLA_PBF_URLS (space-separated) to widen coverage —
# every listed extract is passed to one combined tile build. A new left-driving
# country also needs its ISO row in the admin DB's verification list; the build
# below refuses to graph one without it.
#
# No elevation (skadi) tiles for now: ascent/descent and point elevation are
# consciously dropped in the GraphHopper -> Valhalla switch (see ROADMAP).
set -euo pipefail

# Coverage is a committed list of Geofabrik areas (coverage.list, copied into
# the image beside this script) rather than a URL list written out here, so the
# out-of-band host rebuild in build-tiles.sh graphs exactly what the service
# would build for itself. Widen coverage by editing that file — and note that a
# new left-driving country also needs its ISO row in the admin DB's
# verification list; the build below refuses to graph one without it.
GEOFABRIK=https://download.geofabrik.de/europe
COVERAGE_LIST="${VALHALLA_COVERAGE_LIST:-/coverage.list}"
if [ -n "${VALHALLA_PBF_URLS:-}" ]; then
  PBF_URLS="$VALHALLA_PBF_URLS"
else
  [ -f "$COVERAGE_LIST" ] || {
    echo "ERROR: no coverage list at $COVERAGE_LIST — the image copies it in from" >&2
    echo "infrastructure/valhalla/coverage.list. Set VALHALLA_PBF_URLS to override." >&2
    exit 1
  }
  PBF_URLS="$(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$COVERAGE_LIST" \
    | while read -r area; do printf '%s/%s-latest.osm.pbf ' "$GEOFABRIK" "$area"; done)"
fi

DATA_DIR=/data
CONFIG="$DATA_DIR/valhalla.json"
CONCURRENCY="${VALHALLA_CONCURRENCY:-2}"

mkdir -p "$DATA_DIR"

# Which side of the road each country drives on comes from the admin database,
# and roundabout exit counting depends on it: Valhalla counts the arms on the
# driving side, so a left-driving country graphed as right-driving numbers the
# exits off the far side of the road. Measured on the Isle of Man, two of three
# roundabouts on one short route came out wrong, one of them "1st exit" for
# what is really the 3rd.
#
# The DB is built separately by build-admins.sh, from a continent-wide source.
# It is emphatically NOT built from the extracts below: those clip the country
# boundary relation, and a country whose ring never closes gets no polygon, so
# its roads inherit Valhalla's default admin — which drives on the left. That
# is how this went wrong in the other direction before (384d847).
if [ -f "$DATA_DIR/admins.sqlite" ]; then
  ADMIN_ARGS=(--mjolnir-admin "$DATA_DIR/admins.sqlite")
else
  # No DB: keep Valhalla's per-way right-driving default, which is correct for
  # every country Atlas covered before the UK, and refuse below to graph one
  # where it isn't.
  ADMIN_ARGS=(--mjolnir-data-processing-use-admin-db false)
fi

# The config is regenerated every start so image upgrades pick up new defaults;
# everything mutable lives under /data.
valhalla_build_config \
  --mjolnir-tile-dir "$DATA_DIR/tiles" \
  --mjolnir-tile-extract "$DATA_DIR/tiles.tar" \
  --mjolnir-timezone "$DATA_DIR/timezones.sqlite" \
  "${ADMIN_ARGS[@]}" \
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
  # Refuse to graph a left-driving country with no admin DB to prove it. This
  # is the wrong-by-default state the whole change exists to prevent: routing
  # would come up looking healthy and quietly misnumber every UK roundabout.
  if [ ! -f "$DATA_DIR/admins.sqlite" ]; then
    for pbf in "${PBFS[@]}"; do
      case "$(basename "$pbf")" in
        great-britain* | ireland* | isle-of-man* | guernsey-jersey* | malta* | cyprus*)
          echo "ERROR: $(basename "$pbf") drives on the left, but $DATA_DIR/admins.sqlite" >&2
          echo "is missing, so every road would be graphed as right-driving and its" >&2
          echo "roundabout exits counted off the wrong side. Run:" >&2
          echo "  infrastructure/valhalla/build-admins.sh" >&2
          exit 1
          ;;
      esac
    done
  fi
  echo ">> No tile extract at $DATA_DIR/tiles.tar - building tiles from: ${PBFS[*]}"
  valhalla_build_timezones > "$DATA_DIR/timezones.sqlite"
  # Merge first when there is more than one extract. Valhalla warns that
  # building from several .osm.pbf at once is discouraged (valhalla#3925), and
  # with this coverage it does not merely warn: neighbouring Geofabrik extracts
  # overlap at every border, and ten of them aborted the build with a core dump
  # while writing tiles on the German/French border. The same area built
  # cleanly from one merged file, so the overlap is the fault, not the data.
  SOURCE="$DATA_DIR/graph-source.osm.pbf"
  if [ "${#PBFS[@]}" -gt 1 ]; then
    echo ">> Merging ${#PBFS[@]} extracts into $(basename "$SOURCE")"
    osmium merge "${PBFS[@]}" -o "$SOURCE" --overwrite
  else
    SOURCE="${PBFS[0]}"
  fi
  valhalla_build_tiles -c "$CONFIG" "$SOURCE"
  # Single-file tar of all tiles: faster startup (one mmap) and the marker
  # that the build finished — a crashed build leaves no tiles.tar and reruns.
  valhalla_build_extract -c "$CONFIG" -v --overwrite
  echo ">> Tile build finished"
fi

exec valhalla_service "$CONFIG" "$CONCURRENCY"
