import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { writeArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cellRaster, type Cell } from './cells.js';
import { deriveCell, readSignal, signalsPath } from './derive.js';
import { gatherInputs, type PotentialContext } from './inputs.js';
import { registerPotentialApi } from './index.js';
import { lakeModel } from './lake.js';

/**
 * The lake model against stubbed upstreams — the half of E3 that a synthetic
 * grid in `@atlas/potential` cannot reach, because everything tested here is
 * about turning NVE's *vectors* into the rasters the engine expects.
 *
 * The real services are exercised separately and by hand (the Semsvannet /
 * Dikemark reference pair); this suite has to stay offline so it can run in the
 * quality gate.
 */

const CELL: Cell = { z: 11, x: 1083, y: 596 };
const RASTER = cellRaster(CELL);
const log = { warn: () => {} };

/** The stubbed lake: a rectangle in the middle of the cell. */
const LAKE = { west: 10.418, east: 10.424, south: 59.856, north: 59.861 };

const ring = (b: typeof LAKE) => [
  [b.west, b.south],
  [b.east, b.south],
  [b.east, b.north],
  [b.west, b.north],
  [b.west, b.south],
];

/**
 * Terrain that falls to the south, so which end of a channel is downhill is
 * unambiguous — that is the whole basis of the outlet test.
 */
let terrainCache: ArrayBuffer | null = null;
async function slopingTerrain(): Promise<ArrayBuffer> {
  if (terrainCache) return terrainCache;
  const size = RASTER.size;
  const values = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    // y grows south, so elevation falls as y rises.
    for (let x = 0; x < size; x++) values[y * size + x] = 300 - y * 0.2;
  }
  terrainCache = (await writeArrayBuffer(values, { width: size, height: size })) as ArrayBuffer;
  return terrainCache;
}

/** A solid AR5 tile of one palette colour. Cached: each is 1088² and four are
 * requested per derive, so re-encoding them dominated the suite's runtime. */
const ar5Cache = new Map<string, Buffer>();
function ar5Png(rgb: [number, number, number]): Buffer {
  const key = rgb.join(',');
  const hit = ar5Cache.get(key);
  if (hit) return hit;
  const size = RASTER.size; // the adapter asks for 2× a half-cell, i.e. the full edge
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

const lakeFeature = (over: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [ring(LAKE)] },
  properties: {
    vatnlnr: 5504,
    navn: 'Testvannet',
    hoyde: 148,
    areal_km2: 0.66,
    nedborfeltareal_km2: 12.5,
    objekttype: 'Innsjø',
    dybdekart: null,
    magformal_liste: null,
    ...over,
  },
});

/** A channel running north from the lake — uphill, so an inflow. */
const northChannel = {
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [10.421, 59.8665],
      [10.421, 59.8635],
      [10.421, 59.8605],
    ],
  },
  properties: { ltema: 3211, elveordenstrahler: 4, elvenavnhierarki: 'Nordelva', vatnlnr: 5504 },
};

/** A channel running south from the lake — downhill, so the outlet. */
const southChannel = {
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [10.421, 59.8565],
      [10.421, 59.8535],
      [10.421, 59.8505],
    ],
  },
  properties: { ltema: 3211, elveordenstrahler: 2, elvenavnhierarki: 'Sørelva', vatnlnr: 5504 },
};

interface StubOptions {
  lakes?: unknown[];
  streams?: unknown[];
  contours?: unknown[];
  landCover?: [number, number, number];
  failAr5?: boolean;
}

function upstreamStub(over: StubOptions = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('wcs.hoyde-dtm')) {
      return new Response(await slopingTerrain(), { status: 200 });
    }
    if (url.includes('Innsjodatabase2/MapServer/5')) {
      return geojson(over.lakes ?? [lakeFeature()]);
    }
    if (url.includes('Innsjodatabase2/MapServer/2')) return geojson(over.contours ?? []);
    if (url.includes('Elvenett1/MapServer/2')) {
      return geojson(over.streams ?? [northChannel, southChannel]);
    }
    if (url.includes('cgi-bin/ar5')) {
      if (over.failAr5) return new Response('nope', { status: 500 });
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
    // A private input cache per stub: these tests are about what the upstream
    // answered, and a shared cache would quietly serve the previous test's.
    cacheDir: path.join(cacheDir, String(contexts.length)),
    userAgent: 'atlas-test',
    record: () => {},
    log,
  };
  contexts.push(ctx);
  return ctx;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-lake-'));
  cacheDir = await mkdtemp(path.join(tmpdir(), 'atlas-lake-cache-'));
  contexts.length = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

describe('AR5 land cover', () => {
  it('splits the request so the layer is above its own scale cut-off', async () => {
    const ctx = context();
    await gatherInputs(RASTER, { landCover: true }, ctx);
    const calls = (ctx.fetchImpl as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('cgi-bin/ar5'));
    // 2×2 quadrants: one whole-cell request would land at 9.6 m/px, where the
    // layer answers 200 with a blank image and the country would read as
    // "no land cover anywhere".
    expect(calls).toHaveLength(4);
    for (const url of calls) {
      const params = new URL(url).searchParams;
      const [s, w, n, e] = params.get('BBOX')!.split(',').map(Number);
      const width = Number(params.get('WIDTH'));
      const groundM = (e! - w!) * 111_320 * Math.cos(((n! + s!) / 2) * (Math.PI / 180));
      expect(groundM / width).toBeLessThan(8.7);
    }
  });

  it('classifies the palette and refuses to guess at antialiased edges', async () => {
    // Myr — the colour that reads as Ferskvann if the palette is eyeballed.
    const myr = await gatherInputs(
      RASTER,
      { landCover: true },
      context({ landCover: [181, 236, 252] }),
    );
    expect(myr.landCover!.data[0]).toBe(60);

    // A colour on no class: the pixel is unknown, not the nearest guess.
    const noise = await gatherInputs(
      RASTER,
      { landCover: true },
      context({ landCover: [160, 200, 118] }),
    );
    expect(Number.isNaN(noise.landCover!.data[0]!)).toBe(true);
  });

  it('records a failure without failing the derive', async () => {
    const inputs = await gatherInputs(RASTER, { landCover: true }, context({ failAr5: true }));
    expect(inputs.landCover).toBeNull();
    const record = inputs.records.find((r) => r.id === 'landCover')!;
    expect(record.ok).toBe(false);
    expect(record.detail).toContain('500');
  });
});

describe('the lake adapter', () => {
  it('derives an unsurveyed lake from its shores, telling its inflow from its outlet', async () => {
    const result = await deriveCell(dataDir, lakeModel, 'orret', CELL, context());

    // The polygon was *filled*, not merely outlined, so there is water to score.
    expect(result.manifest.coverage).toBeGreaterThan(0);
    expect(result.tiles).toBe(21);
    // ...and only the shore band of a 0.66 km² lake, not the whole 9.8 km cell.
    expect(result.manifest.coverage).toBeLessThan(0.05);

    // Both mouths were found and told apart by which way the ground falls. If
    // the descent test had failed, one of these two terms would be absent.
    const keys = result.manifest.signals!.terms.map((t) => t.key);
    expect(keys).toContain('inlet');
    expect(keys).toContain('outlet');

    // No survey here, and the note says so as the normal case rather than as a
    // gap — blank ≠ broken.
    const notes = result.manifest.notes.join(' ');
    expect(notes).toMatch(/None of the 1 lakes here has an NVE depth/);
    expect(notes).toMatch(/607 of Norway's 267 194/);
  });

  it('scores a regulated lake down through its own term, not through a footnote', async () => {
    const ctx = context({ lakes: [lakeFeature({ objekttype: 'InnsjøRegulert' })] });
    const result = await deriveCell(dataDir, lakeModel, 'orret', CELL, ctx);

    const planes = gunzipSync(await readFile(signalsPath(dataDir, lakeModel, 'orret', CELL)));
    const index = result.manifest.signals!.planes.indexOf('regulated');
    expect(index).toBeGreaterThan(0);

    // The middle of the lake in signal-plane coordinates.
    const [west, south, east, north] = result.manifest.bounds;
    const pixels = result.manifest.signals!.pixels;
    const sx = Math.floor(((10.421 - west) / (east - west)) * pixels);
    const sy = Math.floor(((north - 59.8585) / (north - south)) * pixels);
    // A drawdown zone is dead water: a low *value*, never a negative weight.
    expect(readSignal(planes, index, sx, sy)).toBeLessThan(0.5);
  });

  it('warns about a drinking-water reservoir rather than scoring it silently', async () => {
    const ctx = context({
      lakes: [lakeFeature({ magformal_liste: 'Vannforsyning, Rekreasjon' })],
    });
    const result = await deriveCell(dataDir, lakeModel, 'orret', CELL, ctx);
    expect(result.manifest.notes.join(' ')).toMatch(/drinking-water reservoirs/);
  });

  it('offers only the species that have lake weights', () => {
    const values = lakeModel.targets.map((t) => t.value);
    expect(values).toEqual(['orret', 'roye', 'abbor', 'gjedde']);
    // Laks and sjøørret are river targets; offering them here would promise a
    // surface the model cannot build.
    expect(values).not.toContain('laks');
  });

  it('draws nothing at all where there is no mapped lake', async () => {
    const result = await deriveCell(dataDir, lakeModel, 'orret', CELL, context({ lakes: [] }));
    expect(result.manifest.coverage).toBe(0);
    expect(result.manifest.notes).toContain('No mapped lakes in this area.');
  });
});

describe('the explain endpoint', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  const start = async (over: StubOptions = {}) => {
    app = Fastify({ logger: false });
    await registerPotentialApi(app, {
      dataDir,
      cacheDir,
      fetchImpl: upstreamStub(over),
      userAgent: 'atlas-test',
      models: [lakeModel],
    });
    await app.ready();
  };

  it('names the signal behind a point, with its weight and a plain reason', async () => {
    await start();
    await deriveCell(dataDir, lakeModel, 'orret', CELL, context());

    // Just inside the northern shore, in front of the inflow.
    const res = await app.inject({
      method: 'GET',
      url: `/api/potential/lake-fishing/orret/explain?lat=${LAKE.north - 0.0004}&lng=10.421`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      score: number;
      bandLabel: string;
      factors: { key: string; weight: number; detail: string }[];
      summary: string;
      tier: string;
      inputs: { id: string; ok: boolean }[];
      standout: boolean;
    };
    expect(body.factors.length).toBeGreaterThan(0);
    expect(body.factors.map((f) => f.key)).toContain('inlet');
    // Weights are renormalised over the factors that actually applied here, so
    // the card's arithmetic matches the pixel's.
    const total = body.factors.reduce((sum, f) => sum + f.weight, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(body.summary).toMatch(/inflow mouth|shoreline|bank/);
    // The provenance of every input travels with the answer.
    expect(body.inputs.map((i) => i.id)).toContain('lakes');
    expect(typeof body.standout).toBe('boolean');
  });

  it('404s a point whose cell has not been derived, and says what it is doing', async () => {
    await start();
    const res = await app.inject({
      method: 'GET',
      url: '/api/potential/lake-fishing/orret/explain?lat=59.858&lng=10.421',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'cell not derived', state: { status: 'queued' } });
  });

  it('rejects a point that is not one', async () => {
    await start();
    const res = await app.inject({
      method: 'GET',
      url: '/api/potential/lake-fishing/orret/explain?lat=notalatitude&lng=10.4',
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports dry land as nothing derived rather than as a zero score', async () => {
    await start();
    await deriveCell(dataDir, lakeModel, 'orret', CELL, context());
    const res = await app.inject({
      method: 'GET',
      // Well outside the lake, but inside the derived cell.
      url: '/api/potential/lake-fishing/orret/explain?lat=59.845&lng=10.50',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      score: number;
      band: string | null;
      bandLabel: string | null;
      summary: string;
    };
    expect(Number.isFinite(body.score)).toBe(false);
    expect(body.summary).toMatch(/Nothing is derived for this point/);
    // Not "Quiet": an underived point is an absence, not the coolest verdict.
    expect(body.band).toBeNull();
    expect(body.bandLabel).toBeNull();
  });
});

describe('best spots on water the gate refused to rank', () => {
  /**
   * The stub lake is a plain rectangle with even banks, and the contrast gate
   * (D5) says so: its hot 5 % is not meaningfully clear of its median. The
   * shortlist is bound by that verdict — numbering eight points on water the
   * surface itself declined to rank is exactly the failure the gate exists to
   * prevent, and "nothing stands out here" has to survive all the way to the
   * list rather than being quietly overruled by a ranking that always finds a
   * top decile.
   */
  it('offers nothing, and says why', async () => {
    const app = Fastify({ logger: false });
    await registerPotentialApi(app, {
      dataDir,
      cacheDir,
      fetchImpl: upstreamStub(),
      userAgent: 'atlas-test',
      models: [lakeModel],
      valhallaUrl: 'http://router.test',
    });
    await app.ready();
    try {
      const derived = await deriveCell(dataDir, lakeModel, 'orret', CELL, context());
      expect(derived.manifest.contrast.standout).toBe(false);

      const bbox = [LAKE.west - 0.004, LAKE.south - 0.004, LAKE.east + 0.004, LAKE.north + 0.004];
      const res = await app.inject({
        url: `/api/potential/lake-fishing/orret/spots?bbox=${bbox.join(',')}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { spots: unknown[]; flat: number; pending: number; note: string };
      expect(body.spots).toHaveLength(0);
      expect(body.flat).toBe(1);
      expect(body.pending).toBe(0);
      expect(body.note).toMatch(/No standout water/);
    } finally {
      await app.close();
    }
  });
});
