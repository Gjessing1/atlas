/**
 * Route-panel presentation: the words a planned route is described with, and
 * the shape of a candidate stop.
 *
 * Web and Android each render the route panel with their own markup, but they
 * must *say* the same things — "+3 min via E18", "B", "at 42 km". These
 * lived as byte-identical copies in both panels until they were pulled here;
 * copies of a label are copies that eventually disagree.
 */

import { fmtCompactDuration, fmtDuration, fmtKm } from './format.js';
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

/** Compact relative ETA for an in-navigation route badge. */
export function routeDeltaLabel(deltaMs: number): string {
  const absoluteMs = Math.abs(deltaMs);
  if (absoluteMs < 30_000) return 'Same ETA';
  if (absoluteMs < 60_000) return deltaMs > 0 ? '+<1 min' : '−<1 min';
  const minutes = Math.round(absoluteMs / 60_000);
  return `${deltaMs > 0 ? '+' : '−'}${minutes} min`;
}

/**
 * Compact trip time for a mode chip: the duration, "—" when the mode can't
 * route this plan, or "…" while the background pass is still routing it.
 */
export function modeTimeLabel(t: number | 'none' | undefined): string {
  if (t === undefined) return '…';
  if (t === 'none') return '—';
  return fmtCompactDuration(t);
}

/**
 * Waypoint label, matching the map markers: A, B, C… — or ⟳ for a loop with
 * nothing but its anchor, where there is no order to letter.
 *
 * A loop *through* planned stops letters them like any other route: they are
 * visited in that order, and a column of identical ⟳ marks would say nothing
 * about which one comes first.
 */
export function waypointLabel(index: number, roundTrip: boolean, count: number): string {
  if (count === 1) return '⟳';
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

/**
 * Where a candidate stop sits on the trip: how far into the route you meet it.
 * "At the start" rather than "at 0 m" — a place beside the first stop is not a
 * distance, and a rounded zero reads as a bug.
 */
export function stopAlongLabel(alongM: number): string {
  return alongM < 100 ? 'at the start' : `at ${fmtKm(alongM)}`;
}

/** A candidate stop offered by the route planner's search. */
export interface StopHit {
  name: string;
  label: string;
  position: LatLng;
  /** True for the user's saved places — listed first, marked with a star. */
  saved: boolean;
  /** Exact Entur/NSR stop selected, when this was a public-transport result. */
  transitStopId?: string;
}
