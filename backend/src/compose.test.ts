import { parseRegionBuildSpec } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository-root compose example is documentation that can rot silently:
 * it kept setting GRAPHHOPPER_URL for a release after the backend had moved to
 * Valhalla, so `docker compose up` produced a healthy container whose routing
 * calls went to a nonexistent localhost default. Assert that every environment
 * variable it sets is one the backend actually reads.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function composeEnvKeys(): string[] {
  const yaml = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^\s+environment:\s*$/.test(l));
  expect(start, 'compose example has no environment: block').toBeGreaterThanOrEqual(0);
  const indent = /^(\s+)/.exec(lines[start + 1] ?? '')?.[1].length ?? 0;
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const depth = /^(\s*)/.exec(line)![1].length;
    if (depth < indent) break;
    const key = /^\s*([A-Z0-9_]+):/.exec(line)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

function backendEnvKeys(): Set<string> {
  const dir = path.join(repoRoot, 'backend/src');
  const keys = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const src = readFileSync(path.join(dir, name), 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
  }
  return keys;
}

describe('repository-root compose example', () => {
  it('only sets env vars the backend reads', () => {
    const read = backendEnvKeys();
    // NODE_ENV is consumed by the runtime/framework, not by our own code.
    const known = new Set([...read, 'NODE_ENV']);
    const unknown = composeEnvKeys().filter((k) => !known.has(k));
    expect(unknown, 'compose sets env vars nothing reads').toEqual([]);
  });

  it('points routing at the Valhalla service', () => {
    const yaml = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    expect(yaml).toMatch(/VALHALLA_URL:\s*http:\/\/atlas-valhalla:8002/);
  });
});

describe('regional Valhalla builds', () => {
  const entrypoint = readFileSync(
    path.join(repoRoot, 'infrastructure/valhalla/entrypoint.sh'),
    'utf8',
  );
  const packBuilder = readFileSync(
    path.join(repoRoot, 'infrastructure/packs/build-pack.sh'),
    'utf8',
  );
  const adminBuilder = readFileSync(
    path.join(repoRoot, 'infrastructure/valhalla/build-admins.sh'),
    'utf8',
  );
  const refreshOutdoor = readFileSync(
    path.join(repoRoot, 'infrastructure/packs/refresh-outdoor.sh'),
    'utf8',
  );
  const imageryBuilder = readFileSync(
    path.join(repoRoot, 'infrastructure/packs/build-imagery-pack.mjs'),
    'utf8',
  );

  // Roundabout exits are counted on the driving side, so the admin DB decides
  // whether "take the 2nd exit" is the 2nd exit. Measured on the Isle of Man,
  // two of three roundabouts on one route came out wrong without it — one of
  // them "1st exit" for what is really the 3rd. These tests pin the two ways
  // that has gone wrong, in both directions.
  it('never derive admins from the routing extracts', () => {
    // The original bug (384d847): country boundary relations are clipped in a
    // regional extract, so countries whose ring never closes get no polygon
    // and their roads inherit the default admin — which drives on the left.
    // That took out every road in Norway.
    expect(entrypoint).not.toContain('valhalla_build_admins');
    expect(packBuilder).not.toContain('valhalla_build_admins');
    // The admin builder is the only place that command belongs, and it reads
    // a continent-wide source rather than the tile extracts.
    expect(adminBuilder).toContain('valhalla_build_admins');
    expect(adminBuilder).toContain('boundary=administrative');
  });

  it('refuse to graph a left-driving country with no admin DB', () => {
    // The opposite bug, and the one that matters now that coverage includes
    // the British Isles: falling back to the right-driving default there is a
    // wrong-by-default deploy that still looks healthy.
    expect(entrypoint).toContain('admins.sqlite');
    for (const iso of ['great-britain', 'ireland', 'isle-of-man', 'guernsey-jersey']) {
      expect(entrypoint).toContain(iso);
    }
    // A pack is what the phone routes from abroad, so it gets no fallback at
    // all: no admin DB, no pack. The path comes from the region's spec (where
    // the database is a required input), never from a default here.
    expect(packBuilder).toContain('--mjolnir-admin /data/$REL_ADMINS');
    expect(packBuilder).not.toContain('--mjolnir-data-processing-use-admin-db false');
  });

  it('merge the coverage extracts into one file before building tiles', () => {
    // Valhalla warns that a multi-extract build is discouraged (valhalla#3925).
    // With ten of them it does not merely warn: neighbouring Geofabrik extracts
    // overlap at every border and the build core-dumped writing tiles on the
    // German/French border. The same area built cleanly from one merged file,
    // so the overlap is the fault rather than the data or the admin DB.
    expect(entrypoint).toContain('osmium merge');
    // Which needs the tool present in the image the entrypoint runs in.
    const dockerfile = readFileSync(
      path.join(repoRoot, 'infrastructure/valhalla/Dockerfile'),
      'utf8',
    );
    expect(dockerfile).toContain('osmium-tool');
  });

  it('build a pack only from a committed spec, with pinned tools', () => {
    // DR7: the producer used to derive its inputs from the region id and one
    // environment variable, and none of those rules were visible in the pack
    // they produced. Every input path now comes from specs/<source>.json, and
    // every tool image from tools.json — pinned by digest, because `:latest`
    // moves under a producer whose artifacts claim to record what cut them.
    expect(packBuilder).toContain('plan-pack.mjs');
    expect(packBuilder).not.toMatch(/ATLAS_PACK_SOURCE/);
    const tools = JSON.parse(
      readFileSync(path.join(repoRoot, 'infrastructure/tools.json'), 'utf8'),
    ) as Record<string, { image?: string; tag?: string }>;
    for (const [id, tool] of Object.entries(tools)) {
      if (id.startsWith('_')) continue;
      expect(tool.image, `${id} must be pinned by digest`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    // The routing engine is the one tool whose version is also a correctness
    // constraint: a pack routes on-device with the same engine the server runs,
    // so the two may never disagree about algorithms or data interpretation.
    expect(tools.valhalla!.image).toContain('valhalla');
    const serverImage = /FROM ghcr\.io\/valhalla\/valhalla:(\S+)/.exec(
      readFileSync(path.join(repoRoot, 'infrastructure/valhalla/Dockerfile'), 'utf8'),
    )?.[1];
    expect(serverImage).toBeTruthy();
    expect(tools.valhalla!.tag).toBe(`ghcr.io/valhalla/valhalla:${serverImage}`);
    // No script may reach for a floating tag of its own any more.
    const basemapBuilder = readFileSync(
      path.join(repoRoot, 'infrastructure/tiles/build-basemap.sh'),
      'utf8',
    );
    const outdoorBuilder = readFileSync(
      path.join(repoRoot, 'infrastructure/tiles/build-outdoor.sh'),
      'utf8',
    );
    for (const [name, script] of Object.entries({
      packBuilder,
      refreshOutdoor,
      imageryBuilder,
      basemapBuilder,
      outdoorBuilder,
    })) {
      expect(script, `${name} pins its images`).not.toMatch(/[a-z0-9/.-]+:latest/);
    }
    expect(adminBuilder).toContain("jq -er '.osmium.image'");
    expect(adminBuilder).toContain('$DATA_DIR/osm');
  });

  it('publish a pack only after its artifacts answer for themselves', () => {
    // Checksums prove a file arrived intact; they cannot tell an intact archive
    // of the wrong place from the right one. pack.json is what /api/regions
    // lists, so writing it IS publication — it happens after the smoke checks,
    // into a staging directory that is swapped in, so a failure leaves the
    // published pack untouched.
    const smoke = packBuilder.indexOf('smoke-pack.mjs');
    const manifest = packBuilder.indexOf('write-manifest.mjs');
    expect(smoke).toBeGreaterThan(0);
    expect(manifest).toBeGreaterThan(smoke);
    expect(packBuilder).toMatch(/mv "\$STAGE" "\$OUT"/);
    // The imagery pack follows the same order: smoke, then pack.json, then swap.
    const imagerySmoke = imageryBuilder.indexOf('smoke: the archive must draw');
    const imageryManifest = imageryBuilder.indexOf("path.join(stage, 'pack.json')");
    expect(imagerySmoke).toBeGreaterThan(0);
    expect(imageryManifest).toBeGreaterThan(imagerySmoke);
    expect(imageryBuilder.indexOf('renameSync(stage, out)')).toBeGreaterThan(imageryManifest);
    // …and reads its tool from tools.json like every other producer script.
    expect(imageryBuilder).toContain('tools.pmtiles.image');
  });

  it('specs cover every region the producer is asked to build', () => {
    // The specs are the whole list of what can be built, and they parse under
    // the same validator the producer runs — including the check that a region
    // lies inside what its masters cover, which is the one an empty archive
    // would otherwise hide until someone opened the pack offline.
    const dir = path.join(repoRoot, 'infrastructure/packs/specs');
    const specs = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(specs.sort()).toEqual(['great-britain.json', 'norway.json']);
    for (const name of specs) {
      const spec = parseRegionBuildSpec(
        JSON.parse(readFileSync(path.join(dir, name), 'utf8')),
        name,
      );
      expect(spec.id, `${name} is named after its source`).toBe(name.replace('.json', ''));
      // Britain drives on the left, which is a property of the admin database
      // alone: a spec that made it optional would publish a pack numbering
      // every roundabout off the wrong side of the road.
      expect(spec.inputs.admins.required).toBe(true);
    }
  });

  it('verify the admin DB before installing it, against every left-driving country', () => {
    // A present-but-wrong DB is the failure mode neither guard above catches,
    // and it stays invisible until someone drives a roundabout in the wrong
    // country. Europe's left-driving countries are a closed list — the UK and
    // its Crown Dependencies, Ireland, Malta, Cyprus — so the builder asserts
    // the whole list rather than trusting the build.
    for (const iso of ['GB', 'IE', 'IM', 'JE', 'GG', 'MT', 'CY']) {
      expect(adminBuilder).toContain(`'${iso}'`);
    }
    // ...and a sample that must come out right-driving, so a DB that simply
    // said "left" everywhere could not pass either.
    for (const iso of ['NO', 'SE', 'DK', 'DE', 'NL', 'BE']) {
      expect(adminBuilder).toContain(`'${iso}'`);
    }
    expect(adminBuilder).toContain('REJECTED');
  });
});

/**
 * Everything above compares files to files, and passes just as happily when
 * none of them has been deployed: the routing container is brought up by hand,
 * and a running container keeps serving off whatever image it started from. An
 * entrypoint change once sat live-in-the-repo and undeployed for three weeks
 * with nothing to show it. These pin the one mechanism that can see that — the
 * revision both images stamp — against the ways it would silently disarm.
 */
describe('the deployed routing service', () => {
  const at = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');
  const revisionScript = at('infrastructure/valhalla/revision.sh');
  const serviceDockerfile = at('infrastructure/valhalla/Dockerfile');
  const backendDockerfile = at('backend/Dockerfile');
  const entrypoint = at('infrastructure/valhalla/entrypoint.sh');
  const reader = at('backend/src/routing-revision.ts');

  it('computes the revision in exactly one place', () => {
    // Two Dockerfiles need the same number out of the same files. A formula
    // copied into both is one that gets edited in one of them and then reports
    // agreement forever, which is worse than having no check at all.
    expect(revisionScript).toContain('sha256sum');
    for (const [name, dockerfile] of Object.entries({ serviceDockerfile, backendDockerfile })) {
      expect(dockerfile, `${name} must call revision.sh`).toContain('revision.sh');
      expect(dockerfile, `${name} must not hash the files itself`).not.toContain('sha256sum');
    }
    // And over the files that decide what the service does — coverage above all,
    // since that is what the graph is built from.
    for (const file of ['Dockerfile', 'coverage.list', 'entrypoint.sh']) {
      expect(revisionScript).toContain(file);
    }
  });

  it('ships the expectation into the runtime image, not just the build stage', () => {
    // The quiet way to disarm this: compute the revision in the build stage and
    // never copy it out. The backend would then find no expectation, report
    // nothing, and look exactly like a healthy deployment forever.
    expect(backendDockerfile).toMatch(
      /COPY --from=build \/valhalla-revision \.\/backend\/valhalla-revision/,
    );
    // Read relative to dist/, so the path in the image and the path the code
    // opens are the same one.
    expect(reader).toContain("'../valhalla-revision'");
  });

  it('publishes the running build where the backend looks for it', () => {
    // The two containers meet only on the shared /mnt/data/atlas mount: the
    // router writes /data/deployed.json, the backend reads /data/valhalla/.
    expect(serviceDockerfile).toContain('/image-revision');
    expect(entrypoint).toContain('/image-revision');
    expect(entrypoint).toMatch(/> "\$DATA_DIR\/deployed\.json"/);
    expect(reader).toContain("path.join('valhalla', 'deployed.json')");
  });
});
