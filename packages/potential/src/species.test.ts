import { describe, expect, it } from 'vitest';
import {
  altitudePlausible,
  depthBandFor,
  describeDepthBand,
  FISH_SPECIES,
  fishSpecies,
  HUNT_SEASON_REFERENCE,
  HUNT_SIGNALS,
  LAKE_SIGNALS,
  QUARRIES,
  quarry,
  RIVER_SIGNALS,
  seasonAt,
  signalMeta,
  WILDLIFE_ACT_REFERENCE,
} from './index.js';

describe('signal registries', () => {
  it('has unique keys across every registry', () => {
    const keys = [...LAKE_SIGNALS, ...RIVER_SIGNALS, ...HUNT_SIGNALS].map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every signal a label and a sentence behind it', () => {
    for (const signal of [...LAKE_SIGNALS, ...RIVER_SIGNALS, ...HUNT_SIGNALS]) {
      expect(signal.label.length).toBeGreaterThan(2);
      expect(signal.about.length).toBeGreaterThan(10);
    }
    expect(signalMeta('inlet')?.label).toBe('Inflow mouth');
    expect(signalMeta('nope')).toBeUndefined();
  });
});

describe('fish species', () => {
  it('weights only signals that exist', () => {
    const lake = new Set<string>(LAKE_SIGNALS.map((s) => s.key));
    const river = new Set<string>(RIVER_SIGNALS.map((s) => s.key));
    for (const species of FISH_SPECIES) {
      for (const [key, weight] of Object.entries(species.lakeWeights)) {
        expect(lake.has(key)).toBe(true);
        expect(weight).toBeGreaterThan(0);
      }
      for (const [key, weight] of Object.entries(species.riverWeights)) {
        expect(river.has(key)).toBe(true);
        expect(weight).toBeGreaterThan(0);
      }
    }
  });

  it('keeps depth bands ordered and plausible', () => {
    for (const species of FISH_SPECIES) {
      const band = species.depthBandM;
      if (!band) continue;
      expect(band.min).toBeLessThanOrEqual(band.peakMin);
      expect(band.peakMin).toBeLessThanOrEqual(band.peakMax);
      expect(band.peakMax).toBeLessThanOrEqual(band.max);
    }
    // Char hold deeper than trout — the distinction the bathymetric model turns on.
    expect(fishSpecies('roye')!.depthBandM!.peakMin).toBeGreaterThan(
      fishSpecies('orret')!.depthBandM!.peakMax,
    );
  });

  it('shifts the band for the season and says which band is in use', () => {
    const trout = fishSpecies('orret')!;
    expect(depthBandFor(trout, 'spring')).toEqual(trout.depthBandM);
    expect(depthBandFor(trout, 'summer')!.peakMin).toBe(4);
    expect(describeDepthBand(trout, 'summer')).toBe('Summer band 4–9 m');
    // River targets have no depth band at all, and say so rather than inventing one.
    expect(describeDepthBand(fishSpecies('laks')!, 'summer')).toBeNull();
  });

  it('picks the season from the date', () => {
    expect(seasonAt(new Date('2026-07-27T10:00:00Z'))).toBe('summer');
    expect(seasonAt(new Date('2026-01-05T10:00:00Z'))).toBe('winter');
    expect(seasonAt(new Date('2026-10-05T10:00:00Z'))).toBe('autumn');
    expect(seasonAt(new Date('2026-04-05T10:00:00Z'))).toBe('spring');
  });

  it('lets an observation overrule the altitude rule in both directions', () => {
    const pike = fishSpecies('gjedde')!;
    expect(altitudePlausible(pike, 200)).toBe(true);
    expect(altitudePlausible(pike, 1100)).toBe(false);
    // Presence-only data: a recorded observation wins outright.
    expect(altitudePlausible(pike, 1100, true)).toBe(true);
    // And absence proves nothing, so the caller may still pass false.
    expect(altitudePlausible(fishSpecies('orret')!, 100, false)).toBe(false);
  });

  it('marks exactly the sea-run species anadromous', () => {
    expect(FISH_SPECIES.filter((s) => s.anadromous).map((s) => s.id)).toEqual(['laks', 'sjoorret']);
  });
});

describe('quarry profiles', () => {
  it('weights only hunt signals that exist', () => {
    const hunt = new Set<string>(HUNT_SIGNALS.map((s) => s.key));
    for (const q of QUARRIES) {
      expect(Object.keys(q.weights).length).toBeGreaterThan(2);
      for (const [key, weight] of Object.entries(q.weights)) {
        expect(hunt.has(key)).toBe(true);
        expect(weight).toBeGreaterThan(0);
      }
    }
  });

  it('models the tree-line species relative to the tree line, not to an elevation', () => {
    // A fixed elevation would travel wrongly from Sørlandet to Finnmark.
    expect(quarry('lirype')!.treeLineBandM).not.toBeNull();
    expect(quarry('fjellrype')!.treeLineBandM!.peakMin).toBeGreaterThan(
      quarry('lirype')!.treeLineBandM!.peakMin,
    );
    expect(quarry('radyr')!.treeLineBandM).toBeNull();
  });

  it('keeps the shy quarry further from roads than the tolerant one', () => {
    expect(quarry('hjort')!.disturbanceBufferM).toBeGreaterThan(
      quarry('radyr')!.disturbanceBufferM,
    );
  });

  it('gives elg browse and storfugl mature pine as their leading signal', () => {
    const leading = (id: string) =>
      Object.entries(quarry(id)!.weights).sort((a, b) => b[1] - a[1])[0]![0];
    expect(leading('elg')).toBe('browse');
    expect(leading('storfugl')).toBe('pine-mature');
    expect(leading('radyr')).toBe('edge-farmland');
  });
});

describe('legal references', () => {
  it('links the jakttider forskrift with an as-of stamp instead of restating dates', () => {
    expect(HUNT_SEASON_REFERENCE.url).toContain('lovdata.no');
    expect(HUNT_SEASON_REFERENCE.forskriftId).toBe('FOR-2022-01-21-128');
    expect(HUNT_SEASON_REFERENCE.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(WILDLIFE_ACT_REFERENCE.lawId).toBe('LOV-2025-06-20-102');
  });

  it('ships no hunting season dates at all', () => {
    // Regional variation (15 March in Finnmark, Troms, Narvik and Evenes; elg
    // starts earlier in the north) plus the 31 March 2028 expiry make any
    // national date pair in this file wrong-by-default. This guard is the
    // mechanism that keeps "links, not dates" from decaying into wallpaper.
    const data = JSON.stringify(QUARRIES);
    expect(data).not.toMatch(/jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}-\d{2}-\d{2}/i);
    for (const q of QUARRIES) {
      expect(Object.keys(q)).not.toContain('season');
      expect(Object.keys(q)).not.toContain('seasonFrom');
      expect(Object.keys(q)).not.toContain('seasonTo');
    }
  });
});
