import { TransitError, parseEnturResponse } from './entur.js';
import { transitCoverage } from './model.js';
import type { TransitQuery, TransitResult } from './model.js';

export interface FetchTransitOptions {
  /** Origin of the Atlas backend; defaults to same-origin (browser). */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
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
