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
# Usage:
#   ./build-outdoor.sh
#
# Output: $DATA_DIR/tiles/outdoor.pmtiles (atomic rename after a successful build)
set -euo pipefail

DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
CACHE_DIR="$DATA_DIR/planetiler"
TILES_DIR="$DATA_DIR/tiles"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Pinned by digest in infrastructure/tools.json (ROADMAP §7.5 DR7), the same
# tiler that cuts the basemap beside it.
PLANETILER_IMAGE="$(jq -er '.planetiler.image' \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools.json")"

mkdir -p "$CACHE_DIR/sources" "$TILES_DIR"

echo ">> Building outdoor.pmtiles (cache: $CACHE_DIR)"
docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e JAVA_TOOL_OPTIONS="-Xmx3g" \
  -v "$CACHE_DIR":/data \
  -v "$SCRIPT_DIR":/schema:ro \
  "$PLANETILER_IMAGE" \
  generate-custom \
  --schema=/schema/outdoor-schema.yml \
  --download \
  --download-dir=/data/sources \
  --tmpdir=/data/tmp \
  --output=/data/outdoor.pmtiles \
  --force

# Atomic-ish publish: rename within the same filesystem so the backend never
# sees a half-written file (the same reason build-basemap.sh does it).
mv -f "$CACHE_DIR/outdoor.pmtiles" "$TILES_DIR/outdoor.pmtiles"
echo ">> Done: $TILES_DIR/outdoor.pmtiles ($(du -h "$TILES_DIR/outdoor.pmtiles" | cut -f1))"
echo ">> Inspect with: node $SCRIPT_DIR/inspect-tiles.mjs $TILES_DIR/outdoor.pmtiles --bbox 10.6 59.8 11.2 60.1 12"
