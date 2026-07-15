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
# Usage:
#   ./build-basemap.sh [area]        # default area: norway
#
# Output: $DATA_DIR/tiles/<area>.pmtiles (atomic rename after a successful build)
set -euo pipefail

AREA="${1:-norway}"
DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
CACHE_DIR="$DATA_DIR/planetiler"
TILES_DIR="$DATA_DIR/tiles"
PLANETILER_IMAGE="ghcr.io/onthegomap/planetiler:latest"

mkdir -p "$CACHE_DIR" "$TILES_DIR"

echo ">> Building $AREA.pmtiles (cache: $CACHE_DIR)"
docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e JAVA_TOOL_OPTIONS="-Xmx3g" \
  -v "$CACHE_DIR":/data \
  "$PLANETILER_IMAGE" \
  --download --area="$AREA" \
  --output="/data/$AREA.pmtiles" \
  --force

# Atomic-ish publish: rename within the same filesystem so the backend never
# sees a half-written file.
mv -f "$CACHE_DIR/$AREA.pmtiles" "$TILES_DIR/$AREA.pmtiles"
echo ">> Done: $TILES_DIR/$AREA.pmtiles ($(du -h "$TILES_DIR/$AREA.pmtiles" | cut -f1))"
