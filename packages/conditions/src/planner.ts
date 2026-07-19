/**
 * Planner helpers shared by the web panel and the Android sheet: turn a
 * forecast into per-step rows (sun altitude + pressure trend + optional
 * activity assessment) and find the "best windows" worth highlighting.
 *
 * Plain weather comes first — rows always carry the forecast point and sun
 * altitude; the activity assessment is a second, optional layer (kind unset =
 * plain weather display, no scoring).
 */
import {
  assessConditions,
  pressureTrend,
  type ConditionAssessment,
  type ConditionsKind,
} from './conditions.js';
import { sunPosition } from './sun.js';
import type { WeatherForecast, WeatherPoint } from './weather.js';

/** One planner row: a forecast step enriched with sun + (optionally) a conditions score. */
export interface PlannerHour {
  point: WeatherPoint;
  /** Epoch ms of `point.time` (parsed once — the scrubber does time math constantly). */
  timeMs: number;
  /** Sun altitude at this step, degrees above the horizon. */
  sunAltitudeDeg: number;
  /** Pressure change vs ~3 h earlier, hPa (null when unknown). */
  pressureTrendHpa: number | null;
  /** Conditions score for the requested activity; absent in plain-weather mode. */
  assessment?: ConditionAssessment;
}

export interface PlannerOptions {
  /** Activity scoring layer; omit for plain weather display. */
  kind?: ConditionsKind | null;
  /** Species tag for the fishing temperature band (perch/pike/trout/char). */
  species?: string | null;
  /** Forecast horizon in hours (default 72 — met.no turns 6-hourly beyond ~3 days anyway). */
  maxHours?: number;
  /** "Now" override for tests. */
  now?: Date;
}

/**
 * Build the planner rows for a forecast: drop past steps (keeping the one
 * covering "now"), cap the horizon, compute sun altitude per step, and — when
 * an activity kind is given — attach the transparent assessment.
 */
export function buildPlanner(forecast: WeatherForecast, opts: PlannerOptions = {}): PlannerHour[] {
  const { kind, species, maxHours = 72 } = opts;
  const nowMs = (opts.now ?? new Date()).getTime();
  const rows: PlannerHour[] = [];
  let startMs: number | null = null;
  for (let i = 0; i < forecast.series.length; i++) {
    const point = forecast.series[i]!;
    const timeMs = new Date(point.time).getTime();
    // Keep the step that covers "now" (steps describe the hour after `time`).
    if (timeMs < nowMs - 3600_000) continue;
    startMs ??= timeMs;
    if (timeMs - startMs > maxHours * 3600_000) break;
    const sunAltitudeDeg = sunPosition(new Date(timeMs), forecast.lat, forecast.lon).altitude;
    const trendHpa = pressureTrend(forecast.series, i);
    rows.push({
      point,
      timeMs,
      sunAltitudeDeg,
      pressureTrendHpa: trendHpa,
      ...(kind
        ? {
            assessment: assessConditions(kind, {
              point,
              sunAltitudeDeg,
              pressureTrendHpa: trendHpa,
              species,
            }),
          }
        : {}),
    });
  }
  return rows;
}

/** A contiguous stretch of good-or-better conditions worth planning around. */
export interface ConditionsWindow {
  /** Indexes into the PlannerHour array (inclusive). */
  startIdx: number;
  endIdx: number;
  /** The best row inside the window. */
  peakIdx: number;
  peakScore: number;
}

/**
 * Find the best condition windows: contiguous runs of assessed rows scoring at
 * least `minScore` (default 55 = the "good" band), split on forecast gaps
 * (> 90 min — the 6-hourly tail never fakes an hourly window). Returns the top
 * `count` windows by peak score, in chronological order.
 */
export function bestWindows(
  hours: PlannerHour[],
  opts: { minScore?: number; count?: number } = {},
): ConditionsWindow[] {
  const { minScore = 55, count = 3 } = opts;
  const windows: ConditionsWindow[] = [];
  let run: ConditionsWindow | null = null;
  for (let i = 0; i < hours.length; i++) {
    const row = hours[i]!;
    const score = row.assessment?.score;
    const prev = i > 0 ? hours[i - 1]! : null;
    const gap = prev ? row.timeMs - prev.timeMs : 0;
    const qualifies = score !== undefined && score >= minScore;
    if (qualifies && run && gap <= 90 * 60_000) {
      run.endIdx = i;
      if (score! > run.peakScore) {
        run.peakScore = score!;
        run.peakIdx = i;
      }
    } else if (qualifies) {
      run = { startIdx: i, endIdx: i, peakIdx: i, peakScore: score! };
      windows.push(run);
    } else {
      run = null;
    }
  }
  return windows
    .sort((a, b) => b.peakScore - a.peakScore)
    .slice(0, count)
    .sort((a, b) => a.startIdx - b.startIdx);
}
