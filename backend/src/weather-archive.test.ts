import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StatusRegistry } from './status.js';
import {
  archiveStamp,
  createWeatherArchive,
  tilesCovering,
  type ArchiveDataset,
} from './weather-archive.js';

const MINUTE = 60_000;
const NOW = Date.parse('2026-09-16T12:20:00Z');
const at = (iso: string) => Date.parse(iso);

/** Small bounds and shallow zooms keep a frame to a handful of tiles. */
const BOUNDS: [number, number, number, number] = [8, 58, 12, 62];
const DATASETS: ArchiveDataset[] = [
  { name: 'precipitation-observations', everyMs: 15 * MINUTE, maxzoom: 3, pastOnly: true },
  { name: 'air-temperature', everyMs: 60 * MINUTE, maxzoom: 2, pastOnly: true },
];

function png(r: number): Buffer {
  const image = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < image.data.length; i += 4) image.data.set([r, 0, 0, 255], i);
  return PNG.sync.write(image);
}

interface FakeMet {
  times: Record<string, string[]>;
  /** Tile URLs containing this answer 503. */
  failing?: string;
  /** Tile URLs containing this answer 404. */
  absent?: string;
  catalogDown?: boolean;
}

function fakeMet(met: FakeMet) {
  const requests: string[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    requests.push(url);
    const match = /\/api\/([a-z-]+)\/(available\.json|(\d{12})\/tiles\/(\d+)\/\d+\/\d+\.png)$/.exec(
      new URL(url).pathname,
    );
    if (!match) return new Response('no', { status: 404 });
    const name = match[1]!;
    if (match[2] === 'available.json') {
      if (met.catalogDown && name === 'precipitation-observations') {
        return new Response('down', { status: 503 });
      }
      return Response.json({
        bounds: name === 'precipitation-observations' ? BOUNDS : [-180, -85, 180, 85],
        minzoom: 0,
        maxzoom: name === 'precipitation-observations' ? 6 : 5,
        times: (met.times[name] ?? []).map((time) => {
          const stamp = time.replace(/[-:]/g, '').slice(0, 13).replace('T', '');
          return {
            time,
            tiles: {
              png: `https://prod.yr-maps.met.no/api/${name}/${stamp}/tiles/{z}/{x}/{y}.png`,
            },
          };
        }),
      });
    }
    if (met.failing && url.includes(met.failing)) return new Response('', { status: 503 });
    if (met.absent && url.includes(met.absent)) return new Response('', { status: 404 });
    return new Response(new Uint8Array(png(Number(match[4]) * 10)), {
      headers: { 'content-type': 'image/png' },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'atlas-weather-archive-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('weather archive', () => {
  it('keeps aligned past frames whole, at every zoom over the radar bounds', async () => {
    const met = fakeMet({
      times: {
        'precipitation-observations': [
          '2026-09-16T11:50:00Z', // not on the quarter hour
          '2026-09-16T12:00:00Z',
          '2026-09-16T12:15:00Z',
          '2026-09-16T12:30:00Z', // the future
        ],
        'air-temperature': ['2026-09-16T12:00:00Z', '2026-09-16T13:00:00Z'],
      },
      absent: '/tiles/3/',
    });
    const status = new StatusRegistry(() => NOW);
    const archive = createWeatherArchive({
      dir,
      fetchImpl: met.fetchImpl,
      now: () => NOW,
      datasets: DATASETS,
      status,
    });
    await archive.capture();
    expect(status.toStatus().find((row) => row.id === 'weather-archive')).toMatchObject({
      health: 'ok',
      detail: '2 radar frames, 0.3 h back, newest 5 min old',
    });

    const radar = await archive.frames('precipitation-observations');
    expect(radar.map((frame) => frame.time)).toEqual([
      '2026-09-16T12:00:00.000Z',
      '2026-09-16T12:15:00.000Z',
    ]);
    expect(radar[0]).toMatchObject({ bounds: BOUNDS, minzoom: 0, maxzoom: 3 });
    expect((await archive.frames('air-temperature')).map((frame) => frame.time)).toEqual([
      '2026-09-16T12:00:00.000Z',
    ]);

    // Every zoom the painter reads, clipped to the radar bounds — never the globe.
    const z2 = tilesCovering(BOUNDS, 2)[0]!;
    expect(PNG.sync.read((await archive.tile(radar[0]!, 2, z2.x, z2.y))!).data[0]).toBe(20);
    const temperatureTiles = met.requests.filter((url) => url.includes('air-temperature/'));
    expect(temperatureTiles.filter((url) => url.endsWith('.png'))).toHaveLength(
      [0, 1, 2].reduce((sum, z) => sum + tilesCovering(BOUNDS, z).length, 0),
    );
    // MET had no tile: remembered as absent, not as a failure.
    const z3 = tilesCovering(BOUNDS, 3)[0]!;
    expect(await archive.tile(radar[0]!, 3, z3.x, z3.y)).toBeNull();

    // A second pass fetches the catalogs and nothing else.
    const before = met.requests.length;
    await archive.capture();
    expect(met.requests.slice(before).every((url) => url.endsWith('available.json'))).toBe(true);

    // A restarted backend finds the frames on disk.
    const reopened = createWeatherArchive({ dir, now: () => NOW, datasets: DATASETS });
    expect(await reopened.frames('precipitation-observations')).toHaveLength(2);
  });

  it('stores nothing of a frame whose tiles failed, and retries it on the next pass', async () => {
    const met = fakeMet({
      times: { 'precipitation-observations': ['2026-09-16T12:15:00Z'] },
      failing: '/tiles/2/',
    });
    const archive = createWeatherArchive({
      dir,
      fetchImpl: met.fetchImpl,
      now: () => NOW,
      datasets: DATASETS,
    });
    await archive.capture();
    expect(await archive.frames('precipitation-observations')).toEqual([]);
    expect(await readdir(path.join(dir, 'precipitation-observations'))).toEqual([]);

    const retry = createWeatherArchive({
      dir,
      fetchImpl: fakeMet({ times: { 'precipitation-observations': ['2026-09-16T12:15:00Z'] } })
        .fetchImpl,
      now: () => NOW,
      datasets: DATASETS,
    });
    await retry.capture();
    expect(await retry.frames('precipitation-observations')).toHaveLength(1);
  });

  it('forgets frames once they are older than a day', async () => {
    let clock = NOW;
    const archive = createWeatherArchive({
      dir,
      fetchImpl: fakeMet({
        times: {
          'precipitation-observations': ['2026-09-16T12:00:00Z', '2026-09-16T12:15:00Z'],
        },
      }).fetchImpl,
      now: () => clock,
      datasets: DATASETS,
      keepMs: 24 * 60 * MINUTE,
    });
    await archive.capture();
    expect(await archive.frames('precipitation-observations')).toHaveLength(2);

    clock = at('2026-09-17T12:10:00Z');
    expect((await archive.frames('precipitation-observations')).map((f) => f.stamp)).toEqual([
      archiveStamp(at('2026-09-16T12:15:00Z')),
    ]);
    await archive.capture();
    expect(await readdir(path.join(dir, 'precipitation-observations'))).toEqual([
      archiveStamp(at('2026-09-16T12:15:00Z')),
    ]);
  });

  it('archives nothing without the radar catalog to bound it', async () => {
    const met = fakeMet({
      times: { 'air-temperature': ['2026-09-16T12:00:00Z'] },
      catalogDown: true,
    });
    const archive = createWeatherArchive({
      dir,
      fetchImpl: met.fetchImpl,
      now: () => NOW,
      datasets: DATASETS,
    });
    await archive.capture();
    expect(met.requests.some((url) => url.endsWith('.png'))).toBe(false);
    expect(await archive.frames('air-temperature')).toEqual([]);
  });
});
