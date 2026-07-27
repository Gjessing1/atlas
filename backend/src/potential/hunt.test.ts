import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { writeArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cellRaster, type Cell } from './cells.js';
import { deriveCell, readSignal, signalsPath, type CellManifest } from './derive.js';
import { huntModel, wildlifeAreaValue } from './hunt.js';
import type { PotentialContext } from './inputs.js';

/**
 * The hunt adapter against stubbed upstreams — the half of E5 that a synthetic
 * grid in `@atlas/potential` cannot reach, because everything tested here is
 * about turning rasters and polygons from four different agencies into the one
 * grid the engine reads: NIBIO's palettes, Naturbase's species names,
 * Miljødirektoratet's protection, and SSB's per-kommune harvest.
 *
 * The real services are exercised separately and by hand; this suite stays
 * offline so it runs in the quality gate.
 */

const CELL: Cell = { z: 11, x: 1083, y: 596 };
const RASTER = cellRaster(CELL);
const log = { warn: () => {} };

/** AR5 `Arealtype` colours, as measured against the live service. */
const AR5 = {
  forest: [158, 204, 115] as const,
  farmland: [255, 209, 110] as const,
  myr: [181, 236, 252] as const,
  built: [252, 219, 214] as const,
  water: [145, 231, 255] as const,
};

/** SR16 colours, likewise measured: a height class and a species class. */
const SR16_HEIGHT = {
  young: [199, 233, 192] as const, // 40–60 dm ⇒ 5 m
  mature: [0, 68, 27] as const, // 160–170 dm ⇒ 16.5 m
  none: [255, 255, 255] as const, // −9999: outside the forest model
};
const SR16_SPECIES = {
  spruce: [82, 176, 56] as const,
  pine: [205, 170, 101] as const,
  deciduous: [255, 220, 130] as const,
  none: [255, 255, 255] as const,
};

/** The cell's own extent, so a fixture can speak in lon/lat. */
const [WEST, SOUTH, EAST, NORTH] = RASTER.cellBounds;
/** North of this parallel the fixture is farmland, south of it forest. */
const FIELD_EDGE_LAT = SOUTH + (NORTH - SOUTH) * 0.7;

/** Terrain rising steadily northward, 200 m to 1000 m across the cell. */
let terrainCache: ArrayBuffer | null = null;
async function terrain(): Promise<ArrayBuffer> {
  if (terrainCache) return terrainCache;
  const size = RASTER.size;
  const values = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const elevation = 1000 - (y / size) * 800;
    for (let x = 0; x < size; x++) values[y * size + x] = elevation;
  }
  terrainCache = (await writeArrayBuffer(values, { width: size, height: size })) as ArrayBuffer;
  return terrainCache;
}

/**
 * Render one WMS answer by asking a callback what class sits at each pixel.
 *
 * The BBOX is read back out of the request, because AR5 arrives as four
 * quadrants (its scale gate) while SR16 arrives whole — so a fixture that
 * ignored the extent would paint the same quarter of the world four times.
 */
const pngCache = new Map<string, Buffer>();
/**
 * Which fixture painted a tile is part of its identity. Keying the cache on the
 * extent alone made every later test render the first one's ground, silently —
 * every request in this suite asks for the same four quadrants of the same cell.
 */
const fixtureIds = new WeakMap<object, number>();
let nextFixtureId = 0;
function renderWms(
  url: URL,
  classAt: (lng: number, lat: number) => readonly [number, number, number],
  key: string,
): Buffer {
  const bbox = (url.searchParams.get('BBOX') ?? '').split(',').map(Number);
  const width = Number(url.searchParams.get('WIDTH'));
  const height = Number(url.searchParams.get('HEIGHT'));
  let fixture = fixtureIds.get(classAt);
  if (fixture === undefined) {
    fixture = nextFixtureId++;
    fixtureIds.set(classAt, fixture);
  }
  const cacheKey = `${key}:${fixture}:${bbox.join(',')}:${width}`;
  const hit = pngCache.get(cacheKey);
  if (hit) return hit;
  // WMS 1.3.0 + EPSG:4326 is lat,lon ordered — the trap both NIBIO layers set.
  const [south, west, north, east] = bbox as [number, number, number, number];
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const lat = north - ((north - south) * (y + 0.5)) / height;
    for (let x = 0; x < width; x++) {
      const lng = west + ((east - west) * (x + 0.5)) / width;
      const [r, g, b] = classAt(lng, lat);
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  const buf = PNG.sync.write(png);
  pngCache.set(cacheKey, buf);
  return buf;
}

const geojson = (features: unknown[]) =>
  new Response(JSON.stringify({ type: 'FeatureCollection', features }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A rectangle in lon/lat, as a GeoJSON polygon feature. */
const box = (
  bounds: { west: number; east: number; south: number; north: number },
  properties: Record<string, unknown>,
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
  properties,
});

/** A surveyed elg winter-grazing area in the south-west corner of the cell. */
const ELG_AREA_WEST = WEST + (EAST - WEST) * 0.1;
const ELG_AREA_EAST = WEST + (EAST - WEST) * 0.3;
const elgArea = box(
  {
    west: ELG_AREA_WEST,
    east: ELG_AREA_EAST,
    south: SOUTH + (NORTH - SOUTH) * 0.1,
    north: SOUTH + (NORTH - SOUTH) * 0.3,
  },
  { norskNavn: 'Elg', funksjon: 1, verdi: 'A', aarstid: 4, omraadeNavn: 'Vinterbeite' },
);

const reserve = box(
  {
    west: WEST + (EAST - WEST) * 0.6,
    east: WEST + (EAST - WEST) * 0.9,
    south: SOUTH + (NORTH - SOUTH) * 0.6,
    north: SOUTH + (NORTH - SOUTH) * 0.9,
  },
  {
    navn: 'Storskogen naturreservat',
    verneform: 'Naturreservat',
    verneforskrift: 'https://lovdata.no/forskrift/2018-06-15-901',
  },
);

interface StubOptions {
  landCover?: (lng: number, lat: number) => readonly [number, number, number];
  treeHeight?: (lng: number, lat: number) => readonly [number, number, number];
  treeSpecies?: (lng: number, lat: number) => readonly [number, number, number];
  wildlife?: unknown[];
  vern?: unknown[];
  lakes?: unknown[];
  /** Upstreams that refuse to answer at all, by the fragment their URL carries. */
  dead?: string[];
  /** SSB answers this many felte elg, or 4xx when null. */
  felt?: number | null;
}

/** Farmland north of the edge, forest south of it. */
const defaultLandCover = (_lng: number, lat: number) =>
  lat > FIELD_EDGE_LAT ? AR5.farmland : AR5.forest;
/**
 * Regrowth in the southern third, timber above it — so a cell carries both
 * stand classes and the exclusive cover terms are exercised for real.
 */
const STAND_EDGE_LAT = SOUTH + (NORTH - SOUTH) * 0.35;
/** Hoisted so repeated renders share one cached tile — see `fixtureIds`. */
const defaultHeight = (_lng: number, lat: number) =>
  lat < STAND_EDGE_LAT ? SR16_HEIGHT.young : SR16_HEIGHT.mature;
const defaultSpecies = () => SR16_SPECIES.spruce;

function upstreamStub(over: StubOptions = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const raw = String(input instanceof Request ? input.url : input);
    for (const fragment of over.dead ?? []) {
      // What a broken TLS chain looks like from in here: not a 500 body, but a
      // fetch that never completes. Miljødirektoratet really has done this.
      if (raw.includes(fragment)) throw new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    }
    const url = new URL(raw);
    if (raw.includes('wcs.hoyde-dtm')) return new Response(await terrain(), { status: 200 });
    if (raw.includes('Innsjodatabase2/MapServer/5')) return geojson(over.lakes ?? []);
    if (raw.includes('Elvenett1/MapServer/2')) return geojson([]);
    if (raw.includes('artfunksjon/MapServer/0')) return geojson(over.wildlife ?? [elgArea]);
    if (raw.includes('vern/MapServer/0')) return geojson(over.vern ?? [reserve]);
    if (raw.includes('kommuneinfo')) {
      return Response.json({ kommunenummer: '3203', kommunenavn: 'Asker' });
    }
    if (raw.includes('data.ssb.no')) {
      const felt = over.felt === undefined ? 63 : over.felt;
      if (felt === null) return new Response('unknown region', { status: 400 });
      // Hjort is asked for too; one figure answers both in this fixture.
      return Response.json({
        value: [felt],
        dimension: { Tid: { category: { index: { '2025-2026': 0 } } } },
      });
    }
    const png = (
      fn: (lng: number, lat: number) => readonly [number, number, number],
      key: string,
    ) =>
      new Response(renderWms(url, fn, key), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    if (raw.includes('cgi-bin/ar5')) return png(over.landCover ?? defaultLandCover, 'ar5');
    if (raw.includes('cgi-bin/sr16')) {
      const layer = url.searchParams.get('LAYERS');
      if (layer === 'SRRHOYDEO') return png(over.treeHeight ?? defaultHeight, 'height');
      return png(over.treeSpecies ?? defaultSpecies, 'species');
    }
    if (init?.method === 'POST') throw new Error(`unstubbed POST: ${raw}`);
    throw new Error(`unstubbed upstream: ${raw}`);
  });
}

let dataDir: string;
let cacheDir: string;
let contexts = 0;

function context(over: StubOptions = {}): PotentialContext {
  return {
    fetchImpl: upstreamStub(over),
    cacheDir: path.join(cacheDir, String(contexts++)),
    userAgent: 'atlas-test',
    record: () => {},
    log,
  };
}

/** One signal sample of a derived cell, by geographic position. */
async function signalAt(
  manifest: CellManifest,
  target: string,
  key: string,
  at: { lat: number; lng: number },
): Promise<number> {
  const planes = gunzipSync(await readFile(signalsPath(dataDir, huntModel, target, CELL)));
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
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-hunt-'));
  cacheDir = await mkdtemp(path.join(tmpdir(), 'atlas-hunt-cache-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

describe('the hunt adapter', () => {
  it('derives dry ground and names what it read', async () => {
    const result = await deriveCell(dataDir, huntModel, 'radyr', CELL, context());

    expect(result.tiles).toBe(21);
    // Unlike a shore band or a river corridor, hunt ground is most of the cell.
    expect(result.manifest.coverage).toBeGreaterThan(0.9);
    expect(result.manifest.vocabulary).toBe('hunt');

    const keys = result.manifest.signals!.terms.map((t) => t.key);
    expect(keys).toContain('edge-farmland');
    // A roe deer weights young cover and never mature timber, so the surface
    // carries the one and not the other — the weights are the model.
    expect(keys).toContain('cover-young');
    expect(keys).not.toContain('cover-mature');
    expect(keys).toContain('quiet');

    // The field edge is the roe deer's lead, and it must be where the fixture
    // put it rather than smeared over the whole cell.
    const onEdge = await signalAt(result.manifest, 'radyr', 'edge-farmland', {
      lat: FIELD_EDGE_LAT,
      lng: (WEST + EAST) / 2,
    });
    const farAway = await signalAt(result.manifest, 'radyr', 'edge-farmland', {
      lat: SOUTH + (NORTH - SOUTH) * 0.05,
      lng: (WEST + EAST) / 2,
    });
    expect(onEdge).toBeGreaterThan(0.4);
    expect(farAway).toBeLessThan(0.1);
  });

  it('leaves water and built-up ground unscored', async () => {
    const half = (WEST + EAST) / 2;
    const result = await deriveCell(
      dataDir,
      huntModel,
      'radyr',
      CELL,
      context({
        landCover: (lng, lat) =>
          lng < half ? AR5.water : lat > FIELD_EDGE_LAT ? AR5.built : AR5.forest,
      }),
    );
    // Half the cell is lake and a slice of the rest is a village: neither is
    // huntable, and neither may be drawn as merely poor ground.
    expect(result.manifest.coverage).toBeLessThan(0.55);
    expect(result.manifest.coverage).toBeGreaterThan(0.2);
  });

  it('joins a surveyed area to its own quarry and nobody else', async () => {
    const inside = {
      lat: SOUTH + (NORTH - SOUTH) * 0.2,
      lng: (ELG_AREA_WEST + ELG_AREA_EAST) / 2,
    };
    const elg = await deriveCell(dataDir, huntModel, 'elg', CELL, context());
    expect(await signalAt(elg.manifest, 'elg', 'artfunksjon', inside)).toBeGreaterThan(0.8);
    expect(elg.manifest.notes.join(' ')).toContain('surveyed elg area');

    // The same Naturbase pull, a different quarry: an elg beiteområde says
    // nothing whatever about capercaillie, so the term must be absent entirely
    // rather than present and zero.
    const storfugl = await deriveCell(dataDir, huntModel, 'storfugl', CELL, context());
    expect(storfugl.manifest.signals!.planes).not.toContain('artfunksjon');
  });

  it('grades a survey by its value and its purpose, never below the middle', () => {
    const lek = wildlifeAreaValue({
      species: 'Storfugl',
      functionCode: 7,
      value: 'A',
      seasonCode: null,
      name: null,
      rings: [],
    });
    const trekkvei = wildlifeAreaValue({
      species: 'Elg',
      functionCode: 2,
      value: 'D',
      seasonCode: null,
      name: null,
      rings: [],
    });
    expect(lek).toBeCloseTo(1, 5);
    // Being surveyed must never score worse than not being surveyed.
    expect(trekkvei).toBeGreaterThanOrEqual(0.6);
    expect(trekkvei).toBeLessThan(lek);
  });
});

describe('what the hunt surface says in words', () => {
  it('names the protected area and links its own forskrift', async () => {
    const result = await deriveCell(dataDir, huntModel, 'elg', CELL, context());
    const notes = result.manifest.notes.join('\n');
    expect(notes).toContain('Storskogen naturreservat');
    expect(notes).toContain('lovdata.no/forskrift/2018-06-15-901');
    expect(notes).toContain('verneforskrift');
  });

  it('never reports an unanswered protection layer as unprotected ground', async () => {
    const result = await deriveCell(
      dataDir,
      huntModel,
      'elg',
      CELL,
      context({ dead: ['vern/MapServer'] }),
    );
    const notes = result.manifest.notes.join('\n');
    expect(notes).toContain('could not be checked');
    expect(notes).not.toContain('naturreservat');
  });

  it('links the seasons rather than restating them, with the kommune and an as-of date', async () => {
    const result = await deriveCell(dataDir, huntModel, 'elg', CELL, context());
    const notes = result.manifest.notes.join('\n');
    expect(notes).toContain('lovdata.no/dokument/SF/forskrift/2022-01-21-128');
    expect(notes).toContain('Asker');
    expect(notes).toMatch(/checked \d{4}-\d{2}-\d{2}/);
    // The dates themselves vary by kommune and expire in 2028 — shipping a pair
    // would be wrong for a large part of the country on the day it landed.
    expect(notes).not.toMatch(/25 Aug|23 Dec|\d{1,2}\.\s?\w+ – \d{1,2}\./);
    expect(notes).toContain('never permission');
  });

  it('takes its tier from the kommune harvest, and has none when SSB cannot answer', async () => {
    const withPrior = await deriveCell(dataDir, huntModel, 'elg', CELL, context());
    expect(withPrior.manifest.tier).not.toBeNull();
    expect(withPrior.manifest.notes.join('\n')).toContain('felled 63 elg');

    const noPrior = await deriveCell(dataDir, huntModel, 'elg', CELL, context({ felt: null }));
    expect(noPrior.manifest.tier).toBeNull();
  });
});

describe('what the hunt surface refuses to do', () => {
  it('fails the cell when the land cover it rests on did not answer', async () => {
    // AR5 decides which ground is huntable, where the edges are and where the
    // forest stops. A confident surface built without it would be a fact about
    // the network dressed as a fact about the hillside.
    await expect(
      deriveCell(dataDir, huntModel, 'radyr', CELL, context({ dead: ['cgi-bin/ar5'] })),
    ).rejects.toThrow(/land cover/);
  });

  it('scores nothing for a tree-line quarry in forest with no tree line', async () => {
    const result = await deriveCell(
      dataDir,
      huntModel,
      'lirype',
      CELL,
      context({ landCover: () => AR5.forest }),
    );
    expect(result.manifest.coverage).toBe(0);
    expect(result.manifest.notes.join(' ')).toContain('tree line');
  });

  it('finds the local tree line where the forest gives out, and scores the band', async () => {
    // Terrain runs 1000 m in the north to 200 m in the south; forest below the
    // 600 m contour only, which sits at 50 % of the cell's height.
    const result = await deriveCell(
      dataDir,
      huntModel,
      'lirype',
      CELL,
      context({
        landCover: (_lng, lat) => (lat < (SOUTH + NORTH) / 2 ? AR5.forest : AR5.myr),
        treeHeight: (_lng, lat) =>
          lat < (SOUTH + NORTH) / 2 ? SR16_HEIGHT.young : SR16_HEIGHT.none,
      }),
    );
    const notes = result.manifest.notes.join(' ');
    const line = Number(/Local tree line ≈ (\d+) m/.exec(notes)?.[1]);
    // The forest's own top, not a national figure: the 600 m contour, give or
    // take the padding ring the derive raster carries beyond the cell.
    expect(line).toBeGreaterThan(540);
    expect(line).toBeLessThan(640);
    expect(result.manifest.signals!.planes).toContain('treeline');
    expect(result.manifest.coverage).toBeGreaterThan(0);
  });
});

describe('the SR16 rasters', () => {
  it('reads mature pine where the palette says pine, and nothing where it says nodata', async () => {
    const half = (WEST + EAST) / 2;
    const result = await deriveCell(
      dataDir,
      huntModel,
      'storfugl',
      CELL,
      context({
        landCover: () => AR5.forest,
        treeSpecies: (lng) => (lng > half ? SR16_SPECIES.pine : SR16_SPECIES.spruce),
      }),
    );
    const lat = (SOUTH + NORTH) / 2;
    const onPine = await signalAt(result.manifest, 'storfugl', 'pine-mature', {
      lat,
      lng: WEST + (EAST - WEST) * 0.9,
    });
    const onSpruce = await signalAt(result.manifest, 'storfugl', 'pine-mature', {
      lat,
      lng: WEST + (EAST - WEST) * 0.1,
    });
    expect(onPine).toBeGreaterThan(0.8);
    expect(onSpruce).toBeLessThan(0.1);
  });

  it('treats ground outside the forest model as unknown, not as treeless', async () => {
    const result = await deriveCell(
      dataDir,
      huntModel,
      'radyr',
      CELL,
      context({ treeHeight: () => SR16_HEIGHT.none, treeSpecies: () => SR16_SPECIES.none }),
    );
    // No stand height anywhere: the cover terms drop out entirely and the
    // surface is built from the signals that did arrive.
    expect(result.manifest.signals!.planes).not.toContain('cover-young');
    expect(result.manifest.notes.join(' ')).toContain('No stand-height model');
    expect(result.manifest.coverage).toBeGreaterThan(0.9);
  });
});
