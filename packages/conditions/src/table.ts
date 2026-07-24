/**
 * The forecast **table** model shared by the web panel and the Android sheet.
 *
 * The scrubber answers "what is it like at this exact hour"; the table answers
 * "what is the day like" — yr.no's strength, where a whole day reads in one
 * glance. Planner rows are grouped into calendar days and, within each day,
 * into the four six-hour periods (Night / Morning / Afternoon / Evening), each
 * summarised down to the columns a reader actually scans: symbol, temperature,
 * precipitation and — the value this exists for — **wind**, which the scrubber
 * hides behind a single selected hour.
 *
 * Deciding the column set here, once, is the whole point: both platforms render
 * the same table from this data rather than drifting into two layouts. The
 * shape is pure data (numbers + a locale-free hour label); day-heading and
 * clock words are formatted in the UI via the shared `@atlas/core` helpers so
 * the 24-hour / weekday rules stay in one place.
 *
 * Grouping is by **device-local** time (`Date#getHours`), matching every other
 * clock in the app; for a Norwegian user viewing Norwegian coordinates that is
 * the location's local time. A step landing on a period boundary counts as the
 * start of the later period (06:00 is Morning, not Night).
 */
import type { PlannerHour } from './planner.js';

/** One of yr.no's four six-hour reading periods. */
export type DayPeriod = 'night' | 'morning' | 'afternoon' | 'evening';

/** A period summarised to the columns the table shows, plus the hours behind it. */
export interface ForecastPeriodCell {
  period: DayPeriod;
  /** Heading word — "Night" | "Morning" | "Afternoon" | "Evening". */
  label: string;
  /** Local-time span, e.g. "06–12" (locale-free — just the boundary hours). */
  hoursLabel: string;
  /** Representative met.no `symbol_code` for the period (the wettest hour, else mid-period). */
  symbol: string;
  /** Coldest hour in the period, °C. */
  tempMin: number;
  /** Warmest hour in the period, °C. */
  tempMax: number;
  /** Total precipitation over the period, mm (null when no step carried an amount). */
  precipMm: number | null;
  /** Highest probability-of-precipitation across the period, % (null when unavailable). */
  precipProb: number | null;
  /** Strongest sustained wind in the period, m/s. */
  windMax: number;
  /** Strongest gust in the period, m/s (null when the product omits gusts). */
  gustMax: number | null;
  /** Wind direction FROM at the windiest hour, degrees (0 = N). */
  windFromDir: number;
  /** The per-hour planner rows in this period, in order (drives row expansion). */
  hours: PlannerHour[];
  /** Index into the flat planner array of the representative hour — selects it on tap. */
  selectIndex: number;
}

/** A calendar day: local-midnight timestamp and its (present) periods. */
export interface ForecastDay {
  /** Local-midnight epoch ms for the day — format its heading with `fmtDayLabel`. */
  dateMs: number;
  periods: ForecastPeriodCell[];
}

const PERIOD_META: { period: DayPeriod; label: string }[] = [
  { period: 'night', label: 'Night' },
  { period: 'morning', label: 'Morning' },
  { period: 'afternoon', label: 'Afternoon' },
  { period: 'evening', label: 'Evening' },
];

const pad2 = (n: number): string => `${n}`.padStart(2, '0');

/** Local-midnight epoch ms for a timestamp (the day-grouping key). */
function localMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Build one period cell from its hours (never empty) and their flat indices. */
function summarise(
  periodIdx: number,
  entries: { row: PlannerHour; index: number }[],
): ForecastPeriodCell {
  const meta = PERIOD_META[periodIdx]!;
  const startHour = periodIdx * 6;

  let tempMin = Infinity;
  let tempMax = -Infinity;
  let precipMm: number | null = null;
  let precipProb: number | null = null;
  let windMax = -Infinity;
  let gustMax: number | null = null;
  let windAtMax = entries[0]!.row.point.windFromDir;
  // Representative hour: the wettest (most significant weather), else the middle.
  let repEntry = entries[Math.floor(entries.length / 2)]!;
  let repPrecip = -Infinity;

  for (const entry of entries) {
    const p = entry.row.point;
    if (p.temp < tempMin) tempMin = p.temp;
    if (p.temp > tempMax) tempMax = p.temp;
    if (p.precip != null) precipMm = (precipMm ?? 0) + p.precip;
    if (p.precipProb != null) precipProb = Math.max(precipProb ?? 0, p.precipProb);
    if (p.windSpeed > windMax) {
      windMax = p.windSpeed;
      windAtMax = p.windFromDir;
    }
    if (p.windGust != null) gustMax = Math.max(gustMax ?? 0, p.windGust);
    const wetness = p.precip ?? 0;
    if (wetness > repPrecip) {
      repPrecip = wetness;
      repEntry = entry;
    }
  }

  return {
    period: meta.period,
    label: meta.label,
    hoursLabel: `${pad2(startHour)}–${pad2(startHour + 6)}`,
    symbol: repEntry.row.point.symbol,
    tempMin,
    tempMax,
    precipMm,
    precipProb,
    windMax,
    gustMax,
    windFromDir: windAtMax,
    hours: entries.map((e) => e.row),
    selectIndex: repEntry.index,
  };
}

/**
 * Group planner rows into a browsable day/period table. Days appear in order;
 * within each, only periods that actually have forecast steps are present (the
 * current partial period at the start, and any gap in the six-hourly tail, are
 * simply absent rather than shown empty). `rows` is the same array the caller
 * holds, so `selectIndex` indexes straight back into it for the scrubber.
 */
export function forecastTable(rows: PlannerHour[]): ForecastDay[] {
  // day-midnight ms → period index (0..3) → the rows in that period.
  const byDay = new Map<number, Map<number, { row: PlannerHour; index: number }[]>>();
  const order: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const dayMs = localMidnight(row.timeMs);
    const periodIdx = Math.floor(new Date(row.timeMs).getHours() / 6);
    let periods = byDay.get(dayMs);
    if (!periods) {
      periods = new Map();
      byDay.set(dayMs, periods);
      order.push(dayMs);
    }
    (periods.get(periodIdx) ?? periods.set(periodIdx, []).get(periodIdx)!).push({ row, index });
  }

  return order.map((dateMs) => {
    const periods = byDay.get(dateMs)!;
    const cells: ForecastPeriodCell[] = [];
    for (let periodIdx = 0; periodIdx < 4; periodIdx++) {
      const entries = periods.get(periodIdx);
      if (entries && entries.length > 0) cells.push(summarise(periodIdx, entries));
    }
    return { dateMs, periods: cells };
  });
}
