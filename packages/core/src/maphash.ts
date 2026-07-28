/** The share-link codec: a map view (camera, pin, route plan) as a URL hash. */

import { round } from './round.js';
import type { LatLng } from './geo.js';

/**
 * A route plan in shareable form: the stops the user placed, not the routed
 * geometry — the recipient re-routes them. Stop labels are deliberately left
 * out; they would dominate the URL and the coordinates are the plan.
 *
 * `profile` stays a plain string here because core knows nothing about the
 * routing engine; the app validates it against its own profile list.
 */
export interface RoutePlanState {
  profile: string;
  points: LatLng[];
  /** Round-trip loop length in km — set when the plan comes home to its start. */
  roundTripKm?: number;
  roundTripDirection?: 'either' | 'clockwise' | 'counterclockwise';
}

/** Shareable map view: camera position, an optional dropped pin, an optional route plan. */
export interface MapViewState {
  center: LatLng;
  zoom: number;
  pin?: LatLng;
  route?: RoutePlanState;
}

/**
 * Encode a map view as a URL hash, e.g. `#map=12.3/59.91384/10.75234` with an
 * optional `&pin=<lat>/<lng>` and an optional
 * `&route=<profile>/<lat>,<lng>/<lat>,<lng>…` (plus `&loop=<km>` for a round
 * trip). Coordinates keep 5 decimals (~1 m).
 */
export function encodeMapHash(state: MapViewState): string {
  const c = state.center;
  let hash = `#map=${round(state.zoom, 2)}/${round(c.lat, 5)}/${round(c.lng, 5)}`;
  if (state.pin) hash += `&pin=${round(state.pin.lat, 5)}/${round(state.pin.lng, 5)}`;
  const plan = state.route;
  if (plan && plan.points.length > 0 && /^[a-z_-]+$/.test(plan.profile)) {
    const points = plan.points.map((p) => `${round(p.lat, 5)},${round(p.lng, 5)}`).join('/');
    hash += `&route=${plan.profile}/${points}`;
    if (plan.roundTripKm !== undefined) {
      hash += `&loop=${round(plan.roundTripKm, 2)}`;
      if (plan.roundTripDirection && plan.roundTripDirection !== 'either') {
        hash += `&loopdir=${plan.roundTripDirection === 'clockwise' ? 'cw' : 'ccw'}`;
      }
    }
  }
  return hash;
}

/** Parse the `&route=…`/`&loop=…` part of a hash; null when absent/malformed. */
function decodeRoutePlan(hash: string): RoutePlanState | null {
  const match = /[#&]route=([a-z_-]+)((?:\/-?[0-9.]+,-?[0-9.]+)+)/.exec(hash);
  if (!match) return null;
  const points: LatLng[] = [];
  for (const pair of match[2]!.split('/').filter(Boolean)) {
    const [lat, lng] = pair.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    points.push({ lat: lat!, lng: lng! });
  }
  if (points.length === 0) return null;

  const plan: RoutePlanState = { profile: match[1]!, points };
  const loopMatch = /[#&]loop=([0-9.]+)/.exec(hash);
  if (loopMatch) {
    const km = Number(loopMatch[1]);
    // The points are the places the loop goes by way of, however many: a shared
    // "40 km ride past the lake" must reopen as that ride, not as a line out to
    // the lake with the loop silently dropped.
    if (Number.isFinite(km) && km > 0) plan.roundTripKm = km;
    const direction = /[#&]loopdir=(cw|ccw)/.exec(hash)?.[1];
    if (direction) {
      plan.roundTripDirection = direction === 'cw' ? 'clockwise' : 'counterclockwise';
    }
  }
  return plan;
}

/** Parse a `#map=…` hash produced by {@link encodeMapHash}; null when absent/malformed. */
export function decodeMapHash(hash: string): MapViewState | null {
  const match = /(?:^|[#&])map=([0-9.-]+)\/([0-9.-]+)\/([0-9.-]+)/.exec(hash);
  if (!match) return null;
  const [zoom, lat, lng] = match.slice(1).map(Number);
  if (![zoom, lat, lng].every(Number.isFinite)) return null;

  const state: MapViewState = { center: { lat: lat!, lng: lng! }, zoom: zoom! };
  const pinMatch = /[#&]pin=([0-9.-]+)\/([0-9.-]+)/.exec(hash);
  if (pinMatch) {
    const [pinLat, pinLng] = pinMatch.slice(1).map(Number);
    if (Number.isFinite(pinLat) && Number.isFinite(pinLng)) {
      state.pin = { lat: pinLat!, lng: pinLng! };
    }
  }
  const plan = decodeRoutePlan(hash);
  if (plan) state.route = plan;
  return state;
}

/**
 * Parse a full shared/deep-link URL into a map view. Accepts every form Atlas
 * produces or registers: `https://…/#map=…` (web share links) and
 * `atlas://map=…` / `atlas:#map=…` (the Android scheme). Null when the URL
 * carries no `map=` fragment.
 */
export function decodeMapLink(url: string): MapViewState | null {
  const hashIndex = url.indexOf('#');
  // No explicit hash: treat everything after the scheme as the fragment, so
  // `atlas://map=…` parses like `#map=…`.
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '#' + url.replace(/^[a-z+.-]+:\/{0,2}/i, '');
  return decodeMapHash(hash);
}
