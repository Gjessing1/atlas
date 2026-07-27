import type { LngLatBbox } from '@atlas/core';

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
 */

export const CELL_ZOOM = 11;
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

/** Highest zoom served from a cell's own pixels; above this the client overzooms. */
export const CELL_MAX_TILE_ZOOM = 13;

const WEB_MERCATOR_EXTENT = 20037508.342789244;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;

/**
 * Norway's data envelope. Every input is a Norwegian government service, so a
 * cell outside this box has nothing to derive from — and per the Norway-only
 * precedent (ROADMAP §2.1) that must read as *absent*, never as an error.
 *
 * Svalbard and Jan Mayen are deliberately outside: NVE's lake register and
 * NIBIO's land cover do not cover them, so a cell there would derive an empty
 * surface that looks like a bug.
 */
export const NORWAY_ENVELOPE: LngLatBbox = [4.0, 57.5, 31.6, 71.4];

export interface Cell {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

/** `11/1083/596` — the cell's canonical name, and a safe path fragment. */
export function cellId(cell: Cell): string {
  return `${cell.z}/${cell.x}/${cell.y}`;
}

/** Parses `11/1083/596`; null for anything that is not a valid cell address. */
export function parseCellId(id: string): Cell | null {
  const parts = id.split('/');
  if (parts.length !== 3) return null;
  const [z, x, y] = parts.map(Number);
  if (z !== CELL_ZOOM) return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  const span = 2 ** CELL_ZOOM;
  if (x! < 0 || y! < 0 || x! >= span || y! >= span) return null;
  return { z: CELL_ZOOM, x: x!, y: y! };
}

/** Latitude of a web-mercator northing, in degrees. */
function mercatorToLat(northing: number): number {
  return (Math.atan(Math.sinh((northing / WEB_MERCATOR_EXTENT) * Math.PI)) * 180) / Math.PI;
}

/** The tile's own extent in WGS84 degrees, `[west, south, east, north]`. */
export function cellBounds(cell: Cell): LngLatBbox {
  const size = (2 * WEB_MERCATOR_EXTENT) / 2 ** cell.z;
  const minX = -WEB_MERCATOR_EXTENT + cell.x * size;
  const maxY = WEB_MERCATOR_EXTENT - cell.y * size;
  return [
    (minX / WEB_MERCATOR_EXTENT) * 180,
    mercatorToLat(maxY - size),
    ((minX + size) / WEB_MERCATOR_EXTENT) * 180,
    mercatorToLat(maxY),
  ];
}

/** The z11 cell containing a point. */
export function cellAt(lat: number, lng: number): Cell {
  const n = 2 ** CELL_ZOOM;
  const latRad = (lat * Math.PI) / 180;
  return {
    z: CELL_ZOOM,
    x: Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n))),
    y: Math.min(
      n - 1,
      Math.max(
        0,
        Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
      ),
    ),
  };
}

/** Does any part of this cell fall inside the Norwegian data envelope? */
export function inNorway(cell: Cell): boolean {
  const [west, south, east, north] = cellBounds(cell);
  const [w, s, e, n] = NORWAY_ENVELOPE;
  return west < e && east > w && south < n && north > s;
}

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
 * Cells covering a viewport, nearest the centre first — so the water the user is
 * actually looking at is prepared before the corners.
 *
 * `limit` is a hard cap rather than an error: a zoomed-out viewport can span
 * hundreds of cells, and the honest answer there is "zoom in" (the UI shows a
 * hint below z11), not a queue of two hundred derives against public services.
 */
export function cellsForBbox(bbox: LngLatBbox, limit = 12): Cell[] {
  const [west, south, east, north] = bbox;
  const topLeft = cellAt(north, west);
  const bottomRight = cellAt(south, east);
  const centre = cellAt((north + south) / 2, (west + east) / 2);
  const cells: Cell[] = [];
  for (let y = topLeft.y; y <= bottomRight.y; y++) {
    for (let x = topLeft.x; x <= bottomRight.x; x++) {
      const cell: Cell = { z: CELL_ZOOM, x, y };
      if (inNorway(cell)) cells.push(cell);
    }
  }
  cells.sort(
    (a, b) =>
      Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(b.x - centre.x, b.y - centre.y),
  );
  return cells.slice(0, limit);
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
