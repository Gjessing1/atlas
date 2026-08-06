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
  it('keep Norway and Sweden on Valhalla’s right-driving fallback', () => {
    const entrypoint = readFileSync(
      path.join(repoRoot, 'infrastructure/valhalla/entrypoint.sh'),
      'utf8',
    );
    const packBuilder = readFileSync(
      path.join(repoRoot, 'infrastructure/packs/build-pack.sh'),
      'utf8',
    );

    // Geofabrik's regional extracts do not contain complete country-boundary
    // relations. An admin DB built from them silently assigned the dummy
    // left-driving admin, making Valhalla count the wrong side of roundabouts.
    for (const script of [entrypoint, packBuilder]) {
      expect(script).toContain('--mjolnir-data-processing-use-admin-db false');
      expect(script).not.toContain('--mjolnir-admin');
    }
    expect(entrypoint).not.toContain('valhalla_build_admins');
  });
});
