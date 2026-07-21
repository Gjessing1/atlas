import { expect, test } from '@playwright/test';
import { waitForMap } from './helpers';

// OPFS storage is per-browser-context and single-tab (exclusive SAH-pool file
// handles), so this journey uses one context and never keeps two pages open.
// A pin saved from the place card is named by its coordinates.
const COORDS = /^-?\d+\.\d{5}, -?\d+\.\d{5}$/;

test('a saved pin survives closing the tab and reopening', async ({ page, context }) => {
  await page.goto('/');
  await waitForMap(page);
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // The card confirms in place; the sidebar has to be opened to see the row.
  await expect(page.getByRole('button', { name: '★ Saved' })).toBeVisible();
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
