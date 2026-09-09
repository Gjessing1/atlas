#!/usr/bin/env bash
# Builds the self-hosted basemap: OSM extract -> Planetiler -> PMTiles.
#
# Runs Planetiler in Docker (no Java needed on the host). Downloads the OSM
# extract (Geofabrik) plus supporting datasets (Natural Earth, water polygons)
# into a cache dir on first run, then generates a single .pmtiles file that the
# backend serves via HTTP range requests (see backend tile routes).
#
# Intended to run as a scheduled batch job (e.g. weekly, overnight) — never in
# response to a user request (see docs/ARCHITECTURE.md, Hardware Budget).
#
# **The output is clipped to the area's Geofabrik polygon** (`--polygon`), and
# the same .poly is published next to the archive for the tile route to read.
# Without the clip Planetiler emits tiles across the whole *bounding box* of the
# extract, and fills them from its global sources (the water-polygons shapefile,
# Natural Earth). Norway's box is -11.4,57.6 -> 35.5,81.1, so norway.pmtiles
# carried water-only tiles over Stockholm, Helsinki and the Baltic. Those tiles
# are not empty, so the tile route counted them as coverage and served them
# instead of proxying the world upstream: a grey map wherever the box overhangs
# the region. A missing polygon is a hard failure here — building unclipped is
# the bug, not a fallback.
#
# Usage:
#   ./build-basemap.sh [area]              # default area: norway
#   PLANETILER_CPUS=1 ./build-basemap.sh   # leave the rest of the box usable
#
# Env: PLANETILER_CPUS (default 2), PLANETILER_MEMORY (6g), PLANETILER_XMX (3g),
#      PLANETILER_THREADS (defaults to PLANETILER_CPUS).
#
# Output: $DATA_DIR/tiles/<area>.pmtiles (atomic rename after a successful build)
#     and $DATA_DIR/tiles/<area>.poly (coverage, read by the tile route)
set -euo pipefail

AREA="${1:-norway}"
DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
CACHE_DIR="$DATA_DIR/planetiler"
TILES_DIR="$DATA_DIR/tiles"
LOG_DIR="$CACHE_DIR/logs"

# Every other Atlas build script caps its container (see build-tiles.sh,
# build-index.sh); this one used to run uncapped at Planetiler's default of four
# threads, which is the whole box. Host RAM is 15 GB with swap routinely at
# zero, so --memory-swap == --memory: the container must never reach for swap
# that is not there.
CPUS="${PLANETILER_CPUS:-2}"
MEM="${PLANETILER_MEMORY:-6g}"
XMX="${PLANETILER_XMX:-3g}"
# Planetiler picks threads from the host CPU count, not the cgroup limit, so a
# --cpus 1 run would still start four workers to share one core: more heap
# churn and context switching for no throughput. Keep them equal.
THREADS="${PLANETILER_THREADS:-$CPUS}"

# Pinned by digest in infrastructure/tools.json (ROADMAP §7.5 DR7): this
# archive becomes a pack input, recorded there by size, mtime and digest, and a
# tag that moved would make "which tiler cut this" unanswerable.
PLANETILER_IMAGE="$(jq -er '.planetiler.image' \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools.json")"

mkdir -p "$CACHE_DIR" "$TILES_DIR" "$LOG_DIR"

LOG="$LOG_DIR/$AREA-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
echo ">> Logging to $LOG"

# The basemap and outdoor builds share this cache (and its downloaded
# norway.osm.pbf), and two Planetiler runs at once would not fit in RAM.
exec 9>"$CACHE_DIR/.build.lock"
if ! flock -n 9; then
  echo "!! another Planetiler build holds $CACHE_DIR/.build.lock — refusing to start" >&2
  exit 1
fi

# Preflight rather than discover it at hour three: a container that cannot get
# its cap is an OOM kill mid-build, and the atomic publish means a killed build
# leaves the live archive untouched but wastes the whole run.
avail_mb="$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)"
need_mb="$(( $(numfmt --from=iec "${MEM^^}") / 1048576 + 512 ))"
if [ "$avail_mb" -lt "$need_mb" ]; then
  echo "!! only ${avail_mb} MB available, need ~${need_mb} MB for --memory $MEM" >&2
  echo "!! wait for the other build to finish, or lower PLANETILER_MEMORY" >&2
  exit 1
fi

# Geofabrik publishes the clipping polygon beside every extract, so derive it
# from the same index Planetiler resolves --area against rather than hardcoding
# a continent path.
POLY="$CACHE_DIR/$AREA.poly"
if [ ! -s "$POLY" ]; then
  echo ">> Fetching clipping polygon for $AREA"
  PBF_URL="$(curl -fsSL --retry 3 https://download.geofabrik.de/index-v1.json \
    | jq -er --arg a "$AREA" '[.features[] | select(.properties.id == $a) | .properties.urls.pbf][0]')"
  curl -fsSL --retry 3 -o "$POLY.tmp" "${PBF_URL%-latest.osm.pbf}.poly"
  mv -f "$POLY.tmp" "$POLY"
fi

echo ">> Building $AREA.pmtiles (cache: $CACHE_DIR, cpus: $CPUS, mem: $MEM)"
docker run --rm \
  --memory "$MEM" --memory-swap "$MEM" --cpus "$CPUS" \
  -u "$(id -u):$(id -g)" \
  -e JAVA_TOOL_OPTIONS="-Xmx$XMX" \
  -v "$CACHE_DIR":/data \
  "$PLANETILER_IMAGE" \
  --download --area="$AREA" \
  --polygon="/data/$AREA.poly" \
  --threads="$THREADS" \
  --output="/data/$AREA.pmtiles" \
  --force

# Atomic-ish publish: rename within the same filesystem so the backend never
# sees a half-written file. The polygon goes with it — the tile route reads
# <area>.poly to decide whether this archive covers a tile at all.
mv -f "$CACHE_DIR/$AREA.pmtiles" "$TILES_DIR/$AREA.pmtiles"
cp -f "$POLY" "$TILES_DIR/$AREA.poly"
echo ">> Done: $TILES_DIR/$AREA.pmtiles ($(du -h "$TILES_DIR/$AREA.pmtiles" | cut -f1))"
