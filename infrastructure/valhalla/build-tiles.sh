#!/usr/bin/env bash
# Rebuild the routing graph OUT OF BAND, so the live service keeps answering
# from the old tiles for the hours this takes and only the final swap is
# downtime. The container entrypoint can build tiles too, but only by starting
# with none — which means routing is down for the whole build.
#
#   ./build-tiles.sh                 # merge coverage.list, build, print the swap
#   TILE_BUILD_MEM=9g TILE_BUILD_CONCURRENCY=2 ./build-tiles.sh
#
# Coverage comes from coverage.list beside this script — the same file the
# image copies to /coverage.list — so this and the service graph the same
# countries. Missing extracts are downloaded next to the ones the service
# already has, which is where the entrypoint looks for them too.
#
# Two long steps, each resumable by leaving its output in place:
#   merge   ~15 min   the extracts -> one graph-source.osm.pbf
#   build   ~4-6 h    tiles + tiles.tar
#
# Why merge at all: Valhalla warns that building from several .osm.pbf at once
# is discouraged (valhalla#3925), and at this coverage it is not merely untidy.
# Neighbouring Geofabrik extracts overlap at every border, and ten of them
# aborted the build outright — "Failed tile 2/794190/0: vector::_M_range_check"
# on the German/French border, then a core dump, an hour in. The same area
# built cleanly from one merged file with the same admin DB.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
DATA="$DATA_DIR/valhalla"
WORK="${ATLAS_TILE_WORK:-$DATA_DIR/valhalla-build}"
SOURCE="$WORK/graph-source.osm.pbf"
GEOFABRIK=https://download.geofabrik.de/europe
MEM="${TILE_BUILD_MEM:-9g}"
CONC="${TILE_BUILD_CONCURRENCY:-2}"
VALHALLA_IMAGE="ghcr.io/valhalla/valhalla:3.8.2"

# The admin DB decides which side of the road each country drives on, and so
# which arm of a roundabout is "the 2nd exit". Coverage includes left-driving
# countries, and without the DB every one of them would be graphed as
# right-driving — healthy-looking and wrong. Same refusal as the entrypoint's.
[[ -f "$DATA/admins.sqlite" ]] || {
  echo "no $DATA/admins.sqlite — run build-admins.sh first" >&2
  exit 1
}

mapfile -t AREAS < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$SCRIPT_DIR/coverage.list")
((${#AREAS[@]})) || {
  echo "coverage.list lists no areas" >&2
  exit 1
}

mkdir -p "$WORK"

PBFS=()
for area in "${AREAS[@]}"; do
  pbf="$DATA/$area-latest.osm.pbf"
  if [[ ! -f "$pbf" ]]; then
    echo "==> downloading $area"
    curl -fL --retry 3 -o "$pbf.part" "$GEOFABRIK/$area-latest.osm.pbf"
    mv "$pbf.part" "$pbf"
  fi
  PBFS+=("/in/$area-latest.osm.pbf")
done

# osmium-tool ships in the Atlas Valhalla image (infrastructure/valhalla), but
# that image is built by the compose file next door and may not exist on a host
# that only ever pulled the upstream one. Build the same one-liner wrapper
# build-admins.sh uses rather than depending on the compose build having run.
if ! docker image inspect atlas-osmium >/dev/null 2>&1; then
  echo "==> preparing osmium"
  docker build -q -t atlas-osmium - <<'DOCKERFILE' >/dev/null
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool \
  && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

# Reuse a merged source that is newer than every extract it came from; a build
# that crashed after the merge should not pay for it twice. A refreshed extract
# is newer than the merge, and redoes it.
NEWEST_PBF="$(ls -t "$DATA"/*-latest.osm.pbf | head -1)"
if [[ -f "$SOURCE" && "$SOURCE" -nt "$NEWEST_PBF" ]]; then
  echo "==> reusing $(basename "$SOURCE") ($(du -h "$SOURCE" | cut -f1))"
else
  echo "==> merging ${#PBFS[@]} extracts into $(basename "$SOURCE")"
  date
  docker run --rm --memory 6g --memory-swap 6g --cpus 2 \
    -v "$DATA:/in:ro" -v "$WORK:/work" atlas-osmium \
    osmium merge "${PBFS[@]}" -o "/work/$(basename "$SOURCE")" --overwrite
  ls -lh "$SOURCE" | awk '{print "    merged: " $5}'
fi

echo "==> building tiles (mem=$MEM concurrency=$CONC)"
date
docker run --rm --memory "$MEM" --memory-swap "$MEM" --cpus 3 \
  -v "$DATA:/data:ro" -v "$WORK:/work" \
  --entrypoint bash "$VALHALLA_IMAGE" -c "
    set -euo pipefail
    # Nothing incremental survives a partial build: leftover tiles from a
    # crashed run are mixed-vintage and would be tarred up as if they were a
    # graph. Cleared in here rather than on the host because the previous build
    # wrote them as root through this same mount.
    rm -rf /work/tiles /work/tiles.tar
    valhalla_build_config \
      --mjolnir-tile-dir /work/tiles \
      --mjolnir-tile-extract /work/tiles.tar \
      --mjolnir-timezone /data/timezones.sqlite \
      --mjolnir-admin /data/admins.sqlite \
      --mjolnir-concurrency $CONC > /work/valhalla.json
    valhalla_build_tiles -c /work/valhalla.json /work/$(basename "$SOURCE")
    valhalla_build_extract -c /work/valhalla.json -v --overwrite"
date

echo "==> built $(du -sh "$WORK/tiles.tar" | cut -f1) — swap it in with:"
echo "    docker stop atlas-valhalla"
echo "    mv $DATA/tiles $DATA/tiles.old && mv $WORK/tiles $DATA/tiles"
echo "    mv $DATA/tiles.tar $DATA/tiles.tar.old && mv $WORK/tiles.tar $DATA/tiles.tar"
echo "    docker start atlas-valhalla"
echo "    # then, once routes look right: rm -rf $DATA/tiles.old $DATA/tiles.tar.old"
