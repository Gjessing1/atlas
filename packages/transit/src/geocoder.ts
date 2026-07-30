import { haversineM, type LatLng, type SearchResult } from '@atlas/core';

/**
 * The Pelias-shaped subset returned by Entur's Geocoder. Atlas deliberately
 * asks for the `venue` layer only: those are NSR stops. Addresses still come
 * from Photon and are merged after these results by
 * {@link mergeTransitSearchResults}.
 */
interface EnturGeocoderFeature {
  geometry?: { type?: unknown; coordinates?: unknown };
  properties?: {
    id?: unknown;
    name?: unknown;
    label?: unknown;
    layer?: unknown;
    category?: unknown;
    locality?: unknown;
    county?: unknown;
  };
}

const STOP_ID = /^[A-Z0-9_-]+:StopPlace:[A-Za-z0-9_-]+$/;
const LINE_ID = /^[A-Z0-9_-]+:Line:[A-Za-z0-9_.:-]+$/;
const CATEGORY_LABEL: Record<string, string> = {
  onstreetBus: 'Bus',
  busStation: 'Bus',
  coachStation: 'Coach',
  onstreetTram: 'Tram',
  tramStation: 'Tram',
  railStation: 'Train',
  metroStation: 'Metro',
  harbourPort: 'Ferry',
  ferryPort: 'Ferry',
  ferryStop: 'Ferry',
  airport: 'Airport',
  liftStation: 'Lift',
  vehicleRailInterchange: 'Interchange',
};

/** Whether a string is a bounded, syntactically valid NSR-style StopPlace id. */
export function isTransitStopId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && STOP_ID.test(value);
}

/**
 * Whether a string is a bounded, syntactically valid line id. Codespaces vary
 * more than for stops — `RUT:Line:280`, `BRA:Line:4_6071`, `VYG:Line:RE10` —
 * so this checks the shape a saved commute may send upstream, nothing more.
 */
export function isTransitLineId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && LINE_ID.test(value);
}

function resultLabel(properties: NonNullable<EnturGeocoderFeature['properties']>): string {
  const name = typeof properties.name === 'string' ? properties.name : '';
  let place = '';
  if (typeof properties.label === 'string') {
    const label = properties.label.trim();
    const prefix = `${name}, `;
    if (label.startsWith(prefix)) place = label.slice(prefix.length);
    else if (label !== name) place = label;
  }
  if (!place) {
    const parts: string[] = [];
    for (const part of [properties.locality, properties.county]) {
      if (typeof part === 'string' && part !== name && !parts.includes(part)) parts.push(part);
    }
    place = parts.join(', ');
  }
  const modes = Array.isArray(properties.category)
    ? properties.category.flatMap((value) =>
        typeof value === 'string' && CATEGORY_LABEL[value] ? [CATEGORY_LABEL[value]] : [],
      )
    : [];
  return [...new Set(modes), ...(place ? [place] : [])].join(' · ') || 'Public transport stop';
}

/**
 * Convert an untrusted Entur autocomplete answer into Atlas search results.
 * Non-stop features, malformed coordinates and identifiers are dropped: an
 * exact-stop query is only better than coordinate snapping when the id is real.
 */
export function parseEnturGeocoderResponse(body: unknown): SearchResult[] {
  if (!body || typeof body !== 'object') return [];
  const features = (body as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];

  return features.flatMap((raw): SearchResult[] => {
    if (!raw || typeof raw !== 'object') return [];
    const feature = raw as EnturGeocoderFeature;
    const coordinates = feature.geometry?.coordinates;
    const properties = feature.properties;
    if (
      feature.geometry?.type !== 'Point' ||
      !Array.isArray(coordinates) ||
      typeof coordinates[0] !== 'number' ||
      typeof coordinates[1] !== 'number' ||
      !Number.isFinite(coordinates[0]) ||
      !Number.isFinite(coordinates[1]) ||
      Math.abs(coordinates[0]) > 180 ||
      Math.abs(coordinates[1]) > 90 ||
      !properties ||
      properties.layer !== 'venue' ||
      typeof properties.name !== 'string' ||
      !properties.name.trim() ||
      !isTransitStopId(properties.id)
    ) {
      return [];
    }
    const category = Array.isArray(properties.category)
      ? properties.category.find((value): value is string => typeof value === 'string')
      : undefined;
    return [
      {
        name: properties.name,
        label: resultLabel(properties),
        position: { lat: coordinates[1], lng: coordinates[0] },
        kind: category ? `public_transport/${category}` : 'public_transport/stop',
        transitStopId: properties.id,
      },
    ];
  });
}

function samePlace(a: SearchResult, b: SearchResult): boolean {
  return (
    a.name.trim().toLocaleLowerCase() === b.name.trim().toLocaleLowerCase() &&
    haversineM(a.position, b.position) < 250
  );
}

/**
 * Rank Entur stops above Photon addresses while suppressing the duplicate OSM
 * station Photon commonly returns a few metres from the NSR stop. Distinct
 * places with the same name survive when they are farther apart.
 */
export function mergeTransitSearchResults(
  stops: readonly SearchResult[],
  general: readonly SearchResult[],
  limit = 8,
): SearchResult[] {
  const exactStops = stops.filter((result) => isTransitStopId(result.transitStopId));
  const addresses = general.filter((result) => !exactStops.some((stop) => samePlace(stop, result)));
  return [...exactStops, ...addresses].slice(0, Math.max(0, Math.trunc(limit)));
}

export interface TransitStopSearchQuery {
  text: string;
  limit?: number;
  bias?: LatLng | null;
}
