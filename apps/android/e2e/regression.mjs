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

/**
 * The warm UiAutomator server, when the session started one (the Ally-X worker's
 * `--uiautomator2`): it holds one UiAutomation connection for the whole run, so a read costs
 * ~0.3 s. `uiautomator dump` starts a fresh app_process JVM per read (~2.8 s), and every wait
 * polls a read, so this sets the pace of the whole run.
 */
const uiautomator2 = { url: process.env.UIAUTOMATOR2_URL || null, session: null };
/** Per reader, how many window reads the run made and their total time — printed at the end. */
const windowReads = new Map();

function uiautomator2Request(method, path, body) {
  const args = ['--silent', '--show-error', '--fail', '--max-time', '30', '-X', method];
  if (body) args.push('-H', 'content-type: application/json', '--data', JSON.stringify(body));
  const result = spawnSync('curl', [...args, `${uiautomator2.url}${path}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `uiautomator2 ${method} ${path}: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

// The attributes `uiautomator dump` writes. Everything below parses that shape with regexes,
// so the server's extras (`text-entry-key`, `window-id`, …) are dropped rather than risk a
// pattern matching inside one.
const DUMP_ATTRIBUTES = new Set(
  'index text resource-id class package content-desc checkable checked clickable enabled focusable focused scrollable long-clickable password selected bounds drawing-order hint'.split(
    ' ',
  ),
);

/** The server's page source in `uiautomator dump`'s shape: `<node>` tags, its attributes. */
function dumpShaped(source) {
  return source
    .replace(/<hierarchy\b[^>]*?\brotation="(\d+)"[^>]*>/, '<hierarchy rotation="$1">')
    .replace(/<\/(?!hierarchy>)[\w.$-]+>/g, '</node>')
    .replace(
      /<(?![?/]|hierarchy\b)[\w.$-]+((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g,
      (_, attributes, close) => {
        const kept = [...attributes.matchAll(/([\w-]+)="[^"]*"/g)]
          .filter((match) => DUMP_ATTRIBUTES.has(match[1]))
          .map((match) => ` ${match[0]}`)
          .join('');
        return `<node${kept}${close}>`;
      },
    );
}

function readWindowFromServer() {
  if (!uiautomator2.session) {
    uiautomator2.session = uiautomator2Request('POST', '/wd/hub/session', {
      capabilities: { alwaysMatch: { platformName: 'Android' } },
    }).sessionId;
    // Wait for a quiet UI before each read, as `uiautomator dump` does (it waits for 1 s of
    // quiet, capped at 10 s). The scenarios rely on that: many read once right after a tap and
    // expect the result already rendered. With no idle wait, the first worker run failed on a
    // POI pill read 0 ms after its tap, though the failure artifact showed it selected.
    uiautomator2Request('POST', `/wd/hub/session/${uiautomator2.session}/appium/settings`, {
      settings: { waitForIdleTimeout: 10_000 },
    });
  }
  return dumpShaped(
    uiautomator2Request('GET', `/wd/hub/session/${uiautomator2.session}/source`).value,
  );
}

function readWindow() {
  const started = Date.now();
  const reader = uiautomator2.url ? 'uiautomator2 server' : 'uiautomator dump';
  try {
    return readWindowOnce();
  } finally {
    const reads = windowReads.get(reader) ?? { count: 0, ms: 0 };
    windowReads.set(reader, { count: reads.count + 1, ms: reads.ms + Date.now() - started });
  }
}

function readWindowOnce() {
  if (uiautomator2.url) {
    try {
      return readWindowFromServer();
    } catch (error) {
      // A dead server has released UiAutomation, so dump works again from here on.
      console.log(
        `Android regression: ${error.message}; reading windows with uiautomator dump from now on`,
      );
      uiautomator2.url = null;
    }
  }
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
  // Search and its IME are a separate, opt-in check. This scenario is about
  // POI categories; typing first made every release depend on the AVD's
  // least reliable input path before it reached the categories at all.
  if (process.env.ATLAS_ANDROID_CHECK_LAYER_SEARCH === '1') {
    await tap('layer-quick-search-toggle');
    await replaceText('layer-quick-search', 'point');
    await waitFor('the layer search keyboard to open', keyboardShown, (shown) => shown);
    await tap('layer-quick-search-toggle');
    await waitForId('layer-quick-search', false);
    await waitFor('closing layer search to hide the keyboard', keyboardShown, (shown) => !shown);
  }
  await tapQuickLayer('layer-quick-points-of-interest');
  let xml = await waitForId('poi-category-all');
  if (!nodeForId(xml, 'poi-category-groceries')) {
    throw new Error('POI layer did not expose the practical category pills');
  }
  if (nodeForId(xml, 'poi-results-list')) {
    throw new Error('Collapsed POI selector exposed the places-in-view list');
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
  // input connection altogether on a loaded emulator, so every retry
  // re-establishes focus when needed instead of assuming it survived.
  // An auto-focused field can be clipped by the keyboard and a sticky sheet
  // footer while still retaining focus; typing into it needs no second tap.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const xml = await waitFor(
      `${id} to be visible or focused`,
      hierarchy,
      (next) => Boolean(visibleNode(next, id)) || /focused="true"/.test(nodeForId(next, id) ?? ''),
      10_000,
    );
    if (!/focused="true"/.test(nodeForId(xml, id) ?? '')) tapId(xml, id);
    await waitFor(
      `${id} to take focus`,
      hierarchy,
      (next) => /focused="true"/.test(nodeForId(next, id) ?? ''),
      10_000,
    );
    const current = nodeForId(hierarchy(), id)?.match(/text="([^"]*)"/)?.[1] ?? '';
    if (current.length > 0) {
      shell('input', 'keyevent', 'KEYCODE_MOVE_END');
      shell(
        'input',
        'keyevent',
        ...Array.from({ length: [...current].length }, () => 'KEYCODE_DEL'),
      );
    }
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

// Collections remembers the folder it was left in (a run tapped from a folder
// closes the sheet, and the next one is picked from the same place), so a step
// that wants the top level goes there explicitly.
async function openCollectionsAtRoot() {
  await openMenuItem('open-favorites');
  await waitForId('favorites-sheet');
  await tap('favorites-sheet-handle');
  await tap('collections-view-folders');
  await tap('collections-places-folders');
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
  // System now starts with the frequent update action and any unhealthy
  // sources. Server is below them; scroll inside the sheet to reach its field.
  await tapAfterScroll('server-origin', 'settings-sheet');
  await replaceText('server-origin', FIXTURE_ORIGIN);
  // The keyboard can clip Save behind the sheet's sticky Back button.
  await dismissKeyboard();
  await tapAfterScroll('server-save', 'settings-sheet');
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
  await tap('search-result-0');
  await waitForId('destination-sheet');
  // The Android emulator sometimes leaves its IME on screen after SearchBar
  // blurred and dismissed the input, while the destination card is already
  // open. Recover this host-only failure with Back; still require that the card
  // remains open. A search-specific run can require the automatic dismissal.
  if (process.env.ATLAS_ANDROID_STRICT_SEARCH_IME === '1') {
    await waitFor('search result selection to hide the keyboard', keyboardShown, (shown) => !shown);
  } else if (keyboardShown()) {
    await delay(1500);
    if (keyboardShown()) {
      console.log('Android regression: recovering a stuck emulator keyboard after search pick');
      await dismissKeyboard();
      await waitForId('destination-sheet');
    }
  }
  await tap('destination-save');
  await waitForId('destination-edit');
  await tap('destination-cancel');
}

/** Save a screenshot on a passing run, for layouts a window dump cannot judge. */
function keepScreenshot(name) {
  try {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(artifactsDir, name),
      command(['exec-out', 'screencap', '-p'], { encoding: null }),
    );
  } catch {
    // A missing picture is not a failed regression.
  }
}

function dynamicId(xml, pattern, label) {
  const result = nodeIds(xml).find((id) => pattern.test(id));
  if (!result) throw new Error(`Could not find ${label} in accessibility hierarchy`);
  return result;
}

async function createFolderAndReadPlace() {
  await openCollectionsAtRoot();
  // The name field is folded behind "＋ New folder" and takes focus as it opens.
  await tap('folder-new');
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
  const folderId = dynamicId(xml, /^folder-row-[0-9a-f-]+$/i, 'folder row').slice(
    'folder-row-'.length,
  );
  // Pin labels: a tap, not typing — the switch is a synced setting, and
  // verifyPersistence reads it back after a process restart. It sits in the
  // open folder's header, so open the folder and come back.
  await tap(`folder-open-${folderId}`);
  await tap(`folder-more-${folderId}`);
  await tap(`folder-labels-${folderId}`);
  await tap(`folder-more-${folderId}`);
  await waitFor('folder pin labels switched on', hierarchy, (value) =>
    isChecked(nodeForId(value, `folder-labels-${folderId}`)),
  );
  shell('input', 'keyevent', 'KEYCODE_BACK');
  await tap('collections-back');
  await waitForId(`folder-row-${folderId}`);
  return {
    folderId,
    placeId: dynamicId(
      xml,
      /^favorite-(?!style-|visible-|edit-|nav-)[0-9a-f-]+$/i,
      'saved place row',
    ).slice('favorite-'.length),
  };
}

async function verifyCollectionBrowsing({ placeId, folderId }) {
  let xml = hierarchy();
  if (nodeForId(xml, `drag-${placeId}`) || nodeForId(xml, `drag-${folderId}`))
    throw new Error('Drag handles must start hidden');
  await tap(`favorite-more-${placeId}`);
  await tap(`favorite-quick-${placeId}`);
  await waitForId(`quick-place-${placeId}`);
  await tap('collections-more');
  await tap('collections-reorder');
  await waitForId(`drag-${folderId}`);
  await tap('collections-reorder-done');
  await waitForId(`drag-${folderId}`, false);
  await tap('collections-view-places');
  await tap('places-sort');
  await tap('places-sort-option-recent');
  await waitForId(`favorite-${placeId}`);
  await tap('collections-places-folders');
  // Hold the place's name, then move it into the folder without exposing a grip.
  xml = await waitForId(`favorite-${placeId}`);
  const from = visibleNode(xml, `favorite-${placeId}`).bounds;
  const to = visibleNode(xml, `folder-row-${folderId}`).bounds;
  const x = Math.round((from.left + from.right) / 2);
  const y = Math.round((from.top + from.bottom) / 2);
  const targetY = Math.round((to.top + to.bottom) / 2);
  shell('input', 'motionevent', 'DOWN', String(x), String(y));
  await delay(600);
  for (let step = 1; step <= 8; step++) {
    shell(
      'input',
      'motionevent',
      'MOVE',
      String(x),
      String(Math.round(y + ((targetY - y) * step) / 8)),
    );
    await delay(35);
  }
  shell('input', 'motionevent', 'UP', String(x), String(targetY));
  await tap(`folder-open-${folderId}`);
  await waitForId(`favorite-${placeId}`);
  keepScreenshot('collections-held-place.png');
  // Restore its folder through the normal editor so later scenarios keep their fixture.
  await tap(`favorite-more-${placeId}`);
  await tap(`favorite-edit-${placeId}`);
  await tapAfterScroll(`favorite-folder-${placeId}-none`, 'collections-scroll');
  await tapAfterScroll(`favorite-save-${placeId}`, 'collections-scroll');
  await tap('collections-back');
  await waitForId(`favorite-${placeId}`);
  keepScreenshot('collections-places.png');
}

function isChecked(node) {
  return Boolean(node?.includes('checked="true"') || node?.includes('selected="true"'));
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
  await openCollectionsAtRoot();
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

/** Exercise the map editor before the ordinary two-stop navigation hand-off. */
async function editRouteOnMap() {
  // MapLibre draws ViewAnnotations, but UiAutomator cannot see their testIDs.
  // Exercise the map tap itself, then use the accessible list for point actions.
  const sheet = visibleNode(hierarchy(), 'route-sheet')?.bounds;
  if (!sheet) throw new Error('Route sheet is missing during map editing');
  // Add in open map space, remove that point from the list, then undo both edits.
  shell(
    'input',
    'tap',
    String(Math.round(sheet.left + sheet.width * 0.16)),
    String(Math.round(sheet.top * 0.22)),
  );
  const added = await waitFor(
    'map tap to add a stop',
    hierarchy,
    (window) => stopCount(window) === 3,
  );
  const actions = nodeIds(added).filter((id) => id.startsWith('route-wp-actions-'));
  if (actions.length !== 3) throw new Error('The three route stops have no list actions');
  await tapAfterScroll(actions[2], 'route-scroll');
  await tapAfterScroll('route-list-point-remove', 'route-scroll');
  await waitFor('point menu to remove a stop', hierarchy, (window) => stopCount(window) === 2);
  await tapAfterScroll('route-undo', 'route-scroll', 'down');
  await waitFor('undo to restore the added stop', hierarchy, (window) => stopCount(window) === 3);
  await tapAfterScroll('route-undo', 'route-scroll', 'down');
  const restored = await waitFor(
    'undo to restore two stops',
    hierarchy,
    (window) => stopCount(window) === 2,
  );
  const firstActions = nodeIds(restored).find((id) => id.startsWith('route-wp-actions-'));
  if (!firstActions) throw new Error('The first route stop has no list actions');
  await tapAfterScroll(firstActions, 'route-scroll');
  await tapAfterScroll('route-list-point-straight', 'route-scroll');
  await waitForId('route-navigate', false);
  await tapAfterScroll('route-undo', 'route-scroll', 'down');
  await waitForId('route-navigate');
}

async function planRoadRoute(folderId, placeId) {
  await openRouteFromSavedPlace(placeId);
  await editRouteOnMap();
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
  // The journeys list below the stops and the time controls, under the half sheet's
  // edge. `uiautomator dump` still listed the first row there (clipped to inverted bounds),
  // and this step once passed on that alone; the warm UiAutomator server drops nodes clipped
  // away entirely, so prove the result by scrolling to it.
  await waitForIdAfterScroll('transit-trip-0', 'route-scroll', 'up', 30_000);
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
  await openCollectionsAtRoot();
  await tap(`folder-open-${folderId}`);
  const xml = await waitFor('saved track row inside folder', hierarchy, (value) =>
    nodeIds(value).some((id) => /^track-(?!visible-|edit-|plan-|export-)[0-9a-f-]+$/i.test(id)),
  );
  const id = dynamicId(
    xml,
    /^track-(?!visible-|edit-|plan-|export-)[0-9a-f-]+$/i,
    'saved track row',
  ).slice('track-'.length);
  await tap(`track-${id}`);
  const profile = await waitForId('track-profile-distance');
  if (!windowStrings(profile).some((value) => /^Total distance: [\d.]+ (?:m|km)$/.test(value))) {
    throw new Error('Saved track profile did not show its total distance');
  }
  await tap('track-profile-close');
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

  // A restart starts Collections at the top level: the place and the folder
  // are there, the track and the folder's label switch are inside it.
  await openMenuItem('open-favorites');
  await tap('favorites-sheet-handle');
  let xml = await waitForId(`folder-row-${folderId}`);
  expectIds(xml, [`quick-place-${placeId}`]);
  if (!nodeForId(xml, `favorite-${placeId}`)) {
    throw new Error(`Saved place ${placeId} did not survive process restart`);
  }
  tapId(xml, `folder-open-${folderId}`);
  xml = await waitForId(`track-${trackId}`);
  expectIds(xml, [`track-${trackId}`, 'collections-back']);
  // The open folder's header and action chips are a layout, not text.
  keepScreenshot('collections-folder.png');
  await tap(`folder-more-${folderId}`);
  xml = await waitForId(`folder-labels-${folderId}`);
  if (!isChecked(nodeForId(xml, `folder-labels-${folderId}`))) {
    throw new Error(
      `Folder pin labels did not persist: ${nodeForId(xml, `folder-labels-${folderId}`)}`,
    );
  }
  shell('input', 'keyevent', 'KEYCODE_BACK');
  await tap('favorites-close');
}

async function verifySavedCollectionSearch({ folderId, trackId }) {
  for (const [query, rowId] of [
    ['regression folder', `folder-row-${folderId}`],
    ['regression track', `track-${trackId}`],
  ]) {
    await tap('search-open');
    await replaceText('search-input', query);
    await waitForId('search-result-0', true, 20_000);
    await tap('search-result-0');
    await waitForId('favorites-sheet');
    await waitForId(rowId);
    await waitFor('search reveal to leave Collections unfiltered', hierarchy, (xml) => {
      const field = nodeForId(xml, 'collections-filter');
      // UiAutomator reports a blank TextInput's placeholder as its text.
      return Boolean(field && /text="(?:|Search folders and places)"/.test(field));
    });
    await tap('favorites-close');
  }
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
  // Keep the same 411×914 dp phone viewport with one third as many pixels for
  // SwiftShader to draw. This AVD has no GPU; the original 1080×2400 frame
  // competes with the app and IME on the same four host cores.
  shell('wm', 'size', '720x1600');
  shell('wm', 'density', '280');
  for (const scale of [
    'window_animation_scale',
    'transition_animation_scale',
    'animator_duration_scale',
  ]) {
    shell('settings', 'put', 'global', scale, '0');
  }
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
  console.log('Android regression: Places, Quick access, sorting and hold-to-reorder');
  await verifyCollectionBrowsing(ids);
  await tap('favorites-close');
  console.log('Android regression: road planning, sheet snaps, and navigation hand-off');
  await planRoadRoute(ids.folderId, ids.placeId);
  console.log('Android regression: transit planning and guidance hand-off');
  await planTransitJourney(ids.placeId);
  console.log('Android regression: persisted settings and saved-data restart');
  await setDarkTheme();
  const trackId = await recordTrackId(ids.folderId);
  await verifyPersistence({ ...ids, trackId });
  console.log('Android regression: main search reveals saved folder and track');
  await verifySavedCollectionSearch({ folderId: ids.folderId, trackId });
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
  for (const [reader, { count, ms }] of windowReads) {
    console.log(
      `Android regression: ${count} window reads by ${reader}, ${(ms / 1000).toFixed(0)} s in all (${(ms / count / 1000).toFixed(2)} s each)`,
    );
  }
  try {
    shell('settings', 'put', 'system', 'user_rotation', '0');
  } catch {
    // The emulator may have stopped; the original failure is more useful.
  }
}
