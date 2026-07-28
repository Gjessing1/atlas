import { describe, expect, it } from 'vitest';

import {
  packFileEntries,
  packLayerFile,
  packUnzipDir,
  type RegionPackLayerFile,
  type RegionPackManifest,
} from './packs.js';

const layerFile = (overrides: Partial<RegionPackLayerFile> = {}): RegionPackLayerFile => ({
  path: 'potential-hunt-elg.zip',
  bytes: 1024,
  sha256: 'a'.repeat(64),
  kind: 'potential',
  layer: 'hunt',
  target: 'elg',
  minzoom: 11,
  maxzoom: 13,
  cells: ['11/1084/594'],
  ...overrides,
});

const manifest = (files: RegionPackManifest['files']): RegionPackManifest => ({
  id: 'oslo',
  name: 'Oslo',
  bbox: { sw: { lat: 59.7, lng: 10.4 }, ne: { lat: 60.1, lng: 11 } },
  version: 1,
  builtAt: 0,
  files,
});

describe('packFileEntries', () => {
  it('walks the fixed slots', () => {
    const entries = packFileEntries(
      manifest({
        basemap: { path: 'basemap.pmtiles', bytes: 10 },
        assets: { path: 'assets.zip', bytes: 20 },
      }),
    );
    expect(entries.map((e) => e.kind)).toEqual(['basemap', 'assets']);
    expect(entries.map((e) => e.file.bytes)).toEqual([10, 20]);
  });

  it('never yields the layers array as if it were a file', () => {
    // The whole reason this helper exists: Object.entries(files) would hand a
    // caller an array where it expects a RegionPackFile, and `.path` would be
    // undefined — a path check that silently passes, on every pack.
    const entries = packFileEntries(
      manifest({ basemap: { path: 'basemap.pmtiles', bytes: 10 }, layers: [layerFile()] }),
    );
    expect(entries.map((e) => e.kind)).toEqual(['basemap', 'layer:hunt:elg']);
    for (const entry of entries) expect(typeof entry.file.path).toBe('string');
  });

  it('distinguishes two targets of the same layer', () => {
    const entries = packFileEntries(
      manifest({
        layers: [layerFile(), layerFile({ path: 'potential-hunt-radyr.zip', target: 'radyr' })],
      }),
    );
    expect(entries.map((e) => e.kind)).toEqual(['layer:hunt:elg', 'layer:hunt:radyr']);
  });

  it('is empty for a pack with no files', () => {
    expect(packFileEntries(manifest({}))).toEqual([]);
  });
});

describe('packUnzipDir', () => {
  it('keeps assets.zip unpacking where installed packs already have it', () => {
    expect(packUnzipDir({ path: 'assets.zip', bytes: 1 })).toBe('assets');
  });

  it('gives a layer archive a directory without a naming rule of its own', () => {
    expect(packUnzipDir(layerFile())).toBe('potential-hunt-elg');
  });
});

describe('packLayerFile', () => {
  it('finds a surface by layer and target', () => {
    const pack = manifest({
      layers: [layerFile(), layerFile({ path: 'potential-hunt-radyr.zip', target: 'radyr' })],
    });
    expect(packLayerFile(pack, 'hunt', 'radyr')?.path).toBe('potential-hunt-radyr.zip');
  });

  it('does not confuse one target for another, or a pack that has none', () => {
    expect(packLayerFile(manifest({ layers: [layerFile()] }), 'hunt', 'radyr')).toBeUndefined();
    expect(packLayerFile(manifest({}), 'hunt', 'elg')).toBeUndefined();
  });
});
