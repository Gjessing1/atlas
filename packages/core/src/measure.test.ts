import { describe, expect, it } from 'vitest';

import {
  MEASURE_DEFAULT_RADII_M,
  MEASURE_DISTANCE_HINT,
  MEASURE_RADIUS_HINT,
  fmtRadius,
  measureFeatures,
  measureHasWork,
  measureReadout,
  measureTotals,
  type MeasureState,
} from './measure.js';

const A = { lat: 59.9, lng: 10.7 };
const B = { lat: 59.91, lng: 10.7 };
const C = { lat: 59.91, lng: 10.72 };

const state = (over: Partial<MeasureState> = {}): MeasureState => ({
  mode: 'distance',
  points: [],
  centers: [],
  radii: MEASURE_DEFAULT_RADII_M,
  ...over,
});

describe('fmtRadius', () => {
  it('reads metres below a kilometre and kilometres above', () => {
    expect(fmtRadius(50)).toBe('50 m');
    expect(fmtRadius(500)).toBe('500 m');
    expect(fmtRadius(1000)).toBe('1 km');
  });
});

describe('measureTotals', () => {
  it('separates the walked length from the straight line', () => {
    const { totalM, straightM } = measureTotals([A, B, C]);
    expect(totalM).toBeGreaterThan(straightM);
    // A dog-leg: two 1.1 km-ish legs against a shorter hypotenuse.
    expect(Math.round(totalM)).toBeGreaterThan(2000);
  });

  it('has no straight line to report below two points', () => {
    expect(measureTotals([A])).toEqual({ totalM: 0, straightM: 0 });
  });
});

describe('measureReadout', () => {
  it('hints instead of stating a total while the measurement is empty', () => {
    expect(measureReadout(state()).hint).toBe(MEASURE_DISTANCE_HINT);
    expect(measureReadout(state({ mode: 'radius' })).hint).toBe(MEASURE_RADIUS_HINT);
    // One point is not yet a distance.
    expect(measureReadout(state({ points: [A] })).headline).toBeNull();
  });

  it('states the total, and the straight line only when the line bends', () => {
    const straight = measureReadout(state({ points: [A, B] }));
    expect(straight.headline).toBe('1.1 km');
    expect(straight.detail).toBeNull();

    const bent = measureReadout(state({ points: [A, B, C] }));
    expect(bent.headline).not.toBeNull();
    expect(bent.detail).toMatch(/^straight line /);
  });

  it('counts circles, singular and plural', () => {
    expect(measureReadout(state({ mode: 'radius', centers: [A] })).detail).toBe('1 circle');
    expect(measureReadout(state({ mode: 'radius', centers: [A, B] })).detail).toBe('2 circles');
  });
});

describe('measureHasWork', () => {
  it('asks about the active mode only', () => {
    expect(measureHasWork(state({ points: [A] }))).toBe(true);
    expect(measureHasWork(state({ mode: 'radius', points: [A] }))).toBe(false);
    expect(measureHasWork(state({ mode: 'radius', centers: [A] }))).toBe(true);
  });
});

describe('measureFeatures', () => {
  it('draws the line, its vertices and a running total from the second on', () => {
    const fc = measureFeatures(state({ points: [A, B, C] }));
    const kinds = fc.features.map((f) => f.properties?.['kind']);
    expect(kinds.filter((k) => k === 'path')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'point')).toHaveLength(3);
    // Labels start at the second vertex — the first has nothing to total.
    expect(kinds.filter((k) => k === 'label')).toHaveLength(2);
  });

  it('draws no line for a single point', () => {
    const fc = measureFeatures(state({ points: [A] }));
    expect(fc.features.map((f) => f.properties?.['kind'])).toEqual(['point']);
  });

  it('draws every radius around every centre, each labelled', () => {
    const fc = measureFeatures(state({ mode: 'radius', centers: [A, B], radii: [100, 200] }));
    const kinds = fc.features.map((f) => f.properties?.['kind']);
    expect(kinds.filter((k) => k === 'point')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'ring')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'label')).toHaveLength(4);
    const labels = fc.features
      .filter((f) => f.properties?.['kind'] === 'label')
      .map((f) => f.properties?.['text']);
    expect(new Set(labels)).toEqual(new Set(['100 m', '200 m']));
  });

  it('labels a ring due north of its centre, on the ring itself', () => {
    const fc = measureFeatures(state({ mode: 'radius', centers: [A], radii: [500] }));
    const label = fc.features.find((f) => f.properties?.['kind'] === 'label');
    const [lng, lat] = (label!.geometry as GeoJSON.Point).coordinates as [number, number];
    expect(lng).toBeCloseTo(A.lng, 5);
    expect(lat).toBeGreaterThan(A.lat);
  });

  it('ignores whatever the other mode collected', () => {
    const fc = measureFeatures(state({ mode: 'radius', points: [A, B], centers: [] }));
    expect(fc.features).toHaveLength(0);
  });
});
