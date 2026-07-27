import { describe, expect, it } from 'vitest';
import {
  applyMask,
  burnPolyline,
  burnPolylineValue,
  combine,
  createGrid,
  createMask,
  distanceTransform,
  fillNearest,
  fillRings,
  focalFraction,
  focalMean,
  gridOf,
  gridQuantile,
  gridStats,
  idw,
  localMaxima,
  maskOf,
  maxOf,
  minOf,
  percentileRank,
  aspectDegrees,
  slopeDegrees,
  slopePercent,
  valueAt,
} from './index.js';
import type { Grid } from './index.js';

const NODATA = Number.NaN;

function values(grid: Grid): number[] {
  return Array.from(grid.data);
}

describe('grid basics', () => {
  it('defaults to nodata and reads out of bounds as nodata', () => {
    const g = createGrid(3, 2, 10);
    expect(Number.isNaN(g.data[0]!)).toBe(true);
    expect(Number.isNaN(valueAt(g, -1, 0))).toBe(true);
    expect(Number.isNaN(valueAt(g, 3, 0))).toBe(true);
  });

  it('reports stats over valid cells only', () => {
    const g = gridOf(2, 2, 10, (x, y) => (x === 0 && y === 0 ? NODATA : x + y));
    const stats = gridStats(g);
    expect(stats.count).toBe(3);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(2);
    expect(stats.mean).toBeCloseTo((1 + 1 + 2) / 3, 10);
  });

  it('maxOf ignores nodata but keeps it where every input is missing', () => {
    const a = gridOf(2, 1, 10, (x) => (x === 0 ? 3 : NODATA));
    const b = gridOf(2, 1, 10, () => NODATA);
    const out = maxOf(a, b);
    expect(out.data[0]).toBe(3);
    expect(Number.isNaN(out.data[1]!)).toBe(true);
    expect(minOf(a, b).data[0]).toBe(3);
  });

  it('refuses to mix rasters of different shapes', () => {
    const a = createGrid(2, 2, 10);
    const b = createGrid(3, 2, 10);
    expect(() => maxOf(a, b)).toThrow(/size mismatch/);
    const c = createGrid(2, 2, 20);
    expect(() => maxOf(a, c)).toThrow(/cell size mismatch/);
  });
});

describe('slope and aspect', () => {
  it('measures a constant grade in percent and degrees', () => {
    // 10 % grade: 1 m rise over a 10 m cell, running east.
    const g = gridOf(5, 5, 10, (x) => x * 1);
    expect(slopePercent(g).data[2 * 5 + 2]).toBeCloseTo(10, 6);
    expect(slopeDegrees(g).data[2 * 5 + 2]).toBeCloseTo((Math.atan(0.1) * 180) / Math.PI, 6);
  });

  it('is flat on a flat surface', () => {
    const g = gridOf(5, 5, 10, () => 42);
    expect(slopePercent(g).data[12]).toBe(0);
    expect(Number.isNaN(aspectDegrees(g).data[12]!)).toBe(true);
  });

  it('faces the downhill compass direction', () => {
    // Descending toward the south: elevation grows northward (small y).
    const southFacing = gridOf(5, 5, 10, (_x, y) => -y * 2);
    expect(aspectDegrees(southFacing).data[12]).toBeCloseTo(180, 4);
    // Descending toward the east.
    const eastFacing = gridOf(5, 5, 10, (x) => -x * 2);
    expect(aspectDegrees(eastFacing).data[12]).toBeCloseTo(90, 4);
  });

  it('keeps nodata at the centre but survives a nodata neighbour', () => {
    const g = gridOf(5, 5, 10, (x, y) => (x === 0 && y === 0 ? NODATA : x));
    const slope = slopePercent(g);
    expect(Number.isNaN(slope.data[0]!)).toBe(true);
    expect(slope.data[2 * 5 + 2]).toBeCloseTo(10, 6);
  });
});

describe('distance transform', () => {
  it('measures exact euclidean distance in metres', () => {
    const mask = maskOf(5, 5, 10, (x, y) => x === 0 && y === 0);
    const { distanceM, nearest } = distanceTransform(mask);
    expect(distanceM.data[0]).toBe(0);
    expect(distanceM.data[4]).toBeCloseTo(40, 6);
    expect(distanceM.data[4 * 5 + 3]).toBeCloseTo(Math.hypot(3, 4) * 10, 5);
    expect(nearest[4 * 5 + 3]).toBe(0);
  });

  it('agrees with a brute-force scan on a scattered mask', () => {
    const w = 24;
    const h = 19;
    const sources: [number, number][] = [
      [3, 4],
      [17, 2],
      [9, 15],
      [22, 18],
    ];
    const mask = maskOf(w, h, 5, (x, y) => sources.some(([sx, sy]) => sx === x && sy === y));
    const { distanceM } = distanceTransform(mask);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const brute = Math.min(...sources.map(([sx, sy]) => Math.hypot(sx - x, sy - y))) * 5;
        expect(distanceM.data[y * w + x]).toBeCloseTo(brute, 4);
      }
    }
  });

  it('returns infinity and no source for an empty mask', () => {
    const { distanceM, nearest } = distanceTransform(createMask(4, 4, 10));
    expect(distanceM.data[0]).toBe(Number.POSITIVE_INFINITY);
    expect(nearest[0]).toBe(-1);
  });
});

describe('fillNearest', () => {
  it('fills holes from the nearest measured cell', () => {
    const g = gridOf(5, 1, 10, (x) => (x === 0 ? 5 : x === 4 ? 9 : NODATA));
    expect(values(fillNearest(g))).toEqual([5, 5, 5, 9, 9]);
  });

  it('leaves an entirely empty grid empty', () => {
    const filled = fillNearest(createGrid(3, 3, 10));
    expect(filled.data.every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe('focal mean', () => {
  it('averages a window and clamps at the edges', () => {
    const g = gridOf(5, 1, 10, (x) => x);
    const out = focalMean(g, 1);
    // Edges see a truncated window: (0+1)/2 and (3+4)/2.
    expect(values(out)).toEqual([0.5, 1, 2, 3, 3.5]);
  });

  it('skips nodata rather than counting it as zero', () => {
    const g = gridOf(3, 1, 10, (x) => (x === 1 ? NODATA : 10));
    expect(values(focalMean(g, 1))).toEqual([10, 10, 10]);
  });

  it('is nodata only where the whole window is', () => {
    const g = createGrid(3, 3, 10);
    expect(focalMean(g, 1).data.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('reads a mask as a coverage fraction', () => {
    const mask = maskOf(3, 3, 10, (x) => x === 0);
    // Centre column sees 3 set of 9 cells.
    expect(focalFraction(mask, 1).data[4]).toBeCloseTo(3 / 9, 6);
  });
});

describe('burn', () => {
  it('rasterises a polyline into a mask', () => {
    const mask = createMask(5, 5, 10);
    burnPolyline(mask, [
      [0, 0],
      [4, 0],
      [4, 4],
    ]);
    expect(Array.from(mask.data.slice(0, 5))).toEqual([1, 1, 1, 1, 1]);
    expect(mask.data[4 * 5 + 4]).toBe(1);
    expect(mask.data[2 * 5 + 0]).toBe(0);
  });

  it('burns a contour value into a grid and ignores out-of-bounds', () => {
    const g = createGrid(5, 5, 10);
    burnPolylineValue(
      g,
      [
        [-3, 2],
        [7, 2],
      ],
      12.5,
    );
    expect(Array.from(g.data.slice(10, 15))).toEqual([12.5, 12.5, 12.5, 12.5, 12.5]);
  });
});

describe('fillRings', () => {
  /** Set cells of a row, as a string, so a filled shape reads at a glance. */
  const row = (mask: ReturnType<typeof createMask>, y: number): string =>
    Array.from(mask.data.slice(y * mask.width, (y + 1) * mask.width))
      .map((v) => (v === 1 ? '#' : '.'))
      .join('');

  it('fills a ring interior, not just its outline', () => {
    const mask = createMask(6, 6, 10);
    fillRings(mask, [
      [
        [1, 1],
        [5, 1],
        [5, 5],
        [1, 5],
      ],
    ]);
    expect(row(mask, 0)).toBe('......');
    expect(row(mask, 2)).toBe('.####.');
    expect(row(mask, 4)).toBe('.####.');
    expect(row(mask, 5)).toBe('......');
  });

  it('punches islands out under the even-odd rule, whatever the winding', () => {
    const island: [number, number][] = [
      [3, 3],
      [6, 3],
      [6, 6],
      [3, 6],
    ];
    for (const inner of [island, [...island].reverse()]) {
      const mask = createMask(10, 10, 10);
      fillRings(mask, [
        [
          [1, 1],
          [8, 1],
          [8, 8],
          [1, 8],
        ],
        inner,
      ]);
      expect(row(mask, 2)).toBe('.#######..');
      expect(row(mask, 4)).toBe('.##...##..');
    }
  });

  it('fills the visible part of a lake that continues past the raster', () => {
    const mask = createMask(4, 4, 10);
    fillRings(mask, [
      [
        [-5, -5],
        [2, -5],
        [2, 2],
        [-5, 2],
      ],
    ]);
    expect(row(mask, 0)).toBe('##..');
    expect(row(mask, 1)).toBe('##..');
    expect(row(mask, 3)).toBe('....');
  });

  it('counts a shared vertex once, so a concave outline does not leak', () => {
    // A bay cut into the top edge: its mouth is wide, it narrows with depth,
    // and it closes at the apex. Every row is a separate chance for the two
    // sloped edges — which meet at a vertex the scanline passes exactly — to be
    // counted twice or not at all, either of which floods or empties the row.
    const mask = createMask(7, 6, 10);
    fillRings(mask, [
      [
        [0, 0],
        [2, 0],
        [3.5, 3],
        [5, 0],
        [7, 0],
        [7, 5],
        [0, 5],
      ],
    ]);
    expect(row(mask, 0)).toBe('##...##');
    expect(row(mask, 1)).toBe('###.###');
    expect(row(mask, 3)).toBe('#######');
  });

  it('ignores degenerate rings rather than throwing', () => {
    const mask = createMask(4, 4, 10);
    fillRings(mask, [
      [],
      [[1, 1]],
      [
        [1, 1],
        [2, 2],
      ],
    ]);
    expect(Array.from(mask.data).every((v) => v === 0)).toBe(true);
  });
});

describe('idw', () => {
  it('returns the sample value exactly at a sample', () => {
    const g = idw(5, 5, 10, [{ x: 2, y: 2, value: 7 }], { searchRadiusCells: 5 });
    expect(g.data[2 * 5 + 2]).toBeCloseTo(7, 10);
  });

  it('weights nearer samples harder', () => {
    const g = idw(
      9,
      1,
      10,
      [
        { x: 0, y: 0, value: 0 },
        { x: 8, y: 0, value: 8 },
      ],
      { searchRadiusCells: 5 },
    );
    expect(g.data[4]).toBeCloseTo(4, 6); // equidistant from both
    expect(g.data[3]).toBeGreaterThan(0); // sees both, but leans on the near one
    expect(g.data[3]).toBeLessThan(4);
  });

  it('leaves cells with no sample in range unmeasured, not zero', () => {
    const g = idw(9, 1, 10, [{ x: 0, y: 0, value: 5 }], { searchRadiusCells: 2 });
    expect(g.data[1]).toBeCloseTo(5, 6);
    expect(Number.isNaN(g.data[8]!)).toBe(true);
  });
});

describe('combine', () => {
  it('renormalises per pixel so a missing input costs nothing', () => {
    const a = gridOf(2, 1, 10, () => 1);
    const b = gridOf(2, 1, 10, (x) => (x === 0 ? 0 : NODATA));
    const out = combine([
      { key: 'a', label: 'A', weight: 1, grid: a },
      { key: 'b', label: 'B', weight: 1, grid: b },
    ]);
    expect(out.data[0]).toBeCloseTo(0.5, 10); // both present
    expect(out.data[1]).toBeCloseTo(1, 10); // only A — B is unknown, not bad
  });

  it('is nodata where every term is missing', () => {
    const out = combine([{ key: 'a', label: 'A', weight: 1, grid: createGrid(2, 1, 10) }]);
    expect(Number.isNaN(out.data[0]!)).toBe(true);
  });

  it('rejects non-positive weights', () => {
    const g = gridOf(2, 1, 10, () => 1);
    expect(() => combine([{ key: 'a', label: 'A', weight: 0, grid: g }])).toThrow(/positive/);
    expect(() => combine([{ key: 'a', label: 'A', weight: -1, grid: g }])).toThrow(/positive/);
  });
});

describe('quantiles and percentile rank', () => {
  it('finds a median and an upper quantile', () => {
    const g = gridOf(101, 1, 10, (x) => x / 100);
    expect(gridQuantile(g, 0.5)).toBeCloseTo(0.5, 2);
    expect(gridQuantile(g, 0.95)).toBeCloseTo(0.95, 2);
  });

  it('ranks a ramp roughly onto itself and keeps nodata out', () => {
    const g = gridOf(100, 1, 10, (x) => (x === 0 ? NODATA : x));
    const rank = percentileRank(g);
    expect(Number.isNaN(rank.data[0]!)).toBe(true);
    expect(rank.data[1]).toBeLessThan(0.05);
    expect(rank.data[99]).toBeGreaterThan(0.95);
  });

  it('ranks a featureless surface flat at the middle, never 0..1', () => {
    const rank = percentileRank(gridOf(20, 20, 10, () => 0.4));
    for (const v of rank.data) expect(v).toBeCloseTo(0.5, 10);
  });
});

describe('localMaxima', () => {
  it('thins neighbouring peaks down to one per separation radius', () => {
    const g = gridOf(21, 1, 10, (x) => 1 - Math.abs(x - 10) / 10);
    const peaks = localMaxima(g, { minSeparationCells: 3 });
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.x).toBe(10);
  });

  it('puts a spot in the middle of a plateau, not on its corners', () => {
    // A saturated signal maxes out across a whole area. Reporting each cell of
    // it — or its corners — is the wrong answer; the middle is the place to go.
    const g = gridOf(21, 21, 10, (x, y) =>
      Math.abs(x - 10) <= 4 && Math.abs(y - 10) <= 4 ? 1 : 0,
    );
    const peaks = localMaxima(g, { minSeparationCells: 2, minValue: 0.5 });
    expect(peaks).toHaveLength(1);
    expect(peaks[0]).toMatchObject({ x: 10, y: 10 });
  });

  it('honours the value floor and the limit', () => {
    const g = gridOf(9, 9, 10, (x, y) => (x === 2 && y === 2 ? 1 : x === 6 && y === 6 ? 0.4 : 0));
    expect(localMaxima(g, { minSeparationCells: 2, minValue: 0.5 })).toHaveLength(1);
    expect(localMaxima(g, { minSeparationCells: 2, limit: 1 })).toHaveLength(1);
  });
});

describe('applyMask', () => {
  it('gates a grid to the mask, leaving the rest unknown', () => {
    const g = gridOf(3, 1, 10, () => 1);
    const mask = maskOf(3, 1, 10, (x) => x === 1);
    const out = applyMask(g, mask);
    expect(Number.isNaN(out.data[0]!)).toBe(true);
    expect(out.data[1]).toBe(1);
  });
});
