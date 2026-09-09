#!/usr/bin/env bash
# Builds the outdoor overlay archive: OSM extract -> Planetiler (custom schema)
# -> PMTiles.
#
# A second, small vector source beside the basemap, carrying the outdoor classes
# the stock OpenMapTiles schema either drops entirely (wilderness_hut, slipway,
# boatyard) or only emits from z14 (gates, cabins, viewpoints). See
# outdoor-schema.yml for why this is a separate archive rather than a fork of
# the OpenMapTiles profile.
#
# Shares the Planetiler cache — and therefore the downloaded norway.osm.pbf —
# with build-basemap.sh, so run it after that (or on the same overnight
# schedule) and it costs a few minutes rather than another 1.4 GB download.
#
# Sharing the cache is also why the two hold the same lock: two Planetiler runs
# at once do not fit in 15 GB of RAM with swap at zero. Queue this one behind a
# running basemap build rather than racing it —
# PLANETILER_LOCK_WAIT seconds turns the refusal into a wait.
#
# No --polygon here, unlike the basemap: this archive is served local-only and
# is never a stand-in for the world upstream (see backend/src/tiles-api.ts), so
# a tile it lacks renders as nothing rather than as a grey hole.
#
# Usage:
#   ./build-outdoor.sh
#   PLANETILER_LOCK_WAIT=36000 ./build-outdoor.sh   # start when the basemap ends
#
# Env: PLANETILER_CPUS (default 2), PLANETILER_MEMORY (6g), PLANETILER_XMX (3g),
#      PLANETILER_THREADS (defaults to PLANETILER_CPUS), PLANETILER_LOCK_WAIT (0).
#
# Output: $DATA_DIR/tiles/outdoor.pmtiles (atomic rename after a successful build)
set -euo pipefail

DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
CACHE_DIR="$DATA_DIR/planetiler"
TILES_DIR="$DATA_DIR/tiles"
LOG_DIR="$CACHE_DIR/logs"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CPUS="${PLANETILER_CPUS:-2}"
MEM="${PLANETILER_MEMORY:-6g}"
XMX="${PLANETILER_XMX:-3g}"
# Planetiler picks threads from the host CPU count, not the cgroup limit.
THREADS="${PLANETILER_THREADS:-$CPUS}"
LOCK_WAIT="${PLANETILER_LOCK_WAIT:-0}"
# Pinned by digest in infrastructure/tools.json (ROADMAP §7.5 DR7), the same
# tiler that cuts the basemap beside it.
PLANETILER_IMAGE="$(jq -er '.planetiler.image' \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools.json")"

mkdir -p "$CACHE_DIR/sources" "$TILES_DIR" "$LOG_DIR"

LOG="$LOG_DIR/outdoor-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
echo ">> Logging to $LOG"

exec 9>"$CACHE_DIR/.build.lock"
if ! flock -w "$LOCK_WAIT" 9; then
  echo "!! another Planetiler build holds $CACHE_DIR/.build.lock — refusing to start" >&2
  echo "!! (set PLANETILER_LOCK_WAIT=<seconds> to queue behind it instead)" >&2
  exit 1
fi

avail_mb="$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)"
need_mb="$(( $(numfmt --from=iec "${MEM^^}") / 1048576 + 512 ))"
if [ "$avail_mb" -lt "$need_mb" ]; then
  echo "!! only ${avail_mb} MB available, need ~${need_mb} MB for --memory $MEM" >&2
  exit 1
fi

echo ">> Building outdoor.pmtiles (cache: $CACHE_DIR, cpus: $CPUS, mem: $MEM)"
docker run --rm \
  --memory "$MEM" --memory-swap "$MEM" --cpus "$CPUS" \
  -u "$(id -u):$(id -g)" \
  -e JAVA_TOOL_OPTIONS="-Xmx$XMX" \
  -v "$CACHE_DIR":/data \
  -v "$SCRIPT_DIR":/schema:ro \
  "$PLANETILER_IMAGE" \
  generate-custom \
  --schema=/schema/outdoor-schema.yml \
  --download \
  --download-dir=/data/sources \
  --tmpdir=/data/tmp \
  --threads="$THREADS" \
  --output=/data/outdoor.pmtiles \
  --force

# Atomic-ish publish: rename within the same filesystem so the backend never
# sees a half-written file (the same reason build-basemap.sh does it).
mv -f "$CACHE_DIR/outdoor.pmtiles" "$TILES_DIR/outdoor.pmtiles"
echo ">> Done: $TILES_DIR/outdoor.pmtiles ($(du -h "$TILES_DIR/outdoor.pmtiles" | cut -f1))"
echo ">> Inspect with: node $SCRIPT_DIR/inspect-tiles.mjs $TILES_DIR/outdoor.pmtiles --bbox 10.6 59.8 11.2 60.1 12"
