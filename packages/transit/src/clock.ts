/**
 * Norwegian wall-clock arithmetic for saved commutes.
 *
 * A commute is defined by a time of day — "leave 07:10", "at work by 08:30" —
 * and that time has to be resolved to an instant in two places that do not
 * share a timezone: the app (a phone, almost always on Norwegian time) and the
 * backend, which renders the home-screen widget's rows from a container whose
 * clock is UTC. Formatting there with `fmtClock` would put every departure an
 * hour or two early, which is the one error a commute widget must not make.
 *
 * So the zone is pinned to Norway rather than taken from the runtime. That is
 * not a simplification: public transport in Atlas is Entur, Entur is Norway
 * (see `transitCoverage`), and the departure time of a Norwegian service *is* a
 * Norwegian clock time — the same answer a traveller reading it from Berlin
 * wants.
 *
 * The rule is computed rather than looked up, deliberately: `Intl` with a
 * `timeZone` would work on Node but this module is shared code, and the repo
 * already hand-formats clocks (`@atlas/core`'s `fmtClock`) instead of trusting
 * a runtime's locale data. Norway has followed the EU rule since 1980 — UTC+1,
 * and UTC+2 from the last Sunday in March 01:00 UTC to the last Sunday in
 * October 01:00 UTC — and any change to it is legislated years ahead.
 */

const WINTER_OFFSET_MINUTES = 60;
const SUMMER_OFFSET_MINUTES = 120;

/** ISO weekday: 1 = Monday … 7 = Sunday. Matches how a commute is described. */
export type TransitWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const MINUTES_PER_DAY = 24 * 60;

/** Last Sunday of `month` (0-based) at 01:00 UTC — the EU changeover instant. */
function euChangeover(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const date = lastDay.getUTCDate() - lastDay.getUTCDay();
  return Date.UTC(year, month, date, 1);
}

/** Norway's UTC offset in minutes at an instant: 60 in winter, 120 in summer. */
export function norwayOffsetMinutes(epochMs: number): number {
  const year = new Date(epochMs).getUTCFullYear();
  const summerStart = euChangeover(year, 2);
  const summerEnd = euChangeover(year, 9);
  return epochMs >= summerStart && epochMs < summerEnd
    ? SUMMER_OFFSET_MINUTES
    : WINTER_OFFSET_MINUTES;
}

/** An instant as Norway reads it off a wall clock and a calendar. */
export interface NorwayTime {
  year: number;
  /** 0-based, as `Date` counts months. */
  month: number;
  day: number;
  weekday: TransitWeekday;
  /** Minutes past local midnight, e.g. 07:10 → 430. */
  minutesOfDay: number;
}

/** Split an instant into Norwegian local calendar and clock parts. */
export function norwayTime(epochMs: number): NorwayTime {
  const shifted = new Date(epochMs + norwayOffsetMinutes(epochMs) * 60_000);
  const isoWeekday = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: isoWeekday as TransitWeekday,
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/**
 * The instant of a Norwegian local date and clock time.
 *
 * Resolved in two passes because the offset depends on the answer: the first
 * pass assumes winter, the second re-reads the offset that actually applies
 * there. The hour that repeats when the clocks go back is genuinely ambiguous;
 * this picks one of the two deterministically rather than pretending otherwise.
 */
export function norwayInstant(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
): number {
  const naive = Date.UTC(year, month, day, 0, minutesOfDay);
  const guess = naive - WINTER_OFFSET_MINUTES * 60_000;
  return naive - norwayOffsetMinutes(guess) * 60_000;
}

/** Format an instant as a Norwegian 24-hour wall clock: `"07:12"`. */
export function norwayClock(epochMs: number): string {
  const { minutesOfDay } = norwayTime(epochMs);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${pad(Math.floor(minutesOfDay / 60))}:${pad(minutesOfDay % 60)}`;
}

/** Whether a weekday is one the commute runs. An empty list means every day. */
export function runsOnWeekday(days: readonly TransitWeekday[], weekday: TransitWeekday): boolean {
  return days.length === 0 || days.includes(weekday);
}

/**
 * The next instant at `minutesOfDay` on a day the commute runs, at or after
 * `fromMs`. Returns `fromMs` itself when the commute has no time of day: "leave
 * now" is a valid commute, and it is what an unconfigured one means.
 *
 * Searching forward a day at a time (eight tries covers a week plus the wrap)
 * rather than computing it: the day list is at most seven entries and the
 * arithmetic has to cross month, year and DST boundaries, all of which
 * `norwayInstant` already handles.
 */
export function nextCommuteInstant(
  minutesOfDay: number | null,
  days: readonly TransitWeekday[],
  fromMs: number,
): number {
  if (minutesOfDay === null) return fromMs;
  const start = norwayTime(fromMs);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = norwayInstant(start.year, start.month, start.day + offset, minutesOfDay);
    if (candidate < fromMs) continue;
    if (runsOnWeekday(days, norwayTime(candidate).weekday)) return candidate;
  }
  // Unreachable for any non-empty subset of a seven-day week; falling back to
  // "now" keeps a corrupt saved day list from producing a board about last week.
  return fromMs;
}
