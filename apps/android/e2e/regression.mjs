#!/usr/bin/env node

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGE = 'io.gjessing.atlas';
const EXPECTED_AVD = 'atlas_test';
const FIXTURE_ORIGIN = 'http://10.0.2.2:3199';
/** The same server as {@link FIXTURE_ORIGIN}, from this side of the emulator. */
const FIXTURE_HOST = 'http://127.0.0.1:3199';
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
    // Awaited, so the same helper can poll the fixture server as well as the
    // device: a sync read is unaffected.
    value = await read();
    if (accept(value)) return value;
    await delay(750);
  }
  const lastValue =
    typeof value === 'string' && value.length > 800
      ? `${value.slice(0, 800)}… (${value.length} characters)`
      : JSON.stringify(value);
  throw new Error(`Timed out waiting for ${label}; last value was ${lastValue}`);
}

function readWindow() {
  shell('uiautomator', 'dump', '/sdcard/atlas-regression-window.xml');
  return command(['exec-out', 'cat', '/sdcard/atlas-regression-window.xml']);
}

function nodeForText(xml, text) {
  return xml.match(new RegExp(`<node[^>]*text="${escapeRegex(text)}"[^>]*/?>`))?.[0] ?? null;
}

/**
 * The window the scenario is asking about — with Play Services' interruptions
 * taken off it first.
 *
 * Play Services asks for "Location Accuracy" consent the first time something
 * wants a fine fix. That dialog belongs to com.google.android.gms and covers
 * the app, so every wait after it reads the wrong window and times out on a
 * screen Atlas had rendered correctly underneath — which is exactly how it
 * presents: a route that is drawn and progressing, reported as a missing
 * sheet. It cannot be pre-answered from our side (`pm clear` reaches only our
 * own package, and the `network_location_opt_in` secure setting does not gate
 * it on this image), so it is answered where it appears.
 *
 * Always **"Turn on"**, never "No thanks". This dialog is not about our
 * permissions — those are granted directly in setup — it is Play Services'
 * `checkLocationSettings` resolution, and declining it leaves the device
 * settings unsatisfied for the fix Atlas asks for. The app then correctly
 * reports "Location request failed due to unsatisfied device settings" and
 * navigation never starts, so dismissing this politely fails the run just as
 * surely as ignoring it.
 */
function hierarchy() {
  const xml = readWindow();
  if (xml.includes('package="com.google.android.gms"') && !xml.includes(`package="${PACKAGE}"`)) {
    for (const label of ['Turn on', 'TURN ON', 'Yes', 'OK']) {
      const bounds = boundsForNode(nodeForText(xml, label));
      if (!bounds) continue;
      console.log(`Android regression: answering a Play Services dialog ("${label}")`);
      tapBounds(bounds);
      return readWindow();
    }
  }
  // "Process system isn't responding". The software-rendered AVD surfaces a
  // system_server ANR whenever the host is busy, and it covers whatever Atlas
  // had rendered underneath — so every wait after it reads the wrong window and
  // times out on a screen that was correct. Answered here rather than only
  // during startup, because host load does not confine itself to the first
  // minute of a run. Always **Wait**: closing it kills the shell the rest of the
  // scenario needs, turning host contention into a false app regression.
  const wait = boundsForNode(nodeForId(xml, 'android:id/aerr_wait'));
  if (wait) {
    console.log('Android regression: waiting out a system ANR dialog');
    tapBounds(wait);
    return readWindow();
  }
  return xml;
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

/** Every node fully inside `bounds`, so an assertion can scope itself to one list. */
function textsWithin(xml, bounds) {
  return [...xml.matchAll(/<node[^>]*\/?>/g)]
    .map((match) => match[0])
    .filter((node) => {
      const box = boundsForNode(node);
      return (
        box &&
        box.left >= bounds.left &&
        box.right <= bounds.right &&
        box.top >= bounds.top &&
        box.bottom <= bounds.bottom
      );
    })
    .map((node) => node.match(/text="([^"]*)"/)?.[1] ?? '')
    .filter(Boolean);
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

// The quick menu's ScrollView carries no testID, and a dump lists only rows on
// screen: Points of interest and Base map sit at its foot, below the catalog
// groups. Swipe inside the visible rows' own bounds until the target shows.
const QUICK_MENU_CHROME = new Set([
  'layer-quick-toggle',
  'layer-quick-backdrop',
  'layer-quick-search-toggle',
  'layer-quick-search',
]);

async function tapQuickLayer(id) {
  await waitForId('layer-quick-backdrop');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const xml = hierarchy();
    const target = visibleNode(xml, id);
    if (target) {
      tapBounds(target.bounds);
      return;
    }
    const rows = nodeIds(xml)
      .filter((rowId) => rowId.startsWith('layer-quick-') && !QUICK_MENU_CHROME.has(rowId))
      .map((rowId) => visibleNode(xml, rowId)?.bounds)
      .filter(Boolean);
    if (rows.length === 0) throw new Error(`Quick layer menu shows no rows to scroll toward ${id}`);
    const top = Math.min(...rows.map((b) => b.top));
    const bottom = Math.max(...rows.map((b) => b.bottom));
    swipeWithin(
      { left: rows[0].left, right: rows[0].right, top, bottom, height: bottom - top },
      'up',
    );
    await delay(400);
  }
  throw new Error(`Could not bring ${id} into view in the quick layer menu`);
}

// Tapping the backdrop by id taps its centre, which a full menu covers with its
// own header. Dismiss from near the top of the screen, above the menu and the
// bottom dock.
async function closeQuickLayerMenu() {
  const xml = await waitForId('layer-quick-backdrop');
  const { bounds } = visibleNode(xml, 'layer-quick-backdrop');
  const y = bounds.top + 200;
  tapBounds({ left: bounds.left, right: bounds.right, top: y, bottom: y });
  await waitForId('layer-quick-backdrop', false);
}

async function verifyPoiCategoryDock() {
  await tap('layer-quick-toggle');
  await tapQuickLayer('layer-quick-points-of-interest');
  let xml = await waitForId('poi-category-all');
  if (!nodeForId(xml, 'poi-category-groceries')) {
    throw new Error('POI layer did not expose the practical category pills');
  }
  await closeQuickLayerMenu();
  await tap('poi-category-groceries');
  xml = await waitForId('poi-category-groceries');
  if (!nodeForId(xml, 'poi-category-groceries')?.includes('selected="true"')) {
    throw new Error('Groceries POI pill did not become selected');
  }

  // The selector *is* the sheet's handle: tapping it snaps past peek into the
  // places-in-view list, the same public interaction as dragging it.
  await tap('poi-list-sheet-handle');
  const listXml = await waitFor('the places-in-view list to fill', hierarchy, (xml) => {
    const bounds = boundsForNode(nodeForId(xml, 'poi-results-list'));
    return Boolean(bounds && textsWithin(xml, bounds).some((t) => t.startsWith('Groceries')));
  });
  const listBounds = boundsForNode(nodeForId(listXml, 'poi-results-list'));
  const rowTexts = textsWithin(listXml, listBounds);
  // No position fix is the normal outcome on this AVD, not an error: the row
  // keeps its name and category and simply leaves the distance out. A fix does
  // sometimes arrive here (see README, "Location"), so a distance is allowed —
  // it just has to read as one and not as a raw metre count.
  const distances = rowTexts.filter((text) => /^\d/.test(text));
  if (distances.some((text) => !/^\d+(?:[.,]\d+)? (?:m|km)$/.test(text))) {
    throw new Error(`POI row showed an unformatted distance: ${distances.join(', ')}`);
  }

  // Back collapses a pulled-up list and is not swallowed at peek: this sheet *is*
  // the selector and never closes, so consuming Back would leave the map with no
  // way back at all (v0.233.0).
  const expandedSheet = boundsForNode(nodeForId(listXml, 'poi-list-sheet'));
  shell('input', 'keyevent', 'KEYCODE_BACK');
  await waitFor('the POI list to collapse on Back', hierarchy, (xml) => {
    const next = boundsForNode(nodeForId(xml, 'poi-list-sheet'));
    return Boolean(expandedSheet && next && next.height < expandedSheet.height - 60);
  });

  // A row whose own line carries an opening status is a place whose hours the
  // shared parser read, so its card must be able to show them — which keeps this
  // assertion honest on whatever the live backend happens to hold here.
  await tap('poi-list-sheet-handle');
  const rowsXml = await waitFor('a POI row with a read opening status', hierarchy, (xml) =>
    nodeIds(xml).some((id) => {
      if (!id.startsWith('poi-result-')) return false;
      const bounds = boundsForNode(nodeForId(xml, id));
      return Boolean(bounds && textsWithin(xml, bounds).some((t) => / · (?:Open|Closed)/.test(t)));
    }),
  );
  const rowId = nodeIds(rowsXml).find((id) => {
    if (!id.startsWith('poi-result-')) return false;
    const bounds = boundsForNode(nodeForId(rowsXml, id));
    return Boolean(
      bounds && textsWithin(rowsXml, bounds).some((t) => / · (?:Open|Closed)/.test(t)),
    );
  });
  tapId(rowsXml, rowId);
  const cardXml = await waitForId('destination-opening-hours');
  const cardTexts = [...cardXml.matchAll(/text="([^"]*)"/g)].map((match) => match[1]);
  if (!cardTexts.some((text) => /\d{2}:\d{2}–\d{2}:\d{2}|^Closed$|^Open 24 hours$/.test(text))) {
    throw new Error(`The place card showed no parsed opening hours: ${cardTexts.join(' | ')}`);
  }
  // A website, when this place has one, is the domain and never a raw URL.
  const website = cardTexts.find(
    (text) => text.endsWith(' ↗') && !text.startsWith('OpenStreetMap'),
  );
  if (website && /:\/\/|^www\./i.test(website)) {
    throw new Error(`The place card did not shorten the website: ${website}`);
  }
  await tap('destination-cancel');
  // Closing the card brings the selector back at peek, so the map controls
  // below it are reachable again.
  await waitForId('poi-category-all');

  // Restore the opt-in layer to off so the dock cannot cover unrelated map
  // controls later in this long scenario. Its focused category may persist.
  await tap('layer-quick-toggle');
  await tapQuickLayer('layer-quick-points-of-interest');
  await waitForId('poi-category-all', false);
  await closeQuickLayerMenu();
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

/**
 * Wait for a node that lives *below* the sheet's clipped edge, scrolling to look
 * for it between polls.
 *
 * `waitForId` alone cannot see one: React Native does not lay out a
 * ScrollView's off-screen children, so "not in the visible tree" and "not
 * rendered yet" are the same observation from UiAutomator — which is why the
 * route-landed signal used to be a control near the top of the sheet. Since
 * v0.174.0 the result and its toolbar sit below the stops, where the answer
 * belongs, so proving the road result arrived means scrolling to it.
 */
async function waitForIdAfterScroll(id, scrollerId, direction = 'up', timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = hierarchy();
    if (visibleNode(last, id)) return last;
    const scroller = visibleNode(last, scrollerId);
    if (scroller) swipeWithin(scroller.bounds, direction);
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for ${id} to scroll into view inside ${scrollerId}; saw ${nodeIds(last).join(', ')}`,
  );
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

// Every stop in a plan renders its own edit control, so counting them is how
// the scenario knows whether the plan already has both ends.
function stopCount(xml) {
  return new Set([...xml.matchAll(/resource-id="route-wp-edit-([^"]+)"/g)].map((m) => m[1])).size;
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
  // React-controlled TextInputs can lose the first part of one fast `adb input
  // text` event while JS is reconciling it. Key characters individually so the
  // value observed by the app is the value the scenario asked for.
  const holds = (next) => {
    const value = nodeForId(next, id)?.match(/text="([^"]*)"/)?.[1] ?? '';
    return value.toLocaleLowerCase().includes(expectedText.toLocaleLowerCase());
  };
  const type = async () => {
    for (const character of text) {
      if (character === ' ') shell('input', 'keyevent', 'KEYCODE_SPACE');
      else shell('input', 'text', character);
      await delay(80);
    }
  };
  // The soft keyboard can keep what was typed as *composing* text: it stands in
  // the IME's suggestion strip while the field the app reads is still empty, so
  // closing it is part of each attempt. Dismissing an IME may also drop the
  // input connection altogether on a loaded emulator, so every retry re-taps
  // and proves focus instead of assuming the previous connection survived.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const xml = await waitForId(id);
    tapId(xml, id);
    await waitFor(
      `${id} to take focus`,
      hierarchy,
      (next) => /focused="true"/.test(nodeForId(next, id) ?? ''),
      10_000,
    );
    shell('input', 'keyevent', 'KEYCODE_MOVE_END');
    shell('input', 'keyevent', ...Array.from({ length: 100 }, () => 'KEYCODE_DEL'));
    await delay(300);
    await type();
    if (holds(hierarchy())) return;
    await dismissKeyboard();
    if (holds(hierarchy())) return;
  }
  await waitFor(`${id} to contain ${expectedText}`, hierarchy, holds);
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

// Planning starts where a user starts it: a picked place's card. "Go" on a
// saved place opens that card, and its Directions plans from a GPS fix to the
// place — a fix this AVD often never delivers, even with a `geo fix` set.
// So wait out the lookup (8 s, then last-known), and if the plan still has
// only the place, give it a second stop with a map tap, which a plan takes as
// a stop. Not through the stop box: injected keys are this AVD's least
// reliable input (a focused field has dropped them on three different screens),
// and the fixture routes any two points. The added stop also retires a fix
// that lands later (it only ever fills a one-stop plan), so what follows never
// depends on GPS timing.
async function openRouteFromSavedPlace(placeId) {
  await openMenuItem('open-favorites');
  await tap(`favorite-nav-${placeId}`);
  await tap('destination-navigate');
  await waitForId('route-sheet');
  const settled = await waitFor(
    'the Directions origin lookup to settle',
    hierarchy,
    (xml) => !xml.includes('text="Getting location…"'),
    30_000,
  );
  // Count the stops, never the stop box: the box stays on screen even for a
  // complete plan (a third stop is always one tap away), so its presence says
  // nothing about whether this plan still needs one. A plan that already has
  // both ends is routed and holds its alternatives, and a third stop would
  // retire them — Valhalla offers alternates for 2-point queries only
  // (packages/routing/src/valhalla.ts), which the navigation preview below
  // asserts. So tap only to supply a start this AVD's GPS did not.
  // The origin can land a beat after the lookup settles, so let the plan show
  // what it has before deciding it is short a stop.
  let planned = settled;
  const decideBy = Date.now() + 5_000;
  while (stopCount(planned) < 2 && Date.now() < decideBy) {
    await delay(500);
    planned = hierarchy();
  }
  if (stopCount(planned) >= 2) return;
  const sheet = visibleNode(planned, 'route-sheet')?.bounds;
  if (!sheet) throw new Error('Route sheet has no measurable bounds');
  // Left of centre and halfway down the map left above the sheet: clear of the
  // place's own pin, which the camera centres, and of the status bar.
  shell(
    'input',
    'tap',
    String(Math.round(sheet.left + sheet.width * 0.25)),
    String(Math.round(sheet.top * 0.5)),
  );
  // Two stops make a plan. The stop rows are what proves the tap was taken:
  // nothing disappears from the sheet to mark it any more.
  await waitFor(
    'the map-tapped stop to join the plan',
    hierarchy,
    (xml) => stopCount(xml) >= 2,
    20_000,
  );
}

async function planRoadRoute(folderId, placeId) {
  await openRouteFromSavedPlace(placeId);
  // This route-only control is the first stable signal that the detailed road
  // result has landed; the alternatives are asserted later in the navigation
  // preview, where both choices are shown. It needs a computed path to exist,
  // and driving is the mode that keeps it in the visible toolbar rather than
  // under "More" (`routeActionsFor`) — so finding it also proves the
  // mode-dependent toolbar rendered. It sits below the stops with the rest of
  // the result, past the half-sheet's clipped edge, hence the scroll.
  await waitForIdAfterScroll('route-action-alongRoute', 'route-scroll', 'up', 45_000);

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

  // Saving a *drive* as a track is a real capability but not a driver's first
  // reach, so the driving toolbar folds it under "More" (`routeActionsFor`).
  await tapAfterScroll('route-more', 'route-scroll');
  await tapAfterScroll('route-action-saveTrack', 'route-scroll');
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

async function planTransitJourney(placeId) {
  await openRouteFromSavedPlace(placeId);
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

/**
 * The commute board and both home-screen widgets.
 *
 * Twice running, the only real bugs in a release were on this surface, and both
 * were found by a human looking at a home screen: v0.176.0's `optString`
 * printing the string `"null"` in two of five columns, and v0.181.0's four
 * rendering faults. The gate tested the row *model* and could not see any of
 * them, because a row model says nothing about what Kotlin painted.
 *
 * So this scenario ends where those bugs were: on the launcher, reading a
 * pinned instance out of `uiautomator dump` and comparing it against the board
 * the fixture server rendered for it (`/api/e2e/widget-board`). Not against a
 * copy of the expected rows kept here — the board comes from `@atlas/transit`,
 * and a second copy of it in the test is a second thing to keep true.
 */

/** The board the fixture last rendered for a widget variant, and which rows it broke. */
async function servedWidgetBoard(variant) {
  const response = await fetch(`${FIXTURE_HOST}/api/e2e/widget-board?variant=${variant}`);
  if (!response.ok) {
    throw new Error(`fixture widget board unavailable (HTTP ${response.status})`);
  }
  return response.json();
}

/**
 * A string as it appears inside a `uiautomator dump` attribute.
 *
 * Astral-plane characters are the ones that matter here: UiAutomator's XML
 * serializer writes 🚌 as `&#128652;` while leaving →, ·, ⇄ and ⚠ alone — so a
 * literal search for the mode glyphs the board and the widget are full of finds
 * nothing at all, which is exactly how this was discovered.
 */
function xmlAttr(value) {
  const named = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0);
      return code > 0xffff ? `&#${code};` : (named[character] ?? character);
    })
    .join('');
}

function nodeForDesc(xml, description) {
  const pattern = new RegExp(
    `<node[^>]*content-desc="${escapeRegex(xmlAttr(description))}"[^>]*/?>`,
  );
  return xml.match(pattern)?.[0] ?? null;
}

/** Every string a window paints or announces, unescaped — see {@link xmlAttr}. */
function windowStrings(xml) {
  return [...xml.matchAll(/(?:text|content-desc)="([^"]*)"/g)].map((match) =>
    match[1]
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&'),
  );
}

function expectStrings(xml, expected, where) {
  const strings = windowStrings(xml);
  const missing = expected.filter((value) => !strings.some((seen) => seen.includes(value)));
  if (missing.length > 0) {
    throw new Error(`${where} is missing: ${missing.map((value) => `"${value}"`).join(', ')}`);
  }
}

/** A dynamic id that may be below the fold, scrolling to look for it. */
async function scrollToDynamicId(pattern, label, scrollerId, direction = 'up') {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const xml = hierarchy();
    const found = nodeIds(xml).find((id) => pattern.test(id));
    if (found) return found;
    const scroller = visibleNode(xml, scrollerId);
    if (scroller) swipeWithin(scroller.bounds, direction);
    await delay(500);
  }
  throw new Error(`Could not bring ${label} into view inside ${scrollerId}`);
}

/**
 * Scroll a sheet until a piece of text is on screen, and hand back that dump.
 *
 * The text twin of {@link scrollToDynamicId}, needed for the same reason:
 * UiAutomator reports what is laid out, so a string inside a card taller than
 * the window is "missing" until that part of the card is brought into view.
 */
async function scrollToString(needle, label, scrollerId, direction = 'up') {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const xml = hierarchy();
    if (windowStrings(xml).some((value) => value.includes(needle))) return xml;
    const scroller = visibleNode(xml, scrollerId);
    if (scroller) swipeWithin(scroller.bounds, direction);
    await delay(400);
  }
  throw new Error(`Could not bring ${label} ("${needle}") into view inside ${scrollerId}`);
}

/** The emulator's screen, for gestures that are not about a node. */
function screenSize() {
  const match = shell('wm', 'size').match(/(\d+)x(\d+)/);
  return { width: Number(match?.[1] ?? 1080), height: Number(match?.[2] ?? 1920) };
}

/**
 * Poll the launcher until a widget paints what is being looked for, paging
 * across the home screen while waiting.
 *
 * "Add automatically" places an instance wherever there is room, which is not
 * always the page in front of you — and a widget one swipe away is invisible to
 * `uiautomator dump`, which reads the window and not the workspace.
 */
async function waitForHomeScreen(label, accept, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const { width, height } = screenSize();
  let attempt = 0;
  let xml = '';
  while (Date.now() < deadline) {
    xml = hierarchy();
    if (accept(xml)) return xml;
    attempt += 1;
    if (attempt % 6 === 0) {
      const y = String(Math.round(height * 0.5));
      shell(
        'input',
        'swipe',
        String(Math.round(width * 0.8)),
        y,
        String(Math.round(width * 0.2)),
        y,
        '300',
      );
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${label} on the home screen`);
}

/** Pick one end of the commute from the fixture server's stop search. */
async function setCommuteEnd(field, query, name) {
  await tapAfterScroll(`commute-end-${field}`, 'commute-sheet');
  await replaceText(`commute-search-${field}`, query);
  await waitForId(`commute-hit-${field}-0`, true, 20_000);
  await dismissKeyboard();
  await tap(`commute-hit-${field}-0`);
  // The field collapses back to the chosen stop; the search box going away is
  // what says the pick was taken rather than merely tapped at.
  await waitForId(`commute-search-${field}`, false);
  await waitFor(`${field} to read ${name}`, hierarchy, (xml) => xml.includes(xmlAttr(name)));
}

/**
 * Put a widget on the home screen and leave the launcher in front.
 *
 * The confirmation is the launcher's own, not ours: `requestPinAppWidget` hands
 * the decision to whichever launcher is running, and its button is worded
 * differently on each. Tapping whichever of them is present is the only way
 * this can be driven without pinning the test to one launcher build.
 */
async function pinWidget(testId) {
  await tapAfterScroll(testId, 'commute-sheet');
  const labels = ['Add automatically', 'ADD AUTOMATICALLY', 'Add to home screen', 'Add', 'ADD'];
  const dialog = await waitFor(
    'the launcher to offer to place the widget',
    hierarchy,
    (xml) => labels.some((label) => nodeForText(xml, label)),
    30_000,
  );
  const label = labels.find((value) => nodeForText(dialog, value));
  tapBounds(boundsForNode(nodeForText(dialog, label)));
  shell('input', 'keyevent', 'KEYCODE_HOME');
  await delay(1_500);
}

/**
 * Back into Atlas from the launcher, with the commute sheet left as it was.
 *
 * `waitForAppReady` cannot be used here: it waits for the map's menu button,
 * and Atlas comes back with the sheet that was open still covering it — which
 * is the correct behaviour and would read as a hung app.
 */
async function returnToApp() {
  shell('am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`);
  await waitFor(
    'Atlas to come back to the front',
    hierarchy,
    (xml) =>
      xml.includes(`package="${PACKAGE}"`) &&
      Boolean(visibleNode(xml, 'open-menu') || visibleNode(xml, 'commute-sheet')),
    60_000,
  );
}

async function openCommuteSheet() {
  if (visibleNode(hierarchy(), 'commute-sheet')) return;
  await openMenuItem('open-commute');
  await waitForId('commute-sheet');
}

/**
 * Leave the map uncovered for whatever runs next.
 *
 * `returnToApp` deliberately accepts the sheet still being up — that *is* the
 * correct behaviour coming back from the launcher — so the scenario that opened
 * it is the one that has to put it away, exactly as the favourites and search
 * scenarios do with theirs.
 */
async function closeCommuteSheet() {
  await tap('commute-close');
  await waitForId('commute-sheet', false);
  await waitForId('search-open');
}

/** The saved commute, and the board the app draws from it. */
async function saveCommuteAndReadBoard() {
  await openCommuteSheet();
  // Nothing is saved after `pm clear`, so the editor opens by itself —
  // which is the state this asserts by finding its fields at all.
  await waitForId('commute-end-from', true, 20_000);
  await setCommuteEnd('from', 'engelsrud', 'Engelsrud E2E');
  await setCommuteEnd('via', 'asker', 'Asker E2E');
  await setCommuteEnd('to', 'oslo', 'Oslo E2E');
  // The commute editor uses Android's native clock, not a row of five-minute
  // nudges. Seeing and accepting the platform dialog proves the native seam is
  // present in the installed binary; the chosen value then returns to Atlas.
  await tapAfterScroll('commute-time-outbound', 'commute-sheet');
  const timeDialog = await waitFor(
    'the native commute time picker',
    hierarchy,
    (xml) => Boolean(nodeForId(xml, 'android:id/button1')),
    20_000,
  );
  tapId(timeDialog, 'android:id/button1');
  await waitForId('commute-sheet', true, 20_000);

  // Common weeks are presets, but individual day controls remain alongside
  // them for custom schedules.
  await tapAfterScroll('commute-days-weekdays', 'commute-sheet');
  await waitForId('commute-day-7');
  await tapAfterScroll('commute-days-every-day', 'commute-sheet');
  // "Done": the board is what the reader came for, the editor is not.
  await tapAfterScroll('commute-edit', 'commute-sheet', 'down');
  const board = await waitFor(
    'the commute board to answer',
    hierarchy,
    (xml) => Boolean(nodeForId(xml, 'commute-leave-now')),
    60_000,
  );
  // The ribbon, with the mode glyphs and the change the widget was missing
  // until v0.181.0. Both vehicles, because a row that names only the first is
  // exactly the bug that shipped — and the interchange the change is at, which
  // now sits on its own line under the bar rather than inside a chip.
  expectStrings(board, ['🚌 280', '🚆 R14', 'Asker E2E'], 'the commute board');

  // TRANSIT.md §7. Tracking a journey is what turns the board into "where am I": the
  // block only exists for a journey the user committed to, so tapping the
  // control is the only way to see it at all.
  await tapAfterScroll('commute-track', 'commute-sheet', 'down');
  const tracked = await waitFor(
    'the board to say where the journey is',
    hierarchy,
    (xml) => Boolean(nodeForId(xml, 'commute-here')),
    20_000,
  );
  // A run that reaches this immediately sees the ordinary pre-departure
  // "Tracking / Upcoming" state. Slower emulator runs can cross the ten-minute
  // boarding threshold, where the product deliberately says "You are here /
  // Boarding soon" instead. Both are valid before departure; a mixed pair is
  // not, and the booked connection must remain visible in either phase.
  const trackedStrings = windowStrings(tracked);
  const has = (value) => trackedStrings.some((seen) => seen.includes(value));
  const upcoming = has('TRACKING') && has('UPCOMING');
  const boarding = has('YOU ARE HERE') && has('BOARDING SOON');
  if (!upcoming && !boarding) {
    throw new Error(
      'the tracked journey is missing a valid pre-departure phase: expected Tracking / Upcoming or You are here / Boarding soon',
    );
  }
  expectStrings(tracked, ['NEXT CONNECTION'], 'the tracked journey');
  // Each leg's own platform, inside the tracked card. Tracking used to show
  // strictly *less* than not tracking — a ribbon and the next connection, but
  // never a platform or a per-leg time — and this is the one surface where the
  // journey cannot simply be looked up again: a board asked "from now" drops it
  // the moment it leaves. Two scrolls, not one dump, because both platforms
  // rarely fit on screen together and "B4" is a bus stop while "3" is a track.
  await scrollToString('plat. B4', 'the tracked journey’s first leg', 'commute-sheet');
  await scrollToString('plat. 3', 'the tracked journey’s second leg', 'commute-sheet');
  // Scrolled *down* the list, not back to the top: the card's control now sits
  // under its legs rather than a few lines under its ribbon.
  await tapAfterScroll('commute-stop-tracking', 'commute-sheet', 'up');
  await waitForId('commute-here', false, 20_000);

  // One journey opened to its legs: every leg states its *own* platform, which
  // is the fault v0.181.0 fixed — a row knows only the first ride's, and on a
  // bus→train commute that is a bus stop.
  //
  // Scrolled for rather than read off the window: the list sits under the
  // "if I leave now" card, and React Native does not lay out a ScrollView's
  // off-screen children — so "no journey row" and "not scrolled to yet" are the
  // same observation from UiAutomator.
  const journeyId = await scrollToDynamicId(/^commute-journey-/, 'a journey row', 'commute-sheet');
  await tapAfterScroll(journeyId, 'commute-sheet');
  const opened = await waitFor(
    'the journey to open its legs',
    hierarchy,
    (xml) => windowStrings(xml).some((value) => value.includes('plat. 3')),
    20_000,
  );
  expectStrings(opened, ['plat. B4', 'plat. 3', 'Total '], 'the opened journey');

  // TRANSIT.md §13's middle mode: the change as a stop, drawn as the departures
  // *leaving* it in both directions — the train in and the bus home, which is
  // the one glance someone standing at Asker is taking.
  await tapAfterScroll('commute-mode-interchange', 'commute-sheet', 'up');
  await scrollToString('ASKER E2E ↓ OSLO E2E', 'the train in from the change', 'commute-sheet');
  const boards = await scrollToString(
    'ASKER E2E ↓ ENGELSRUD E2E',
    'the way home from the change',
    'commute-sheet',
    'down',
  );
  // Never a hop *into* the change: a board of departures from your own front
  // door has no business under a mode about the station.
  const inbound = windowStrings(boards).filter((value) => value.includes('↓ ASKER E2E'));
  if (inbound.length > 0) {
    throw new Error(`the interchange mode drew a hop into the change: ${inbound[0]}`);
  }
  await tapAfterScroll('commute-mode-outbound', 'commute-sheet', 'up');
}

/** Multiple commute identities, and the saved-place marker they contribute. */
async function verifyMultipleCommutes(placeId) {
  await tapAfterScroll('commute-rename', 'commute-sheet', 'up');
  await replaceText('commute-name', 'Work E2E');
  await tap('commute-name-save');
  await tap('commute-add');
  // A new commute is selected and genuinely empty; it must not inherit the
  // corridor that remains assigned to the home-screen widget.
  await waitForId('commute-end-from', true, 20_000);
  await tap('commute-end-from');
  await tap(`commute-place-from-${placeId}`);
  await tap('commute-rename');
  await replaceText('commute-name', 'Cabin E2E');
  await tap('commute-name-save');
  // The migrated/first commute has a deterministic id. Returning to it brings
  // its board back, while the widget remains on that corridor throughout.
  await tap('commute-pick-commute');
  await waitForId('commute-leave-now', true, 60_000);

  await closeCommuteSheet();
  await openMenuItem('open-favorites');
  await waitForId('favorites-sheet');
  await scrollToString('Commute · Cabin E2E', 'the saved-place commute marker', 'favorites-sheet');
  await tap('favorites-close');
  await openCommuteSheet();
}

/**
 * The **v2** widget — "Atlas commute (live)" — pinned, painted, and committed to.
 *
 * The commitment is the half no unit test can reach: tapping a row is what buys
 * the whole state ladder (TRANSIT.md §W2), and the fixture's timetable deliberately
 * breaks one journey's connection so the announcement TRANSIT.md §W4 rests on is read
 * off a home screen rather than eyeballed on the one morning it matters.
 */
async function verifyLiveWidget() {
  await pinWidget('commute-add-widget-v2');
  const served = await waitFor(
    'the pinned live widget to ask for its board',
    () => servedWidgetBoard('v2'),
    (value) => Boolean(value.board),
    120_000,
  );
  const rows = served.board.blocks.flatMap((block) => block.rows);
  if (rows.length === 0) throw new Error('the fixture rendered a live widget board with no rows');
  const painted = await waitForHomeScreen(
    'the pinned live widget to paint the rows it was sent',
    (xml) => rows.some((row) => nodeForDesc(xml, row.text)),
  );
  // Painted from the board, part by part — the columns v0.176.0 filled with the
  // string "null" and v0.181.0 filled with a unit-less delay. `duration` and
  // `platform` are deliberately not asserted: a narrow instance drops both
  // columns on purpose (`NARROW_DP`), and how wide the launcher placed this one
  // is not something a test should decide.
  const shown = rows.filter((row) => nodeForDesc(painted, row.text));
  const strings = windowStrings(painted);
  for (const row of shown) {
    const parts = [row.time, row.arrival, row.lines, row.delayLabel];
    const missing = parts.filter((part) => part && !strings.includes(part));
    if (missing.length > 0) {
      throw new Error(
        `the live widget's row "${row.text}" is missing ${missing.join(', ')} on the home screen`,
      );
    }
  }
  if (strings.includes('null')) {
    throw new Error('the live widget painted the string "null" where a value belongs');
  }
  expectStrings(painted, [served.board.focus.action], 'the live widget');

  // TRANSIT.md §W4: commit to the journey whose connection this timetable breaks, and
  // the widget must say the change no longer holds.
  const brokenId = served.broken[0];
  const broken = shown.find((row) => row.id === brokenId);
  if (!broken) {
    throw new Error(
      `the broken journey ${brokenId} is not among the painted rows: ${shown
        .map((row) => row.id)
        .join(', ')}`,
    );
  }
  tapBounds(boundsForNode(nodeForDesc(painted, broken.text)));
  const committed = await waitFor(
    'the widget to take the commitment and re-ask',
    () => servedWidgetBoard('v2'),
    (value) => value.board?.commitId === brokenId,
    120_000,
  );
  const alert = committed.board.focus.alert;
  // TRANSIT.md §W4: the broken change is not merely announced, it is re-planned — and
  // the vehicle that takes over has to be on the home screen, which is the one
  // place this could ever be read.
  if (!alert?.startsWith('Connection replaced at')) {
    throw new Error(`a committed broken journey was not re-planned: ${alert}`);
  }
  await waitForHomeScreen('the replaced connection', (xml) =>
    windowStrings(xml).some((value) => value.includes(alert)),
  );
  return broken;
}

/**
 * TRANSIT.md §7 — one commitment, two hands on it: the journey tapped on the *widget*
 * is the journey the *board* is tracking.
 *
 * The board is holding none when this runs — `saveCommuteAndReadBoard` stops
 * tracking before it finishes — so a "you are here" block existing at all is
 * proof the app read the widget's store, and the departure printed inside it is
 * proof it read the right row. Neither could be asserted before the tracked
 * card carried the journey's legs; the card said a phase and a connection, and
 * both of those are true of more than one departure.
 *
 * It is checked on the way back from the launcher rather than by opening the
 * sheet, because that is the honest sequence: Atlas returns with the sheet it
 * left open, so "the board opened" never fires for the one journey that needs
 * the read.
 */
async function verifyCommitReachedTheBoard(row) {
  await waitForIdAfterScroll('commute-here', 'commute-sheet', 'down', 45_000);
  await scrollToString(row.time, 'the adopted journey’s departure', 'commute-sheet');
}

/** The **v1** widget — "Atlas commute" — one board, pinned, painted from the same route. */
async function verifySimpleWidget() {
  await pinWidget('commute-add-widget');
  const served = await waitFor(
    'the pinned simple widget to ask for its board',
    () => servedWidgetBoard('v1'),
    (value) => Boolean(value.board),
    120_000,
  );
  const rows = served.board.directions.flatMap((direction) => direction.rows);
  if (rows.length === 0) throw new Error('the fixture rendered a simple widget board with no rows');
  const painted = await waitForHomeScreen(
    'the pinned simple widget to paint the rows it was sent',
    (xml) => rows.some((row) => nodeForDesc(xml, row.text)),
  );
  const strings = windowStrings(painted);
  if (strings.includes('null')) {
    throw new Error('the simple widget painted the string "null" where a value belongs');
  }
  // v1 paints the leg strip a line per vehicle rather than one `lines` column,
  // so this is where v0.181.0's four faults are actually visible: the delay with
  // its unit beside the time it corrects, a mode icon per vehicle, and each
  // leg's own window — the row-level platform is the *first* ride's, which on a
  // bus→train commute is a bus stop. `quay`, `duration` and `platform` are left
  // out on purpose: all three are dropped below `NARROW_DP`, and how wide the
  // launcher placed this instance is not something a test should decide.
  for (const row of rows.filter((entry) => nodeForDesc(painted, entry.text))) {
    const parts = [
      row.time,
      row.arrival,
      row.delayLabel,
      ...row.legs.flatMap((leg) => [leg.icon, leg.line, leg.window]),
    ];
    const missing = parts.filter((part) => part && !strings.includes(part));
    if (missing.length > 0) {
      throw new Error(
        `the simple widget's row "${row.text}" is missing ${missing.join(', ')} on the home screen`,
      );
    }
  }
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
  // High accuracy (gps + network). This is what Play Services' location-settings
  // check wants; satisfying it up front usually keeps its consent dialog off the
  // screen entirely, and `hierarchy()` answers the dialog if it appears anyway.
  shell('settings', 'put', 'secure', 'location_mode', '3');
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
  expectIds(xml, ['search-open', 'map-profile-toggle', 'layer-quick-toggle', 'locate']);

  // Before the fixture, which serves an empty layer catalog: the Layers button
  // only exists while the catalog does, so the built-in POI switch is out of
  // reach afterwards. This step therefore reads the live backend's own places,
  // and asserts the shapes the app is responsible for rather than any one name.
  console.log('Android regression: POI layer, category pills and places in view');
  await verifyPoiCategoryDock();
  console.log('Android regression: configuring controlled backend');
  await configureFixtureServer();
  console.log('Android regression: creating saved place and folder');
  await searchAndSavePlace();
  const ids = await createFolderAndReadPlace();
  await tap('favorites-close');
  console.log('Android regression: road planning, sheet snaps, and navigation hand-off');
  await planRoadRoute(ids.folderId, ids.placeId);
  console.log('Android regression: transit planning and guidance hand-off');
  await planTransitJourney(ids.placeId);
  console.log('Android regression: persisted settings and saved-data restart');
  await setDarkTheme();
  const trackId = await recordTrackId(ids.folderId);
  await verifyPersistence({ ...ids, trackId });
  console.log('Android regression: commute board, then both widgets on the home screen');
  await saveCommuteAndReadBoard();
  await verifyMultipleCommutes(ids.placeId);
  const committedRow = await verifyLiveWidget();
  await returnToApp();
  await openCommuteSheet();
  await verifyCommitReachedTheBoard(committedRow);
  await verifySimpleWidget();
  await returnToApp();
  await closeCommuteSheet();

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
    'Android regression passed: candidate install, controlled backend, saved-data persistence, road and transit planning, navigation hand-off, the commute board and both home-screen widgets, sheet snaps, Back-compatible surfaces, and rotation.',
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
