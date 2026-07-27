import { expect, test, type Page } from '@playwright/test';
import { waitForMap } from './helpers';

// OPFS storage is per-browser-context and single-tab (exclusive SAH-pool file
// handles), so these journeys share one context. The second test deliberately
// breaks the one-page rule — being second is a state the app has to explain
// and recover from, not one it may leave the user stuck in.
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
