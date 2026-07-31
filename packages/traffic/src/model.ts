import type { LatLng } from '@atlas/core';

import type { TrafficSituation } from './datex.js';

export interface TrafficClosure {
  id: string;
  position: LatLng;
  /** NPRA's Norwegian message, intentionally never translated. */
  message: string;
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

/** Distance from one WGS84 point to a route polyline, in local tangent metres. */
export function distanceToTrafficRouteM(point: LatLng, route: readonly LatLng[]): number {
  if (route.length === 0) return Infinity;
  if (route.length === 1) {
    const only = route[0]!;
    const y = ((only.lat - point.lat) * Math.PI * EARTH_RADIUS_M) / 180;
    const x =
      ((only.lng - point.lng) * Math.PI * EARTH_RADIUS_M * Math.cos((point.lat * Math.PI) / 180)) /
      180;
    return Math.hypot(x, y);
  }
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  const xy = (p: LatLng) => ({
    x: ((p.lng - point.lng) * Math.PI * EARTH_RADIUS_M * cosLat) / 180,
    y: ((p.lat - point.lat) * Math.PI * EARTH_RADIUS_M) / 180,
  });
  let best = Infinity;
  for (let i = 1; i < route.length; i++) {
    const a = xy(route[i - 1]!);
    const b = xy(route[i]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const denom = dx * dx + dy * dy;
    const t = denom === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / denom));
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

/** Active closures actually touching a routed line, nearest first and Valhalla-capped. */
export function closuresNearRoute(
  closures: readonly TrafficClosure[],
  route: readonly LatLng[],
  maxDistanceM = 75,
  limit = 50,
): TrafficClosure[] {
  return closures
    .map((closure) => ({ closure, distance: distanceToTrafficRouteM(closure.position, route) }))
    .filter(({ distance }) => distance <= maxDistanceM)
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
