import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { writeArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cellRaster, type Cell } from './cells.js';
import { deriveCell, readSignal, signalsPath, type CellManifest } from './derive.js';
import type { PotentialContext } from './inputs.js';
import { confluenceNodes, orientDownstream, riverModel } from './river.js';

/**
 * The river adapter against stubbed upstreams — the half of E4 that a synthetic
 * grid in `@atlas/potential` cannot reach, because everything tested here is
 * about turning NVE's and Miljødirektoratet's *vectors* into the rasters the
 * engine expects: which end of a channel is uphill, which junctions are real,
 * which catchment's water a reach carries, and which stretches laks can reach.
 *
 * The real services are exercised separately and by hand; this suite stays
 * offline so it runs in the quality gate.
 */

const CELL: Cell = { z: 11, x: 1083, y: 596 };
const RASTER = cellRaster(CELL);
const log = { warn: () => {} };

/** The stubbed river runs down this meridian, north (high) to south (low). */
const RIVER_LNG = 10.44;
/** Where the tributary meets it. */
const JUNCTION_LAT = 59.85;

/**
 * Terrain falling to the south at ~2 % — a riffle everywhere — with one flat
 * band across the middle rows, which is the only pool in the cell.
 */
let terrainCache: ArrayBuffer | null = null;
async function terrain(): Promise<ArrayBuffer> {
  if (terrainCache) return terrainCache;
  const size = RASTER.size;
  const values = new Float32Array(size * size);
  const flatFrom = 520;
  const flatTo = 700;
  for (let y = 0; y < size; y++) {
    // y grows south, so elevation falls as y rises.
    const drop =
      y <= flatFrom ? y * 0.2 : y >= flatTo ? (y - (flatTo - flatFrom)) * 0.2 : flatFrom * 0.2;
    for (let x = 0; x < size; x++) values[y * size + x] = 300 - drop;
  }
  terrainCache = (await writeArrayBuffer(values, { width: size, height: size })) as ArrayBuffer;
  return terrainCache;
}

const ar5Cache = new Map<string, Buffer>();
function ar5Png(rgb: [number, number, number]): Buffer {
  const key = rgb.join(',');
  const hit = ar5Cache.get(key);
  if (hit) return hit;
  const size = RASTER.size;
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  const buf = PNG.sync.write(png);
  ar5Cache.set(key, buf);
  return buf;
}

const geojson = (features: unknown[]) =>
  new Response(JSON.stringify({ type: 'FeatureCollection', features }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const line = (coords: [number, number][], properties: Record<string, unknown>) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coords },
  properties,
});

/** The main stem, split at its junction exactly as NVE splits a network. */
const mainUpper = line(
  [
    [RIVER_LNG, 59.886],
    [RIVER_LNG, 59.87],
    [RIVER_LNG, JUNCTION_LAT],
  ],
  { ltema: 3211, elveordenstrahler: 5, elvenavnhierarki: 'Storelva', vatnlnr: null },
);
const mainLower = line(
  [
    [RIVER_LNG, JUNCTION_LAT],
    [RIVER_LNG, 59.83],
    [RIVER_LNG, 59.802],
  ],
  { ltema: 3211, elveordenstrahler: 5, elvenavnhierarki: 'Storelva', vatnlnr: null },
);
/** A real tributary — a confluence. */
const tributary = line(
  [
    [10.4, 59.868],
    [10.42, 59.858],
    [RIVER_LNG, JUNCTION_LAT],
  ],
  { ltema: 3211, elveordenstrahler: 3, elvenavnhierarki: 'Sideelva', vatnlnr: null },
);
/** A lake through-flow centreline, which must never reach the river model. */
const throughFlow = line(
  [
    [10.48, 59.86],
    [10.49, 59.855],
  ],
  { ltema: 3103, elveordenstrahler: 5, elvenavnhierarki: 'Storelva', vatnlnr: 42 },
);

const catchment = (
  name: string,
  q: number,
  bounds: { west: number; east: number; south: number; north: number },
) => ({
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.south],
        [bounds.east, bounds.north],
        [bounds.west, bounds.north],
        [bounds.west, bounds.south],
      ],
    ],
  },
  properties: {
    nedborfeltnavn: name,
    vassdragsnr: '012.Z',
    areal_km2: q * 2,
    qnormal_mm3aar: q,
  },
});

const anadromousStretch = line(
  [
    [RIVER_LNG, JUNCTION_LAT],
    [RIVER_LNG, 59.802],
  ],
  {
    elvenavn: 'Storelva',
    vassdragsNR: '012.Z',
    nasjonaltLaksevassdrag: 'Ja',
    lakseregURL: 'https://lakseregisteret.statsforvalteren.no/visElv.aspx?id=012.Z',
  },
);

const barrier = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [RIVER_LNG, JUNCTION_LAT] },
  properties: {
    hindertype: 'Vandringsstopp',
    hinderaarsak: 'Foss',
    informasjon: 'Storefossen',
  },
};

interface StubOptions {
  streams?: unknown[];
  lakes?: unknown[];
  catchments?: unknown[];
  anadromous?: unknown[];
  barriersLaks?: unknown[];
  landCover?: [number, number, number];
  /** Upstreams that refuse to answer at all, by the fragment their URL carries. */
  dead?: string[];
}

function upstreamStub(over: StubOptions = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const fragment of over.dead ?? []) {
      // What a broken TLS chain looks like from in here: not a 500 body, but a
      // fetch that never completes. Miljødirektoratet really has done this.
      if (url.includes(fragment)) throw new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    }
    if (url.includes('wcs.hoyde-dtm')) return new Response(await terrain(), { status: 200 });
    if (url.includes('Innsjodatabase2/MapServer/5')) return geojson(over.lakes ?? []);
    if (url.includes('Elvenett1/MapServer/2')) {
      return geojson(over.streams ?? [mainUpper, mainLower, tributary, throughFlow]);
    }
    if (url.includes('Nedborfelt2/MapServer/3')) {
      return geojson(
        over.catchments ?? [
          catchment('Storelvvassdraget', 8000, {
            west: 10.3,
            east: 10.6,
            south: 59.79,
            north: 59.9,
          }),
        ],
      );
    }
    if (url.includes('anadrome_laksefisk/MapServer/4')) {
      return geojson(over.anadromous ?? [anadromousStretch]);
    }
    if (url.includes('anadrome_laksefisk/MapServer/0')) {
      return geojson(over.barriersLaks ?? [barrier]);
    }
    if (url.includes('anadrome_laksefisk/MapServer/1')) return geojson([]);
    if (url.includes('cgi-bin/ar5')) {
      return new Response(ar5Png(over.landCover ?? [158, 204, 115]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    throw new Error(`unstubbed upstream: ${url}`);
  });
}

let dataDir: string;
let cacheDir: string;
const contexts: PotentialContext[] = [];

function context(over: StubOptions = {}): PotentialContext {
  const ctx: PotentialContext = {
    fetchImpl: upstreamStub(over),
    cacheDir: path.join(cacheDir, String(contexts.length)),
    userAgent: 'atlas-test',
    record: () => {},
    log,
  };
  contexts.push(ctx);
  return ctx;
}

/** One signal sample of a derived cell, by geographic position. */
async function signalAt(
  manifest: CellManifest,
  target: string,
  key: string,
  at: { lat: number; lng: number },
): Promise<number> {
  const planes = gunzipSync(await readFile(signalsPath(dataDir, riverModel, target, CELL)));
  const index = manifest.signals!.planes.indexOf(key);
  expect(index).toBeGreaterThanOrEqual(0);
  const [west, south, east, north] = manifest.bounds;
  const pixels = manifest.signals!.pixels;
  return readSignal(
    planes,
    index,
    Math.floor(((at.lng - west) / (east - west)) * pixels),
    Math.floor(((north - at.lat) / (north - south)) * pixels),
  );
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-river-'));
  cacheDir = await mkdtemp(path.join(tmpdir(), 'atlas-river-cache-'));
  contexts.length = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

describe('reading the network', () => {
  it('counts a real tributary as a confluence and a ditch mouth as not', () => {
    const streams = [mainUpper, mainLower, tributary].map((f) => ({
      ltema: 3211,
      strahler: f.properties['elveordenstrahler'] as number,
      name: null,
      vatnlnr: null,
      paths: [f.geometry.coordinates as [number, number][]],
    }));
    const nodes = confluenceNodes(streams);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.point[1]).toBeCloseTo(JUNCTION_LAT, 6);
    expect(nodes[0]!.branches).toBe(3);

    // The same junction with a first-order ditch instead of the tributary. NVE
    // splits the main stem either way, so the node still has three ends — only
    // the *smallest* order tells the two cases apart.
    const withDitch = confluenceNodes([...streams.slice(0, 2), { ...streams[2]!, strahler: 1 }]);
    expect(withDitch).toHaveLength(0);
  });

  it('orients a channel by the ground, whichever way it was digitised', () => {
    const downhill = [300, 298, 296, 294, 292, 290];
    expect(orientDownstream(downhill)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(orientDownstream([...downhill].reverse())).toEqual([5, 4, 3, 2, 1, 0]);
    // No elevation at all: leave it alone. A profile with no ground carries no
    // gradient either, so the orientation cannot matter.
    expect(orientDownstream([Number.NaN, Number.NaN])).toEqual([0, 1]);
  });
});

describe('the river adapter', () => {
  it('derives a channel network, telling pool from riffle', async () => {
    const result = await deriveCell(dataDir, riverModel, 'orret', CELL, context());

    expect(result.tiles).toBe(21);
    // A corridor along the channels, not the whole 9.8 km cell.
    expect(result.manifest.coverage).toBeGreaterThan(0);
    expect(result.manifest.coverage).toBeLessThan(0.1);

    const keys = result.manifest.signals!.terms.map((t) => t.key);
    expect(keys).toContain('pool');
    expect(keys).toContain('riffle');
    expect(keys).toContain('confluence');
    expect(keys).toContain('magnitude');
    expect(keys).toContain('cover');

    // The flat band is a pool and the sloping reaches are riffle — the whole
    // point of measuring the water surface in percent.
    const pool = await signalAt(result.manifest, 'orret', 'pool', { lat: 59.839, lng: RIVER_LNG });
    const riffle = await signalAt(result.manifest, 'orret', 'riffle', {
      lat: 59.878,
      lng: RIVER_LNG,
    });
    expect(pool).toBeGreaterThan(0.5);
    expect(riffle).toBeGreaterThan(0.5);

    const notes = result.manifest.notes.join(' ');
    expect(notes).toMatch(/km of channel read/);
    expect(notes).toMatch(/1 confluence of real tributaries/);
  });

  it('never reads a lake through-flow centreline as a river', async () => {
    // `throughFlow` is `ltema` 3103 — Elvenett routes every stream through its
    // lake, and scoring those lines would put the surface down the middle of
    // water the lake model reads properly.
    const result = await deriveCell(dataDir, riverModel, 'orret', CELL, context());
    const onCentreline = await signalAt(result.manifest, 'orret', 'rank', {
      lat: 59.8575,
      lng: 10.485,
    });
    expect(Number.isNaN(onCentreline)).toBe(true);
  });

  it('bounds a reach by the water its catchment actually carries', async () => {
    // Two catchments side by side, exactly as they tile in reality: a 250 m³/s
    // watershed north of the junction and a 0.15 m³/s coastal one south of it.
    // The channel is 5th-order throughout, so Strahler alone would call both a
    // large river.
    const ctx = context({
      catchments: [
        catchment('Storelvvassdraget', 8000, {
          west: 10.3,
          east: 10.6,
          south: JUNCTION_LAT,
          north: 59.9,
        }),
        catchment('Vesleelva', 4.7, {
          west: 10.3,
          east: 10.6,
          south: 59.79,
          north: JUNCTION_LAT,
        }),
      ],
    });
    const result = await deriveCell(dataDir, riverModel, 'orret', CELL, ctx);
    const big = await signalAt(result.manifest, 'orret', 'magnitude', {
      lat: 59.87,
      lng: RIVER_LNG,
    });
    const small = await signalAt(result.manifest, 'orret', 'magnitude', {
      lat: 59.82,
      lng: RIVER_LNG,
    });
    expect(big).toBeGreaterThan(0.6);
    expect(small).toBeLessThan(0.2);
    expect(result.manifest.notes.join(' ')).toMatch(/m³\/s mean flow/);
  });

  it('offers every species with river weights, laks and sjøørret included', () => {
    const values = riverModel.targets.map((t) => t.value);
    expect(values).toEqual(['orret', 'roye', 'abbor', 'gjedde', 'laks', 'sjoorret']);
    for (const target of riverModel.targets) expect(target.caption).toMatch(/weigh heaviest/);
  });

  it('draws nothing at all where no channel is mapped', async () => {
    const result = await deriveCell(dataDir, riverModel, 'orret', CELL, context({ streams: [] }));
    expect(result.manifest.coverage).toBe(0);
    expect(result.manifest.notes).toContain('No mapped river or stream in this area.');
  });
});

describe('the anadromous targets', () => {
  it('scores only the mapped stretch, and links the register rather than judging it', async () => {
    const inland = await deriveCell(dataDir, riverModel, 'orret', CELL, context());
    const salmon = await deriveCell(dataDir, riverModel, 'laks', CELL, context());

    // The gate is the whole difference: ørret read the entire network, laks only
    // the stretch below the junction that the directorate has mapped.
    expect(salmon.manifest.coverage).toBeGreaterThan(0);
    expect(salmon.manifest.coverage).toBeLessThan(inland.manifest.coverage);
    const above = await signalAt(salmon.manifest, 'laks', 'rank', { lat: 59.878, lng: RIVER_LNG });
    expect(Number.isNaN(above)).toBe(true);

    // Whether a river is open this week is decided by emergency forskrift and
    // exists in no machine-readable form, so the answer is the per-river link —
    // never a verdict of ours.
    const notes = salmon.manifest.notes.join(' ');
    expect(notes).toMatch(/lakseregisteret\.statsforvalteren\.no/);
    expect(notes).toMatch(/check .* before fishing/i);
    expect(notes).toMatch(/nasjonalt laksevassdrag/);
  });

  it('holds fish below the falls and not above them', async () => {
    const result = await deriveCell(dataDir, riverModel, 'laks', CELL, context());
    expect(result.manifest.signals!.terms.map((t) => t.key)).toContain('barrier-pool');
    expect(result.manifest.notes.join(' ')).toMatch(/Storefossen/);
    // Just below the barrier at the junction; above it is outside the gate here,
    // which is the same answer by a different route.
    const below = await signalAt(result.manifest, 'laks', 'barrier-pool', {
      lat: JUNCTION_LAT - 0.001,
      lng: RIVER_LNG,
    });
    expect(below).toBeGreaterThan(0.5);
  });

  it('says there is nothing to reach rather than drawing an empty layer', async () => {
    const result = await deriveCell(
      dataDir,
      riverModel,
      'laks',
      CELL,
      context({ anadromous: [], barriersLaks: [] }),
    );
    expect(result.manifest.coverage).toBe(0);
    expect(result.manifest.notes.join(' ')).toMatch(/No anadromous water is mapped here/);
  });

  /**
   * The live drive's finding, and the reason the test above is not enough: both
   * states hand the model `[]`, and only one of them is a fact about the river.
   * A dead upstream that reads as "nothing here" is the failure mode N7 exists
   * to catch, arriving by a route N7 cannot see — the fetch is *inside* a
   * derive, so the layer stays green while every cell it produces is a
   * confident blank.
   */
  it('fails the cell when the gate could not be read, rather than blaming the river', async () => {
    await expect(
      deriveCell(dataDir, riverModel, 'laks', CELL, context({ dead: ['MapServer/4'] })),
    ).rejects.toThrow(/anadromous input failed/);

    // Barriers are the same claim from the other side: without them the dead
    // water above the falls would score like the pool below it.
    await expect(
      deriveCell(dataDir, riverModel, 'laks', CELL, context({ dead: ['MapServer/0'] })),
    ).rejects.toThrow(/barriers input failed/);
  });

  /**
   * Live data caught this: Hellefoss on the Drammenselva comes back as
   * `TemporærtHinder` with `informasjon: "Hellefoss, trapp her."` — a falls with
   * a ladder in it. Flattening it into a `Vandringsstopp` made the manifest tell
   * a Drammenselva salmon fisher that nothing runs above one of the most fished
   * pools in the country.
   */
  it('only says "never above" of a barrier the directorate calls a Vandringsstopp', async () => {
    const ladder = {
      ...barrier,
      properties: {
        ...barrier.properties,
        hindertype: 'TemporærtHinder',
        informasjon: 'Trappfossen, trapp her.',
      },
    };
    const passable = await deriveCell(
      dataDir,
      riverModel,
      'laks',
      CELL,
      context({ barriersLaks: [ladder] }),
    );
    expect(passable.manifest.notes.join(' ')).toMatch(/gather below them, and some pass/);
    expect(passable.manifest.notes.join(' ')).not.toMatch(/never above/);

    // …and still holds them below it: a ladder is a queue, not an open door.
    expect(passable.manifest.signals!.terms.map((t) => t.key)).toContain('barrier-pool');

    const stop = await deriveCell(dataDir, riverModel, 'laks', CELL, context());
    expect(stop.manifest.notes.join(' ')).toMatch(/never above/);
  });

  it('lets an inland target through when only the anadromous upstreams are down', async () => {
    // ørret weight neither signal, so the same outage costs them nothing — and
    // failing their cell too would take the whole layer down with one service.
    const result = await deriveCell(
      dataDir,
      riverModel,
      'orret',
      CELL,
      context({ dead: ['MapServer/4', 'MapServer/0'] }),
    );
    expect(result.manifest.coverage).toBeGreaterThan(0);
  });
});
