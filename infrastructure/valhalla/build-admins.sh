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
SOURCE_URL="${ADMIN_SOURCE_URL:-https://download.geofabrik.de/europe-latest.osm.pbf}"
SOURCE_PBF="$WORK/$(basename "$SOURCE_URL")"
BOUNDARIES="$WORK/boundaries.osm.pbf"
OUT="$DATA_DIR/valhalla/admins.sqlite"
VALHALLA_IMAGE="ghcr.io/valhalla/valhalla:3.8.2"

# Same discipline as the other builds on this host: hard caps so the worst case
# is an OOM-killed build container, never a wedged host. Both heavy steps are
# disk-backed, so a bigger source costs time rather than RAM.
LIMITS=(--memory 6g --memory-swap 6g --cpus 2)

mkdir -p "$WORK" "$DATA_DIR/valhalla"

if [[ ! -f "$SOURCE_PBF" ]]; then
  echo "==> downloading $SOURCE_URL (~32 GB, deletable afterwards)"
  curl -fL --retry 3 -o "$SOURCE_PBF.part" "$SOURCE_URL"
  mv "$SOURCE_PBF.part" "$SOURCE_PBF"
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
# -r pulls in the ways and nodes the relations reference, which is what makes
# the rings closeable — the exact thing the clipped country extracts lack.
# The node index is disk-backed so this stays inside the memory cap.
docker run --rm "${LIMITS[@]}" -v "$WORK:/work" atlas-osmium \
  osmium tags-filter -r --index-type=sparse_file_array \
  "/work/$(basename "$SOURCE_PBF")" r/boundary=administrative \
  -o /work/boundaries.osm.pbf --overwrite
ls -lh "$BOUNDARIES" | awk '{print "    boundaries: " $5}'

echo "==> building admins.sqlite"
docker run --rm "${LIMITS[@]}" -v "$WORK:/work" --entrypoint bash "$VALHALLA_IMAGE" -c "
  set -e
  valhalla_build_config --mjolnir-admin /work/admins.sqlite --mjolnir-timezone '' > /work/admin-config.json
  rm -f /work/admins.sqlite
  valhalla_build_admins -c /work/admin-config.json /work/boundaries.osm.pbf"

# The guard. A DB that is merely *present* is not safe: the failure this whole
# script exists to prevent is a plausible-looking file with countries missing
# or on the wrong side, and that failure is invisible until someone drives a
# roundabout in the wrong country. So assert the answer we already know —
# every left-driving country in Europe, and a sample that must stay right —
# and refuse to install anything that disagrees.
echo "==> verifying"
python3 - "$WORK/admins.sqlite" <<'PY'
import sqlite3, sys

# Europe's left-driving countries, in full: the UK and its Crown Dependencies,
# Ireland, Malta, Cyprus. Everything else on the continent drives on the right.
LEFT = {'GB': 'United Kingdom', 'IE': 'Ireland', 'IM': 'Isle of Man',
        'JE': 'Jersey', 'GG': 'Guernsey', 'MT': 'Malta', 'CY': 'Cyprus'}
RIGHT = {'NO': 'Norway', 'SE': 'Sweden', 'DK': 'Denmark', 'NL': 'Netherlands',
         'BE': 'Belgium', 'DE': 'Germany', 'FR': 'France', 'ES': 'Spain',
         'IT': 'Italy', 'PL': 'Poland', 'FI': 'Finland'}

db = sqlite3.connect(sys.argv[1])
rows = dict(db.execute('select iso_code, drive_on_right from admins where admin_level = 2'))
problems = []
for iso, name in sorted(LEFT.items()):
    got = rows.get(iso)
    if got is None:
        problems.append(f'{name} ({iso}): no country row — its roads would inherit the default admin')
    elif got != 0:
        problems.append(f'{name} ({iso}): drive_on_right={got}, expected 0 (drives on the left)')
for iso, name in sorted(RIGHT.items()):
    got = rows.get(iso)
    if got is None:
        problems.append(f'{name} ({iso}): no country row — its roads would inherit the default admin')
    elif got != 1:
        problems.append(f'{name} ({iso}): drive_on_right={got}, expected 1 (drives on the right)')

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
