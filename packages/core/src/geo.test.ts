import { describe, expect, it } from 'vitest';
import {
  bboxContains,
  circleFeature,
  destinationPoint,
  haversineM,
  markerScaleForZoom,
  metersPerPixel,
  pathLengthM,
  scaleBarFor,
  type BBox,
  type LatLng,
} from './index.js';

const oslo: LatLng = { lat: 59.91, lng: 10.75 };

describe('bboxContains', () => {
  const norway: BBox = { sw: { lat: 57.9, lng: 4.5 }, ne: { lat: 71.2, lng: 31.2 } };

  it('contains a point inside', () => {
    expect(bboxContains(norway, { lat: 59.91, lng: 10.75 })).toBe(true); // Oslo
  });

  it('excludes a point outside', () => {
    expect(bboxContains(norway, { lat: 48.85, lng: 2.35 })).toBe(false); // Paris
  });

  it('includes the boundary', () => {
    expect(bboxContains(norway, { lat: 57.9, lng: 4.5 })).toBe(true);
  });
});

describe('pathLengthM', () => {
  it('is zero for fewer than two points', () => {
    expect(pathLengthM([])).toBe(0);
    expect(pathLengthM([oslo])).toBe(0);
  });

  it('sums the segments of a polyline', () => {
    const b = { lat: 59.92, lng: 10.75 };
    const c = { lat: 59.92, lng: 10.77 };
    const expected = haversineM(oslo, b) + haversineM(b, c);
    expect(pathLengthM([oslo, b, c])).toBeCloseTo(expected, 6);
  });
});

describe('destinationPoint', () => {
  it('lands the requested distance away', () => {
    const p = destinationPoint(oslo, 90, 1000);
    expect(haversineM(oslo, p)).toBeCloseTo(1000, 1);
  });

  it('heads north / east in the right direction', () => {
    expect(destinationPoint(oslo, 0, 500).lat).toBeGreaterThan(oslo.lat);
    expect(destinationPoint(oslo, 90, 500).lng).toBeGreaterThan(oslo.lng);
    expect(destinationPoint(oslo, 180, 500).lat).toBeLessThan(oslo.lat);
    expect(destinationPoint(oslo, 270, 500).lng).toBeLessThan(oslo.lng);
  });
});

describe('circleFeature', () => {
  it('is a closed polygon of the requested resolution', () => {
    const f = circleFeature(oslo, 200, { radiusM: 200 }, 32);
    const ring = f.geometry.coordinates[0]!;
    expect(ring).toHaveLength(33); // steps + closing vertex
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(f.properties).toEqual({ radiusM: 200 });
  });

  it('keeps every vertex ~radius from the centre', () => {
    const f = circleFeature(oslo, 150, {}, 16);
    for (const [lng, lat] of f.geometry.coordinates[0]!.slice(0, -1)) {
      expect(haversineM(oslo, { lat: lat!, lng: lng! })).toBeCloseTo(150, 0);
    }
  });
});

describe('markerScaleForZoom', () => {
  it('keeps full size at city zooms and clamps when far out', () => {
    expect(markerScaleForZoom(12)).toBe(1);
    expect(markerScaleForZoom(16)).toBe(1);
    expect(markerScaleForZoom(7)).toBe(0.5);
    expect(markerScaleForZoom(3)).toBe(0.5);
  });

  it('shrinks monotonically between the clamp zooms', () => {
    expect(markerScaleForZoom(9.5)).toBe(0.75);
    expect(markerScaleForZoom(11)).toBeGreaterThan(markerScaleForZoom(10));
    expect(markerScaleForZoom(10)).toBeGreaterThan(markerScaleForZoom(8));
  });
});

describe('scale bar', () => {
  it('halves the ground resolution for each zoom level', () => {
    // 512 px tiles: z14 at the equator is ~4.78 m/px, not the 256 px table's 9.55.
    expect(metersPerPixel(0, 14)).toBeCloseTo(4.777, 2);
    expect(metersPerPixel(0, 15)).toBeCloseTo(metersPerPixel(0, 14) / 2, 6);
  });

  it('shrinks the ground resolution towards the poles', () => {
    expect(metersPerPixel(60, 10)).toBeCloseTo(metersPerPixel(0, 10) * Math.cos(Math.PI / 3), 6);
  });

  it('rounds to 1/2/3/5/10 steps that fit the budget', () => {
    for (const zoom of [4, 8, 11, 14, 17]) {
      const bar = scaleBarFor(59.91, zoom, 100);
      expect(bar.widthPx).toBeLessThanOrEqual(100);
      const digits = bar.meters / Math.pow(10, Math.floor(Math.log10(bar.meters)));
      expect([1, 2, 3, 5, 10]).toContain(Math.round(digits));
    }
  });

  it('labels in km past 1000 m and never in imperial units', () => {
    expect(scaleBarFor(59.91, 6, 100).label).toMatch(/ km$/);
    expect(scaleBarFor(59.91, 18, 100).label).toMatch(/ m$/);
  });

  it('reports a width consistent with the distance it claims', () => {
    const bar = scaleBarFor(59.91, 12, 100);
    expect(bar.widthPx * metersPerPixel(59.91, 12)).toBeCloseTo(bar.meters, 6);
  });
});
