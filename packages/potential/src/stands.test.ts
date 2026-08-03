import { describe, expect, it } from 'vitest';

import { createGrid, gridOf, maskOf } from './raster.js';
import {
  decodeStandVantage,
  huntStandPlan,
  STAND_DIRECTIONS,
  STAND_MAX_RANGE_M,
} from './stands.js';

describe('hunt stand planning', () => {
  const size = 41;
  const metres = 10;
  const centre = 20;

  function plan(
    over: {
      screen?: (x: number, y: number) => number;
      terrain?: (x: number, y: number) => number;
    } = {},
  ) {
    const habitat = createGrid(size, size, metres, 0);
    // Strong holding cover 100 m east of the candidate stand.
    habitat.data[centre * size + centre + 10] = 1;
    return huntStandPlan(
      {
        habitat,
        terrain: gridOf(size, size, metres, over.terrain ?? (() => 100)),
        screenHeightM: gridOf(size, size, metres, over.screen ?? (() => 0)),
        standable: maskOf(size, size, metres, () => true),
      },
      { sampleStride: 1 },
    );
  }

  it('pairs a stand with visible habitat inside a 150 m lane', () => {
    const result = plan();
    const i = centre * size + centre;
    expect(result.lanes.e.data[i]).toBeCloseTo(1);
    expect(result.aims.e.data[i] * STAND_MAX_RANGE_M).toBeCloseTo(100);
    expect(result.pairs.e.data[i]).toBeCloseTo(1);
    expect(result.score.data[i]).toBeGreaterThan(0.8);
    expect(STAND_DIRECTIONS.map((d) => d.key)).toEqual([
      'n',
      'ne',
      'e',
      'se',
      's',
      'sw',
      'w',
      'nw',
    ]);
  });

  it('lets canopy close the lane before habitat rather than seeing through it', () => {
    const result = plan({ screen: (x, y) => (y === centre && x === centre + 5 ? 12 : 0) });
    const i = centre * size + centre;
    expect(result.lanes.e.data[i] * STAND_MAX_RANGE_M).toBeLessThan(100);
    expect(result.pairs.e.data[i]).toBe(0);
  });

  it('treats unread canopy as closed instead of inventing an open lane', () => {
    const result = plan({
      screen: (x, y) => (y === centre && x === centre + 5 ? Number.NaN : 0),
    });
    expect(result.pairs.e.data[centre * size + centre]).toBe(0);
  });

  it('records whether the stand is above or below its surroundings', () => {
    const result = plan({
      terrain: (x, y) => 100 + Math.max(0, 12 - Math.hypot(x - centre, y - centre)),
    });
    const encoded = result.vantage.data[centre * size + centre]!;
    expect(decodeStandVantage(encoded)).toBeGreaterThan(5);
  });

  it('lets a rut tactic prefer close calling cover over a long field-edge view', () => {
    const habitat = createGrid(size, size, metres, 0);
    habitat.data[centre * size + centre + 4] = 1;
    habitat.data[centre * size + centre + 12] = 1;
    const inputs = {
      habitat,
      terrain: gridOf(size, size, metres, () => 100),
      screenHeightM: gridOf(size, size, metres, () => 0),
      standable: maskOf(size, size, metres, () => true),
    };
    const regular = huntStandPlan(inputs, { sampleStride: 1 });
    const rut = huntStandPlan(inputs, {
      sampleStride: 1,
      distanceBandM: { min: 10, peakMin: 20, peakMax: 60, max: 150 },
    });
    const i = centre * size + centre;
    expect(regular.aims.e.data[i]! * STAND_MAX_RANGE_M).toBeCloseTo(120);
    expect(rut.aims.e.data[i]! * STAND_MAX_RANGE_M).toBeCloseTo(40);
  });
});
