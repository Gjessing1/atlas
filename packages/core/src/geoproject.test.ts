import { describe, expect, it } from 'vitest';

import {
  bboxToUtm33,
  polygonLabelPoint,
  snapLabelBbox,
  utm33ToWgs84,
  wgs84ToUtm33,
} from './geoproject.js';

describe('snapLabelBbox', () => {
  it('rounds outwards so the viewport stays covered', () => {
    const [w, s, e, n] = snapLabelBbox([10.3, 59.78, 10.5, 59.9]);
    expect(w).toBeLessThanOrEqual(10.3);
    expect(s).toBeLessThanOrEqual(59.78);
    expect(e).toBeGreaterThanOrEqual(10.5);
    expect(n).toBeGreaterThanOrEqual(59.9);
  });

  it('gives nearby viewports the identical key', () => {
    // The point of the grid: panning a little must not look like a new request.
    expect(snapLabelBbox([10.3, 59.78, 10.5, 59.9]).join()).toBe(
      snapLabelBbox([10.31, 59.79, 10.49, 59.89]).join(),
    );
  });

  it('leaves no float dust in the key', () => {
    for (const v of snapLabelBbox([10.3, 59.78, 10.5, 59.9])) {
      expect(String(v)).not.toMatch(/\d{6,}/);
    }
  });

  it('clamps to the Mercator limits', () => {
    const [, s, , n] = snapLabelBbox([-10, -89, 10, 89]);
    expect(s).toBeGreaterThanOrEqual(-85.25);
    expect(n).toBeLessThanOrEqual(85.25);
  });
});

describe('wgs84ToUtm33', () => {
  // Reference values read back from NVE's own service: querying
  // Innsjodatabase2 layer 4 for Verkensvannet (vatnlnr 2478) returns geometry
  // in EPSG:25833 around this easting/northing.
  it('projects a Norwegian lake to its published grid position', () => {
    const { x, y } = wgs84ToUtm33(10.36708, 59.81332);
    expect(x).toBeCloseTo(240272, -1);
    expect(y).toBeCloseTo(6639706, -1);
  });

  it('puts the central meridian on the false easting', () => {
    const { x } = wgs84ToUtm33(15, 60);
    expect(x).toBeCloseTo(500000, 3);
  });

  it('grows the northing monotonically with latitude', () => {
    const south = wgs84ToUtm33(10, 58);
    const north = wgs84ToUtm33(10, 70);
    expect(north.y).toBeGreaterThan(south.y);
  });
});

describe('utm33ToWgs84', () => {
  it('round-trips the whole Norwegian span of zone 33 to the millimetre', () => {
    // The eastern and western extremes are the point: they are 15° off the
    // central meridian, where a classic USGS inverse drifts tens of metres.
    for (const [lng, lat] of [
      [4.6, 58.9], // Rogaland, the western extreme
      [5.32, 60.39], // Bergen — a negative easting
      [10.75, 59.91], // Oslo
      [18.96, 69.65], // Tromsø
      [30.05, 69.73], // Kirkenes, the eastern extreme
    ] as const) {
      const { x, y } = wgs84ToUtm33(lng, lat);
      const back = utm33ToWgs84(x, y);
      const offM = Math.hypot(
        (back.lng - lng) * 111320 * Math.cos(lat * (Math.PI / 180)),
        (back.lat - lat) * 110540,
      );
      expect(offM).toBeLessThan(0.001);
    }
  });

  it('agrees with NVE’s own reprojection in eastern Finnmark', () => {
    // Independent reference: Innsjodatabase2 layer 5 returns lake 209007's
    // first ring vertex as (1097035.90, 7795119.83) in EPSG:25833 and as
    // (30.4755496, 69.5795068) in EPSG:4326. This is the check that caught a
    // 32 m error in the first, series-truncated inverse.
    const point = utm33ToWgs84(1097035.9, 7795119.83);
    expect(point.lng).toBeCloseTo(30.4755496, 6);
    expect(point.lat).toBeCloseTo(69.5795068, 6);
  });

  it('reads a negative easting as western Norway, not as the North Sea', () => {
    // Straight from NPRA's corridor table: the first vertex of "Åsanevegen -
    // Eikås" in Bergen. Zone 33's false easting does not keep the coordinate
    // positive that far west, and dropping the sign lands ~60 km offshore.
    const bergen = utm33ToWgs84(-30621, 6742669);
    expect(bergen.lng).toBeCloseTo(5.3264, 3);
    expect(bergen.lat).toBeCloseTo(60.4682, 3);
  });
});

describe('bboxToUtm33', () => {
  it('covers every corner, not just two of them', () => {
    const [minX, minY, maxX, maxY] = bboxToUtm33([10, 59, 11, 60]);
    for (const [lng, lat] of [
      [10, 59],
      [11, 59],
      [10, 60],
      [11, 60],
    ] as const) {
      const p = wgs84ToUtm33(lng, lat);
      expect(p.x).toBeGreaterThanOrEqual(minX);
      expect(p.x).toBeLessThanOrEqual(maxX);
      expect(p.y).toBeGreaterThanOrEqual(minY);
      expect(p.y).toBeLessThanOrEqual(maxY);
    }
  });
});

describe('polygonLabelPoint', () => {
  const square: number[][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];

  it('finds the centre of a square', () => {
    const p = polygonLabelPoint([square]);
    expect(p?.lng).toBeCloseTo(5, 9);
    expect(p?.lat).toBeCloseTo(5, 9);
  });

  it('is unmoved by extra vertices along one edge', () => {
    // The same square, but the bottom edge is densely digitised — a mean of the
    // vertices would slide the label towards it, an area centroid does not.
    const dense: number[][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
      [6, 0],
      [7, 0],
      [8, 0],
      [9, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const p = polygonLabelPoint([dense]);
    expect(p?.lng).toBeCloseTo(5, 9);
    expect(p?.lat).toBeCloseTo(5, 9);
  });

  it('ignores smaller rings (islands) and picks the largest', () => {
    const island: number[][] = [
      [100, 100],
      [101, 100],
      [101, 101],
      [100, 101],
      [100, 100],
    ];
    const p = polygonLabelPoint([island, square]);
    expect(p?.lng).toBeCloseTo(5, 9);
    expect(p?.lat).toBeCloseTo(5, 9);
  });

  it('returns null for degenerate input', () => {
    expect(polygonLabelPoint([])).toBeNull();
    expect(polygonLabelPoint([[[1, 1]]])).toBeNull();
    expect(
      polygonLabelPoint([
        [
          [0, 0],
          [1, 1],
          [2, 2],
          [0, 0],
        ],
      ]),
    ).toBeNull();
  });
});
