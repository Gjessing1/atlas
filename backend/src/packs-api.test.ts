import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppVersionResponse, RegionsResponse } from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

let dataDir: string;
let app: FastifyInstance;

const manifest = {
  id: 'ignored-by-server',
  name: 'Oslo',
  bbox: { sw: { lat: 59.7, lng: 10.4 }, ne: { lat: 60.1, lng: 11.0 } },
  version: 3,
  builtAt: 1_784_000_000_000,
  files: {
    basemap: { path: 'basemap.pmtiles', bytes: 17 },
    search: { path: 'search.sqlite', bytes: 5 },
  },
};

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-packs-test-'));
  const oslo = path.join(dataDir, 'packs', 'oslo');
  await mkdir(oslo, { recursive: true });
  await writeFile(path.join(oslo, 'pack.json'), JSON.stringify(manifest));
  await writeFile(path.join(oslo, 'basemap.pmtiles'), 'PMTiles-pack-fixture');
  await writeFile(path.join(oslo, 'search.sqlite'), 'sqlDB');
  // A directory without a manifest must be skipped, not break the listing.
  await mkdir(path.join(dataDir, 'packs', 'incomplete'), { recursive: true });

  const appDir = path.join(dataDir, 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(
    path.join(appDir, 'version.json'),
    JSON.stringify({ versionCode: 7, versionName: '0.2.0', file: 'atlas-0.2.0.apk' }),
  );
  await writeFile(path.join(appDir, 'atlas-0.2.0.apk'), 'apk-bytes');
  await writeFile(path.join(appDir, 'notes.txt'), 'not an apk');

  app = await buildApp({ dataDir });
});

afterAll(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('/api/regions', () => {
  it('lists pack manifests with the directory as id', async () => {
    const res = await app.inject({ url: '/api/regions' });
    expect(res.statusCode).toBe(200);
    const body = res.json<RegionsResponse>();
    expect(body.regions).toHaveLength(1);
    expect(body.regions[0].id).toBe('oslo');
    expect(body.regions[0].name).toBe('Oslo');
    expect(body.regions[0].files.basemap?.path).toBe('basemap.pmtiles');
  });

  it('serves pack files with range support', async () => {
    const res = await app.inject({
      url: '/packs/oslo/basemap.pmtiles',
      headers: { range: 'bytes=0-6' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('PMTiles');
  });
});

describe('/api/app/version', () => {
  it('reports the published APK', async () => {
    const res = await app.inject({ url: '/api/app/version' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AppVersionResponse>();
    expect(body.versionCode).toBe(7);
    expect(body.versionName).toBe('0.2.0');
    expect(body.apkUrl).toBe('/app/atlas-0.2.0.apk');
    expect(body.bytes).toBe(9);
  });

  it('serves only .apk files from the app dir', async () => {
    const apk = await app.inject({ url: '/app/atlas-0.2.0.apk' });
    expect(apk.statusCode).toBe(200);
    const other = await app.inject({ url: '/app/notes.txt' });
    expect(other.statusCode).toBe(404);
  });
});

describe('without packs/app directories', () => {
  it('answers empty/404 instead of failing', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'atlas-bare-test-'));
    const bareApp = await buildApp({ dataDir: bare });
    try {
      const regions = await bareApp.inject({ url: '/api/regions' });
      expect(regions.statusCode).toBe(200);
      expect(regions.json<RegionsResponse>().regions).toEqual([]);
      const version = await bareApp.inject({ url: '/api/app/version' });
      expect(version.statusCode).toBe(404);
    } finally {
      await bareApp.close();
      await rm(bare, { recursive: true, force: true });
    }
  });
});
