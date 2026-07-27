import { expect, test, type Page } from '@playwright/test';
import { waitForMap } from './helpers';

// OPFS storage is per-browser-context and single-tab (exclusive SAH-pool file
// handles), so these journeys share one context. The last two tests
// deliberately break the one-page rule — being second is a state the app has to
// explain and recover from, not one it may leave the user stuck in, and it must
// do so without burning the machine down while it waits.
// A pin saved from the place card is named by its coordinates.
const COORDS = /^-?\d+\.\d{5}, -?\d+\.\d{5}$/;

/** Right-click the map centre and save the resulting pin. */
async function saveCentrePin(page: Page): Promise<void> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: '★ Saved' })).toBeVisible();
}

test('a saved pin survives closing the tab and reopening', async ({ page, context }) => {
  await page.goto('/');
  await waitForMap(page);
  await saveCentrePin(page);
  // The card confirms in place; the sidebar has to be opened to see the row.
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(page.locator('.item-name')).toContainText(COORDS);
  await page.close();

  const page2 = await context.newPage();
  await page2.goto('/');
  await waitForMap(page2);
  await page2.getByRole('button', { name: 'Collections' }).click();
  await expect(page2.locator('.item-name')).toContainText(COORDS);
  // The saved place is also drawn as a marker.
  await expect(page2.locator('.place-marker')).toBeVisible();
});

/**
 * Hold every file in the SAH pool from a worker that takes no owner lock —
 * an older bundle, or a page the browser has not finished tearing down.
 * Resolves with the number of handles held (they stay held until the page is
 * closed).
 */
async function holdStorageHandles(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const source = `(async () => {
          const root = await navigator.storage.getDirectory();
          const pool = await root.getDirectoryHandle('.opfs-sahpool');
          const files = await pool.getDirectoryHandle('.opaque');
          const held = [];
          for await (const entry of files.values()) {
            if (entry.kind === 'file') held.push(await entry.createSyncAccessHandle());
          }
          self.held = held;
          postMessage(held.length);
        })().catch((e) => postMessage(String(e)));`;
        const worker = new Worker(URL.createObjectURL(new Blob([source])));
        worker.onmessage = (e: MessageEvent<number | string>) =>
          typeof e.data === 'number' ? resolve(e.data) : reject(new Error(e.data));
      }),
  );
}

test('a page locked out by handles nobody owns backs off instead of hammering', async ({
  page,
  context,
}) => {
  // The reported failure: flashing chrome and a console full of DOMExceptions.
  // This page holds the owner lock and OPFS still refuses, so "wait for the
  // lock to be released" resolved instantly — nothing held it — and the retry
  // ran as fast as workers could be spawned. Every one of those attempts also
  // runs sqlite's install-failure cleanup, which tries to delete the pool.
  test.setTimeout(90_000);
  await page.goto('/');
  await waitForMap(page);
  // Saving both creates the pool on disk and gives the recovery below
  // something to prove it opened the real database.
  await saveCentrePin(page);
  await page.close();

  await context.route('**/e2e-storage-holder', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>holder</title>' }),
  );
  const holder = await context.newPage();
  await holder.goto('/e2e-storage-holder');
  expect(await holdStorageHandles(holder)).toBeGreaterThan(0);

  const app = await context.newPage();
  let attempts = 0;
  app.on('console', (m) => {
    if (m.text().includes('Persistent storage unavailable')) attempts += 1;
  });
  await app.goto('/');
  const banner = app.locator('.storage-banner');
  await expect(banner).toBeVisible();

  // Poll faster than a retry cycle: the banner must sit still, not unmount and
  // remount behind each attempt.
  await app.evaluate(() => {
    const w = window as unknown as { __bannerFlips: number };
    w.__bannerFlips = 0;
    let last = Boolean(document.querySelector('.storage-banner'));
    setInterval(() => {
      const now = Boolean(document.querySelector('.storage-banner'));
      if (now !== last) {
        w.__bannerFlips += 1;
        last = now;
      }
    }, 50);
  });
  await app.waitForTimeout(12_000);
  expect(
    await app.evaluate(() => (window as unknown as { __bannerFlips: number }).__bannerFlips),
  ).toBe(0);
  // Backing off, not hammering: without it this is one attempt per ~1.2 s.
  expect(attempts).toBeLessThanOrEqual(6);

  // Still a wait rather than a surrender — the handles go, the page opens it,
  // and what it opens is the database that was there all along (every failed
  // attempt was also an attempt by sqlite's cleanup to delete the pool).
  await holder.close();
  await expect(banner).toBeHidden({ timeout: 30_000 });
  await app.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(app.locator('.item-name')).toContainText(COORDS);
});

test('a second tab explains itself and takes over when the first closes', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await waitForMap(page);
  // Saving proves the first page really holds the exclusive OPFS handles.
  await saveCentrePin(page);

  const second = await context.newPage();
  await second.goto('/');
  const banner = second.locator('.storage-banner');
  await expect(banner).toContainText('Atlas is open in another window');
  // Account sign-in is blocked by this, and has to say so rather than sit on
  // "Opening local storage…" forever (the reported bug).
  await second.getByRole('button', { name: 'Settings' }).click();
  await second.getByRole('tab', { name: 'Account' }).click();
  await expect(second.locator('.account-error')).toContainText('already open elsewhere');
  await second.getByRole('button', { name: 'Close panel' }).click();

  await page.close();
  // No reload and no button press: the lock is released and this page opens it.
  await expect(banner).toBeHidden({ timeout: 20_000 });
  await second.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(second.locator('.item-name')).toContainText(COORDS);
});
