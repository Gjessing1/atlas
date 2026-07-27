import { createGrid, gridStats, type Grid } from '@atlas/potential';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { writeArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CELL_PIXELS, cellRaster, type Cell } from './cells.js';
import { cropToCell, deriveCell, manifestPath, readManifest, tilePath } from './derive.js';
import { gatherInputs, type PotentialContext } from './inputs.js';
import { registerPotentialApi } from './index.js';
import { burnPaths, type DeriveModel, type ModelResult } from './models.js';

const CELL: Cell = { z: 11, x: 1083, y: 596 };
const RASTER = cellRaster(CELL);

const log = { warn: () => {} };

// ---- upstream stubs -------------------------------------------------------

/**
 * A float32 GeoTIFF of the padded raster size, with a ridge down the middle.
 * Encoded once per size: a 1088² coverage is 4.7 MB and every derive asks for one.
 */
const tiffCache = new Map<number, ArrayBuffer>();
async function terrainTiff(size = RASTER.size): Promise<ArrayBuffer> {
  const hit = tiffCache.get(size);
  if (hit) return hit;
  const values = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      values[y * size + x] = 100 + 200 * Math.exp(-((x - size / 2) ** 2) / (2 * 40 ** 2));
    }
  }
  const buf = (await writeArrayBuffer(values, { width: size, height: size })) as ArrayBuffer;
  tiffCache.set(size, buf);
  return buf;
}

const geojson = (features: unknown[], more = false) =>
  new Response(
    JSON.stringify({ type: 'FeatureCollection', features, exceededTransferLimit: more }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );

const lakeFeature = (over: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [10.418, 59.856],
        [10.424, 59.856],
        [10.424, 59.861],
        [10.418, 59.861],
        [10.418, 59.856],
      ],
    ],
  },
  properties: {
    vatnlnr: 5504,
    navn: 'Semsvannet',
    hoyde: 148,
    areal_km2: 0.66,
    nedborfeltareal_km2: 12.5,
    objekttype: 'Innsjø',
    dybdekart: 'J',
    magformal_liste: null,
    ...over,
  },
});

const streamFeature = (ltema: number, strahler: number) => ({
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [10.42, 59.862],
      [10.421, 59.861],
      [10.4215, 59.8605],
    ],
  },
  properties: { ltema, elveordenstrahler: strahler, elvenavnhierarki: 'Askerelva', vatnlnr: 0 },
});

/** Answers every upstream the adapters call, by URL. */
function upstreamStub(over: { terrainSize?: number } = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('wcs.hoyde-dtm')) {
      const buf = await terrainTiff(over.terrainSize);
      return new Response(buf, { status: 200, headers: { 'content-type': 'image/tiff' } });
    }
    if (url.includes('Innsjodatabase2/MapServer/5')) return geojson([lakeFeature()]);
    if (url.includes('Innsjodatabase2/MapServer/2')) return geojson([]);
    if (url.includes('Elvenett1/MapServer/2')) {
      return geojson([
        streamFeature(3211, 3), // real channel
        streamFeature(3103, 1), // lake through-flow centreline
        streamFeature(3299, 1), // fictitious connector
      ]);
    }
    throw new Error(`unstubbed upstream: ${url}`);
  });
}

let dataDir: string;
let cacheDir: string;
let ctx: PotentialContext;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-potential-'));
  cacheDir = await mkdtemp(path.join(tmpdir(), 'atlas-potential-cache-'));
  ctx = {
    fetchImpl: upstreamStub(),
    cacheDir,
    userAgent: 'atlas-test',
    record: () => {},
    log,
  };
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

// ---- test models ----------------------------------------------------------

/**
 * A lake with one good shore: nodata over dry land, an even 0.1 over the water,
 * and a hotspot covering ~10 % of it.
 *
 * Shaped like a real model's output on purpose. The gate measures the spread of
 * the **scored** cells, so a first attempt that flooded the whole 9.8 km cell
 * with a 0.3 % hotspot was correctly reported as "nothing special here" — the
 * hot area has to be a real fraction of the water, not of the county.
 */
const LAKE_FROM = 450;
const LAKE_TO = 650;
const HOT_FROM = 500;
const HOT_TO = 564;

const peakModel = (over: Partial<DeriveModel> = {}): DeriveModel => ({
  layer: 'peak',
  label: 'Peak',
  rev: 1,
  targets: [
    { value: 'first', label: 'First' },
    { value: 'second', label: 'Second' },
  ],
  inputs: { terrain: true, lakes: true, streams: true },
  vocabulary: 'fishing',
  run: (inputs): ModelResult => {
    const g = createGrid(
      inputs.raster.size,
      inputs.raster.size,
      inputs.raster.cellSizeM,
      Number.NaN,
    );
    for (let y = LAKE_FROM; y < LAKE_TO; y++) {
      for (let x = LAKE_FROM; x < LAKE_TO; x++) g.data[y * g.width + x] = 0.1;
    }
    for (let y = HOT_FROM; y < HOT_TO; y++) {
      for (let x = HOT_FROM; x < HOT_TO; x++) g.data[y * g.width + x] = 0.9;
    }
    return { score: g, notes: ['synthetic peak'], absolute: 0.6 };
  },
  ...over,
});

/** The same lake, evenly scored: the gate must refuse to invent hotspots (D5). */
const flatModel: DeriveModel = {
  ...peakModel(),
  layer: 'flat',
  run: (inputs) => {
    const g = createGrid(
      inputs.raster.size,
      inputs.raster.size,
      inputs.raster.cellSizeM,
      Number.NaN,
    );
    for (let y = LAKE_FROM; y < LAKE_TO; y++) {
      for (let x = LAKE_FROM; x < LAKE_TO; x++) g.data[y * g.width + x] = 0.42;
    }
    return { score: g, notes: [] };
  },
};

// ---- inputs ---------------------------------------------------------------

describe('input adapters', () => {
  it('parses the lake register, including the survey flag', async () => {
    const inputs = await gatherInputs(RASTER, { lakes: true }, ctx);
    expect(inputs.lakes).toHaveLength(1);
    const lake = inputs.lakes[0]!;
    expect(lake).toMatchObject({
      vatnlnr: 5504,
      name: 'Semsvannet',
      elevationM: 148,
      surveyed: true,
    });
    expect(lake.rings[0]!.length).toBe(5);
  });

  it('treats an absent survey flag as unsurveyed — the normal case', async () => {
    ctx.fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(geojson([lakeFeature({ dybdekart: null })])));
    const inputs = await gatherInputs(RASTER, { lakes: true }, ctx);
    expect(inputs.lakes[0]!.surveyed).toBe(false);
  });

  it('keeps the ltema class on every stream so callers can exclude fake water', async () => {
    const inputs = await gatherInputs(RASTER, { streams: true }, ctx);
    expect(inputs.streams.map((s) => s.ltema)).toEqual([3211, 3103, 3299]);
    const record = inputs.records.find((r) => r.id === 'streams')!;
    expect(record.detail).toBe('3 segments, 1 real channel');
  });

  /** Sending lon/lat to a service that reads its own grid matches nothing. */
  it('asks NVE in its own projection, with the SR stated', async () => {
    const fetchImpl = upstreamStub();
    ctx.fetchImpl = fetchImpl;
    await gatherInputs(RASTER, { lakes: true }, ctx);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.get('inSR')).toBe('25833');
    expect(url.searchParams.get('outSR')).toBe('4326');
    const envelope = JSON.parse(url.searchParams.get('geometry')!) as {
      xmin: number;
      spatialReference: { wkid: number };
    };
    expect(envelope.spatialReference.wkid).toBe(25833);
    // UTM33 eastings around Asker are ~240 000 — not a longitude.
    expect(envelope.xmin).toBeGreaterThan(100_000);
  });

  it('decodes the elevation coverage onto the padded raster', async () => {
    const inputs = await gatherInputs(RASTER, { terrain: true }, ctx);
    expect(inputs.terrain?.width).toBe(RASTER.size);
    const stats = gridStats(inputs.terrain!);
    expect(stats.max).toBeGreaterThan(290);
    expect(stats.min).toBeCloseTo(100, 0);
  });

  /**
   * A missing input must read as "unknown", never as bad ground — so the derive
   * carries on and the manifest records what failed and why.
   */
  it('records a failed input instead of failing the whole gather', async () => {
    ctx.fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 503 }));
    const inputs = await gatherInputs(RASTER, { terrain: true, lakes: true }, ctx);
    expect(inputs.terrain).toBeNull();
    expect(inputs.lakes).toEqual([]);
    expect(inputs.records.every((r) => !r.ok)).toBe(true);
    expect(inputs.records[0]!.detail).toContain('503');
  });

  it('rejects a coverage that is not the size it asked for', async () => {
    ctx.fetchImpl = upstreamStub({ terrainSize: 64 });
    const inputs = await gatherInputs(RASTER, { terrain: true }, ctx);
    expect(inputs.terrain).toBeNull();
    expect(inputs.records[0]!.detail).toContain('64×64');
  });

  it('serves a second gather from disk without touching the network', async () => {
    const fetchImpl = upstreamStub();
    ctx.fetchImpl = fetchImpl;
    await gatherInputs(RASTER, { terrain: true, lakes: true, streams: true }, ctx);
    const firstCalls = fetchImpl.mock.calls.length;
    const again = await gatherInputs(RASTER, { terrain: true, lakes: true, streams: true }, ctx);
    expect(fetchImpl.mock.calls.length).toBe(firstCalls);
    expect(again.records.every((r) => r.cached)).toBe(true);
    expect(again.lakes[0]!.name).toBe('Semsvannet');
    expect(gridStats(again.terrain!).max).toBeGreaterThan(290);
  });
});

describe('burnPaths', () => {
  it('puts a stream on the raster where the coordinates say', () => {
    const mask = {
      width: RASTER.size,
      height: RASTER.size,
      cellSizeM: RASTER.cellSizeM,
      data: new Uint8Array(RASTER.size * RASTER.size),
    };
    const burned = burnPaths(
      RASTER,
      [
        [
          [10.42, 59.862],
          [10.4215, 59.8605],
        ],
      ],
      mask,
    );
    expect(burned).toBe(1);
    expect(mask.data.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});

// ---- derive ---------------------------------------------------------------

describe('deriveCell', () => {
  it('emits the whole z11–z13 pyramid and a manifest naming its inputs', async () => {
    const model = peakModel();
    const { manifest, tiles } = await deriveCell(dataDir, model, 'first', CELL, ctx);
    // 1 + 4 + 16 tiles: z11 whole, z12 quadrants, z13 pixel-for-pixel.
    expect(tiles).toBe(21);
    expect(manifest.cell).toBe('11/1083/596');
    expect(manifest.target).toBe('first');
    expect(manifest.inputs.map((r) => r.id).sort()).toEqual(['lakes', 'streams', 'terrain']);
    expect(manifest.inputs.every((r) => r.ok)).toBe(true);
    expect(manifest.cellSizeM).toBeGreaterThan(9.4);
    // The absolute prior the model supplied, as a tier rather than a number.
    expect(manifest.tier).toBe('Good');
    expect(manifest.notes).toContain('synthetic peak');
    expect(await readManifest(dataDir, model, 'first', CELL)).toEqual(manifest);
  });

  it('writes real PNG tiles at the addresses the client will ask for', async () => {
    const model = peakModel();
    await deriveCell(dataDir, model, 'first', CELL, ctx);
    for (const [z, x, y] of [
      [11, CELL.x, CELL.y],
      [12, CELL.x * 2, CELL.y * 2],
      [13, CELL.x * 4 + 1, CELL.y * 4 + 1],
    ] as const) {
      const png = PNG.sync.read(await readFile(tilePath(dataDir, model, 'first', z, x, y)));
      expect([png.width, png.height]).toEqual([256, 256]);
    }
  });

  /**
   * D5: a surface must be allowed to say "nothing special here". Percentile
   * ranking always manufactures a top decile, so the gate runs on the raw score
   * — a featureless pond must not come back with hotspots.
   */
  it('reports no standout structure on a featureless surface', async () => {
    const { manifest } = await deriveCell(dataDir, flatModel, 'first', CELL, ctx);
    expect(manifest.contrast.standout).toBe(false);
    expect(manifest.contrast.reason).toContain('No standout structure');
    // No prior was supplied, so there is honestly no tier.
    expect(manifest.tier).toBeNull();
  });

  it('finds the structure in a surface that has some', async () => {
    const { manifest } = await deriveCell(dataDir, peakModel(), 'first', CELL, ctx);
    expect(manifest.contrast.standout).toBe(true);
    expect(manifest.contrast.spread).toBeGreaterThan(0.08);
    // Only the water is scored, so coverage is a small slice of the cell — and
    // the un-scored land must stay nodata rather than be ranked as "quiet".
    expect(manifest.coverage).toBeLessThan(0.05);
    expect(manifest.coverage).toBeGreaterThan(0);
  });

  it('keeps separate artefacts per target', async () => {
    const model = peakModel();
    await deriveCell(dataDir, model, 'first', CELL, ctx);
    await deriveCell(dataDir, model, 'second', CELL, ctx);
    expect(await readManifest(dataDir, model, 'second', CELL)).not.toBeNull();
    expect(manifestPath(dataDir, model, 'first', CELL)).not.toBe(
      manifestPath(dataDir, model, 'second', CELL),
    );
  });

  it('falls back to the default target rather than trusting the request', async () => {
    const { manifest } = await deriveCell(dataDir, peakModel(), '../../etc/passwd', CELL, ctx);
    expect(manifest.target).toBe('first');
  });

  it('refuses a model that returns the wrong raster size', async () => {
    const broken = peakModel({
      run: (inputs) => ({ score: createGrid(64, 64, inputs.raster.cellSizeM), notes: [] }),
    });
    await expect(deriveCell(dataDir, broken, 'first', CELL, ctx)).rejects.toThrow(/expected/);
  });
});

describe('cropToCell', () => {
  it('drops the margin the focal operations needed', () => {
    const padded = createGrid(RASTER.size, RASTER.size, RASTER.cellSizeM, 0);
    // Mark the cell's own top-left pixel so the crop can be located exactly.
    padded.data[RASTER.pad * RASTER.size + RASTER.pad] = 7;
    const cropped: Grid = cropToCell(padded, RASTER.pad);
    expect(cropped.width).toBe(CELL_PIXELS);
    expect(cropped.data[0]).toBe(7);
  });
});

// ---- routes ---------------------------------------------------------------

describe('potential routes', () => {
  let app: FastifyInstance;
  const model = peakModel();

  beforeEach(async () => {
    app = Fastify();
    await registerPotentialApi(app, {
      dataDir,
      cacheDir,
      fetchImpl: upstreamStub(),
      models: [model, flatModel],
      concurrency: 1,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('advertises the models and their targets', async () => {
    const body = (await app.inject({ url: '/api/potential/layers' })).json() as {
      cellZoom: number;
      layers: { layer: string; targets: { value: string }[] }[];
    };
    expect(body.cellZoom).toBe(11);
    expect(body.layers.map((l) => l.layer)).toEqual(['peak', 'flat']);
    expect(body.layers[0]!.targets.map((t) => t.value)).toEqual(['first', 'second']);
  });

  it('queues the cells under a viewport and reports each one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/potential/prepare',
      payload: { layer: 'peak', target: 'first', bbox: [10.4, 59.82, 10.5, 59.87] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cells: { cell: string; status: string }[]; working: number };
    expect(body.cells.length).toBeGreaterThan(0);
    expect(body.cells.every((c) => c.status !== 'ready')).toBe(true);
    expect(body.working).toBe(body.cells.length);
  });

  it('says a viewport outside Norway has nothing to derive, without erroring', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/potential/prepare',
      payload: { layer: 'peak', bbox: [2.0, 48.0, 2.4, 48.4] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cells: [], outsideCoverage: true });
  });

  it('rejects an unknown layer and a malformed bbox', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/potential/prepare',
          payload: { layer: 'nope', bbox: [10, 59, 11, 60] },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/potential/prepare',
          payload: { layer: 'peak', bbox: [11, 60, 10, 59] },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('draws nothing, uncached, for a cell that has not been derived', async () => {
    const res = await app.inject({ url: `/api/potential/peak/first/11/${CELL.x}/${CELL.y}.png` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // no-store, so the client is not stuck with a blank tile once the cell lands.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  /**
   * The cache header is the one thing here learned the hard way: a re-derive
   * rewrites the same URL, and a long max-age would keep serving the old surface
   * until it lapsed — with no reload able to help, since tiles load lazily.
   */
  it('serves a derived tile revalidating, with a content ETag', async () => {
    await deriveCell(dataDir, model, 'first', CELL, ctx);
    const res = await app.inject({
      url: `/api/potential/peak/first/13/${CELL.x * 4}/${CELL.y * 4}.png`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    const etag = res.headers['etag'] as string;
    expect(etag).toMatch(/^"[0-9a-f]{16}-13-/);

    const revalidated = await app.inject({
      url: `/api/potential/peak/first/13/${CELL.x * 4}/${CELL.y * 4}.png`,
      headers: { 'if-none-match': etag },
    });
    expect(revalidated.statusCode).toBe(304);
  });

  it('gives each tile of a cell its own ETag', async () => {
    await deriveCell(dataDir, model, 'first', CELL, ctx);
    const a = await app.inject({
      url: `/api/potential/peak/first/12/${CELL.x * 2}/${CELL.y * 2}.png`,
    });
    const b = await app.inject({
      url: `/api/potential/peak/first/12/${CELL.x * 2 + 1}/${CELL.y * 2}.png`,
    });
    expect(a.headers['etag']).not.toBe(b.headers['etag']);
  });

  it('refuses tile coordinates outside the served pyramid', async () => {
    expect(
      (await app.inject({ url: `/api/potential/peak/first/14/${CELL.x * 8}/${CELL.y * 8}.png` }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: `/api/potential/peak/first/9/${CELL.x}/${CELL.y}.png` })).statusCode,
    ).toBe(400);
  });

  it('answers a cell manifest with its provenance, and 404s an underived one', async () => {
    const url = `/api/potential/peak/first/cell/${CELL.x}/${CELL.y}.json`;
    const missing = await app.inject({ url });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'cell not derived' });

    await deriveCell(dataDir, model, 'first', CELL, ctx);
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(200);
    const manifest = res.json() as { inputs: { source: string }[]; contrast: { reason: string } };
    expect(manifest.inputs.map((i) => i.source)).toContain('NVE Elvenett1 layer 2');
    expect(manifest.contrast.reason).toBeTruthy();
  });

  it('derives a queued cell end to end through the queue', async () => {
    const queue = await registerPotentialApi(Fastify(), {
      dataDir,
      cacheDir,
      fetchImpl: upstreamStub(),
      models: [model],
      concurrency: 1,
    });
    const job = queue.request('peak', 'first', CELL)!;
    expect(job.status).toBe('queued');
    await vi.waitFor(
      async () => {
        expect(await readManifest(dataDir, model, 'first', CELL)).not.toBeNull();
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(queue.get('peak', 'first', CELL)?.status).toBe('done');
    // The pyramid is on disk under the layer/target/revision path.
    const zooms = await readdir(
      path.dirname(path.dirname(tilePath(dataDir, model, 'first', 11, CELL.x, CELL.y))),
    );
    expect(zooms).toContain(String(CELL.x));
  });
});
