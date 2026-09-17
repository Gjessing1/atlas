#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGE = 'io.gjessing.atlas';
const EXPECTED_AVD = 'atlas_test';
const resetApp = process.argv.includes('--reset-app');
const sdkRoot = process.env.ANDROID_HOME ?? join(homedir(), 'android-sdk');
const adb = process.env.ADB ?? join(sdkRoot, 'platform-tools', 'adb');
const artifactsDir = resolve(import.meta.dirname, 'artifacts');

function command(args, options = {}) {
  const encoding = Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8';
  const result = spawnSync(adb, args, {
    encoding,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: options.stdio ?? 'pipe',
  });
  if (result.error || result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : result.stderr;
    const detail = result.error?.message ?? stderr ?? `exit ${result.status}`;
    throw new Error(`adb ${args.join(' ')} failed: ${detail}`);
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : result.stdout;
}

function shell(...args) {
  return command(['shell', ...args]);
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(label, read, accept, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = read();
    if (accept(value)) return value;
    await delay(750);
  }
  const lastValue =
    typeof value === 'string' && value.length > 500
      ? `${value.slice(0, 500)}… (${value.length} characters)`
      : JSON.stringify(value);
  throw new Error(`Timed out waiting for ${label}; last value was ${lastValue}`);
}

function hierarchy() {
  shell('uiautomator', 'dump', '/sdcard/atlas-smoke-window.xml');
  return command(['exec-out', 'cat', '/sdcard/atlas-smoke-window.xml']);
}

function nodeForId(xml, id) {
  return xml.match(new RegExp(`<node[^>]*resource-id="${id}"[^>]*/?>`))?.[0] ?? null;
}

async function waitForId(id, present = true, timeoutMs) {
  return waitFor(
    `${id} to be ${present ? 'visible' : 'absent'}`,
    hierarchy,
    (xml) => Boolean(nodeForId(xml, id)) === present,
    timeoutMs,
  );
}

function tapId(xml, id) {
  const node = nodeForId(xml, id);
  const match = node?.match(/bounds="\[(\d+),(\d+)]\[(\d+),(\d+)]"/);
  if (!match) throw new Error(`Cannot tap missing or unbounded node ${id}`);
  const [, left, top, right, bottom] = match.map(Number);
  shell(
    'input',
    'tap',
    String(Math.round((left + right) / 2)),
    String(Math.round((top + bottom) / 2)),
  );
}

function expectIds(xml, ids) {
  const missing = ids.filter((id) => !nodeForId(xml, id));
  if (missing.length > 0) throw new Error(`Missing UI controls: ${missing.join(', ')}`);
}

function rotation() {
  return Number(hierarchy().match(/<hierarchy rotation="(\d+)"/)?.[1] ?? -1);
}

function saveArtifacts(error) {
  mkdirSync(artifactsDir, { recursive: true });
  const xml = hierarchy();
  writeFileSync(join(artifactsDir, 'window.xml'), xml);
  const screenshot = command(['exec-out', 'screencap', '-p'], { encoding: null });
  writeFileSync(join(artifactsDir, 'failure.png'), screenshot);
  writeFileSync(join(artifactsDir, 'failure.txt'), `${error.stack ?? error}\n`);
}

async function main() {
  command(['wait-for-device'], { timeout: 120_000 });
  await waitFor(
    'Android boot completion',
    () => shell('getprop', 'sys.boot_completed'),
    (v) => v === '1',
    120_000,
  );

  const avd = shell('getprop', 'ro.boot.qemu.avd_name');
  if (avd !== EXPECTED_AVD) {
    throw new Error(
      `Refusing to test ${avd || 'an unidentified device'}; expected ${EXPECTED_AVD}`,
    );
  }
  if (!shell('pm', 'list', 'packages', PACKAGE).includes(`package:${PACKAGE}`)) {
    throw new Error(`${PACKAGE} is not installed on ${EXPECTED_AVD}`);
  }

  shell('settings', 'put', 'system', 'accelerometer_rotation', '0');
  shell('settings', 'put', 'system', 'user_rotation', '0');
  shell('input', 'keyevent', 'KEYCODE_WAKEUP');
  shell('wm', 'dismiss-keyguard');

  if (resetApp) {
    shell('pm', 'clear', PACKAGE);
    for (const permission of [
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.POST_NOTIFICATIONS',
    ]) {
      const grant = spawnSync(adb, ['shell', 'pm', 'grant', PACKAGE, permission], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (grant.status !== 0 && !grant.stderr.includes('not a changeable permission type')) {
        throw new Error(`Could not grant ${permission}: ${grant.stderr.trim()}`);
      }
    }
  }

  shell('am', 'force-stop', PACKAGE);
  shell('am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`);
  let xml = await waitForId('open-menu', true, 60_000);
  expectIds(xml, ['search-open', 'map-profile-toggle', 'layer-quick-toggle', 'locate']);

  tapId(xml, 'open-menu');
  xml = await waitForId('main-menu-sheet');
  expectIds(xml, [
    'open-explore',
    'open-favorites',
    'open-layers',
    'open-measure',
    'open-commute',
    'open-settings',
  ]);
  shell('input', 'keyevent', 'KEYCODE_BACK');
  await waitForId('main-menu-sheet', false);

  xml = await waitForId('search-open');
  tapId(xml, 'search-open');
  xml = await waitForId('search-sheet');
  expectIds(xml, ['search-input', 'search-close']);
  if (rotation() !== 0) throw new Error('Search did not open in portrait');

  shell('settings', 'put', 'system', 'user_rotation', '1');
  await waitFor('landscape rotation', rotation, (value) => value === 1, 20_000);
  xml = await waitForId('search-input');
  if (!nodeForId(xml, 'search-sheet')) throw new Error('Search sheet disappeared in landscape');
  if (!xml.includes(`package="${PACKAGE}"`)) throw new Error('Search left Atlas in landscape');
  tapId(xml, 'search-close');
  await waitForId('search-sheet', false);

  shell('settings', 'put', 'system', 'user_rotation', '0');
  await waitFor('portrait rotation', rotation, (value) => value === 0, 20_000);
  console.log('Android smoke passed: boot, six map controls, menu, and portrait/landscape search.');
}

try {
  await main();
} catch (error) {
  try {
    saveArtifacts(error);
  } catch (artifactError) {
    console.error(`Could not save failure artifacts: ${artifactError.message}`);
  }
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  try {
    shell('settings', 'put', 'system', 'user_rotation', '0');
  } catch {
    // The emulator may have stopped; the original failure is more useful.
  }
}
