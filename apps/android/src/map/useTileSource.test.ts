import type { BBox, RegionPackManifest } from '@atlas/core';
import { describe, expect, it } from 'vitest';

import type { LocalPack } from '../regions/packs';
import { packCoveringView } from './useTileSource';

const oslo: BBox = { sw: { lat: 59.8, lng: 10.5 }, ne: { lat: 60.1, lng: 11.0 } };
const bergen: BBox = { sw: { lat: 60.2, lng: 5.1 }, ne: { lat: 60.5, lng: 5.6 } };

const file = { path: 'x', bytes: 1, sha256: '' };

function pack(
  name: string,
  bbox: BBox,
  files: RegionPackManifest['files'] = { basemap: file, assets: file },
): LocalPack {
  return {
    dir: `file:///packs/${name}`,
    manifest: { id: name, name, bbox, version: 1, builtAt: 0, files },
  };
}

describe('packCoveringView', () => {
  const packs = [pack('Oslo', oslo), pack('Bergen', bergen)];

  it('picks the pack the map is looking at', () => {
    expect(packCoveringView(packs, { lat: 59.91, lng: 10.75 })?.manifest.name).toBe('Oslo');
    expect(packCoveringView(packs, { lat: 60.39, lng: 5.32 })?.manifest.name).toBe('Bergen');
  });

  it('gives up outside every pack, where its tiles would draw a blank map', () => {
    expect(packCoveringView(packs, { lat: 63.43, lng: 10.4 })).toBeUndefined();
  });

  it('ignores packs that cannot draw a complete map on their own', () => {
    const here = { lat: 59.91, lng: 10.75 };
    expect(packCoveringView([pack('Oslo', oslo, {})], here)).toBeUndefined();
    // Tiles but no glyphs/sprites: a label-less map is worse than streaming.
    expect(packCoveringView([pack('Oslo', oslo, { basemap: file })], here)).toBeUndefined();
  });

  it('has nothing to cover before the camera has settled', () => {
    expect(packCoveringView(packs, null)).toBeUndefined();
  });
});
