import { TransitError, parseEnturDeparturesResponse, parseEnturResponse } from './entur.js';
import type { LatLng, SearchResult } from '@atlas/core';
import { transitCoverage, transitCoversPoint } from './model.js';
import type {
  TransitDeparturesQuery,
  TransitDeparturesResult,
  TransitCommuteQuery,
  TransitCommuteResult,
  TransitQuery,
  TransitResult,
  TransitStopLines,
} from './model.js';

export interface FetchTransitOptions {
  /** Origin of the Atlas backend; defaults to same-origin (browser). */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface FetchTransitStopsOptions extends FetchTransitOptions {
  limit?: number;
  bias?: LatLng | null;
}

/**
 * Search Entur's National Stop Register through Atlas's identifying proxy.
 * Results carry `transitStopId`, which must stay attached to the selected route
 * waypoint so the subsequent journey query can use the exact StopPlace.
 */
export async function fetchTransitStops(
  text: string,
  opts: FetchTransitStopsOptions = {},
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: text });
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.bias) {
    params.set('lat', String(opts.bias.lat));
    params.set('lon', String(opts.bias.lng));
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? ''}/api/transit/stops?${params}`, {
    signal: opts.signal,
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json !== null && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `stop search failed (HTTP ${res.status})`;
    throw new TransitError(message, res.status);
  }
  if (
    !json ||
    typeof json !== 'object' ||
    !Array.isArray((json as { results?: unknown }).results)
  ) {
    return [];
  }
  return (json as { results: SearchResult[] }).results;
}

/**
 * Ask the Atlas backend (`/api/transit`) to plan a public transport journey.
 * The backend owns the Entur endpoint, the `ET-Client-Name` header and the rate
 * limit; this side only knows the Atlas query and trip model.
 *
 * Throws `TransitError` when the planner is unreachable or refuses the query,
 * and passes AbortError through so callers can drop superseded requests. An
 * empty `trips` array is a *successful* answer meaning "nothing runs then".
 */
export async function fetchTransitTrips(
  query: TransitQuery,
  opts: FetchTransitOptions = {},
): Promise<TransitResult> {
  // Fail fast rather than spending a round trip to learn what the bounding box
  // already knows — and give the caller the reason, not an empty list that
  // looks like "no departures".
  if (!transitCoverage(query.from, query.to)) {
    throw new TransitError('public transport is available for journeys within Norway only');
  }
  if (query.via?.some((place) => !transitCoversPoint(place))) {
    throw new TransitError('public transport is available for journeys within Norway only');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? ''}/api/transit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal: opts.signal,
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json !== null && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `journey planning failed (HTTP ${res.status})`;
    throw new TransitError(message, res.status);
  }
  // The backend already speaks the Atlas model; parse defensively anyway so a
  // half-shaped payload becomes an empty result rather than a render crash.
  return json !== null && typeof json === 'object' && 'trips' in json
    ? (json as TransitResult)
    : parseEnturResponse(json);
}

/**
 * Fetch the next hour at an exact NSR stop or, for coordinate-only targets,
 * the nearest stop within walking distance. This is intentionally separate
 * from journey planning: no destination is required and no `RoutePath` exists.
 */
export async function fetchTransitDepartures(
  query: TransitDeparturesQuery,
  opts: FetchTransitOptions = {},
): Promise<TransitDeparturesResult> {
  if (!transitCoversPoint(query)) {
    throw new TransitError('departure boards are available within Norway only');
  }
  const params = new URLSearchParams({
    lat: String(query.lat),
    lon: String(query.lng),
  });
  if (query.stopId) params.set('stopId', query.stopId);
  if (query.startTimeMs !== undefined) params.set('startTimeMs', String(query.startTimeMs));
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? ''}/api/transit/departures?${params}`, {
    signal: opts.signal,
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json !== null && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `departure board failed (HTTP ${res.status})`;
    throw new TransitError(message, res.status);
  }
  return json !== null && typeof json === 'object' && 'departures' in json
    ? (json as TransitDeparturesResult)
    : parseEnturDeparturesResponse(json);
}

/**
 * Every line calling at one stop, for the commute editor's line picker. A
 * stop's line set changes with the timetable rather than the minute, so this is
 * the one transit answer worth caching for hours.
 */
export async function fetchTransitStopLines(
  stopId: string,
  opts: FetchTransitOptions = {},
): Promise<TransitStopLines> {
  const params = new URLSearchParams({ stopId });
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? ''}/api/transit/stop-lines?${params}`, {
    signal: opts.signal,
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json !== null && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `stop lines failed (HTTP ${res.status})`;
    throw new TransitError(message, res.status);
  }
  if (!json || typeof json !== 'object' || !Array.isArray((json as { lines?: unknown }).lines)) {
    return { stop: null, lines: [] };
  }
  return json as TransitStopLines;
}

/** Fetch the saved commute's upcoming journeys in both directions. */
export async function fetchTransitCommute(
  query: TransitCommuteQuery,
  opts: FetchTransitOptions = {},
): Promise<TransitCommuteResult> {
  const places = [query.from, ...query.via, query.to];
  if (places.some((place) => !transitCoversPoint(place))) {
    throw new TransitError('public transport is available for journeys within Norway only');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? ''}/api/transit/commute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal: opts.signal,
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json !== null && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `commute board failed (HTTP ${res.status})`;
    throw new TransitError(message, res.status);
  }
  if (!json || typeof json !== 'object' || !('outbound' in json) || !('inbound' in json)) {
    throw new TransitError('commute board returned an invalid response');
  }
  return json as TransitCommuteResult;
}
