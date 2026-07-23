#!/usr/bin/env node
// Build every @atlas/* package in dependency order, derived from each package's
// own `@atlas/*` dependencies — NOT a hand-maintained wave list. npm does not
// topologically sort `-w`, so a new package that another one imports would be
// built too late (or a stale dist/ would mask it locally while a clean build
// fails). Reading the graph here means adding a package needs no edit to any
// ordering: drop it in packages/, declare its deps, done.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');

// name -> { name, atlasDeps: string[] } for every workspace package under packages/.
const pkgs = new Map();
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(packagesDir, entry.name, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const atlasDeps = Object.keys(deps).filter((d) => d.startsWith('@atlas/'));
  pkgs.set(manifest.name, { name: manifest.name, atlasDeps });
}

// Topological sort (Kahn-ish via depth-first) so each package builds after the
// @atlas/* packages it imports. Only edges to packages that live here count.
const ordered = [];
const state = new Map(); // name -> 'visiting' | 'done'
const visit = (name) => {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'visiting') {
    throw new Error(`Cyclic @atlas dependency involving ${name}`);
  }
  state.set(name, 'visiting');
  for (const dep of pkgs.get(name)?.atlasDeps ?? []) {
    if (pkgs.has(dep)) visit(dep);
  }
  state.set(name, 'done');
  ordered.push(name);
};
for (const name of pkgs.keys()) visit(name);

console.log('build order:', ordered.join(' -> '));
for (const name of ordered) {
  execFileSync('npm', ['run', 'build', '-w', name], { stdio: 'inherit', cwd: root });
}
