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

/**
 * Format an instant as a Norwegian 24-hour wall clock: `"07:12"`.
 *
 * A non-finite input renders as `"--:--"` rather than `"NaN:NaN"`. Not
 * hypothetical: the clients take the backend's journey JSON at its word (see
 * `fetchTransitTrips`), so a field a newer or older server omits arrives here as
 * `undefined` and would otherwise be painted, in a large font, where a departure
 * time belongs.
 */
export function norwayClock(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '--:--';
  const { minutesOfDay } = norwayTime(epochMs);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${pad(Math.floor(minutesOfDay / 60))}:${pad(minutesOfDay % 60)}`;
}

/**
 * Weekday and month names, hand-held rather than asked of `Intl`.
 *
 * The same decision as `fmtClock` in `@atlas/core`: this module already computes
 * Norway's UTC offset instead of trusting a runtime's tz database, and a date
 * label that came from `Intl` would be Norwegian on a Norwegian phone, American
 * on a container and absent on Hermes — three renderings of one commute. The
 * app's copy is English throughout ("Leave at", "Any line"), so these are too.
 */
const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** `"Tuesday"` / `"Tue"` for an instant, read off the Norwegian calendar. */
export function norwayWeekdayLabel(epochMs: number, short = false): string {
  const name = WEEKDAY_NAMES[norwayTime(epochMs).weekday - 1] ?? '';
  return short ? name.slice(0, 3) : name;
}

/** `"Tuesday 25 August"` — the dashboard header's date line. */
export function norwayDateLabel(epochMs: number, short = false): string {
  const { day, month } = norwayTime(epochMs);
  const monthName = MONTH_NAMES[month] ?? '';
  return `${norwayWeekdayLabel(epochMs, short)} ${day} ${short ? monthName.slice(0, 3) : monthName}`;
}

/**
 * Whole Norwegian *calendar* days from one instant to another — 0 for today, 1
 * for tomorrow — regardless of how many hours apart they are. 23:50 and 00:10
 * are twenty minutes and one day apart, and a departure board that calls the
 * second one "today" sends someone to the stop a day early.
 */
export function norwayDayOffset(fromMs: number, toMs: number): number {
  const start = norwayTime(fromMs);
  const end = norwayTime(toMs);
  const midnight = (t: NorwayTime) => Date.UTC(t.year, t.month, t.day);
  return Math.round((midnight(end) - midnight(start)) / 86_400_000);
}

/**
 * How a departure names its day when it is not today: `null`, `"Tomorrow"`, or
 * the date itself. Null for today is the point — a board that stamps every row
 * with "Today" has spent its most valuable line saying nothing.
 */
export function norwayDayNote(nowMs: number, whenMs: number, short = false): string | null {
  const offset = norwayDayOffset(nowMs, whenMs);
  if (offset === 0) return null;
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  return norwayDateLabel(whenMs, short);
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
