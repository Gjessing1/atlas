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

# Coverage: Norway + Sweden (home), the land corridor down to the North Sea
# ferries (Denmark, Germany, Netherlands, Belgium), and the British Isles —
# Great Britain, Ireland + Northern Ireland, and the Crown Dependencies, whose
# extracts are a few MB each and complete "the whole UK".
#
# Every left-driving country in Europe is in that last group; Malta and Cyprus
# are the only others on the continent and are left out only because no road
# reaches them from here. The admin DB covers them anyway, so adding them later
# is a one-line change with the driving side already correct.
GEOFABRIK=https://download.geofabrik.de/europe
PBF_URLS="${VALHALLA_PBF_URLS:-\
$GEOFABRIK/norway-latest.osm.pbf \
$GEOFABRIK/sweden-latest.osm.pbf \
$GEOFABRIK/denmark-latest.osm.pbf \
$GEOFABRIK/germany-latest.osm.pbf \
$GEOFABRIK/netherlands-latest.osm.pbf \
$GEOFABRIK/belgium-latest.osm.pbf \
$GEOFABRIK/great-britain-latest.osm.pbf \
$GEOFABRIK/ireland-and-northern-ireland-latest.osm.pbf \
$GEOFABRIK/isle-of-man-latest.osm.pbf \
$GEOFABRIK/guernsey-jersey-latest.osm.pbf}"
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
  valhalla_build_tiles -c "$CONFIG" "${PBFS[@]}"
  # Single-file tar of all tiles: faster startup (one mmap) and the marker
  # that the build finished — a crashed build leaves no tiles.tar and reruns.
  valhalla_build_extract -c "$CONFIG" -v --overwrite
  echo ">> Tile build finished"
fi

exec valhalla_service "$CONFIG" "$CONCURRENCY"
