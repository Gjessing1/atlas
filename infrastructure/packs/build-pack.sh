#!/usr/bin/env bash
# Build an offline region pack for the Android app (Phase 6).
#
#   ./build-pack.sh <id> "<Name>" <minLng,minLat,maxLng,maxLat>
#   ./build-pack.sh oslo "Oslo" 10.4,59.7,11.0,60.1
#
# Produces <DATA_DIR>/packs/<id>/ containing:
#   basemap.pmtiles   extracted from the master basemap (tiles/norway.pmtiles)
#   search.sqlite     FTS5 index of named OSM features (build-search-db.mjs)
#   valhalla.tar      Valhalla tile extract for the region (offline routing —
#                     the same engine version the server runs, so offline and
#                     online routes agree)
#   assets.zip        map glyphs + sprites (offline labels/icons)
#   pack.json         manifest served by /api/regions
#
# Sources: the master .pmtiles and the Norway .osm.pbf under DATA_DIR (see
# CLAUDE.md data dir layout). Building the routing tiles runs the same
# Valhalla image the server uses (infrastructure/valhalla) and reuses the
# server's admins/timezones databases from DATA_DIR/valhalla (bring the
# server service up once before building packs).
set -euo pipefail

# This host runs ~30 other containers in 15 GiB of RAM. Every docker step gets
# a hard memory cap (memory-swap == memory, so no host swap pressure) and a CPU
# cap; worst case the build container is OOM-killed (exit 137), never the host.
# The steps whose memory would grow with region size run disk-backed (osmium
# file index, Valhalla tile build), so bigger regions cost time, not RAM.
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
MASTER_PBF="$DATA_DIR/valhalla/norway.osm.pbf"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ID="${1:?region id, e.g. oslo}"
NAME="${2:?region name, e.g. Oslo}"
BBOX="${3:?bbox as minLng,minLat,maxLng,maxLat}"

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
node "$SCRIPT_DIR/enrich-place-content.mjs" "$OUT/search.sqlite"
rm -f "$WORK/$ID.geojsonseq" "$WORK/$ID.nodeidx"

echo "==> [$ID] building Valhalla routing tiles"
# Reuse the server's admins/timezones (built by infrastructure/valhalla on
# first start) — same data source, and skips a shapefile download per pack.
VALHALLA_MASTER="$DATA_DIR/valhalla"
for f in admins.sqlite timezones.sqlite; do
  [[ -f "$VALHALLA_MASTER/$f" ]] || {
    echo "missing $VALHALLA_MASTER/$f — start infrastructure/valhalla once first." >&2
    exit 1
  }
done
# Tile builds run as root in the container; clean any stale root-owned dir.
docker run --rm -v "$WORK:/work" alpine:latest rm -rf /work/valhalla-tiles /work/valhalla.tar
docker run --rm "${LIMITS[@]}" \
  -v "$WORK:/work" \
  -v "$VALHALLA_MASTER:/master:ro" \
  --entrypoint bash \
  ghcr.io/valhalla/valhalla:3.8.2 \
  -c "set -euo pipefail
      valhalla_build_config \
        --mjolnir-tile-dir /work/valhalla-tiles \
        --mjolnir-tile-extract /work/valhalla.tar \
        --mjolnir-timezone /master/timezones.sqlite \
        --mjolnir-admin /master/admins.sqlite \
        --mjolnir-concurrency 2 > /work/valhalla.json
      valhalla_build_tiles -c /work/valhalla.json /work/$ID.osm.pbf
      valhalla_build_extract -c /work/valhalla.json -v --overwrite"
cp "$WORK/valhalla.tar" "$OUT/valhalla.tar"

echo "==> [$ID] zipping assets"
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
    routing: file('valhalla.tar'),
    assets: file('assets.zip'),
  },
}, null, 2));
" "$OUT" "$ID" "$NAME"

echo "==> [$ID] removing stale files"
# Drop leftovers from earlier builds (e.g. graph.zip from the GraphHopper era)
# so the pack dir only ever holds what pack.json references.
for f in "$OUT"/*; do
  case "$(basename "$f")" in
    basemap.pmtiles | search.sqlite | valhalla.tar | assets.zip | pack.json) ;;
    *)
      echo "    removing stale $(basename "$f")"
      rm -rf "$f"
      ;;
  esac
done

echo "==> [$ID] done:"
ls -la "$OUT"
