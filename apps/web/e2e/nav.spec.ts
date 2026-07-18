import { expect, test } from '@playwright/test';
import { mockRouting, waitForMap } from './helpers';

/**
 * Turn-by-turn web navigation: geolocation is mocked at the browser level and
 * routing at the network level, so the spec exercises the real hook, banner,
 * map layers and camera-follow logic.
 */
test.use({
  geolocation: { latitude: 59.91, longitude: 10.75 },
  permissions: ['geolocation'],
});

test('navigate to a dropped pin: banner, route line, live progress, End', async ({
  page,
  context,
}) => {
  await mockRouting(page);
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);

  // Start navigation from the pin popup.
  await page.locator('.place-marker').click();
  await page.getByRole('button', { name: 'Navigate' }).click();

  // Banner up, guidance summary showing, route drawn, puck snapped to the line.
  await expect(page.locator('.nav-banner')).toBeVisible();
  await expect(page.locator('.nav-summary')).toContainText('arrive');
  await page.waitForFunction(() => Boolean(window.__atlasMap!.getSource('atlas-nav')));
  await expect(page.locator('.nav-puck')).toBeVisible();
  await expect(page.locator('.nav-dest-marker')).toBeVisible();

  // A fix near the destination arrives → the session declares arrival.
  await context.setGeolocation({ latitude: 59.9199, longitude: 10.7599 });
  await expect(page.locator('.nav-maneuver')).toContainText('You have arrived');

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.nav-banner')).toHaveCount(0);
});

test('geolocation denied shows an error state, End dismisses it', async ({ page, context }) => {
  await mockRouting(page);
  await context.clearPermissions();
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);

  await page.locator('.place-marker').click();
  await page.getByRole('button', { name: 'Navigate' }).click();

  await expect(page.locator('.nav-error')).toBeVisible();
  await page.getByRole('button', { name: 'End' }).click();
  await expect(page.locator('.nav-banner')).toHaveCount(0);
});
