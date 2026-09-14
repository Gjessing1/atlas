import type { LatLng } from '@atlas/core';

import type { TrafficSituation } from './datex.js';

export interface TrafficClosure {
  id: string;
  position: LatLng;
  /** NPRA's Norwegian message, intentionally never translated. */
  message: string;
  /** Official road identifier (`E18`, `F1270`, …), when published. */
  roadNumber?: string;
  /** Exact affected stretch from DATEX; absent on older/point-only records. */
  roadGeometry?: LatLng[];
}

export interface TrafficFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
      id: string;
      kind: TrafficSituation['kind'];
      severity: TrafficSituation['severity'];
      message: string;
      location: string;
      startTime: string;
      endTime: string;
      markerColor: string;
      symbol: string;
    };
  }>;
}

const EARTH_RADIUS_M = 6_371_000;

interface RouteProjection {
  distanceM: number;
  dx: number;
  dy: number;
}

const ROUTE_CELL_DEG = 0.005;

interface TrafficRouteIndex {
  points: readonly LatLng[];
  cells: Map<string, number[]>;
  cellLngDeg: number;
}

const routeCellKey = (row: number, column: number): string => `${row}:${column}`;

/** Bucket a route's segments once so every closure sample scans only nearby road. */
function indexTrafficRoute(points: readonly LatLng[]): TrafficRouteIndex {
  const midLat = points[Math.floor(points.length / 2)]?.lat ?? 60;
  const cosLat = Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const cellLngDeg = ROUTE_CELL_DEG / cosLat;
  const cells = new Map<string, number[]>();
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const rowFrom = Math.floor(Math.min(start.lat, end.lat) / ROUTE_CELL_DEG);
    const rowTo = Math.floor(Math.max(start.lat, end.lat) / ROUTE_CELL_DEG);
    const columnFrom = Math.floor(Math.min(start.lng, end.lng) / cellLngDeg);
    const columnTo = Math.floor(Math.max(start.lng, end.lng) / cellLngDeg);
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let column = columnFrom; column <= columnTo; column++) {
        const key = routeCellKey(row, column);
        const bucket = cells.get(key);
        if (bucket) bucket.push(index);
        else cells.set(key, [index]);
      }
    }
  }
  return { points, cells, cellLngDeg };
}

/** Nearest routed segment and its local-metre direction from one point. */
function projectToTrafficRoute(point: LatLng, route: readonly LatLng[]): RouteProjection {
  if (route.length === 0) return { distanceM: Infinity, dx: 0, dy: 0 };
  if (route.length === 1) {
    const only = route[0]!;
    const y = ((only.lat - point.lat) * Math.PI * EARTH_RADIUS_M) / 180;
    const x =
      ((only.lng - point.lng) * Math.PI * EARTH_RADIUS_M * Math.cos((point.lat * Math.PI) / 180)) /
      180;
    return { distanceM: Math.hypot(x, y), dx: 0, dy: 0 };
  }
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  const xy = (p: LatLng) => ({
    x: ((p.lng - point.lng) * Math.PI * EARTH_RADIUS_M * cosLat) / 180,
    y: ((p.lat - point.lat) * Math.PI * EARTH_RADIUS_M) / 180,
  });
  let best: RouteProjection = { distanceM: Infinity, dx: 0, dy: 0 };
  for (let index = 1; index < route.length; index++) {
    const a = xy(route[index - 1]!);
    const b = xy(route[index]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const denom = dx * dx + dy * dy;
    const t = denom === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / denom));
    const distanceM = Math.hypot(a.x + t * dx, a.y + t * dy);
    if (distanceM < best.distanceM) best = { distanceM, dx, dy };
  }
  return best;
}

/** Nearest routed segment among the grid cells surrounding a closure sample. */
function projectToIndexedTrafficRoute(point: LatLng, route: TrafficRouteIndex): RouteProjection {
  const row = Math.floor(point.lat / ROUTE_CELL_DEG);
  const column = Math.floor(point.lng / route.cellLngDeg);
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  let best: RouteProjection = { distanceM: Infinity, dx: 0, dy: 0 };
  for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
    for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
      const segments = route.cells.get(routeCellKey(row + rowOffset, column + columnOffset)) ?? [];
      for (const index of segments) {
        const start = route.points[index - 1]!;
        const end = route.points[index]!;
        const ax = (start.lng - point.lng) * cosLat;
        const ay = start.lat - point.lat;
        const dx = (end.lng - start.lng) * cosLat;
        const dy = end.lat - start.lat;
        const denom = dx * dx + dy * dy;
        const t = denom === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom));
        const distanceM = Math.hypot(ax + t * dx, ay + t * dy) * 111_320;
        if (distanceM < best.distanceM) best = { distanceM, dx, dy };
      }
    }
  }
  return best;
}

/** Distance from one WGS84 point to a route polyline, in local tangent metres. */
export function distanceToTrafficRouteM(point: LatLng, route: readonly LatLng[]): number {
  return projectToTrafficRoute(point, route).distanceM;
}

const ROAD_MATCH_DISTANCE_M = 12;
const ROAD_SAMPLE_M = 20;
const MIN_ALIGNMENT = Math.cos(Math.PI / 4);

interface RoadMatch {
  distanceM: number;
  position: LatLng;
}

/**
 * Match the affected DATEX road geometry rather than its label/display point.
 *
 * Every 20 m sample has to be both close to and broadly parallel with the
 * routed line. Distance rejects the neighbouring carriageway or parallel road;
 * alignment rejects a road that merely crosses at the display point. Requiring
 * up to 30 m of overlap keeps one coincident junction vertex from closing an
 * otherwise unrelated route.
 */
function roadMatch(geometry: readonly LatLng[], route: TrafficRouteIndex): RoadMatch | null {
  let totalM = 0;
  let matchedM = 0;
  let best: RoadMatch | null = null;
  for (let index = 1; index < geometry.length; index++) {
    const start = geometry[index - 1]!;
    const end = geometry[index]!;
    const meanLat = (start.lat + end.lat) / 2;
    const dy = ((end.lat - start.lat) * Math.PI * EARTH_RADIUS_M) / 180;
    const dx =
      ((end.lng - start.lng) * Math.PI * EARTH_RADIUS_M * Math.cos((meanLat * Math.PI) / 180)) /
      180;
    const lengthM = Math.hypot(dx, dy);
    if (lengthM === 0) continue;
    totalM += lengthM;
    const steps = Math.max(1, Math.ceil(lengthM / ROAD_SAMPLE_M));
    const pieceM = lengthM / steps;
    for (let step = 0; step < steps; step++) {
      const t = (step + 0.5) / steps;
      const position = {
        lat: start.lat + (end.lat - start.lat) * t,
        lng: start.lng + (end.lng - start.lng) * t,
      };
      const projected = projectToIndexedTrafficRoute(position, route);
      const routeLength = Math.hypot(projected.dx, projected.dy);
      const alignment =
        routeLength === 0
          ? 0
          : Math.abs((dx * projected.dx + dy * projected.dy) / lengthM / routeLength);
      if (projected.distanceM <= ROAD_MATCH_DISTANCE_M && alignment >= MIN_ALIGNMENT) {
        matchedM += pieceM;
        if (!best || projected.distanceM < best.distanceM) {
          best = { distanceM: projected.distanceM, position };
        }
      }
    }
  }
  const requiredM = Math.min(30, totalM / 2);
  return best && matchedM >= requiredM ? best : null;
}

/** Active closures actually touching a routed line, nearest first and Valhalla-capped. */
export function closuresNearRoute(
  closures: readonly TrafficClosure[],
  route: readonly LatLng[],
  maxDistanceM = 75,
  limit = 50,
): TrafficClosure[] {
  const indexedRoute = indexTrafficRoute(route);
  return closures
    .map((closure) => {
      if (closure.roadGeometry && closure.roadGeometry.length >= 2) {
        const match = roadMatch(closure.roadGeometry, indexedRoute);
        if (!match) return null;
        // The national GML line is matching input, not client payload. Only the
        // point Valhalla should exclude crosses the API boundary.
        const { roadGeometry: _roadGeometry, ...summary } = closure;
        return { closure: { ...summary, position: match.position }, distance: match.distanceM };
      }
      // Point-only records are few, and the public maxDistanceM parameter can
      // exceed one grid cell. Keep the exact scan for this explicit fallback.
      const distance = distanceToTrafficRouteM(closure.position, route);
      return distance <= maxDistanceM ? { closure, distance } : null;
    })
    .filter((match): match is { closure: TrafficClosure; distance: number } => match !== null)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ closure }) => closure);
}

const visual = (kind: TrafficSituation['kind']): { markerColor: string; symbol: string } => {
  switch (kind) {
    case 'closure':
      return { markerColor: '#dc2626', symbol: '×' };
    case 'incident':
      return { markerColor: '#ea580c', symbol: '!' };
    case 'roadworks':
      return { markerColor: '#d97706', symbol: '◆' };
    case 'restriction':
      return { markerColor: '#7c3aed', symbol: '!' };
  }
};

/** Compact, display-ready GeoJSON for both MapLibre clients. */
export function trafficFeatureCollection(
  situations: readonly TrafficSituation[],
): TrafficFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: situations.map((situation) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [situation.position.lng, situation.position.lat],
      },
      properties: {
        id: situation.id,
        kind: situation.kind,
        severity: situation.severity,
        message: situation.message,
        location: situation.location,
        startTime: situation.startTime,
        endTime: situation.endTime,
        ...visual(situation.kind),
      },
    })),
  };
}
