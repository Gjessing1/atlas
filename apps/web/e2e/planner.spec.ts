import { expect, test } from '@playwright/test';
import { mockRouting, project, waitForMap } from './helpers';

test('map planner adds, inserts, drags, removes and undoes points', async ({ page }) => {
  await mockRouting(page);
  await page.goto('/#map=14/59.91/10.75&route=hike/59.905,10.745/59.913,10.752');
  await waitForMap(page);
  await expect(page.locator('.route-waypoint-marker')).toHaveCount(2);
  await expect(page.locator('.route-stats')).toBeVisible();

  // Empty map space appends; the routed line inserts into its own leg.
  await page.mouse.click(500, 170);
  await expect(page.locator('.route-waypoint-marker')).toHaveCount(3);
  await expect(page.locator('.route-stats')).toBeVisible();
  const [x, y] = await project(page, 59.909, 10.7485);
  await page.mouse.click(x, y);
  await expect(page.locator('.route-waypoint-marker')).toHaveCount(4);

  const marker = page.locator('.route-waypoint-marker').nth(3);
  const box = await marker.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 - 30, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo point edit' })).toBeEnabled();

  await page.locator('.route-waypoint-marker').nth(3).click();
  await page.locator('.route-point-actions').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.route-waypoint-marker')).toHaveCount(3);
  await page.getByRole('button', { name: 'Undo point edit' }).click();
  await expect(page.locator('.route-waypoint-marker')).toHaveCount(4);

  await page.locator('.route-waypoint-marker').first().click();
  await page
    .locator('.route-point-actions')
    .getByRole('button', { name: 'Straight line to next' })
    .click();
  await expect(page.getByRole('button', { name: 'Start navigation' })).toBeDisabled();
  await expect(page.locator('.route-leg-tag')).toHaveCount(1);
});

test('a 390 px map builds and trims a ten-point plan', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRouting(page);
  await page.goto('/#map=14/59.91/10.75&route=hike/59.905,10.745/59.913,10.752');
  await waitForMap(page);
  await expect(page.locator('.route-waypoint-marker')).toHaveCount(2);
  for (let i = 0; i < 8; i++) {
    await page.mouse.click(115 + (i % 3) * 70, 165 + Math.floor(i / 3) * 65);
    await expect(page.locator('.route-waypoint-marker')).toHaveCount(i + 3);
  }
  const exposedPoint = await page.evaluate(() => {
    const panelTop = document.querySelector('.route-panel')!.getBoundingClientRect().top;
    return [...document.querySelectorAll('.route-waypoint-marker')].findIndex(
      (marker) => marker.getBoundingClientRect().bottom < panelTop - 8,
    );
  });
  expect(exposedPoint).toBeGreaterThanOrEqual(0);
  await page.locator('.route-waypoint-marker').nth(exposedPoint).click();
  await page.locator('.route-point-actions').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.route-waypoint-marker')).toHaveCount(9);
  await page.getByRole('button', { name: 'Undo point edit' }).click();
  await expect(page.locator('.route-waypoint-marker')).toHaveCount(10);
});
