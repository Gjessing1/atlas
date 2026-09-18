#!/usr/bin/env node
// Write a built pack's manifest — the last step, after the smoke checks.
//
//   node write-manifest.mjs <plan.json> <pack-dir>
//
// pack.json is what the backend lists and the device reads, so writing it is
// publication. Besides the files and their digests it now records where the
// pack came from: the committed spec and its digest, every master input with
// its size, mtime and digest, and the pinned image of every tool that touched
// it. "Offline search, map and routing disagree in this region" is then read
// off the artifact rather than reconstructed from whatever the host looked
// like that night.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PACK_RUNTIME_REGION, PACK_SCHEMA_VERSION } from '@atlas/core';

const [planPath, packDir] = process.argv.slice(2);
if (!planPath || !packDir) {
  console.error('usage: write-manifest.mjs <plan.json> <pack-dir>');
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8'));

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });

// Streamed, because the tiles and routing files are hundreds of megabytes; the
// device verifies each one against these digests before it is allowed to
// replace a good pack.
const entry = async (name) => ({
  path: name,
  bytes: statSync(path.join(packDir, name)).size,
  sha256: await sha256(path.join(packDir, name)),
});

const files = {
  basemap: await entry('basemap.pmtiles'),
  search: await entry('search.sqlite'),
  routing: await entry('valhalla.tar'),
  assets: await entry('assets.zip'),
};
// Both optional by design: a region with no road data ships no nvdb.sqlite, and
// a source with no outdoor overlay ships no outdoor.pmtiles. Absent means the
// app falls back, not that the pack is broken.
if (existsSync(path.join(packDir, 'nvdb.sqlite'))) files.nvdb = await entry('nvdb.sqlite');
if (existsSync(path.join(packDir, 'outdoor.pmtiles')))
  files.outdoor = await entry('outdoor.pmtiles');

const builtAt = Date.now();
const manifest = {
  id: plan.region.id,
  name: plan.region.name,
  bbox: plan.region.bbox,
  // Milliseconds keep published versions monotonic with partial pack refreshes
  // (refresh-outdoor.sh) while staying an opaque comparable number to clients.
  // A seconds value after one of those refreshes would look older.
  version: builtAt,
  builtAt,
  compat: { schema: PACK_SCHEMA_VERSION, minRuntime: PACK_RUNTIME_REGION },
  provenance: {
    spec: { source: plan.source, region: plan.region.id, sha256: plan.spec.sha256 },
    builder: plan.builder,
    // The OSM extract's replication timestamp is the one input vintage that is
    // not a file mtime: it says when the *data* was current, not when this host
    // happened to download it.
    ...(plan.osmReplication ? { osmReplication: plan.osmReplication } : {}),
    inputs: plan.inputs,
    tools: plan.tools,
  },
  files,
};
writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(manifest, null, 2));
console.log(
  `    ${manifest.id} v${manifest.version}: ${Object.keys(files).join(', ')} ` +
    `from ${plan.source} (spec ${plan.spec.sha256.slice(0, 12)})`,
);
