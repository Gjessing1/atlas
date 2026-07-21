import { expect, test } from '@playwright/test';
import { cameraState, mockRouting, mockSearch, project, waitForMap } from './helpers';

test('cold load shows the map at the default Oslo view', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  await expect(page.getByPlaceholder('Search places')).toBeVisible();
  const cam = await cameraState(page);
  expect(cam.zoom).toBeCloseTo(5, 0);
  expect(cam.lat).toBeCloseTo(59.91, 1);
  expect(cam.lng).toBeCloseTo(10.75, 1);
});

test('dark mode themes the UI and basemap, persists, and profiles change map emphasis', async ({
  page,
}) => {
  // The Playwright container deliberately mounts only the checkout, not the
  // host's /mnt/data style assets. Supply the smallest Liberty-shaped style
  // that exercises Atlas's client-side variants.
  await page.route('**/assets/styles/liberty.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        name: 'Theme fixture',
        sources: {
          roads: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
          {
            id: 'road_path_pedestrian',
            type: 'line',
            source: 'roads',
            minzoom: 14,
            paint: { 'line-color': '#fff', 'line-width': 2 },
          },
          {
            id: 'road_service_track',
            type: 'line',
            source: 'roads',
            paint: { 'line-color': '#fff', 'line-width': 2 },
          },
        ],
      }),
    }),
  );
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Dark' }).click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(() => page.evaluate(() => window.__atlasMap!.getStyle().name))
    .toBe('Atlas Dark · explore');
  expect(
    await page
      .locator('.settings-panel')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(36, 43, 48)');

  // The cartographic pass is part of every variant: paths are reddish dashed,
  // and a separately-filtered brown dashed track overlay survives style swaps.
  const contrast = await page.evaluate(() => {
    const style = window.__atlasMap!.getStyle();
    const path = style.layers?.find((layer) => layer.id === 'road_path_pedestrian');
    const track = style.layers?.find(
      (layer) => layer.id === 'atlas-road_service_track-track-contrast',
    );
    return { path: path?.paint?.['line-dasharray'], track: track?.paint?.['line-dasharray'] };
  });
  expect(contrast.path).toEqual([2, 1.35]);
  expect(contrast.track).toEqual([2.4, 1.4]);

  await page.reload();
  await waitForMap(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: 'Hike' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__atlasMap!.getStyle().name))
    .toBe('Atlas Dark · hike');
  expect(
    await page.evaluate(
      () =>
        window.__atlasMap!.getStyle().layers?.find((layer) => layer.id === 'road_path_pedestrian')
          ?.minzoom,
    ),
  ).toBe(12);
});

test('right-click drops a pin and opens the place card', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('.place-marker')).toBeVisible();
  // A bare pin is titled by its own coordinates, and offers the shared actions.
  const card = page.locator('.place-card');
  await expect(card.locator('strong')).toHaveText(/^-?\d+\.\d{5}, -?\d+\.\d{5}$/);
  await expect(card.getByRole('button', { name: 'Navigate' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Save' })).toBeVisible();
  // The Light row is offline maths, so it is always there and always 24-hour.
  // Elevation is deliberately not asserted: it comes from a live upstream, and a
  // Geonorge outage should fail this suite's *own* subject, not this test.
  await expect(card.locator('.place-card-facts')).toContainText(
    /↑ \d{2}:\d{2} · ↓ \d{2}:\d{2} · \d+ h \d+ min of daylight/,
  );
  // Weather opens the forecast on this spot rather than on the map centre.
  await card.getByRole('button', { name: 'Weather' }).click();
  await expect(page.locator('.weather-panel')).toBeVisible();
  await page.locator('.weather-panel').getByRole('button', { name: 'Close' }).click();
  // Closing the card leaves the pin; removing the pin closes the card.
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.place-marker')).toBeVisible();
  await page.locator('.place-marker').click();
  await page.locator('.place-card').getByRole('button', { name: 'Remove pin' }).click();
  await expect(page.locator('.place-marker')).toHaveCount(0);
  await expect(page.locator('.place-card')).toHaveCount(0);
});

test('saving from the place card flips the button and lists the place', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  const card = page.locator('.place-card');
  await card.getByRole('button', { name: 'Save' }).click();
  // The saved place is found by proximity, so the card knows it is now saved.
  await expect(card.getByRole('button', { name: '★ Saved' })).toBeVisible();
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
  await page.getByPlaceholder('Search places').fill('preikestolen');
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
  await page.getByRole('button', { name: 'Route' }).click();
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

test('search along a route shows detour cost and inserts the stop in order', async ({ page }) => {
  await mockRouting(page);
  await page.route('**/api/search**', (route) =>
    route.fulfill({
      json: {
        results: [
          {
            name: 'Corridor café',
            label: 'Oslo, Norway',
            position: { lat: 59.91, lng: 10.75 },
            kind: 'amenity/cafe',
          },
        ],
      },
    }),
  );
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Route' }).click();
  const [x1, y1] = await project(page, 59.905, 10.74);
  const [x2, y2] = await project(page, 59.915, 10.76);
  await page.mouse.click(x1, y1);
  await page.mouse.click(x2, y2);
  await expect(page.locator('.route-stats')).toBeVisible();

  await page.getByRole('button', { name: 'Search along route' }).click();
  await page.getByPlaceholder('Fuel, food, or a saved place…').fill('cafe');
  const hit = page.locator('.route-along-search').getByRole('button', {
    name: /Corridor café.*detour/,
  });
  await expect(hit).toContainText('+<1 min detour');
  await hit.click();

  await expect(page.locator('.route-waypoints li')).toHaveCount(3);
  await expect(page.locator('.route-waypoints')).toContainText('Corridor café');
});
