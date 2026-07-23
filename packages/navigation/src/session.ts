import type { LatLng } from '@atlas/core';
import {
  speedLimitKphAt,
  tunnelAt,
  tunnelNear,
  type RouteEnrichment,
  type RouteInstruction,
  type RouteLane,
  type RoutePath,
} from '@atlas/routing';

import { bearingDeg, cumulativeDistances, pointAtDistance, snapToRoute } from './geometry.js';
import {
  DEFAULT_NAV_OPTIONS,
  type NavigationOptions,
  type NavState,
  type NavUpdate,
  type Position,
  type SustainGuidance,
  type TunnelState,
  type UpcomingManeuver,
  type VoicePrompt,
} from './model.js';

interface Maneuver {
  instruction: RouteInstruction;
  index: number;
  /** Cumulative distance (m) along the route at which this maneuver occurs. */
  alongStartM: number;
  timeMs: number;
}

const EPS = 1e-6;
/** Smallest signed angle (deg, −180..180] equivalent to `d`. */
function wrapDeg(d: number): number {
  const w = ((d % 360) + 540) % 360;
  return w - 180 === -180 ? 180 : w - 180;
}
/** Fix-to-fix intervals longer than this are gaps, not pace evidence. */
const PACE_MAX_SAMPLE_MS = 30_000;
/** The pace factor's effect on the ETA, clamped: one red light must not triple it. */
const PACE_MIN = 0.4;
const PACE_MAX = 2;
/** Reckoned ticks (~s) the yaw divergence must persist before `wrongBranch`. */
const WRONG_BRANCH_GRACE_TICKS = 5;
/** Atlas turn code for a roundabout leg — both entering (26) and exiting (27). */
const ROUNDABOUT_SIGN = 6;

/** A time-derived warning distance, never tighter than the tuned fallback. */
function leadDistanceM(fallbackM: number, leadTimeS: number, speedMps: number | null): number {
  if (speedMps === null || !Number.isFinite(speedMps) || speedMps <= 0) return fallbackM;
  return Math.max(fallbackM, Math.round(speedMps * leadTimeS));
}

/** Human speech for the live distance at which a cue actually fired. */
function voiceDistance(distanceM: number): string {
  const d = Math.max(0, distanceM);
  if (d < 100) return `${Math.max(10, Math.round(d / 10) * 10)} meters`;
  if (d < 1000) return `${Math.round(d / 50) * 50} meters`;
  if (d < 10_000) {
    const km = Math.round(d / 100) / 10;
    return `${km} ${km === 1 ? 'kilometer' : 'kilometers'}`;
  }
  const km = Math.round(d / 1000);
  return `${km} ${km === 1 ? 'kilometer' : 'kilometers'}`;
}

/**
 * Follows a single planned route against a stream of position fixes, producing
 * the state a turn-by-turn UI renders (snapped position, next maneuver, ETA)
 * plus voice prompts and off-route detection. Platform-neutral: the app owns
 * the GPS source, TTS, and the decision to reroute when status is `off-route`.
 * Call `tick()` from a ~1 s timer as well — it bridges GPS gaps (tunnels) by
 * dead reckoning and reports signal loss when fixes stop.
 */
export class NavigationSession {
  private readonly points: LatLng[];
  private readonly cum: number[];
  private readonly totalM: number;
  private readonly totalTimeMs: number;
  private readonly maneuvers: Maneuver[];
  /** suffixTimeMs[i] = total instruction time of maneuvers after i. */
  private readonly suffixTimeMs: number[];
  private readonly opts: Required<NavigationOptions>;

  private offRouteCount = 0;
  /** Consecutive moving fixes whose heading opposes the route direction. */
  private wrongWayCount = 0;
  private arrived = false;
  /** When the vehicle first stopped inside `arrivalLoiterRadiusM`, else null. */
  private loiterSinceMs: number | null = null;
  /** True once the vehicle has demonstrably started driving (see NavState.departed). */
  private departed: boolean;
  /** alongM of the first fix, so progress can also prove departure. */
  private firstFixAlongM: number | null = null;
  private readonly firedPrompts = new Set<string>();
  /** Maneuver whose leg was current at the previous prompt collection. */
  private lastPromptManeuverIndex: number | null = null;
  /** alongM of the previous snap — continuity hint for the map matcher. */
  private lastAlongM: number | null = null;
  /** Timestamp / along-route anchor / speed of the last accepted fix. */
  private lastFixMs: number | null = null;
  private alongAtFixM: number | null = null;
  private lastSpeedMps: number | null = null;
  private lastState: NavState | null = null;
  /** Observed speed over the route's expected speed, smoothed (1 = on pace). */
  private paceFactor = 1;
  /** Sensor-measured heading change (deg) accumulated over the current GPS gap. */
  private yawActualDeg = 0;
  /** Route-tangent heading change (deg) over the same reckoned stretch. */
  private yawExpectedDeg = 0;
  /** Route course at the previous reckoned tick, to step yawExpectedDeg. */
  private reckonCourseDeg: number | null = null;
  /**
   * Road attributes along this route, attached whenever the enrichment call
   * resolves — which is after guidance starts, so it must be optional: the
   * driver is already moving while it is in flight.
   */
  private enrichment: RouteEnrichment | null = null;
  private wrongBranch = false;
  private wrongBranchAnnounced = false;
  /** Consecutive reckoned ticks with the divergence above threshold. */
  private wrongBranchTicks = 0;

  constructor(route: RoutePath, options: NavigationOptions = {}) {
    if (route.points.length === 0) throw new Error('cannot navigate an empty route');
    this.points = route.points.map((p) => ({ lat: p.lat, lng: p.lng }));
    this.cum = cumulativeDistances(this.points);
    this.totalM = this.cum[this.cum.length - 1] ?? 0;
    this.totalTimeMs = route.timeMs;
    this.opts = { ...DEFAULT_NAV_OPTIONS, ...options };
    this.departed = this.opts.startDeparted;

    const lastIdx = this.points.length - 1;
    this.maneuvers = (route.instructions ?? []).map((instruction, index) => {
      const start = Math.min(Math.max(instruction.interval[0], 0), lastIdx);
      return { instruction, index, alongStartM: this.cum[start]!, timeMs: instruction.timeMs };
    });
    this.suffixTimeMs = new Array<number>(this.maneuvers.length).fill(0);
    for (let i = this.maneuvers.length - 2; i >= 0; i--) {
      this.suffixTimeMs[i] = this.suffixTimeMs[i + 1]! + this.maneuvers[i + 1]!.timeMs;
    }
  }

  /**
   * Carry the trip's learned traffic pace into a replacement route session.
   * A reroute changes the expected road-by-road timing, but the observed ratio
   * between that timing and the driver's real progress is still evidence about
   * the same trip. Keeping the value here avoids exposing mutable ETA state to
   * platform controllers.
   */
  inheritPaceFrom(previous: NavigationSession): void {
    this.paceFactor = previous.paceFactor;
  }

  /**
   * Attach (or replace) the route's road attributes. Called once the
   * enrichment request for this route resolves; until then every attribute
   * simply reads as unknown, so guidance runs unchanged without it.
   */
  setEnrichment(enrichment: RouteEnrichment | null): NavState | null {
    this.enrichment = enrichment;
    // The state on screen was built before the attributes arrived. Refresh it
    // in place and hand it back, so the limit appears when it is known rather
    // than at the next fix — which, stopped at a light or in a tunnel, may be
    // a long way off.
    if (this.lastState) {
      this.lastState = {
        ...this.lastState,
        speedLimitKph: speedLimitKphAt(enrichment, this.lastState.traveledM),
        tunnel: this.tunnelState(this.lastState.traveledM),
      };
    }
    return this.lastState;
  }

  /**
   * End the trip because the traveller says so — the banner's "I've arrived".
   * Both automatic rules can miss (a fix that never gets accurate enough, a
   * destination the road data puts across a wall), and the driver standing at
   * the door must always have a way out that isn't "cancel", which reads as
   * abandoning the trip rather than completing it. Returns the refreshed state
   * so the UI flips immediately instead of waiting for a fix that may be
   * minutes away — parked in a garage, the next one may never come.
   */
  declareArrived(): NavState | null {
    this.arrived = true;
    if (this.lastState) {
      this.lastState = {
        ...this.lastState,
        status: 'arrived',
        routeProgress: 1,
        upcoming: null,
        then: null,
        sustain: null,
        laneGuidance: null,
      };
    }
    return this.lastState;
  }

  /** What the road data says about being in a tunnel at `alongM`. */
  private tunnelState(alongM: number): TunnelState | null {
    const tunnel = tunnelAt(this.enrichment, alongM);
    if (!tunnel) return null;
    return { name: tunnel.name, remainingM: Math.max(0, tunnel.endM - alongM) };
  }

  /** Feed one position fix; returns the new state and any voice prompts it triggered. */
  update(position: Position, nowMs: number = Date.now()): NavUpdate {
    const accuracyM =
      typeof position.accuracyM === 'number' && position.accuracyM >= 0 ? position.accuracyM : null;
    if (accuracyM !== null && accuracyM > this.opts.discardAccuracyM) {
      // A hopeless fix (urban-canyon multipath) would teleport the puck and
      // corrupt the matcher's continuity hint; coast on the last state instead.
      // Exception: once the signal is already `lost`, there is no good position
      // left to protect — a coarse fix is real evidence of where the car is and
      // beats a frozen, greyed puck that lingers long after the phone has
      // re-locked (the first fixes out of a tunnel are routinely > 100 m). So
      // when lost, fall through and let the coarse fix re-anchor guidance;
      // off-route/arrival stay gated on accuracy below, so it still can't fire
      // a spurious reroute or a false arrival.
      const recovering = this.lastState !== null && this.lastState.fix === 'lost';
      if (this.lastState !== null && !recovering)
        return this.tick(nowMs) ?? { state: this.lastState, prompts: [] };
      // With no state yet a cold-start garbage fix must not become the origin
      // of guidance either — show a provisional (greyed) puck and wait.
      if (this.lastState === null)
        return { state: this.provisionalState(position, nowMs), prompts: [] };
    }
    const speedMps =
      typeof position.speedMps === 'number' && position.speedMps >= 0 ? position.speedMps : null;
    // A phone in a tunnel usually doesn't go silent — it falls back to the
    // fused/network provider and keeps delivering fixes that claim the car is
    // standing still, at accuracies too coarse to mean anything. Those are the
    // ones that killed dead reckoning: accepting one re-anchors `lastFixMs` and
    // zeroes `lastSpeedMps`, so `tick()` sees no gap and no speed to reckon
    // with, and the puck parks mid-tunnel while still claiming a live fix.
    // Refuse to anchor on a coarse fix that reports a stop we were nowhere near
    // making, and let the extrapolation keep running instead — its own distance
    // and time caps still bound it. A real stop (traffic, a queue) comes with an
    // accurate fix and is honoured normally; once the signal is genuinely lost
    // there is nothing left to protect, so any fix may re-anchor.
    if (
      this.lastState !== null &&
      this.lastState.fix !== 'lost' &&
      this.lastSpeedMps !== null &&
      this.lastSpeedMps >= this.opts.deadReckonMinSpeedMps &&
      (speedMps === null || speedMps < this.opts.deadReckonMinSpeedMps) &&
      accuracyM !== null &&
      accuracyM > this.opts.offRouteMaxAccuracyM
    ) {
      return this.tick(nowMs) ?? { state: this.lastState, prompts: [] };
    }
    // The GPS course only disambiguates direction when actually moving —
    // stationary headings are compass noise.
    const moving = speedMps !== null && speedMps >= 2;
    const headingDeg =
      moving && typeof position.headingDeg === 'number' && position.headingDeg >= 0
        ? position.headingDeg
        : null;
    const snap = snapToRoute(position, this.points, this.cum, {
      prevAlongM: this.lastAlongM,
      headingDeg,
    });
    this.lastAlongM = snap.alongM;
    const alongM = snap.alongM;
    const distanceRemainingM = Math.max(0, this.totalM - alongM);

    // Only fixes accurate enough to prove a departure count toward off-route
    // (or arrival) — an uncertain fix leaves the tally untouched either way.
    const accurate = accuracyM === null || accuracyM <= this.opts.offRouteMaxAccuracyM;

    // Tearing the trip down is irreversible, so a poor fix drifting through the
    // arrival radius must not fire it; only an accurate fix may declare arrival.
    if (distanceRemainingM <= this.opts.arrivalRadiusM && accurate) this.arrived = true;

    // Secondary arrival, deliberately *not* accuracy-gated: having stopped for
    // `arrivalLoiterMs` this close to the destination, the trip is over whatever
    // the fix quality says. Drifting cannot fake it — a drifting fix is moving,
    // and any speed above walking pace (or leaving the loose radius) restarts
    // the clock. This is the escape hatch for the car park / courtyard / urban
    // canyon case, where an accurate fix may simply never come.
    if (this.departed && !this.arrived) {
      const still =
        distanceRemainingM <= this.opts.arrivalLoiterRadiusM &&
        speedMps !== null &&
        speedMps <= this.opts.arrivalLoiterMaxSpeedMps;
      if (!still) this.loiterSinceMs = null;
      else if (this.loiterSinceMs === null) this.loiterSinceMs = nowMs;
      else if (nowMs - this.loiterSinceMs >= this.opts.arrivalLoiterMs) this.arrived = true;
    } else {
      this.loiterSinceMs = null;
    }

    if (accurate) {
      if (snap.crossTrackM > this.opts.offRouteM) this.offRouteCount++;
      else this.offRouteCount = 0;
      // Wrong-way: heading opposes the route tangent while moving. Cross-track
      // stays ≈ 0 driving the line backwards (the matcher even pins the puck
      // via its backtrack penalty), so this is the only signal that catches it.
      //
      // Not inside a roundabout, though: `courseAt` reads the route direction
      // from a straight chord 25..60 m ahead, and on a tight ring that chord
      // cuts across the island while the driver's heading follows the kerb.
      // Measured on a synthetic ring, the divergence passes `wrongWayDeg` and
      // *sustains* past `offRouteGraceUpdates` on a 5 m-radius mini-roundabout
      // taken at 11–18 km/h — which would reroute the driver mid-ring, the most
      // disorienting possible moment. Suppressed here rather than by widening
      // the angle globally, which would blunt genuine wrong-way detection on
      // the straight roads where it actually earns its keep. Cross-track still
      // guards the ring, and the tally resets so a pre-roundabout streak cannot
      // fire on the way out.
      const inRoundabout = this.currentInstruction(alongM)?.sign === ROUNDABOUT_SIGN;
      const tangent = headingDeg !== null && !inRoundabout ? this.courseAt(alongM, speedMps) : null;
      if (tangent !== null && Math.abs(wrapDeg(headingDeg! - tangent)) > this.opts.wrongWayDeg) {
        this.wrongWayCount++;
      } else if (headingDeg !== null || inRoundabout) {
        this.wrongWayCount = 0;
      }
    }
    const offRoute =
      this.offRouteCount >= this.opts.offRouteGraceUpdates ||
      this.wrongWayCount >= this.opts.offRouteGraceUpdates;

    // Departure: the drive has visibly begun once the vehicle moves at
    // driving pace or has progressed along the route (for devices that
    // report no speed). Sticky for the session's lifetime.
    if (!this.departed) {
      if (this.firstFixAlongM === null) this.firstFixAlongM = alongM;
      if (
        (speedMps !== null && speedMps >= this.opts.departMinSpeedMps) ||
        alongM - this.firstFixAlongM >= this.opts.departProgressM
      ) {
        this.departed = true;
      }
    }

    this.updatePace(nowMs, alongM, snap.crossTrackM);
    this.lastFixMs = nowMs;
    this.alongAtFixM = alongM;
    this.lastSpeedMps = speedMps;
    // A live fix settles where the vehicle really is — the gyro comparison
    // starts over at the next gap, and off-route logic owns the truth now.
    this.yawActualDeg = 0;
    this.yawExpectedDeg = 0;
    this.reckonCourseDeg = null;
    this.wrongBranch = false;
    this.wrongBranchAnnounced = false;
    this.wrongBranchTicks = 0;

    const [upcoming, then] = this.arrived ? [null, null] : this.findUpcoming(alongM);
    const prompts = this.arrived || offRoute ? [] : this.collectPrompts(alongM, upcoming, speedMps);

    // Display position: glue to the route only while the fix is genuinely
    // near it (tighter still before departure) — a puck pinned to a road the
    // car isn't on reads as broken. On the road and moving, project the shown
    // position slightly ahead along the line so the map agrees with the
    // windshield despite GPS + camera-animation latency; guidance math
    // (prompts, distances, off-route) stays on the true position throughout.
    const snapDisplayM = this.departed ? this.opts.snapDisplayMaxM : this.opts.startSnapDisplayMaxM;
    let shown: LatLng;
    let shownCourse: number | null;
    if (snap.crossTrackM <= snapDisplayM) {
      let displayAlongM = alongM;
      if (!this.arrived && moving && speedMps !== null && this.opts.predictAheadMs > 0) {
        const aheadM = Math.min(60, speedMps * (this.opts.predictAheadMs / 1000));
        displayAlongM = Math.min(this.totalM, alongM + aheadM);
      }
      shown = pointAtDistance(this.points, this.cum, displayAlongM);
      // Bearing from where the vehicle actually is, not from the projected
      // display point: the projection exists to cancel render latency in the
      // *position*, and letting it drive the bearing too made the course-up
      // camera start turning while the car was still short of the bend.
      shownCourse = this.courseAt(alongM, speedMps);
    } else {
      shown = { lat: position.lat, lng: position.lng };
      // Off the line the route tangent is a lie; the GPS course (when moving)
      // is the only honest bearing, else leave the camera/chevron alone.
      shownCourse = headingDeg;
    }

    const remainMs = this.remainingTimeMs(alongM, distanceRemainingM);
    const state: NavState = {
      status: this.arrived ? 'arrived' : offRoute ? 'off-route' : 'navigating',
      snapped: shown,
      raw: { lat: position.lat, lng: position.lng },
      offRouteM: snap.crossTrackM,
      traveledM: alongM,
      routeProgress: this.arrived ? 1 : this.totalM > 0 ? Math.min(1, alongM / this.totalM) : 0,
      distanceRemainingM,
      timeRemainingMs: remainMs,
      etaEpochMs: nowMs + remainMs,
      upcoming,
      then,
      sustain: this.arrived ? null : this.sustainAt(alongM, speedMps),
      laneGuidance: this.arrived ? null : this.laneGuidanceAt(upcoming, speedMps),
      currentRoad: this.roadAt(alongM),
      speedLimitKph: speedLimitKphAt(this.enrichment, alongM),
      tunnel: this.tunnelState(alongM),
      departed: this.departed,
      courseDeg: shownCourse,
      fix: 'live',
      wrongBranch: false,
    };
    this.lastState = state;
    return { state, prompts };
  }

  /**
   * Advance the session without a fix — call ~1×/s from a timer. When fixes
   * stop while moving (tunnel, underpass) the position is extrapolated
   * along-route at the last speed, Google/OsmAnd-style, still firing voice
   * prompts; once the gap is too long or too far (or there is no speed to
   * extrapolate with) the state goes `lost` so the UI can grey the puck. Returns null
   * while fixes are flowing normally — nothing to re-render.
   */
  tick(nowMs: number = Date.now()): NavUpdate | null {
    const last = this.lastState;
    if (this.arrived || last === null || this.lastFixMs === null) return null;
    const gapMs = nowMs - this.lastFixMs;
    if (gapMs < this.opts.fixGapMs) return null;

    const speed = this.lastSpeedMps;
    // Reckoned distance since the fix. The speed eases from the last GPS speed
    // toward the leg's expected speed (closed form of an exponential blend) —
    // through a long tunnel with a limit change, the route's own pace is
    // better evidence than a minutes-old GPS reading. Anchored at the fix and
    // recomputed each tick, so it never compounds.
    // Where the signal died inside (or right before) a mapped tunnel, the far
    // portal is the honest bound on extrapolation: past it the car is back in
    // daylight and a still-absent fix means something other than a tunnel, so
    // reckoning should stop rather than run on to the generic 25 km cap. Where
    // the data says nothing — an unmapped tunnel, a dead receiver, a parking
    // garage — the generic cap remains the bound, which is why the v0.24.3
    // coarse-fix heuristic stays in place as the fallback it now is.
    const tunnel =
      this.alongAtFixM === null
        ? null
        : tunnelNear(this.enrichment, this.alongAtFixM, this.opts.tunnelArmM);
    const maxReckonM =
      tunnel === null
        ? this.opts.deadReckonMaxM
        : Math.max(0, tunnel.endM + this.opts.tunnelExitMarginM - this.alongAtFixM!);

    let reckonedM: number | null = null;
    if (
      this.alongAtFixM !== null &&
      speed !== null &&
      speed >= this.opts.deadReckonMinSpeedMps &&
      gapMs <= this.opts.deadReckonMaxMs
    ) {
      const tSec = gapMs / 1000;
      const tauSec = this.opts.deadReckonBlendTauMs / 1000;
      const expected = this.expectedSpeedAt(this.alongAtFixM);
      const d =
        expected !== null && Number.isFinite(tauSec) && tauSec > 0
          ? expected * tSec + (speed - expected) * tauSec * (1 - Math.exp(-tSec / tauSec))
          : speed * tSec;
      // Past the bound the extrapolation is fiction, not a tunnel.
      if (d <= maxReckonM) reckonedM = d;
    }
    if (reckonedM === null) {
      if (gapMs < this.opts.signalLostMs) return null;
      const state: NavState = { ...last, fix: 'lost', etaEpochMs: nowMs + last.timeRemainingMs };
      this.lastState = state;
      return { state, prompts: [] };
    }

    // Dead-reckon along the route, but stop just short of the destination —
    // only a real fix may declare arrival.
    const ceiling = Math.max(this.alongAtFixM!, this.totalM - this.opts.arrivalRadiusM);
    const alongM = Math.min(this.alongAtFixM! + reckonedM, ceiling);
    this.lastAlongM = alongM; // keep the matcher's continuity hint moving too
    const distanceRemainingM = Math.max(0, this.totalM - alongM);
    const [upcoming, then] = this.findUpcoming(alongM);
    const prompts = this.collectPrompts(alongM, upcoming, speed);
    const remainMs = this.remainingTimeMs(alongM, distanceRemainingM);
    const point = pointAtDistance(this.points, this.cum, alongM);
    const course = this.courseAt(alongM, speed);

    // Wrong-branch check: the gyro (fed via reportHeadingDelta) says how much
    // the vehicle actually turned during this gap; the route tangent says how
    // much the assumed line turns over the same reckoned stretch. A sustained
    // mismatch means an in-tunnel fork or roundabout was taken differently —
    // something cross-track can't see while there are no fixes at all.
    if (this.reckonCourseDeg !== null && course !== null) {
      this.yawExpectedDeg += wrapDeg(course - this.reckonCourseDeg);
    }
    if (course !== null) this.reckonCourseDeg = course;
    // Reckoned position and real position drift apart through a bend, so a
    // sharp corner spikes the divergence for a few seconds even when the
    // driver follows the route — only a sustained mismatch is evidence of a
    // wrong branch.
    if (Math.abs(this.yawActualDeg - this.yawExpectedDeg) > this.opts.wrongBranchDeg) {
      this.wrongBranchTicks++;
      if (this.wrongBranchTicks >= WRONG_BRANCH_GRACE_TICKS) this.wrongBranch = true;
    } else {
      this.wrongBranchTicks = 0;
    }
    if (this.wrongBranch && !this.wrongBranchAnnounced) {
      this.wrongBranchAnnounced = true;
      prompts.push({
        text: 'Check your route — you may have taken a different turn.',
        kind: 'alert',
        maneuverIndex: -1,
        thresholdM: 0,
      });
    }
    const state: NavState = {
      status: 'navigating',
      snapped: point,
      raw: point,
      offRouteM: 0,
      traveledM: alongM,
      routeProgress: this.totalM > 0 ? Math.min(1, alongM / this.totalM) : 0,
      distanceRemainingM,
      timeRemainingMs: remainMs,
      etaEpochMs: nowMs + remainMs,
      upcoming,
      then,
      sustain: this.sustainAt(alongM, speed),
      laneGuidance: this.laneGuidanceAt(upcoming, speed),
      currentRoad: this.roadAt(alongM),
      speedLimitKph: speedLimitKphAt(this.enrichment, alongM),
      tunnel: this.tunnelState(alongM),
      departed: this.departed,
      courseDeg: course,
      fix: 'estimated',
      wrongBranch: this.wrongBranch,
    };
    this.lastState = state;
    return { state, prompts };
  }

  /**
   * Feed a sensor-measured heading change (deg, clockwise-positive, since the
   * previous report) from the platform's motion sensors — see
   * `headingRateDegPerSec` for turning device rotation rates into this.
   * Consumed only while dead reckoning (`fix: 'estimated'`); while live fixes
   * flow, GPS is the better heading source and reports are dropped.
   */
  reportHeadingDelta(deltaDeg: number): void {
    if (!Number.isFinite(deltaDeg)) return;
    if (this.lastState?.fix !== 'estimated') return;
    this.yawActualDeg += deltaDeg;
  }

  /**
   * The instruction to speak when guidance starts and after every reroute —
   * the route's first maneuver ("Drive north on …"). It sits behind the
   * traveller from the first fix, so approach prompts never fire for it.
   */
  departurePrompt(): VoicePrompt | null {
    const first = this.maneuvers[0];
    if (!first || !first.instruction.text) return null;
    return {
      text: first.instruction.verbal?.pre ?? this.withChainedNext(0, first.instruction.text),
      kind: 'depart',
      maneuverIndex: first.index,
      thresholdM: 0,
    };
  }

  /**
   * What to speak on arrival. Valhalla's destination maneuver text carries
   * the side of the street ("Your destination is on the right."); fall back
   * to a generic phrase for instruction-less routes.
   */
  arrivalText(): string {
    const last = this.maneuvers[this.maneuvers.length - 1];
    return last && last.instruction.sign === 4 && last.instruction.text
      ? (last.instruction.verbal?.pre ?? last.instruction.text)
      : 'You have arrived';
  }

  /**
   * A state to show before any usable fix has arrived — the raw point, greyed
   * (`fix: 'lost'`), at the route's start with nothing yet snapped or matched.
   * Deliberately *not* stored as `lastState`: the next fix is still treated as
   * the first, so a garbage cold-start fix never anchors guidance.
   */
  private provisionalState(position: Position, nowMs: number): NavState {
    const [upcoming, then] = this.findUpcoming(0);
    return {
      status: 'navigating',
      snapped: { lat: position.lat, lng: position.lng },
      raw: { lat: position.lat, lng: position.lng },
      offRouteM: 0,
      traveledM: 0,
      routeProgress: 0,
      distanceRemainingM: this.totalM,
      timeRemainingMs: this.totalTimeMs,
      etaEpochMs: nowMs + this.totalTimeMs,
      upcoming,
      then,
      sustain: this.sustainAt(0, null),
      laneGuidance: this.laneGuidanceAt(upcoming, null),
      currentRoad: this.roadAt(0),
      speedLimitKph: speedLimitKphAt(this.enrichment, 0),
      tunnel: this.tunnelState(0),
      departed: this.departed,
      courseDeg: null,
      fix: 'lost',
      wrongBranch: false,
    };
  }

  /** The maneuver being approached (first strictly ahead of `alongM`) plus the one after it. */
  private findUpcoming(alongM: number): [UpcomingManeuver | null, UpcomingManeuver | null] {
    for (let i = 0; i < this.maneuvers.length; i++) {
      const m = this.maneuvers[i]!;
      if (m.alongStartM > alongM + EPS) {
        const next = this.maneuvers[i + 1];
        return [
          { instruction: m.instruction, distanceToM: m.alongStartM - alongM },
          next ? { instruction: next.instruction, distanceToM: next.alongStartM - alongM } : null,
        ];
      }
    }
    return [null, null];
  }

  /** Lane arrows become useful at the same moment ordinary approach guidance does. */
  private laneGuidanceAt(
    upcoming: UpcomingManeuver | null,
    speedMps: number | null,
  ): RouteLane[] | null {
    const lanes = upcoming?.instruction.lanes;
    const distanceToM = upcoming?.distanceToM;
    if (!lanes?.length || distanceToM === undefined) return null;
    const speed =
      speedMps === null || !Number.isFinite(speedMps)
        ? null
        : Math.min(speedMps, this.opts.promptSpeedMaxMps);
    const approachM = leadDistanceM(
      this.opts.approachThresholdsM[0] ?? 0,
      this.opts.approachLeadTimesS[0] ?? 0,
      speed,
    );
    return distanceToM <= approachM ? lanes : null;
  }

  /**
   * Route direction at `alongM` from a forward tangent (looking back at the
   * very end). The tangent length scales with speed — ~1.5 s of travel,
   * clamped to 25..60 m — so a fast course-up camera starts leaning into a
   * bend earlier while low-speed turns stay tight.
   */
  /**
   * The route's heading *at* a position — the direction the vehicle is
   * pointing right now, which is what a course-up camera and the puck's
   * chevron both mean. Deliberately a short window centred on the position
   * rather than a chord reaching ahead: a forward chord long enough to be
   * smooth (tens of metres) already spans the next bend while the vehicle is
   * still on the straight before it, so the map visibly swung round before the
   * car did. Centred, the bearing only starts to turn as the corner enters the
   * window, and the camera's own easing carries the rest.
   */
  private courseAt(alongM: number, speedMps: number | null): number | null {
    if (this.points.length < 2 || this.totalM <= 0) return null;
    // A window rather than the raw segment bearing: route polylines have
    // vertices every few metres, and one short segment's bearing jitters.
    // Scales gently with speed — a motorway needs more averaging than a
    // car park — but stays small enough not to anticipate the turn.
    const SPAN_M = Math.min(30, Math.max(14, (speedMps ?? 0) * 0.8));
    const half = SPAN_M / 2;
    const from = Math.min(Math.max(0, alongM - half), Math.max(0, this.totalM - SPAN_M));
    const to = Math.min(this.totalM, from + SPAN_M);
    if (to <= from) return null;
    return bearingDeg(
      pointAtDistance(this.points, this.cum, from),
      pointAtDistance(this.points, this.cum, to),
    );
  }

  private remainingTimeMs(alongM: number, distanceRemainingM: number): number {
    let base: number;
    if (this.maneuvers.length === 0) {
      base = this.totalM > 0 ? this.totalTimeMs * (distanceRemainingM / this.totalM) : 0;
    } else {
      // Find the maneuver currently being executed (last one started) and add
      // the unfinished fraction of its leg to the time of every maneuver after.
      const current = this.currentManeuverIndex(alongM);
      const cur = this.maneuvers[current]!;
      const next = this.maneuvers[current + 1];
      const legM = (next?.alongStartM ?? this.totalM) - cur.alongStartM;
      const fractionLeft =
        legM > 0 ? Math.max(0, (next?.alongStartM ?? this.totalM) - alongM) / legM : 0;
      base = fractionLeft * cur.timeMs + this.suffixTimeMs[current]!;
    }
    // Traffic adaptation: scale the route's static estimate by the observed
    // pace so a jam (or a clear road) actually moves the ETA.
    return base / Math.min(PACE_MAX, Math.max(PACE_MIN, this.paceFactor));
  }

  /**
   * Street name of the road being driven at `alongM` — the name on the
   * maneuver whose leg contains the position (Valhalla names each maneuver
   * with the road it puts the traveller on). Null when the data has none.
   */
  private roadAt(alongM: number): string | null {
    if (this.maneuvers.length === 0) return null;
    return this.maneuvers[this.currentManeuverIndex(alongM)]!.instruction.streetName ?? null;
  }

  /** Long-road display state until the next maneuver enters its far approach band. */
  private sustainAt(alongM: number, speedMps: number | null): SustainGuidance | null {
    if (!Number.isFinite(this.opts.sustainMinLegM)) return null;
    const current = this.maneuvers[this.currentManeuverIndex(alongM)];
    const next = this.maneuvers[this.currentManeuverIndex(alongM) + 1];
    const road = current?.instruction.streetName;
    if (!current || !next || !road) return null;
    const legM = next.alongStartM - current.alongStartM;
    const remainingM = next.alongStartM - alongM;
    if (legM < this.opts.sustainMinLegM || remainingM <= 0) return null;
    const handoverM = leadDistanceM(
      this.opts.farApproachM,
      this.opts.farApproachLeadTimeS,
      this.promptSpeed(speedMps),
    );
    return remainingM > handoverM ? { road, distanceRemainingM: remainingM } : null;
  }

  /** Clamp only prompt timing; map matching and speed display keep the real fix. */
  private promptSpeed(speedMps: number | null): number | null {
    return speedMps === null ? null : Math.min(speedMps, this.opts.promptSpeedMaxMps);
  }

  /** The instruction whose leg contains `alongM`, or null for a route without any. */
  private currentInstruction(alongM: number): RouteInstruction | null {
    return this.maneuvers[this.currentManeuverIndex(alongM)]?.instruction ?? null;
  }

  /** Index of the maneuver whose leg contains `alongM` (last one started). */
  private currentManeuverIndex(alongM: number): number {
    let current = 0;
    for (let i = 0; i < this.maneuvers.length; i++) {
      if (this.maneuvers[i]!.alongStartM <= alongM + EPS) current = i;
      else break;
    }
    return current;
  }

  /** The route's own expected speed (m/s) on the maneuver leg containing `alongM`. */
  private expectedSpeedAt(alongM: number): number | null {
    if (this.maneuvers.length === 0) {
      return this.totalTimeMs > 0 ? this.totalM / (this.totalTimeMs / 1000) : null;
    }
    const cur = this.maneuvers[this.currentManeuverIndex(alongM)]!;
    const next = this.maneuvers[this.currentManeuverIndex(alongM) + 1];
    const legM = (next?.alongStartM ?? this.totalM) - cur.alongStartM;
    return cur.timeMs > 0 && legM > 0 ? legM / (cur.timeMs / 1000) : null;
  }

  /**
   * Blend the along-route progress rate since the previous fix into the pace
   * factor. Along-route progress (not GPS speed) makes a standstill in a jam
   * read as pace 0 — exactly the signal that should stretch the ETA.
   */
  private updatePace(nowMs: number, alongM: number, crossTrackM: number): void {
    const prevMs = this.lastFixMs;
    const prevAlong = this.alongAtFixM;
    if (prevMs === null || prevAlong === null) return;
    const dtMs = nowMs - prevMs;
    // Only gap-free, on-route stretches are pace evidence.
    if (dtMs <= 0 || dtMs > PACE_MAX_SAMPLE_MS || crossTrackM > this.opts.offRouteM) return;
    const expectedMps = this.expectedSpeedAt(alongM);
    if (expectedMps === null || expectedMps <= 0.5) return;
    const sample = Math.min(4, Math.max(0, alongM - prevAlong) / (dtMs / 1000) / expectedMps);
    const alpha = 1 - Math.exp(-dtMs / this.opts.paceTauMs);
    this.paceFactor += alpha * (sample - this.paceFactor);
  }

  /**
   * "…, then X" when the maneuver after `idx` follows within chainManeuverM —
   * the spoken counterpart of the banner's "then" hint, so a quick
   * turn-then-keep-left combination is announced as one breath.
   */
  private withChainedNext(idx: number, text: string): string {
    const cur = this.maneuvers[idx];
    const next = this.maneuvers[idx + 1];
    if (!cur || !next?.instruction.text) return text;
    if (next.alongStartM - cur.alongStartM > this.opts.chainManeuverM) return text;
    const n = next.instruction.text;
    return `${text.replace(/\.\s*$/, '')}, then ${n.charAt(0).toLowerCase()}${n.slice(1)}`;
  }

  /** Router-authored wording for one cue, with the old display-text synthesis as fallback. */
  private cueText(idx: number, phase: 'alert' | 'pre' | 'now'): string {
    const instruction = this.maneuvers[idx]!.instruction;
    const verbal = instruction.verbal;
    const authored =
      phase === 'alert'
        ? (verbal?.alert ?? verbal?.pre)
        : phase === 'pre'
          ? (verbal?.pre ?? verbal?.alert)
          : (verbal?.succinct ?? verbal?.pre ?? verbal?.alert);
    return authored ?? this.withChainedNext(idx, instruction.text);
  }

  private collectPrompts(
    alongM: number,
    upcoming: UpcomingManeuver | null,
    speedMps: number | null,
  ): VoicePrompt[] {
    // Crossing a maneuver starts its new leg. Valhalla's post-transition cue
    // is the authoritative confirmation for that moment ("Continue on E18
    // for 154 kilometers"). Do not stack an approach cue behind it on the
    // same GPS update; a close following turn is already carried by
    // `verbal_multi_cue` in the pre-turn phrase.
    const currentIdx = this.currentManeuverIndex(alongM);
    if (this.lastPromptManeuverIndex === null) {
      this.lastPromptManeuverIndex = currentIdx;
    } else if (currentIdx > this.lastPromptManeuverIndex) {
      this.lastPromptManeuverIndex = currentIdx;
      const post = this.opts.postTransitionPrompts
        ? this.maneuvers[currentIdx]?.instruction.verbal?.post
        : undefined;
      if (post) {
        const key = `${currentIdx}:post`;
        if (!this.firedPrompts.has(key)) {
          this.firedPrompts.add(key);
          return [{ text: post, kind: 'post', maneuverIndex: currentIdx, thresholdM: 0 }];
        }
      }
    }
    if (!upcoming) return [];
    // Locate the maneuver's index in our list to key fired prompts stably.
    const idx = this.maneuvers.find((m) => m.instruction === upcoming.instruction)?.index ?? -1;
    if (idx < 0) return [];
    const d = upcoming.distanceToM;
    const promptSpeedMps = this.promptSpeed(speedMps);
    const alertFallbackM = this.opts.approachThresholdsM[0] ?? 0;
    const preFallbackM = this.opts.approachThresholdsM[1] ?? alertFallbackM;
    const alertLeadS = this.opts.approachLeadTimesS[0] ?? 0;
    const preLeadS = this.opts.approachLeadTimesS[1] ?? alertLeadS;
    // Highway guidance gets an early alert around 100 seconds out. At other
    // speeds the same alert slot uses the normal ~45-second band, so the same
    // wording is never repeated merely because the car crossed 800 and 400 m.
    const farActive =
      this.opts.farApproachM > 0 &&
      promptSpeedMps !== null &&
      promptSpeedMps >= this.opts.farApproachMinSpeedMps;
    const alertThresholdM = farActive
      ? leadDistanceM(this.opts.farApproachM, this.opts.farApproachLeadTimeS, promptSpeedMps)
      : leadDistanceM(alertFallbackM, alertLeadS, promptSpeedMps);
    const preThresholdM = leadDistanceM(preFallbackM, preLeadS, promptSpeedMps);
    const nowThresholdM = leadDistanceM(
      this.opts.nowThresholdM,
      this.opts.nowLeadTimeS,
      promptSpeedMps,
    );

    if (d <= nowThresholdM) {
      const key = `${idx}:now`;
      if (this.firedPrompts.has(key)) return [];
      // A jump straight to the maneuver skips its earlier phases for good.
      this.firedPrompts.add(`${idx}:alert`);
      this.firedPrompts.add(`${idx}:pre`);
      this.firedPrompts.add(key);
      return [{ text: this.cueText(idx, 'now'), kind: 'now', maneuverIndex: idx, thresholdM: 0 }];
    }

    if (d <= preThresholdM) {
      const key = `${idx}:pre`;
      if (this.firedPrompts.has(key)) return [];
      // A coarse fix can jump over the alert band; do not replay it later.
      this.firedPrompts.add(`${idx}:alert`);
      this.firedPrompts.add(key);
      return [
        {
          text: `In ${voiceDistance(d)}, ${this.cueText(idx, 'pre')}`,
          kind: 'approach',
          maneuverIndex: idx,
          thresholdM: preThresholdM,
        },
      ];
    }

    if (d <= alertThresholdM) {
      const key = `${idx}:alert`;
      if (this.firedPrompts.has(key)) return [];
      this.firedPrompts.add(key);
      return [
        {
          text: `In ${voiceDistance(d)}, ${this.cueText(idx, 'alert')}`,
          kind: 'approach',
          maneuverIndex: idx,
          thresholdM: alertThresholdM,
        },
      ];
    }

    return [];
  }
}
