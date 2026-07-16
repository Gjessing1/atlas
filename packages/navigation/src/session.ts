import type { LatLng } from '@atlas/core';
import type { RouteInstruction, RoutePath } from '@atlas/routing';

import { cumulativeDistances, snapToPolyline } from './geometry.js';
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

/**
 * Follows a single planned route against a stream of position fixes, producing
 * the state a turn-by-turn UI renders (snapped position, next maneuver, ETA)
 * plus voice prompts and off-route detection. Platform-neutral: the app owns
 * the GPS source, TTS, and the decision to reroute when status is `off-route`.
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
    const snap = snapToPolyline(position, this.points, this.cum);
    const alongM = snap.alongM;
    const distanceRemainingM = Math.max(0, this.totalM - alongM);

    if (distanceRemainingM <= this.opts.arrivalRadiusM) this.arrived = true;

    if (snap.crossTrackM > this.opts.offRouteM) this.offRouteCount++;
    else this.offRouteCount = 0;
    const offRoute = this.offRouteCount >= this.opts.offRouteGraceUpdates;

    const upcoming = this.arrived ? null : this.findUpcoming(alongM);
    const prompts = this.arrived || offRoute ? [] : this.collectPrompts(upcoming);

    const state: NavState = {
      status: this.arrived ? 'arrived' : offRoute ? 'off-route' : 'navigating',
      snapped: snap.point,
      offRouteM: snap.crossTrackM,
      traveledM: alongM,
      routeProgress: this.arrived ? 1 : this.totalM > 0 ? Math.min(1, alongM / this.totalM) : 0,
      distanceRemainingM,
      timeRemainingMs: this.remainingTimeMs(alongM, distanceRemainingM),
      etaEpochMs: nowMs + this.remainingTimeMs(alongM, distanceRemainingM),
      upcoming,
    };
    return { state, prompts };
  }

  /** The maneuver being approached: the first one strictly ahead of `alongM`. */
  private findUpcoming(alongM: number): UpcomingManeuver | null {
    for (const m of this.maneuvers) {
      if (m.alongStartM > alongM + EPS) {
        return { instruction: m.instruction, distanceToM: m.alongStartM - alongM };
      }
    }
    return null;
  }

  private remainingTimeMs(alongM: number, distanceRemainingM: number): number {
    if (this.maneuvers.length === 0) {
      return this.totalM > 0 ? this.totalTimeMs * (distanceRemainingM / this.totalM) : 0;
    }
    // Find the maneuver currently being executed (last one started) and add the
    // unfinished fraction of its leg to the time of every maneuver after it.
    let current = 0;
    for (let i = 0; i < this.maneuvers.length; i++) {
      if (this.maneuvers[i]!.alongStartM <= alongM + EPS) current = i;
      else break;
    }
    const cur = this.maneuvers[current]!;
    const next = this.maneuvers[current + 1];
    const legM = (next?.alongStartM ?? this.totalM) - cur.alongStartM;
    const fractionLeft =
      legM > 0 ? Math.max(0, (next?.alongStartM ?? this.totalM) - alongM) / legM : 0;
    return fractionLeft * cur.timeMs + this.suffixTimeMs[current]!;
  }

  private collectPrompts(upcoming: UpcomingManeuver | null): VoicePrompt[] {
    if (!upcoming) return [];
    // Locate the maneuver's index in our list to key fired prompts stably.
    const idx = this.maneuvers.find((m) => m.instruction === upcoming.instruction)?.index ?? -1;
    if (idx < 0) return [];
    const d = upcoming.distanceToM;

    if (d <= this.opts.nowThresholdM) {
      const key = `${idx}:now`;
      if (this.firedPrompts.has(key)) return [];
      // A jump straight to the maneuver skips its approach prompts for good.
      for (const t of this.opts.approachThresholdsM) this.firedPrompts.add(`${idx}:${t}`);
      this.firedPrompts.add(key);
      return [{ text: upcoming.instruction.text, kind: 'now', maneuverIndex: idx, thresholdM: 0 }];
    }

    // Fire the tightest not-yet-fired threshold we've crossed; mark looser ones
    // fired too so a large GPS jump doesn't replay them later.
    const crossed = this.opts.approachThresholdsM
      .filter((t) => d <= t && !this.firedPrompts.has(`${idx}:${t}`))
      .sort((a, b) => a - b);
    const t = crossed[0];
    if (t === undefined) return [];
    for (const larger of this.opts.approachThresholdsM) {
      if (larger >= t) this.firedPrompts.add(`${idx}:${larger}`);
    }
    return [
      {
        text: `In ${t} meters, ${upcoming.instruction.text}`,
        kind: 'approach',
        maneuverIndex: idx,
        thresholdM: t,
      },
    ];
  }
}
