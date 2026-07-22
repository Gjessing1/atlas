/**
 * Route-panel presentation: the words a planned route is described with, and
 * the shape of a candidate stop.
 *
 * Web and Android each render the route panel with their own markup, but they
 * must *say* the same things — "+3 min via E18", "B", "+<1 min detour". These
 * lived as byte-identical copies in both panels until they were pulled here;
 * copies of a label are copies that eventually disagree.
 */

import { fmtDuration } from './format.js';
import type { LatLng } from './geo.js';

/** Alternative chip: the fastest shows its duration, others their extra minutes. */
export function altChipLabel(
  paths: readonly { timeMs: number }[],
  i: number,
  vias: readonly (string | null)[],
): string {
  const extraMin = Math.round((paths[i]!.timeMs - paths[0]!.timeMs) / 60000);
  const head =
    i === 0 ? fmtDuration(paths[0]!.timeMs) : extraMin < 1 ? '+<1 min' : `+${extraMin} min`;
  const via = vias[i];
  return via ? `${head} via ${via}` : head;
}

/**
 * Compact trip time for a mode chip: the duration, "—" when the mode can't
 * route this plan, or "…" while the background pass is still routing it.
 */
export function modeTimeLabel(t: number | 'none' | undefined): string {
  if (t === undefined) return '…';
  if (t === 'none') return '—';
  return fmtDuration(t);
}

/** Waypoint label, matching the map markers: A, B, C… (⟳ for a round trip). */
export function waypointLabel(index: number, roundTrip: boolean, count: number): string {
  if (roundTrip || count === 1) return '⟳';
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * What a stop row says it is. Lettered markers match the map pins and are right
 * for a multi-stop road route, but they are a riddle on the two-stop journey
 * people actually plan — "A" does not tell you it is where you are leaving
 * from. So the ends are named outright whenever there are only two of them,
 * which is also the only shape transit supports.
 */
export function stopRole(index: number, count: number, roundTrip: boolean): string | null {
  if (roundTrip || count !== 2) return null;
  return index === 0 ? 'From' : 'To';
}

/** What a stop is called: its looked-up name, or coordinates when it has none. */
export function stopTitle(w: { pos: LatLng; name?: string }): string {
  return w.name ?? `${w.pos.lat.toFixed(4)}, ${w.pos.lng.toFixed(4)}`;
}

/** How much longer the trip gets by calling at a candidate stop. */
export function detourLabel(timeMs: number): string {
  if (timeMs < 60_000) return '+<1 min';
  return `+${Math.round(timeMs / 60_000)} min`;
}

/** A candidate stop offered by the route planner's search. */
export interface StopHit {
  name: string;
  label: string;
  position: LatLng;
  /** True for the user's saved places — listed first, marked with a star. */
  saved: boolean;
}

/** A candidate stop that has been costed against the selected route. */
export interface AlongRouteHit extends StopHit {
  /** Insert before this waypoint, preserving the route's visiting order. */
  insertIndex: number;
  extraTimeMs: number;
  extraDistanceM: number;
}

/**
 * Identity of a candidate stop for de-duplication: a saved place and the
 * geocoder's row for the same door are the same stop, and the list should
 * offer it once. Five decimals is ~1 m — close enough to be the same door,
 * far enough apart to keep neighbours distinct.
 */
export const stopHitKey = (hit: StopHit): string =>
  `${hit.position.lat.toFixed(5)}/${hit.position.lng.toFixed(5)}`;
