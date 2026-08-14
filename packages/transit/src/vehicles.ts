import { fmtClock, type OverlayIdentifyGroup } from '@atlas/core';

/** Geographic window sent to Entur's live-vehicle service. */
export interface TransitVehicleBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TransitVehicleFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: string;
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
      id: string;
      mode: string;
      line: string;
      lineName: string;
      destination: string;
      operator: string;
      delayS: number;
      occupancy: string;
      updatedAt: string;
      bearing: number;
      markerColor: string;
    };
  }>;
}

/** The smallest useful vehicle payload; every field is rendered or shown on tap. */
export const ENTUR_VEHICLES_QUERY = `query Vehicles($box:BoundingBox!){
 vehicles(boundingBox:$box,maxDataAge:"PT2M"){
  vehicleId mode line{lineName publicCode} operator{name} destinationName
  lastUpdated location{latitude longitude} bearing delay occupancyStatus
 }
}`;

/** Build a bounded request — a country-wide live feed is needlessly large on every refresh. */
export function buildEnturVehiclesRequest(bounds: TransitVehicleBounds): {
  query: string;
  variables: { box: { minLat: number; minLon: number; maxLat: number; maxLon: number } };
} {
  return {
    query: ENTUR_VEHICLES_QUERY,
    variables: {
      box: {
        minLat: bounds.south,
        minLon: bounds.west,
        maxLat: bounds.north,
        maxLon: bounds.east,
      },
    },
  };
}

/**
 * Atlas proxy URL for a viewport. Bounds expand to a 0.05° grid so nearby clients share the
 * backend/CDN's ten-second cache instead of turning every pixel of a pan into a unique live query.
 */
export function transitVehicleFeaturesUrl(
  baseUrl: string,
  bbox: readonly [number, number, number, number],
): string {
  const step = 0.05;
  const snapped = [
    Math.floor(bbox[0] / step) * step,
    Math.floor(bbox[1] / step) * step,
    Math.ceil(bbox[2] / step) * step,
    Math.ceil(bbox[3] / step) * step,
  ].map((value) => value.toFixed(2));
  return `${baseUrl}/api/overlay/transit-vehicles/features?bbox=${snapped.join(',')}`;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const finite = (value: unknown): number | null => {
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null;
};
const rounded = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const modeName = (value: unknown): string => {
  const mode = text(value).toLowerCase();
  return ['bus', 'rail', 'tram', 'metro', 'ferry', 'water', 'air'].includes(mode)
    ? mode
    : 'transit';
};

const markerColor = (mode: string): string => {
  switch (mode) {
    case 'bus':
      return '#2563eb';
    case 'rail':
      return '#7c3aed';
    case 'tram':
      return '#dc2626';
    case 'metro':
      return '#ea580c';
    case 'ferry':
    case 'water':
      return '#0891b2';
    case 'air':
      return '#475569';
    default:
      return '#64748b';
  }
};

/** Defensive GraphQL wire parse into compact display-ready GeoJSON. */
export function parseEnturVehiclesResponse(value: unknown): TransitVehicleFeatureCollection {
  const root = record(value);
  const data = record(root?.['data']);
  const rows = Array.isArray(data?.['vehicles']) ? data['vehicles'] : [];
  const features: TransitVehicleFeatureCollection['features'] = [];

  for (const raw of rows) {
    const vehicle = record(raw);
    const location = record(vehicle?.['location']);
    const lat = finite(location?.['latitude']);
    const lng = finite(location?.['longitude']);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;

    const id = text(vehicle?.['vehicleId']);
    if (!id) continue;
    const line = record(vehicle?.['line']);
    const operator = record(vehicle?.['operator']);
    const mode = modeName(vehicle?.['mode']);
    features.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [rounded(lng, 6), rounded(lat, 6)] },
      properties: {
        id,
        mode,
        line: text(line?.['publicCode']),
        lineName: text(line?.['lineName']),
        destination: text(vehicle?.['destinationName']),
        operator: text(operator?.['name']),
        delayS: Math.round(finite(vehicle?.['delay']) ?? 0),
        occupancy: text(vehicle?.['occupancyStatus']),
        updatedAt: text(vehicle?.['lastUpdated']),
        bearing: rounded(finite(vehicle?.['bearing']) ?? 0, 1),
        markerColor: markerColor(mode),
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

const occupancyLabel = (value: string): string | null => {
  const labels: Record<string, string> = {
    empty: 'Empty',
    manySeatsAvailable: 'Many seats available',
    fewSeatsAvailable: 'Few seats available',
    seatsAvailable: 'Seats available',
    standingRoomOnly: 'Standing room only',
    crushedStandingRoomOnly: 'Very crowded',
    full: 'Full',
    notAcceptingPassengers: 'Not accepting passengers',
    noData: 'Not reported',
  };
  return labels[value] ?? null;
};

/** The same tap card on both clients, built only from the properties already drawn. */
export function transitVehicleIdentify(
  properties: Record<string, unknown> | null | undefined,
): OverlayIdentifyGroup | null {
  if (!properties) return null;
  const mode = modeName(properties['mode']);
  const line = text(properties['line']);
  const lineName = text(properties['lineName']);
  const rows: Record<string, string> = {};
  if (lineName && lineName !== line) rows['Route'] = lineName;
  const destination = text(properties['destination']);
  if (destination) rows['Towards'] = destination;
  const delayS = finite(properties['delayS']);
  if (delayS !== null) {
    rows['Running'] =
      Math.abs(delayS) < 60
        ? 'On time'
        : delayS > 0
          ? `${Math.round(delayS / 60)} min late`
          : `${Math.round(Math.abs(delayS) / 60)} min early`;
  }
  const occupancy = occupancyLabel(text(properties['occupancy']));
  if (occupancy) rows['Occupancy'] = occupancy;
  const operator = text(properties['operator']);
  if (operator) rows['Operator'] = operator;
  const updatedAt = Date.parse(text(properties['updatedAt']));
  if (Number.isFinite(updatedAt)) rows['Position updated'] = fmtClock(updatedAt);
  const title = `${mode === 'transit' ? 'Transit' : mode[0]!.toUpperCase() + mode.slice(1)}${line ? ` ${line}` : ''}`;
  return { title, properties: rows };
}
