import type { TrackData } from '@atlas/gpx';
import type { TrackRecord } from '@atlas/storage';
import { describe, expect, it } from 'vitest';

import { planningArea } from './usePlanningAreas.js';

const track = (over: Partial<TrackRecord> = {}): TrackRecord => ({
  id: 'sleikebekk',
  name: 'iNatur – Delområde Sleikebekk',
  stats: {},
  collectionId: 'permits',
  notes: '',
  tags: ['iNatur permit'],
  visible: true,
  area: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const data: TrackData = {
  name: 'Sleikebekk',
  waypoints: [],
  segments: [
    [
      { lat: 59.58, lng: 9.55 },
      { lat: 59.6, lng: 9.55 },
      { lat: 59.6, lng: 9.61 },
      { lat: 59.58, lng: 9.55 },
    ],
  ],
};

describe('planningArea', () => {
  it('recovers a legacy iNatur boundary from its closed GPX', () => {
    const area = planningArea(track(), data)!;
    expect(area.bbox).toEqual([9.55, 59.58, 9.61, 59.6]);
    expect(area.polygons[0]![0]).toHaveLength(4);
  });

  it('uses exact stored topology when a newer save has it', () => {
    const polygons = [
      [
        [
          [9, 59],
          [10, 59],
          [9, 59],
        ],
      ],
    ] as [number, number][][][];
    expect(
      planningArea(
        track({
          area: { kind: 'area', source: 'inatur', sourceId: 'x', bbox: [9, 59, 10, 60], polygons },
        }),
        null,
      )!.polygons,
    ).toBe(polygons);
  });

  it('does not reinterpret an ordinary visible route as a permit', () => {
    expect(planningArea(track({ name: 'Sunday walk', tags: [] }), data)).toBeNull();
  });
});
