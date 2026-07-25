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

/** How big the mini window's parts are drawn at the size the system gave it. */
export interface PipCardMetrics {
  /** Turn arrow edge length. */
  icon: number;
  /** Distance-to-maneuver type size — the one thing readable at a glance. */
  headline: number;
  /** Street/maneuver line. */
  detail: number;
  /** ETA row. */
  footer: number;
  padding: number;
  gap: number;
  /** False in the shortest windows, where the ETA row costs the street name. */
  showFooter: boolean;
}

/**
 * Type and spacing for a mini window of the given size (dp).
 *
 * The user resizes this window — pinch it larger and the card has to use the
 * room rather than float a 17 px line in the middle of it, which is what a
 * fixed-size strip did. Everything scales off the window's *height*, since a
 * PiP window keeps its aspect ratio: width follows, and height is what decides
 * whether a second line fits at all.
 */
export function pipCardMetrics(width: number, height: number): PipCardMetrics {
  // 0 at a ~90 dp-tall window, 1 at ~220 dp — the range Android's PiP allows.
  const room = Math.max(0, Math.min(1, (Math.min(height, width * 0.75) - 90) / 130));
  const at = (small: number, large: number) => Math.round(small + (large - small) * room);
  return {
    icon: at(38, 76),
    headline: at(26, 48),
    detail: at(13, 20),
    footer: at(12, 17),
    padding: at(10, 18),
    gap: at(10, 18),
    showFooter: height >= 104,
  };
}

/**
 * The guidance that fits a picture-in-picture window: the turn arrow, how far to
 * it, and what it is. No lanes, no widgets, no speed roundel, no controls — at
 * ~150 dp tall anything more is unreadable, and a control that small is one the
 * driver would hit by accident.
 *
 * A trip that ends while the window is up says so: an "arrived" or "stopped"
 * card is honest, where a frozen last maneuver would read as live guidance.
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
