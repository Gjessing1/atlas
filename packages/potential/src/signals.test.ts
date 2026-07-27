import { describe, expect, it } from 'vitest';
import {
  boundaryBand,
  classifyChannel,
  createMask,
  dischargeM3s,
  dropOffField,
  edgeMask,
  edgeProximity,
  gradientPercentProfile,
  gridOf,
  magnitudeFromDischarge,
  magnitudeFromStrahler,
  maskOf,
  membership,
  membershipGrid,
  monotonicDownstream,
  mouthMask,
  nearshoreSlopePercent,
  proximityField,
  shelfField,
  shiftBand,
  shorelineStructure,
  southness,
  structureField,
  topographicPositionM,
  aspectDegrees,
} from './index.js';
import type { Band } from './index.js';

const TROUT: Band = { min: 0.3, peakMin: 1, peakMax: 6, max: 12 };

describe('membership', () => {
  it('is a trapezoid, not a hard cut', () => {
    expect(membership(0.2, TROUT)).toBe(0);
    expect(membership(3, TROUT)).toBe(1);
    expect(membership(0.65, TROUT)).toBeCloseTo(0.5, 6);
    expect(membership(9, TROUT)).toBeCloseTo(0.5, 6);
    expect(membership(20, TROUT)).toBe(0);
  });

  it('keeps nodata unknown', () => {
    expect(Number.isNaN(membership(Number.NaN, TROUT))).toBe(true);
    const g = membershipGrid(
      gridOf(2, 1, 10, (x) => (x === 0 ? Number.NaN : 3)),
      TROUT,
    );
    expect(Number.isNaN(g.data[0]!)).toBe(true);
    expect(g.data[1]).toBe(1);
  });

  it('shifts a whole band for the season', () => {
    expect(shiftBand(TROUT, 3)).toEqual({ min: 3.3, peakMin: 4, peakMax: 9, max: 15 });
  });
});

describe('proximity', () => {
  it('halves every half-distance and is zero, not unknown, far away', () => {
    const mask = maskOf(11, 1, 10, (x) => x === 0);
    const field = proximityField(mask, { halfDistanceM: 20, maxDistanceM: 60 });
    expect(field.data[0]).toBeCloseTo(1, 10);
    expect(field.data[2]).toBeCloseTo(0.5, 6); // 20 m
    expect(field.data[4]).toBeCloseTo(0.25, 6); // 40 m
    expect(field.data[10]).toBe(0); // 100 m, past the cut
  });

  it('is flat zero when the feature is simply absent here', () => {
    const field = proximityField(createMask(4, 4, 10), { halfDistanceM: 20 });
    expect(Array.from(field.data).every((v) => v === 0)).toBe(true);
  });
});

describe('edges', () => {
  it('finds cells of one class touching another', () => {
    const forest = maskOf(4, 1, 10, (x) => x < 2);
    const farmland = maskOf(4, 1, 10, (x) => x >= 2);
    const edge = edgeMask(forest, farmland);
    expect(Array.from(edge.data)).toEqual([0, 1, 0, 0]);
    const field = edgeProximity(forest, farmland, { halfDistanceM: 10 });
    expect(field.data[1]).toBeCloseTo(1, 10);
    expect(field.data[3]).toBeCloseTo(0.25, 6);
  });
});

describe('shoreline', () => {
  const lake = maskOf(41, 41, 10, (x, y) => Math.hypot(x - 20, y - 20) <= 14);

  it('keeps the shore band inside the water and off the middle', () => {
    const band = boundaryBand(lake, 30);
    expect(band.data[20 * 41 + 20]).toBe(0); // lake centre, 140 m from shore
    expect(band.data[20 * 41 + 32]).toBe(1); // near the eastern shore
  });

  it('reads a bay as concave and open shore as neutral', () => {
    // The round lake plus a narrow inlet channel running east out of it.
    const withBay = maskOf(41, 41, 10, (x, y) => {
      if (Math.hypot(x - 20, y - 20) <= 14) return true;
      return x >= 34 && x <= 38 && y === 20;
    });
    const structure = shorelineStructure(withBay, { radiusM: 40, shoreBandM: 40 });
    const inBay = structure.coves.data[20 * 41 + 37]!;
    const openShore = structure.coves.data[6 * 41 + 20]!;
    expect(inBay).toBeGreaterThan(0.4);
    expect(inBay).toBeGreaterThan(openShore + 0.2);
    expect(structure.headlands.data[20 * 41 + 37]).toBe(0);
    // Outside the shore band the question is meaningless, not zero.
    expect(Number.isNaN(structure.curvature.data[20 * 41 + 20]!)).toBe(true);
  });

  it('infers a steep shore from the terrain around it', () => {
    // Cliff on the west bank, gentle bog on the east.
    const water = maskOf(41, 11, 10, (x) => x >= 15 && x <= 25);
    const terrain = gridOf(41, 11, 10, (x) => (x < 15 ? (15 - x) * 8 : (x - 25) * 0.2));
    const slope = nearshoreSlopePercent(terrain, water, {
      ringM: 30,
      spreadM: 30,
      shoreBandM: 30,
    });
    const west = slope.data[5 * 41 + 16]!;
    const east = slope.data[5 * 41 + 24]!;
    expect(west).toBeGreaterThan(east * 5);
    expect(Number.isNaN(slope.data[5 * 41 + 20]!)).toBe(true); // mid-lake, outside the band
  });
});

describe('mouths', () => {
  it('keeps the inflow mouth and drops the in-lake centreline', () => {
    const water = maskOf(41, 21, 10, (x, y) => Math.hypot(x - 20, y - 10) <= 10);
    // Elvenett runs the stream straight THROUGH the lake — the trap this masks.
    const streams = maskOf(41, 21, 10, (_x, y) => y === 10);
    const mouths = mouthMask(streams, water, { ringM: 20 });
    expect(mouths.data[10 * 41 + 11]).toBe(1); // western mouth
    expect(mouths.data[10 * 41 + 29]).toBe(1); // eastern mouth
    expect(mouths.data[10 * 41 + 20]).toBe(0); // lake centre — the false signal
    const field = proximityField(mouths, { halfDistanceM: 60 });
    expect(field.data[10 * 41 + 20]).toBeLessThan(field.data[10 * 41 + 12]!);
  });
});

describe('terrain helpers', () => {
  it('scores south-facing ground warm and north-facing cold', () => {
    const southFacing = gridOf(5, 5, 10, (_x, y) => -y * 2);
    expect(southness(aspectDegrees(southFacing)).data[12]).toBeCloseTo(1, 4);
    const northFacing = gridOf(5, 5, 10, (_x, y) => y * 2);
    expect(southness(aspectDegrees(northFacing)).data[12]).toBeCloseTo(0, 4);
  });

  it('separates a knoll from its surroundings', () => {
    const terrain = gridOf(21, 21, 10, (x, y) => (Math.hypot(x - 10, y - 10) < 3 ? 20 : 0));
    const tpi = topographicPositionM(terrain, 60);
    expect(tpi.data[10 * 21 + 10]).toBeGreaterThan(5);
    expect(tpi.data[0]).toBeLessThanOrEqual(0);
  });
});

describe('lake structure', () => {
  const depth = gridOf(40, 1, 10, (x) => (x < 20 ? 2 : 2 + (x - 20) * 3));

  it('lights the break, not the whole slope', () => {
    const dropOff = dropOffField(depth, {
      steepPercent: { min: 5, peakMin: 15, peakMax: 100, max: 400 },
      depthBandM: { min: 1, peakMin: 3, peakMax: 20, max: 30 },
    });
    expect(dropOff.data[22]).toBeGreaterThan(0.5);
    expect(dropOff.data[5]).toBeLessThan(0.1); // flat shallows
    expect(dropOff.data[38]).toBeLessThan(0.5); // too deep for the band
  });

  it('reads the flat shallows as shelf', () => {
    const shelf = shelfField(depth, {
      flatPercent: { min: -1, peakMin: 0, peakMax: 5, max: 12 },
      shallowM: { min: 0, peakMin: 1, peakMax: 4, max: 8 },
    });
    expect(shelf.data[5]).toBeGreaterThan(0.8);
    expect(shelf.data[30]).toBeLessThan(0.2);
  });

  it('takes the max of drop-off and shelf, never their average', () => {
    const steep = gridOf(2, 1, 10, (x) => (x === 0 ? 1 : 0));
    const flat = gridOf(2, 1, 10, (x) => (x === 0 ? 0 : 1));
    const structure = structureField(steep, flat);
    // Averaging would cap both at 0.5 and wash the surface out — the nodemap bug.
    expect(Array.from(structure.data)).toEqual([1, 1]);
  });
});

describe('channel gradient', () => {
  it('forces a noisy profile to run downhill', () => {
    expect(monotonicDownstream([100, 101, 99, 99.5, 97])).toEqual([100, 100, 99, 99, 97]);
  });

  it('measures gradient in percent, so real reaches separate', () => {
    // 0.1 % — a pool. In degrees this is 0.06°, indistinguishable from flat.
    const pool = gradientPercentProfile([100, 99.9, 99.8, 99.7], 100);
    expect(pool[1]).toBeCloseTo(0.1, 6);
    expect(classifyChannel(pool[1]!)).toBe('pool');

    // 2 % — a riffle. Only 1.1°, which the old degree rule called "flat".
    const riffle = gradientPercentProfile([100, 98, 96, 94], 100);
    expect(riffle[1]).toBeCloseTo(2, 6);
    expect(classifyChannel(riffle[1]!)).toBe('riffle');

    expect(classifyChannel(25)).toBe('cascade');
  });
});

describe('river magnitude', () => {
  it('converts NVE annual discharge to m3/s (Glomma sanity check)', () => {
    // 24 362 mill. m3/year is the ~772 m3/s Glomma is known for.
    expect(dischargeM3s(24362)).toBeCloseTo(772, 0);
    expect(dischargeM3s(63)).toBeCloseTo(2, 0);
  });

  it('separates a brook from a big river on a log scale', () => {
    expect(magnitudeFromDischarge(2)).toBeLessThan(magnitudeFromDischarge(772));
    expect(magnitudeFromDischarge(0)).toBe(0);
    expect(magnitudeFromDischarge(5000)).toBe(1);
  });

  it('falls back to Strahler order where no catchment figure exists', () => {
    expect(magnitudeFromStrahler(1)).toBe(0);
    expect(magnitudeFromStrahler(4)).toBeCloseTo(0.5, 6);
    expect(magnitudeFromStrahler(8)).toBe(1);
    expect(magnitudeFromStrahler(Number.NaN)).toBe(0);
  });
});
