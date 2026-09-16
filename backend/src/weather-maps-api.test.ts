import {
  RAIN_COLORS,
  rampRgb,
  SNOW_COLORS,
  TEMPERATURE_RAMP,
  WEATHER_FIELD_GROUP,
  type WeatherGridResponse,
  type WeatherMapsResponse,
  type WeatherPointSample,
} from '@atlas/conditions';
import Fastify, { type FastifyInstance } from 'fastify';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { archiveStamp, type ArchivedFrame, type WeatherArchive } from './weather-archive.js';
import { registerWeatherMapsApi, weatherLayerMetas } from './weather-maps-api.js';

const NOW = Date.parse('2026-09-16T12:20:00Z');
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

/** A 256×256 tile filled with one RGBA value (16-bit when asked). */
function tile(rgba: [number, number, number, number], bitDepth: 8 | 16 = 8): Buffer {
  const png = new PNG({
    width: 256,
    height: 256,
    bitDepth,
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });
  const data = bitDepth === 16 ? new Uint16Array(256 * 256 * 4) : Buffer.alloc(256 * 256 * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  png.data = data as Buffer;
  return PNG.sync.write(png, { bitDepth, colorType: 6, inputColorType: 6, inputHasAlpha: true });
}

function readPixel(body: Buffer, x = 128, y = 128): number[] {
  const png = PNG.sync.read(body);
  const i = (y * png.width + x) * 4;
  return Array.from(png.data.subarray(i, i + 4));
}

interface Upstream {
  /** Upstream tile pixel per dataset name. */
  pixels: Partial<Record<string, [number, number, number, number]>>;
  /** Datasets that answer 404 for tiles. */
  missing?: Set<string>;
  alerts?: unknown;
  fail?: boolean;
}

function fakeMet(upstream: Upstream) {
  const requests: string[] = [];
  const minutes: Record<string, number[]> = {
    'precipitation-observations': [-100, -10, -5],
    'precipitation-nowcast': [-5, 0, 5, 200],
    'precipitation-amount': [-20, 40, 100, 5000],
    'air-temperature': [-20, 40, 100],
    wind: [-20, 40],
    'cloud-area-fraction': [-20, 40],
    'sea-temperature': [-20, 40],
  };
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    requests.push(url);
    if (upstream.fail) return new Response('down', { status: 503 });
    if (url.includes('metalerts'))
      return new Response(JSON.stringify(upstream.alerts ?? { features: [] }));
    const match =
      /\/api\/([a-z-]+)\/(available\.json|run\/(-?\d+)\/tiles\/\d+\/\d+\/\d+\.png)$/.exec(
        new URL(url).pathname,
      );
    if (!match) return new Response('no', { status: 404 });
    const name = match[1]!;
    if (match[2] === 'available.json') {
      const radar = name.startsWith('precipitation-o') || name.startsWith('precipitation-n');
      return new Response(
        JSON.stringify({
          bounds: radar ? [-8, 53, 41, 74] : [-180, -85, 180, 85],
          minzoom: 0,
          maxzoom: radar ? 6 : 5,
          times: (minutes[name] ?? []).map((m) => ({
            time: iso(m),
            tiles: {
              png: `https://prod.yr-maps.met.no/api/${name}/run/${m}/tiles/{z}/{x}/{y}.png`,
              webp: `https://prod.yr-maps.met.no/api/${name}/run/${m}/tiles/{z}/{x}/{y}.webp`,
            },
          })),
        }),
      );
    }
    if (upstream.missing?.has(name)) return new Response('', { status: 404 });
    const pixel = upstream.pixels[name];
    if (!pixel) return new Response('', { status: 404 });
    return new Response(new Uint8Array(tile(pixel, name === 'wind' ? 16 : 8)), {
      headers: { 'content-type': 'image/png' },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

let app: FastifyInstance | null = null;

async function start(upstream: Upstream, now = () => NOW, archive?: WeatherArchive) {
  const met = fakeMet(upstream);
  app = Fastify();
  registerWeatherMapsApi(app, { fetchImpl: met.fetchImpl, userAgent: 'test', now, archive });
  await app.ready();
  return { app, ...met };
}

afterEach(async () => {
  await app?.close();
  app = null;
});

const PIXELS: Upstream['pixels'] = {
  'air-temperature': [140, 0, 0, 255], // 12 °C
  'precipitation-amount': [0, 128, 255, 255], // level 4
  'precipitation-observations': [0, 85, 255, 255], // level 5
  'precipitation-nowcast': [145, 228, 255, 255],
  wind: [33086, 28370, 3000, 65535],
  'cloud-area-fraction': [200, 0, 0, 255],
  'sea-temperature': [76, 0, 0, 255],
};

describe('weather layer catalog rows', () => {
  it('offers one exclusive row per field plus the warnings, all in the Weather group', () => {
    const metas = weatherLayerMetas();
    expect(metas.map((m) => m.id)).toEqual([
      'weather-precipitation',
      'weather-wind',
      'weather-temperature',
      'weather-clouds',
      'weather-sea-temperature',
      'aurora-forecast',
      'weather-warnings',
    ]);
    expect(metas.every((m) => m.group === 'Weather')).toBe(true);
    const fields = metas.filter((m) => m.weather);
    expect(fields).toHaveLength(5);
    expect(fields.every((m) => m.exclusive === WEATHER_FIELD_GROUP && !m.vector)).toBe(true);
    expect(metas.at(-1)!.vector).toBe(true);
    // Outlines and badges read over any field, so warnings are not in the group.
    expect(metas.at(-1)!.exclusive).toBeUndefined();
    expect(weatherLayerMetas('frost-client').map((m) => m.id)).toContain('weather-lightning');
  });
});

describe('/api/weather/maps', () => {
  it('lists radar and forecast timelines inside their windows, with per-run frame ids', async () => {
    const { app } = await start({ pixels: PIXELS });
    const res = await app.inject('/api/weather/maps');
    expect(res.statusCode).toBe(200);
    const body = res.json<WeatherMapsResponse>();
    expect(body.layers.map((l) => l.id)).toEqual([
      'precipitation',
      'wind',
      'temperature',
      'clouds',
      'sea-temperature',
    ]);
    const rain = body.layers[0]!;
    const radar = rain.timelines.find((t) => t.id === 'radar')!;
    // −100 min is outside radar's window and +200 min beyond it; observed radar wins at −5.
    expect(radar.frames.map((f) => [f.time, f.kind])).toEqual([
      [iso(-10), 'observation'],
      [iso(-5), 'observation'],
      [iso(0), 'nowcast'],
      [iso(5), 'nowcast'],
    ]);
    expect(radar.bounds).toEqual([-8, 53, 41, 74]);
    // Painted three zooms deeper than the data.
    expect(radar.maxzoom).toBe(9);
    const forecast = rain.timelines.find((t) => t.id === 'forecast')!;
    expect(forecast.frames).toHaveLength(3); // +5000 min is past three days
    expect(forecast.frames[0]!.id).toMatch(/^forecast-20260916-120000-[0-9a-f]{8}$/);
    expect(forecast.frames[0]!.tilePath).toMatch(/\/\{z\}\/\{x\}\/\{y\}\.png\?v=\d+$/);
    // What the first release's bundles read is still there.
    expect(rain.frames.length).toBeGreaterThan(0);
    expect(rain.legend.length).toBeGreaterThan(0);
    expect(body.lightning.available).toBe(false);
  });

  it('502s with no catalog to fall back to', async () => {
    const { app } = await start({ pixels: PIXELS, fail: true });
    expect((await app.inject('/api/weather/maps')).statusCode).toBe(502);
  });
});

describe('painted tiles', () => {
  async function tilePath(app: FastifyInstance, layer: string, timeline = 'forecast', index = 0) {
    const body = (await app.inject('/api/weather/maps')).json<WeatherMapsResponse>();
    const frame = body.layers.find((l) => l.id === layer)!.timelines.find((t) => t.id === timeline)!
      .frames[index]!;
    return (z: number, x: number, y: number) =>
      frame.tilePath.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`);
  }

  it('paints temperature on the shared ramp and caches the result as immutable', async () => {
    const { app, requests } = await start({ pixels: PIXELS });
    const path = await tilePath(app, 'temperature');
    const res = await app.inject(path(3, 4, 2));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(readPixel(res.rawPayload)).toEqual([...rampRgb(TEMPERATURE_RAMP, 12), 255]);
    const upstreamTiles = () => requests.filter((u) => u.endsWith('.png')).length;
    const before = upstreamTiles();
    await app.inject(path(3, 4, 2));
    expect(upstreamTiles()).toBe(before);
    expect(requests.some((u) => u.endsWith('/run/-20/tiles/3/4/2.png'))).toBe(true);
  });

  it('draws precipitation as snow where the forecast air temperature is freezing', async () => {
    const warm = await start({ pixels: PIXELS });
    const warmTile = await warm.app.inject((await tilePath(warm.app, 'precipitation'))(5, 16, 9));
    expect(readPixel(warmTile.rawPayload).slice(0, 3)).toEqual(hex(RAIN_COLORS[3]!));
    await warm.app.close();

    const cold = await start({ pixels: { ...PIXELS, 'air-temperature': [127, 0, 0, 255] } });
    // A radar tile one zoom deeper than the temperature data still finds its temperature.
    const coldTile = await cold.app.inject(
      (await tilePath(cold.app, 'precipitation', 'radar'))(6, 33, 18),
    );
    expect(readPixel(coldTile.rawPayload).slice(0, 3)).toEqual(hex(SNOW_COLORS[4]!));
  });

  it('answers a transparent tile where MET has none, and 404s beyond the data', async () => {
    const { app } = await start({ pixels: PIXELS, missing: new Set(['wind']) });
    const path = await tilePath(app, 'wind');
    const empty = await app.inject(path(2, 1, 1));
    expect(empty.statusCode).toBe(200);
    expect(readPixel(empty.rawPayload)[3]).toBe(0);
    expect((await app.inject(path(9, 1, 1))).statusCode).toBe(404);
    expect((await app.inject(path(2, 9, 1))).statusCode).toBe(400);
    expect((await app.inject('/api/weather/maps/wind/nope/1/0/0.png')).statusCode).toBe(404);
  });

  it('serves the frame nearest now on the plain overlay path older clients draw', async () => {
    const { app } = await start({ pixels: PIXELS });
    const res = await app.inject('/api/overlay/weather-temperature/2/2/1.png?v=1');
    expect(res.statusCode).toBe(200);
    expect(readPixel(res.rawPayload)).toEqual([...rampRgb(TEMPERATURE_RAMP, 12), 255]);
  });
});

describe('/api/weather/maps/:layer/:frame/grid', () => {
  it('reads wind components over a viewport', async () => {
    const { app } = await start({ pixels: PIXELS });
    const body = (await app.inject('/api/weather/maps')).json<WeatherMapsResponse>();
    const frame = body.layers.find((l) => l.id === 'wind')!.timelines[0]!.frames[0]!;
    const res = await app.inject(
      `/api/weather/maps/wind/${frame.id}/grid?bbox=4,58,12,63&cols=4&rows=3`,
    );
    expect(res.statusCode).toBe(200);
    const grid = res.json<WeatherGridResponse>();
    expect(grid).toMatchObject({ layer: 'wind', cols: 4, rows: 3, time: frame.time });
    expect(grid.u).toHaveLength(12);
    expect(grid.u![0]).toBeCloseTo(0.72, 1);
    expect(grid.v![0]).toBeCloseTo(-10.07, 1);
    expect(grid.values).toBeUndefined();
  });

  it('rejects a malformed viewport', async () => {
    const { app } = await start({ pixels: PIXELS });
    for (const query of [
      'bbox=4,58,2,63&cols=4&rows=3',
      'bbox=4,58,12,63&cols=400&rows=3',
      'cols=4',
    ]) {
      expect((await app.inject(`/api/weather/maps/wind/x/grid?${query}`)).statusCode).toBe(400);
    }
  });
});

describe('/api/weather/maps/point', () => {
  it('samples every layer at the nearest frames, preferring radar where it has a picture', async () => {
    const { app } = await start({ pixels: PIXELS });
    const res = await app.inject(`/api/weather/maps/point?lat=59.91&lng=10.75&time=${iso(-6)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json<WeatherPointSample>()).toEqual({
      time: iso(-5),
      temperatureC: 12,
      wind: { speed: 10.1, fromDeg: 356 },
      precipitation: { level: 5, frozen: false, radar: true },
      cloudCoverPct: 100,
      seaTemperatureC: 16.5,
    });
  });

  it('falls back to the forecast outside radar coverage and past the radar window', async () => {
    const { app } = await start({
      pixels: { ...PIXELS, 'precipitation-observations': [255, 255, 255, 255] },
    });
    const outside = (
      await app.inject(`/api/weather/maps/point?lat=59.91&lng=10.75&time=${iso(-6)}`)
    ).json<WeatherPointSample>();
    expect(outside.precipitation).toEqual({ level: 4, frozen: false, radar: false });
    const later = (
      await app.inject(`/api/weather/maps/point?lat=59.91&lng=10.75&time=${iso(95)}`)
    ).json<WeatherPointSample>();
    expect(later.precipitation?.radar).toBe(false);
    expect(later.time).toBe(iso(100));
  });

  it('rejects bad coordinates', async () => {
    const { app } = await start({ pixels: PIXELS });
    expect((await app.inject('/api/weather/maps/point?lat=x&lng=1')).statusCode).toBe(400);
  });
});

describe('radar history from the archive', () => {
  const archived = (dataset: string, minutes: number): ArchivedFrame => {
    const ms = NOW + minutes * 60_000;
    return {
      dataset,
      time: new Date(ms).toISOString(),
      ms,
      stamp: archiveStamp(ms),
      bounds: [-8, 53, 41, 74],
      minzoom: 0,
      maxzoom: dataset === 'air-temperature' ? 5 : 6,
    };
  };
  /** An archive of whole frames whose every tile is one pixel value. */
  function fakeArchive(
    frames: Record<string, ArchivedFrame[]>,
    pixels: Record<string, [number, number, number, number]>,
  ) {
    const reads: string[] = [];
    const archive: WeatherArchive = {
      frames: async (dataset) => frames[dataset] ?? [],
      tile: async (frame, z, x, y) => {
        reads.push(`${frame.dataset}/${frame.stamp}/${z}/${x}/${y}`);
        const pixel = pixels[frame.dataset];
        return pixel ? tile(pixel) : null;
      },
      capture: async () => {},
      start: () => {},
      stop: async () => {},
    };
    return { archive, reads };
  }

  it('reaches a day back before MET’s live window, without overlapping it', async () => {
    const { archive } = fakeArchive(
      {
        'precipitation-observations': [-26 * 60, -5 * 60, -15, -10].map((m) =>
          archived('precipitation-observations', m),
        ),
      },
      {},
    );
    const { app } = await start({ pixels: PIXELS }, () => NOW, archive);
    const body = (await app.inject('/api/weather/maps')).json<WeatherMapsResponse>();
    const rain = body.layers.find((l) => l.id === 'precipitation')!;
    const radar = rain.timelines.find((t) => t.id === 'radar')!;
    // Older than a day is dropped; −10 is MET's own live picture, not the archive's.
    expect(radar.frames.map((f) => [f.time, f.kind])).toEqual([
      [iso(-5 * 60), 'observation'],
      [iso(-15), 'observation'],
      [iso(-10), 'observation'],
      [iso(-5), 'observation'],
      [iso(0), 'nowcast'],
      [iso(5), 'nowcast'],
    ]);
    expect(radar.frames[0]!.id).toMatch(/^observation-20260916-072000-[0-9a-f]{8}$/);
    // Bundles from before timelines keep MET's live window only.
    expect(rain.frames.some((f) => f.time === iso(-5 * 60))).toBe(false);
  });

  it('paints an archived picture from disk, with the snow phase of its own hour', async () => {
    const { archive, reads } = fakeArchive(
      {
        'precipitation-observations': [archived('precipitation-observations', -5 * 60)],
        'air-temperature': [archived('air-temperature', -5 * 60 - 20)],
      },
      {
        'precipitation-observations': [0, 85, 255, 255], // level 5
        'air-temperature': [127, 0, 0, 255], // −1 °C
      },
    );
    const { app, requests } = await start({ pixels: PIXELS }, () => NOW, archive);
    const body = (await app.inject('/api/weather/maps')).json<WeatherMapsResponse>();
    const frame = body.layers
      .find((l) => l.id === 'precipitation')!
      .timelines.find((t) => t.id === 'radar')!.frames[0]!;
    const before = requests.filter((u) => u.endsWith('.png')).length;
    const res = await app.inject(
      frame.tilePath.replace('{z}', '6').replace('{x}', '33').replace('{y}', '18'),
    );
    expect(res.statusCode).toBe(200);
    expect(readPixel(res.rawPayload).slice(0, 3)).toEqual(hex(SNOW_COLORS[4]!));
    // Nothing of it came from MET: those runs no longer exist upstream.
    expect(requests.filter((u) => u.endsWith('.png')).length).toBe(before);
    expect(reads.some((r) => r.startsWith('precipitation-observations/'))).toBe(true);
    expect(reads.some((r) => r.startsWith('air-temperature/'))).toBe(true);

    // A tap at that time answers from the same archived pictures.
    const sample = (
      await app.inject(`/api/weather/maps/point?lat=59.91&lng=10.75&time=${iso(-5 * 60 + 2)}`)
    ).json<WeatherPointSample>();
    expect(sample).toMatchObject({
      time: iso(-5 * 60),
      temperatureC: -1,
      precipitation: { level: 5, frozen: true, radar: true },
    });
  });
});

describe('/api/overlay/weather-warnings/features', () => {
  const alert = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [5, 60],
          [6, 60],
          [6, 61],
          [5, 61],
          [5, 60],
        ],
      ],
    },
    properties: { id: 'a', awareness_level: '3; orange; Severe', event: 'rain', area: 'Vestland' },
    when: { interval: [iso(-60), iso(600)] },
  };

  it('serves MET’s live warnings as areas with badges, and stale ones when MET is down', async () => {
    const started = await start({ pixels: PIXELS, alerts: { features: [alert] } });
    const res = await started.app.inject('/api/overlay/weather-warnings/features');
    expect(res.statusCode).toBe(200);
    const fc = res.json<GeoJSON.FeatureCollection>();
    expect(fc.features.map((f) => f.geometry.type)).toEqual(['Polygon', 'Point']);
    expect(fc.features[0]!.properties).toMatchObject({ level: 'orange', eventLabel: 'Heavy rain' });
  });

  it('502s when MET is down and nothing was cached', async () => {
    const { app } = await start({ pixels: PIXELS, fail: true });
    expect((await app.inject('/api/overlay/weather-warnings/features')).statusCode).toBe(502);
  });
});

describe('live sky layers', () => {
  it('authenticates to Frost server-side, scopes lightning to the viewport and caches it', async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://frost.met.no');
      expect(url.searchParams.get('referencetime')).toBe('latest');
      expect(url.searchParams.get('maxage')).toBe('PT24H');
      expect(url.searchParams.get('geometry')).toContain('POLYGON((8 58,12 58');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Basic ${Buffer.from('client-id:').toString('base64')}`,
      );
      return new Response(
        '0 2026 09 16 12 15 00 0 60.1000 10.2000 -24 0 5 7 0 0 0 0 0 0 0 1 1 0 1\n',
      );
    });
    app = Fastify();
    registerWeatherMapsApi(app, {
      fetchImpl: fetchImpl as typeof fetch,
      frostClientId: 'client-id',
      userAgent: 'test',
      now: () => NOW,
    });
    await app.ready();

    const url = '/api/overlay/weather-lightning/features?bbox=8.1,58.2,11.9,61.1&window=24h';
    const first = await app.inject(url);
    expect(first.statusCode).toBe(200);
    expect(first.json().features[0]).toMatchObject({
      geometry: { coordinates: [10.2, 60.1] },
      properties: { ageMinutes: 5, polarity: 'negative', peakCurrentKa: -24 },
    });
    await app.inject(url);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      (await app.inject('/api/overlay/weather-lightning/features?bbox=-180,-80,180,80')).statusCode,
    ).toBe(400);
  });

  it('turns NOAA OVATION probability into a transparent, refreshable raster', async () => {
    const coordinates = Array.from({ length: 360 * 181 }, (_, index) => {
      const lng = Math.floor(index / 181);
      const lat = (index % 181) - 90;
      return [lng, lat, lat > 55 ? 80 : 0];
    });
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('ovation_aurora')) {
        return Response.json({
          'Observation Time': '2026-09-16T12:00:00Z',
          'Forecast Time': '2026-09-16T12:45:00Z',
          coordinates,
        });
      }
      if (url.includes('VIIRS_Night_Lights')) {
        return new Response(new Uint8Array(tile([0, 0, 0, 255])), {
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response('', { status: 404 });
    });
    app = Fastify();
    registerWeatherMapsApi(app, { fetchImpl: fetchImpl as typeof fetch, userAgent: 'test' });
    await app.ready();

    const first = await app.inject('/api/overlay/aurora-forecast/0/0/0.png?v=1');
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.headers['cache-control']).toContain('max-age=240');
    expect(first.headers['x-atlas-forecast-time']).toBe('2026-09-16T12:45:00Z');
    expect(readPixel(first.rawPayload, 128, 32)[3]).toBeGreaterThan(0);
    expect(readPixel(first.rawPayload, 128, 128)[3]).toBe(0);
    const metadata = await app.inject('/api/weather/aurora');
    expect(metadata.json()).toMatchObject({
      forecastTime: '2026-09-16T12:45:00Z',
      factors: ['aurora', 'darkness', 'clouds', 'light-pollution'],
    });
    await app.inject('/api/overlay/aurora-forecast/0/0/0.png?v=2');
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).includes('ovation_aurora')),
    ).toHaveLength(1);
  });
});

function hex(color: string): number[] {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
