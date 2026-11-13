#!/usr/bin/env node
// Read ../e2e/README.md first. Drives an already installed Atlas on a running atlas_test AVD.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { APP, createDevice, nodes, SIZES } from './play-review-steps.mjs';
import { TOUR } from './play-review-tour.mjs';
import { writeReport } from './play-review-report.mjs';

const { values } = parseArgs({
  options: {
    tour: { type: 'boolean' },
    only: { type: 'string' },
    screen: { type: 'string' },
    size: { type: 'string', default: 'phone' },
    out: { type: 'string' },
    serial: { type: 'string', default: process.env.ANDROID_SERIAL ?? 'emulator-5554' },
    landscape: { type: 'boolean' },
    probe: { type: 'boolean' },
    list: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(`node apps/android/scripts/play-review.mjs --tour --size phone --out /tmp/review
  --size phone-small|phone|phone-large|tablet|all (or comma-separated)
  --only Map,Settings     select areas for a tour
  --screen Map/home      capture one predefined screen (default)
  --landscape            capture in landscape instead of portrait
  --serial emulator-5554  choose a running atlas_test emulator
  --probe                print native controls after the selected screen's actions
  --list                 list the tour without a device
Outputs PNG + XML, manifest.json, index.html and REVIEW.md in a NEW/EMPTY folder.
Read apps/android/e2e/README.md first. Never share the device with another driver.`);
  process.exit(0);
}
const catalog = TOUR.flatMap(({ area, screens }) =>
  screens.map((screen) => ({ ...screen, area, id: `${area}/${screen.name}` })),
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
if (!/^emulator-\d+$/.test(values.serial))
  throw new Error('Use a dedicated atlas_test emulator, not a personal device');
const device = createDevice(values.serial);
const avd = device.shell('getprop', 'ro.boot.qemu.avd_name');
if (avd !== 'atlas_test') throw new Error(`Expected atlas_test; ${values.serial} is ${avd}`);
if (!device.shell('pm', 'path', APP).startsWith('package:'))
  throw new Error('Atlas must already be installed; see the Android runbook');
// Reviews and regression both drive native input. Refuse known competing drivers on this host.
const processes = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '';
if (
  processes
    .split('\n')
    .some(
      (line) =>
        /^\s*\d+\s+(?:\S*\/)?node\s+\S*(?:regression|play-review|storage-proof-device)\.mjs\b/.test(
          line,
        ) &&
        !line.includes('/web/') &&
        Number(line.trim().split(/\s+/)[0]) !== process.pid,
    )
) {
  throw new Error('Another Android driver is running; use the emulator exclusively');
}
const lockPath = join(tmpdir(), `atlas-review-${values.serial}.lock`);
let lock;
try {
  lock = await open(lockPath, 'wx');
} catch (error) {
  if (error.code === 'EEXIST')
    throw new Error(
      `Device review lock exists: ${lockPath}; check its PID before removing a stale lock`,
    );
  throw error;
}
let original;
let out;
let manifest;
const interrupt = () => device.interrupt();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  await lock.writeFile(`${process.pid}\n`);
  out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), 'atlas-review-'));
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length)
    throw new Error(
      `Output folder must be empty: ${out}; use a new folder to avoid stale screenshots`,
    );
  const git = (...args) =>
    spawnSync('git', args, {
      cwd: resolve(import.meta.dirname, '../../..'),
      encoding: 'utf8',
    }).stdout?.trim();
  original = device.snapshot();
  const orientation = values.landscape ? 'landscape' : 'portrait';
  const planned = sizes.flatMap((size) =>
    selected.map((s) => ({
      ...s,
      size,
      orientation,
      file: `${s.area}/${s.name}-${size}-${orientation}.png`,
    })),
  );
  manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: process.argv.slice(2),
    checkout: { sha: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) },
    device: {
      serial: values.serial,
      avd,
      app: APP,
      android: device.shell('getprop', 'ro.build.version.release'),
      apkVersion: device.shell('dumpsys', 'package', APP).match(/versionName=(\S+)/)?.[1],
    },
    originalDisplay: original,
    sizes: Object.fromEntries(sizes.map((size) => [size, SIZES[size]])),
    planned: planned.map(({ id, size, orientation, file }) => ({ id, size, orientation, file })),
    screens: [],
    gaps: [],
    restoreErrors: [],
  };
  await writeReport(out, manifest);
  let lastSize;
  for (const screen of planned) {
    device.check();
    if (lastSize !== screen.size) {
      device.configure(SIZES[screen.size], values.landscape);
      lastSize = screen.size;
    }
    await mkdir(dirname(join(out, screen.file)), { recursive: true });
    try {
      await device.launch();
      for (const step of screen.steps) await device.runStep(step);
      if (screen.expect) await device.runStep({ wait: screen.expect });
      const xml = device.hierarchy();
      if (values.probe)
        console.log(
          JSON.stringify({ id: screen.id, size: screen.size, controls: nodes(xml) }, null, 2),
        );
      const { png, settled } = await device.stableScreenshot();
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error('screencap did not return a PNG');
      await writeFile(join(out, screen.file), png);
      await writeFile(join(out, screen.file.replace(/\.png$/, '.xml')), xml);
      manifest.screens.push({
        id: screen.id,
        area: screen.area,
        screen: screen.name,
        title: screen.title,
        size: screen.size,
        orientation,
        file: screen.file,
        note: screen.note,
        steps: screen.steps,
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        sha256: createHash('sha256').update(png).digest('hex'),
        settled,
        capturedAt: new Date().toISOString(),
      });
      console.log(`${settled ? '✓' : '~ unsettled'} ${screen.file}`);
    } catch (error) {
      const gap = { id: screen.id, size: screen.size, file: screen.file, error: error.message };
      manifest.gaps.push(gap);
      console.error(`✗ ${screen.file}: ${error.message}`);
      // Keep the actual failed state, including system dialogs, without labelling it a review screen.
      try {
        await writeFile(
          join(out, screen.file.replace(/\.png$/, '.failed.png')),
          device.adb('exec-out', 'screencap', '-p'),
        );
      } catch {
        /* device may have disconnected */
      }
      try {
        await writeFile(
          join(out, screen.file.replace(/\.png$/, '.failed.xml')),
          device.hierarchy({ requireApp: false, checkInterrupt: false }),
        );
      } catch {
        /* keep the original error */
      }
      await writeFile(
        join(out, 'failure.txt'),
        `${error.stack}\nScreen: ${screen.id}, ${screen.size}\n`,
      );
      process.exitCode = 1;
      device.check();
      if (device.adb('get-state').toString().trim() !== 'device')
        throw new Error('Emulator disconnected');
    }
    await writeReport(out, manifest);
  }
} catch (error) {
  process.exitCode = 1;
  if (manifest) manifest.stopped = error.message;
  console.error(error.message);
} finally {
  if (original) {
    const errors = device.restore(original);
    if (manifest) manifest.restoreErrors = errors;
    if (errors.length) {
      process.exitCode = 1;
      console.error(`Display restoration failed: ${errors.join('; ')}`);
    }
  }
  try {
    if (manifest) {
      const attempted = new Set([...manifest.screens, ...manifest.gaps].map((s) => s.file));
      manifest.gaps.push(
        ...manifest.planned
          .filter((s) => !attempted.has(s.file))
          .map((s) => ({ ...s, error: 'Not reached; run stopped early' })),
      );
      await writeReport(out, manifest);
      console.log(`${manifest.screens.length} captures, ${manifest.gaps.length} gaps → ${out}`);
    }
  } finally {
    device.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await lock.close();
    await unlink(lockPath);
    // An unused temporary output directory can remain empty after an early validation failure.
    if (!values.out && out && !manifest) await rmdir(out).catch(() => {});
  }
}
