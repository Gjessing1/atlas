import type { LayerMeta, RegionPackLayerFile, RegionPackManifest } from '@atlas/core';
import { describe, expect, it } from 'vitest';

import type { ActiveOverlay } from '../layers/useOverlays';
import {
  localImageryBase,
  localSurfaceTemplate,
  packWithImagery,
  packWithSurface,
  withLocalSurfaces,
} from './localSurfaces';
import type { LocalPack } from './packs';

/**
 * E7 — a kept surface is drawn from disk.
 *
 * The rules asserted are the ones that decide whether the feature works in the
 * field at all: coverage is judged by *cell* (a framed rectangle almost never
 * lands on cell boundaries, so asking the bbox blanks the edges), the source id
 * has to change with the URL or MapLibre keeps the tiles it already has, and a
 * pack for the wrong quarry must not be mistaken for this one.
 */

/** Nordmarka: cell 11/1084/594 spans 10.547–10.723 × 59.977–60.065. */
const IN_CELL = { lat: 60.02, lng: 10.6 };
const ELSEWHERE = { lat: 63.43, lng: 10.4 };

const layerFile = (over: Partial<RegionPackLayerFile> = {}): RegionPackLayerFile => ({
  path: 'potential-hunt-elg.zip',
  bytes: 10,
  kind: 'potential',
  layer: 'hunt',
  target: 'elg',
  minzoom: 11,
  maxzoom: 13,
  cells: ['11/1084/594'],
  ...over,
});

const pack = (layers: RegionPackLayerFile[], id = 'potential-abc'): LocalPack => ({
  dir: `file:///doc/packs/${id}`,
  manifest: {
    id,
    name: 'Elgvaldet',
    bbox: { sw: { lat: 60, lng: 10.6 }, ne: { lat: 60.03, lng: 10.65 } },
    version: 1,
    builtAt: 0,
    files: { layers },
  } satisfies RegionPackManifest,
});

const imageryFile = (over: Partial<RegionPackLayerFile> = {}): RegionPackLayerFile => ({
  path: 'imagery.zip',
  bytes: 10,
  kind: 'imagery',
  layer: 'satellite-2025',
  minzoom: 0,
  // Below the layer's own z13: the producer stops where the region's size
  // budget does, and the client must overzoom from what is really there.
  maxzoom: 11,
  ...over,
});

const imageryOverlay = (over: Partial<ActiveOverlay> = {}): ActiveOverlay => ({
  meta: {
    id: 'satellite-2025',
    maxzoom: 19,
    offlinePack: { maxzoom: 13 },
  } as unknown as LayerMeta,
  opacity: 1,
  tileUrlTemplate: 'https://atlas.example/api/overlay/satellite-2025/{z}/{x}/{y}.png',
  options: {},
  sourceId: 'atlas-overlay-satellite-2025',
  ...over,
});

const overlay = (over: Partial<ActiveOverlay> = {}): ActiveOverlay => ({
  meta: {
    id: 'hunt',
    name: 'Hunt potential',
    derived: { vocabulary: 'hunt', legend: [] },
  } as unknown as LayerMeta,
  opacity: 0.8,
  tileUrlTemplate: 'https://atlas.example/api/potential/hunt/elg/{z}/{x}/{y}.png',
  options: { target: 'elg' },
  sourceId: 'atlas-overlay-hunt--target=elg',
  ...over,
});

describe('packWithSurface', () => {
  it('finds the pack whose cells cover the view', () => {
    expect(packWithSurface([pack([layerFile()])], 'hunt', 'elg', IN_CELL)?.manifest.id).toBe(
      'potential-abc',
    );
  });

  it('judges coverage by cell, not by the framed rectangle', () => {
    // A point inside the cell but outside the bbox the user drew still draws:
    // the surface exists in whole cells, and blanking the difference would put
    // a hole along every edge of every pack.
    const outsideBbox = { lat: 60.05, lng: 10.7 };
    expect(packWithSurface([pack([layerFile()])], 'hunt', 'elg', outsideBbox)).toBeDefined();
  });

  it('does not answer for ground the pack never carried', () => {
    expect(packWithSurface([pack([layerFile()])], 'hunt', 'elg', ELSEWHERE)).toBeUndefined();
  });

  it('does not mistake one quarry for another', () => {
    expect(packWithSurface([pack([layerFile()])], 'hunt', 'radyr', IN_CELL)).toBeUndefined();
    expect(packWithSurface([pack([layerFile()])], 'lake-fishing', 'elg', IN_CELL)).toBeUndefined();
  });

  it('has no answer before the map has settled anywhere', () => {
    expect(packWithSurface([pack([layerFile()])], 'hunt', 'elg', null)).toBeUndefined();
  });
});

describe('localSurfaceTemplate', () => {
  it('points at the archive’s own directory inside the pack', () => {
    expect(localSurfaceTemplate([pack([layerFile()])], 'hunt', 'elg', IN_CELL)).toBe(
      'file:///doc/packs/potential-abc/potential-hunt-elg/{z}/{x}/{y}.png',
    );
  });

  it('is null where no pack covers the view', () => {
    expect(localSurfaceTemplate([pack([layerFile()])], 'hunt', 'elg', ELSEWHERE)).toBeNull();
  });
});

describe('offline imagery', () => {
  it('covers the view by the pack bbox, not by cells', () => {
    const packs = [pack([imageryFile()])];
    // Inside the pack's rectangle but outside the derive cell list it carries
    // none of: an imagery slab is cut to the rectangle, so this is covered.
    expect(packWithImagery(packs, 'satellite-2025', { lat: 60.01, lng: 10.62 })).toBeDefined();
    expect(packWithImagery(packs, 'satellite-2025', ELSEWHERE)).toBeUndefined();
  });

  it('ignores a pack that carries only a derived surface', () => {
    expect(packWithImagery([pack([layerFile()])], 'satellite-2025', IN_CELL)).toBeUndefined();
  });

  it('hands MapLibre the archive’s own maxzoom, not the catalog’s', () => {
    const base = localImageryBase([pack([imageryFile()])], 'satellite-2025', IN_CELL);
    expect(base).toEqual({
      tileUrlTemplate: 'file:///doc/packs/potential-abc/imagery/{z}/{x}/{y}.png',
      maxzoom: 11,
    });
  });

  it('attaches the slab without touching the live layer', () => {
    const [out] = withLocalSurfaces([imageryOverlay()], [pack([imageryFile()])], IN_CELL, false);
    // The layer above keeps streaming: the slab is drawn *under* it, so it only
    // shows where the live tiles could not load.
    expect(out!.tileUrlTemplate).toMatch(/^https:/);
    expect(out!.sourceId).toBe('atlas-overlay-satellite-2025');
    expect(out!.offlineBase).toEqual({
      tileUrlTemplate: 'file:///doc/packs/potential-abc/imagery/{z}/{x}/{y}.png',
      maxzoom: 11,
    });
  });

  it('keeps the slab even when the user asked for online tiles', () => {
    // preferOnline is for a pack the user knows is stale, and it cannot hide
    // anything: the slab is only ever visible where the live layer failed, so
    // dropping it there would trade a stale picture for a blank one.
    const [out] = withLocalSurfaces([imageryOverlay()], [pack([imageryFile()])], IN_CELL, true);
    expect(out!.offlineBase).toBeDefined();
  });

  it('leaves the layer alone where no pack reaches', () => {
    const [out] = withLocalSurfaces([imageryOverlay()], [pack([imageryFile()])], ELSEWHERE, false);
    expect(out!.offlineBase).toBeUndefined();
  });
});

describe('withLocalSurfaces', () => {
  it('swaps the derived surface onto the pack and remounts the source', () => {
    const [out] = withLocalSurfaces([overlay()], [pack([layerFile()])], IN_CELL, false);
    expect(out!.tileUrlTemplate).toMatch(/^file:\/\/\/doc\/packs\//);
    // Without a new id the native source keeps serving the tiles it already
    // loaded from the server.
    expect(out!.sourceId).toBe('atlas-overlay-hunt--target=elg--offline');
    // Everything else is untouched: same legend, same opacity, same layer.
    expect(out!.opacity).toBe(0.8);
    expect(out!.meta.id).toBe('hunt');
  });

  it('leaves ordinary overlays alone', () => {
    const wms = overlay({
      meta: { id: 'lake-depth' } as unknown as LayerMeta,
      sourceId: 'atlas-overlay-lake-depth',
      tileUrlTemplate: 'https://atlas.example/api/overlay/lake-depth/{z}/{x}/{y}.png',
    });
    expect(withLocalSurfaces([wms], [pack([layerFile()])], IN_CELL, false)[0]).toBe(wms);
  });

  it('keeps streaming when the user asked for online tiles', () => {
    const [out] = withLocalSurfaces([overlay()], [pack([layerFile()])], IN_CELL, true);
    expect(out!.tileUrlTemplate).toMatch(/^https:/);
  });

  it('keeps streaming where the pack does not reach', () => {
    const [out] = withLocalSurfaces([overlay()], [pack([layerFile()])], ELSEWHERE, false);
    expect(out!.tileUrlTemplate).toMatch(/^https:/);
    expect(out!.sourceId).toBe('atlas-overlay-hunt--target=elg');
  });

  it('picks the pack that carries the switched-on quarry', () => {
    const packs = [
      pack([layerFile({ path: 'potential-hunt-radyr.zip', target: 'radyr' })], 'potential-roe'),
      pack([layerFile()], 'potential-elk'),
    ];
    const [out] = withLocalSurfaces([overlay()], packs, IN_CELL, false);
    expect(out!.tileUrlTemplate).toContain('/potential-elk/potential-hunt-elg/');
  });

  it('does nothing with no packs installed', () => {
    const overlays = [overlay()];
    expect(withLocalSurfaces(overlays, [], IN_CELL, false)).toBe(overlays);
  });
});
