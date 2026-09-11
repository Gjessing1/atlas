/**
 * The navigation diagnostic log's vocabulary — one place that decides what a
 * trip records, so the writing half and the reading half (`navlog.ts`) cannot
 * drift apart.
 *
 * Three things shape everything here, all measured on a real 6878-line drive:
 *
 *  1. **A log is per trip.** One append-only file lost the drive a report was
 *     actually about, because the next trip's rotation check or a Settings
 *     Clear had already taken it. Trips are therefore bracketed by
 *     `trip-start` / `trip-end` records, and the platform sink turns those
 *     brackets into files.
 *  2. **Every event says why it happened.** `route-request` used to carry the
 *     query and nothing else, so first-fix, off-route, closure, faster-probe
 *     and accepted-offer were indistinguishable; and `active-route` fired on
 *     object identity, so a traffic re-price that swapped in *identical*
 *     geometry looked exactly like a route change. Hence {@link NavRouteReason}
 *     and {@link routeFingerprint}.
 *  3. **Bytes are the retention budget.** 57 % of the old file was
 *     `navigation-state` repeating the upcoming maneuver's full text and all
 *     four verbal strings on every line, and route geometry was logged twice.
 *     {@link compactNavState} references maneuvers by index and rounds every
 *     number to the precision the number actually has; {@link NavRouteLedger}
 *     stores each geometry once behind its digest.
 *
 * Nothing in this module performs I/O or knows what a file is: the platform
 * supplies a {@link NavDiagnosticsSink} and decides where records go.
 */

import type { LatLng } from '@atlas/core';
import type { RoutePath } from '@atlas/routing';

import type { NavFix, NavMatchTrace, NavState, NavStatus, Position } from './model.js';

/** One line of the log. `event` names the record; the rest is its payload. */
export interface NavDiagnosticRecord {
  event: string;
  [key: string]: unknown;
}

/**
 * Where records go. Deliberately fire-and-forget and synchronous from the
 * caller's side: navigation must never wait on, or fail because of, its own
 * diagnostics.
 */
export type NavDiagnosticsSink = (record: NavDiagnosticRecord) => void;

/**
 * Why a route was asked for. The 3-minute faster-route cadence used to be the
 * only way to guess this from a log, and it guessed wrong whenever two causes
 * landed in the same window.
 */
export type NavRouteReason =
  /** Start: the choices the preview card offers. */
  | 'preview'
  /** The preview card's profile switch re-asked for the same trip. */
  | 'preview-profile'
  /** Go: refreshing the choices from a fresh fix before departing. */
  | 'depart-refresh'
  /** Picking an interrupted trip back up. */
  | 'resume'
  /** The matcher reported off-route and this profile reroutes automatically. */
  | 'off-route'
  /** The traveller tapped Reroute (walking modes' off-route offer). */
  | 'reroute-requested'
  /** A stop was inserted into the running trip. */
  | 'add-stop'
  /** The traveller declared the next intermediate stop done. */
  | 'continue-past-stop'
  /** A DATEX closure appeared on the line being followed. */
  | 'closure-ahead'
  /** The periodic "is there anything better" probe. */
  | 'faster-probe'
  /** The driver tapped one of the alternate lines already drawn on the map. */
  | 'alternative-selected';

/** What ended a trip — the difference between a completed drive and an abandoned one. */
export type NavTripOutcome =
  /** The destination was reached (automatically or by "I've arrived"). */
  | 'arrived'
  /** End was pressed before arriving — a partial trip, and still worth reading. */
  | 'ended-early'
  /** Setup failed: no fix, no route, no permission. */
  | 'failed'
  /** The process died mid-trip; discovered by the next launch, not by the app. */
  | 'interrupted';

/** Enough of a route to recognise it again without storing it twice. */
export interface NavRouteFingerprint {
  /** Stable digest of the geometry — equal digests mean the same line. */
  digest: string;
  distanceM: number;
  timeMs: number;
  maneuvers: number;
}

/** Round to `places` decimals, keeping `null`/non-finite honest rather than 0. */
function round(value: number | null | undefined, places: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/** 6 decimals ≈ 0.1 m — finer than any receiver, and half the bytes of a raw double. */
function coord(point: LatLng | null | undefined): [number, number] | null {
  if (!point) return null;
  const lat = round(point.lat, 6);
  const lng = round(point.lng, 6);
  return lat === null || lng === null ? null : [lat, lng];
}

/**
 * A stable short digest of a route's geometry.
 *
 * FNV-1a over the rounded coordinates: not a cryptographic hash and not meant
 * to be one — it exists so two records can say "the same line" and so the log
 * stores each line once. Hermes has no Web Crypto without a polyfill, and this
 * runs on the phone.
 */
export function routeDigest(points: readonly LatLng[]): string {
  let hash = 0x811c9dc5;
  for (const point of points) {
    const text = `${point.lat.toFixed(6)},${point.lng.toFixed(6)};`;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  // Length participates too: a prefix of another route must not collide with it.
  hash ^= points.length;
  hash = Math.imul(hash, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function routeFingerprint(path: RoutePath): NavRouteFingerprint {
  return {
    digest: routeDigest(path.points),
    distanceM: Math.round(path.distanceM),
    timeMs: Math.round(path.timeMs),
    maneuvers: path.instructions?.length ?? 0,
  };
}

/**
 * Remembers which route geometries this trip has already written down.
 *
 * The old log carried the calculated route (341 KiB over 11 lines) and then
 * the adopted copy of the same line again (180 KiB). A ledger per trip means
 * every distinct line is stored exactly once and every later mention is eight
 * hex characters.
 */
export class NavRouteLedger {
  private readonly seen = new Set<string>();

  /**
   * Fingerprint `path`, and hand back the geometry to log *only* the first
   * time this trip has seen it.
   */
  note(path: RoutePath): { fingerprint: NavRouteFingerprint; geometry: NavRouteGeometry | null } {
    const fingerprint = routeFingerprint(path);
    if (this.seen.has(fingerprint.digest)) return { fingerprint, geometry: null };
    this.seen.add(fingerprint.digest);
    return { fingerprint, geometry: routeGeometry(path, fingerprint.digest) };
  }
}

/** A route stored once per digest: the line, and the instruction table by index. */
export interface NavRouteGeometry {
  digest: string;
  distanceM: number;
  timeMs: number;
  /** `[lat, lng]` pairs, rounded to 6 decimals. */
  points: [number, number][];
  instructions: {
    text: string;
    sign: number;
    streetName?: string;
    distanceM: number;
    timeMs: number;
    interval: [number, number];
  }[];
}

function routeGeometry(path: RoutePath, digest: string): NavRouteGeometry {
  return {
    digest,
    distanceM: Math.round(path.distanceM),
    timeMs: Math.round(path.timeMs),
    points: path.points.flatMap((p) => {
      const pair = coord(p);
      return pair ? [pair] : [];
    }),
    instructions: (path.instructions ?? []).map((instruction) => ({
      text: instruction.text,
      sign: instruction.sign,
      ...(instruction.streetName ? { streetName: instruction.streetName } : {}),
      distanceM: Math.round(instruction.distanceM),
      timeMs: Math.round(instruction.timeMs),
      interval: instruction.interval,
    })),
  };
}

/** The per-fix record's payload: what the state was, at the precision it has. */
export interface CompactNavState {
  status: NavStatus;
  fix: NavFix;
  /** `[lat, lng]` of the drawn position and of the raw fix. */
  snapped: [number, number] | null;
  raw: [number, number] | null;
  offRouteM: number | null;
  traveledM: number | null;
  remainingM: number | null;
  remainingMs: number;
  trafficMs: number;
  /** The maneuver being approached, by index into the route's instruction table. */
  upcoming: [number, number] | null;
  then: [number, number] | null;
  road: string | null;
  limitKph: number | null;
  tunnelM: number | null;
  courseDeg: number | null;
  departed: boolean;
  viasPassed: number;
  wrongBranch: boolean;
  /** Present only while a section-control stretch is being driven. */
  sectionAvgKph?: number | null;
}

/**
 * The loggable projection of a nav state.
 *
 * Every maneuver becomes `[index, distance]` because the route's instruction
 * table is written once per trip and this references it — the single change
 * that turns 1.79 KB per line into a few hundred bytes, since a `navigation-state`
 * line used to repeat the upcoming maneuver's full text and all four of
 * Valhalla's verbal strings once a second for the whole drive.
 */
export function compactNavState(state: NavState): CompactNavState {
  return {
    status: state.status,
    fix: state.fix,
    snapped: coord(state.snapped),
    raw: coord(state.raw),
    offRouteM: round(state.offRouteM, 1),
    traveledM: round(state.traveledM, 1),
    remainingM: round(state.distanceRemainingM, 1),
    remainingMs: Math.round(state.timeRemainingMs),
    trafficMs: Math.round(state.trafficDelayMs),
    upcoming: state.upcoming
      ? [state.upcoming.index, round(state.upcoming.distanceToM, 1) ?? 0]
      : null,
    then: state.then ? [state.then.index, round(state.then.distanceToM, 1) ?? 0] : null,
    road: state.currentRoad,
    limitKph: state.speedLimitKph,
    tunnelM: state.tunnel ? round(state.tunnel.remainingM, 0) : null,
    courseDeg: round(state.courseDeg, 1),
    departed: state.departed,
    viasPassed: state.viasPassed,
    wrongBranch: state.wrongBranch,
    ...(state.sectionControl ? { sectionAvgKph: state.sectionControl.avgKph } : {}),
  };
}

/** The matcher trace, at the precision it has. */
export function compactMatchTrace(match: NavMatchTrace): Record<string, unknown> {
  return {
    alongM: round(match.alongM, 1),
    seg: match.segmentIndex,
    crossM: round(match.crossTrackM, 1),
    accM: round(match.accuracyM, 1),
    accurate: match.accurate,
    headingDeg: round(match.headingDeg, 1),
    tangentDeg: round(match.tangentDeg, 1),
    divergenceDeg: round(match.headingDivergenceDeg, 1),
    offRouteCount: match.offRouteCount,
    wrongWayCount: match.wrongWayCount,
    grace: match.graceUpdates,
    progressStalled: match.progressStalled,
    stallMs: Math.round(match.stallDurationMs),
    stallGroundM: round(match.stallGroundM, 1),
    stallProgressM: round(match.stallProgressM, 1),
    corridorM: match.corridorM,
    wrongWayDeg: match.wrongWayDeg,
    snapCorridorM: match.snapCorridorM,
    snapped: match.snapped,
    reckonArmed: match.reckonArmed,
    ...(match.inRoundabout ? { inRoundabout: true } : {}),
  };
}

/** The raw fix, at the precision it has — what the receiver actually said. */
export function compactPosition(position: Position): Record<string, unknown> {
  return {
    at: coord(position),
    accM: round(position.accuracyM, 1),
    speedMps: round(position.speedMps, 2),
    headingDeg: round(position.headingDeg, 1),
    altitudeM: round(position.altitudeM, 1),
  };
}

/**
 * What a trip amounted to — the record that triages a drive without parsing
 * every line of it.
 *
 * All of it is measured from the states the session actually produced, so the
 * numbers answer the questions a report starts with: was the receiver working,
 * did the matcher hold the line, how much of the drive was spent off-route or
 * recalculating.
 */
export interface NavTripReport {
  /** States seen, and the wall-clock span they cover. */
  samples: number;
  durationMs: number;
  /** Distance the session measured along its routes (banked across reroutes). */
  distanceM: number;
  /** Time the trip spent reporting off-route. */
  offRouteMs: number;
  /** Time without a live fix — dead reckoning plus outright signal loss. */
  noLiveFixMs: number;
  reckonedMs: number;
  lostMs: number;
  /** Share (0..1) of states whose drawn position was glued to the route. */
  snappedShare: number;
  /** Routes adopted after the first one: reroutes, accepted offers, stop changes. */
  routeChanges: number;
  /** Route requests that failed outright. */
  routeFailures: number;
  /** Voice prompts the session emitted (whether or not they were audible). */
  prompts: number;
  /** Moments the traveller marked by hand. */
  markers: number;
  /** Gaps between consecutive states longer than {@link FIX_GAP_MS}. */
  fixGaps: number;
  maxFixGapMs: number;
  worstAccuracyM: number | null;
  maxOffRouteM: number;
}

/** A gap this long between states is worth counting as a gap, not as jitter. */
export const FIX_GAP_MS = 3000;

/**
 * The little of a state a trip report actually needs.
 *
 * Named as its own shape so the accumulator has exactly one input, whether it
 * is fed live from a {@link NavState} during the drive ({@link navTripSample})
 * or rebuilt afterwards from the compacted records in a log
 * ({@link navTripSampleFromLog}) — a trip the process died in never wrote a
 * `trip-end`, and its summary has to come from the lines that did survive.
 */
export interface NavTripSample {
  status: NavStatus;
  fix: NavFix;
  traveledM: number;
  offRouteM: number;
  /** Whether the drawn position was glued to the route rather than the raw fix. */
  snapped: boolean;
  accuracyM: number | null;
}

/** The live half: what the session just produced, plus the fix's own accuracy. */
export function navTripSample(state: NavState, accuracyM: number | null = null): NavTripSample {
  return {
    status: state.status,
    fix: state.fix,
    traveledM: state.traveledM,
    offRouteM: state.offRouteM,
    // The session moved the drawn position off the raw fix onto the line —
    // which is the question, and needs no second copy of the corridor rules.
    snapped: state.snapped.lat !== state.raw.lat || state.snapped.lng !== state.raw.lng,
    accuracyM,
  };
}

/** The rebuilt half: the same sample, read back out of a logged record. */
export function navTripSampleFromLog(
  state: CompactNavState,
  accuracyM: number | null = null,
): NavTripSample {
  const snapped = state.snapped;
  const raw = state.raw;
  return {
    status: state.status,
    fix: state.fix,
    traveledM: state.traveledM ?? 0,
    offRouteM: state.offRouteM ?? 0,
    snapped: snapped !== null && raw !== null && (snapped[0] !== raw[0] || snapped[1] !== raw[1]),
    accuracyM,
  };
}

/**
 * Accumulates a trip report as the trip happens.
 *
 * Deliberately fed from the states rather than from the raw fixes: what a
 * report needs to say is what *guidance* experienced — how long it had no live
 * position, how long it believed itself off-route — and only the state knows
 * that. One instance per trip; the platform hands the result to `trip-end`.
 */
export class NavTripStats {
  private samples = 0;
  private firstAtMs: number | null = null;
  private lastAtMs: number | null = null;
  private distanceM = 0;
  private offRouteMs = 0;
  private reckonedMs = 0;
  private lostMs = 0;
  private snappedSamples = 0;
  /** Routes adopted, including the one the trip departed on. */
  private adoptions = 0;
  private routeFailures = 0;
  private prompts = 0;
  private markers = 0;
  private fixGaps = 0;
  private maxFixGapMs = 0;
  private worstAccuracyM: number | null = null;
  private maxOffRouteM = 0;
  /** Distance banked from routes that have already been replaced. */
  private bankedM = 0;
  private lastStatus: NavStatus | null = null;
  private lastFixKind: NavFix | null = null;

  /**
   * One produced state. `atMs` is wall clock, so the durations below stay
   * honest across the session's own monotonic clamping.
   */
  sample(sample: NavTripSample, atMs: number): void {
    this.samples++;
    if (this.firstAtMs === null) this.firstAtMs = atMs;
    const previousMs = this.lastAtMs;
    this.lastAtMs = atMs;
    this.distanceM = this.bankedM + sample.traveledM;
    if (sample.offRouteM > this.maxOffRouteM) this.maxOffRouteM = sample.offRouteM;
    const accuracyM = sample.accuracyM;
    if (accuracyM !== null && Number.isFinite(accuracyM)) {
      if (this.worstAccuracyM === null || accuracyM > this.worstAccuracyM) {
        this.worstAccuracyM = accuracyM;
      }
    }
    if (sample.snapped) this.snappedSamples++;
    if (previousMs !== null) {
      const dtMs = Math.max(0, atMs - previousMs);
      // Attribute the interval to the condition that held *during* it.
      if (this.lastStatus === 'off-route') this.offRouteMs += dtMs;
      if (this.lastFixKind === 'estimated') this.reckonedMs += dtMs;
      if (this.lastFixKind === 'lost') this.lostMs += dtMs;
      if (dtMs > FIX_GAP_MS) {
        this.fixGaps++;
        if (dtMs > this.maxFixGapMs) this.maxFixGapMs = dtMs;
      }
    }
    this.lastStatus = sample.status;
    this.lastFixKind = sample.fix;
  }

  /** A new route was adopted; adjust for distance that the new session does not own. */
  routeAdopted(accountingAdjustmentM: number): void {
    this.adoptions++;
    // Usually this is the outgoing session's distance. It may be negative when
    // the replacement still contains more of the already-driven prefix than
    // the old route did; preserving that sign prevents diagnostic totals from
    // counting the shared road twice.
    this.bankedM += accountingAdjustmentM;
  }

  routeFailed(): void {
    this.routeFailures++;
  }

  promptEmitted(count = 1): void {
    this.prompts += count;
  }

  markerAdded(): void {
    this.markers++;
  }

  report(): NavTripReport {
    const durationMs =
      this.firstAtMs === null || this.lastAtMs === null ? 0 : this.lastAtMs - this.firstAtMs;
    return {
      samples: this.samples,
      durationMs,
      distanceM: Math.round(this.distanceM),
      offRouteMs: Math.round(this.offRouteMs),
      noLiveFixMs: Math.round(this.reckonedMs + this.lostMs),
      reckonedMs: Math.round(this.reckonedMs),
      lostMs: Math.round(this.lostMs),
      snappedShare: this.samples === 0 ? 0 : this.snappedSamples / this.samples,
      // The route departed on is not a change; everything after it is.
      routeChanges: Math.max(0, this.adoptions - 1),
      routeFailures: this.routeFailures,
      prompts: this.prompts,
      markers: this.markers,
      fixGaps: this.fixGaps,
      maxFixGapMs: Math.round(this.maxFixGapMs),
      worstAccuracyM: this.worstAccuracyM === null ? null : Math.round(this.worstAccuracyM),
      maxOffRouteM: Math.round(this.maxOffRouteM),
    };
  }
}
