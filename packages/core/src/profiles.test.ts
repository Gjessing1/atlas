import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP_PROFILE,
  isMapProfile,
  layerDefaultsOn,
  layerInProfile,
  layersForProfile,
  MAP_PROFILES,
  mapProfile,
  type LayerMeta,
} from './index.js';

describe('map profiles', () => {
  const meta = (id: string, profiles?: string[]): LayerMeta =>
    ({ id, rev: 1, profiles }) as LayerMeta;

  it('narrows unknown ids to the default profile', () => {
    expect(isMapProfile('hike')).toBe(true);
    expect(isMapProfile('rocket')).toBe(false);
    expect(isMapProfile(null)).toBe(false);
    expect(mapProfile('rocket').id).toBe(DEFAULT_MAP_PROFILE);
  });

  it('always offers untagged general-purpose layers', () => {
    for (const p of MAP_PROFILES) {
      expect(layerInProfile(meta('hillshade'), p.id)).toBe(true);
      expect(layerInProfile(meta('property', []), p.id)).toBe(true);
    }
  });

  it('hides a tagged layer until its own profile is picked', () => {
    expect(layerInProfile(meta('trails-ski', ['ski']), 'ski')).toBe(true);
    expect(layerInProfile(meta('trails-ski', ['ski']), 'explore')).toBe(false);
    expect(layerInProfile(meta('trails-ski', ['ski']), 'hike')).toBe(false);
  });

  it('matches the hiking tag from the hike profile despite the differing words', () => {
    expect(layerInProfile(meta('trails-hiking', ['hiking']), 'hike')).toBe(true);
    expect(layerInProfile(meta('trails-bike', ['bike']), 'bike')).toBe(true);
  });

  it('filters a catalog while keeping the server order', () => {
    const catalog = [
      meta('hillshade'),
      meta('trails-ski', ['ski']),
      meta('sea-depth'),
      meta('trails-hiking', ['hiking']),
    ];
    expect(layersForProfile(catalog, 'explore').map((m) => m.id)).toEqual([
      'hillshade',
      'sea-depth',
    ]);
    expect(layersForProfile(catalog, 'hike').map((m) => m.id)).toEqual([
      'hillshade',
      'sea-depth',
      'trails-hiking',
    ]);
  });

  it('turns a profile default layer on only within that profile', () => {
    // Hike surfaces the trail network by default; nobody else does, and no
    // profile defaults a layer it does not even offer.
    expect(layerDefaultsOn('trails-hiking', 'hike')).toBe(true);
    expect(layerDefaultsOn('trails-hiking', 'explore')).toBe(false);
    expect(layerDefaultsOn('trails-hiking', 'bike')).toBe(false);
    expect(layerDefaultsOn('hillshade', 'hike')).toBe(false);
    for (const p of MAP_PROFILES) {
      for (const id of p.defaultLayers ?? []) {
        expect(layerInProfile(meta(id, [p.layerTags[0]!]), p.id)).toBe(true);
      }
    }
  });

  it('only names travel modes the routing package actually knows', () => {
    // A profile whose `routing` drifts from ROUTING_PROFILES would silently
    // fail at request time; core can't import routing, so assert the ids here.
    const known = ['car', 'bike', 'foot', 'hike'];
    for (const p of MAP_PROFILES) {
      if (p.routing !== null) expect(known).toContain(p.routing);
    }
  });
});
