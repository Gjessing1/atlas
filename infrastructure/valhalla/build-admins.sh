#!/usr/bin/env bash
# Build the Valhalla admin database: the country polygons that tell the routing
# graph which side of the road each road drives on. Run once, then whenever the
# covered countries change; the result lands at DATA_DIR/valhalla/admins.sqlite
# and the service picks it up on its next tile build.
#
# Why this is a separate job rather than a step of the tile build
# -----------------------------------------------------------------
# `valhalla_build_admins` over the same regional Geofabrik extracts the tiles
# are built from silently drops countries: the extract clips the country
# boundary relation, the ring never closes, and no level-2 row is written.
# Norway + Sweden yields exactly two country rows, both Sweden, with every
# Norwegian county orphaned (parent_admin NULL). A road inside no country
# polygon falls back to Valhalla's default admin — which drives on the LEFT.
# That is how an admin DB built this way made Norwegian roundabouts count
# their exits on the wrong side, and why the tile build ran with the admin DB
# disabled entirely (384d847).
#
# The fix is to stop deriving admins from the routing extracts. Boundaries are
# a rounding error of the continent — a few tens of MB of a 32 GB Europe
# extract — so this builds them once from a continent-wide source and every
# tile build reuses the result. Coverage of the admin DB is deliberately wider
# than the routing graph: countries cost nothing here, and a graph that later
# gains a country already has its driving side waiting.
#
# Boundaries change on the timescale of treaties, so this is not an overnight
# job like the tile and basemap builds — rerun it when the routing graph gains
# a country, or once a year to pick up OSM corrections.
set -euo pipefail

DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
WORK="${ATLAS_ADMIN_WORK:-$DATA_DIR/admin-build}"
# The GWDG mirror rather than Geofabrik itself: Geofabrik throttles a sustained
# 32 GB transfer down to a few hundred kB/s partway through (measured, and it
# turns a 30-minute download into a six-hour one), while the mirror holds ~20
# MB/s throughout. Both are the same weekly build, and the md5 check below
# catches the case where the mirror is mid-update.
SOURCE_URL="${ADMIN_SOURCE_URL:-https://ftp5.gwdg.de/pub/misc/openstreetmap/download.geofabrik.de/europe-latest.osm.pbf}"
SOURCE_PBF="$WORK/$(basename "$SOURCE_URL")"
BOUNDARIES="$WORK/boundaries.osm.pbf"
OUT="$DATA_DIR/valhalla/admins.sqlite"
VALHALLA_IMAGE="ghcr.io/valhalla/valhalla:3.8.2"

# Same discipline as the other builds on this host: hard caps so the worst case
# is an OOM-killed build container, never a wedged host. Both heavy steps are
# disk-backed, so a bigger source costs time rather than RAM.
LIMITS=(--memory 6g --memory-swap 6g --cpus 2)

# Europe's left-driving countries, in full: the UK and its Crown Dependencies,
# Ireland, Malta, Cyprus. Everything else on the continent drives on the right;
# RIGHT_ISO is a sample big enough that a DB claiming "left" everywhere could
# not pass. Both lists are checked for a complete boundary ring below and for
# the correct driving side at the end — one source of truth for both.
LEFT_ISO=('GB' 'IE' 'IM' 'JE' 'GG' 'MT' 'CY')
RIGHT_ISO=('NO' 'SE' 'DK' 'DE' 'NL' 'BE' 'FR' 'ES' 'IT' 'PL' 'FI')

mkdir -p "$WORK" "$DATA_DIR/valhalla"

if [[ ! -f "$SOURCE_PBF" ]]; then
  echo "==> downloading $SOURCE_URL (~32 GB, deletable afterwards)"
  curl -fL --retry 5 --retry-delay 10 -o "$SOURCE_PBF.part" "$SOURCE_URL"
  mv "$SOURCE_PBF.part" "$SOURCE_PBF"
fi

# Both of the next two steps read the 33 GB source, and together they are most
# of this script's runtime, so they are skipped once the filtered result exists
# and is newer than what it came from. Deleting boundaries.osm.pbf forces both
# again; so does a fresh download, since that makes the source newer.
if [[ -f "$BOUNDARIES" && "$BOUNDARIES" -nt "$SOURCE_PBF" ]]; then
  echo "==> reusing $(basename "$BOUNDARIES") ($(du -h "$BOUNDARIES" | cut -f1))"
else

# Verify the source before spending an hour on it. A mirror caught mid-update
# serves a truncated file, and a truncated PBF does not fail loudly — osmium
# reads the blocks that are there and the admin build simply comes out missing
# whichever countries fell off the end, which is precisely the silent, plausible
# wrongness the verification step below exists to catch. Cheaper to catch here.
if curl -fsL --retry 3 -o "$WORK/source.md5" "$SOURCE_URL.md5"; then
  echo "==> verifying $(basename "$SOURCE_PBF") against published md5"
  (cd "$(dirname "$SOURCE_PBF")" && md5sum -c --status \
    <(awk -v f="$(basename "$SOURCE_PBF")" '{print $1 "  " f}' "$WORK/source.md5")) || {
    echo "md5 mismatch — the download is corrupt or the mirror was mid-update." >&2
    echo "delete $SOURCE_PBF and rerun." >&2
    exit 1
  }
else
  echo "==> no published md5 for this source; skipping integrity check"
fi

# osmium-tool isn't packaged in the Valhalla image and there is no public
# osmium image to pull, so build a one-line Debian wrapper for it.
echo "==> preparing osmium"
docker build -q -t atlas-osmium - > /dev/null <<'DOCKERFILE'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool \
  && rm -rf /var/lib/apt/lists/*
DOCKERFILE

echo "==> filtering boundary relations out of $(basename "$SOURCE_PBF")"
# tags-filter carries the ways and nodes those relations reference along by
# default (-R would omit them), and that is the whole point: those members are
# what lets the rings close, and dropping them is exactly what the clipped
# country extracts do. It tracks the referenced ids in bitmaps rather than a
# node cache, so this stays well inside the memory cap even on the continent.
docker run --rm "${LIMITS[@]}" -v "$WORK:/work" atlas-osmium \
  osmium tags-filter \
  "/work/$(basename "$SOURCE_PBF")" r/boundary=administrative \
  -o /work/boundaries.osm.pbf --overwrite
ls -lh "$BOUNDARIES" | awk '{print "    boundaries: " $5}'
fi

# Patch the rings the continent cut.
#
# A country polygon is built from its boundary relation's member ways, and if
# one is missing the ring never closes and the country gets no polygon at all —
# whereupon every road in it inherits Valhalla's default admin, which drives on
# the left. Even a continent extract does this, because country relations reach
# outside their continent: Norway's includes Bouvet Island in the South
# Atlantic, and losing that one way of 223 costs Norway its entire polygon. The
# Netherlands loses 38 ways to its Caribbean municipalities.
#
# So: find the countries whose rings are short, and refetch those relations
# whole from the OSM API. Only the incomplete ones, which is normally two, and
# the geometry is what matters rather than the snapshot it came from.
echo "==> checking country rings"
RING_CHECK="$WORK/ring-check.sh"
cat > "$RING_CHECK" <<'RING'
set -e
for iso in "$@"; do
  osmium tags-filter -R /work/boundaries.osm.pbf "r/ISO3166-1=$iso"     -o /work/_rel.osm.pbf --overwrite 2>/dev/null
  line=$(osmium cat -f opl /work/_rel.osm.pbf 2>/dev/null | head -1)
  [ -n "$line" ] || { echo "$iso MISSING_RELATION"; continue; }
  echo "$line" | sed 's/.*M//' | tr ',' '
' | grep '^w' | sed 's/@.*//;s/^w//'     | sort -u > /work/_want.ids
  sed 's/^/w/' /work/_want.ids > /work/_want.txt
  # getid exits non-zero when a requested id is absent, which is the very case
  # being measured here — it still writes what it did find, so tolerate the
  # status and let the count comparison below be the answer.
  osmium getid -i /work/_want.txt /work/boundaries.osm.pbf -o /work/_got.osm.pbf     --overwrite 2>/dev/null || true
  osmium cat -f opl /work/_got.osm.pbf 2>/dev/null | grep '^w' | cut -d' ' -f1     | sed 's/^w//' | sort -u > /work/_got.ids
  short=$(comm -23 /work/_want.ids /work/_got.ids | grep -c . || true)
  if [ "$short" != "0" ]; then
    echo "$iso INCOMPLETE $(echo "$line" | cut -d' ' -f1 | sed 's/^r//') $short"
  fi
done
RING
docker run --rm "${LIMITS[@]}" -v "$WORK:/work" atlas-osmium   bash /work/ring-check.sh "${LEFT_ISO[@]}" "${RIGHT_ISO[@]}" > "$WORK/rings.txt"

PATCH_SOURCES=()
while read -r iso state relid short; do
  if [[ "$state" == MISSING_RELATION ]]; then
    echo "  $iso: no boundary relation in the source at all" >&2
    exit 1
  fi
  echo "  $iso: ring short by $short way(s) — refetching relation $relid"
  curl -fsSL --retry 3 -o "$WORK/rel-$relid.osm"     "https://api.openstreetmap.org/api/0.6/relation/$relid/full"
  docker run --rm "${LIMITS[@]}" -v "$WORK:/work" atlas-osmium     osmium sort "/work/rel-$relid.osm" -o "/work/rel-$relid.osm.pbf" --overwrite
  PATCH_SOURCES+=("/work/rel-$relid.osm.pbf")
done < "$WORK/rings.txt"

if ((${#PATCH_SOURCES[@]})); then
  echo "==> merging ${#PATCH_SOURCES[@]} refetched relation(s) into the boundaries"
  docker run --rm "${LIMITS[@]}" -v "$WORK:/work" atlas-osmium     osmium merge /work/boundaries.osm.pbf "${PATCH_SOURCES[@]}"     -o /work/boundaries-patched.osm.pbf --overwrite
  ADMIN_INPUT=/work/boundaries-patched.osm.pbf
else
  echo "    every checked country ring is complete"
  ADMIN_INPUT=/work/boundaries.osm.pbf
fi

echo "==> building admins.sqlite"
docker run --rm "${LIMITS[@]}" -v "$WORK:/work" --entrypoint bash "$VALHALLA_IMAGE" -c "
  set -e
  valhalla_build_config --mjolnir-admin /work/admins.sqlite --mjolnir-timezone '' > /work/admin-config.json
  rm -f /work/admins.sqlite
  valhalla_build_admins -c /work/admin-config.json $ADMIN_INPUT"

# The guard. A DB that is merely *present* is not safe: the failure this whole
# script exists to prevent is a plausible-looking file with countries missing
# or on the wrong side, and that failure is invisible until someone drives a
# roundabout in the wrong country. So assert the answer we already know —
# every left-driving country in Europe, and a sample that must stay right —
# and refuse to install anything that disagrees.
echo "==> verifying"
LEFT_CSV=$(IFS=,; echo "${LEFT_ISO[*]}")
RIGHT_CSV=$(IFS=,; echo "${RIGHT_ISO[*]}")
python3 - "$WORK/admins.sqlite" "$LEFT_CSV" "$RIGHT_CSV" <<'PY'
import sqlite3, sys

db_path, left_csv, right_csv = sys.argv[1], sys.argv[2], sys.argv[3]
LEFT = left_csv.split(',')
RIGHT = right_csv.split(',')

db = sqlite3.connect(db_path)
rows = dict(db.execute('select iso_code, drive_on_right from admins where admin_level = 2'))
problems = []


def check(iso, want):
    got = rows.get(iso)
    side = 'left' if want == 0 else 'right'
    if got is None:
        # The failure that matters most: no polygon means the country's roads
        # inherit the default admin, which drives on the left.
        problems.append(f'{iso}: no country row — its roads would inherit the default admin')
    elif got != want:
        problems.append(f'{iso}: drive_on_right={got}, expected {want} (drives on the {side})')


for iso in LEFT:
    check(iso, 0)
for iso in RIGHT:
    check(iso, 1)

print(f'    {len(rows)} countries; checked {len(LEFT)} left-driving, {len(RIGHT)} right-driving')
if problems:
    print('\nadmin DB REJECTED — not installed:', file=sys.stderr)
    for p in problems:
        print(f'  - {p}', file=sys.stderr)
    sys.exit(1)
PY

mv "$WORK/admins.sqlite" "$OUT"
echo "==> installed $OUT ($(du -h "$OUT" | cut -f1))"
echo "    Rebuild the routing tiles to apply it:"
echo "      rm /mnt/data/atlas/valhalla/tiles.tar && docker compose restart valhalla"
echo "    The $(basename "$SOURCE_PBF") in $WORK is only needed to rebuild this DB; safe to delete."
