#!/usr/bin/env bash
# Build an offline region pack for the Android app (Phase 6).
#
#   ./build-pack.sh <id> "<Name>" <minLng,minLat,maxLng,maxLat> [--graph-dir <dir>]
#   ./build-pack.sh oslo "Oslo" 10.4,59.7,11.0,60.1
#
# Produces <DATA_DIR>/packs/<id>/ containing:
#   basemap.pmtiles   extracted from the master basemap (tiles/norway.pmtiles)
#   search.sqlite     FTS5 index of named OSM features (build-search-db.mjs)
#   graph.zip         GraphHopper graph-cache for the region (offline routing)
#   assets.zip        map glyphs + sprites (offline labels/icons)
#   pack.json         manifest served by /api/regions
#
# Sources: the master .pmtiles and the Norway .osm.pbf under DATA_DIR (see
# CLAUDE.md data dir layout). Building the routing graph runs the same
# GraphHopper image the server uses (infrastructure/graphhopper) in import
# mode; pass --graph-dir to reuse an existing graph-cache instead.
set -euo pipefail

# This host runs ~30 other containers in 15 GiB of RAM. Every docker step gets
# a hard memory cap (memory-swap == memory, so no host swap pressure) and a CPU
# cap; worst case the build container is OOM-killed (exit 137), never the host.
# The steps whose memory would grow with region size run disk-backed (osmium
# file index, GraphHopper MMAP_STORE), so bigger regions cost time, not RAM.
LIMITS=(--memory 4g --memory-swap 4g --cpus 2)

# Refuse to start if the host doesn't have headroom for the capped builds
# (e.g. the Android emulator container is running — stop it first).
AVAIL_KB=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
if ((AVAIL_KB < 6 * 1024 * 1024)); then
  echo "refusing to build: <6 GiB available on host ($((AVAIL_KB / 1024)) MiB)." >&2
  echo "free up memory first (e.g. docker stop atlas-emulator) and retry." >&2
  exit 1
fi

DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
MASTER_PMTILES="$DATA_DIR/tiles/norway.pmtiles"
MASTER_PBF="$DATA_DIR/graphhopper/norway.osm.pbf"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ID="${1:?region id, e.g. oslo}"
NAME="${2:?region name, e.g. Oslo}"
BBOX="${3:?bbox as minLng,minLat,maxLng,maxLat}"
GRAPH_DIR=""
if [[ "${4:-}" == "--graph-dir" ]]; then
  GRAPH_DIR="${5:?--graph-dir needs a path}"
fi

OUT="$DATA_DIR/packs/$ID"
WORK="$DATA_DIR/packs-build/$ID"
mkdir -p "$OUT" "$WORK"

echo "==> [$ID] extracting basemap from $(basename "$MASTER_PMTILES")"
docker run --rm "${LIMITS[@]}" -v "$DATA_DIR/tiles:/tiles" -v "$OUT:/out" protomaps/go-pmtiles:latest \
  extract "/tiles/$(basename "$MASTER_PMTILES")" /out/basemap.pmtiles --bbox="$BBOX"

echo "==> [$ID] extracting region .osm.pbf"
docker run --rm "${LIMITS[@]}" -v "$(dirname "$MASTER_PBF"):/in" -v "$WORK:/work" iboates/osmium:latest \
  extract --bbox "$BBOX" --overwrite -o "/work/$ID.osm.pbf" "/in/$(basename "$MASTER_PBF")"

echo "==> [$ID] building search.sqlite"
# Disk-backed node index: export memory stays flat no matter the region size
# (the in-memory default scales with node count and would hit the cap).
docker run --rm "${LIMITS[@]}" -v "$WORK:/work" iboates/osmium:latest \
  export --overwrite -f geojsonseq -i "sparse_file_array,/work/$ID.nodeidx" \
  -o "/work/$ID.geojsonseq" "/work/$ID.osm.pbf"
node "$SCRIPT_DIR/build-search-db.mjs" "$OUT/search.sqlite" "$NAME" < "$WORK/$ID.geojsonseq"
rm -f "$WORK/$ID.geojsonseq" "$WORK/$ID.nodeidx"

if [[ -z "$GRAPH_DIR" ]]; then
  echo "==> [$ID] building GraphHopper graph (import mode)"
  GRAPH_DIR="$WORK/graph-cache"
  # The import container runs as root, so stale graph-cache files are
  # root-owned and a plain host rm can't remove them.
  docker run --rm -v "$WORK:/work" alpine:latest rm -rf /work/graph-cache
  # MMAP_STORE keeps the graph on disk during import instead of on the heap:
  # slower, but import memory no longer scales with region size, so big
  # regions just take longer rather than needing a bigger cap. It can't be set
  # via -Ddw.… (Dropwizard nests on the dots inside GH's literal keys), so
  # generate an import config from the server one.
  sed '/^graphhopper:/a\  graph.dataaccess.default_type: MMAP_STORE' \
    "$SCRIPT_DIR/../graphhopper/config.yml" > "$WORK/gh-import.yml"
  # Run the import directly rather than through the image entrypoint: the
  # entrypoint ignores CLI args (defaults to downloading all of Norway) and
  # execs into server mode after importing, which would hang the build.
  docker run --rm "${LIMITS[@]}" \
    -v "$WORK:/data" \
    -v "$DATA_DIR/graphhopper/elevation-cache:/data/elevation-cache" \
    --entrypoint java \
    graphhopper-graphhopper:latest \
    -Xmx3g \
    -Ddw.graphhopper.datareader.file="/data/$ID.osm.pbf" \
    -jar /graphhopper/graphhopper.jar import /data/gh-import.yml
fi

echo "==> [$ID] zipping graph + assets"
# No zip binary on the host; python3 stdlib makes an equivalent deflated zip.
zipdir() { # zipdir <srcdir> <out.zip> [entries…, default all of srcdir]
  python3 - "$@" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
entries = sys.argv[3:] or ['.']
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for entry in entries:
        top = os.path.join(src, entry)
        if os.path.isfile(top):
            z.write(top, os.path.normpath(entry))
            continue
        for root, _, files in os.walk(top):
            for f in sorted(files):
                full = os.path.join(root, f)
                z.write(full, os.path.relpath(full, src))
PY
}
zipdir "$GRAPH_DIR" "$OUT/graph.zip"
zipdir "$DATA_DIR/assets" "$OUT/assets.zip" fonts sprites

echo "==> [$ID] writing pack.json"
IFS=',' read -r MINLNG MINLAT MAXLNG MAXLAT <<< "$BBOX"
node -e "
const { statSync, writeFileSync } = require('node:fs');
const out = process.argv[1];
const file = (p) => ({ path: p, bytes: statSync(out + '/' + p).size });
writeFileSync(out + '/pack.json', JSON.stringify({
  id: process.argv[2],
  name: process.argv[3],
  bbox: { sw: { lat: $MINLAT, lng: $MINLNG }, ne: { lat: $MAXLAT, lng: $MAXLNG } },
  version: Math.floor(Date.now() / 1000),
  builtAt: Date.now(),
  files: {
    basemap: file('basemap.pmtiles'),
    search: file('search.sqlite'),
    graph: file('graph.zip'),
    assets: file('assets.zip'),
  },
}, null, 2));
" "$OUT" "$ID" "$NAME"

echo "==> [$ID] done:"
ls -la "$OUT"
