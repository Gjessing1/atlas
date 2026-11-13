#!/usr/bin/env node
// Read ../e2e/README.md first. Run inside the matching Playwright container.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { TOUR } from './play-review-tour.mjs';
import { runStep, SIZES, stableScreenshot, waitForMap } from './play-review-steps.mjs';
import { writeReport } from './play-review-report.mjs';

const { values } = parseArgs({
  options: {
    tour: { type: 'boolean' },
    only: { type: 'string' },
    screen: { type: 'string' },
    size: { type: 'string', default: 'desktop' },
    out: { type: 'string' },
    url: { type: 'string', default: 'http://127.0.0.1:3100' },
    landscape: { type: 'boolean' },
    list: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(`node apps/web/scripts/play-review.mjs --tour --size phone,tablet,desktop --out /tmp/review
  --url http://127.0.0.1:3100  running Atlas backend + web (no server is started)
  --only Map,Settings        select areas for a tour
  --screen Map/home          capture one predefined screen (default)
  --size phone-small|phone|tablet|desktop|all (or comma-separated)
  --landscape                swap portrait viewport dimensions
  --list                     list the tour without launching a browser
Outputs PNGs, manifest.json, index.html and REVIEW.md in a NEW/EMPTY folder.
Fresh isolated Chromium contexts; no personal browser profile is accessed.`);
  process.exit(0);
}
const catalog = TOUR.flatMap(({ area, screens }) =>
  screens.map((s) => ({ ...s, area, id: `${area}/${s.name}` })),
);
if (values.list) {
  console.log(catalog.map((s) => `${s.id}\t${s.title}`).join('\n'));
  process.exit(0);
}
if (values.tour && values.screen) throw new Error('Choose --tour or --screen');
if (values.only && !values.tour) throw new Error('--only requires --tour');
const sizes = [...new Set(values.size === 'all' ? Object.keys(SIZES) : values.size.split(','))];
if (sizes.some((size) => !SIZES[size]))
  throw new Error(`Unknown size; use ${Object.keys(SIZES).join(', ')} or all`);
const only = values.only?.split(',').map((a) => a.trim().toLowerCase());
if (only?.some((a) => !TOUR.some((t) => t.area.toLowerCase() === a)))
  throw new Error(`Unknown area; use ${TOUR.map((t) => t.area).join(', ')}`);
const selected = values.tour
  ? catalog.filter((s) => !only || only.includes(s.area.toLowerCase()))
  : catalog.filter((s) => s.id.toLowerCase() === (values.screen ?? 'Map/home').toLowerCase());
if (!selected.length) throw new Error('No screens selected; see --list');
const origin = new URL(values.url);
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
  throw new Error('Use an HTTP(S) Atlas URL without embedded credentials');
const health = await fetch(new URL('/api/health', origin), {
  signal: AbortSignal.timeout(10_000),
}).then((r) => r.json());
if (health.app !== 'Atlas') throw new Error('The URL does not serve an Atlas backend');
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), 'atlas-web-review-'));
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error(`Output folder must be empty: ${out}`);
const git = (...args) =>
  spawnSync('git', args, {
    cwd: resolve(import.meta.dirname, '../../..'),
    encoding: 'utf8',
  }).stdout?.trim();
const planned = sizes.flatMap((size) =>
  selected.map((s) => {
    const dimensions = SIZES[size];
    const viewport =
      values.landscape && dimensions.height > dimensions.width
        ? { width: dimensions.height, height: dimensions.width }
        : dimensions;
    const orientation = viewport.width > viewport.height ? 'landscape' : 'portrait';
    return {
      ...s,
      size,
      viewport,
      orientation,
      file: `${s.area}/${s.name}-${size}-${orientation}.png`,
    };
  }),
);
const manifest = {
  schemaVersion: 1,
  platform: 'web',
  generatedAt: new Date().toISOString(),
  command: process.argv.slice(2),
  origin: origin.origin,
  deployedSha: health.gitSha,
  checkout: { sha: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) },
  sizes: Object.fromEntries(
    sizes.map((size) => [
      size,
      { size: `${SIZES[size].width}x${SIZES[size].height}`, density: 160 },
    ]),
  ),
  planned: planned.map(({ id, size, orientation, file }) => ({ id, size, orientation, file })),
  screens: [],
  gaps: [],
};
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
const check = () => {
  if (interrupted) throw new Error('Review interrupted');
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
let browser;
try {
  await writeReport(out, manifest);
  const { chromium } = await import('@playwright/test');
  browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false });
  manifest.browser = browser.version();
  for (const screen of planned) {
    check();
    const context = await browser.newContext({
      viewport: screen.viewport,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'en-GB',
      timezoneId: 'Europe/Oslo',
    });
    // One page per context: OPFS owns exclusive file handles. Each screen gets an empty library.
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', (error) => {
      if (errors.length < 30) errors.push(error.message);
    });
    await mkdir(dirname(join(out, screen.file)), { recursive: true });
    try {
      await page.goto(new URL('/#map=12/59.91/10.75', origin).href, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      const mapReady = await waitForMap(page);
      await page.getByRole('button', { name: 'Collections', exact: true }).waitFor();
      for (const step of screen.steps) await runStep(page, step);
      if (screen.expect) await page.locator(screen.expect).waitFor({ state: 'visible' });
      await page.evaluate(() => document.fonts.ready);
      const { png, settled } = await stableScreenshot(page, check);
      await writeFile(join(out, screen.file), png);
      manifest.screens.push({
        id: screen.id,
        area: screen.area,
        screen: screen.name,
        title: screen.title,
        size: screen.size,
        orientation: screen.orientation,
        file: screen.file,
        note: screen.note,
        viewport: screen.viewport,
        steps: screen.steps,
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        sha256: createHash('sha256').update(png).digest('hex'),
        settled: settled && mapReady,
        mapReady,
        errors,
        capturedAt: new Date().toISOString(),
      });
      console.log(`${settled && mapReady ? '✓' : '~ unsettled'} ${screen.file}`);
    } catch (error) {
      manifest.gaps.push({
        id: screen.id,
        size: screen.size,
        file: screen.file,
        error: error.message,
      });
      process.exitCode = 1;
      console.error(`✗ ${screen.file}: ${error.message}`);
      await page
        .screenshot({
          path: join(out, screen.file.replace(/\.png$/, '.failed.png')),
          timeout: 5000,
        })
        .catch(() => {});
      await writeFile(
        join(out, 'failure.txt'),
        `${error.stack}\nScreen: ${screen.id}, ${screen.size}\n`,
      );
      check();
    } finally {
      await context.close();
    }
    await writeReport(out, manifest);
  }
} catch (error) {
  process.exitCode = 1;
  manifest.stopped = error.message;
  console.error(error.message);
} finally {
  try {
    await browser?.close();
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    const attempted = new Set([...manifest.screens, ...manifest.gaps].map((s) => s.file));
    manifest.gaps.push(
      ...manifest.planned
        .filter((s) => !attempted.has(s.file))
        .map((s) => ({ ...s, error: 'Not reached; run stopped early' })),
    );
    await writeReport(out, manifest);
    console.log(`${manifest.screens.length} captures, ${manifest.gaps.length} gaps → ${out}`);
  }
}
