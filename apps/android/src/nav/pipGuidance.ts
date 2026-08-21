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
  /** Street/maneuver detail yields first; ETA is retained at every width. */
  showDetail: boolean;
  /**
   * Put the arrival clock on its own line under the turn, instead of beside it.
   * A portrait window is narrow, and a single row of arrow · distance · clock
   * simply runs off the edge there — the clock, being last, is what falls off.
   */
  stack: boolean;
}

/**
 * Type and spacing for the guidance strip of a mini window of the given size (dp).
 *
 * The user resizes this window — pinch it larger and the strip has to use the
 * room rather than float a 12 px line along the bottom of it. Everything scales
 * off the window's *shorter* dimension, since a PiP window keeps its aspect
 * ratio: that is what decides how much of it guidance may take before the map
 * underneath stops being a map.
 *
 * Both shapes have to work. Atlas asks for 3:4, which Android hands back at
 * roughly 110x147 dp — deliberately taller than the old 16:9 letterbox, and so
 * narrow that the row has to become two lines to keep the clock. A pinch
 * upwards, or an older window still on the previous shape, is wider than it is
 * tall and stays a single row.
 */
export function pipCardMetrics(width: number, height: number, fontScale = 1): PipCardMetrics {
  // 0 at a ~90 dp-tall window, 1 at ~220 dp — the range Android's PiP allows.
  const room = Math.max(0, Math.min(1, (Math.min(height, width * 0.75) - 90) / 130));
  const at = (small: number, large: number) => Math.round(small + (large - small) * room);
  const safeFontScale = Math.max(1, Math.min(1.3, fontScale));
  const footer = at(10, 13);
  // Arrow, distance and clock side by side need about 170 dp before the clock
  // starts running past the right edge; below that the clock drops to a second
  // line, which costs its own type height plus the breathing room under it.
  // Only in a window with height to spend, though: a short wide one has no
  // second line to give, and would buy the clock by taking it from the map.
  const stack = width < 190 && height > width;
  const gap = at(8, 12);
  const baseHeight = at(40, 66) + (stack ? footer + gap : 0);
  return {
    icon: at(22, 34),
    headline: at(15, 24),
    detail: at(11, 15),
    footer,
    padding: at(8, 12),
    gap,
    // Respect large text without letting guidance consume the map. The Text
    // nodes use the same 1.3 cap, so this height and their actual glyphs agree.
    height: Math.max(
      36,
      Math.min(Math.round(baseHeight * safeFontScale), Math.floor(height * 0.48)),
    ),
    // The mini window answers two questions: "what is next?" and "when will I
    // arrive?" The road/maneuver wording is useful context, but it yields in
    // the smallest window so the arrival clock never does.
    showDetail: width >= 250,
    stack,
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
