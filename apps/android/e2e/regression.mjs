#!/usr/bin/env node

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGE = 'io.gjessing.atlas';
const EXPECTED_AVD = 'atlas_test';
const FIXTURE_ORIGIN = 'http://10.0.2.2:3199';
const sdkRoot = process.env.ANDROID_HOME ?? join(homedir(), 'android-sdk');
const adb = process.env.ADB ?? join(sdkRoot, 'platform-tools', 'adb');
const artifactsDir = resolve(import.meta.dirname, 'artifacts');

function command(args, options = {}) {
  const encoding = Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8';
  const result = spawnSync(adb, args, {
    encoding,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
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
    typeof value === 'string' && value.length > 800
      ? `${value.slice(0, 800)}… (${value.length} characters)`
      : JSON.stringify(value);
  throw new Error(`Timed out waiting for ${label}; last value was ${lastValue}`);
}

function hierarchy() {
  shell('uiautomator', 'dump', '/sdcard/atlas-regression-window.xml');
  return command(['exec-out', 'cat', '/sdcard/atlas-regression-window.xml']);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nodeForId(xml, id) {
  return xml.match(new RegExp(`<node[^>]*resource-id="${escapeRegex(id)}"[^>]*/?>`))?.[0] ?? null;
}

function nodeIds(xml) {
  return [...xml.matchAll(/resource-id="([^"]+)"/g)].map((match) => match[1]);
}

function boundsForNode(node) {
  const match = node?.match(/bounds="\[(\d+),(\d+)]\[(\d+),(\d+)]"/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function visibleNode(xml, id) {
  const node = nodeForId(xml, id);
  const bounds = boundsForNode(node);
  // React Native still exposes a node whose layout is almost entirely clipped
  // at a ScrollView edge (for example five pixels above the navigation bar).
  // That is present, but not a usable touch target.
  return node && bounds && bounds.width > 8 && bounds.height > 8 ? { node, bounds } : null;
}

async function waitForId(id, present = true, timeoutMs) {
  return waitFor(
    `${id} to be ${present ? 'visible' : 'absent'}`,
    hierarchy,
    (xml) => Boolean(visibleNode(xml, id)) === present,
    timeoutMs,
  );
}

async function waitForAppReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = hierarchy();
    if (visibleNode(xml, 'open-menu')) return xml;
    // The software-rendered test AVD can surface a transient SystemUI ANR when
    // the host is busy compiling. Waiting is the safe OS action; closing it
    // would kill the shell Atlas needs and turn host contention into a false
    // app regression.
    const wait = visibleNode(xml, 'android:id/aerr_wait');
    if (wait) {
      tapBounds(wait.bounds);
      await delay(1_000);
      continue;
    }
    await delay(750);
  }
  throw new Error('Timed out waiting for Atlas to become ready');
}

function tapBounds(bounds) {
  shell(
    'input',
    'tap',
    String(Math.round((bounds.left + bounds.right) / 2)),
    String(Math.round((bounds.top + bounds.bottom) / 2)),
  );
}

function tapId(xml, id) {
  const found = visibleNode(xml, id);
  if (!found) throw new Error(`Cannot tap missing or off-screen node ${id}`);
  tapBounds(found.bounds);
}

async function tap(id, timeoutMs = 45_000) {
  const xml = await waitForId(id, true, timeoutMs);
  tapId(xml, id);
}

function swipeWithin(bounds, direction) {
  const x = Math.round((bounds.left + bounds.right) / 2);
  const high = Math.round(bounds.top + bounds.height * 0.28);
  const low = Math.round(bounds.top + bounds.height * 0.76);
  shell(
    'input',
    'swipe',
    String(x),
    String(direction === 'up' ? low : high),
    String(x),
    String(direction === 'up' ? high : low),
    '350',
  );
}

async function tapAfterScroll(id, scrollerId, direction = 'up') {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const xml = hierarchy();
    const target = visibleNode(xml, id);
    if (target) {
      tapBounds(target.bounds);
      return;
    }
    const scroller = visibleNode(xml, scrollerId);
    if (!scroller) throw new Error(`Cannot scroll missing ${scrollerId} to reach ${id}`);
    swipeWithin(scroller.bounds, direction);
    await delay(400);
  }
  throw new Error(`Could not bring ${id} into view inside ${scrollerId}`);
}

async function focusAfterScroll(id, scrollerId, direction = 'up') {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const xml = hierarchy();
    const node = nodeForId(xml, id);
    const bounds = boundsForNode(node);
    if (node && bounds && bounds.width > 0 && bounds.height > 0) {
      tapBounds(bounds);
      return;
    }
    const scroller = visibleNode(xml, scrollerId);
    if (!scroller) throw new Error(`Cannot scroll missing ${scrollerId} to reach ${id}`);
    swipeWithin(scroller.bounds, direction);
    await delay(400);
  }
  throw new Error(`Could not focus ${id} inside ${scrollerId}`);
}

function expectIds(xml, ids) {
  const missing = ids.filter((id) => !nodeForId(xml, id));
  if (missing.length > 0) throw new Error(`Missing UI controls: ${missing.join(', ')}`);
}

function rotation() {
  return Number(hierarchy().match(/<hierarchy rotation="(\d+)"/)?.[1] ?? -1);
}

function keyboardShown() {
  const state = shell('dumpsys', 'input_method');
  return /mInputShown=true/.test(state) || /mImeWindowVis=0x[13]/.test(state);
}

async function dismissKeyboard() {
  if (!keyboardShown()) return;
  shell('input', 'keyevent', 'KEYCODE_BACK');
  await waitFor('software keyboard to close', keyboardShown, (shown) => !shown, 10_000);
}

async function replaceText(id, text, expectedText = text) {
  const xml = await waitForId(id);
  tapId(xml, id);
  shell('input', 'keyevent', 'KEYCODE_MOVE_END');
  shell('input', 'keyevent', ...Array.from({ length: 100 }, () => 'KEYCODE_DEL'));
  await delay(300);
  // React-controlled TextInputs can lose the first part of one fast `adb input
  // text` event while JS is reconciling it. Key characters individually so the
  // value observed by the app is the value the scenario asked for.
  for (const character of text) {
    if (character === ' ') shell('input', 'keyevent', 'KEYCODE_SPACE');
    else shell('input', 'text', character);
    await delay(80);
  }
  await waitFor(`${id} to contain ${expectedText}`, hierarchy, (next) => {
    const value = nodeForId(next, id)?.match(/text="([^"]*)"/)?.[1] ?? '';
    return value.toLocaleLowerCase().includes(expectedText.toLocaleLowerCase());
  });
}

async function openMenuItem(id) {
  await tap('open-menu');
  await waitForId('main-menu-sheet');
  await tap(id);
}

async function closeSettings() {
  let xml = hierarchy();
  if (visibleNode(xml, 'settings-back')) {
    tapId(xml, 'settings-back');
    xml = await waitFor(
      'settings section menu',
      hierarchy,
      (value) => !nodeForId(value, 'settings-back') && Boolean(nodeForId(value, 'settings-close')),
    );
  }
  tapId(xml, 'settings-close');
  await waitForId('settings-sheet', false);
}

async function configureFixtureServer() {
  await openMenuItem('open-settings');
  await waitForId('settings-sheet');
  await tapAfterScroll('settings-open-system', 'settings-sheet');
  await waitForId('server-origin');
  await replaceText('server-origin', FIXTURE_ORIGIN);
  await tap('server-save');
  await waitFor(
    'the fixture server to become the saved origin',
    hierarchy,
    (xml) => nodeForId(xml, 'server-origin')?.includes(`text="${FIXTURE_ORIGIN}"`) ?? false,
  );
  await closeSettings();
}

async function searchAndSavePlace() {
  await tap('search-open');
  await replaceText('search-input', 'saved');
  await waitForId('search-result-0', true, 20_000);
  await dismissKeyboard();
  await tap('search-result-0');
  await waitForId('destination-sheet');
  await dismissKeyboard();
  await tap('destination-save');
  await waitForId('destination-edit');
  await tap('destination-cancel');
}

function dynamicId(xml, pattern, label) {
  const result = nodeIds(xml).find((id) => pattern.test(id));
  if (!result) throw new Error(`Could not find ${label} in accessibility hierarchy`);
  return result;
}

async function createFolderAndReadPlace() {
  await openMenuItem('open-favorites');
  await waitForId('favorites-sheet');
  await replaceText('folder-new-name', 'regression folder');
  // Submit from the field itself. On Android a tap immediately after `input
  // text` can be consumed by the IME dismissal even though the button's
  // accessibility bounds are already back in place.
  shell('input', 'keyevent', 'KEYCODE_ENTER');
  const xml = await waitFor(
    'saved place and folder rows',
    hierarchy,
    (value) =>
      nodeIds(value).some((id) => /^folder-row-[0-9a-f-]+$/i.test(id)) &&
      nodeIds(value).some((id) => /^favorite-(?!style-|visible-|edit-|nav-)[0-9a-f-]+$/i.test(id)),
  );
  return {
    folderId: dynamicId(xml, /^folder-row-[0-9a-f-]+$/i, 'folder row').slice('folder-row-'.length),
    placeId: dynamicId(
      xml,
      /^favorite-(?!style-|visible-|edit-|nav-)[0-9a-f-]+$/i,
      'saved place row',
    ).slice('favorite-'.length),
  };
}

async function addRouteStop(name) {
  // The newly-mounted controlled stop box can drop its first injected key on
  // the emulator. A duplicate leading character is harmless to search and
  // leaves the intended query intact whether that native race occurs or not.
  await replaceText('route-stop-search', `${name[0]}${name}`, name);
  await waitForId('route-stop-result-0', true, 20_000);
  await dismissKeyboard();
  await tap('route-stop-result-0');
  await waitForId('route-stop-search');
}

async function planRoadRoute(folderId) {
  await tap('plan-route');
  await waitForId('route-sheet');
  await addRouteStop('origin');
  await addRouteStop('destination');
  // The alternatives live below the clipped half-sheet and therefore are not
  // mounted into UiAutomator's visible tree yet. This route-only control is
  // the first stable signal that the detailed road result has landed; the two
  // choices are asserted later in the navigation preview where both are shown.
  await waitForId('route-along-toggle', true, 30_000);

  const initial = boundsForNode(nodeForId(hierarchy(), 'route-sheet'));
  await tap('route-sheet-handle');
  const expandedXml = await waitFor('route sheet to expand', hierarchy, (xml) => {
    const next = boundsForNode(nodeForId(xml, 'route-sheet'));
    return Boolean(initial && next && next.height > initial.height + 100);
  });
  const expanded = boundsForNode(nodeForId(expandedXml, 'route-sheet'));
  if (!initial || !expanded) {
    throw new Error('Route sheet did not expose measurable bounds');
  }
  // Tapping the handle is the same public snap interaction as dragging it,
  // and is deterministic through UiAutomator: full explicitly cycles to half.
  tapId(expandedXml, 'route-sheet-handle');
  await waitFor('route sheet to respond to a downward snap gesture', hierarchy, (xml) => {
    const next = boundsForNode(nodeForId(xml, 'route-sheet'));
    return Boolean(next && next.height < expanded.height - 80);
  });

  await tapAfterScroll('route-save-track', 'route-scroll');
  await focusAfterScroll('route-save-name', 'route-scroll');
  await replaceText('route-save-name', 'regression track');
  await dismissKeyboard();
  await tapAfterScroll(`route-save-folder-${folderId}`, 'route-scroll');
  await tapAfterScroll('route-save-confirm', 'route-scroll');
  await waitForId('route-save-confirm', false);

  await tapAfterScroll('route-navigate', 'route-scroll', 'down');
  let xml = await waitForId('route-preview-sheet', true, 60_000);
  expectIds(xml, ['route-choice-0', 'route-choice-1', 'preview-go', 'preview-cancel']);
  tapId(xml, 'route-choice-1');
  await tap('preview-go');
  xml = await waitForId('stop-nav', true, 60_000);
  expectIds(xml, ['toggle-mute', 'toggle-orientation', 'toggle-overview']);
  tapId(xml, 'stop-nav');
  await waitForId('stop-nav', false);
}

async function planTransitJourney() {
  await tap('plan-route');
  await addRouteStop('origin');
  await addRouteStop('destination');
  await tap('route-profile-transit');
  await waitFor(
    'transit journey result',
    hierarchy,
    (xml) => Boolean(nodeForId(xml, 'transit-trip-0')),
    30_000,
  );
  // `useTransitPlan` opens the best journey by default; scroll to its action.
  // Tapping the already-selected summary would collapse it.
  await tapAfterScroll('transit-start-0', 'route-scroll');
  await waitForId('transit-guidance');
  await tap('transit-guidance-end');
  await waitForId('transit-guidance', false);
}

async function setDarkTheme() {
  await openMenuItem('open-settings');
  await tap('settings-open-appearance');
  await tap('theme-dark');
  await closeSettings();
}

async function recordTrackId(folderId) {
  await openMenuItem('open-favorites');
  let xml = await waitForId(`folder-row-${folderId}`);
  if (!nodeIds(xml).some((id) => /^track-(?!visible-|edit-|plan-|export-)[0-9a-f-]+$/i.test(id))) {
    tapId(xml, `folder-collapse-${folderId}`);
    xml = await waitFor('saved track row inside folder', hierarchy, (value) =>
      nodeIds(value).some((id) => /^track-(?!visible-|edit-|plan-|export-)[0-9a-f-]+$/i.test(id)),
    );
  }
  const id = dynamicId(
    xml,
    /^track-(?!visible-|edit-|plan-|export-)[0-9a-f-]+$/i,
    'saved track row',
  ).slice('track-'.length);
  await tap('favorites-close');
  return id;
}

async function verifyPersistence({ folderId, placeId, trackId }) {
  shell('am', 'force-stop', PACKAGE);
  shell('am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`);
  await waitForAppReady();

  await openMenuItem('open-settings');
  await tap('settings-open-appearance');
  const themeXml = await waitForId('theme-dark');
  const themeNode = nodeForId(themeXml, 'theme-dark');
  if (!themeNode?.includes('checked="true"') && !themeNode?.includes('selected="true"')) {
    throw new Error(`Dark theme did not persist: ${themeNode}`);
  }
  await closeSettings();

  await openMenuItem('open-favorites');
  let xml = await waitForId(`folder-row-${folderId}`);
  if (!nodeForId(xml, `favorite-${placeId}`)) {
    throw new Error(`Saved place ${placeId} did not survive process restart`);
  }
  if (!nodeForId(xml, `track-${trackId}`)) {
    const collapse = visibleNode(xml, `folder-collapse-${folderId}`);
    if (collapse) tapBounds(collapse.bounds);
    xml = await waitForId(`track-${trackId}`);
  }
  expectIds(xml, [`favorite-${placeId}`, `track-${trackId}`, `folder-row-${folderId}`]);
  await tap('favorites-close');
}

function saveArtifacts(error) {
  mkdirSync(artifactsDir, { recursive: true });
  let xml = '';
  try {
    xml = hierarchy();
    writeFileSync(join(artifactsDir, 'window.xml'), xml);
  } catch (artifactError) {
    writeFileSync(join(artifactsDir, 'window-error.txt'), String(artifactError));
  }
  try {
    const screenshot = command(['exec-out', 'screencap', '-p'], { encoding: null });
    writeFileSync(join(artifactsDir, 'failure.png'), screenshot);
  } catch (artifactError) {
    writeFileSync(join(artifactsDir, 'screenshot-error.txt'), String(artifactError));
  }
  for (const [file, args] of [
    ['logcat.txt', ['logcat', '-d', '-t', '1200']],
    ['activity.txt', ['shell', 'dumpsys', 'activity', 'activities']],
    ['package.txt', ['shell', 'dumpsys', 'package', PACKAGE]],
  ]) {
    try {
      writeFileSync(join(artifactsDir, file), command(args));
    } catch (artifactError) {
      writeFileSync(join(artifactsDir, `${file}.error`), String(artifactError));
    }
  }
  writeFileSync(join(artifactsDir, 'failure.txt'), `${error.stack ?? error}\n`);
}

async function main() {
  rmSync(artifactsDir, { recursive: true, force: true });
  command(['wait-for-device'], { timeout: 120_000 });
  await waitFor(
    'Android boot completion',
    () => shell('getprop', 'sys.boot_completed'),
    (value) => value === '1',
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
  shell('pm', 'clear', PACKAGE);
  for (const permission of [
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_BACKGROUND_LOCATION',
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
  command(['emu', 'geo', 'fix', String(ORIGIN_LNG), String(ORIGIN_LAT)]);

  shell('am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`);
  let xml = await waitForAppReady();
  expectIds(xml, [
    'search-open',
    'plan-route',
    'map-profile-toggle',
    'layer-quick-toggle',
    'locate',
  ]);

  console.log('Android regression: configuring controlled backend');
  await configureFixtureServer();
  console.log('Android regression: creating saved place and folder');
  await searchAndSavePlace();
  const ids = await createFolderAndReadPlace();
  await tap('favorites-close');
  console.log('Android regression: road planning, sheet snaps, and navigation hand-off');
  await planRoadRoute(ids.folderId);
  console.log('Android regression: transit planning and guidance hand-off');
  await planTransitJourney();
  console.log('Android regression: persisted settings and saved-data restart');
  await setDarkTheme();
  const trackId = await recordTrackId(ids.folderId);
  await verifyPersistence({ ...ids, trackId });

  await tap('search-open');
  await waitForId('search-sheet');
  shell('settings', 'put', 'system', 'user_rotation', '1');
  await waitFor('landscape rotation', rotation, (value) => value === 1, 20_000);
  xml = await waitForId('search-input');
  if (!nodeForId(xml, 'search-sheet') || !xml.includes(`package="${PACKAGE}"`)) {
    throw new Error('Search did not remain inside Atlas in landscape');
  }
  await tap('search-close');

  console.log(
    'Android regression passed: candidate install, controlled backend, saved-data persistence, road and transit planning, navigation hand-off, sheet snaps, Back-compatible surfaces, and rotation.',
  );
}

const ORIGIN_LAT = 59.8337;
const ORIGIN_LNG = 10.4348;

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
