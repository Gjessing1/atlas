/**
 * The derive service's wire contract — cell addressing and the shapes
 * `/api/potential/…` speaks (ROADMAP § N5 → E2/E3b).
 *
 * It lives in the engine package rather than in the backend because both ends
 * need the same answers and neither may guess: the server derives cells and the
 * clients decide *which* cells they are looking at, whether the viewport is
 * inside Norway at all, and what to call the surface once it lands. Two
 * implementations of "which z11 tile is this point in" would be a registration
 * bug waiting to happen — the derived pixels are only trustworthy because
 * everyone agrees on the grid.
 *
 * Nothing here fetches. The URL builders hand back strings; the client owns the
 * request, because web and Android disagree about origins and MapLibre wants a
 * `{z}/{x}/{y}` template rather than a URL.
 */

import type { ConditionFactor } from '@atlas/conditions';
import type { LatLng, LngLatBbox } from '@atlas/core';
import type { PotentialExplanation } from './explain.js';
import type { SurfaceBandKey, SurfaceVocabulary } from './surface.js';

// ---- cell addressing ------------------------------------------------------

/**
 * The derive grid: **fixed z11 cells**, not user-drawn areas (D2 of
 * docs/FISH-HUNT-ENGINE.md). One cell is one z11 web-mercator tile — about
 * 9.8 × 9.8 km of ground at 60°N.
 */
export const CELL_ZOOM = 11;

/** Highest zoom served from a cell's own pixels; above this the client overzooms. */
export const CELL_MAX_TILE_ZOOM = 13;

const WEB_MERCATOR_EXTENT = 20037508.342789244;

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
 * Every derivable cell a viewport touches, nearest the centre first — so the
 * water the user is actually looking at is prepared before the corners.
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

// ---- wire shapes ----------------------------------------------------------

/** One thing a surface can be tuned for — a species, a quarry. */
export interface PotentialTarget {
  readonly value: string;
  readonly label: string;
  /**
   * One line saying what choosing this changes about the arithmetic. The picker
   * is the only place a surface can teach what it is tuned for, so a target that
   * needs no explanation is a sign the target list is unclear.
   */
  readonly caption?: string;
}

/** GET /api/potential/layers — what this build can derive. */
export interface PotentialLayerMeta {
  /** URL and cache-path segment, e.g. `lake-fishing`. */
  readonly layer: string;
  readonly label: string;
  readonly rev: number;
  /** Never empty: a surface with no declared target is meaningless (D4). */
  readonly targets: readonly PotentialTarget[];
  readonly vocabulary: SurfaceVocabulary;
}

export interface PotentialLayersResponse {
  readonly cellZoom: number;
  readonly maxTileZoom: number;
  readonly layers: readonly PotentialLayerMeta[];
}

/** One input's provenance, as recorded when the cell was derived. */
export interface PotentialInputRecord {
  readonly id: string;
  readonly label: string;
  /** The service, as a human would name it. */
  readonly source: string;
  /** Did it answer? A *missing* input must read as unknown, never as bad ground. */
  readonly ok: boolean;
  /** What arrived: counts, extents, byte sizes. */
  readonly detail: string;
  /** Whether this cell's copy came from disk rather than the network. */
  readonly cached: boolean;
  /** When the data was fetched (epoch ms). */
  readonly fetchedAt: number;
}

/**
 * A derived cell's manifest: the coverage verdict and the provenance of every
 * input behind it — what makes a surface auditable months later instead of
 * re-probing and guessing.
 */
export interface PotentialCellManifest {
  /** `11/1083/596`. */
  readonly cell: string;
  readonly layer: string;
  readonly target: string;
  /** The model's revision at derive time. */
  readonly rev: number;
  readonly engineRev: number;
  readonly derivedAt: number;
  /** Ground metres per raster pixel. */
  readonly cellSizeM: number;
  readonly bounds: LngLatBbox;
  readonly inputs: readonly PotentialInputRecord[];
  readonly contrast: {
    readonly standout: boolean;
    readonly validCells: number;
    readonly spread: number;
    readonly reason: string;
  };
  /** Absolute quality tier, or null when the model supplied no prior. */
  readonly tier: string | null;
  readonly notes: readonly string[];
  /** Fraction of the cell that carries a score, 0..1. */
  readonly coverage: number;
  /** Content ETag shared by every tile of this cell. */
  readonly etag: string;
  /** Legend vocabulary, so a client renders the right words. */
  readonly vocabulary: SurfaceVocabulary;
  /**
   * The persisted signal planes behind this cell, or null when the model
   * supplied none. Their *order* is the file layout, so this is the header of
   * the `.signals` blob beside the manifest, not decoration.
   */
  readonly signals: {
    readonly pixels: number;
    /** Plane order in the blob; `rank` is always first. */
    readonly planes: readonly string[];
    /** One entry per weighted signal, in plane order after `rank`. */
    readonly terms: readonly {
      readonly key: string;
      readonly label: string;
      readonly weight: number;
    }[];
  } | null;
}

export type PotentialCellStatus = 'queued' | 'running' | 'done' | 'failed' | 'ready';

/** What a client needs to know about one cell of a requested area. */
export interface PotentialCellState {
  readonly cell: string;
  readonly status: PotentialCellStatus;
  readonly error?: string;
  /** Present once derived: the coverage note and provenance for that cell. */
  readonly manifest?: PotentialCellManifest;
}

/** POST /api/potential/prepare — "I am looking here". */
export interface PotentialPrepareRequest {
  readonly layer: string;
  readonly target: string;
  readonly bbox: LngLatBbox;
}

export interface PotentialPrepareResponse {
  readonly layer: string;
  readonly target: string;
  readonly cellZoom: number;
  readonly cells: readonly PotentialCellState[];
  readonly ready: number;
  /**
   * Cells still queued or running — **only** what is going to change on its
   * own, because a client polls while this is above zero. A failed cell is
   * terminal and is counted in `failed` instead.
   */
  readonly working: number;
  /** Cells whose derive gave up. Absent on servers older than this field. */
  readonly failed?: number;
  /** No cell of this viewport is inside the Norwegian envelope. */
  readonly outsideCoverage: boolean;
}

/**
 * GET /api/potential/:layer/:target/explain — why *this point* scores what it
 * does (D4), plus the cell-level context that decides whether the number may be
 * believed at all.
 */
export interface PotentialExplainResponse extends PotentialExplanation {
  readonly cell: string;
  readonly layer: string;
  readonly target: string;
  readonly vocabulary: SurfaceVocabulary;
  readonly tier: string | null;
  /**
   * The contrast gate's verdict travels with every answer: on a surface with no
   * standout, "top 3 %" means nothing and the client must be able to say so.
   */
  readonly standout: boolean;
  readonly contrast: string;
  readonly notes: readonly string[];
  readonly inputs: readonly PotentialInputRecord[];
}

/**
 * How a spot is reached on foot from the nearest drivable road — the number
 * that decides whether a prime shoreline is tonight's plan or next summer's.
 */
export interface PotentialSpotAccess {
  readonly distanceM: number;
  readonly durationS: number;
  /**
   * The router could not walk the last stretch (no path reaches the water), so
   * this is a straight-line floor rather than a route. Said out loud in the UI:
   * an over-confident "12 min" to a spot with no path to it is exactly the kind
   * of number that gets someone into a bog at dusk.
   */
  readonly approximate: boolean;
  /** Where the walk starts — the nearest point on a road a car can reach. */
  readonly from: LatLng;
}

/** One numbered recommendation from "best spots in view". */
export interface PotentialSpot {
  /** Stable within a response, and the id the map markers carry. */
  readonly id: string;
  readonly position: LatLng;
  /** The derived cell this came out of, for provenance. */
  readonly cell: string;
  /** Percentile rank within its own cell, 0..1. */
  readonly rank: number;
  /** `rank` as 0..100, the same number the explain card quotes. */
  readonly score: number;
  readonly band: SurfaceBandKey;
  readonly bandLabel: string;
  /** The strongest factor's own sentence — why *this* point, in one line. */
  readonly reason: string;
  /** The full weighted breakdown, in the weather card's shape. */
  readonly factors: readonly ConditionFactor[];
  /** Null when the router could not be asked, or found no road at all. */
  readonly access: PotentialSpotAccess | null;
}

/** GET /api/potential/:layer/:target/spots?bbox=w,s,e,n */
export interface PotentialSpotsResponse {
  readonly layer: string;
  readonly target: string;
  readonly vocabulary: SurfaceVocabulary;
  /** Strongest first, already thinned to real alternatives. */
  readonly spots: readonly PotentialSpot[];
  /**
   * Cells under this view that are not derived yet. Above zero the shortlist is
   * **provisional** — the best water in view may still be building — and the UI
   * has to say so rather than presenting eight of them as the answer.
   */
  readonly pending: number;
  /**
   * Derived cells whose contrast gate found no standout. Not a failure: it is
   * the surface declining to point at anything, and the reason an empty list
   * can be honest.
   */
  readonly flat: number;
  /** Whether walk-in times could be asked for at all (the router may be down). */
  readonly accessAvailable: boolean;
  /** Why the list is empty or short. Null when it needs no explanation. */
  readonly note: string | null;
}

// ---- URLs -----------------------------------------------------------------

/** Where the derive service lives. `origin` is '' on the web (same-origin). */
export function potentialLayersUrl(origin: string): string {
  return `${origin}/api/potential/layers`;
}

export function potentialPrepareUrl(origin: string): string {
  return `${origin}/api/potential/prepare`;
}

/**
 * A derived layer's MapLibre raster template. The `{z}/{x}/{y}` placeholders
 * are left for the map to substitute, exactly like `overlayTileUrl`.
 *
 * No cache-busting parameter, on purpose: a re-derive rewrites the *same* URL
 * and the route answers `no-cache` with a content ETag, so the client
 * revalidates and can never be shown a surface that has since been rebuilt.
 */
export function potentialTileUrl(origin: string, layer: string, target: string): string {
  return (
    `${origin}/api/potential/${encodeURIComponent(layer)}/${encodeURIComponent(target)}` +
    `/{z}/{x}/{y}.png`
  );
}

export function potentialExplainUrl(
  origin: string,
  layer: string,
  target: string,
  at: LatLng,
): string {
  return (
    `${origin}/api/potential/${encodeURIComponent(layer)}/${encodeURIComponent(target)}/explain` +
    `?lat=${at.lat}&lng=${at.lng}`
  );
}

/**
 * The shortlist for what is on screen. A GET with the bbox in the query, so it
 * caches and retries like any read — the cells it reads were queued by
 * `/prepare`, and asking for spots never starts work of its own.
 */
export function potentialSpotsUrl(
  origin: string,
  layer: string,
  target: string,
  bbox: LngLatBbox,
  limit?: number,
): string {
  const query = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(6)).join(',') });
  if (limit !== undefined) query.set('limit', String(limit));
  return (
    `${origin}/api/potential/${encodeURIComponent(layer)}/${encodeURIComponent(target)}/spots` +
    `?${query.toString()}`
  );
}

export function potentialCellUrl(
  origin: string,
  layer: string,
  target: string,
  cell: Cell,
): string {
  return (
    `${origin}/api/potential/${encodeURIComponent(layer)}/${encodeURIComponent(target)}` +
    `/cell/${cell.x}/${cell.y}.json`
  );
}
