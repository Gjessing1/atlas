import type { LngLatBbox } from '@atlas/core';
import {
  burnPolyline,
  cellBounds,
  CELL_MAX_TILE_ZOOM,
  CELL_ZOOM,
  type Cell,
  type Mask,
} from '@atlas/potential';

/**
 * The derive grid: **fixed z11 cells**, not user-drawn areas (D2 of
 * docs/FISH-HUNT-ENGINE.md).
 *
 * A cell is one z11 web-mercator tile — about 9.8 × 9.8 km of ground at 60°N —
 * rasterised at 1024², i.e. ~9.6 m per pixel. Fixed cells buy three things a
 * drawn AOI cannot:
 *
 * - **Immutability.** A cell is identified by `(layer, target, rev, z/x/y)` and
 *   never partially rewritten, so there is nothing to invalidate. nodemap's
 *   shared per-layer tile tree forced a bbox-scoped wipe before every derive
 *   because a full one deleted other areas' tiles; that whole bug class is gone.
 * - **Sharing.** Two users looking at the same water get the same cell.
 * - **Trivial pyramids.** 1024 = 4 × 256, so a cell serves z11 at 4:1, z12 at
 *   2:1 and z13 pixel-for-pixel, and overzooms above that. The surface is
 *   10 m-smooth, so overzoom is honest rather than invented detail.
 *
 * **The addressing itself lives in `@atlas/potential`** (`api.ts`) and is only
 * re-exported here. The clients have to agree with the server about which z11
 * tile a point falls in — that is how a viewport becomes a list of cells to
 * prepare — and a second implementation of that arithmetic is a registration
 * bug waiting to happen. What stays here is what only the *derive service*
 * needs: the padded raster, the projection onto it, and the tile pyramid.
 */

export {
  CELL_MAX_TILE_ZOOM,
  CELL_ZOOM,
  cellAt,
  cellBounds,
  cellId,
  cellsForBbox,
  inNorway,
  NORWAY_ENVELOPE,
  parseCellId,
  type Cell,
} from '@atlas/potential';

/** Raster edge of a cell's own extent, in pixels. */
export const CELL_PIXELS = 1024;
/**
 * Extra pixels fetched and computed outside the cell on every side.
 *
 * Focal operations (slope, focal means, distance transforms) read neighbours, so
 * without a margin every derived product carries a ring of wrong values along
 * each edge — and because cells tile the country, those rings would form a
 * visible grid across the map. 32 px ≈ 310 m, which covers the largest focal
 * radius the models use. The margin is computed and then cropped away.
 */
export const PAD_PIXELS = 32;

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;

/**
 * The padded raster a cell is derived on, and everything needed to put vector
 * data onto it.
 */
export interface CellRaster {
  readonly cell: Cell;
  /** Padded edge in pixels (`CELL_PIXELS + 2 * PAD_PIXELS`). */
  readonly size: number;
  readonly pad: number;
  /** Ground metres per pixel at the cell's centre latitude. */
  readonly cellSizeM: number;
  /** Padded extent — what upstreams are asked for. */
  readonly bounds: LngLatBbox;
  /** The cell's own extent — what is served and stored. */
  readonly cellBounds: LngLatBbox;
}

/**
 * Geometry of one cell's derive raster.
 *
 * Pixels are laid out **linearly in longitude and latitude** rather than in
 * mercator metres, because that is the only grid the Kartverket DTM WCS will
 * hand out (`CRS=EPSG:4326` with a plain BBOX; its 2.0.1 `SUBSET=` form 400s).
 * Sampling a mercator tile's extent that way is not exact, but the error was
 * measured for this grid and peaks at **0.34 px (3.3 m) at mid-tile** — a third
 * of a pixel — so resampling the elevation raster into mercator rows would add
 * a step and a class of bug for less than the grid's own resolution.
 *
 * That choice is why everything else here projects linearly too: the raster, the
 * burned vectors and the served tile all agree.
 */
export function cellRaster(cell: Cell): CellRaster {
  const bounds = cellBounds(cell);
  const [west, south, east, north] = bounds;
  const padLng = ((east - west) * PAD_PIXELS) / CELL_PIXELS;
  const padLat = ((north - south) * PAD_PIXELS) / CELL_PIXELS;
  const centreLat = (north + south) / 2;
  // Mercator tiles are square in metres, so ground width at the centre latitude
  // divided by the pixel count is the pixel size in both axes (to within the
  // variation of cos(lat) across one tile, ~0.3 %).
  const groundWidthM =
    (EARTH_CIRCUMFERENCE_M / 2 ** cell.z) * Math.cos((centreLat * Math.PI) / 180);
  return {
    cell,
    size: CELL_PIXELS + 2 * PAD_PIXELS,
    pad: PAD_PIXELS,
    cellSizeM: groundWidthM / CELL_PIXELS,
    bounds: [west - padLng, south - padLat, east + padLng, north + padLat],
    cellBounds: bounds,
  };
}

/**
 * Fractional pixel coordinates of a lon/lat on the padded raster. Values outside
 * `[0, size)` are returned as-is: callers burning a line need the off-raster
 * endpoint so the visible part of the segment is drawn, rather than a line that
 * stops at the edge.
 */
export function projectToRaster(
  raster: CellRaster,
  lng: number,
  lat: number,
): readonly [number, number] {
  const [west, south, east, north] = raster.bounds;
  return [
    ((lng - west) / (east - west)) * raster.size,
    ((north - lat) / (north - south)) * raster.size,
  ];
}

/**
 * Which cell serves a requested tile, and where inside it.
 *
 * `scale` is how many cell pixels one tile pixel covers (4 at z11, 1 at z13);
 * above `CELL_MAX_TILE_ZOOM` there is no answer and the client overzooms the
 * z13 tile instead of the server inventing detail.
 */
export function cellForTile(
  z: number,
  x: number,
  y: number,
): { cell: Cell; offsetX: number; offsetY: number; scale: number } | null {
  if (!Number.isInteger(z) || z < CELL_ZOOM || z > CELL_MAX_TILE_ZOOM) return null;
  const steps = z - CELL_ZOOM;
  const factor = 2 ** steps;
  const cell: Cell = { z: CELL_ZOOM, x: Math.floor(x / factor), y: Math.floor(y / factor) };
  // Pixels of the cell raster covered by this tile, and the tile's origin in it.
  const covered = CELL_PIXELS / factor;
  return {
    cell,
    offsetX: (x % factor) * covered,
    offsetY: (y % factor) * covered,
    scale: covered / 256,
  };
}

/**
 * Burn every path of a vector input onto a mask, in raster pixels.
 *
 * Lives here rather than beside the models because it is pure cell geometry —
 * and because both the model registry and the individual models need it, which
 * would otherwise make them import each other at runtime.
 */
export function burnPaths(
  raster: CellRaster,
  paths: readonly (readonly (readonly [number, number])[])[],
  mask: Mask,
): number {
  let burned = 0;
  for (const path of paths) {
    if (path.length < 2) continue;
    burnPolyline(
      mask,
      path.map(([lng, lat]) => {
        const [x, y] = projectToRaster(raster, lng, lat);
        return [Math.round(x), Math.round(y)] as const;
      }),
    );
    burned++;
  }
  return burned;
}
