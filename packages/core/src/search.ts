/** Search results: the app-level shape, coordinate queries, Photon mapping. */

import { round } from './round.js';
import type { LatLng } from './geo.js';

/** A geocoding result in app terms, decoupled from the Photon wire format. */
export interface SearchResult {
  /** Primary display name, e.g. "Preikestolen". */
  name: string;
  /** Disambiguation line: street, city, region, country. */
  label: string;
  position: LatLng;
  /** OSM key/value, e.g. "tourism/attraction" — drives result icons later. */
  kind?: string;
}

/**
 * Parse a search query that is nothing but a coordinate pair, in decimal
 * degrees: "59.9139, 10.7522", "59.9139 10.7522", optional hemisphere letters
 * before or after each number ("N 59.9139 E 10.7522", "59.9139S, 10.7522W")
 * and optional degree signs. Latitude always comes first. Null when the text
 * isn't a pure coordinate pair or is out of range — geocoding proceeds then.
 */
export function parseCoordinateQuery(text: string): LatLng | null {
  const m =
    /^\s*([NS])?\s*([+-]?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*([EW])?\s*([+-]?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EW])?\s*$/i.exec(
      text,
    );
  if (!m) return null;
  const [, latPre, latRaw, latPost, lngPre, lngRaw, lngPost] = m;
  // At most one hemisphere letter per number (prefix or suffix, not both).
  if ((latPre && latPost) || (lngPre && lngPost)) return null;
  const hemi = (raw: string, letter: string | undefined, negative: string): number | null => {
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    if (!letter) return value;
    if (value < 0) return null; // "-59.9 S" is contradictory
    return letter.toUpperCase() === negative ? -value : value;
  };
  const lat = hemi(latRaw!, latPre || latPost, 'S');
  const lng = hemi(lngRaw!, lngPre || lngPost, 'W');
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * The SearchResult for a query parsed by {@link parseCoordinateQuery} — shared
 * so web and Android present typed-in coordinates identically.
 */
export function coordinateSearchResult(p: LatLng): SearchResult {
  return {
    name: `${round(p.lat, 5)}, ${round(p.lng, 5)}`,
    label: 'Coordinates',
    position: { lat: p.lat, lng: p.lng },
  };
}

/** The subset of a Photon GeoJSON feature Atlas consumes. */
export interface PhotonFeature {
  geometry?: { type?: string; coordinates?: number[] };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_key?: string;
    osm_value?: string;
  };
}

/**
 * Map a Photon geocoding feature to a SearchResult, or null when the feature
 * has no usable point geometry or name. The label collects the address parts
 * that aren't already the name, most specific first.
 */
export function photonFeatureToSearchResult(feature: PhotonFeature): SearchResult | null {
  const [lng, lat] = feature.geometry?.coordinates ?? [];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;

  const p = feature.properties ?? {};
  const street = p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street;
  const name = p.name || street;
  if (!name) return null;

  const labelParts: string[] = [];
  for (const part of [street, p.city, p.state, p.country]) {
    if (part && part !== name && !labelParts.includes(part)) labelParts.push(part);
  }

  return {
    name,
    label: labelParts.join(', '),
    position: { lat, lng },
    kind: p.osm_key && p.osm_value ? `${p.osm_key}/${p.osm_value}` : undefined,
  };
}

/**
 * Match saved places against a search query — the route planner's stop search
 * shows these alongside geocoder results so a favorite can be picked directly
 * as a stop. Case-insensitive; whole-name prefix matches rank first, then
 * word-prefix and substring matches, in the input order.
 */
export function matchPlacesByName<T extends { name: string }>(
  places: T[],
  query: string,
  limit = 5,
): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const prefix: T[] = [];
  const rest: T[] = [];
  for (const place of places) {
    const name = place.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(place);
    else if (name.includes(q)) rest.push(place);
  }
  return [...prefix, ...rest].slice(0, limit);
}

/** The minimum a saved place needs to be findable from the search box. */
export interface SearchablePlace {
  name: string;
  lat: number;
  lng: number;
  /** Free text the user attached — today that is where they paste addresses. */
  notes?: string;
}

/** Label a saved place carries in a result list, so its origin is obvious. */
export const SAVED_PLACE_LABEL = 'Saved place';

/**
 * The user's own saved places as search results, for the main search box.
 *
 * A geocoder cannot answer "where is that place I saved as *Bogdan og Ada*" —
 * the name means something to this user and nothing to OSM — so a query that
 * only ever went to Photon could never find it. Matching locally also means
 * favourites keep resolving with no network at all.
 *
 * Notes are searched after names because that is where addresses currently get
 * pasted; a name match always outranks a notes match.
 */
export function savedPlaceResults<T extends SearchablePlace>(
  places: T[],
  query: string,
  limit = 4,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const byName = matchPlacesByName(places, q, limit);
  const seen = new Set<T>(byName);
  const byNotes: T[] = [];
  if (byName.length < limit) {
    for (const place of places) {
      if (seen.has(place)) continue;
      if (place.notes?.toLowerCase().includes(q)) byNotes.push(place);
      if (byName.length + byNotes.length === limit) break;
    }
  }
  return [...byName, ...byNotes].map((p) => ({
    name: p.name,
    label: SAVED_PLACE_LABEL,
    position: { lat: p.lat, lng: p.lng },
  }));
}
