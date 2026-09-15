import { expect, test } from '@playwright/test';
import { mockSearch, waitForMap } from './helpers';

const LAYER = {
  id: 'hillshade',
  rev: 1,
  title: 'Hillshade',
  description: 'Terrain relief shading.',
  group: 'Terrain',
  attribution: '© Kartverket',
  maxzoom: 15,
  defaultOpacity: 0.35,
  identify: false,
};

test('settings areas own layers and profile layout while map controls stay in one grid', async ({
  page,
}) => {
  await page.route('**/api/layers', (route) => route.fulfill({ json: { layers: [LAYER] } }));
  await page.goto('/');
  await waitForMap(page);

  const grid = page.locator('.map-control-grid');
  await expect(grid).toHaveCSS('display', 'grid');
  await expect(grid.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(grid.getByRole('button', { name: 'Zoom out' })).toBeVisible();
  await expect(grid.getByRole('button', { name: 'Find my location' })).toBeVisible();
  await expect(grid.getByRole('button', { name: 'Map layers' })).toBeVisible();

  const cells = await Promise.all(
    ['.profile-switch', '.layer-switch', '.map-zoom-controls', '.map-locate-control'].map(
      (selector) => grid.locator(selector).boundingBox(),
    ),
  );
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i]!;
      const b = cells[j]!;
      const overlaps =
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      expect(overlaps).toBe(false);
    }
  }

  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-panel');
  // The tab names come from the shared settings-section list, so they are also
  // the row names Android shows.
  await expect(settings.getByRole('tab')).toHaveText([
    'Appearance',
    'Map layers',
    'Activity profiles',
    'Navigation',
    'Account & data',
    'System',
  ]);
  await settings.getByRole('tab', { name: 'Map layers' }).click();
  await expect(settings.getByText('Hillshade', { exact: true })).toBeVisible();

  await settings.getByRole('tab', { name: 'Activity profiles' }).click();
  const ski = settings.locator('.profile-settings-card').filter({ hasText: 'Ski' });
  await ski.getByRole('checkbox', { name: 'Quick switcher' }).uncheck();
  await expect(grid.getByRole('radio', { name: 'Ski' })).toHaveCount(0);

  const hike = settings.locator('.profile-settings-card').filter({ hasText: 'Hike' });
  await hike.getByRole('checkbox', { name: 'Hillshade' }).check();
  await expect(hike.getByRole('checkbox', { name: 'Hillshade' })).toBeChecked();

  await settings.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(page.locator('.sidebar .layers-section')).toHaveCount(0);
});

test('saving a search hit keeps its address on the card and in the editor', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/');
  await waitForMap(page);

  await page.getByPlaceholder('Search places').fill('Preikestolen');
  await page.getByRole('option', { name: /Preikestolen/ }).click();
  const card = page.locator('.place-card');
  await expect(card).toContainText('Preikestolvegen 521, 4105 Jørpeland');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  // A search hit arrives with a name, so nothing opens by itself; the card's
  // own Edit action is the way into the editor for it.
  await card.getByRole('button', { name: 'Edit', exact: true }).click();

  await expect(page.locator('.place-edit-dialog')).toBeVisible();
  await expect(page.getByLabel('Address')).toHaveValue('Preikestolvegen 521, 4105 Jørpeland');
});

test('arrow keys pan the map without requiring canvas focus', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);

  const before = await page.evaluate(() => window.__atlasMap!.getCenter().lng);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ArrowRight');

  await expect
    .poll(() => page.evaluate(() => window.__atlasMap!.getCenter().lng))
    .toBeGreaterThan(before);
});
