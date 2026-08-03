#!/usr/bin/env node
// Build every @atlas/* package with one incremental `tsc -b`.
//
// Ordering is derived from each package's own `@atlas/*` dependencies — NOT a
// hand-maintained wave list. npm does not topologically sort `-w`, so a new
// package that another one imports would be built too late (or a stale dist/
// would mask it locally while a clean build fails). Reading the graph here
// means adding a package needs no edit to any ordering: drop it in packages/,
// declare its deps, done.
//
// The same graph is the source of truth for the `references` array in every
// workspace tsconfig, which is what makes the build incremental: composite
// projects let `tsc -b` skip a package whose inputs have not changed, and
// references are how tsc learns that @atlas/gpx must be rechecked when
// @atlas/core's types move. Those arrays are verified on every build and
// rewritten by `npm run build:packages -- --fix`, so they can never drift from
// package.json.
//
// Flags: --fix (write stale references instead of failing), --force (rebuild
// everything, ignoring the up-to-date checks).
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');
const fix = process.argv.includes('--fix');
const force = process.argv.includes('--force');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
// tsconfigs are allowed to carry comments (packages/storage's explains its DOM
// lib), so parse them leniently — and never rewrite one, because a rewrite
// would drop exactly those comments.
const stripComments = (text) =>
  text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) =>
    m.startsWith('"') ? m : '',
  );
const readTsconfig = (path) => JSON.parse(stripComments(readFileSync(path, 'utf8')));
const atlasDepsOf = (manifest) =>
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((d) =>
    d.startsWith('@atlas/'),
  );

// Every workspace tsc compiles: the packages themselves plus the two apps that
// consume them (their references keep `tsc -b` honest about stale dists too).
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, 'package.json')))
  .map((e) => join('packages', e.name));
const workspaceDirs = [...packageDirs, 'backend', 'apps/web'].filter((d) =>
  existsSync(join(root, d, 'tsconfig.json')),
);

// name -> { dir, atlasDeps }
const byName = new Map();
for (const dir of workspaceDirs) {
  const manifest = readJson(join(root, dir, 'package.json'));
  byName.set(manifest.name, { name: manifest.name, dir, atlasDeps: atlasDepsOf(manifest) });
}

// Topological sort (depth-first) so each package builds after the @atlas/*
// packages it imports. Only edges to packages that live here count.
const ordered = [];
const state = new Map(); // name -> 'visiting' | 'done'
const visit = (name) => {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'visiting') {
    throw new Error(`Cyclic @atlas dependency involving ${name}`);
  }
  state.set(name, 'visiting');
  for (const dep of byName.get(name)?.atlasDeps ?? []) {
    if (byName.has(dep)) visit(dep);
  }
  state.set(name, 'done');
  ordered.push(name);
};
for (const name of byName.keys()) visit(name);

// --- tsconfig references + build state, derived from the dependency graph ----
const stale = [];
for (const { dir, atlasDeps } of byName.values()) {
  const expected = atlasDeps
    .filter((dep) => byName.has(dep))
    .map((dep) => relative(join(root, dir), join(root, byName.get(dep).dir)).replaceAll('\\', '/'))
    .sort();
  const configPath = join(root, dir, 'tsconfig.json');
  const config = readTsconfig(configPath);
  const actual = (config.references ?? []).map((r) => r.path).sort();
  // `.tsbuildinfo` must live inside outDir. Left at its default it sits beside
  // the tsconfig and outlives the outputs it describes: delete dist/ (or let
  // .dockerignore drop it from a build context) and `tsc -b` reads the orphaned
  // state, calls every package up to date, emits nothing — and the first package
  // whose state *was* inside dist/ then fails with "Cannot find module
  // '@atlas/core'". That is a silently skipped build, so it is checked here.
  const outDir = config.compilerOptions?.outDir;
  const wantInfo = outDir ? `${outDir}/tsconfig.tsbuildinfo` : undefined;
  const haveInfo = config.compilerOptions?.tsBuildInfoFile;
  const referencesOk = actual.join('\0') === expected.join('\0');
  const infoOk = !wantInfo || haveInfo === wantInfo;
  if (referencesOk && infoOk) continue;
  // Only a comment-free tsconfig can be regenerated safely; the rest are quoted
  // back to the developer instead.
  let rewritable = true;
  try {
    readJson(configPath);
  } catch {
    rewritable = false;
  }
  if (!fix || !rewritable) {
    if (!referencesOk) {
      const wanted = JSON.stringify(expected.map((path) => ({ path })));
      stale.push(`  ${dir}/tsconfig.json: "references" should be ${wanted}`);
    }
    if (!infoOk) {
      stale.push(`  ${dir}/tsconfig.json: "tsBuildInfoFile" should be "${wantInfo}"`);
    }
    continue;
  }
  if (expected.length === 0) delete config.references;
  else config.references = expected.map((path) => ({ path }));
  if (wantInfo) config.compilerOptions.tsBuildInfoFile = wantInfo;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`fixed tsconfig: ${dir}/tsconfig.json`);
}
if (stale.length > 0) {
  console.error(
    `tsconfig references do not match package.json dependencies:\n${stale.join('\n')}\n` +
      'Run `npm run build:packages -- --fix` (then `npm run format`).',
  );
  process.exit(1);
}

// One `tsc -b` for the whole tree: it reuses a single program per project and
// skips the ones already up to date, where twelve separate `tsc` invocations
// each started cold (6.5 min a run, no matter how little had changed).
const dirs = ordered.map((n) => byName.get(n).dir).filter((d) => packageDirs.includes(d));
console.log('build order:', dirs.join(' -> '));
const tsc = join(root, 'node_modules', '.bin', 'tsc');
try {
  execFileSync(tsc, ['-b', ...dirs, ...(force ? ['--force'] : [])], {
    stdio: 'inherit',
    cwd: root,
  });
} catch (err) {
  // tsc already printed the diagnostics; a node stack trace on top only buries them.
  process.exit(err.status ?? 1);
}
