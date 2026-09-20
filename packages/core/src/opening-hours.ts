/**
 * A deliberately strict, locale-independent subset of OSM `opening_hours`.
 * Unknown syntax returns null: a missing status is better than telling someone
 * a closed pharmacy is open.
 */

const DAY_KEYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
type DayKey = (typeof DAY_KEYS)[number];

interface MinutesInterval {
  start: number;
  end: number;
}

export interface OpeningHoursDay {
  day: DayKey;
  label: string;
  /** Human-readable 24-hour spans, or `Closed`. */
  hours: string;
  today: boolean;
}

export interface OpeningHoursStatus {
  isOpen: boolean;
  /** `Open`, `Closed`, or `Open 24 hours`. */
  statusText: string;
  /** `Closes 21:00`, `Opens tomorrow 09:00`, and similar. */
  nextOpenOrClose: string | null;
  todayHours: string;
  weeklyHours: OpeningHoursDay[];
}

interface ParsedRule {
  days: number[];
  intervals: MinutesInterval[];
  display: string;
}

const pad = (value: number) => `${value}`.padStart(2, '0');
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}

function selectorDays(selector: string): number[] | null {
  const days = new Set<number>();
  for (const part of selector.split(',').map((value) => value.trim())) {
    if (part === 'PH' || part === 'SH') continue;
    const range = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part);
    if (!range) return null;
    const start = DAY_KEYS.indexOf(range[1] as DayKey);
    const end = range[2] ? DAY_KEYS.indexOf(range[2] as DayKey) : start;
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === end) break;
    }
  }
  return [...days];
}

/**
 * A comma can join times (`10:00-14:00,16:00-20:00`) or start a whole new
 * rule (`Mo-Fr 08:00-22:00, Sa 08:00-20:00`). Split it only after the current
 * fragment already has its state, and only when the suffix begins a complete
 * selector followed by another state.
 */
function splitRules(value: string): string[] {
  const rules: string[] = [];
  for (const semicolonPart of value.split(';')) {
    let start = 0;
    for (let index = 0; index < semicolonPart.length; index++) {
      if (semicolonPart[index] !== ',') continue;
      const before = semicolonPart.slice(start, index);
      const after = semicolonPart.slice(index + 1);
      const hasState = /(?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}|\b(?:off|closed)\b)/i.test(before);
      const startsRule =
        /^\s*(?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,\s*)*(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s+(?:\d|off\b|closed\b)/i.test(
          after,
        );
      if (hasState && startsRule) {
        rules.push(before.trim());
        start = index + 1;
      }
    }
    rules.push(semicolonPart.slice(start).trim());
  }
  return rules.filter(Boolean);
}

function parseRule(value: string): ParsedRule | null {
  const match =
    /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,\s*)*(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)\s+(.+)$/i.exec(
      value,
    );
  // No day selector at all means every day: `12:00-24:00` is the most common
  // unparsed shape in the database (129 of Berlin's top-8 misses alone), and
  // the specification is unambiguous about it.
  const days = match ? selectorDays(match[1]!.replaceAll(/\s/g, '')) : [0, 1, 2, 3, 4, 5, 6];
  if (!days) return null;
  const state = (match ? match[2]! : value).trim();
  if (/^(?:off|closed)$/i.test(state)) return { days, intervals: [], display: 'Closed' };
  const intervals: MinutesInterval[] = [];
  const display: string[] = [];
  for (const span of state.split(',')) {
    const range = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(span.trim());
    if (!range) return null;
    const start = parseClock(range[1]!);
    const end = parseClock(range[2]!);
    if (start === null || end === null || start === 1440 || start === end) return null;
    intervals.push({ start, end: end <= start ? end + 1440 : end });
    display.push(`${clock(start)}–${end === 1440 ? '24:00' : clock(end)}`);
  }
  return { days, intervals, display: display.join(', ') };
}

function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayOffsetLabel(offset: number, date: Date): string {
  if (offset === 0) return '';
  if (offset === 1) return 'tomorrow ';
  return `${DAY_LABELS[mondayIndex(date)]} `;
}

/** Extract an exact quoted comment such as `"by appointment"`. */
export function openingHoursComment(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^\s*"([^"\r\n]+)"\s*$/.exec(value);
  return match?.[1]?.trim() || null;
}

/** Parse and evaluate supported opening hours in the device's local timezone. */
export function parseOpeningHours(
  value: string | undefined,
  nowMs = Date.now(),
): OpeningHoursStatus | null {
  const source = value?.trim();
  if (!source || openingHoursComment(source)) return null;
  if (/^(?:off|closed)$/i.test(source)) {
    const now = new Date(nowMs);
    return {
      isOpen: false,
      statusText: 'Closed',
      nextOpenOrClose: null,
      todayHours: 'Closed',
      weeklyHours: DAY_KEYS.map((day, index) => ({
        day,
        label: DAY_LABELS[index]!,
        hours: 'Closed',
        today: index === mondayIndex(now),
      })),
    };
  }
  if (source === '24/7') {
    const now = new Date(nowMs);
    return {
      isOpen: true,
      statusText: 'Open 24 hours',
      nextOpenOrClose: null,
      todayHours: 'Open 24 hours',
      weeklyHours: DAY_KEYS.map((day, index) => ({
        day,
        label: DAY_LABELS[index]!,
        hours: 'Open 24 hours',
        today: index === mondayIndex(now),
      })),
    };
  }
  // Unsupported OSM constructs whose calendar or semantics cannot be inferred.
  if (
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|week)\b/i.test(source) ||
    /\[-?\d+\]/.test(source) ||
    /\d{1,2}:\d{2}\s*\+/.test(source) ||
    /"/.test(source)
  ) {
    return null;
  }

  const rules = splitRules(source).map(parseRule);
  if (rules.length === 0 || rules.some((rule) => rule === null)) return null;
  const parsed = rules as ParsedRule[];
  if (!parsed.some((rule) => rule.days.length > 0)) return null;

  const schedules: { intervals: MinutesInterval[]; display: string }[] = DAY_KEYS.map(() => ({
    intervals: [],
    display: 'Closed',
  }));
  for (const rule of parsed) {
    for (const day of rule.days)
      schedules[day] = { intervals: rule.intervals, display: rule.display };
  }

  const now = new Date(nowMs);
  const today = startOfDay(now);
  const occurrences: { start: number; end: number }[] = [];
  for (let offset = -1; offset <= 7; offset++) {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);
    const schedule = schedules[mondayIndex(date)]!;
    for (const interval of schedule.intervals) {
      occurrences.push({
        start: date.getTime() + interval.start * 60_000,
        end: date.getTime() + interval.end * 60_000,
      });
    }
  }
  occurrences.sort((a, b) => a.start - b.start);
  const current = occurrences
    .filter((item) => item.start <= nowMs && item.end > nowMs)
    .sort((a, b) => b.end - a.end)[0];
  const isOpen = Boolean(current);
  let nextOpenOrClose: string | null = null;
  if (current) {
    // Adjacent/overlapping intervals are one continuous opening.
    let closeAt = current.end;
    for (const item of occurrences)
      if (item.start <= closeAt && item.end > closeAt) closeAt = item.end;
    nextOpenOrClose = `Closes ${clock(new Date(closeAt).getHours() * 60 + new Date(closeAt).getMinutes())}`;
  } else {
    const next = occurrences.find((item) => item.start > nowMs);
    if (next) {
      const date = new Date(next.start);
      const offset = Math.round((startOfDay(date).getTime() - today.getTime()) / 86_400_000);
      nextOpenOrClose = `Opens ${dayOffsetLabel(offset, date)}${clock(date.getHours() * 60 + date.getMinutes())}`;
    }
  }

  const todayIndex = mondayIndex(now);
  return {
    isOpen,
    statusText: isOpen ? 'Open' : 'Closed',
    nextOpenOrClose,
    todayHours: schedules[todayIndex]!.display,
    weeklyHours: DAY_KEYS.map((day, index) => ({
      day,
      label: DAY_LABELS[index]!,
      hours: schedules[index]!.display,
      today: index === todayIndex,
    })),
  };
}

/** Domain-only website label; clients retain the original URL as the target. */
export function websiteDisplayName(value: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.replace(/^www\./i, '') || value;
  } catch {
    return value
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/$/, '');
  }
}
