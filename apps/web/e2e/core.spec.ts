import { expect, test } from '@playwright/test';
import { cameraState, mockRouting, mockSearch, project, waitForMap } from './helpers';

test('cold load shows the map at the default Oslo view', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  await expect(page.getByPlaceholder('Search places…')).toBeVisible();
  const cam = await cameraState(page);
  expect(cam.zoom).toBeCloseTo(5, 0);
  expect(cam.lat).toBeCloseTo(59.91, 1);
  expect(cam.lng).toBeCloseTo(10.75, 1);
});

test('right-click drops a pin with a working popup', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('.place-marker')).toBeVisible();
  // The popup opens on marker click; it carries coords + actions.
  await page.locator('.place-marker').click();
  await expect(page.locator('.pin-popup code')).toBeVisible();
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.place-marker')).toHaveCount(0);
});

test('share link restores camera and pin; garbage hash falls back', async ({ page }) => {
  await page.goto('/#map=13/59.5/10.5&pin=59.5/10.5');
  await waitForMap(page);
  await expect(page.locator('.place-marker')).toBeVisible();
  const cam = await cameraState(page);
  expect(cam.zoom).toBeCloseTo(13, 0);
  expect(cam.lat).toBeCloseTo(59.5, 2);
  expect(cam.lng).toBeCloseTo(10.5, 2);

  await page.goto('/#map=abc/1/2');
  await page.reload();
  await waitForMap(page);
  expect((await cameraState(page)).zoom).toBeCloseTo(5, 0);
});

test('search result flies the camera and drops the pin', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/');
  await waitForMap(page);
  await page.getByPlaceholder('Search places…').fill('preikestolen');
  await page.getByText('Preikestolen').click();
  await expect(page.locator('.place-marker')).toBeVisible();
  await expect
    .poll(async () => (await cameraState(page)).lat, { timeout: 10_000 })
    .toBeCloseTo(58.9864, 1);
});

test('route planning: two map clicks produce a route with stats', async ({ page }) => {
  await mockRouting(page);
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await page.getByRole('button', { name: '⇄ Route' }).click();
  const [x1, y1] = await project(page, 59.905, 10.74);
  const [x2, y2] = await project(page, 59.915, 10.76);
  await page.mouse.click(x1, y1);
  await page.mouse.click(x2, y2);
  await expect(page.locator('.route-stats')).toContainText('km');
  const hasRouteSource = await page.evaluate(() =>
    Boolean(window.__atlasMap!.getSource('atlas-route')),
  );
  expect(hasRouteSource).toBe(true);
});
