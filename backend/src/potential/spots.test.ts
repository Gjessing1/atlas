import type { LatLng } from '@atlas/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellManifest } from './derive.js';
import { assessHuntApproach, walkAccess } from './spots.js';

const PIXELS = 256;
const PLANE_BYTES = PIXELS * PIXELS;

function approachSurface(coverColumns: readonly number[]) {
  const manifest = {
    bounds: [10, 59, 10.18, 59.1],
    signals: {
      pixels: PIXELS,
      planes: ['rank', 'cover-young', 'cover-mature'],
      terms: [
        { key: 'cover-young', label: 'Young cover', weight: 1 },
        { key: 'cover-mature', label: 'Mature cover', weight: 1 },
      ],
    },
  } as CellManifest;
  const blob = Buffer.alloc(PLANE_BYTES * 3, 255);
  // The whole synthetic route is upper-quartile habitat.
  blob.fill(254, 0, PLANE_BYTES);
  // Measured open cover (zero), except for the requested strong-cover columns.
  blob.fill(0, PLANE_BYTES, PLANE_BYTES * 2);
  for (let y = 0; y < PIXELS; y++) {
    for (const x of coverColumns) blob[PLANE_BYTES + y * PIXELS + x] = 254;
  }
  return { manifest, blob };
}

function atSample(x: number): LatLng {
  return { lat: 59.05, lng: 10 + ((x + 0.5) / PIXELS) * 0.18 };
}

describe('hunt walk-in disturbance', () => {
  const path = [atSample(100), atSample(115)];

  it('calls a short crossing of strong habitat and cover a caution', () => {
    const assessment = assessHuntApproach(path, [approachSurface([104, 105])]);
    expect(assessment?.risk).toBe('caution');
    expect(assessment!.holdingCoverM).toBeGreaterThanOrEqual(40);
    expect(assessment!.holdingCoverM).toBeLessThan(100);
  });

  it('calls a sustained crossing high risk, but not open habitat', () => {
    const covered = assessHuntApproach(path, [
      approachSurface(Array.from({ length: 16 }, (_, x) => 100 + x)),
    ]);
    expect(covered?.risk).toBe('high');
    expect(covered!.holdingCoverM).toBeGreaterThan(100);

    const open = assessHuntApproach(path, [approachSurface([])]);
    expect(open).toMatchObject({ risk: 'clear', holdingCoverM: 0 });
  });

  it('declines when too little of the route has derived cover data', () => {
    expect(assessHuntApproach([atSample(-20), atSample(-10)], [approachSurface([])])).toBeNull();
  });
});

/** Minimal precision-6 encoder for the Valhalla route fixture. */
function encode(points: readonly LatLng[]): string {
  let previousLat = 0;
  let previousLng = 0;
  let out = '';
  const part = (delta: number) => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    while (value >= 0x20) {
      out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    out += String.fromCharCode(value + 63);
  };
  for (const point of points) {
    const lat = Math.round(point.lat * 1e6);
    const lng = Math.round(point.lng * 1e6);
    part(lat - previousLat);
    part(lng - previousLng);
    previousLat = lat;
    previousLng = lng;
  }
  return out;
}

describe('walkAccess route geometry', () => {
  const road = { lat: 59, lng: 10 };
  const stand = { lat: 59, lng: 10.01 };
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/locate') {
        return Response.json([{ edges: [{ correlated_lat: road.lat, correlated_lon: road.lng }] }]);
      }
      if (path === '/sources_to_targets') {
        const body = JSON.parse(String(init?.body)) as { shape_format?: string };
        expect(body.shape_format).toBe('polyline6');
        return Response.json({ sources_to_targets: [[{ distance: 0.75, time: 640 }]] });
      }
      if (path === '/route') {
        return Response.json({ trip: { legs: [{ shape: encode([road, stand]) }] } });
      }
      throw new Error(`unexpected route ${path}`);
    });
  });

  it('asks for the reachable path and attaches its habitat assessment', async () => {
    const assessApproach = vi.fn(() => ({
      risk: 'high' as const,
      basis: 'mapped-route' as const,
      holdingCoverM: 180,
      assessedM: 720,
    }));
    const result = await walkAccess([stand], {
      valhallaUrl: 'http://router.test',
      fetchImpl,
      assessApproach,
    });
    expect(result?.[0]).toMatchObject({
      approximate: false,
      approach: { risk: 'high', holdingCoverM: 180 },
    });
    expect(assessApproach).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('scores a snapped fallback as a clearly identified direct off-path line', async () => {
    fetchImpl.mockImplementation(async (input: URL | RequestInfo) => {
      const path = new URL(String(input)).pathname;
      if (path === '/locate') {
        return Response.json([{ edges: [{ correlated_lat: road.lat, correlated_lon: road.lng }] }]);
      }
      return Response.json({ sources_to_targets: [[{ distance: 0.02, time: 15 }]] });
    });
    const assessApproach = vi.fn(() => ({
      risk: 'clear' as const,
      basis: 'direct-line' as const,
      holdingCoverM: 0,
      assessedM: 540,
    }));
    const result = await walkAccess([stand], {
      valhallaUrl: 'http://router.test',
      fetchImpl,
      assessApproach,
    });
    expect(result?.[0]).toMatchObject({
      approximate: true,
      approach: { risk: 'clear', basis: 'direct-line' },
    });
    expect(assessApproach).toHaveBeenCalledWith([road, stand], 0, 'direct-line');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
