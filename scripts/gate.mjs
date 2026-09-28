#!/usr/bin/env node
// The pre-push quality gate: format → lint → build → typecheck → tests, with the
// two expensive parts made conditional on what actually changed.
//
// Why this exists: the gate used to run twice for every release — once locally
// inside `docker build`, once again in CI — and both runs paid for five raster
// test files that most releases never touch. That was ~40 minutes of serial
// waiting per release. Two rules cut it:
//
//   1. `*.slow.test.ts` (the potential raster models) run only when this change
//      touches the models, or when --slow is passed. CI's image build always
//      runs them (`npm run test:all`), so nothing is ever skipped on the path
//      that decides a deploy.
//   2. The local `docker build` only proves things the fast gate cannot: that
//      the *image* is assemblable and complete — a workspace missing from the
//      runtime stage, an uncommitted package-lock.json entry (the bug that
//      silently blocked two deploys before v0.129.0). Only a change to the
//      dependency/packaging surface can break that, so it runs only then.
//
// Usage: npm run gate [--slow] [--docker] [--no-docker] [--dry] [--since <ref>]
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const sinceArg = argv.indexOf('--since');
const since = sinceArg === -1 ? null : argv[sinceArg + 1];

const git = (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

// Everything this working tree would push: committed-but-unpushed, staged,
// unstaged, and untracked. With no upstream (fresh clone, a new branch, detached
// checkout) nothing is known to be pushed, so every tracked file counts. The old
// `HEAD~1` fallback saw only the last commit, and on a repo's single first
// commit saw nothing, skipping the docker build on exactly the first push.
const baseRef =
  since ?? git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) ?? '';
const changed = new Set(
  [
    baseRef ? git(['diff', '--name-only', `${baseRef}...HEAD`]) : git(['ls-files']),
    git(['diff', '--name-only', 'HEAD']),
    git(['ls-files', '--others', '--exclude-standard']),
  ]
    .join('\n')
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean),
);

// Packaging surface: what the image build proves and the fast gate cannot.
const imageRisk = [...changed].filter(
  (f) =>
    f === 'package-lock.json' ||
    f === '.dockerignore' ||
    f.endsWith('package.json') ||
    f.startsWith('backend/Dockerfile') ||
    f.startsWith('.forgejo/'),
);
// The raster models the slow tests cover.
const slowRisk = [...changed].filter(
  (f) =>
    f.startsWith('backend/src/potential/') ||
    f.startsWith('packages/potential/') ||
    f.endsWith('.slow.test.ts'),
);

const runSlow = has('--slow') || slowRisk.length > 0;
const runDocker = has('--docker') || (imageRisk.length > 0 && !has('--no-docker'));

const stages = [
  ['format:check', ['npm', ['run', 'format:check']]],
  ['lint', ['npm', ['run', 'lint']]],
  ['build', ['npm', ['run', 'build']]],
  ['typecheck', ['npm', ['run', 'typecheck']]],
  ['test', ['npm', ['test']]],
  ...(runSlow ? [['test:slow', ['npm', ['run', 'test:slow']]]] : []),
  ...(runDocker
    ? [['docker build', ['docker', ['build', '-f', 'backend/Dockerfile', '-t', 'atlas-gate', '.']]]]
    : []),
];

console.log(`gate: ${changed.size} changed file(s) vs ${baseRef || 'no upstream (whole tree)'}`);
console.log(
  runSlow
    ? `gate: slow tests INCLUDED (${slowRisk.slice(0, 3).join(', ')}${slowRisk.length > 3 ? ', …' : ''})`
    : 'gate: slow tests skipped (no potential-model change) — CI still runs them',
);
const imageVerdict = runDocker
  ? `gate: image build INCLUDED (${imageRisk.slice(0, 3).join(', ')}${imageRisk.length > 3 ? ', …' : ''})`
  : imageRisk.length > 0
    ? `gate: image build REQUIRED by ${imageRisk.length} packaging file(s) but skipped via --no-docker — only CI will prove the image`
    : 'gate: image build skipped (no dependency/packaging change) — CI still builds it';
console.log(imageVerdict);
// --dry answers "what would this run cost?" without spending it.
if (has('--dry')) {
  console.log(`gate: --dry, would run: ${stages.map(([name]) => name).join(' → ')}`);
  process.exit(0);
}

const timings = [];
for (const [name, [cmd, args]] of stages) {
  const started = Date.now();
  console.log(`\n=== ${name} ===`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
  } catch {
    const failed = ((Date.now() - started) / 1000).toFixed(0);
    console.error(`\ngate: FAILED at ${name} after ${failed}s`);
    process.exit(1);
  }
  timings.push([name, ((Date.now() - started) / 1000).toFixed(0)]);
}

const total = timings.reduce((sum, [, s]) => sum + Number(s), 0);
console.log('\ngate: PASSED');
for (const [name, seconds] of timings) console.log(`  ${name.padEnd(14)} ${seconds}s`);
console.log(`  ${'total'.padEnd(14)} ${total}s`);
if (!runDocker) console.log(`  (${imageVerdict.replace('gate: ', '')})`);
