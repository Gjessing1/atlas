import { describe, expect, it } from 'vitest';

import {
  isImageryPack,
  packFileEntries,
  packImageryFile,
  packIncompatibleReason,
  packLayerFile,
  packUnzipDir,
  PACK_RUNTIME_IMAGERY,
  PACK_RUNTIME_REGION,
  PACK_RUNTIME_VERSION,
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

describe('packIncompatibleReason', () => {
  const pack = (compat?: RegionPackManifest['compat']): RegionPackManifest => ({
    ...manifest({ basemap: { path: 'basemap.pmtiles', bytes: 10 } }),
    ...(compat ? { compat } : {}),
  });

  it('accepts a pack built for this runtime', () => {
    expect(
      packIncompatibleReason(pack({ schema: 1, minRuntime: PACK_RUNTIME_VERSION })),
    ).toBeNull();
  });

  it('accepts a pre-DR7 pack that declares nothing', () => {
    // Every pack already installed on a phone is one of these; treating a
    // missing contract as unusable would uninstall working offline maps.
    expect(packIncompatibleReason(pack())).toBeNull();
  });

  it('accepts a newer document shape it can still read', () => {
    // Added manifest fields are optional by construction, and the artifacts are
    // what the app actually opens.
    expect(packIncompatibleReason(pack({ schema: 99, minRuntime: 1 }), 1)).toBeNull();
  });

  it('rejects a pack whose artifacts need a newer app', () => {
    expect(packIncompatibleReason(pack({ schema: 2, minRuntime: 2 }), 1)).toMatch(
      /needs a newer version of Atlas/,
    );
  });

  it('rejects a nonsense contract rather than trusting it', () => {
    expect(
      packIncompatibleReason(pack({ schema: 1, minRuntime: 0 } as RegionPackManifest['compat']), 1),
    ).toMatch(/invalid minimum runtime/);
  });
});

describe('imagery packs', () => {
  const imagery = layerFile({
    path: 'imagery.pmtiles',
    kind: 'imagery',
    layer: 'satellite-2025',
    minzoom: 0,
    maxzoom: 13,
    target: undefined,
    cells: undefined,
  });

  it('tells an imagery download from a region', () => {
    expect(isImageryPack(manifest({ layers: [imagery] }))).toBe(true);
    // A region that happens to carry imagery is still a region.
    expect(
      isImageryPack(
        manifest({ basemap: { path: 'basemap.pmtiles', bytes: 10 }, layers: [imagery] }),
      ),
    ).toBe(false);
    expect(isImageryPack(manifest({ layers: [layerFile()] }))).toBe(false);
  });

  it('finds the imagery for a layer, never a surface', () => {
    const pack = manifest({ layers: [layerFile(), imagery] });
    expect(packImageryFile(pack, 'satellite-2025')).toBe(imagery);
    expect(packImageryFile(pack, 'hunt')).toBeUndefined();
    expect(packFileEntries(pack).map((entry) => entry.kind)).toEqual([
      'layer:hunt:elg',
      'layer:satellite-2025',
    ]);
  });

  it('is declined by apps that cannot draw it, while regions stay installable', () => {
    // An app from before the raster archive would download a country of
    // imagery and draw none of it.
    const pack = {
      ...manifest({ layers: [imagery] }),
      compat: { schema: 2, minRuntime: PACK_RUNTIME_IMAGERY },
    };
    expect(packIncompatibleReason(pack, PACK_RUNTIME_REGION)).toMatch(/newer version/);
    expect(packIncompatibleReason(pack)).toBeNull();
    // Raising what this app reads must not raise what a region demands.
    expect(PACK_RUNTIME_REGION).toBe(1);
    expect(PACK_RUNTIME_VERSION).toBeGreaterThanOrEqual(PACK_RUNTIME_IMAGERY);
  });
});
