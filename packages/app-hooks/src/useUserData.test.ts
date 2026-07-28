import { parseGpx } from '@atlas/gpx';
import { describe, expect, it } from 'vitest';
import { permitTrackInput } from './useUserData.js';

describe('permitTrackInput', () => {
  it('keeps the exact filled topology while retaining every ring in GPX export', () => {
    const area = {
      offerId: '0123456789abcdef01234567',
      name: 'Nordmarka',
      bbox: [10, 60, 11, 61] as [number, number, number, number],
      polygons: [
        [
          [
            [10, 60],
            [11, 60],
            [11, 61],
            [10, 60],
          ],
          [
            [10.2, 60.2],
            [10.3, 60.2],
            [10.2, 60.2],
          ],
        ],
      ] as [number, number][][][],
      rings: [
        [
          [10, 60],
          [11, 60],
          [11, 61],
          [10, 60],
        ],
        [
          [10.2, 60.2],
          [10.3, 60.2],
          [10.2, 60.2],
        ],
      ] as [number, number][][],
      subAreas: 1,
    };

    const { data, input } = permitTrackInput(area, 'permits');
    expect(input).toMatchObject({
      name: 'iNatur – Nordmarka',
      collectionId: 'permits',
      tags: ['iNatur permit'],
      area: {
        kind: 'area',
        source: 'inatur',
        sourceId: area.offerId,
        polygons: area.polygons,
        bbox: area.bbox,
      },
    });
    expect(data.segments).toHaveLength(2);
    expect(parseGpx(input.gpx).segments).toHaveLength(2);
  });
});
