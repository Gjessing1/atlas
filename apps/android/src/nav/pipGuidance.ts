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
