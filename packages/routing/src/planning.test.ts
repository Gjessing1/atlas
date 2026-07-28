import { describe, expect, it } from 'vitest';

import { enrichPlannedPath, routeProfileIndexes } from './planning.js';
import { routeSurfaceAt, routeSurfaceBreakdown } from './surface.js';
import type { RoutePath } from './model.js';

const path: RoutePath = {
  points: Array.from({ length: 5 }, (_, index) => ({ lat: 60 + index * 0.001, lng: 10 })),
  distanceM: 445,
  timeMs: 60_000,
  ascentM: 0,
  descentM: 0,
};

describe('planner route detail', () => {
  it('samples the original shape without dropping its endpoints', () => {
    expect(routeProfileIndexes(10, 4)).toEqual([0, 3, 6, 9]);
    expect(routeProfileIndexes(3, 10)).toEqual([0, 1, 2]);
  });

  it('annotates sampled elevations and per-edge surfaces', async () => {
    const detailed = await enrichPlannedPath(
      path,
      'bike',
      async () => ({
        edges: [
          { begin_shape_index: 0, end_shape_index: 2, surface: 'paved_smooth' },
          { begin_shape_index: 2, end_shape_index: 4, surface: 'gravel' },
        ],
      }),
      async (points) => points.map((_, index) => 100 + index * 10),
    );
    expect(detailed.points).toHaveLength(path.points.length);
    expect(detailed.points.map((point) => point.ele)).toEqual([100, 110, 120, 130, 140]);
    expect(detailed.ascentM).toBe(40);
    expect(detailed.enrichment?.segments.map((segment) => segment.surface)).toEqual([
      'paved_smooth',
      'gravel',
    ]);
  });
});

describe('route surface summary', () => {
  const enrichment = {
    segments: [
      { startM: 0, endM: 600, surface: 'paved_smooth' },
      { startM: 600, endM: 900, surface: 'gravel' },
    ],
  };

  it('groups route shares and accounts for unknown gaps', () => {
    expect(routeSurfaceBreakdown(enrichment, 1000)).toEqual([
      { label: 'Paved', distanceM: 600, percent: 60 },
      { label: 'Gravel', distanceM: 300, percent: 30 },
      { label: 'Unknown', distanceM: 100, percent: 10 },
    ]);
    expect(routeSurfaceAt(enrichment, 700)).toBe('Gravel');
  });
});
