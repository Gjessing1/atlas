import type { NavController } from '@atlas/app-hooks';
import { fmtClock, fmtDistanceM } from '@atlas/core';
import { shortManeuverText } from '@atlas/navigation';
import { formatExitSign, type RouteInstruction } from '@atlas/routing';

/** What the mini window shows. Nothing here is interactive — the window is a glance. */
export interface PipGuidance {
  /** Maneuver to draw a turn arrow for, or null when there is nothing to point at. */
  instruction: RouteInstruction | { sign: number } | null;
  /** Lead line: distance to the maneuver, or a state word. */
  headline: string;
  /** Second line: the maneuver, road or state detail. */
  detail: string | null;
  /** Arrival clock and distance left, or null outside active guidance. */
  footer: string | null;
  /** True once the trip is over or broken — the window stops implying guidance. */
  ended: boolean;
}

/** How big the mini window's guidance strip is drawn at the size the system gave it. */
export interface PipCardMetrics {
  /** Turn arrow edge length. */
  icon: number;
  /** Distance-to-maneuver type size — the one thing readable at a glance. */
  headline: number;
  /** Street/maneuver line. */
  detail: number;
  /** Arrival clock. */
  footer: number;
  padding: number;
  gap: number;
  /** Height (dp) the strip occupies along the bottom of the window. */
  height: number;
  /** False in the narrowest windows, where the clock costs the street name. */
  showFooter: boolean;
}

/**
 * Type and spacing for the guidance strip of a mini window of the given size (dp).
 *
 * The user resizes this window — pinch it larger and the strip has to use the
 * room rather than float a 12 px line along the bottom of it. Everything scales
 * off the window's *height*, since a PiP window keeps its aspect ratio: width
 * follows, and height is what decides how much of it guidance may take before
 * the map underneath stops being a map.
 */
export function pipCardMetrics(width: number, height: number): PipCardMetrics {
  // 0 at a ~90 dp-tall window, 1 at ~220 dp — the range Android's PiP allows.
  const room = Math.max(0, Math.min(1, (Math.min(height, width * 0.75) - 90) / 130));
  const at = (small: number, large: number) => Math.round(small + (large - small) * room);
  return {
    icon: at(22, 34),
    headline: at(15, 24),
    detail: at(11, 15),
    footer: at(10, 13),
    padding: at(8, 12),
    gap: at(8, 12),
    height: at(40, 66),
    // The clock is the first thing to go: it is the one line the driver can
    // reconstruct, and a cramped row that truncates the street name is worse.
    showFooter: width >= 240,
  };
}

/**
 * The guidance that fits the strip along the bottom of a picture-in-picture
 * window: the turn arrow, how far to it, what it is, and the arrival clock. No
 * lanes, no widgets, no speed roundel, no controls — at ~150 dp tall anything
 * more is unreadable, and a control that small is one the driver would hit by
 * accident.
 *
 * A trip that ends while the window is up says so: an "arrived" or "stopped"
 * strip is honest, where a frozen last maneuver would read as live guidance.
 */
export function pipGuidance(
  nav: Pick<NavController, 'phase' | 'state' | 'tripSummary' | 'error'>,
): PipGuidance {
  const { state } = nav;
  if (nav.phase === 'arrived') {
    return {
      instruction: null,
      headline: 'Arrived',
      detail: nav.tripSummary ? fmtDistanceM(nav.tripSummary.distanceM) : null,
      footer: null,
      ended: true,
    };
  }
  if (nav.phase === 'error') {
    return {
      instruction: null,
      headline: 'Navigation stopped',
      detail: nav.error ?? null,
      footer: null,
      ended: true,
    };
  }
  if (nav.phase === 'starting') {
    return {
      instruction: null,
      headline: 'Finding route…',
      detail: null,
      footer: null,
      ended: false,
    };
  }
  if (nav.phase === 'idle' || nav.phase === 'preview' || !state) {
    return {
      instruction: null,
      headline: 'Atlas',
      detail: 'Tap to open',
      footer: null,
      ended: true,
    };
  }

  const footer = `${fmtClock(state.etaEpochMs)} · ${fmtDistanceM(state.distanceRemainingM)}`;
  const maneuver = state.upcoming;
  // A long leg with its turn still far off: lead with the road being driven,
  // exactly as the full banner does.
  if (state.sustain) {
    return {
      instruction: { sign: 0 },
      headline: fmtDistanceM(state.sustain.distanceRemainingM),
      detail: state.sustain.road,
      footer,
      ended: false,
    };
  }
  if (!maneuver) {
    return {
      instruction: null,
      headline: nav.phase === 'rerouting' ? 'Rerouting…' : fmtDistanceM(state.distanceRemainingM),
      detail: state.currentRoad,
      footer,
      ended: false,
    };
  }
  const exit = maneuver.instruction.exitSign ? formatExitSign(maneuver.instruction.exitSign) : null;
  return {
    instruction: maneuver.instruction,
    headline: fmtDistanceM(maneuver.distanceToM),
    detail: exit
      ? `${shortManeuverText(maneuver.instruction)} · ${exit}`
      : shortManeuverText(maneuver.instruction),
    footer,
    ended: false,
  };
}
