#!/usr/bin/env bash
# Fetches the self-hosted map style + its assets (glyphs, sprites) from
# OpenFreeMap (https://openfreemap.org, CC0/ODbL) into the Atlas data dir,
# rewiring every external URL to same-origin placeholders:
#
#   assets/styles/liberty.json   style with {origin} placeholders; the web app
#                                substitutes window.location.origin at load time
#   assets/fonts/<stack>/*.pbf   glyph ranges for the font stacks the style uses
#   assets/sprites/ofm*          sprite sheet (json/png, 1x + 2x)
#
# The style's vector source is pointed at the PMTiles archive built by
# build-basemap.sh; its low-zoom natural-earth raster source is dropped
# (planet-wide raster tiles are not worth self-hosting for a regional map).
#
# Usage: ./fetch-map-assets.sh [area]     # default area: norway
set -euo pipefail

AREA="${1:-norway}"
DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
ASSETS_DIR="$DATA_DIR/assets"
OFM=https://tiles.openfreemap.org
OFM_ASSETS=https://assets.openfreemap.com

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
mkdir -p "$ASSETS_DIR/styles" "$ASSETS_DIR/fonts" "$ASSETS_DIR/sprites"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo ">> Style: liberty"
curl -fsSL "$OFM/styles/liberty" -o "$tmp/liberty.json"

jq --arg tiles "pmtiles://{origin}/tiles/$AREA.pmtiles" '
  del(.sources.ne2_shaded)
  | .layers |= map(select(.source != "ne2_shaded"))
  | .sources.openmaptiles = {
      type: "vector",
      url: $tiles,
      attribution: "<a href=\"https://openmaptiles.org/\" target=\"_blank\">&copy; OpenMapTiles</a> <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\">&copy; OpenStreetMap contributors</a>"
    }
  | .glyphs = "{origin}/assets/fonts/{fontstack}/{range}.pbf"
  | .sprite = "{origin}/assets/sprites/ofm"
  | .name = "Atlas Liberty"
' "$tmp/liberty.json" > "$ASSETS_DIR/styles/liberty.json"

echo ">> Sprites"
curl -fsSL "$OFM_ASSETS/sprites/ofm_f384.tar.gz" | tar -xz -C "$tmp"
# Tarball layout may nest; take the four ofm* files wherever they landed.
find "$tmp" -name 'ofm*' \( -name '*.json' -o -name '*.png' \) -exec cp {} "$ASSETS_DIR/sprites/" \;

echo ">> Fonts (glyph ranges for the stacks the style uses)"
curl -fsSL "$OFM_ASSETS/fonts/ofm.tar.gz" -o "$tmp/fonts.tar.gz"
mkdir -p "$tmp/fonts"
tar -xzf "$tmp/fonts.tar.gz" -C "$tmp/fonts"
jq -r '[.layers[].layout."text-font" // empty] | flatten | unique | .[]' \
  "$ASSETS_DIR/styles/liberty.json" | while IFS= read -r stack; do
  src=$(find "$tmp/fonts" -type d -name "$stack" | head -1)
  if [ -z "$src" ]; then
    echo "!! font stack not in bundle: $stack" >&2
    exit 1
  fi
  rm -rf "$ASSETS_DIR/fonts/$stack"
  cp -r "$src" "$ASSETS_DIR/fonts/$stack"
  echo "   $stack ($(ls "$ASSETS_DIR/fonts/$stack" | wc -l) ranges)"
done

echo ">> Done: $ASSETS_DIR"
