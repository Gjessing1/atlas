import { expect, test } from '@playwright/test';
import type maplibregl from 'maplibre-gl';
import {
  cameraState,
  closePlaceEditor,
  mockRouting,
  mockSearch,
  openRoutePlannerAt,
  project,
  waitForMap,
} from './helpers';

test('cold load shows the map at the default Oslo view', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  await expect(page.getByPlaceholder('Search places')).toBeVisible();
  const cam = await cameraState(page);
  expect(cam.zoom).toBeCloseTo(5, 0);
  expect(cam.lat).toBeCloseTo(59.91, 1);
  expect(cam.lng).toBeCloseTo(10.75, 1);
});

test('direction-arrow source is selectable and persists on this device', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Navigation' }).click();
  await expect(page.getByRole('radio', { name: 'Auto' })).toBeChecked();
  await page.getByRole('radio', { name: 'GPS course' }).click();
  await expect(page.getByRole('radio', { name: 'GPS course' })).toBeChecked();
  // Settings writes are asynchronous through the OPFS worker; give the click's
  // transaction a turn before deliberately tearing the page down.
  await page.waitForTimeout(250);

  await page.reload();
  await waitForMap(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Navigation' }).click();
  await expect(page.getByRole('radio', { name: 'GPS course' })).toBeChecked();
});

test('points of interest open an on-map category filter per profile', async ({ page }) => {
  await page.route('**/assets/styles/liberty.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        name: 'POI fixture',
        sources: {
          map: { type: 'vector', tiles: ['http://127.0.0.1:3199/e2e/{z}/{x}/{y}.pbf'] },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
          {
            id: 'poi_r20',
            type: 'symbol',
            source: 'map',
            'source-layer': 'poi',
            layout: { 'text-field': ['get', 'name'] },
          },
          {
            id: 'label_city',
            type: 'symbol',
            source: 'map',
            'source-layer': 'place',
            layout: { 'text-field': ['get', 'name'] },
          },
        ],
      }),
    }),
  );
  await page.route('**/e2e/**', (route) => route.fulfill({ status: 204 }));
  await page.goto('/');
  await waitForMap(page);

  await expect
    .poll(() => page.evaluate(() => Boolean(window.__atlasMap!.getLayer('poi_r20'))))
    .toBe(false);
  await page.getByRole('button', { name: /^Map layers/ }).click();
  const poi = page.getByRole('switch', { name: 'Points of interest' });
  await expect(poi).toHaveAttribute('aria-checked', 'false');
  await poi.click();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__atlasMap!.getLayer('poi_r20'))))
    .toBe(true);
  const categories = page.getByRole('group', { name: 'POI categories' });
  await expect(categories).toBeVisible();
  await expect(categories.getByRole('button', { name: 'All' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await categories.getByRole('button', { name: 'Groceries' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.stringify(window.__atlasMap!.getFilter('poi_r20') ?? null)),
    )
    .toContain('grocery');
  expect(
    await page.evaluate(() => JSON.stringify(window.__atlasMap!.getFilter('poi_r20') ?? null)),
  ).toContain('supermarket');
  expect(await page.evaluate(() => Boolean(window.__atlasMap!.getLayer('label_city')))).toBe(true);

  // The choice belongs to Explore. Switching profile restores that profile's
  // untouched default instead of globally stripping POIs from every map.
  await page.getByRole('radio', { name: 'Hike' }).click();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__atlasMap!.getLayer('poi_r20'))))
    .toBe(false);
  await expect(categories).toBeHidden();
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

test('every profile can enter and leave 3D terrain', async ({ page }) => {
  await page.route('**/assets/styles/liberty.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        name: 'Terrain fixture',
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eee' } }],
      }),
    }),
  );
  // One transparent pixel is enough for this interaction test: it proves the
  // same-origin tile request is wired without making CI depend on Mapterhorn.
  let terrainRequests = 0;
  await page.route('**/api/terrain/**', (route) => {
    terrainRequests += 1;
    return route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await page.goto('/');
  await waitForMap(page);

  // Explore, the default — the switch used to be offered only by the outdoor
  // profiles, which read as the 3D map having disappeared.
  const terrain = page.getByRole('button', { name: 'Switch to 3D terrain' });
  await expect(terrain).toBeVisible();
  await terrain.click();

  await expect
    .poll(() => page.evaluate(() => window.__atlasMap!.getStyle().name))
    .toBe('Atlas Light · explore · 3D');
  // It is one choice, not one per profile: switching activity keeps it. (Not
  // asserted through the style name — on this one-layer fixture Explore and
  // Drive differ only in `name`, which MapLibre's style diff never applies.)
  await page.getByRole('radio', { name: 'Drive' }).click();
  await expect(page.getByRole('radio', { name: 'Drive' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Switch to 2D map' })).toBeVisible();
  expect(await page.evaluate(() => window.__atlasMap!.getStyle().terrain)).toEqual({
    source: 'atlas-terrain-dem',
    exaggeration: 1,
  });
  await expect.poll(() => page.evaluate(() => window.__atlasMap!.getPitch())).toBeGreaterThan(50);
  const style = await page.evaluate(() => window.__atlasMap!.getStyle());
  expect(style.terrain).toEqual({ source: 'atlas-terrain-dem', exaggeration: 1 });
  expect(style.sources['atlas-terrain-dem']).toMatchObject({
    type: 'raster-dem',
    encoding: 'terrarium',
  });
  expect(style.layers?.some((layer) => layer.id === 'atlas-terrain-hillshade')).toBe(true);
  await expect.poll(() => terrainRequests).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Switch to 2D map' }).click();
  await expect.poll(() => page.evaluate(() => window.__atlasMap!.getPitch())).toBeLessThan(1);
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__atlasMap!.getSource('atlas-terrain-dem'))))
    .toBe(false);
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
  const nearbyActions = card.locator('.place-card-nearby-buttons').getByRole('button');
  await expect(nearbyActions).toHaveCount(3);
  await expect(nearbyActions.nth(0)).toHaveAccessibleName('Photos nearby');
  await expect(nearbyActions.nth(1)).toHaveAccessibleName('Nearby places');
  await expect(nearbyActions.nth(2)).toHaveAccessibleName('Weather');
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

test('what the overlays say lands on the place card, not in a popup of its own', async ({
  page,
}) => {
  // One identify-capable overlay, switched on through the real quick switch.
  await page.route('**/api/layers**', (route) =>
    route.fulfill({
      json: {
        layers: [
          {
            id: 'lake-depth',
            rev: 1,
            title: 'Lake depth',
            group: 'Water',
            identify: true,
            maxzoom: 18,
            attribution: 'NVE',
          },
        ],
      },
    }),
  );
  await page.route('**/api/overlay/lake-depth/identify**', (route) =>
    route.fulfill({
      json: {
        // Shaped like a real crowded answer: the one under the finger, a
        // neighbour with a measured distance, a register link, a description
        // long enough to be clipped, and a count of what is left out.
        results: [
          {
            navn: 'Semsvannet',
            maksdyp: '32.5',
            informasjon: 'A surveyor’s field description. '.repeat(12),
            lenke: 'https://kulturminnesok.no/ra/lokalitet/22228',
          },
          { navn: 'Nordvannet', maksdyp: '4.2' },
        ],
        distancesM: [3, 42],
        more: { count: 2, withinM: 30 },
      },
    }),
  );
  // Raster tiles for the stub layer are irrelevant here; keep them off the wire.
  await page.route('**/api/overlay/lake-depth/tiles/**', (route) => route.abort());

  await page.goto('/#map=14/59.8553/10.4211');
  await waitForMap(page);
  await page.getByRole('button', { name: /^Map layers/ }).click();
  await page.getByRole('switch', { name: 'Lake depth' }).click();
  await page.keyboard.press('Escape');

  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // The answer opens the card for the clicked point and sits inside it — the
  // separate MapLibre popup that used to show this is gone.
  const card = page.locator('.place-card');
  const identify = card.getByTestId('place-card-identify');
  await expect(identify).toContainText('Lake depth');
  await expect(identify).toContainText('32.5');
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  // And it is one card: the spot's own facts are still there beside the answer.
  await expect(card.locator('.place-card-facts')).toContainText('Daylight');

  // The one under the finger leads and says nothing about distance; the
  // neighbour behind it says how far away it is, and the card admits what it
  // is not showing.
  await expect(identify.locator('section').first()).toContainText('Semsvannet');
  await expect(identify.locator('section').first().locator('em')).toHaveCount(0);
  await expect(identify.locator('section').nth(1)).toContainText('42 m away');
  await expect(identify).toContainText('2 more within about 30 m');

  // A register's own record is a link, not a line of text nobody can use.
  const link = identify.getByRole('link', { name: /kulturminnesok\.no/ });
  await expect(link).toHaveAttribute('href', 'https://kulturminnesok.no/ra/lokalitet/22228');

  // And a description longer than the box can be opened rather than scrolled
  // blindly (the block keeps a bounded height either way).
  const more = card.getByRole('button', { name: 'Show more' });
  await expect(more).toBeVisible();
  const clipped = (await identify.boundingBox())!.height;
  await more.click();
  await expect(card.getByRole('button', { name: 'Show less' })).toBeVisible();
  expect((await identify.boundingBox())!.height).toBeGreaterThan(clipped);
});

test('a satellite tap opens the on-device pass predictor', async ({ page }) => {
  const epoch = new Date().toISOString().replace(/Z$/, '');
  await page.route('**/api/layers**', (route) =>
    route.fulfill({
      json: {
        layers: [
          {
            id: 'satellites',
            rev: 1,
            title: 'Satellites & ISS',
            description: 'Live orbital positions',
            group: 'Sky',
            attribution: 'CelesTrak',
            maxzoom: 22,
            defaultOpacity: 1,
            identify: false,
            profiles: ['curiosities'],
            vector: true,
          },
        ],
      },
    }),
  );
  await page.route('**/api/overlay/satellites/elements**', (route) =>
    route.fulfill({
      json: {
        fetchedAt: new Date().toISOString(),
        groups: ['visual'],
        satellites: [
          {
            OBJECT_NAME: 'ATLAS TEST SATELLITE',
            OBJECT_ID: '2026-001A',
            EPOCH: epoch,
            MEAN_MOTION: 15.48996812,
            ECCENTRICITY: 0.00050573,
            INCLINATION: 51.631,
            RA_OF_ASC_NODE: 262.6049,
            ARG_OF_PERICENTER: 109.4187,
            MEAN_ANOMALY: 250.7348,
            EPHEMERIS_TYPE: 0,
            CLASSIFICATION_TYPE: 'U',
            NORAD_CAT_ID: 99005,
            ELEMENT_SET_NO: 1,
            REV_AT_EPOCH: 1,
            BSTAR: 0.000081465205,
            MEAN_MOTION_DOT: 0.0000404,
            MEAN_MOTION_DDOT: 0,
            ATLAS_GROUP: 'visual',
          },
        ],
      },
    }),
  );

  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('radio', { name: 'Curiosities' }).click();
  await page.getByRole('button', { name: /^Map layers/ }).click();
  await page.getByRole('switch', { name: 'Satellites & ISS' }).click();
  await page.keyboard.press('Escape');

  await expect
    .poll(() =>
      page.evaluate(() => {
        const data = window.__atlasMap!.getSource('atlas-satellites')?.serialize().data;
        return typeof data === 'object' && 'features' in data ? data.features.length : 0;
      }),
    )
    .toBeGreaterThan(0);
  const position = await page.evaluate(() => {
    const data = window.__atlasMap!.getSource('atlas-satellites')?.serialize().data;
    if (!data || typeof data === 'string' || data.features.length === 0) {
      throw new Error('Satellite source is empty');
    }
    const feature = data.features.find((candidate) => candidate.geometry.type === 'Point')!;
    const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
    window.__atlasMap!.jumpTo({ center: [lng!, lat!], zoom: 5 });
    return { lat: lat!, lng: lng! };
  });
  const [x, y] = await project(page, position.lat, position.lng);
  const canvas = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(canvas.x + x, canvas.y + y);

  const card = page.getByTestId('satellite-pass-card');
  await expect(card).toContainText('ATLAS TEST SATELLITE');
  await expect(card).toContainText('Passes over map centre');
  await expect(card.getByRole('button', { name: 'Visible' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await card.getByRole('button', { name: 'All', exact: true }).click();
  await expect(card).toContainText('All passes');

  // The horizon circle: the ground this object can be seen from right now.
  // The map was jumped onto its sub-point, so the observer is directly under
  // it and the card must say so.
  await expect(card).toContainText('Above your horizon now');
  const footprintSpan = () =>
    page.evaluate(() => {
      const data = window.__atlasMap!.getSource('atlas-satellites')?.serialize().data;
      if (!data || typeof data === 'string') return 0;
      const disc = data.features.find((feature) => feature.properties?.footprint === true);
      if (!disc) return 0;
      const ring = (disc.geometry as GeoJSON.Polygon).coordinates[0]!;
      const latitudes = ring.map(([, lat]) => lat!);
      return Math.max(...latitudes) - Math.min(...latitudes);
    });
  await expect.poll(footprintSpan).toBeGreaterThan(0);
  const atTenDegrees = await footprintSpan();

  // Raising the floor must visibly shrink the circle. This is the assertion
  // that the map and the list read one elevation value and not two copies of
  // it: a 30° circle is less than half the radius of a 10° one.
  await card.getByRole('button', { name: '30°+' }).click();
  await expect(card).toContainText('next 3 days');
  await expect.poll(footprintSpan).toBeLessThan(atTenDegrees);
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
});

test('a freshly launched batch is drawn as a purple train', async ({ page }) => {
  const epoch = new Date().toISOString().replace(/Z$/, '');
  await page.route('**/api/layers**', (route) =>
    route.fulfill({
      json: {
        layers: [
          {
            id: 'satellites',
            rev: 1,
            title: 'Satellites & ISS',
            description: 'Live orbital positions',
            group: 'Sky',
            attribution: 'CelesTrak',
            maxzoom: 22,
            defaultOpacity: 1,
            identify: false,
            profiles: ['curiosities'],
            vector: true,
          },
        ],
      },
    }),
  );
  // Ten objects from one launch, at the ~324 km a batch is inserted at and
  // 2.2 degrees of orbit apart — about 245 km, or half a minute of sky.
  await page.route('**/api/overlay/satellites/elements**', (route) =>
    route.fulfill({
      json: {
        fetchedAt: new Date().toISOString(),
        groups: ['starlink'],
        satellites: Array.from({ length: 10 }, (_, index) => ({
          OBJECT_NAME: `ATLAS TRAIN ${index + 1}`,
          OBJECT_ID: `2026-201${String.fromCharCode(65 + index)}`,
          EPOCH: epoch,
          MEAN_MOTION: 15.85,
          ECCENTRICITY: 0.0001,
          INCLINATION: 53.16,
          RA_OF_ASC_NODE: 262.6,
          ARG_OF_PERICENTER: 90,
          MEAN_ANOMALY: 40 + index * 2.2,
          EPHEMERIS_TYPE: 0,
          CLASSIFICATION_TYPE: 'U',
          NORAD_CAT_ID: 99100 + index,
          ELEMENT_SET_NO: 1,
          REV_AT_EPOCH: 1,
          BSTAR: 0.0008,
          MEAN_MOTION_DOT: 0.0001,
          MEAN_MOTION_DDOT: 0,
          ATLAS_GROUP: 'starlink',
        })),
      },
    }),
  );

  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('radio', { name: 'Curiosities' }).click();
  await page.getByRole('button', { name: /^Map layers/ }).click();
  await page.getByRole('switch', { name: 'Satellites & ISS' }).click();
  await page.keyboard.press('Escape');

  // Every member purple, in one of the two shades: hue says "train", value
  // still says whether the sun is on it.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const data = window.__atlasMap!.getSource('atlas-satellites')?.serialize().data;
        if (!data || typeof data === 'string') return [];
        return data.features
          .filter((feature) => feature.geometry.type === 'Point')
          .map((feature) => `${feature.properties?.train}/${feature.properties?.color}`);
      }),
    )
    .toEqual(Array.from({ length: 10 }, () => expect.stringMatching(/^true\/#(c084fc|7e22ce)$/)));

  const position = await page.evaluate(() => {
    const data = window.__atlasMap!.getSource('atlas-satellites')?.serialize().data;
    if (!data || typeof data === 'string' || data.features.length === 0) {
      throw new Error('Satellite source is empty');
    }
    const feature = data.features.find((candidate) => candidate.geometry.type === 'Point')!;
    const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
    window.__atlasMap!.jumpTo({ center: [lng!, lat!], zoom: 5 });
    return { lat: lat!, lng: lng! };
  });
  const [x, y] = await project(page, position.lat, position.lng);
  const canvas = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(canvas.x + x, canvas.y + y);

  // And the card names the batch the dot belongs to, so the second colour on
  // the map is explained somewhere rather than left as a riddle.
  const card = page.getByTestId('satellite-pass-card');
  await expect(card).toContainText('Flying as a train — 10 objects from launch 2026-201');
  await expect(card).toContainText(/one every \d+ s/);
});

test('Fish & Hunt shows live ice times and saves a permit as a filled area', async ({ page }) => {
  await page.route('**/api/layers**', (route) =>
    route.fulfill({
      json: {
        layers: [
          {
            id: 'ice-observations',
            rev: 1,
            title: 'Ice observations',
            description: 'Latest Regobs observations',
            group: 'Water & depth',
            attribution: 'NVE Regobs',
            minzoom: 7,
            maxzoom: 18,
            defaultOpacity: 1,
            identify: false,
            profiles: ['fishing', 'hunting', 'ski'],
            vector: true,
          },
        ],
      },
    }),
  );
  await page.route('**/api/overlay/ice-observations/features**', (route) =>
    route.fulfill({
      json: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [10, 60] },
            properties: {
              regId: 42,
              kind: 'open-water',
              label: 'Open water',
              observedAt: '2026-01-19T10:15:00+01:00',
              observer: 'Kari',
              summary: 'Open by the outlet',
              age: 'fresh',
              markerColor: '#16a34a',
              symbol: '≈',
              sourceUrl: 'https://www.regobs.no/registration/42',
            },
          },
        ],
      },
    }),
  );
  await page.route('**/api/inatur/resolve?**', (route) =>
    route.fulfill({
      json: {
        offerId: '0123456789abcdef01234567',
        name: 'Test permit',
        bbox: [9.98, 59.98, 10.02, 60.02],
        polygons: [
          [
            [
              [9.98, 59.98],
              [10.02, 59.98],
              [10.02, 60.02],
              [9.98, 60.02],
              [9.98, 59.98],
            ],
            [
              [9.995, 59.995],
              [10.005, 59.995],
              [10.005, 60.005],
              [9.995, 60.005],
              [9.995, 59.995],
            ],
          ],
        ],
        rings: [
          [
            [9.98, 59.98],
            [10.02, 59.98],
            [10.02, 60.02],
            [9.98, 60.02],
            [9.98, 59.98],
          ],
          [
            [9.995, 59.995],
            [10.005, 59.995],
            [10.005, 60.005],
            [9.995, 60.005],
            [9.995, 59.995],
          ],
        ],
        subAreas: 1,
      },
    }),
  );

  await page.goto('/#map=10/60/10');
  await waitForMap(page);
  await page.getByRole('radio', { name: 'Fish & Hunt' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__atlasMap!.getStyle().sources['atlas-ice-observations'] as {
              data?: { features?: unknown[] };
            }
          )?.data?.features?.length ?? 0,
      ),
    )
    .toBe(1);

  const marker = await project(page, 60, 10);
  await expect
    .poll(() =>
      page.evaluate(
        ([x, y]) =>
          window.__atlasMap!.queryRenderedFeatures(
            [
              [x! - 10, y! - 10],
              [x! + 10, y! + 10],
            ],
            { layers: ['atlas-ice-observations-dot'] },
          ).length,
        marker,
      ),
    )
    .toBe(1);
  const canvas = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(canvas.x + marker[0], canvas.y + marker[1]);
  const identify = page.getByTestId('place-card-identify');
  await expect(identify).toContainText('Open water');
  await expect(identify).toContainText('2026-01-19 10:15 +01:00');
  await expect(identify).toContainText('Kari');
  await page.locator('.place-card').getByRole('button', { name: 'Close' }).click();

  // The permit tool lives where saved data comes in — the Collections header —
  // and not on the map: the map-level copy could not choose a folder and was
  // removed in v0.129.0.
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'iNatur permit' }).click();
  await page.getByLabel('iNatur offer link or id').fill('0123456789abcdef01234567');
  await page.getByRole('button', { name: 'Add permit area' }).click();

  const savedArea = () =>
    page.evaluate(() => {
      const sources = window.__atlasMap!.getStyle().sources;
      const id = Object.keys(sources).find((key) => key.startsWith('atlas-track-'));
      if (!id) return null;
      const data = (sources[id] as { data?: GeoJSON.FeatureCollection }).data;
      const area = data?.features.find((feature) => feature.geometry.type === 'MultiPolygon');
      return area?.geometry.type === 'MultiPolygon' ? area.geometry.coordinates : null;
    });
  await expect.poll(savedArea).toHaveLength(1);
  expect((await savedArea())?.[0]).toHaveLength(2); // exterior + excluded hole

  // The filled topology is persisted, not merely held by the just-completed
  // resolver or flattened into the GPX boundary.
  await page.reload();
  await waitForMap(page);
  await expect.poll(savedArea).toHaveLength(1);
  expect((await savedArea())?.[0]).toHaveLength(2);
});

test('nearby photos and places are separate on-demand features', async ({ page }) => {
  // The user's own case: a town hall Wikipedia has never written about.
  let photoRequests = 0;
  await page.route('**/api/place-content?**', (route) => route.fulfill({ json: { content: [] } }));
  await page.route('**/api/place-photos**', (route) => {
    photoRequests += 1;
    return route.fulfill({
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
    });
  });
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

  // Opening the marker card does not fetch or show imagery. Photos are a peer
  // action beside Nearby places, and each result says how far off it was taken.
  await expect(card.locator('.place-card-photo-strip')).toHaveCount(0);
  expect(photoRequests).toBe(0);
  await card.getByRole('button', { name: /Photos nearby/ }).click();
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
  // A pin has only its coordinates for a name, so the editor opens on it to be
  // named; this journey is about the card, so dismiss it and keep the default.
  await closePlaceEditor(page);
  // The saved place is found by proximity, so the card knows it is now saved.
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
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
  const card = page.locator('.place-card');
  // Share opens the format chooser — the same list, in the same words, as the
  // Android sheet. The `geo:` hand-off is deliberately absent on the web.
  await card.getByRole('button', { name: 'Share' }).click();
  const chooser = card.getByTestId('place-card-share');
  await expect(chooser.getByRole('menuitem')).toHaveText([
    /Atlas link/,
    /Copy coordinates59\.50000, 10\.50000/,
  ]);
  await chooser.getByTestId('share-link').click();
  await expect(chooser).toHaveCount(0);

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

test('search replaces stale rows with honest loading, empty and error states', async ({ page }) => {
  await page.route('**/api/search**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return route.fulfill({
        json: {
          results: [{ name: 'Slow place', label: 'Oslo', position: { lat: 59.91, lng: 10.75 } }],
        },
      });
    }
    if (query === 'empty') return route.fulfill({ json: { results: [] } });
    return route.fulfill({ status: 503, json: { message: 'unavailable' } });
  });
  await page.goto('/');
  await waitForMap(page);
  const input = page.getByPlaceholder('Search places');

  await input.fill('slow');
  await expect(page.getByText('Searching…')).toBeVisible();
  await expect(page.getByText('Slow place')).toBeVisible();

  await input.fill('empty');
  await expect(page.getByText('Searching…')).toBeVisible();
  await expect(page.getByText('Slow place')).toHaveCount(0);
  await expect(page.getByText('No matches found.')).toBeVisible();

  await input.fill('failure');
  await expect(page.getByText('Search is unavailable.')).toBeVisible();
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
          {
            name: 'Tim Wendelboe',
            label: 'Cafe, Oslo',
            position: { lat: 59.9277, lng: 10.7492 },
            kind: 'amenity/cafe',
            distanceM: 1_900,
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
  await expect(explore.locator('.explore-result-index')).toHaveText(['1', '2']);
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__atlasMap!.getSource('atlas-explore-results'))))
    .toBe(true);

  // Panning does not silently re-fetch (that once ran on every camera frame),
  // but the list says plainly that it describes the previous view.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = window.__atlasMap!;
        map.once('moveend', () => resolve());
        map.panBy([120, 0], { duration: 0 });
      }),
  );
  await expect(explore).toContainText('Results are for the previous map view.');
  await explore.getByRole('button', { name: /Fuglen/ }).click();

  const card = page.locator('.place-card');
  // Opening one result keeps the rest of the numbered spatial answer visible.
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__atlasMap!.getSource('atlas-explore-results'))))
    .toBe(true);
  await expect(card).toContainText('A coffee bar and design shop in central Oslo.');
  await expect(card.getByRole('link', { name: 'Read article' })).toHaveAttribute(
    'href',
    'https://en.wikipedia.org/wiki/Fuglen',
  );
  await card.getByRole('button', { name: 'Close' }).click();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__atlasMap!.getSource('atlas-explore-results'))))
    .toBe(false);
});

test('route planning: two map clicks produce a route with stats', async ({ page }) => {
  await mockRouting(page);
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await openRoutePlannerAt(page, 59.905, 10.74);
  await expect(page.getByRole('searchbox', { name: 'Search for a start' })).toBeVisible();
  const routed = page.waitForRequest(
    (request) => request.url().endsWith('/api/route') && request.method() === 'POST',
  );
  const [x2, y2] = await project(page, 59.915, 10.76);
  await page.mouse.click(x2, y2);
  const body = (await routed).postDataJSON() as {
    locations: { lat: number; lon: number }[];
  };
  expect(body.locations[0]!.lat).toBeCloseTo(59.915, 3);
  expect(body.locations[0]!.lon).toBeCloseTo(10.76, 3);
  expect(body.locations[1]!.lat).toBeCloseTo(59.905, 3);
  expect(body.locations[1]!.lon).toBeCloseTo(10.74, 3);
  await expect(page.locator('.route-stats')).toContainText('km');
  await expect(page.locator('.route-stats')).toContainText('Surface');
  await expect(page.locator('.elevation-panel')).toBeVisible();
  await expect(page.locator('.profile-segment')).not.toHaveCount(0);
  const hasRouteSource = await page.evaluate(() =>
    Boolean(window.__atlasMap!.getSource('atlas-route')),
  );
  expect(hasRouteSource).toBe(true);
});

test('transit stop search plans exact stops and starts guided transit', async ({ page }) => {
  await mockRouting(page);
  const now = Date.now();
  let transitBody: {
    from?: { lat: number; lng: number; stopId?: string };
    to?: { lat: number; lng: number; stopId?: string };
  } | null = null;
  let servedTrip: Record<string, unknown> | null = null;

  await page.route('**/api/search**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    const national = q.toLowerCase().includes('national');
    route.fulfill({
      json: {
        results: [
          {
            // Photon knows an OSM station too. The Entur result below must win
            // and this nearby duplicate must not become a second ambiguous row.
            name: national ? 'Nationaltheatret' : 'Oslo S',
            label: 'Photon address',
            position: national ? { lat: 59.9147, lng: 10.7333 } : { lat: 59.9104, lng: 10.7531 },
          },
          {
            name: national ? 'Nationaltheatret café' : 'Oslo City',
            label: 'General place',
            position: national ? { lat: 59.915, lng: 10.734 } : { lat: 59.912, lng: 10.751 },
          },
        ],
      },
    });
  });
  await page.route('**/api/transit/stops**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    const national = q.toLowerCase().includes('national');
    route.fulfill({
      json: {
        results: [
          {
            name: national ? 'Nationaltheatret' : 'Oslo S',
            label: national ? 'Train · Tram · Oslo' : 'Bus · Train · Oslo',
            position: national
              ? { lat: 59.9147, lng: 10.7333 }
              : { lat: 59.910357, lng: 10.753051 },
            transitStopId: national ? 'NSR:StopPlace:58404' : 'NSR:StopPlace:59872',
          },
        ],
      },
    });
  });
  await page.route('**/api/transit', (route) => {
    transitBody = route.request().postDataJSON() as typeof transitBody;
    servedTrip = {
      startMs: now + 240_000,
      endMs: now + 600_000,
      durationMs: 360_000,
      walkDistanceM: 0,
      legs: [
        {
          mode: 'rail',
          distanceM: 5_000,
          durationMs: 360_000,
          aimedStartMs: now,
          expectedStartMs: now + 240_000,
          aimedEndMs: now + 360_000,
          expectedEndMs: now + 600_000,
          realtime: true,
          startPredictionInaccurate: true,
          endPredictionInaccurate: false,
          from: {
            name: 'Oslo S',
            position: { lat: 59.910357, lng: 10.753051 },
            quay: { publicCode: '2' },
          },
          to: {
            name: 'Nationaltheatret',
            position: { lat: 59.9147, lng: 10.7333 },
          },
          line: { publicCode: 'R14', headsign: 'Kongsvinger' },
          intermediateStops: [],
          points: [],
          situations: [],
        },
      ],
    };
    route.fulfill({
      json: {
        trips: [servedTrip],
        problems: [],
      },
    });
  });
  await page.route('**/api/transit/commute', (route) => {
    route.fulfill({
      json: {
        outbound: { trips: servedTrip ? [servedTrip] : [], problems: [] },
        inbound: { trips: [], problems: [] },
        segments: [],
      },
    });
  });

  await page.goto('/#map=13/59.91/10.75');
  await waitForMap(page);
  await openRoutePlannerAt(page, 59.905, 10.74);
  await page.getByRole('button', { name: /Transit/ }).click();

  await page.locator('.route-wp-tap').click();
  const editSearch = page.locator('.route-wp-edit');
  await editSearch.getByRole('searchbox', { name: 'Change this stop' }).fill('Oslo');
  await expect(editSearch.locator('li').first()).toContainText('Bus · Train · Oslo');
  await expect(editSearch.getByRole('button', { name: /Oslo S/ })).toHaveCount(1);
  await editSearch.getByRole('button', { name: /Oslo S/ }).click();

  const search = page.locator('.route-stop-search');
  await search.getByRole('searchbox', { name: 'Search for a destination' }).fill('National');
  await expect(search.locator('li').first()).toContainText('Train · Tram · Oslo');
  await search
    .getByRole('button', { name: /Nationaltheatret/ })
    .first()
    .click();

  await expect
    .poll(() => transitBody)
    .toMatchObject({
      from: {
        lat: 59.910357,
        lng: 10.753051,
        stopId: 'NSR:StopPlace:59872',
      },
      to: {
        lat: 59.9147,
        lng: 10.7333,
        stopId: 'NSR:StopPlace:58404',
      },
    });
  await expect(page.locator('.transit-results')).toBeVisible();
  await expect(page.locator('.transit-summary-departure')).toContainText('planned');
  await expect(page.locator('.transit-summary-departure')).toContainText('Live estimate uncertain');

  // The planner, daily board and detailed journey are one connected flow: the
  // exact stop ids survive saving, and the commute card can return to the
  // standard trip view at the chosen departure.
  await page.getByRole('button', { name: 'Make this my commute' }).click();
  const commute = page.locator('.commute-panel');
  await expect(commute).toContainText('Oslo S → Nationaltheatret');
  await commute.getByRole('button', { name: 'Full journey' }).first().click();
  await expect(page.locator('.transit-results')).toBeVisible();

  await page.context().grantPermissions(['notifications']);
  await page.getByRole('button', { name: 'Start journey' }).click();
  await expect(page.locator('.route-panel')).toHaveCount(0);
  const guidance = page.getByRole('complementary', { name: 'Transit guidance' });
  await expect(guidance).toContainText('Board line R14');
  await expect(guidance).toContainText('guidance continues offline');
  await guidance.getByRole('button', { name: 'End' }).click();
  await expect(guidance).toHaveCount(0);
});

test('a planned route saves as a track and reopens as an editable route', async ({ page }) => {
  await mockRouting(page);
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await openRoutePlannerAt(page, 59.905, 10.74);
  const [x2, y2] = await project(page, 59.915, 10.76);
  await page.mouse.click(x2, y2);
  await expect(page.locator('.route-stats')).toBeVisible();

  // Saving a *drive* as a track is a real capability but not a driver's first
  // reach, so the driving toolbar folds it under "More" (`routeActionsFor`).
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Save track' }).click();
  const save = page.locator('.route-save-track');
  await save.getByLabel('Track name').fill('Desktop ride');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved as track' })).toBeVisible();

  await page.getByRole('button', { name: 'Close route planning' }).click();
  await page.getByRole('button', { name: 'Collections' }).click();
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toContainText('Desktop ride');
  await sidebar.getByRole('button', { name: 'Edit Desktop ride' }).click();
  await sidebar.getByRole('button', { name: 'Plan as route' }).click();

  await expect(page.locator('.route-panel')).toBeVisible();
  await expect(page.locator('.route-waypoints li')).toHaveCount(2);
  await expect(page.locator('.route-waypoints')).toContainText('Desktop ride start');
});

test('running and custom trail preferences reach the routing engine', async ({ page }) => {
  await mockRouting(page);
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await openRoutePlannerAt(page, 59.905, 10.74);
  await page.getByRole('button', { name: 'Run' }).click();
  // The options are chips behind one button (v0.175.0), which states the
  // constraint itself when only one is set — so the fold is opened by the name
  // it carries while the plan is under none. A chip's accessible name is its
  // own words, so voice control can reach what the user can see; the full
  // sentence is the tooltip.
  await page.getByRole('button', { name: 'Route options' }).click();
  // Ferries mean nothing on foot, so running's fold does not offer them.
  await expect(page.getByRole('switch', { name: 'No ferries' })).toHaveCount(0);
  await page.getByRole('switch', { name: 'Trails', exact: true }).click();

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
  const [x2, y2] = await project(page, 59.915, 10.76);
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
  await openRoutePlannerAt(page, 59.905, 10.74);
  const [x2, y2] = await project(page, 59.915, 10.76);
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
  await openRoutePlannerAt(page, 59.905, 10.74);
  const [x2, y2] = await project(page, 59.915, 10.76);
  await page.mouse.click(x2, y2);
  await expect(page.locator('.route-stats')).toBeVisible();

  // Turning "round trip" on used to throw the destination away and draw an
  // arbitrary loop from the start; both stops must survive it. A chip in the
  // options row since v0.173.0, not a checkbox — and behind the options fold
  // since v0.175.0, which is why the row has to be opened first.
  await page.getByRole('button', { name: 'Route options' }).click();
  await page.getByRole('switch', { name: 'Round trip' }).click();
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

test('the measure tool rules a line, drops range rings, and clears on close', async ({ page }) => {
  await page.goto('/#map=13/59.91/10.75');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Measure distance and radius' }).click();
  const panel = page.getByRole('dialog', { name: 'Measure' });
  await expect(panel).toContainText('Add points along a line to measure it.');

  // Two clicks make a distance; a third bend adds the straight-line comparison.
  const [x1, y1] = await project(page, 59.905, 10.74);
  const [x2, y2] = await project(page, 59.915, 10.74);
  const [x3, y3] = await project(page, 59.915, 10.77);
  await page.mouse.click(x1, y1);
  await page.mouse.click(x2, y2);
  await expect(panel.locator('.measure-readout')).toHaveText('1.1 km');
  await page.mouse.click(x3, y3);
  await expect(panel.locator('.measure-sub')).toContainText('straight line');

  // The ruler is drawn from the shared measure model: line, vertices, labels.
  const ruler = await page.evaluate(async () => {
    const source = window.__atlasMap!.getSource('atlas-measure') as maplibregl.GeoJSONSource;
    const data = (await source.getData()) as GeoJSON.FeatureCollection;
    return data.features.map((f) => f.properties?.['kind']);
  });
  expect(ruler.filter((kind) => kind === 'point')).toHaveLength(3);
  expect(ruler.filter((kind) => kind === 'path')).toHaveLength(1);

  // Radius mode: one drop, two default rings, and a third when 50 m is added.
  await panel.getByRole('button', { name: 'Radius' }).click();
  await page.mouse.click(x1, y1);
  await expect(panel).toContainText('1 circle');
  await panel.getByRole('button', { name: '50 m' }).click();
  const rings = await page.evaluate(async () => {
    const source = window.__atlasMap!.getSource('atlas-measure') as maplibregl.GeoJSONSource;
    const data = (await source.getData()) as GeoJSON.FeatureCollection;
    return data.features.filter((f) => f.properties?.['kind'] === 'ring');
  });
  expect(rings).toHaveLength(3);

  // Closing the tool takes its layers with it — a stale ruler over a map that
  // has since moved is not a measurement anyone wants back.
  await panel.getByRole('button', { name: 'Close measure tool' }).click();
  await expect(panel).toBeHidden();
  expect(await page.evaluate(() => Boolean(window.__atlasMap!.getSource('atlas-measure')))).toBe(
    false,
  );
});
