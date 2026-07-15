import type { TrackPoint } from '@atlas/gpx';
import type { RoutePath, RouteQuery, RouteResult } from './model.js';

/**
 * Body for a GraphHopper `POST /route` request. Geometry comes back as plain
 * GeoJSON coordinates (`points_encoded: false`) with elevation as the third
 * ordinate; turn instructions are off until navigation (Phase 7) needs them.
 */
export function buildRouteRequest(query: RouteQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {
    profile: query.profile,
    points: query.points.map((p) => [p.lng, p.lat]),
    elevation: true,
    points_encoded: false,
    instructions: false,
    locale: 'en',
  };
  if (query.roundTrip) {
    body['algorithm'] = 'round_trip';
    body['round_trip.distance'] = Math.round(query.roundTrip.distanceM);
    body['round_trip.seed'] = query.roundTrip.seed ?? 0;
  } else if (query.alternatives && query.points.length === 2) {
    body['algorithm'] = 'alternative_route';
    body['alternative_route.max_paths'] = 3;
  }
  return body;
}

/** The subset of a GraphHopper route response Atlas consumes. */
interface GraphHopperResponse {
  paths?: {
    distance?: number;
    time?: number;
    ascend?: number;
    descend?: number;
    points?: { coordinates?: number[][] };
    bbox?: number[];
  }[];
}

/**
 * Map a GraphHopper route response to a RouteResult. Throws on a shape that
 * doesn't look like a successful response (no usable paths).
 */
export function parseRouteResponse(json: unknown): RouteResult {
  const paths = (json as GraphHopperResponse)?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('routing response contains no paths');
  }
  const result: RoutePath[] = [];
  for (const path of paths) {
    const coordinates = path.points?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const points: TrackPoint[] = coordinates.map(([lng, lat, ele]) => {
      const p: TrackPoint = { lat: lat!, lng: lng! };
      if (typeof ele === 'number') p.ele = Math.round(ele * 10) / 10;
      return p;
    });
    const [west, south, east, north] = path.bbox ?? [];
    result.push({
      points,
      distanceM: path.distance ?? 0,
      timeMs: path.time ?? 0,
      ascentM: path.ascend ?? 0,
      descentM: path.descend ?? 0,
      bbox:
        west !== undefined && south !== undefined && east !== undefined && north !== undefined
          ? { sw: { lat: south, lng: west }, ne: { lat: north, lng: east } }
          : undefined,
    });
  }
  if (result.length === 0) throw new Error('routing response contains no usable paths');
  return { paths: result };
}
