import { expect, test } from '@playwright/test';

import { waitForMap } from './helpers';

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);

test('sky layers expose lightning windows and aurora validity in the weather dock', async ({
  page,
}) => {
  await page.route('**/api/layers', (route) =>
    route.fulfill({
      json: {
        layers: [
          {
            id: 'weather-lightning',
            rev: 2,
            title: 'Lightning',
            description: 'Detected strikes',
            group: 'Weather',
            attribution: 'MET Norway',
            minzoom: 4,
            maxzoom: 18,
            defaultOpacity: 1,
            identify: false,
            vector: true,
          },
          {
            id: 'aurora-forecast',
            rev: 2,
            title: 'Aurora viewing chance',
            description: 'Viewing chance',
            group: 'Weather',
            attribution: 'NOAA / MET / NASA',
            maxzoom: 5,
            defaultOpacity: 0.85,
            identify: false,
            refreshSeconds: 300,
          },
          {
            id: 'light-pollution',
            rev: 1,
            title: 'Light pollution',
            description: 'Artificial night light',
            group: 'Weather',
            attribution: 'NASA',
            maxzoom: 8,
            defaultOpacity: 0.72,
            identify: false,
          },
        ],
      },
    }),
  );
  await page.route('**/api/overlay/weather-lightning/features**', (route) =>
    route.fulfill({ json: { type: 'FeatureCollection', features: [] } }),
  );
  await page.route('**/api/weather/aurora', (route) =>
    route.fulfill({
      json: {
        observationTime: '2026-09-16T12:00:00Z',
        forecastTime: '2026-09-16T12:45:00Z',
        factors: ['aurora', 'darkness', 'clouds', 'light-pollution'],
      },
    }),
  );
  await page.route('**/api/overlay/aurora-forecast/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: TRANSPARENT_PNG }),
  );
  await page.route('**/api/overlay/light-pollution/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: TRANSPARENT_PNG }),
  );

  await page.goto('/#map=5/60/10');
  await waitForMap(page);
  await page.getByRole('button', { name: /^Map layers/ }).click();
  await expect(page.getByRole('button', { name: 'Light pollution' })).toBeVisible();
  await page.getByRole('button', { name: 'Lightning' }).click();

  const lightning = page.getByRole('group', { name: 'Lightning time window' });
  await expect(lightning.getByRole('button', { name: 'Last hour' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const request = page.waitForRequest((candidate) => candidate.url().includes('window=24h'));
  await lightning.getByRole('button', { name: '24 hours' }).click();
  await request;

  // Using the dock closed the layer menu, as any click outside it does.
  await page.getByRole('button', { name: /^Map layers/ }).click();
  await page.getByRole('button', { name: 'Aurora viewing chance' }).click();
  await expect(page.getByLabel('Aurora forecast time')).toContainText(/\d\d:45/);
  await expect(page.getByLabel('Aurora forecast time')).toContainText(
    'darkness · MET clouds · VIIRS light pollution',
  );
});

test('lightning is drawn by strike age, and only the newest strike pulses', async ({ page }) => {
  await page.route('**/api/layers', (route) =>
    route.fulfill({
      json: {
        layers: [
          {
            id: 'weather-lightning',
            rev: 2,
            title: 'Lightning',
            description: 'Detected strikes',
            group: 'Weather',
            attribution: 'MET Norway',
            minzoom: 4,
            maxzoom: 18,
            defaultOpacity: 1,
            identify: false,
            vector: true,
          },
        ],
      },
    }),
  );
  // Ages measured at request time: a pulse, then one strike in each solid band.
  let fresh = true;
  await page.route('**/api/overlay/weather-lightning/features**', (route) => {
    const now = Date.now();
    const ages = fresh ? [20e3, 5 * 60e3, 30 * 60e3, 3 * 3600e3, 20 * 3600e3] : [5 * 60e3];
    route.fulfill({
      json: {
        type: 'FeatureCollection',
        features: [...ages].reverse().map((ageMs, i) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [10.2 + i * 0.25, 60] },
          properties: {
            observedAt: new Date(now - ageMs).toISOString(),
            observedMs: now - ageMs,
            ageMinutes: Math.round(ageMs / 60e3),
            age: 'fresh',
            markerColor: '#000000',
            peakCurrentKa: -12,
            polarity: 'negative',
          },
        })),
      },
    });
  });

  await page.goto('/#map=8/60/10.7');
  await waitForMap(page);
  await page.getByRole('button', { name: /^Map layers/ }).click();
  await page.getByRole('button', { name: 'Lightning' }).click();
  const key = page.getByLabel('Lightning strike age');
  await expect(key).toContainText('< 1 min');
  await expect(key).toContainText('1 h');
  await expect(key).not.toContainText('6 h');

  await page.waitForFunction(() => Boolean(window.__atlasMap!.getLayer('atlas-lightning-ring')));
  await page.waitForFunction(() =>
    Boolean(
      window.__atlasMap!.querySourceFeatures('atlas-lightning').length >= 5 ||
      window.__atlasMap!.queryRenderedFeatures({ layers: ['atlas-lightning-dot'] }).length >= 5,
    ),
  );
  // The shockwave ring is animating: its radius changes frame to frame.
  const radii = await page.evaluate(async () => {
    const map = window.__atlasMap!;
    const out: number[] = [];
    for (let i = 0; i < 6; i++) {
      out.push(Number(map.getPaintProperty('atlas-lightning-ring', 'circle-radius')));
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return out;
  });
  expect(new Set(radii.map((r) => r.toFixed(2))).size).toBeGreaterThan(2);
  await page.screenshot({ path: 'test-results/lightning-bands.png' });

  // Only the newest band pulses: with no strike under a minute old the ring rests.
  fresh = false;
  const windows = page.getByRole('group', { name: 'Lightning time window' });
  await windows.getByRole('button', { name: '24 hours' }).click();
  await expect(key).toContainText('6 h');
  await expect(key).toContainText('24 h');
  await page.waitForTimeout(1_000);
  const resting = await page.evaluate(async () => {
    const map = window.__atlasMap!;
    const a = map.getPaintProperty('atlas-lightning-ring', 'circle-radius');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return [a, map.getPaintProperty('atlas-lightning-ring', 'circle-radius')];
  });
  expect(resting[0]).toBe(resting[1]);
});
