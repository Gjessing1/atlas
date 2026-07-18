import type { LatLng } from '@atlas/core';
import type { RouteInstruction, RoutePath } from '@atlas/routing';

import { bearingDeg, cumulativeDistances, pointAtDistance, snapToRoute } from './geometry.js';
import {
  DEFAULT_NAV_OPTIONS,
  type NavigationOptions,
  type NavState,
  type NavUpdate,
  type Position,
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
/** Fix-to-fix intervals longer than this are gaps, not pace evidence. */
const PACE_MAX_SAMPLE_MS = 30_000;
/** The pace factor's effect on the ETA, clamped: one red light must not triple it. */
const PACE_MIN = 0.4;
const PACE_MAX = 2;

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
  private arrived = false;
  private readonly firedPrompts = new Set<string>();
  /** alongM of the previous snap — continuity hint for the map matcher. */
  private lastAlongM: number | null = null;
  /** Timestamp / along-route anchor / speed of the last accepted fix. */
  private lastFixMs: number | null = null;
  private alongAtFixM: number | null = null;
  private lastSpeedMps: number | null = null;
  private lastState: NavState | null = null;
  /** Observed speed over the route's expected speed, smoothed (1 = on pace). */
  private paceFactor = 1;

  constructor(route: RoutePath, options: NavigationOptions = {}) {
    if (route.points.length === 0) throw new Error('cannot navigate an empty route');
    this.points = route.points.map((p) => ({ lat: p.lat, lng: p.lng }));
    this.cum = cumulativeDistances(this.points);
    this.totalM = this.cum[this.cum.length - 1] ?? 0;
    this.totalTimeMs = route.timeMs;
    this.opts = { ...DEFAULT_NAV_OPTIONS, ...options };

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

  /** Feed one position fix; returns the new state and any voice prompts it triggered. */
  update(position: Position, nowMs: number = Date.now()): NavUpdate {
    const accuracyM =
      typeof position.accuracyM === 'number' && position.accuracyM >= 0 ? position.accuracyM : null;
    // A hopeless fix (urban-canyon multipath) would teleport the puck and
    // corrupt the matcher's continuity hint; coast on the last state instead.
    if (accuracyM !== null && accuracyM > this.opts.discardAccuracyM && this.lastState !== null) {
      return this.tick(nowMs) ?? { state: this.lastState, prompts: [] };
    }
    const speedMps =
      typeof position.speedMps === 'number' && position.speedMps >= 0 ? position.speedMps : null;
    // The GPS course only disambiguates direction when actually moving —
    // stationary headings are compass noise.
    const moving = speedMps !== null && speedMps >= 2;
    const snap = snapToRoute(position, this.points, this.cum, {
      prevAlongM: this.lastAlongM,
      headingDeg:
        moving && typeof position.headingDeg === 'number' && position.headingDeg >= 0
          ? position.headingDeg
          : null,
    });
    this.lastAlongM = snap.alongM;
    const alongM = snap.alongM;
    const distanceRemainingM = Math.max(0, this.totalM - alongM);

    if (distanceRemainingM <= this.opts.arrivalRadiusM) this.arrived = true;

    // Only fixes accurate enough to prove a departure count toward off-route;
    // an uncertain fix leaves the tally untouched in either direction.
    if (accuracyM === null || accuracyM <= this.opts.offRouteMaxAccuracyM) {
      if (snap.crossTrackM > this.opts.offRouteM) this.offRouteCount++;
      else this.offRouteCount = 0;
    }
    const offRoute = this.offRouteCount >= this.opts.offRouteGraceUpdates;

    this.updatePace(nowMs, alongM, snap.crossTrackM);
    this.lastFixMs = nowMs;
    this.alongAtFixM = alongM;
    this.lastSpeedMps = speedMps;

    const [upcoming, then] = this.arrived ? [null, null] : this.findUpcoming(alongM);
    const prompts = this.arrived || offRoute ? [] : this.collectPrompts(upcoming, speedMps);

    const remainMs = this.remainingTimeMs(alongM, distanceRemainingM);
    const state: NavState = {
      status: this.arrived ? 'arrived' : offRoute ? 'off-route' : 'navigating',
      snapped: snap.point,
      raw: { lat: position.lat, lng: position.lng },
      offRouteM: snap.crossTrackM,
      traveledM: alongM,
      routeProgress: this.arrived ? 1 : this.totalM > 0 ? Math.min(1, alongM / this.totalM) : 0,
      distanceRemainingM,
      timeRemainingMs: remainMs,
      etaEpochMs: nowMs + remainMs,
      upcoming,
      then,
      currentRoad: this.roadAt(alongM),
      courseDeg: this.courseAt(alongM, speedMps),
      fix: 'live',
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
      // Past the distance cap the extrapolation is fiction, not a tunnel.
      if (d <= this.opts.deadReckonMaxM) reckonedM = d;
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
    const prompts = this.collectPrompts(upcoming, speed);
    const remainMs = this.remainingTimeMs(alongM, distanceRemainingM);
    const point = pointAtDistance(this.points, this.cum, alongM);
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
      currentRoad: this.roadAt(alongM),
      courseDeg: this.courseAt(alongM, speed),
      fix: 'estimated',
    };
    this.lastState = state;
    return { state, prompts };
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
      text: this.withChainedNext(0, first.instruction.text),
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
      ? last.instruction.text
      : 'You have arrived';
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

  /**
   * Route direction at `alongM` from a forward tangent (looking back at the
   * very end). The tangent length scales with speed — ~1.5 s of travel,
   * clamped to 25..60 m — so a fast course-up camera starts leaning into a
   * bend earlier while low-speed turns stay tight.
   */
  private courseAt(alongM: number, speedMps: number | null): number | null {
    if (this.points.length < 2 || this.totalM <= 0) return null;
    const LOOKAHEAD_M = Math.min(60, Math.max(25, (speedMps ?? 0) * 1.5));
    const from = Math.min(alongM, Math.max(0, this.totalM - LOOKAHEAD_M));
    const to = Math.min(this.totalM, from + LOOKAHEAD_M);
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

  private collectPrompts(
    upcoming: UpcomingManeuver | null,
    speedMps: number | null,
  ): VoicePrompt[] {
    if (!upcoming) return [];
    // Locate the maneuver's index in our list to key fired prompts stably.
    const idx = this.maneuvers.find((m) => m.instruction === upcoming.instruction)?.index ?? -1;
    if (idx < 0) return [];
    const d = upcoming.distanceToM;
    const text = this.withChainedNext(idx, upcoming.instruction.text);
    // At highway speed the standard thresholds give under 20 s of warning, so
    // an extra far-out prompt is armed; skipping it entirely at city speeds
    // keeps dense urban routes from becoming a monologue.
    const allThresholds = [this.opts.farApproachM, ...this.opts.approachThresholdsM];
    const activeThresholds =
      speedMps !== null && speedMps >= this.opts.farApproachMinSpeedMps
        ? allThresholds
        : this.opts.approachThresholdsM;

    if (d <= this.opts.nowThresholdM) {
      const key = `${idx}:now`;
      if (this.firedPrompts.has(key)) return [];
      // A jump straight to the maneuver skips its approach prompts for good.
      for (const t of allThresholds) this.firedPrompts.add(`${idx}:${t}`);
      this.firedPrompts.add(key);
      return [{ text, kind: 'now', maneuverIndex: idx, thresholdM: 0 }];
    }

    // Fire the tightest not-yet-fired threshold we've crossed; mark looser ones
    // fired too so a large GPS jump doesn't replay them later.
    const crossed = activeThresholds
      .filter((t) => d <= t && !this.firedPrompts.has(`${idx}:${t}`))
      .sort((a, b) => a - b);
    const t = crossed[0];
    if (t === undefined) return [];
    for (const larger of allThresholds) {
      if (larger >= t) this.firedPrompts.add(`${idx}:${larger}`);
    }
    return [
      {
        text: `In ${t} meters, ${text}`,
        kind: 'approach',
        maneuverIndex: idx,
        thresholdM: t,
      },
    ];
  }
}
