import { haversineM, type LatLng } from '@atlas/core';

import type { RoutePath, RoutingProfile } from './model.js';
import type { ValhallaTransport } from './provider.js';

/**
 * Route enrichment — per-edge road attributes aligned to distance along a
 * chosen route.
 *
 * Valhalla's `/route` response says what to *do* (maneuvers) but nothing about
 * the road being driven: no speed limit, no tunnel flag, no road class. Those
 * live in the same tiles and come back from `/trace_attributes`, so one extra
 * call over the route's own shape yields them for the whole trip in one go.
 * That is deliberately done once per route (at Start, and after a reroute)
 * rather than per fix: the attributes are static, and navigation only needs to
 * look up "what applies at `alongM`".
 *
 * Keyed by along-route distance rather than shape index so consumers stay
 * decoupled from geometry: `NavigationSession` already tracks `alongM`, and
 * the same enrichment survives display prediction and dead reckoning, which
 * both move a distance, not an index.
 */

/** Road attributes that hold over one stretch of the route. */
export interface RouteEnrichmentSegment {
  /** Distance (m) along the route where this stretch begins (inclusive). */
  startM: number;
  /** Distance (m) along the route where it ends (exclusive, except the last). */
  endM: number;
  /**
   * Posted limit in km/h. Absent where the tiles carry no limit for the edge —
   * roughly 5 % of edges — which callers must render as "unknown", never as
   * the last known value.
   */
  speedLimitKph?: number;
  /** True on edges tagged as tunnels. */
  tunnel?: boolean;
  /** Valhalla road class (`motorway`, `trunk`, `residential`, …). */
  roadClass?: string;
  /** Primary road name on the edge, when it has one. */
  name?: string;
}

/** Road attributes for a whole route, ordered by `startM` and non-overlapping. */
export interface RouteEnrichment {
  segments: RouteEnrichmentSegment[];
}

/** Valhalla costing model for an Atlas profile — trace_attributes needs one too. */
function costingFor(profile: RoutingProfile): string {
  switch (profile) {
    case 'car':
      return 'auto';
    case 'bike':
      return 'bicycle';
    case 'foot':
    case 'hike':
      return 'pedestrian';
  }
}

/**
 * The attributes we ask for, by Valhalla's filter names. Kept to the few we
 * actually consume: a full trace_attributes response over a long route is
 * megabytes, and most of it is turn-cost bookkeeping no UI will ever read.
 */
const ATTRIBUTE_FILTERS = [
  'edge.speed_limit',
  'edge.tunnel',
  'edge.road_class',
  'edge.names',
  'edge.begin_shape_index',
  'edge.end_shape_index',
];

/**
 * Body for a Valhalla `POST /trace_attributes` over an exact route shape.
 *
 * `shape_match: edge_walk` is the cheap, exact mode: it assumes the shape
 * already lies on the graph and just walks the edges under it — true here by
 * construction, since the shape came out of the same engine's router. (The
 * expensive `map_snap` mode is for GPS traces, which this is not.)
 */
export function buildTraceAttributesRequest(
  points: LatLng[],
  profile: RoutingProfile,
): Record<string, unknown> {
  return {
    shape: points.map((p) => ({ lat: p.lat, lon: p.lng })),
    costing: costingFor(profile),
    shape_match: 'edge_walk',
    // Limits come back in the requested unit; kilometres keeps them km/h,
    // matching the rest of Atlas (units are hand-formatted metric, never locale).
    directions_options: { units: 'kilometers' },
    filters: { attributes: ATTRIBUTE_FILTERS, action: 'include' },
  };
}

interface ValhallaTraceEdge {
  speed_limit?: number;
  tunnel?: boolean;
  road_class?: string;
  names?: string[];
  begin_shape_index?: number;
  end_shape_index?: number;
}

/** Cumulative distance (m) at each point of `points` (`[0]` is always 0). */
function cumulative(points: LatLng[]): number[] {
  const cum = new Array<number>(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1]! + haversineM(points[i - 1]!, points[i]!);
  }
  return cum;
}

/** Two segments carrying exactly the same attributes can be drawn as one. */
function sameAttributes(a: RouteEnrichmentSegment, b: RouteEnrichmentSegment): boolean {
  return (
    a.speedLimitKph === b.speedLimitKph &&
    a.tunnel === b.tunnel &&
    a.roadClass === b.roadClass &&
    a.name === b.name
  );
}

/**
 * Map a `/trace_attributes` response onto distances along `points` (the same
 * shape the request was built from). `offsetM` shifts the result when `points`
 * is a chunk of a longer route.
 *
 * Unparseable or empty responses yield no segments rather than throwing:
 * enrichment is an enhancement, and navigation must run without it.
 */
export function parseTraceAttributes(
  json: unknown,
  points: LatLng[],
  offsetM = 0,
): RouteEnrichmentSegment[] {
  const edges = (json as { edges?: unknown } | null)?.edges;
  if (!Array.isArray(edges) || points.length < 2) return [];
  const cum = cumulative(points);
  const lastIdx = points.length - 1;
  const out: RouteEnrichmentSegment[] = [];

  for (const raw of edges as ValhallaTraceEdge[]) {
    const begin = raw?.begin_shape_index;
    const end = raw?.end_shape_index;
    if (typeof begin !== 'number' || typeof end !== 'number') continue;
    const from = Math.min(Math.max(begin, 0), lastIdx);
    const to = Math.min(Math.max(end, 0), lastIdx);
    if (to <= from) continue;
    const segment: RouteEnrichmentSegment = {
      startM: offsetM + cum[from]!,
      endM: offsetM + cum[to]!,
    };
    // A missing limit and a limit of 0 mean the same thing — the tiles don't
    // know — and both must stay absent so the UI can show nothing.
    if (typeof raw.speed_limit === 'number' && raw.speed_limit > 0) {
      segment.speedLimitKph = raw.speed_limit;
    }
    if (raw.tunnel === true) segment.tunnel = true;
    if (typeof raw.road_class === 'string' && raw.road_class.length > 0) {
      segment.roadClass = raw.road_class;
    }
    const name = raw.names?.find((n) => typeof n === 'string' && n.length > 0);
    if (name) segment.name = name;
    out.push(segment);
  }

  out.sort((a, b) => a.startM - b.startM);
  return out;
}

/** Collapse touching segments that carry identical attributes. */
function coalesce(segments: RouteEnrichmentSegment[]): RouteEnrichmentSegment[] {
  const out: RouteEnrichmentSegment[] = [];
  for (const segment of segments) {
    const prev = out[out.length - 1];
    if (prev && sameAttributes(prev, segment) && segment.startM <= prev.endM + 1) {
      prev.endM = Math.max(prev.endM, segment.endM);
      continue;
    }
    out.push({ ...segment });
  }
  return out;
}

export interface EnrichRouteOptions {
  /**
   * Largest shape the engine is asked to walk in one request. Valhalla caps
   * trace shapes (`max_trace_shape`), and a cross-country route can exceed
   * that, so long routes go out in chunks and are stitched back together.
   */
  maxShapePoints?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_SHAPE_POINTS = 3000;

/**
 * Fetch road attributes for a chosen route. Long routes are split into
 * overlapping chunks (each chunk repeats the previous chunk's last point, so
 * no edge falls between them) and the results concatenated by distance.
 *
 * Never throws: a failed or partial enrichment returns what it has, because
 * every consumer treats missing attributes as "unknown" already, and losing a
 * speed-limit roundel must not be able to stop navigation from starting.
 */
export async function enrichRoute(
  path: RoutePath,
  profile: RoutingProfile,
  transport: ValhallaTransport,
  opts: EnrichRouteOptions = {},
): Promise<RouteEnrichment> {
  const points: LatLng[] = path.points.map((p) => ({ lat: p.lat, lng: p.lng }));
  if (points.length < 2) return { segments: [] };
  const max = Math.max(2, opts.maxShapePoints ?? DEFAULT_MAX_SHAPE_POINTS);
  const cum = cumulative(points);
  const segments: RouteEnrichmentSegment[] = [];

  for (let start = 0; start < points.length - 1; start += max - 1) {
    const chunk = points.slice(start, start + max);
    if (chunk.length < 2) break;
    try {
      const json = await transport(buildTraceAttributesRequest(chunk, profile), opts.signal);
      segments.push(...parseTraceAttributes(json, chunk, cum[start]!));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // Keep whatever earlier chunks produced: a route enriched to km 40 is
      // strictly better than one enriched nowhere.
      break;
    }
  }

  return { segments: coalesce(segments) };
}

/** Index of the segment covering `alongM`, or -1 outside the enriched range. */
function indexAt(segments: RouteEnrichmentSegment[], alongM: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid]!;
    if (alongM < seg.startM) hi = mid - 1;
    else if (alongM > seg.endM) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** The stretch of road covering `alongM`, or null outside the enriched range. */
export function enrichmentAt(
  enrichment: RouteEnrichment | null | undefined,
  alongM: number,
): RouteEnrichmentSegment | null {
  const segments = enrichment?.segments;
  if (!segments || segments.length === 0) return null;
  const i = indexAt(segments, alongM);
  return i < 0 ? null : segments[i]!;
}

/**
 * Posted limit (km/h) at `alongM`, or null where the data has none. Null is a
 * real answer here — "we don't know" — and must be rendered as an absent
 * roundel, not as the previous limit.
 */
export function speedLimitKphAt(
  enrichment: RouteEnrichment | null | undefined,
  alongM: number,
): number | null {
  return enrichmentAt(enrichment, alongM)?.speedLimitKph ?? null;
}

/**
 * One tunnel the route passes through, merged across the edges that make it
 * up. A single bore is routinely several enrichment segments — the limit
 * drops at the portal, the road class changes, a name appears — so the
 * physical tunnel only exists once contiguous tunnel edges are joined.
 */
export interface RouteTunnel {
  /** Distance (m) along the route of the entry portal. */
  startM: number;
  /** Distance (m) along the route of the exit portal. */
  endM: number;
  /** Tunnel name where the tiles carry one ("Brynstunnelen"), else null. */
  name: string | null;
}

/** Segments are contiguous when they touch (sub-metre rounding tolerated). */
function touches(a: RouteEnrichmentSegment, b: RouteEnrichmentSegment): boolean {
  return b.startM <= a.endM + 1;
}

/** Grow the tunnel run around `i` and describe it. */
function tunnelRun(segments: RouteEnrichmentSegment[], i: number): RouteTunnel {
  let first = i;
  let last = i;
  while (
    first > 0 &&
    segments[first - 1]!.tunnel === true &&
    touches(segments[first - 1]!, segments[first]!)
  ) {
    first--;
  }
  while (
    last < segments.length - 1 &&
    segments[last + 1]!.tunnel === true &&
    touches(segments[last]!, segments[last + 1]!)
  ) {
    last++;
  }
  let name: string | null = null;
  for (let k = first; k <= last && name === null; k++) name = segments[k]!.name ?? null;
  return { startM: segments[first]!.startM, endM: segments[last]!.endM, name };
}

/** The tunnel containing `alongM`, or null when the route is in the open there. */
export function tunnelAt(
  enrichment: RouteEnrichment | null | undefined,
  alongM: number,
): RouteTunnel | null {
  const segments = enrichment?.segments;
  if (!segments || segments.length === 0) return null;
  const i = indexAt(segments, alongM);
  if (i < 0 || segments[i]!.tunnel !== true) return null;
  return tunnelRun(segments, i);
}

/**
 * The tunnel at `alongM`, or the next one starting within `lookAheadM`.
 *
 * The look-ahead exists because fixes die *around* a portal, not exactly at
 * it: the last usable fix before a tunnel is often a short way short of the
 * entrance, and treating that as "not a tunnel" would throw away the very
 * knowledge this data was fetched for. Callers that report what the driver is
 * inside right now should use `tunnelAt` instead — this one is for arming
 * behaviour at a portal the route is about to reach.
 */
export function tunnelNear(
  enrichment: RouteEnrichment | null | undefined,
  alongM: number,
  lookAheadM: number,
): RouteTunnel | null {
  const inside = tunnelAt(enrichment, alongM);
  if (inside) return inside;
  const segments = enrichment?.segments;
  if (!segments) return null;
  for (const [i, seg] of segments.entries()) {
    if (seg.startM > alongM + lookAheadM) break;
    if (seg.tunnel === true && seg.endM > alongM) return tunnelRun(segments, i);
  }
  return null;
}
