import { deflateSync } from 'node:zlib';

import { expect, test, type Page } from '@playwright/test';

import { waitForMap } from './helpers';

/** A 1×1 RGBA PNG: MapLibre stretches any raster tile image over its tile. */
function pixelPng([r, g, b, a]: [number, number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, r, g, b, a]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FRAME_COUNT = 8;

/** A precipitation row and a radar timeline whose tiles arrive slowly and unevenly. */
async function mockRadar(page: Page) {
  const now = Date.now();
  const frames = Array.from({ length: FRAME_COUNT }, (_, i) => {
    const time = new Date(Math.floor(now / 300_000) * 300_000 - (FRAME_COUNT - 2 - i) * 300_000);
    const id = `observation-${i}`;
    return {
      id,
      time: time.toISOString(),
      kind: i < FRAME_COUNT - 2 ? 'observation' : 'nowcast',
      tilePath: `/api/weather/maps/precipitation/${id}/{z}/{x}/{y}.png?v=1`,
    };
  });
  const bounds = [-8, 53, 41, 74];
  await page.route('**/api/layers', (route) =>
    route.fulfill({
      json: {
        layers: [
          {
            id: 'weather-precipitation',
            rev: 1,
            title: 'Precipitation',
            description: 'Radar',
            group: 'Weather',
            attribution: 'MET Norway',
            maxzoom: 5,
            defaultOpacity: 0.9,
            identify: false,
            weather: { layer: 'precipitation' },
            exclusive: 'weather-field',
          },
        ],
      },
    }),
  );
  await page.route('**/api/weather/maps', (route) =>
    route.fulfill({
      json: {
        layers: [
          {
            id: 'precipitation',
            title: 'Precipitation',
            description: '',
            unit: 'mm/h',
            coverageNote: '',
            defaultOpacity: 0.9,
            timelines: [{ id: 'radar', bounds, minzoom: 0, maxzoom: 9, frames }],
            frames,
            legend: [],
            bounds,
            minzoom: 0,
            maxzoom: 9,
          },
        ],
        attribution: 'MET Norway',
        lightning: { available: false, reason: '' },
      },
    }),
  );
  // Each frame its own colour, and every tile 150–900 ms late: the conditions
  // under which the old swap showed the bare map between two pictures.
  await page.route('**/api/weather/maps/precipitation/**', async (route) => {
    const index = Number(/observation-(\d+)/.exec(route.request().url())?.[1] ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 750));
    await route.fulfill({
      contentType: 'image/png',
      headers: { 'cache-control': 'no-store' },
      body: pixelPng([40 + index * 25, 90, 255 - index * 20, 255]),
    });
  });
}

test('playing radar never shows the bare map between frames', async ({ page }) => {
  await mockRadar(page);
  await page.goto('/#map=5/62/12');
  await waitForMap(page);
  await page.getByRole('button', { name: /^Map layers/ }).click();
  await page.getByRole('switch', { name: 'Precipitation' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  // Let the first picture arrive before judging what replaces it.
  await page.waitForFunction(() => {
    const map = window.__atlasMap!;
    return Object.keys(map.getStyle().sources).some(
      (id) => id.startsWith('atlas-weather-map-') && map.isSourceLoaded(id),
    );
  });
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: 'Play' }).click();

  const run = await page.evaluate(async () => {
    const map = window.__atlasMap! as unknown as {
      style: {
        _layers: Record<string, { paint: { get(name: string): number } }>;
        tileManagers?: Record<string, { getRenderableIds(): unknown[] }>;
        sourceCaches?: Record<string, { getRenderableIds(): unknown[] }>;
      };
      isSourceLoaded(id: string): boolean;
    };
    const coverage: number[] = [];
    const labels = new Set<string>();
    const started = performance.now();
    while (performance.now() - started < 9_000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      // How much of a drawn, loaded weather picture covers the map right now:
      // 1 − Π(1 − opacity) over frames whose tiles are on the GPU.
      let clear = 1;
      for (const [id, layer] of Object.entries(map.style._layers)) {
        if (!id.startsWith('atlas-weather-map-')) continue;
        const tiles = (map.style.tileManagers ?? map.style.sourceCaches)?.[id];
        const drawn = Boolean(
          tiles && tiles.getRenderableIds().length > 0 && map.isSourceLoaded(id),
        );
        if (drawn) clear *= 1 - layer.paint.get('raster-opacity');
      }
      coverage.push(1 - clear);
      const label = document.querySelector('.weather-time strong')?.textContent;
      if (label) labels.add(label);
    }
    return { min: Math.min(...coverage), samples: coverage.length, frames: labels.size };
  });

  console.log(`radar playback: ${JSON.stringify(run)}`);
  // It moved…
  expect(run.frames).toBeGreaterThanOrEqual(4);
  // …and at no sampled animation frame was the picture gone or even half gone
  // (the layer's opacity is 0.9, so a settled frame covers 0.9). SwiftShader in
  // the container renders ~8 frames a second, so dozens of samples, not hundreds.
  expect(run.samples).toBeGreaterThan(40);
  expect(run.min).toBeGreaterThan(0.6);
});
