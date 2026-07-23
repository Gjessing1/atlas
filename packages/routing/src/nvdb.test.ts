import { describe, expect, it } from 'vitest';

import type { RouteEnrichment } from './enrich.js';
import {
  applyNvdbSpeedLimits,
  nvdbSpeedOverrides,
  type NvdbSpeedSegment,
  type SpeedLimitOverride,
} from './nvdb.js';

/**
 * A north-going route of `n` vertices, ~111 m apart (0.001° latitude), on the
 * meridian 10°E — the same convention as enrich.test.ts so distances are easy
 * to reason about (segment i→i+1 ≈ 111 m).
 */
function route(n: number, lng = 10) {
  return Array.from({ length: n }, (_, i) => ({ lat: 60 + i * 0.001, lng }));
}

/** An NVDB stretch tracing the route between two vertex indices, offset sideways. */
function stretch(
  fromIdx: number,
  toIdx: number,
  limitKph: number,
  lngOffset = 0,
): NvdbSpeedSegment {
  return {
    limitKph,
    points: route(toIdx + 1)
      .slice(fromIdx, toIdx + 1)
      .map((p) => ({ ...p, lng: p.lng + lngOffset })),
  };
}

describe('nvdbSpeedOverrides', () => {
  it('returns nothing without segments or with a degenerate route', () => {
    expect(nvdbSpeedOverrides(route(5), [])).toEqual([]);
    expect(nvdbSpeedOverrides(route(1), [stretch(0, 4, 80)])).toEqual([]);
  });

  it('covers the matched span with the stretch limit', () => {
    const overrides = nvdbSpeedOverrides(route(11), [stretch(0, 10, 80)]);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.limitKph).toBe(80);
    expect(overrides[0]!.startM).toBeCloseTo(0, 0);
    // 10 edges × ~111 m.
    expect(overrides[0]!.endM).toBeGreaterThan(1100);
    expect(overrides[0]!.endM).toBeLessThan(1120);
  });

  it('splits into runs where the limit changes along the route', () => {
    const overrides = nvdbSpeedOverrides(route(11), [stretch(0, 5, 60), stretch(5, 10, 90)]);
    expect(overrides.map((o) => o.limitKph)).toEqual([60, 90]);
    // The two runs meet, with no gap and no overlap.
    expect(overrides[0]!.endM).toBeCloseTo(overrides[1]!.startM, 3);
  });

  it('leaves a gap where no stretch is near', () => {
    // A stretch over the first half only; the rest of the route is bare.
    const overrides = nvdbSpeedOverrides(route(11), [stretch(0, 4, 70)]);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.limitKph).toBe(70);
    // Ends around vertex 4 (~444 m), not the whole route.
    expect(overrides[0]!.endM).toBeLessThan(600);
  });

  it('ignores a stretch beyond the tolerance (a parallel carriageway)', () => {
    // ~0.002° east ≈ 110 m sideways — well outside the 15 m default.
    expect(nvdbSpeedOverrides(route(11), [stretch(0, 10, 80, 0.002)])).toEqual([]);
    // …but a generous tolerance would pick it up.
    expect(
      nvdbSpeedOverrides(route(11), [stretch(0, 10, 80, 0.002)], { toleranceM: 200 }),
    ).toHaveLength(1);
  });

  it('picks the nearer stretch when two overlap', () => {
    const near = stretch(0, 10, 50, 0.00005); // ~3 m east
    const far = stretch(0, 10, 90, 0.0001); // ~6 m east
    const overrides = nvdbSpeedOverrides(route(11), [far, near]);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.limitKph).toBe(50);
  });
});

describe('applyNvdbSpeedLimits', () => {
  const base: RouteEnrichment = {
    segments: [
      { startM: 0, endM: 500, speedLimitKph: 50, roadClass: 'primary', name: 'Ring 3' },
      { startM: 500, endM: 1000, speedLimitKph: 50, tunnel: true, name: 'Ring 3' },
    ],
  };

  it('returns the base unchanged when there are no overrides', () => {
    expect(applyNvdbSpeedLimits(base, [])).toBe(base);
  });

  it('overrides the limit inside a range but keeps other attributes', () => {
    const overrides: SpeedLimitOverride[] = [{ startM: 0, endM: 500, limitKph: 60 }];
    const out = applyNvdbSpeedLimits(base, overrides);
    const first = out.segments.find((s) => s.startM === 0)!;
    expect(first.speedLimitKph).toBe(60);
    expect(first.roadClass).toBe('primary');
    // The untouched second half keeps 50 and its tunnel flag.
    const tunnelSeg = out.segments.find((s) => s.tunnel)!;
    expect(tunnelSeg.speedLimitKph).toBe(50);
    expect(tunnelSeg.endM).toBe(1000);
  });

  it('splits a base segment where the override only covers part of it', () => {
    const out = applyNvdbSpeedLimits(base, [{ startM: 0, endM: 200, limitKph: 30 }]);
    const seg30 = out.segments.find((s) => s.speedLimitKph === 30)!;
    expect(seg30.startM).toBe(0);
    expect(seg30.endM).toBe(200);
    // The remainder of the first base segment keeps its original 50.
    const rest = out.segments.find((s) => s.startM === 200)!;
    expect(rest.speedLimitKph).toBe(50);
    expect(rest.endM).toBe(500);
    expect(rest.roadClass).toBe('primary');
  });

  it('adds a speed-only segment where NVDB extends past the base enrichment', () => {
    const out = applyNvdbSpeedLimits(base, [{ startM: 1000, endM: 1500, limitKph: 80 }]);
    const extra = out.segments.find((s) => s.startM === 1000)!;
    expect(extra.speedLimitKph).toBe(80);
    expect(extra.endM).toBe(1500);
    // No invented road-class/tunnel data on an NVDB-only stretch.
    expect(extra.roadClass).toBeUndefined();
    expect(extra.tunnel).toBeUndefined();
  });

  it('coalesces adjacent ranges the override makes identical', () => {
    // Both base halves share name "Ring 3"; forcing the tunnel half's limit to
    // 50 and dropping its tunnel flag would merge — but the tunnel flag stays,
    // so they must not merge. A same-attribute case: override both to 50 over a
    // segment boundary that otherwise matches.
    const flat: RouteEnrichment = {
      segments: [
        { startM: 0, endM: 500, speedLimitKph: 40, name: 'A' },
        { startM: 500, endM: 1000, speedLimitKph: 50, name: 'A' },
      ],
    };
    const out = applyNvdbSpeedLimits(flat, [{ startM: 0, endM: 1000, limitKph: 70 }]);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]).toMatchObject({ startM: 0, endM: 1000, speedLimitKph: 70, name: 'A' });
  });
});
