// Native React Native interaction helpers. Read ../e2e/README.md before driving a device.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const APP = 'io.gjessing.atlas';
export const SIZES = {
  'phone-small': { size: '720x1280', density: 320 },
  phone: { size: '720x1600', density: 280 },
  'phone-large': { size: '1008x2244', density: 360 },
  tablet: { size: '1600x2560', density: 320 },
};

export function nodes(xml) {
  return [...xml.matchAll(/<node\b[^>]*>/g)].map(([tag]) => {
    const attrs = Object.fromEntries(
      [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    const box = attrs.bounds?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    return { ...attrs, box: box ? box.slice(1).map(Number) : null };
  });
}

export function createDevice(serial) {
  const executable =
    process.env.ADB ??
    join(process.env.ANDROID_HOME ?? join(homedir(), 'android-sdk'), 'platform-tools/adb');
  let interrupted = false;
  function check() {
    if (interrupted) throw new Error('Review interrupted');
  }
  function adb(...args) {
    const result = spawnSync(executable, ['-s', serial, ...args], {
      timeout: 30_000,
      maxBuffer: 48 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `adb ${args.join(' ')}: ${result.error?.message ?? result.stderr?.toString().trim() ?? result.status}`,
      );
    }
    return result.stdout;
  }
  const shell = (...args) =>
    adb('shell', ...args)
      .toString()
      .trim();
  // Reuse the warm reader supplied by an Ally-X session; local ADB needs no server.
  let server = process.env.UIAUTOMATOR2_URL;
  let session;
  function request(method, path, body) {
    const result = spawnSync(
      'curl',
      [
        '--silent',
        '--show-error',
        '--fail',
        '--max-time',
        '30',
        '-X',
        method,
        ...(body ? ['-H', 'content-type: application/json', '--data', JSON.stringify(body)] : []),
        `${server}${path}`,
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message ?? result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  }
  function close() {
    if (server && session) {
      try {
        request('DELETE', `/wd/hub/session/${session}`);
      } catch {
        /* wrapper also stops its server */
      }
      session = undefined;
    }
  }
  function hierarchy({ requireApp = true, checkInterrupt = true } = {}) {
    if (checkInterrupt) check();
    let xml;
    if (server) {
      try {
        if (!session) {
          session = request('POST', '/wd/hub/session', {
            capabilities: { alwaysMatch: { platformName: 'Android' } },
          }).sessionId;
          request('POST', `/wd/hub/session/${session}/appium/settings`, {
            settings: { waitForIdleTimeout: 10_000 },
          });
        }
        xml = request('GET', `/wd/hub/session/${session}/source`)
          .value.replace(/<\/(?!hierarchy>)[\w.$-]+>/g, '</node>')
          .replace(/<(?![?/]|hierarchy\b)[\w.$-]+((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g, '<node$1$2>');
      } catch (error) {
        close();
        server = undefined;
        console.warn(`Warm UiAutomator unavailable: ${error.message}; using adb dump`);
      }
    }
    if (!xml) {
      shell('uiautomator', 'dump', '/sdcard/atlas-review-window.xml');
      xml = adb('exec-out', 'cat', '/sdcard/atlas-review-window.xml').toString();
    }
    if (requireApp && !xml.includes(`package="${APP}"`))
      throw new Error(
        'Atlas is not the visible app; inspect the failure screenshot for a system dialog or crash',
      );
    return xml;
  }
  function visible(xml, id) {
    return nodes(xml).find(
      (node) =>
        node['resource-id'] === id &&
        node.enabled !== 'false' &&
        node.box &&
        node.box[2] - node.box[0] > 8 &&
        node.box[3] - node.box[1] > 8,
    );
  }
  async function waitFor(id, timeout = 25_000) {
    const deadline = Date.now() + timeout;
    let previous;
    do {
      const node = visible(hierarchy(), id);
      // Reading twice prevents tapping the old position of an animating bottom sheet.
      if (node && JSON.stringify(node.box) === previous) return node;
      previous = node ? JSON.stringify(node.box) : undefined;
      await delay(350);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${id} to be visible and settled`);
  }
  async function tap(id) {
    const {
      box: [left, top, right, bottom],
    } = await waitFor(id);
    shell(
      'input',
      'tap',
      String(Math.round((left + right) / 2)),
      String(Math.round((top + bottom) / 2)),
    );
  }
  async function scrollTo(id, container) {
    for (let i = 0; i < 9; i++) {
      const xml = hierarchy();
      if (visible(xml, id)) return tap(id);
      const node = visible(xml, container);
      if (!node) {
        await delay(500);
        continue;
      }
      const [left, top, right, bottom] = node.box;
      const x = String(Math.round((left + right) / 2));
      // Keep the swipe clear of a sheet's handle and sticky footer.
      shell(
        'input',
        'swipe',
        x,
        String(Math.round(top + (bottom - top) * 0.75)),
        x,
        String(Math.round(top + (bottom - top) * 0.3)),
        '400',
      );
      await delay(400);
    }
    throw new Error(`Cannot reach ${id} inside ${container}`);
  }
  async function launch() {
    check();
    shell('am', 'force-stop', APP);
    shell('am', 'start', '-W', '-n', `${APP}/.MainActivity`);
    const deadline = Date.now() + 60_000;
    let dismissedDraft = false;
    while (Date.now() < deadline) {
      const xml = hierarchy();
      // Atlas restores unfinished plans across cold launches. Close the draft through
      // its normal UI so the next recipe can reach the idle map controls.
      if (!dismissedDraft && visible(xml, 'route-close')) {
        await tap('route-close');
        dismissedDraft = true;
      } else if (visible(xml, 'open-menu')) {
        await waitFor('open-menu');
        // The native map may load after React has drawn its controls.
        await delay(2000);
        return;
      }
      await delay(500);
    }
    throw new Error('Timed out waiting for the idle map after closing a restored planner');
  }
  async function runStep(step) {
    check();
    if (step.tap) return tap(step.tap);
    if (step.wait) return waitFor(step.wait);
    if (step.scrollTo) return scrollTo(step.scrollTo, step.within);
    if (step.mapPoint) {
      const {
        box: [left, top, right],
      } = await waitFor('open-menu');
      const x = String(Math.round((left + right) / 2 + 100));
      const y = String(Math.round(top * 0.35));
      shell('input', 'swipe', x, y, x, y, '900');
      return waitFor('destination-sheet');
    }
    throw new Error(`Unknown review step: ${JSON.stringify(step)}`);
  }
  async function stableScreenshot() {
    let png = adb('exec-out', 'screencap', '-p');
    let matches = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      check();
      await delay(700);
      const next = adb('exec-out', 'screencap', '-p');
      matches = next.equals(png) ? matches + 1 : 0;
      png = next;
      if (matches === 2) return { png, settled: true };
    }
    return { png, settled: false };
  }
  function snapshot() {
    const setting = (key) => shell('settings', 'get', 'system', key);
    return {
      size: shell('wm', 'size').match(/Override size: (\S+)/)?.[1] ?? 'reset',
      density: shell('wm', 'density').match(/Override density: (\S+)/)?.[1] ?? 'reset',
      accelerometer_rotation: setting('accelerometer_rotation'),
      user_rotation: setting('user_rotation'),
    };
  }
  function configure(profile, landscape) {
    shell('wm', 'size', profile.size);
    shell('wm', 'density', String(profile.density));
    shell('settings', 'put', 'system', 'accelerometer_rotation', '0');
    shell('settings', 'put', 'system', 'user_rotation', landscape ? '1' : '0');
  }
  function restore(original) {
    const errors = [];
    const attempt = (fn) => {
      try {
        fn();
      } catch (error) {
        errors.push(error.message);
      }
    };
    attempt(() => shell('am', 'force-stop', APP));
    for (const key of ['size', 'density']) attempt(() => shell('wm', key, original[key]));
    for (const key of ['accelerometer_rotation', 'user_rotation']) {
      attempt(() =>
        original[key] === 'null'
          ? shell('settings', 'delete', 'system', key)
          : shell('settings', 'put', 'system', key, original[key]),
      );
    }
    return errors;
  }
  return {
    adb,
    shell,
    hierarchy,
    launch,
    runStep,
    stableScreenshot,
    snapshot,
    configure,
    restore,
    close,
    interrupt: () => {
      interrupted = true;
    },
    check,
  };
}
