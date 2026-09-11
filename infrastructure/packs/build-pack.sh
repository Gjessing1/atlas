#!/usr/bin/env bash
# Build an offline region pack for the Android app (Phase 6).
#
#   ./build-pack.sh <source> <region>
#   ./build-pack.sh norway oslo
#   ./build-pack.sh great-britain scotland
#
# Both arguments name entries in a committed spec: specs/<source>.json says
# which master datasets the source is cut from, which of them a pack may ship
# without, what the masters cover, and — per region — the bbox plus the search
# and routing points that prove the result works. Nothing
# here is derived from the region id any more: the producer used to know that
# `oslo` meant `tiles/norway.pmtiles` and that Great Britain would want
# `tiles/outdoor-great-britain.pmtiles`, and none of those rules were visible in
# the pack they produced.
#
# Produces <DATA_DIR>/packs/<region>/ containing:
#   basemap.pmtiles   cut from the source's master basemap
#   outdoor.pmtiles   cut from the outdoor overlay — cabins, gates, ramps and
#                     shelters the basemap drops or hides until z14; absent
#                     where the source declares no overlay
#   search.sqlite     FTS5 index of named OSM features (build-search-db.mjs)
#   nvdb.sqlite       speed limits, turn lanes and cameras (build-pack-nvdb.mjs)
#   valhalla.tar      routing tiles, same engine version the server runs, so
#                     offline and online routes agree
#   assets.zip        map glyphs + sprites (offline labels/icons)
#   pack.json         manifest served by /api/regions — written LAST, after the
#                     smoke checks, because writing it is publication
#
# The build runs in a staging directory and is swapped into place only once
# smoke-pack.mjs has opened every artifact and asked it a real question. A
# failure anywhere leaves the previously published pack exactly as it was.
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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOURCE="${1:?source id, e.g. norway (see specs/)}"
REGION="${2:?region id, e.g. oslo}"

OUT="$DATA_DIR/packs/$REGION"
WORK="$DATA_DIR/packs-build/$REGION"
STAGE="$WORK/stage"
PLAN="$WORK/plan.json"
mkdir -p "$WORK"

# Everything that can be known before the expensive work: the spec parses, the
# region is inside what the masters cover, every required input exists, the
# admin DB has the countries (a missing polygon means Valhalla's default admin,
# which drives on the LEFT), and which pinned tool images to run. Nothing below
# resolves a path of its own.
echo "==> [$REGION] planning from specs/$SOURCE.json"
# Captured first, evaluated second: `eval "$(...)"` takes the exit status of
# eval, so a planner that refused would otherwise be an empty eval and a build
# that carried on into an unset-variable error further down.
PLAN_ENV="$(node "$SCRIPT_DIR/plan-pack.mjs" "$SOURCE" "$REGION" --plan "$PLAN")"
eval "$PLAN_ENV"

# A stale stage can only be an interrupted build of this same region, and its
# files are of unknown vintage. The Valhalla step writes root-owned dirs through
# the mount, so the cleanup runs in a container.
docker run --rm "${LIMITS[@]}" -v "$WORK:/work" "$TOOL_CLEANUP" rm -rf /work/stage
mkdir -p "$STAGE"

echo "==> [$REGION] extracting basemap from $(basename "$IN_BASEMAP")"
docker run --rm "${LIMITS[@]}" -v "$(dirname "$IN_BASEMAP"):/tiles:ro" -v "$STAGE:/out" "$TOOL_PMTILES" \
  extract "/tiles/$(basename "$IN_BASEMAP")" /out/basemap.pmtiles --bbox="$PACK_BBOX"

# Optional, and deliberately so: a source that declares no outdoor overlay (or
# a host that has never run build-outdoor.sh) still produces a complete,
# working pack — the app falls back to the basemap-only outdoor layers exactly
# as it does online.
if [[ -n "$IN_OUTDOOR" ]]; then
  echo "==> [$REGION] extracting outdoor overlay"
  docker run --rm "${LIMITS[@]}" -v "$(dirname "$IN_OUTDOOR"):/tiles:ro" -v "$STAGE:/out" "$TOOL_PMTILES" \
    extract "/tiles/$(basename "$IN_OUTDOOR")" /out/outdoor.pmtiles --bbox="$PACK_BBOX"
else
  echo "==> [$REGION] $PACK_SOURCE declares no outdoor overlay — skipping"
fi

echo "==> [$REGION] extracting region .osm.pbf"
docker run --rm "${LIMITS[@]}" -v "$(dirname "$IN_OSM"):/in:ro" -v "$WORK:/work" "$TOOL_OSMIUM" \
  extract --bbox "$PACK_BBOX" --overwrite -o "/work/$REGION.osm.pbf" "/in/$(basename "$IN_OSM")"

echo "==> [$REGION] building search.sqlite"
# Disk-backed node index: export memory stays flat no matter the region size
# (the in-memory default scales with node count and would hit the cap).
docker run --rm "${LIMITS[@]}" -v "$WORK:/work" "$TOOL_OSMIUM" \
  export --overwrite -f geojsonseq -i "sparse_file_array,/work/$REGION.nodeidx" \
  -o "/work/$REGION.geojsonseq" "/work/$REGION.osm.pbf"
node "$SCRIPT_DIR/build-search-db.mjs" "$STAGE/search.sqlite" "$PACK_NAME" < "$WORK/$REGION.geojsonseq"
node "$SCRIPT_DIR/enrich-place-content.mjs" "$STAGE/search.sqlite"

echo "==> [$REGION] building nvdb.sqlite (speed limits + turn lanes + cameras)"
# Offline road data: NVDB speed limits + turn lanes + ATK cameras
# clipped from the national master where the source has one, plus OSM speed
# cameras read from the same region extract — the only camera data available
# outside Norway. Reuses the search stream, so it must run before the
# geojsonseq is removed. The script deletes its output when the region has no
# road data, so a missing file below simply means "nothing to ship".
node "$SCRIPT_DIR/build-pack-nvdb.mjs" "$STAGE/nvdb.sqlite" "$PACK_BBOX" ${IN_NVDB:+"$IN_NVDB"} \
  < "$WORK/$REGION.geojsonseq"
rm -f "$WORK/$REGION.geojsonseq" "$WORK/$REGION.nodeidx"

echo "==> [$REGION] building Valhalla routing tiles"
# Reuse the server's timezones and its admin database, so an offline pack counts
# roundabout exits on the same side as the server. Both are required by every
# spec: a pack is what the phone routes from abroad, which is exactly where a
# wrong driving side would be a surprise rather than a nuisance.
docker run --rm "${LIMITS[@]}" -v "$WORK:/work" "$TOOL_CLEANUP" rm -rf /work/valhalla-tiles /work/valhalla.tar
# The data dir is mounted whole and read-only rather than one input's parent:
# a spec may keep the admin and timezone databases in different directories.
docker run --rm "${LIMITS[@]}" \
  -v "$WORK:/work" \
  -v "$DATA_DIR:/data:ro" \
  --entrypoint bash \
  "$TOOL_VALHALLA" \
  -c "set -euo pipefail
      valhalla_build_config \
        --mjolnir-tile-dir /work/valhalla-tiles \
        --mjolnir-tile-extract /work/valhalla.tar \
        --mjolnir-timezone /data/$REL_TIMEZONES \
        --mjolnir-admin /data/$REL_ADMINS \
        --mjolnir-concurrency 2 > /work/valhalla.json
      valhalla_build_tiles -c /work/valhalla.json /work/$REGION.osm.pbf
      valhalla_build_extract -c /work/valhalla.json -v --overwrite"
cp "$WORK/valhalla.tar" "$STAGE/valhalla.tar"

echo "==> [$REGION] zipping assets"
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
zipdir "$IN_ASSETS" "$STAGE/assets.zip" fonts sprites

echo "==> [$REGION] smoke checks"
# Opens every artifact and asks it the question a phone will ask: draw this
# tile, find this place, route between these two points. Checksums cannot tell
# an intact archive of the wrong place from the right one.
node "$SCRIPT_DIR/smoke-pack.mjs" "$PLAN" "$STAGE"

echo "==> [$REGION] writing pack.json"
node "$SCRIPT_DIR/write-manifest.mjs" "$PLAN" "$STAGE"

echo "==> [$REGION] publishing"
# The swap, mirroring what the device does with a downloaded pack: the previous
# pack is parked, the new one moved in, the parked copy dropped only once the
# new one is in place. Same filesystem, so each move is a rename.
if [[ -d "$OUT" ]]; then
  rm -rf "$OUT.old"
  mv "$OUT" "$OUT.old"
fi
mkdir -p "$(dirname "$OUT")"
if ! mv "$STAGE" "$OUT"; then
  [[ -d "$OUT.old" ]] && mv "$OUT.old" "$OUT"
  echo "publish failed — the previous pack is back in place" >&2
  exit 1
fi
rm -rf "$OUT.old"

echo "==> [$REGION] done:"
ls -la "$OUT"
