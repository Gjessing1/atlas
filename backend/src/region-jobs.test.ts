import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RegionPackJob, RegionPackManifest } from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const BBOX = {
  sw: { lat: 59.8, lng: 10.5 },
  ne: { lat: 60.05, lng: 10.95 },
};

async function fixture(): Promise<{
  app: FastifyInstance;
  dataDir: string;
  extracted: { bbox?: unknown };
}> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-region-jobs-'));
  await mkdir(path.join(dataDir, 'tiles'), { recursive: true });
  await writeFile(path.join(dataDir, 'tiles', 'norway.pmtiles'), 'master');
  const baseDir = path.join(dataDir, 'packs', 'east');
  await mkdir(baseDir, { recursive: true });
  const manifest: RegionPackManifest = {
    id: 'east',
    name: 'Eastern Norway',
    bbox: { sw: { lat: 57.5, lng: 4 }, ne: { lat: 63, lng: 14 } },
    version: 1,
    builtAt: 1,
    files: {
      basemap: { path: 'basemap.pmtiles', bytes: 4 },
      search: { path: 'search.sqlite', bytes: 6 },
      routing: { path: 'valhalla.tar', bytes: 7 },
      assets: { path: 'assets.zip', bytes: 6 },
    },
  };
  await writeFile(path.join(baseDir, 'pack.json'), JSON.stringify(manifest));
  await writeFile(path.join(baseDir, 'basemap.pmtiles'), 'base');
  await writeFile(path.join(baseDir, 'search.sqlite'), 'search');
  await writeFile(path.join(baseDir, 'valhalla.tar'), 'routing');
  await writeFile(path.join(baseDir, 'assets.zip'), 'assets');
  const largerDir = path.join(dataDir, 'packs', 'norway');
  await mkdir(largerDir, { recursive: true });
  await writeFile(
    path.join(largerDir, 'pack.json'),
    JSON.stringify({
      ...manifest,
      id: 'norway',
      name: 'All Norway',
      bbox: { sw: { lat: 55, lng: 2 }, ne: { lat: 72, lng: 32 } },
      files: {
        basemap: { path: 'basemap.pmtiles', bytes: 4 },
        search: { path: 'search.sqlite', bytes: 13 },
        routing: { path: 'valhalla.tar', bytes: 19 },
        assets: { path: 'assets.zip', bytes: 13 },
      },
    } satisfies RegionPackManifest),
  );
  await writeFile(path.join(largerDir, 'basemap.pmtiles'), 'base');
  await writeFile(path.join(largerDir, 'search.sqlite'), 'larger-search');
  await writeFile(path.join(largerDir, 'valhalla.tar'), 'much-larger-routing');
  await writeFile(path.join(largerDir, 'assets.zip'), 'larger-assets');
  const extracted: { bbox?: unknown } = {};
  const app = await buildApp({
    dataDir,
    globalRateLimit: 0,
    regionJobs: {
      extract: async (_input, output, bbox) => {
        extracted.bbox = bbox;
        await writeFile(output, 'custom tiles');
      },
    },
  });
  return { app, dataDir, extracted };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe('custom offline-region jobs', () => {
  it('extracts tiles and reuses the smallest enclosing routing/search pack', async () => {
    const { app, dataDir, extracted } = await fixture();
    cleanup.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    const create = await app.inject({
      method: 'POST',
      url: '/api/region-jobs',
      payload: { name: 'Weekend map', bbox: BBOX },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json<RegionPackJob>().id;

    let job: RegionPackJob | undefined;
    await vi.waitFor(async () => {
      job = (await app.inject({ url: `/api/region-jobs/${id}` })).json<RegionPackJob>();
      expect(job.status).toBe('done');
    });
    expect(extracted.bbox).toEqual(BBOX);
    expect(job?.manifest?.downloadBase).toBe(`/region-jobs/files/${id}`);
    expect(job?.manifest?.custom).toBe(true);
    expect(job?.manifest?.files.routing?.bytes).toBe(7);
    // Every file carries a digest so the device can verify before swapping.
    const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(job?.manifest?.files.basemap?.sha256).toBe(digestOf('custom tiles'));
    expect(job?.manifest?.files.routing?.sha256).toBe(digestOf('routing'));

    const tiles = await app.inject({ url: `/region-jobs/files/${id}/basemap.pmtiles` });
    expect(tiles.statusCode).toBe(200);
    expect(tiles.body).toBe('custom tiles');
    expect(
      await readFile(path.join(dataDir, 'pack-jobs', 'artifacts', id, 'search.sqlite'), 'utf8'),
    ).toBe('search');
  });

  it('rejects selections outside the published routing packs', async () => {
    const { app, dataDir } = await fixture();
    cleanup.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/region-jobs',
      payload: {
        name: 'Outside',
        bbox: { sw: { lat: 73, lng: 20 }, ne: { lat: 73.2, lng: 20.3 } },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'no published offline region fully contains this selection',
    });
  });
});
