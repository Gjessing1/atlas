import { describe, expect, it } from 'vitest';
import { coverageIntersectsTile, parsePolyFile, tileBBox } from './coverage.js';

/** The tile containing a point, so cases read as places rather than indices. */
function tileOf(lat: number, lng: number, z: number): [number, number, number] {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [z, x, y];
}

/** A square ring, as the .poly format writes them: `lon lat`, ring per section. */
function square(west: number, south: number, east: number, north: number, hole = false): string {
  return [
    `${hole ? '!' : ''}1`,
    `   ${west}   ${south}`,
    `   ${east}   ${south}`,
    `   ${east}   ${north}`,
    `   ${west}   ${north}`,
    `   ${west}   ${south}`,
    'END',
  ].join('\n');
}

const southernNorway = `norway\n${square(5, 58, 12, 64)}\nEND\n`;

describe('parsePolyFile', () => {
  it('reads the name, ring and bounds', () => {
    const poly = parsePolyFile(southernNorway);
    expect(poly?.name).toBe('norway');
    expect(poly?.rings).toHaveLength(1);
    expect(poly?.bbox).toEqual({ sw: { lat: 58, lng: 5 }, ne: { lat: 64, lng: 12 } });
  });

  it('marks !-prefixed sections as holes and unions only outer rings into the bbox', () => {
    const text = `region\n${square(0, 0, 10, 10)}\n${square(4, 4, 6, 6, true)}\nEND\n`;
    const poly = parsePolyFile(text);
    expect(poly?.rings.map((r) => r.hole)).toEqual([false, true]);
    expect(poly?.bbox).toEqual({ sw: { lat: 0, lng: 0 }, ne: { lat: 10, lng: 10 } });
  });

  it('parses exponential coordinates and skips unparseable lines', () => {
    const text = [
      'area',
      '1',
      '   1.0E+00   5.0E+01',
      '   junk',
      '   2 50',
      '   2 51',
      'END',
      'END',
    ].join('\n');
    const poly = parsePolyFile(text);
    expect(poly?.rings[0]?.points).toHaveLength(3);
    expect(poly?.rings[0]?.points[0]).toEqual({ lat: 50, lng: 1 });
  });

  it('returns null when no usable outer ring survives, so callers keep the archive', () => {
    expect(parsePolyFile('')).toBeNull();
    expect(parsePolyFile('name\nEND\n')).toBeNull();
    // Two points cannot enclose anything.
    expect(parsePolyFile('name\n1\n  1 1\n  2 2\nEND\nEND\n')).toBeNull();
    // A hole with no outer ring is not coverage.
    expect(parsePolyFile(`name\n${square(1, 1, 2, 2, true)}\nEND\n`)).toBeNull();
  });
});

describe('coverageIntersectsTile', () => {
  const poly = parsePolyFile(southernNorway)!;

  it('covers a tile inside the region', () => {
    expect(coverageIntersectsTile(poly, ...tileOf(60.39, 5.32, 12))).toBe(true); // Bergen
  });

  it('rejects a tile outside the region but inside its bounding box', () => {
    // The whole point: Stockholm sits in Norway's bbox, not in Norway. This is
    // the tile that used to be answered with water-only filler.
    expect(coverageIntersectsTile(poly, ...tileOf(59.31, 18.19, 12))).toBe(false);
    expect(coverageIntersectsTile(poly, ...tileOf(59.31, 18.19, 14))).toBe(false);
  });

  it('rejects a tile nowhere near the region', () => {
    expect(coverageIntersectsTile(poly, ...tileOf(-33.87, 151.21, 10))).toBe(false); // Sydney
  });

  it('covers a border tile that only partly holds the region', () => {
    // A z6 tile is ~5.6 degrees wide, so the tile holding the eastern edge
    // straddles it — the archive genuinely has data for that tile.
    const [z, x, y] = tileOf(60, 12, 6);
    const box = tileBBox(z, x, y);
    expect(box.sw.lng).toBeLessThan(12);
    expect(box.ne.lng).toBeGreaterThan(12);
    expect(coverageIntersectsTile(poly, z, x, y)).toBe(true);
  });

  it('covers a tile larger than the whole region', () => {
    expect(coverageIntersectsTile(poly, ...tileOf(60, 8, 2))).toBe(true);
  });

  it('drops a tile swallowed by a hole but keeps one straddling its edge', () => {
    const holed = parsePolyFile(`region\n${square(0, 0, 10, 10)}\n${square(4, 4, 6, 6, true)}\n`)!;
    expect(coverageIntersectsTile(holed, ...tileOf(5, 5, 12))).toBe(false);
    expect(coverageIntersectsTile(holed, ...tileOf(5, 5, 4))).toBe(true);
  });
});
