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
          {
            id: 'poi_r20',
            type: 'symbol',
            source: 'roads',
            layout: { 'text-field': 'POI', 'text-size': 10, 'icon-size': 1 },
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

  // The style editor is applied after theme/profile tuning and persists with
  // the rest of the device-local map appearance.
  await page.getByLabel('Land color').fill('#123456');
  await page.getByLabel('Label size').fill('125');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__atlasMap!.getStyle().layers?.find((layer) => layer.id === 'background')?.paint?.[
            'background-color'
          ],
      ),
    )
    .toBe('#123456');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__atlasMap!.getStyle().layers?.find((layer) => layer.id === 'poi_r20')?.layout?.[
            'text-size'
          ],
      ),
    )
    .toBe(12.5);

  await page.reload();
  await waitForMap(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__atlasMap!.getStyle().layers?.find((layer) => layer.id === 'background')?.paint?.[
            'background-color'
          ],
      ),
    )
    .toBe('#123456');
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
  await expect(card.getByRole('button', { name: 'Directions' })).toBeVisible();
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

test('a place with no article of its own shows nearby photos and places', async ({ page }) => {
  // The user's own case: a town hall Wikipedia has never written about.
  await page.route('**/api/place-content?**', (route) => route.fulfill({ json: { content: [] } }));
  await page.route('**/api/place-photos**', (route) =>
    route.fulfill({
      json: {
        photos: [
          {
            title: 'Torvveien 9',
            url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
            width: 480,
            height: 320,
            pageUrl: 'https://commons.example/Torvveien',
            distanceM: 39,
            credit: 'Ssu · CC BY-SA 4.0',
          },
        ],
      },
    }),
  );
  await page.route('**/api/place-content/nearby**', (route) =>
    route.fulfill({
      json: {
        places: [
          {
            title: 'Asker station',
            extract: 'A railway station in downtown Asker.',
            url: 'https://no.wikipedia.org/wiki/Asker_stasjon',
            language: 'no',
            position: { lat: 59.8336, lng: 10.4344 },
            distanceM: 23,
          },
        ],
      },
    }),
  );
  await page.goto('/#map=17/59.83365/10.43485');
  await waitForMap(page);
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  const card = page.locator('.place-card');

  // Photos of the area stand in for the picture the place itself does not have,
  // and each tile says how far off it was taken.
  await expect(card.locator('.place-card-photo-strip a')).toHaveCount(1);
  await expect(card.locator('.place-card-photos')).toContainText('39 m');

  // The nearby list is behind its own toggle — one round trip, on request.
  await card.getByRole('button', { name: /Nearby places/ }).click();
  const row = card.locator('.place-card-nearby li button').first();
  await expect(row).toContainText('Asker station');
  await expect(row).toContainText('23 m away');

  // Picking one re-aims the whole card at that place.
  await row.click();
  await expect(card.locator('.place-card-titles strong')).toHaveText('Asker station');
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

test('sharing a place hands out the pin, the coordinates and the Atlas link', async ({ page }) => {
  // Capture whatever goes to the OS share sheet. Without this the browser has
  // no navigator.share and the card falls back to the clipboard, which needs
  // per-browser permissions to read back.
  await page.addInitScript(() => {
    (window as unknown as { __shared: string[] }).__shared = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: { text?: string }) => {
        (window as unknown as { __shared: string[] }).__shared.push(data.text ?? '');
        return Promise.resolve();
      },
    });
  });
  await page.goto('/#map=13/59.5/10.5&pin=59.5/10.5');
  await waitForMap(page);
  await page.locator('.place-card').getByRole('button', { name: 'Share' }).click();

  await page.waitForFunction(
    () => (window as unknown as { __shared: string[] }).__shared.length > 0,
  );
  const shared = await page.evaluate(
    () => (window as unknown as { __shared: string[] }).__shared[0]!,
  );
  // The pin must survive: a share link that only carries `map=` puts the
  // recipient near the spot instead of on it.
  expect(shared).toContain('pin=59.5/10.5');
  // And the payload must be usable by someone who does not have Atlas.
  expect(shared).toContain('59.50000, 10.50000');
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

test('Explore browses the map view by category and opens place guide content', async ({ page }) => {
  await page.route('**/api/explore**', (route) =>
    route.fulfill({
      json: {
        results: [
          {
            name: 'Fuglen',
            label: 'Cafe, Oslo',
            position: { lat: 59.9161, lng: 10.746 },
            kind: 'amenity/cafe',
            distanceM: 420,
          },
        ],
      },
    }),
  );
  await page.route('**/api/place-content**', (route) =>
    route.fulfill({
      json: {
        content: [
          {
            source: 'wikipedia',
            language: 'en',
            title: 'Fuglen',
            extract: 'A coffee bar and design shop in central Oslo.',
            url: 'https://en.wikipedia.org/wiki/Fuglen',
          },
        ],
      },
    }),
  );
  await page.goto('/');
  await waitForMap(page);

  await page.getByRole('button', { name: 'Explore nearby places' }).click();
  const explore = page.getByRole('complementary', { name: 'Explore nearby places' });
  await explore.getByRole('tab', { name: 'Coffee' }).click();
  await expect(explore).toContainText('Fuglen');
  await explore.getByRole('button', { name: /Fuglen/ }).click();

  const card = page.locator('.place-card');
  await expect(card).toContainText('A coffee bar and design shop in central Oslo.');
  await expect(card.getByRole('link', { name: 'Read article' })).toHaveAttribute(
    'href',
    'https://en.wikipedia.org/wiki/Fuglen',
  );
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

test('running and custom trail preferences reach the routing engine', async ({ page }) => {
  await mockRouting(page);
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Route' }).click();
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByText('Customize Run').click();
  await page.getByRole('checkbox', { name: 'Prefer trails' }).check();

  const customizedRequest = page.waitForRequest((request) => {
    if (!request.url().endsWith('/api/route') || request.method() !== 'POST') return false;
    const body = request.postDataJSON() as {
      costing?: string;
      costing_options?: { pedestrian?: Record<string, unknown> };
    };
    return (
      body.costing === 'pedestrian' &&
      body.costing_options?.pedestrian?.['walking_speed'] === 10 &&
      body.costing_options.pedestrian['use_tracks'] === 1
    );
  });
  const [x1, y1] = await project(page, 59.905, 10.74);
  const [x2, y2] = await project(page, 59.915, 10.76);
  await page.mouse.click(x1, y1);
  await page.mouse.click(x2, y2);

  await customizedRequest;
  await expect(page.locator('.route-stats')).toContainText('km');
});

test('stops along a route are browsed by category and insert in order', async ({ page }) => {
  await mockRouting(page);
  const categories: string[] = [];
  await page.route('**/api/explore**', (route) => {
    categories.push(new URL(route.request().url()).searchParams.get('category') ?? '');
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
    });
  });
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Route' }).click();
  const [x1, y1] = await project(page, 59.905, 10.74);
  const [x2, y2] = await project(page, 59.915, 10.76);
  await page.mouse.click(x1, y1);
  await page.mouse.click(x2, y2);
  await expect(page.locator('.route-stats')).toBeVisible();

  await page.getByRole('button', { name: 'Stops along route' }).click();
  // Driving opens on fuel; the category chips are the whole search.
  await expect.poll(() => categories).toContain('fuel');
  await page.getByRole('tab', { name: 'Coffee' }).click();
  await expect.poll(() => categories).toContain('coffee');

  const hit = page.locator('.route-along-search').getByRole('button', {
    name: /Corridor café/,
  });
  // Measured against the route, not against the query text.
  await expect(hit).toContainText('at ');
  await hit.click();

  await expect(page.locator('.route-waypoints li')).toHaveCount(3);
  await expect(page.locator('.route-waypoints')).toContainText('Corridor café');
});

test('a round trip keeps the stops already planned and rides through them', async ({ page }) => {
  await mockRouting(page);
  const requests: { lat: number; lon: number; type?: string }[][] = [];
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/route') || request.method() !== 'POST') return;
    const body = request.postDataJSON() as { locations?: { lat: number; lon: number }[] };
    if (body.locations) requests.push(body.locations);
  });
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Route' }).click();
  const [x1, y1] = await project(page, 59.905, 10.74);
  const [x2, y2] = await project(page, 59.915, 10.76);
  await page.mouse.click(x1, y1);
  await page.mouse.click(x2, y2);
  await expect(page.locator('.route-stats')).toBeVisible();

  // Ticking "round trip" used to throw the destination away and draw an
  // arbitrary loop from the start; both stops must survive it.
  await page.getByRole('checkbox', { name: 'Round trip' }).check();
  await expect(page.locator('.route-waypoints li')).toHaveCount(2);
  await expect(page.locator('.route-waypoints li').first()).toContainText('A');
  await expect(page.locator('.route-waypoints li').nth(1)).toContainText('B');

  // The loop query: both planned stops as real stops, shaping points to fill
  // the requested distance, and home to the start.
  await expect
    .poll(() => {
      const last = requests.at(-1) ?? [];
      return last.length > 3 && last.filter((l) => l.type !== 'through').length === 3;
    })
    .toBe(true);
  const loop = requests.at(-1)!;
  expect(loop[0]!.lat).toBeCloseTo(loop.at(-1)!.lat, 4);
  // The planned destination is a stop, not a shaping point.
  expect(loop[1]!.type).toBe('break');
  expect(loop.some((l) => l.type === 'through')).toBe(true);
});
