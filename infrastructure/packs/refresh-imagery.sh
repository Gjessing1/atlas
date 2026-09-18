#!/usr/bin/env bash
# Add (or refresh) the offline satellite slab inside every published region.
#
# The same reasoning as refresh-outdoor.sh, and the reason that script exists:
# gaining one artifact should not spend hours rebuilding Valhalla tiles and FTS
# indexes that are byte-for-byte unchanged. A full build-pack.sh run over the
# six published regions is the better part of a day; this is the imagery step
# alone, cut to each region's own bbox and swapped in atomically.
#
#   ./refresh-imagery.sh [region-id …]     (default: every published pack)
#
# Needs the backend running — the tiles come through its overlay proxy so a
# pack cannot disagree with the layer it draws under (see build-pack-imagery.mjs).
# Point ATLAS_ORIGIN elsewhere to build against a dev backend.
set -euo pipefail

DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
PACKS_DIR="$DATA_DIR/packs"
ORIGIN="${ATLAS_ORIGIN:-http://127.0.0.1:3100}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsS --max-time 10 "$ORIGIN/api/health" > /dev/null || {
  echo "no backend at $ORIGIN — start it (or set ATLAS_ORIGIN) and retry" >&2
  exit 1
}

shopt -s nullglob
if (($# > 0)); then
  MANIFESTS=()
  for id in "$@"; do
    [[ -f "$PACKS_DIR/$id/pack.json" ]] || {
      echo "no published pack '$id' under $PACKS_DIR" >&2
      exit 1
    }
    MANIFESTS+=("$PACKS_DIR/$id/pack.json")
  done
else
  MANIFESTS=("$PACKS_DIR"/*/pack.json)
  ((${#MANIFESTS[@]} > 0)) || {
    echo "no published packs under $PACKS_DIR" >&2
    exit 1
  }
fi

for manifest in "${MANIFESTS[@]}"; do
  pack_dir="$(dirname "$manifest")"
  pack_id="$(basename "$pack_dir")"
  bbox="$(jq -er '[.bbox.sw.lng,.bbox.sw.lat,.bbox.ne.lng,.bbox.ne.lat] | join(",")' "$manifest")"

  echo ">> [$pack_id] cutting the satellite slab ($bbox)"
  # Built beside the pack, not inside it: a pack directory is published, and a
  # half-written archive there is one a device could download.
  node "$SCRIPT_DIR/build-pack-imagery.mjs" \
    "$WORK/$pack_id.zip" "$bbox" "$WORK/$pack_id.json" "$ORIGIN"

  if [[ ! -f "$WORK/$pack_id.zip" ]]; then
    echo ">> [$pack_id] no imagery to add — leaving the pack as it is"
    continue
  fi

  # Move first, then publish by rewriting the manifest: a pack whose manifest
  # names a file is a pack whose file is already there.
  mv -f "$WORK/$pack_id.zip" "$pack_dir/imagery.zip"

  node - "$manifest" "$WORK/$pack_id.json" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const manifestPath = process.argv[2];
const packDir = dirname(manifestPath);
const zipPath = join(packDir, 'imagery.zip');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const meta = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const builtAt = Date.now();

const entry = {
  path: 'imagery.zip',
  bytes: statSync(zipPath).size,
  sha256: createHash('sha256').update(readFileSync(zipPath)).digest('hex'),
  ...meta,
};
// Replace this layer's slab rather than appending: a pack carries one archive
// per layer, and a second entry would be downloaded and then ignored.
const layers = (manifest.files.layers ?? []).filter(
  (file) => !(file.kind === 'imagery' && file.layer === meta.layer),
);
layers.push(entry);
manifest.files.layers = layers;
// Same rule as refresh-outdoor.sh: the version has to move or no device will
// look at the pack again, and it has to stay monotonic with a full rebuild.
manifest.version = Math.max(Number(manifest.version) + 1, builtAt);
manifest.builtAt = builtAt;

const next = `${manifestPath}.next`;
writeFileSync(next, `${JSON.stringify(manifest, null, 2)}\n`);
renameSync(next, manifestPath);
console.log(
  `   ${manifest.id}: imagery.zip ${(entry.bytes / 1024 / 1024).toFixed(1)} MB, ` +
    `z${entry.minzoom}-${entry.maxzoom}, version ${manifest.version}`,
);
NODE
done

echo ">> Refreshed offline imagery in ${#MANIFESTS[@]} published region pack(s)"
