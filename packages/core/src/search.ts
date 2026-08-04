/** Search results: the app-level shape, coordinate queries, Photon mapping. */

import { round } from './round.js';
import type { LatLng } from './geo.js';

/** A geocoding result in app terms, decoupled from the Photon wire format. */
export interface SearchResult {
  /** Primary display name, e.g. "Preikestolen". */
  name: string;
  /** Disambiguation line: street, city, region, country. */
  label: string;
  /** Full address suitable for saving separately from the display name. */
  address?: string;
  position: LatLng;
  /** OSM key/value, e.g. "tourism/attraction" — drives result icons later. */
  kind?: string;
  /** Distance from a browse/explore centre; ordinary text search leaves it absent. */
  distanceM?: number;
  /**
   * Stable NSR StopPlace id when this result came from Entur's stop search.
   * Ordinary addresses and saved places remain coordinate-only. Keeping the id
   * beside the coordinate lets the transit planner board the exact stop the
   * traveller chose instead of asking Entur to guess the nearest one again.
   */
  transitStopId?: string;
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
    /** Norway: the fylke. Absent for Oslo, which is its own. */
    county?: string;
    state?: string;
    country?: string;
    osm_key?: string;
    osm_value?: string;
  };
}

/**
 * "1384 Asker" — postcode and place written the way an address is written, not
 * as two comma-separated fields. `skip` drops the place when it would only
 * repeat the result's own name, leaving the postcode to stand alone.
 */
function postalLine(postcode?: string, city?: string, skip?: string): string {
  return [postcode, city === skip ? undefined : city].filter(Boolean).join(' ');
}

/**
 * Map a Photon geocoding feature to a SearchResult, or null when the feature
 * has no usable point geometry or name. The label collects the address parts
 * that aren't already the name, most specific first.
 *
 * The postcode and the county are in the label rather than tucked away in
 * `address`, because they are what separates the street you typed from the
 * four others with that name: a query for `Alfheim 7 1387 Asker` matches
 * 1384, and a row that cannot show it looks like the hit the user asked for.
 */
export function photonFeatureToSearchResult(feature: PhotonFeature): SearchResult | null {
  const [lng, lat] = feature.geometry?.coordinates ?? [];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;

  const p = feature.properties ?? {};
  const street = p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street;
  const name = p.name || street;
  if (!name) return null;

  const labelParts: string[] = [];
  for (const part of [street, postalLine(p.postcode, p.city, name), p.county, p.state, p.country]) {
    if (part && part !== name && !labelParts.includes(part)) labelParts.push(part);
  }
  const addressParts: string[] = [];
  for (const part of [street, postalLine(p.postcode, p.city), p.county, p.state, p.country]) {
    if (part && !addressParts.includes(part)) addressParts.push(part);
  }

  return {
    name,
    label: labelParts.join(', '),
    ...(addressParts.length > 0 ? { address: addressParts.join(', ') } : {}),
    position: { lat, lng },
    kind: p.osm_key && p.osm_value ? `${p.osm_key}/${p.osm_value}` : undefined,
  };
}

/**
 * Collapse key for "one real-world place", used to drop the several OSM
 * objects Photon returns for one thing (peak + trail + viewpoint named alike).
 *
 * The postcode is deliberately *not* in the key, although it is now in the
 * label: one long street runs through several postal areas and Photon answers
 * with a feature per segment, so keying on the label would turn Karl Johans
 * gate into three rows that all lead to the same street.
 */
function placeKey(feature: PhotonFeature): string {
  const p = feature.properties ?? {};
  const street = p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street;
  return [p.name || street, p.city, p.county, p.state, p.country].map((v) => v ?? '').join('|');
}

/** A search query read as an address: what the user pinned down, and how to loosen it. */
export interface AddressQuery {
  /** The query as typed, trimmed — always the first thing asked. */
  query: string;
  /** A standalone four-digit token: a Norwegian postnummer. */
  postcode?: string;
  /** A token that starts with a digit and isn't the postcode — "57", "10A". */
  houseNumber?: string;
  /**
   * Progressively looser retries, most specific first, for a query that found
   * nothing. Empty when there is nothing to loosen.
   */
  fallbacks: string[];
}

/** Bare token, without the comma or period the user typed around it. */
const bare = (token: string): string => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Read a free-text query as an address, so a search that finds nothing can be
 * loosened rather than answered with "no results".
 *
 * Measured against the live Photon Norway index (2026-08-04): the house-number
 * level is present and fine — `Karl Johans gate 22` resolves — but adding the
 * postcode makes Photon prefer a postcode-matching *street* over the house,
 * and `Dælimosen 57, 1359 Eiksmarka` returns nothing at all while the street
 * alone resolves. So the two things worth dropping, in order, are the postcode
 * and then the house number; the street is what is left, and a street is an
 * honest answer to a house number OSM has never heard of.
 */
export function parseAddressQuery(text: string): AddressQuery {
  const query = text.trim();
  const tokens = query.split(/\s+/).filter(Boolean);
  let postcodeAt = -1;
  let houseAt = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = bare(tokens[i]!);
    if (postcodeAt === -1 && /^\d{4}$/.test(token)) postcodeAt = i;
    else if (houseAt === -1 && /^\d{1,4}[a-zA-Z]?$/.test(token)) houseAt = i;
  }
  const drop = (...indexes: number[]): string =>
    tokens.filter((_, i) => !indexes.includes(i)).join(' ');
  const fallbacks: string[] = [];
  // Never offer a fallback that is empty, or that is the query itself.
  const add = (candidate: string) => {
    if (candidate.trim().length > 0 && candidate !== query && !fallbacks.includes(candidate))
      fallbacks.push(candidate);
  };
  if (postcodeAt !== -1) add(drop(postcodeAt));
  if (houseAt !== -1) add(drop(postcodeAt, houseAt));
  return {
    query,
    ...(postcodeAt !== -1 ? { postcode: bare(tokens[postcodeAt]!) } : {}),
    ...(houseAt !== -1 ? { houseNumber: bare(tokens[houseAt]!) } : {}),
    fallbacks,
  };
}

/** "10" matches "10A"; "10A" does not match "10". */
function houseNumberMatches(featureNumber: string, typed: string): boolean {
  const a = featureNumber.toLowerCase();
  const b = typed.toLowerCase();
  return a === b || (a.startsWith(b) && /^[a-z]$/.test(a.slice(b.length)));
}

/**
 * Map a whole Photon response: drop unusable features, collapse duplicates of
 * one real-world place, and float the features that match what the user
 * actually pinned down.
 *
 * The ranking exists because Photon scores the postcode as just another term:
 * ask for `Karl Johans gate 22, 0159 Oslo` and three postcode-matching street
 * segments come back above the house. A typed house number is the most
 * specific thing in the query, so a feature carrying it outranks one that does
 * not, and a postcode match breaks the remaining ties. The sort is stable, so
 * within a tier Photon's own ranking survives untouched.
 *
 * Scoring happens *before* collapsing, and each group keeps its best-matching
 * member rather than the first one Photon happened to return — otherwise a
 * street answered as three postal segments could be collapsed onto a segment
 * two postcodes away from the one the user typed, which is precisely the
 * near-miss the label is there to make visible.
 */
export function photonSearchResults(
  features: PhotonFeature[],
  query?: AddressQuery | null,
): SearchResult[] {
  const groups = new Map<string, { result: SearchResult; score: number }>();
  for (const feature of features) {
    const result = photonFeatureToSearchResult(feature);
    if (!result) continue;
    const p = feature.properties ?? {};
    let score = 0;
    if (query?.houseNumber && p.housenumber && houseNumberMatches(p.housenumber, query.houseNumber))
      score += 2;
    if (query?.postcode && p.postcode === query.postcode) score += 1;
    const key = placeKey(feature);
    const kept = groups.get(key);
    if (!kept || score > kept.score) groups.set(key, { result, score });
  }
  return [...groups.values()].sort((a, b) => b.score - a.score).map((g) => g.result);
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
  /** First-class address captured from search or edited later. */
  address?: string;
  /** Free text the user attached. */
  notes?: string;
  /**
   * The labels the user (or the app) put on it. Searched because the app writes
   * them itself — `spotPlaceDraft()` tags every saved stand `hunt`/`spot`/
   * `stand` — and a vocabulary the app authors but cannot answer on is worse
   * than none: "show me my stands" was unanswerable in a product that had
   * already labelled them.
   */
  tags?: readonly string[];
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
 * Tags, address and notes are searched after names, in that order; a name match
 * always ranks first. Tags come before the two free-text fields because they
 * are a deliberate label rather than prose the query happened to land in.
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
  /** The next tier of matches, up to whatever the earlier tiers left of `limit`. */
  const tier = (matches: (place: T) => boolean, taken: number): T[] => {
    const found: T[] = [];
    if (taken >= limit) return found;
    for (const place of places) {
      if (seen.has(place)) continue;
      if (!matches(place)) continue;
      found.push(place);
      seen.add(place);
      if (taken + found.length === limit) break;
    }
    return found;
  };
  const byTag = tier(
    (p) => (p.tags ?? []).some((tag) => tag.toLowerCase().includes(q)),
    byName.length,
  );
  const byAddress = tier(
    (p) => (p.address ?? '').toLowerCase().includes(q),
    byName.length + byTag.length,
  );
  const byNotes = tier(
    (p) => (p.notes ?? '').toLowerCase().includes(q),
    byName.length + byTag.length + byAddress.length,
  );
  return [...byName, ...byTag, ...byAddress, ...byNotes].map((p) => ({
    name: p.name,
    label: p.address || SAVED_PLACE_LABEL,
    ...(p.address ? { address: p.address } : {}),
    position: { lat: p.lat, lng: p.lng },
  }));
}
