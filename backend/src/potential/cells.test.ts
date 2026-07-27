import { describe, expect, it } from 'vitest';
import {
  CELL_PIXELS,
  CELL_ZOOM,
  cellAt,
  cellBounds,
  cellForTile,
  cellId,
  cellRaster,
  cellsForBbox,
  inNorway,
  parseCellId,
  projectToRaster,
} from './cells.js';

/** Semsvannet in Asker — the Fish & Hunt engine's bathymetric reference lake. */
const SEMSVANNET = { lat: 59.85834, lng: 10.42062 };
/** The z11 cell containing it, verified against the live services. */
const SEMS_CELL = { z: 11, x: 1083, y: 596 };

describe('cell addressing', () => {
  it('places a known lake in its cell', () => {
    expect(cellAt(SEMSVANNET.lat, SEMSVANNET.lng)).toEqual(SEMS_CELL);
    expect(cellId(SEMS_CELL)).toBe('11/1083/596');
  });

  it('round-trips a cell id', () => {
    expect(parseCellId('11/1083/596')).toEqual(SEMS_CELL);
  });

  it('refuses ids that are not cells', () => {
    // Wrong zoom: cells are z11 by definition, and accepting another zoom would
    // silently derive a different-sized area under the same name.
    expect(parseCellId('12/2166/1192')).toBeNull();
    expect(parseCellId('11/1083')).toBeNull();
    expect(parseCellId('11/-1/596')).toBeNull();
    expect(parseCellId(`11/${2 ** 11}/596`)).toBeNull();
    expect(parseCellId('11/a/b')).toBeNull();
  });

  it('bounds the cell where the lake actually is', () => {
    const [west, south, east, north] = cellBounds(SEMS_CELL);
    expect(west).toBeLessThan(SEMSVANNET.lng);
    expect(east).toBeGreaterThan(SEMSVANNET.lng);
    expect(south).toBeLessThan(SEMSVANNET.lat);
    expect(north).toBeGreaterThan(SEMSVANNET.lat);
  });
});

describe('cell raster', () => {
  const raster = cellRaster(SEMS_CELL);

  /**
   * ~9.6 m at 60°N is the resolution the whole engine design assumes (a 9.8 km
   * cell over 1024 px). A change here silently rescales every distance-based
   * signal, so it is pinned.
   */
  it('is ~9.6 m per pixel at 60°N', () => {
    expect(raster.cellSizeM).toBeGreaterThan(9.4);
    expect(raster.cellSizeM).toBeLessThan(9.8);
  });

  it('pads the fetched extent beyond the cell on every side', () => {
    const [pw, ps, pe, pn] = raster.bounds;
    const [cw, cs, ce, cn] = raster.cellBounds;
    expect(pw).toBeLessThan(cw);
    expect(ps).toBeLessThan(cs);
    expect(pe).toBeGreaterThan(ce);
    expect(pn).toBeGreaterThan(cn);
    expect(raster.size).toBe(CELL_PIXELS + 2 * raster.pad);
  });

  it('projects the cell corners to the padded raster inset by exactly the pad', () => {
    const [west, south, east, north] = raster.cellBounds;
    const [x0, y0] = projectToRaster(raster, west, north);
    const [x1, y1] = projectToRaster(raster, east, south);
    expect(x0).toBeCloseTo(raster.pad, 6);
    expect(y0).toBeCloseTo(raster.pad, 6);
    expect(x1).toBeCloseTo(raster.pad + CELL_PIXELS, 6);
    expect(y1).toBeCloseTo(raster.pad + CELL_PIXELS, 6);
  });

  it('puts the reference lake inside the cell area of the raster', () => {
    const [x, y] = projectToRaster(raster, SEMSVANNET.lng, SEMSVANNET.lat);
    expect(x).toBeGreaterThan(raster.pad);
    expect(x).toBeLessThan(raster.pad + CELL_PIXELS);
    expect(y).toBeGreaterThan(raster.pad);
    expect(y).toBeLessThan(raster.pad + CELL_PIXELS);
  });
});

describe('coverage', () => {
  it('accepts Norwegian cells and rejects distant ones', () => {
    expect(inNorway(SEMS_CELL)).toBe(true);
    // Svalbard is deliberately outside: the lake register and land cover do not
    // cover it, so a cell there would derive an empty surface that looks broken.
    expect(inNorway(cellAt(78.22, 15.65))).toBe(false);
    expect(inNorway(cellAt(48.85, 2.35))).toBe(false);
  });
});

describe('cellsForBbox', () => {
  it('covers a viewport, nearest the centre first', () => {
    const cells = cellsForBbox([10.2, 59.7, 10.7, 60.0]);
    expect(cells.length).toBeGreaterThan(1);
    const centre = cellAt(59.85, 10.45);
    // The first cell must be the one the user is looking at.
    expect(cells[0]).toEqual(centre);
  });

  it('caps the number of cells rather than queueing a whole country', () => {
    const cells = cellsForBbox([4, 58, 31, 71], 12);
    expect(cells).toHaveLength(12);
  });

  it('returns nothing outside Norwegian coverage', () => {
    expect(cellsForBbox([2.0, 48.0, 2.5, 49.0])).toEqual([]);
  });
});

describe('cellForTile', () => {
  it('maps the cell zoom to the whole cell at 4:1', () => {
    const located = cellForTile(CELL_ZOOM, SEMS_CELL.x, SEMS_CELL.y)!;
    expect(located.cell).toEqual(SEMS_CELL);
    expect(located.offsetX).toBe(0);
    expect(located.offsetY).toBe(0);
    expect(located.scale).toBe(4);
  });

  it('maps z12 to a quadrant at 2:1', () => {
    const located = cellForTile(12, SEMS_CELL.x * 2 + 1, SEMS_CELL.y * 2 + 1)!;
    expect(located.cell).toEqual(SEMS_CELL);
    expect(located.offsetX).toBe(512);
    expect(located.offsetY).toBe(512);
    expect(located.scale).toBe(2);
  });

  /** 1024 = 4 × 256, so z13 is pixel-for-pixel — no resampling at all. */
  it('maps z13 one-to-one', () => {
    const located = cellForTile(13, SEMS_CELL.x * 4 + 3, SEMS_CELL.y * 4 + 2)!;
    expect(located.cell).toEqual(SEMS_CELL);
    expect(located.offsetX).toBe(768);
    expect(located.offsetY).toBe(512);
    expect(located.scale).toBe(1);
  });

  it('has no answer outside the served pyramid', () => {
    expect(cellForTile(10, 541, 298)).toBeNull();
    expect(cellForTile(14, 17328, 9536)).toBeNull();
  });
});
