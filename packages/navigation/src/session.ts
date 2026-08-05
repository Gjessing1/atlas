import type { LatLng } from '@atlas/core';
import {
  speedLimitKphAt,
  tunnelAt,
  tunnelNear,
  type RouteCameras,
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
  type SectionControlState,
  type SpeedCameraState,
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
/** Reckoned ticks (~s) the yaw divergence must persist before `wrongBranch`. */
const WRONG_BRANCH_GRACE_TICKS = 5;
/** Atlas turn code for a roundabout leg — both entering (26) and exiting (27). */
const ROUNDABOUT_SIGN = 6;
/** Farthest ahead (m) the next speed camera is surfaced in the state at all. */
const CAMERA_CHIP_M = 2000;
/**
 * Minimum/fallback distance (m) and lead time (s) for camera voice alerts —
 * the same speed-scaled shape as maneuver approach cues. Vegvesen's own
 * warning sign (556) stands a few hundred metres before the camera, so this
 * roughly matches what the driver sees out the windscreen. (NVDB's signed
 * influence zones, type 775, were deliberately not used for timing: for
 * section installations they cover the whole multi-kilometre stretch, which
 * would fire a "camera ahead" absurdly early.)
 */
const CAMERA_ALERT_M = 500;
const CAMERA_ALERT_LEAD_S = 20;
/** Shortest sample (m / s) inside a section before the average is worth showing. */
const SECTION_AVG_MIN_M = 100;
const SECTION_AVG_MIN_S = 5;
/** How long a moving fix's heading still describes a now-crawling vehicle. */
const HEADING_MEMORY_MS = 15_000;
/** Speed allowance for the matcher's travel bound: acceleration plus GPS slop. */
const ADVANCE_SPEED_MARGIN = 1.6;
/** Advance always allowed regardless of speed — a stationary fix still wanders. */
const ADVANCE_SLACK_M = 20;

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
  /** Not readonly: {@link setSchedule} re-prices the trip without restarting it. */
  private totalTimeMs: number;
  private readonly maneuvers: Maneuver[];
  /** Along-route positions of the trip's via stops (sign-5 maneuvers), ascending. */
  private readonly viaAlongM: number[];
  /**
   * Roundabouts, as the pair of maneuvers the router splits each one into:
   * entry index → exit index. The entry carries the exit to count ("3rd exit")
   * and the angle the ring turns through; the exit carries only "leave the
   * roundabout". Pairing them lets the display keep the ring on screen for the
   * whole time the vehicle is inside it (see {@link displayUpcoming}).
   */
  private readonly ringExitByEntry = new Map<number, number>();
  private readonly ringEntryByExit = new Map<number, number>();
  /** suffixTimeMs[i] = total instruction time of maneuvers after i. */
  private readonly suffixTimeMs: number[];
  /** The same, counting only the measured-congestion share of each leg. */
  private readonly suffixTrafficMs: number[];
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
  /**
   * The last travel direction a moving fix reported, and when. A vehicle
   * waiting to turn still points where it pointed a moment ago, but reports no
   * usable GPS course at a crawl — so the matcher keeps the last one briefly,
   * which is exactly the situation ("about to turn off") where losing it let
   * the snap slide onto the road not yet taken. Map matching only: wrong-way
   * detection needs live evidence and keeps using the fix's own heading.
   */
  private lastHeadingDeg: number | null = null;
  private lastHeadingMs = 0;
  /** Timestamp / along-route anchor / speed of the last accepted fix. */
  private lastFixMs: number | null = null;
  private alongAtFixM: number | null = null;
  private lastSpeedMps: number | null = null;
  private lastState: NavState | null = null;
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
  /** ATK cameras matched onto this route; attached like enrichment, optional. */
  private cameras: RouteCameras | null = null;
  /**
   * Where and when the current average-speed stretch was entered. `measured`
   * is true only when the entry crossing itself was observed — an average
   * started mid-stretch is not the number the installation measures, so it is
   * withheld rather than shown wrong.
   */
  private sectionEntry: {
    index: number;
    alongM: number;
    atMs: number;
    measured: boolean;
  } | null = null;
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
    this.viaAlongM = this.maneuvers
      .filter((m) => m.instruction.sign === 5)
      .map((m) => m.alongStartM);
    this.suffixTimeMs = new Array<number>(this.maneuvers.length).fill(0);
    this.suffixTrafficMs = new Array<number>(this.maneuvers.length).fill(0);
    this.rebuildSuffixes();
    // Valhalla emits a roundabout as enter-then-exit, always adjacent; consume
    // them in pairs so two rings in a row can't be mistaken for one long one.
    for (let i = 0; i < this.maneuvers.length - 1; i++) {
      if (
        this.maneuvers[i]!.instruction.sign === ROUNDABOUT_SIGN &&
        this.maneuvers[i + 1]!.instruction.sign === ROUNDABOUT_SIGN
      ) {
        this.ringExitByEntry.set(i, i + 1);
        this.ringEntryByExit.set(i + 1, i);
        i++;
      }
    }
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

  /** Recompute both suffix sums from the maneuvers' current times. */
  private rebuildSuffixes(): void {
    for (let i = this.maneuvers.length - 2; i >= 0; i--) {
      const next = this.maneuvers[i + 1]!;
      this.suffixTimeMs[i] = this.suffixTimeMs[i + 1]! + next.timeMs;
      this.suffixTrafficMs[i] =
        this.suffixTrafficMs[i + 1]! + (next.instruction.trafficDelayMs ?? 0);
    }
  }

  /**
   * Re-price the trip in flight: same roads, same turns, a newer estimate of
   * how long they take.
   *
   * The schedule was fixed at construction, so a jam that formed after
   * departure could only reach the driver by tearing the trip down and
   * starting a new session — losing the prompts already fired, the distance
   * bank and the section-control anchor to report a number. This accepts the
   * revised maneuver times instead, and everything else about the trip
   * continues untouched.
   *
   * `route` must be *this* route: same geometry, same maneuvers at the same
   * points. A schedule that does not describe it is refused rather than
   * half-applied — a mismatch means the caller has a different line in hand,
   * and the honest response to that is a reroute, not a re-priced fiction.
   * Returns the refreshed state (so the ETA moves now rather than at the next
   * fix, which stopped in a queue may be a while), or null when refused.
   */
  setSchedule(route: RoutePath, nowMs: number = Date.now()): NavState | null {
    const revised = route.instructions ?? [];
    if (route.points.length !== this.points.length) return null;
    if (revised.length !== this.maneuvers.length) return null;
    if (!Number.isFinite(route.timeMs) || route.timeMs < 0) return null;
    for (let i = 0; i < revised.length; i++) {
      const before = this.maneuvers[i]!.instruction.interval;
      const after = revised[i]!.interval;
      if (before[0] !== after[0] || before[1] !== after[1]) return null;
    }

    this.totalTimeMs = route.timeMs;
    for (let i = 0; i < revised.length; i++) {
      const maneuver = this.maneuvers[i]!;
      maneuver.instruction = revised[i]!;
      maneuver.timeMs = revised[i]!.timeMs;
    }
    this.rebuildSuffixes();

    // An arrived trip has no remaining time to re-price, and a state whose
    // upcoming/sustain fields were cleared on arrival must not be rebuilt.
    if (this.lastState && this.lastState.status !== 'arrived') {
      const remainMs = this.remainingTimeMs(
        this.lastState.traveledM,
        this.lastState.distanceRemainingM,
      );
      this.lastState = {
        ...this.lastState,
        timeRemainingMs: remainMs,
        etaEpochMs: nowMs + remainMs,
        trafficDelayMs: this.remainingTrafficMs(this.lastState.traveledM),
      };
    }
    return this.lastState;
  }

  /**
   * Attach (or replace) the route's matched ATK cameras once the camera
   * request for this route resolves — the same late-arrival contract as
   * {@link setEnrichment}: guidance runs unchanged without them, and the
   * refreshed state is handed back so a camera already inside the chip window
   * appears now rather than at the next fix.
   */
  setCameras(cameras: RouteCameras | null, nowMs: number = Date.now()): NavState | null {
    this.cameras = cameras;
    this.sectionEntry = null;
    if (this.lastState && this.lastState.status !== 'arrived') {
      this.lastState = {
        ...this.lastState,
        speedCamera: this.speedCameraState(this.lastState.traveledM),
        sectionControl: this.sectionControlState(this.lastState.traveledM, nowMs),
      };
    }
    return this.lastState;
  }

  /** The next point camera ahead, once inside the chip window. */
  private speedCameraState(alongM: number): SpeedCameraState | null {
    const points = this.cameras?.points;
    if (!points) return null;
    for (const p of points) {
      // Small just-passed slack so the chip drops as the camera goes by
      // rather than lingering to the next one.
      if (p.atM >= alongM - 25) {
        const distanceM = Math.max(0, p.atM - alongM);
        return distanceM <= CAMERA_CHIP_M ? { distanceM, name: p.name } : null;
      }
    }
    return null;
  }

  /** The average-speed stretch containing `alongM`, with our own running average. */
  private sectionControlState(alongM: number, nowMs: number): SectionControlState | null {
    const sections = this.cameras?.sections;
    if (!sections) return null;
    const index = sections.findIndex((s) => alongM >= s.startM && alongM <= s.endM);
    if (index < 0) return null;
    const section = sections[index]!;
    let avgKph: number | null = null;
    const entry = this.sectionEntry;
    if (entry && entry.index === index && entry.measured) {
      const dM = alongM - entry.alongM;
      const dtS = (nowMs - entry.atMs) / 1000;
      if (dM >= SECTION_AVG_MIN_M && dtS >= SECTION_AVG_MIN_S) {
        avgKph = Math.round((dM / dtS) * 3.6);
      }
    }
    return {
      name: section.name,
      remainingM: Math.max(0, section.endM - alongM),
      avgKph,
      limitKph: speedLimitKphAt(this.enrichment, alongM),
    };
  }

  /**
   * Keep the section-entry anchor in step with the position. The average must
   * span everything since the entry camera — including a stop, or a spell
   * off-route — because that is exactly what the installation measures: wall
   * time between the two endpoint passages.
   */
  private trackSection(prevAlongM: number | null, alongM: number, nowMs: number): void {
    const sections = this.cameras?.sections;
    if (!sections) return;
    const index = sections.findIndex((s) => alongM >= s.startM && alongM <= s.endM);
    if (index < 0) {
      this.sectionEntry = null;
      return;
    }
    if (this.sectionEntry?.index === index) return;
    this.sectionEntry = {
      index,
      alongM,
      atMs: nowMs,
      // Only an observed crossing may anchor an average: the previous position
      // was still ahead of the entry line (small slack for the fix interval).
      measured: prevAlongM !== null && prevAlongM < sections[index]!.startM + 50,
    };
  }

  /** Camera voice alerts — the hazard counterpart of the maneuver cues. */
  private cameraPrompts(alongM: number, speedMps: number | null): VoicePrompt[] {
    const cams = this.cameras;
    if (!cams) return [];
    const prompts: VoicePrompt[] = [];
    const leadM = leadDistanceM(CAMERA_ALERT_M, CAMERA_ALERT_LEAD_S, this.promptSpeed(speedMps));
    cams.points.forEach((p, i) => {
      const key = `cam:${i}`;
      if (this.firedPrompts.has(key)) return;
      if (p.atM <= alongM) {
        // Already behind (a jump, or cameras attached late): never announce late.
        this.firedPrompts.add(key);
        return;
      }
      const d = p.atM - alongM;
      if (d <= leadM) {
        this.firedPrompts.add(key);
        prompts.push({
          text: `Speed camera in ${voiceDistance(d)}`,
          kind: 'alert',
          maneuverIndex: -1,
          thresholdM: leadM,
        });
      }
    });
    cams.sections.forEach((s, i) => {
      const enterKey = `sec:${i}`;
      const doneKey = `sec:${i}:done`;
      if (!this.firedPrompts.has(enterKey)) {
        if (alongM >= s.endM) {
          // The whole stretch is already behind — say nothing, ever.
          this.firedPrompts.add(enterKey);
          this.firedPrompts.add(doneKey);
        } else if (alongM >= s.startM) {
          // Entered without an approach cue (cameras attached mid-stretch).
          this.firedPrompts.add(enterKey);
          prompts.push({
            text: `Average speed check for the next ${voiceDistance(s.endM - alongM)}`,
            kind: 'alert',
            maneuverIndex: -1,
            thresholdM: 0,
          });
        } else if (s.startM - alongM <= leadM) {
          this.firedPrompts.add(enterKey);
          prompts.push({
            text: `Average speed check ahead, for the next ${voiceDistance(s.endM - s.startM)}`,
            kind: 'alert',
            maneuverIndex: -1,
            thresholdM: leadM,
          });
        }
      } else if (!this.firedPrompts.has(doneKey) && alongM > s.endM) {
        this.firedPrompts.add(doneKey);
        prompts.push({
          text: 'Average speed check complete',
          kind: 'alert',
          maneuverIndex: -1,
          thresholdM: 0,
        });
      }
    });
    return prompts;
  }

  /**
   * The engine's own remaining-time estimate (ms) at the last known
   * along-route position. This is the honest baseline for judging a freshly
   * fetched candidate route: the candidate's `timeMs` uses the same engine
   * schedule, so a difference means the roads differ. Null before the first
   * fix has anchored a position.
   */
  plannedRemainingMs(): number | null {
    if (this.lastAlongM === null) return null;
    return this.baseRemainingMs(this.lastAlongM, Math.max(0, this.totalM - this.lastAlongM));
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
        displayRouteProgress: 1,
        trafficDelayMs: 0,
        upcoming: null,
        then: null,
        sustain: null,
        laneGuidance: null,
        speedCamera: null,
        sectionControl: null,
      };
    }
    return this.lastState;
  }

  /** How many via stops lie behind `alongM` — passed stops, dropped on reroute. */
  private viasPassedAt(alongM: number): number {
    let passed = 0;
    for (const via of this.viaAlongM) {
      if (via <= alongM + EPS) passed++;
      else break;
    }
    return passed;
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
    if (headingDeg !== null) {
      this.lastHeadingDeg = headingDeg;
      this.lastHeadingMs = nowMs;
    }
    const matchHeadingDeg =
      headingDeg ?? (nowMs - this.lastHeadingMs <= HEADING_MEMORY_MS ? this.lastHeadingDeg : null);
    const prevAlongM = this.lastAlongM;
    const snap = snapToRoute(position, this.points, this.cum, {
      prevAlongM: this.lastAlongM,
      headingDeg: matchHeadingDeg,
      maxAdvanceM: this.plausibleAdvanceM(nowMs, speedMps),
    });
    this.lastAlongM = snap.alongM;
    const alongM = snap.alongM;
    this.trackSection(prevAlongM, alongM, nowMs);
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

    const [upcoming, then] = this.arrived ? [null, null] : this.displayUpcoming(alongM);
    const prompts =
      this.arrived || offRoute
        ? []
        : this.collectPrompts(alongM, this.findUpcoming(alongM), speedMps);
    if (!this.arrived && !offRoute) prompts.push(...this.cameraPrompts(alongM, speedMps));

    // Display position: glue to the route only while the fix is genuinely
    // near it (tighter still before departure) — a puck pinned to a road the
    // car isn't on reads as broken. On the road and moving, project the shown
    // position slightly ahead along the line so the map agrees with the
    // windshield despite GPS + camera-animation latency; guidance math
    // (prompts, distances, off-route) stays on the true position throughout.
    //
    // Only an *accurate* fix earns the snap. A coarse fix (standing in the
    // garden, an urban-canyon bounce) whose error circle happens to reach the
    // road is not evidence the traveller is on it — gluing there was the "it
    // snapped when I was nowhere near" bug — so a fuzzy fix shows its own raw
    // position and lets the puck sit honestly off the line.
    const snapDisplayM = this.departed ? this.opts.snapDisplayMaxM : this.opts.startSnapDisplayMaxM;
    let shown: LatLng;
    let shownCourse: number | null;
    let displayRouteProgress = this.arrived
      ? 1
      : this.totalM > 0
        ? Math.min(1, alongM / this.totalM)
        : 0;
    const displayOnRoute = snap.crossTrackM <= snapDisplayM && accurate;
    if (this.opts.snapDisplayPosition && displayOnRoute) {
      let displayAlongM = alongM;
      if (!this.arrived && moving && speedMps !== null && this.opts.predictAheadMs > 0) {
        const aheadM = Math.min(60, speedMps * (this.opts.predictAheadMs / 1000));
        // Never project across the next maneuver. The projection exists to
        // cancel latency along the road being driven; carried round a corner
        // it draws the vehicle on a road it has not turned onto yet — which,
        // with the course-up camera swinging to match, reads as being on the
        // wrong road facing the wrong way.
        const nextIdx = this.nextManeuverIndex(alongM);
        const turnM = nextIdx >= 0 ? this.maneuvers[nextIdx]!.alongStartM : this.totalM;
        displayAlongM = Math.min(this.totalM, turnM, alongM + aheadM);
      }
      shown = pointAtDistance(this.points, this.cum, displayAlongM);
      displayRouteProgress = this.arrived
        ? 1
        : this.totalM > 0
          ? Math.min(1, displayAlongM / this.totalM)
          : 0;
      // Bearing from where the vehicle actually is, not from the projected
      // display point: the projection exists to cancel render latency in the
      // *position*, and letting it drive the bearing too made the course-up
      // camera start turning while the car was still short of the bend.
      shownCourse = this.courseAt(alongM, speedMps);
    } else {
      shown = { lat: position.lat, lng: position.lng };
      // The guidance matcher is continuity- and heading-biased on purpose: at
      // junctions and doubled-back routes it may choose a nearby branch that
      // is not the raw point's closest piece of line. That is useful for route
      // progress, but it must not put the grey travelled boundary ahead of a
      // puck we chose to draw raw. Anchor the rendered boundary to the raw
      // point's plain geometric projection instead.
      const shownSnap = snapToRoute(shown, this.points, this.cum);
      displayRouteProgress = this.arrived
        ? 1
        : this.totalM > 0
          ? Math.min(1, shownSnap.alongM / this.totalM)
          : 0;
      // A pedestrian profile may deliberately draw the precise fix even while
      // it is on-route. Keep the stable route course there for the walking
      // compass blend; only a genuinely off-line puck should use the raw GPS
      // course, because there the route tangent is a lie.
      shownCourse = displayOnRoute ? this.courseAt(alongM, speedMps) : headingDeg;
    }

    const remainMs = this.remainingTimeMs(alongM, distanceRemainingM);
    const state: NavState = {
      status: this.arrived ? 'arrived' : offRoute ? 'off-route' : 'navigating',
      snapped: shown,
      raw: { lat: position.lat, lng: position.lng },
      offRouteM: snap.crossTrackM,
      traveledM: alongM,
      routeProgress: this.arrived ? 1 : this.totalM > 0 ? Math.min(1, alongM / this.totalM) : 0,
      displayRouteProgress,
      distanceRemainingM,
      timeRemainingMs: remainMs,
      etaEpochMs: nowMs + remainMs,
      trafficDelayMs: this.arrived ? 0 : this.remainingTrafficMs(alongM),
      upcoming,
      then,
      sustain: this.arrived ? null : this.sustainAt(alongM, speedMps),
      laneGuidance: this.arrived ? null : this.laneGuidanceAt(upcoming, speedMps),
      currentRoad: this.roadAt(alongM),
      speedLimitKph: speedLimitKphAt(this.enrichment, alongM),
      tunnel: this.tunnelState(alongM),
      speedCamera: this.arrived ? null : this.speedCameraState(alongM),
      sectionControl: this.arrived ? null : this.sectionControlState(alongM, nowMs),
      departed: this.departed,
      viasPassed: this.viasPassedAt(alongM),
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
    const prevAlongM = this.lastAlongM;
    this.lastAlongM = alongM; // keep the matcher's continuity hint moving too
    this.trackSection(prevAlongM, alongM, nowMs);
    const distanceRemainingM = Math.max(0, this.totalM - alongM);
    const [upcoming, then] = this.displayUpcoming(alongM);
    const prompts = this.collectPrompts(alongM, this.findUpcoming(alongM), speed);
    // A camera does not stop existing because GPS did — Norwegian tunnels have
    // ATK too, and the reckoned position is exactly what the alert needs.
    prompts.push(...this.cameraPrompts(alongM, speed));
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
      displayRouteProgress: this.totalM > 0 ? Math.min(1, alongM / this.totalM) : 0,
      distanceRemainingM,
      timeRemainingMs: remainMs,
      etaEpochMs: nowMs + remainMs,
      trafficDelayMs: this.remainingTrafficMs(alongM),
      upcoming,
      then,
      sustain: this.sustainAt(alongM, speed),
      laneGuidance: this.laneGuidanceAt(upcoming, speed),
      currentRoad: this.roadAt(alongM),
      speedLimitKph: speedLimitKphAt(this.enrichment, alongM),
      tunnel: this.tunnelState(alongM),
      speedCamera: this.speedCameraState(alongM),
      sectionControl: this.sectionControlState(alongM, nowMs),
      departed: this.departed,
      viasPassed: this.viasPassedAt(alongM),
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
    const [upcoming, then] = this.displayUpcoming(0);
    return {
      status: 'navigating',
      snapped: { lat: position.lat, lng: position.lng },
      raw: { lat: position.lat, lng: position.lng },
      offRouteM: 0,
      traveledM: 0,
      routeProgress: 0,
      displayRouteProgress: 0,
      distanceRemainingM: this.totalM,
      timeRemainingMs: this.totalTimeMs,
      etaEpochMs: nowMs + this.totalTimeMs,
      trafficDelayMs: this.remainingTrafficMs(0),
      upcoming,
      then,
      sustain: this.sustainAt(0, null),
      laneGuidance: this.laneGuidanceAt(upcoming, null),
      currentRoad: this.roadAt(0),
      speedLimitKph: speedLimitKphAt(this.enrichment, 0),
      tunnel: this.tunnelState(0),
      speedCamera: this.speedCameraState(0),
      sectionControl: this.sectionControlState(0, nowMs),
      departed: this.departed,
      viasPassed: 0,
      courseDeg: null,
      fix: 'lost',
      wrongBranch: false,
    };
  }

  /** Index of the first maneuver strictly ahead of `alongM`, or -1 past the last. */
  private nextManeuverIndex(alongM: number): number {
    for (let i = 0; i < this.maneuvers.length; i++) {
      if (this.maneuvers[i]!.alongStartM > alongM + EPS) return i;
    }
    return -1;
  }

  /**
   * The maneuver being approached — the first one strictly ahead. This is the
   * one voice guidance is about: every cue belongs to the maneuver the
   * traveller is actually heading for, including "exit the roundabout".
   */
  private findUpcoming(alongM: number): UpcomingManeuver | null {
    const i = this.nextManeuverIndex(alongM);
    const m = this.maneuvers[i];
    return m ? { instruction: m.instruction, distanceToM: m.alongStartM - alongM } : null;
  }

  /**
   * The maneuver a banner should *show*, plus the one after it — which is not
   * always the next one in the list.
   *
   * A roundabout is two maneuvers: "enter the roundabout and take the 3rd
   * exit" and, once inside the ring, "exit the roundabout". The moment the
   * wheels crossed the give-way line the banner therefore lost the one number
   * the driver still needed — the exit to count — precisely while counting
   * them off. So the entry maneuver stays on screen for the whole ring, its
   * distance now counting down to the point where the route actually leaves
   * it. The same pairing keeps the "then" slot useful in both directions: it
   * shows what follows the roundabout, never a second, numberless ring icon
   * for the exit half of the one already being shown.
   *
   * Voice is deliberately untouched (see {@link findUpcoming}): "exit the
   * roundabout onto Kirkeveien" is exactly the right thing to say inside the
   * ring, even though it is the wrong thing to draw.
   */
  private displayUpcoming(alongM: number): [UpcomingManeuver | null, UpcomingManeuver | null] {
    const next = this.nextManeuverIndex(alongM);
    if (next < 0) return [null, null];
    const shown = this.ringEntryByExit.get(next) ?? next;
    const afterIdx = (this.ringExitByEntry.get(shown) ?? shown) + 1;
    const after = this.maneuvers[afterIdx];
    return [
      {
        instruction: this.maneuvers[shown]!.instruction,
        distanceToM: this.maneuvers[next]!.alongStartM - alongM,
      },
      after ? { instruction: after.instruction, distanceToM: after.alongStartM - alongM } : null,
    ];
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

  /** The route's static remaining-time estimate, before pace adaptation. */
  private baseRemainingMs(alongM: number, distanceRemainingM: number): number {
    if (this.maneuvers.length === 0) {
      return this.totalM > 0 ? this.totalTimeMs * (distanceRemainingM / this.totalM) : 0;
    }
    // Find the maneuver currently being executed (last one started) and add
    // the unfinished fraction of its leg to the time of every maneuver after.
    const current = this.currentManeuverIndex(alongM);
    const cur = this.maneuvers[current]!;
    const next = this.maneuvers[current + 1];
    const legM = (next?.alongStartM ?? this.totalM) - cur.alongStartM;
    const fractionLeft =
      legM > 0 ? Math.max(0, (next?.alongStartM ?? this.totalM) - alongM) / legM : 0;
    return fractionLeft * cur.timeMs + this.suffixTimeMs[current]!;
  }

  /**
   * The measured-congestion part of what is still ahead — the same suffix walk
   * as {@link baseRemainingMs}, over the traffic share of each leg. This is
   * what lets the banner name the delay honestly while it is still coming and
   * stop naming it once it has been driven through.
   */
  private remainingTrafficMs(alongM: number): number {
    if (this.maneuvers.length === 0) return 0;
    const current = this.currentManeuverIndex(alongM);
    const cur = this.maneuvers[current]!;
    const next = this.maneuvers[current + 1];
    const legM = (next?.alongStartM ?? this.totalM) - cur.alongStartM;
    const fractionLeft =
      legM > 0 ? Math.max(0, (next?.alongStartM ?? this.totalM) - alongM) / legM : 0;
    return Math.round(
      fractionLeft * (cur.instruction.trafficDelayMs ?? 0) + this.suffixTrafficMs[current]!,
    );
  }

  private remainingTimeMs(alongM: number, distanceRemainingM: number): number {
    // Valhalla budgets every maneuver leg, so route progress already says how
    // much of the departure estimate has been consumed. Keep that schedule
    // intact: at planned pace `now + remaining` stays steady; a one-minute
    // stop moves arrival by one minute and cannot reprice the whole remaining
    // journey as though the current zero speed will last to the destination.
    return this.baseRemainingMs(alongM, distanceRemainingM);
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

  /**
   * How far along the route the traveller could plausibly have got since the
   * previous snap — the faster of the last and current speeds over the elapsed
   * interval, with margin for acceleration and a floor for GPS wander. Null
   * before the first fix has anchored a time and a position, where there is
   * nothing to reason from and the matcher keeps its plain ahead-slack.
   */
  private plausibleAdvanceM(nowMs: number, speedMps: number | null): number | null {
    if (this.lastFixMs === null || this.lastAlongM === null) return null;
    const dtS = (nowMs - this.lastFixMs) / 1000;
    if (!Number.isFinite(dtS) || dtS < 0) return null;
    // No speed anywhere means no bound: some devices report none at all, and
    // an invented one would hold the match back on a road being driven fast.
    if (speedMps === null && this.lastSpeedMps === null) return null;
    const speed = Math.max(speedMps ?? 0, this.lastSpeedMps ?? 0);
    return speed * dtS * ADVANCE_SPEED_MARGIN + ADVANCE_SLACK_M;
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
    // Collapse phases that would land on top of each other. Counted outward
    // from the maneuver, so what survives is the cue closest to the turn plus
    // whichever earlier one is far enough away to be worth hearing — three
    // announcements inside a hundred metres of walking is nagging, not
    // guidance. Zero spacing (every driving profile) keeps all three.
    const spacingM = this.opts.minPromptSpacingM;
    const preActive = preThresholdM - nowThresholdM >= spacingM;
    const alertActive = alertThresholdM - (preActive ? preThresholdM : nowThresholdM) >= spacingM;

    if (d <= nowThresholdM) {
      const key = `${idx}:now`;
      if (this.firedPrompts.has(key)) return [];
      // A jump straight to the maneuver skips its earlier phases for good.
      this.firedPrompts.add(`${idx}:alert`);
      this.firedPrompts.add(`${idx}:pre`);
      this.firedPrompts.add(key);
      return [{ text: this.cueText(idx, 'now'), kind: 'now', maneuverIndex: idx, thresholdM: 0 }];
    }

    if (preActive && d <= preThresholdM) {
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

    if (alertActive && d <= alertThresholdM) {
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
