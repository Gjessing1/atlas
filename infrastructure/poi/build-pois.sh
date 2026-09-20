#!/usr/bin/env bash
# Build Europe's category-pin database from the shared Geofabrik extract.
# POI_DOWNLOAD=1 refreshes the PBF first; without it the already verified copy
# is used, which makes the first build need no 35 GB download.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
OSM_DIR="$DATA_DIR/osm"
# The source and geometry work belong on the large data disk, but the live
# random-read database can be placed on faster storage independently. The first
# Europe build measured 253 ms cold on tank, so production sets this to the
# system NVMe and bind-mounts the same directory at /data/poi.
POI_DIR="${ATLAS_POI_DIR:-$DATA_DIR/poi}"
WORK="${ATLAS_POI_WORK:-$DATA_DIR/poi-build}"
SOURCE_URL="${POI_SOURCE_URL:-https://ftp5.gwdg.de/pub/misc/openstreetmap/download.geofabrik.de/europe-latest.osm.pbf}"
SOURCE="$OSM_DIR/europe-latest.osm.pbf"
SOURCE_MD5_FILE="$OSM_DIR/europe-latest.osm.pbf.md5"
POLY="$OSM_DIR/europe.poly"
CANDIDATE="$POI_DIR/europe.sqlite.next"
REPORT_NEXT="$POI_DIR/europe-report.json.next"
CURRENT="$POI_DIR/europe.sqlite"
PREVIOUS="$POI_DIR/europe.sqlite.previous"
OSMIUM_IMAGE="$(jq -er '.osmium.image' "$SCRIPT_DIR/../tools.json")"
LIMITS=(--memory 6g --memory-swap 6g --cpus 2)
STARTED="${POI_BUILD_STARTED:-$(date +%s)}"

mkdir -p "$OSM_DIR" "$POI_DIR" "$WORK" "$DATA_DIR/planetiler" "$DATA_DIR/valhalla-build"

# Hold the producer lock and both other heavy-build locks for the entire run.
# Cron skips instead of queueing: two 6 GB jobs do not fit on this host.
exec 7>"$POI_DIR/.build.lock"
flock -n 7 || { echo "another POI build is running — skipping"; exit 0; }
exec 8>"$DATA_DIR/planetiler/.build.lock"
flock -n 8 || { echo "Planetiler is building — skipping POI refresh"; exit 0; }
exec 9>"$DATA_DIR/valhalla-build/.build.lock"
flock -n 9 || { echo "Valhalla is building — skipping POI refresh"; exit 0; }

trap 'rm -f "$CANDIDATE" "$CANDIDATE-journal" "$CANDIDATE-wal" "$CANDIDATE-shm" "$REPORT_NEXT"' EXIT

# v0.231.0's admin builder left the already verified Europe source here. Move,
# rather than copy, its 35 GB into the shared home both producers now use.
LEGACY="$DATA_DIR/admin-build/europe-latest.osm.pbf"
if [[ ! -s "$SOURCE" && -s "$LEGACY" ]]; then
  echo ">> Moving the existing Europe extract into $OSM_DIR"
  mv "$LEGACY" "$SOURCE"
  if [[ -s "$DATA_DIR/admin-build/source.md5" ]]; then
    cp "$DATA_DIR/admin-build/source.md5" "$SOURCE_MD5_FILE"
  fi
fi

if [[ "${POI_DOWNLOAD:-0}" == 1 ]]; then
  echo ">> Downloading current Europe extract from GWDG"
  curl -fL --retry 5 --retry-delay 10 -o "$SOURCE.next" "$SOURCE_URL"
  curl -fsSL --retry 3 -o "$SOURCE_MD5_FILE.next" "$SOURCE_URL.md5"
  EXPECTED="$(awk 'NR == 1 {print $1}' "$SOURCE_MD5_FILE.next")"
  echo "$EXPECTED  $SOURCE.next" | md5sum -c --status - || {
    echo "downloaded Europe extract failed its published md5" >&2
    exit 1
  }
  mv "$SOURCE.next" "$SOURCE"
  mv "$SOURCE_MD5_FILE.next" "$SOURCE_MD5_FILE"
fi

[[ -s "$SOURCE" ]] || { echo "missing $SOURCE" >&2; exit 1; }
if [[ ! -s "$SOURCE_MD5_FILE" ]]; then
  curl -fsSL --retry 3 -o "$SOURCE_MD5_FILE" "$SOURCE_URL.md5"
fi
EXPECTED_MD5="$(awk 'NR == 1 {print $1}' "$SOURCE_MD5_FILE")"
echo ">> Verifying the shared Europe extract"
echo "$EXPECTED_MD5  $SOURCE" | md5sum -c --status - || {
  echo "$SOURCE does not match its published md5" >&2
  exit 1
}

echo ">> Fetching Geofabrik's Europe coverage polygon"
curl -fsSL --retry 3 -o "$POLY.next" https://download.geofabrik.de/europe.poly
mv "$POLY.next" "$POLY"

echo ">> Building @atlas/core and deriving the osmium filter from POI_CATEGORIES"
(cd "$REPO" && npm run build -w @atlas/core)
node "$SCRIPT_DIR/generate-config.mjs" "$WORK/filter.txt" "$WORK/config.json" >/dev/null
SOURCE_TIMESTAMP="$(docker run --rm -v "$OSM_DIR:/osm:ro" "$OSMIUM_IMAGE" \
  fileinfo -g header.option.osmosis_replication_timestamp /osm/europe-latest.osm.pbf)"
[[ "$SOURCE_TIMESTAMP" =~ ^[0-9]{4}- ]] || { echo "source has no replication timestamp" >&2; exit 1; }

echo ">> Cutting POI objects from Europe (6 GB / 2 CPU cap)"
if [[ "${POI_REUSE_CUT:-0}" == 1 && -s "$WORK/pois.osm.pbf" ]]; then
  echo "    reusing completed $(du -h "$WORK/pois.osm.pbf" | cut -f1) recovery cut"
else
  docker run --rm "${LIMITS[@]}" -u "$(id -u):$(id -g)" \
    -v "$OSM_DIR:/osm:ro" -v "$WORK:/work" "$OSMIUM_IMAGE" \
    tags-filter --expressions=/work/filter.txt /osm/europe-latest.osm.pbf \
    -o /work/pois.osm.pbf --overwrite
fi

rm -f "$CANDIDATE"
echo ">> Exporting centres into the staged SQLite R-tree"
docker run --rm "${LIMITS[@]}" -u "$(id -u):$(id -g)" \
  -v "$WORK:/work" "$OSMIUM_IMAGE" \
  export -f geojsonseq -u type_id -a type,id -i sparse_file_array,/work/node-locations.idx \
  /work/pois.osm.pbf \
  | node "$SCRIPT_DIR/build-poi-db.mjs" "$CANDIDATE" "$WORK/config.json" \
      "$SOURCE_TIMESTAMP" "$SOURCE_URL" "$EXPECTED_MD5" "$POLY" "$STARTED"

echo ">> Smoke-checking counts, European coverage and local query latency"
node "$SCRIPT_DIR/smoke-poi-db.mjs" "$CANDIDATE" "$REPORT_NEXT"

# Keep the previous good inode for rollback, then atomically replace the live
# name. An already-open backend keeps reading the old inode until its next
# request notices and opens the replacement.
if [[ -s "$CURRENT" ]]; then ln -f "$CURRENT" "$PREVIOUS"; fi
mv -f "$CANDIDATE" "$CURRENT"
mv -f "$REPORT_NEXT" "$POI_DIR/europe-report.json"
rm -f "$WORK/pois.osm.pbf" "$WORK/node-locations.idx"
trap - EXIT
echo ">> Published $CURRENT ($(du -h "$CURRENT" | cut -f1)); rollback: $PREVIOUS"
