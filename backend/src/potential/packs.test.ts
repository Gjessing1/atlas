import type { RegionPackManifest } from '@atlas/core';
import { createGrid } from '@atlas/potential';
import { unzipSync } from 'fflate';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Cell } from './cells.js';
import { manifestPath, tilePath } from './derive.js';
import { registerPotentialApi } from './index.js';
import type { DeriveModel } from './models.js';
import { cellTiles, MAX_PACK_CELLS, PotentialPackBuilder, PACK_TTL_MS } from './packs.js';

/**
 * E7 — "keep this area offline".
 *
 * What is asserted here is the set of rules the obvious implementation gets
 * wrong: a pack must never *derive* anything, must never silently ship a
 * truncated area, must be identified by what is in it so re-taking the same
 * ground replaces rather than duplicates, and must keep the tile bytes intact
 * through the archive — a surface that arrives subtly re-encoded is worse than
 * one that is absent.
 */

const model = (over: Partial<DeriveModel> = {}): DeriveModel => ({
  layer: 'hunt',
  label: 'Hunt potential',
  targets: [
    { value: 'elg', label: 'Elg' },
    { value: 'radyr', label: 'Rådyr' },
  ],
  catalog: true,
  rev: 1,
  inputs: {},
  vocabulary: 'hunt',
  run: (inputs) => ({ score: createGrid(4, 4, inputs.raster.cellSizeM), notes: [] }),
  ...over,
});

/** Two adjacent cells in Nordmarka. */
const CELLS: Cell[] = [
  { z: 11, x: 1084, y: 594 },
  { z: 11, x: 1085, y: 594 },
];

/**
 * A bbox strictly inside cell 11/1084/594, which spans 10.547–10.723 ×
 * 59.977–60.065 — the "framed area" a user would send.
 */
const ONE_CELL_BBOX = { sw: { lat: 60.0, lng: 10.6 }, ne: { lat: 60.03, lng: 10.65 } };

let dataDir: string;
let cacheDir: string;

/** Pretend a cell has been derived: a manifest, and a tile per pyramid slot. */
async function fakeCell(cell: Cell, target: string, tiles = true): Promise<void> {
  const file = manifestPath(dataDir, model(), target, cell);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ cell: `${cell.z}/${cell.x}/${cell.y}`, target }));
  if (!tiles) return;
  for (const tile of cellTiles(cell)) {
    const png = tilePath(dataDir, model(), target, tile.z, tile.x, tile.y);
    await mkdir(path.dirname(png), { recursive: true });
    // Distinct per tile, so a mixed-up archive cannot pass.
    await writeFile(png, Buffer.from(`png:${tile.z}/${tile.x}/${tile.y}`));
  }
}

/** The cells a bbox covers, as the builder computes them. */
const bboxFor = (cells: Cell[]) => {
  // Cell (11,x,y) spans a known lon/lat box; build one that covers all of them
  // by taking a point inside each. 360/2^11 degrees of longitude per cell.
  const span = 360 / 2 ** 11;
  const lngs = cells.map((c) => -180 + (c.x + 0.5) * span);
  return {
    sw: { lat: 60.02, lng: Math.min(...lngs) },
    ne: { lat: 60.03, lng: Math.max(...lngs) },
  };
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-packs-'));
  cacheDir = await mkdtemp(path.join(tmpdir(), 'atlas-packs-cache-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

describe('PotentialPackBuilder', () => {
  const builder = (now?: () => number) =>
    new PotentialPackBuilder({ dataDir, models: [model()], now });

  const request = (over: Record<string, unknown> = {}) => ({
    name: 'Elgvaldet',
    bbox: ONE_CELL_BBOX,
    surfaces: [{ layer: 'hunt', target: 'elg' }],
    ...over,
  });

  it('packs a derived cell as a layer file, tiles intact', async () => {
    await fakeCell(CELLS[0]!, 'elg');
    const build = builder();
    await build.init();
    const manifest = await build.build(request());

    expect(manifest.files.layers).toHaveLength(1);
    const layer = manifest.files.layers![0]!;
    expect(layer).toMatchObject({
      kind: 'potential',
      layer: 'hunt',
      target: 'elg',
      minzoom: 11,
      maxzoom: 13,
      cells: ['11/1084/594'],
    });
    expect(layer.path).toBe('potential-hunt-elg.zip');
    expect(manifest.downloadBase).toBe(`/potential-packs/${manifest.id}`);
    expect(manifest.name).toBe('Elgvaldet');

    const archive = unzipSync(
      new Uint8Array(
        await readFile(path.join(dataDir, 'potential-packs', manifest.id, layer.path)),
      ),
    );
    // The whole z11–z13 pyramid: 1 + 4 + 16.
    expect(Object.keys(archive)).toHaveLength(21);
    expect(Buffer.from(archive['11/1084/594.png']!).toString()).toBe('png:11/1084/594');
    expect(Buffer.from(archive['13/4336/2376.png']!).toString()).toBe('png:13/4336/2376');
  });

  it('refuses an area whose cells have not been derived, and derives nothing', async () => {
    const build = builder();
    await build.init();
    await expect(build.build(request())).rejects.toThrow(/has not been read yet/);
    // Nothing written: the refusal is the whole behaviour.
    await expect(readdir(path.join(dataDir, 'potential-packs'))).resolves.toEqual([]);
  });

  it('counts what is missing when only part of the area is ready', async () => {
    await fakeCell(CELLS[0]!, 'elg');
    const build = builder();
    await build.init();
    await expect(build.build(request({ bbox: bboxFor(CELLS) }))).rejects.toMatchObject({
      statusCode: 409,
      detail: { missing: 1, ready: 1 },
    });
  });

  it('refuses too large an area rather than quietly keeping its middle', async () => {
    // cellsForBbox() caps its result for a viewport; a pack must not inherit
    // that silence — the user would get a map with holes and no warning.
    const build = builder();
    await build.init();
    await expect(
      build.build(request({ bbox: { sw: { lat: 59, lng: 5 }, ne: { lat: 62, lng: 12 } } })),
    ).rejects.toMatchObject({ statusCode: 400, detail: { limit: MAX_PACK_CELLS } });
  });

  it('says so plainly outside Norway', async () => {
    const build = builder();
    await build.init();
    await expect(
      build.build(request({ bbox: { sw: { lat: 48.8, lng: 2.3 }, ne: { lat: 48.9, lng: 2.4 } } })),
    ).rejects.toThrow(/Norway only/);
  });

  it('gives the same ground the same id, so re-taking it replaces the pack', async () => {
    await fakeCell(CELLS[0]!, 'elg');
    const build = builder();
    await build.init();
    const first = await build.build(request());
    const second = await build.build(request({ name: 'A different name' }));
    expect(second.id).toBe(first.id);
    expect(second.version).toBeGreaterThanOrEqual(first.version);
    expect(await readdir(path.join(dataDir, 'potential-packs'))).toEqual([first.id]);
  });

  it('gives two targets two archives', async () => {
    await fakeCell(CELLS[0]!, 'elg');
    await fakeCell(CELLS[0]!, 'radyr');
    const build = builder();
    await build.init();
    const manifest = await build.build(
      request({
        surfaces: [
          { layer: 'hunt', target: 'elg' },
          { layer: 'hunt', target: 'radyr' },
        ],
      }),
    );
    expect(manifest.files.layers!.map((f) => f.path)).toEqual([
      'potential-hunt-elg.zip',
      'potential-hunt-radyr.zip',
    ]);
  });

  it('ignores the same surface asked for twice', async () => {
    await fakeCell(CELLS[0]!, 'elg');
    const build = builder();
    await build.init();
    const manifest = await build.build(
      request({
        surfaces: [
          { layer: 'hunt', target: 'elg' },
          { layer: 'hunt', target: 'elg' },
        ],
      }),
    );
    expect(manifest.files.layers).toHaveLength(1);
  });

  it('still builds when a manifested cell has lost its tiles', async () => {
    await fakeCell(CELLS[0]!, 'elg', false);
    const build = builder();
    await build.init();
    const manifest = await build.build(request());
    // An empty archive is honest here: a missing tile draws nothing, which is
    // what underived ground already does.
    expect(manifest.files.layers![0]!.cells).toEqual(['11/1084/594']);
  });

  it('rejects a nameless pack and an unknown layer', async () => {
    const build = builder();
    await build.init();
    await expect(build.build(request({ name: '  ' }))).rejects.toThrow(/name must be/);
    await expect(
      build.build(request({ surfaces: [{ layer: 'nope', target: 'x' }] })),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(build.build(request({ surfaces: [] }))).rejects.toThrow(/at least one surface/);
  });

  it('falls back to the default target rather than trusting the request', async () => {
    await fakeCell(CELLS[0]!, 'elg');
    const build = builder();
    await build.init();
    const manifest = await build.build(
      request({ surfaces: [{ layer: 'hunt', target: '../../etc/passwd' }] }),
    );
    expect(manifest.files.layers![0]!.target).toBe('elg');
  });

  it('sweeps packs whose time on the server has run out', async () => {
    await fakeCell(CELLS[0]!, 'elg');
    let clock = 1_000_000;
    const build = builder(() => clock);
    await build.init();
    const manifest = await build.build(request());
    clock += PACK_TTL_MS + 1;
    await build.expireOld();
    expect(await readdir(path.join(dataDir, 'potential-packs'))).not.toContain(manifest.id);
  });
});

describe('POST /api/potential/packs', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await registerPotentialApi(app, {
      dataDir,
      cacheDir,
      models: [model()],
      fetchImpl: (() => Promise.reject(new Error('no upstream in this test'))) as typeof fetch,
      concurrency: 1,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers with the manifest and serves the archive it names', async () => {
    await fakeCell(CELLS[0]!, 'elg');
    const res = await app.inject({
      method: 'POST',
      url: '/api/potential/packs',
      payload: { name: 'Elgvaldet', bbox: ONE_CELL_BBOX, surfaces: [{ layer: 'hunt' }] },
    });
    expect(res.statusCode).toBe(200);
    const manifest = res.json() as RegionPackManifest;
    const layer = manifest.files.layers![0]!;

    const file = await app.inject({ url: `${manifest.downloadBase}/${layer.path}` });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.byteLength).toBe(layer.bytes);
  });

  it('reports an unprepared area as a refusal the client can act on', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/potential/packs',
      payload: { name: 'Elgvaldet', bbox: ONE_CELL_BBOX, surfaces: [{ layer: 'hunt' }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ missing: 1, ready: 0 });
  });
});
