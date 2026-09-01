#!/usr/bin/env bash
# Refresh only the outdoor overlay inside every published offline region.
#
# The national outdoor archive is rebuilt far more often than routing/search
# data: adding an OSM POI class should not spend hours rebuilding Valhalla and
# FTS indexes that are byte-for-byte unchanged. This extracts the new archive
# to each region's existing bbox, then atomically updates its file and manifest.
set -euo pipefail

DATA_DIR="${ATLAS_DATA_DIR:-/mnt/data/atlas}"
MASTER_OUTDOOR="$DATA_DIR/tiles/outdoor.pmtiles"
PACKS_DIR="$DATA_DIR/packs"
# Pinned by digest in tools.json, like every other tool the producer runs
# (ROADMAP §7.5 DR7) — the archive this cuts is recorded in each pack's
# provenance, and a `:latest` that moved would make that record a guess.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PMTILES_IMAGE="$(jq -er '.pmtiles.image' "$SCRIPT_DIR/../tools.json")"

[[ -f "$MASTER_OUTDOOR" ]] || {
  echo "missing $MASTER_OUTDOOR — run infrastructure/tiles/build-outdoor.sh first" >&2
  exit 1
}

shopt -s nullglob
MANIFESTS=("$PACKS_DIR"/*/pack.json)
(( ${#MANIFESTS[@]} > 0 )) || {
  echo "no published packs under $PACKS_DIR" >&2
  exit 1
}

for manifest in "${MANIFESTS[@]}"; do
  pack_dir="$(dirname "$manifest")"
  pack_id="$(basename "$pack_dir")"
  bbox="$(jq -er '[.bbox.sw.lng,.bbox.sw.lat,.bbox.ne.lng,.bbox.ne.lat] | join(",")' "$manifest")"
  next="$pack_dir/outdoor.pmtiles.next"

  # A stale .next can only be an interrupted extraction for this exact pack.
  rm -f "$next"
  echo ">> [$pack_id] extracting outdoor overlay ($bbox)"
  docker run --rm \
    -u "$(id -u):$(id -g)" \
    -v "$DATA_DIR/tiles:/tiles:ro" \
    -v "$pack_dir:/out" \
    "$PMTILES_IMAGE" \
    extract "/tiles/$(basename "$MASTER_OUTDOOR")" /out/outdoor.pmtiles.next --bbox="$bbox"
  mv -f "$next" "$pack_dir/outdoor.pmtiles"

  node - "$manifest" "$MASTER_OUTDOOR" "${MASTER_OUTDOOR#"$DATA_DIR/"}" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const manifestPath = process.argv[2];
const packDir = dirname(manifestPath);
const outdoorPath = join(packDir, 'outdoor.pmtiles');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bytes = readFileSync(outdoorPath);
const builtAt = Date.now();
manifest.files.outdoor = {
  path: 'outdoor.pmtiles',
  bytes: statSync(outdoorPath).size,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
manifest.version = Math.max(Number(manifest.version) + 1, builtAt);
manifest.builtAt = builtAt;
// Keep the provenance honest about the archive this pack was actually cut
// from: a refreshed overlay with the old input record is exactly the
// wrong-but-readable pack DR7 exists to prevent.
const master = process.argv[3];
if (manifest.provenance && master) {
  const stat = statSync(master);
  const record = {
    id: 'outdoor',
    path: process.argv[4],
    bytes: stat.size,
    modifiedAt: Math.round(stat.mtimeMs),
    sha256: createHash('sha256').update(readFileSync(master)).digest('hex'),
  };
  const inputs = manifest.provenance.inputs ?? [];
  const at = inputs.findIndex((input) => input.id === 'outdoor');
  if (at >= 0) inputs[at] = record;
  else inputs.push(record);
  manifest.provenance.inputs = inputs;
}
const nextManifest = `${manifestPath}.next`;
writeFileSync(nextManifest, `${JSON.stringify(manifest, null, 2)}\n`);
renameSync(nextManifest, manifestPath);
NODE
done

echo ">> Refreshed ${#MANIFESTS[@]} published region packs"
