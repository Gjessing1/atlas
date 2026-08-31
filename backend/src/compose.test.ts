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
    // all: no admin DB, no pack.
    expect(packBuilder).toContain('--mjolnir-admin /master/admins.sqlite');
    expect(packBuilder).not.toContain('--mjolnir-data-processing-use-admin-db false');
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
