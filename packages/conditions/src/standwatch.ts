/**
 * "Which of my stands is on tonight?" — the ten-day answer for saved stands
 * (ROADMAP § E12).
 *
 * The shortlist answers a question asked once per area: *where should I sit?*
 * The repeat action of a season is the opposite one — three to eight stands you
 * already know, and one decision each afternoon about which of them the wind
 * allows. Nothing here derives a surface, routes a walk or asks a new upstream:
 * it is the forecast, the sun and the rose the stand was already saved with.
 *
 * Three scope corrections are the substance of this file, each replacing a rule
 * the shortlist was right to have and that is wrong here:
 *
 * - **The verdict is per sit, not per day.** A stand blown at dawn and perfect
 *   at dusk got one word for both, because the window was taken at the peak hour
 *   of the day. Morning and evening are separate questions and are asked
 *   separately.
 * - **Scent is read over the whole window, not at its best hour.** A score can
 *   be averaged; a hazard cannot. The verdict a cell reports is the *worst* the
 *   forecast expects while you are sitting there, and the arrow it shows is the
 *   one that produced that verdict — not a different, kinder hour's.
 * - **Ten days, honest about what a day means.** met.no's series runs ~9.5 days
 *   but turns 6-hourly past ~3, and a 6-hourly step cannot resolve a dawn sit.
 *   The *timing* stays exact all ten days because `sun.ts` needs no forecast, so
 *   a cell keeps its real window and marks itself coarse rather than pretending
 *   to an hour it does not have.
 */

import { fmtClock, standScentExposure, type PlaceStand, type StandScentReading } from '@atlas/core';
import { assessConditions, type ActivityRating, type HuntConditionsProfile } from './conditions.js';
import { windArrow } from './display.js';
import { buildPlanner, type PlannerHour } from './planner.js';
import { sunDay } from './sun.js';
import type { WeatherForecast } from './weather.js';

/** The two sits a roe hunter actually chooses between. */
export type StandSit = 'morning' | 'evening';

export const STAND_SITS: readonly StandSit[] = ['morning', 'evening'];

/** How many days ahead the board offers. met.no's series stops just short of ten. */
export const STAND_BOARD_DAYS = 10;

/** Past this step length a forecast cell describes a part of a day, not an hour. */
const COARSE_STEP_MS = 90 * 60_000;

/** How long after sunrise roe movement is still worth sitting out. */
const AFTER_SUNRISE_MS = 90 * 60_000;
/** How long before sunset the evening sit is worth taking up. */
const BEFORE_SUNSET_MS = 90 * 60_000;
/** Usable shooting light either side, when civil twilight is not reported. */
const TWILIGHT_FALLBACK_MS = 40 * 60_000;

/** The clock window of one sit, and why it is where it is. */
export interface StandSitWindow {
  readonly startMs: number;
  readonly endMs: number;
  /**
   * Set where the sun does not rise or set on this date. Norway spans the
   * Arctic Circle and the roe rut peaks in late July, so a Nordland stand in
   * rut week genuinely has no first light to sit — a board that silently
   * returned midnight would be wrong exactly where it is hardest to guess.
   */
  readonly polar: 'day' | 'night' | null;
}

/**
 * The window for a sit on a calendar date at a point.
 *
 * Anchored on the sun rather than on clock hours, because that is the whole
 * reason the timing survives into the coarse tail of the forecast: sunrise on
 * day nine is known exactly while its weather is a six-hour average.
 */
export function standSitWindow(
  date: Date,
  lat: number,
  lon: number,
  sit: StandSit,
): StandSitWindow {
  const day = sunDay(date, lat, lon);
  if (day.sunrise && day.sunset) {
    if (sit === 'morning') {
      const start = day.dawn ?? new Date(day.sunrise.getTime() - TWILIGHT_FALLBACK_MS);
      return {
        startMs: start.getTime(),
        endMs: day.sunrise.getTime() + AFTER_SUNRISE_MS,
        polar: null,
      };
    }
    const end = day.dusk ?? new Date(day.sunset.getTime() + TWILIGHT_FALLBACK_MS);
    return {
      startMs: day.sunset.getTime() - BEFORE_SUNSET_MS,
      endMs: end.getTime(),
      polar: null,
    };
  }
  if (day.polar === 'day') {
    // Under the midnight sun the two sits do not separate: the darkest, coolest
    // stretch is solar midnight and both morning and evening collapse onto it.
    // The cell says so rather than inventing a dawn that does not happen.
    const midnight = day.solarNoon.getTime() + 12 * 3600_000;
    return { startMs: midnight - 90 * 60_000, endMs: midnight + 90 * 60_000, polar: 'day' };
  }
  // Polar night: there is no first or last light, only the brightest hours
  // around noon. Split them so the two sits still mean different clock time.
  const noon = day.solarNoon.getTime();
  return sit === 'morning'
    ? { startMs: noon - 3 * 3600_000, endMs: noon, polar: 'night' }
    : { startMs: noon, endMs: noon + 3 * 3600_000, polar: 'night' };
}

/** One day-cell of the board: a stand, a sit, a date. */
export interface StandDayCell {
  /** Local midnight of the day this cell is about. */
  readonly dayMs: number;
  readonly sit: StandSit;
  readonly window: StandSitWindow;
  /** Null past the forecast horizon — the sun is known, the weather is not. */
  readonly rating: ActivityRating | null;
  /** Mean conditions score across the sit, 0..100; null with no forecast. */
  readonly score: number | null;
  /** The worst scent verdict expected while you are sitting there. */
  readonly scent: StandScentReading | null;
  /** Wind at the hour that produced `scent`, so the arrow explains the verdict. */
  readonly windFromDeg: number | null;
  readonly windSpeed: number | null;
  /** True when the only steps covering this sit are 6-hourly or worse. */
  readonly coarse: boolean;
  /** Why this cell is empty, when it is. */
  readonly note: string | null;
}

/** Local midnight `offset` days after the local midnight containing `from`. */
function dayStart(from: Date, offset: number): Date {
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + offset);
  return day;
}

/** Step length at `index`, measured against its neighbour on either side. */
function stepMs(rows: readonly PlannerHour[], index: number): number {
  const next = rows[index + 1];
  if (next) return next.timeMs - rows[index]!.timeMs;
  const prev = rows[index - 1];
  return prev ? rows[index]!.timeMs - prev.timeMs : 3600_000;
}

export interface StandWatchOptions {
  readonly huntProfile?: HuntConditionsProfile;
  /** The stand's own slope/aspect, when the terrain fit succeeded. */
  readonly slopeDeg?: number | null;
  readonly aspectDeg?: number | null;
  readonly days?: number;
  readonly now?: Date;
}

/**
 * The ten-day column for one stand and one sit.
 *
 * A cell's score is the mean over the sit — you are there for the window, not
 * for its best hour — while its scent verdict is the worst hour in it, because
 * being winded once ends the sit and no amount of good hours either side undoes
 * it. The two answer different questions and are deliberately not blended.
 */
export function standWatchDays(
  stand: PlaceStand,
  forecast: WeatherForecast | null,
  sit: StandSit,
  opts: StandWatchOptions = {},
): StandDayCell[] {
  const now = opts.now ?? new Date();
  const dayCount = opts.days ?? STAND_BOARD_DAYS;
  const rows = forecast
    ? buildPlanner(forecast, {
        kind: 'hunting',
        huntProfile: opts.huntProfile,
        slopeDeg: opts.slopeDeg,
        aspectDeg: opts.aspectDeg,
        maxHours: dayCount * 24,
        now,
      })
    : [];
  const lat = forecast?.lat ?? stand.aim.position.lat;
  const lon = forecast?.lon ?? stand.aim.position.lng;

  const cells: StandDayCell[] = [];
  for (let offset = 0; offset < dayCount; offset++) {
    const day = dayStart(now, offset);
    const window = standSitWindow(day, lat, lon, sit);
    const covering: { row: PlannerHour; index: number }[] = [];
    rows.forEach((row, index) => {
      // A step describes the stretch *after* its timestamp, so it covers the
      // sit when those two stretches overlap at all.
      if (row.timeMs < window.endMs && row.timeMs + stepMs(rows, index) > window.startMs) {
        covering.push({ row, index });
      }
    });

    if (covering.length === 0) {
      cells.push({
        dayMs: day.getTime(),
        sit,
        window,
        rating: null,
        score: null,
        scent: null,
        windFromDeg: null,
        windSpeed: null,
        coarse: false,
        note:
          window.endMs < now.getTime()
            ? 'This sit is already past.'
            : 'Beyond the forecast — the timing is known, the weather is not.',
      });
      continue;
    }

    let scoreSum = 0;
    let worst: { scent: StandScentReading; row: PlannerHour } | null = null;
    let coarse = false;
    for (const { row, index } of covering) {
      const assessment =
        row.assessment ??
        assessConditions('hunting', {
          point: row.point,
          sunAltitudeDeg: row.sunAltitudeDeg,
          huntProfile: opts.huntProfile,
          slopeDeg: opts.slopeDeg,
          aspectDeg: opts.aspectDeg,
          latitude: lat,
        });
      scoreSum += assessment.score;
      if (stepMs(rows, index) > COARSE_STEP_MS) coarse = true;
      const scent = standScentExposure(stand, row.point.windFromDir);
      if (scent && (!worst || scent.exposure > worst.scent.exposure)) worst = { scent, row };
    }

    const mean = scoreSum / covering.length;
    cells.push({
      dayMs: day.getTime(),
      sit,
      window,
      rating: mean >= 72 ? 'prime' : mean >= 55 ? 'good' : mean >= 40 ? 'fair' : 'slow',
      score: Math.round(mean),
      scent: worst?.scent ?? null,
      windFromDeg: worst?.row.point.windFromDir ?? null,
      windSpeed: worst ? Math.round(worst.row.point.windSpeed * 10) / 10 : null,
      coarse,
      note: null,
    });
  }
  return cells;
}

/** How a cell orders against another: scent first, then the conditions score. */
const VERDICT_ORDER = { good: 0, crosswind: 1, blown: 2 } as const;

/**
 * Rank cells for the same day and sit — scent verdict first, score second.
 *
 * Scent leads because it is the one factor that decides the sit outright: a
 * prime-scoring stand you are blown out of is not a better plan than a fair one
 * the wind allows, and presenting it above would be the board recommending the
 * hunt it exists to prevent. Cells with no forecast sort last; they are not a
 * recommendation either way.
 */
export function compareStandCells(a: StandDayCell | null, b: StandDayCell | null): number {
  if (!a || a.score === null) return !b || b.score === null ? 0 : 1;
  if (!b || b.score === null) return -1;
  const verdictA = a.scent ? VERDICT_ORDER[a.scent.verdict] : 1.5;
  const verdictB = b.scent ? VERDICT_ORDER[b.scent.verdict] : 1.5;
  if (verdictA !== verdictB) return verdictA - verdictB;
  return b.score - a.score;
}

/**
 * The eight bearings' worth of elevation a stand's slope fit needs, as ring
 * offsets. Kept beside the model so the sampling radius and the fit that reads
 * it cannot drift apart.
 */
export const STAND_SLOPE_RADIUS_M = 60;
export const STAND_SLOPE_BEARINGS: readonly number[] = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * A cell as words, so web and Android say the same thing about one evening.
 *
 * The wording lives here for the reason §7.6 gave: two hand-maintained copies of
 * "Blown out" is how the clients drift, and this is a sentence a hunter will
 * compare across the two screens on the same afternoon.
 */
export interface StandCellSummary {
  /** Local `HH:MM–HH:MM` for the sit. */
  readonly windowLabel: string;
  /** The verdict as a badge word. */
  readonly scentLabel: string;
  /** The verdict as a sentence, or why there is none. */
  readonly detail: string;
  /** `↘ 4 m/s`, pointing the way the wind blows — null with no forecast. */
  readonly windLabel: string | null;
  /** `Prime · 78`, or null past the forecast. */
  readonly ratingLabel: string | null;
  /** Set when this cell is a six-hour average being read as an evening. */
  readonly coarseNote: string | null;
  /** Set where the sun does not rise or set on this date. */
  readonly polarNote: string | null;
}

const SCENT_WORDS = {
  good: 'Wind clean',
  crosswind: 'Crosswind',
  blown: 'Blown out',
} as const;

const RATING_WORDS = { prime: 'Prime', good: 'Good', fair: 'Fair', slow: 'Slow' } as const;

export function standCellSummary(cell: StandDayCell): StandCellSummary {
  return {
    windowLabel: `${fmtClock(cell.window.startMs)}–${fmtClock(cell.window.endMs)}`,
    scentLabel: cell.scent ? SCENT_WORDS[cell.scent.verdict] : 'Wind unknown',
    detail: cell.scent?.detail ?? cell.note ?? 'No wind forecast for this sit.',
    windLabel:
      cell.windFromDeg === null
        ? null
        : `${windArrow(cell.windFromDeg)} ${cell.windSpeed ?? '?'} m/s`,
    ratingLabel: cell.rating === null ? null : `${RATING_WORDS[cell.rating]} · ${cell.score}`,
    // Named rather than hidden: a six-hour average cannot resolve a dawn sit,
    // and a cell that looked like the others would be claiming it can.
    coarseNote: cell.coarse ? 'Six-hourly forecast — read as a day, not an hour.' : null,
    polarNote:
      cell.window.polar === 'day'
        ? 'Midnight sun — first and last light do not separate here.'
        : cell.window.polar === 'night'
          ? 'Polar night — these are the brightest hours, not first light.'
          : null,
  };
}
