import { describe, expect, it } from 'vitest';

import { cumulativeDistances } from './geometry.js';
import { remainingElevationProfile } from './elevation.js';

const route = [
  { lat: 60, lng: 10, ele: 100 },
  { lat: 60.001, lng: 10, ele: 140 },
  { lat: 60.002, lng: 10, ele: 120 },
  { lat: 60.003, lng: 10, ele: 170 },
];

describe('remainingElevationProfile', () => {
  it('starts at an interpolated current elevation and rebases remaining distance', () => {
    const distances = cumulativeDistances(route);
    const halfway = distances[1]! + (distances[2]! - distances[1]!) / 2;
    const profile = remainingElevationProfile(route, halfway);

    expect(profile[0]!.distanceM).toBe(0);
    expect(profile[0]!.elevationM).toBeCloseTo(130, 5);
    expect(profile[1]!.elevationM).toBe(120);
    expect(profile.at(-1)!.distanceM).toBeCloseTo(distances[3]! - halfway, 5);
    expect(profile.at(-1)!.elevationM).toBe(170);
  });

  it('shrinks to the finish and stays empty without enough elevation evidence', () => {
    expect(remainingElevationProfile(route, 1_000_000)).toEqual([]);
    expect(
      remainingElevationProfile(
        route.map(({ ele: _ele, ...point }) => point),
        0,
      ),
    ).toEqual([]);
  });

  it('downsamples while retaining the current point and finish', () => {
    const dense = Array.from({ length: 200 }, (_, index) => ({
      lat: 60 + index / 10_000,
      lng: 10,
      ele: 100 + index,
    }));
    const profile = remainingElevationProfile(dense, 0, 12);

    expect(profile).toHaveLength(12);
    expect(profile[0]!.distanceM).toBe(0);
    expect(profile[0]!.elevationM).toBe(100);
    expect(profile.at(-1)!.elevationM).toBe(299);
  });
});
