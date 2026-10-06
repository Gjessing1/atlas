/**
 * Units, clock and distance formatting. Atlas is metric and 24-hour
 * everywhere, whatever the device locale says, so these are hand-formatted
 * rather than left to Intl (see fmtClock for why that is not paranoia).
 */

import type { LatLng } from './geo.js';

/**
 * Clock time as HH:MM, 24-hour, always — in the device's local timezone.
 *
 * Hand-formatted rather than via toLocaleTimeString: an en-US device renders
 * AM/PM in nav banners and ETAs, and `hour12: false` is not a reliable fix —
 * some ICU builds return "24:05" for midnight, and Hermes ships its own Intl.
 * Atlas is 24-hour everywhere, so this must not depend on locale or engine.
 */
export function fmtClock(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Short weekday plus 24-hour clock, e.g. "Sat 18:00" — for forecast steps that
 * span more than a day. The weekday stays locale-derived (it is a translatable
 * word, not a number format); only the time is pinned.
 */
export function fmtDayClock(epochMs: number): string {
  const weekday = new Date(epochMs).toLocaleDateString([], { weekday: 'short' });
  return `${weekday} ${fmtClock(epochMs)}`;
}

/**
 * A time that may or may not be today: the clock alone when it is, weekday plus
 * clock when it is not. For anything the user *steps* through — a chosen
 * departure, a picked arrival — where "00:30" stepped past midnight would
 * otherwise read as half past midnight this morning, twenty-three hours ago.
 */
export function fmtWhenClock(epochMs: number, nowMs = Date.now()): string {
  const d = new Date(epochMs);
  const now = new Date(nowMs);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? fmtClock(epochMs) : fmtDayClock(epochMs);
}

/**
 * A calendar-day heading: "Today" / "Tomorrow" for the two nearest days,
 * otherwise short weekday plus day-of-month ("Sat 26"). For forecast/agenda
 * sections that span several days. Like {@link fmtDayClock}, the weekday word
 * stays locale-derived (it is translatable); the day number is pinned.
 */
export function fmtDayLabel(epochMs: number, nowMs = Date.now()): string {
  const d = new Date(epochMs);
  const now = new Date(nowMs);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Tomorrow';
  if (dayDiff === -1) return 'Yesterday';
  const weekday = d.toLocaleDateString([], { weekday: 'short' });
  return `${weekday} ${d.getDate()}`;
}

/**
 * A short calendar date for lists of saved things: "5 Jul", with the year only when it is not
 * this year ("5 Jul 2025"). Month word locale-derived, day number pinned, as in fmtDayLabel.
 */
export function fmtShortDate(epochMs: number, nowMs = Date.now()): string {
  const d = new Date(epochMs);
  const month = d.toLocaleDateString([], { month: 'short' });
  const year = d.getFullYear() === new Date(nowMs).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${month}${year}`;
}

/** Coordinates as a fixed 5-decimal (~1 m) "lat, lng" string. */
export function fmtCoords(p: LatLng): string {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

/**
 * A **live** distance readout — distance-to-turn, "1.2 km away" on a place
 * card: metres below 1 km, but rounded to 10 m above 100 m so a jittering GPS
 * fix doesn't churn the last digit. Use {@link fmtKm} for a static total, where
 * that deliberate coarseness would just lose precision.
 */
export function fmtDistanceM(m: number): string {
  if (m < 100) return `${Math.round(m)} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/**
 * A **static** distance total — a route's length, a track's distance: whole
 * metres below 1 km, one decimal kilometre above, at every magnitude. Nothing
 * is recomputed while the user watches, so there is no jitter to smooth over
 * (contrast {@link fmtDistanceM}).
 */
export function fmtKm(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * A duration as "45 min" / "2 h 5 min".
 *
 * Rounds to whole minutes *before* splitting hours, so 59.9 minutes reads
 * "1 h 0 min" rather than "59 min" — the two apps used to disagree on exactly
 * this, which is how the same trip could show two different times.
 */
export function fmtDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A route-mode chip duration, compact enough to compare across a six-mode row. */
export function fmtCompactDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Arrival clock time for a trip of `durationMs` starting now. */
export function fmtEta(durationMs: number, now = Date.now()): string {
  return fmtClock(now + durationMs);
}

/**
 * The one-line summary under a track's name — "12.4 km · 3 h 10 min · ↗ 640 m".
 *
 * Both apps list tracks, and both had grown their own version of this line: web
 * showed distance and ascent, Android distance, duration and ascent. Same track,
 * two different subtitles. A track's `stats` is an open `Record<string, number>`
 * (the importer writes whatever it could measure), so every absent key is a
 * legitimate case rather than an error — a track with no measurable stats at all
 * still needs something to say.
 */
export function trackSummary(stats: Record<string, number>): string {
  const parts: string[] = [];
  if (typeof stats['distanceM'] === 'number') parts.push(fmtKm(stats['distanceM']));
  const durationMs = stats['durationMs'];
  if (typeof durationMs === 'number' && durationMs > 0) parts.push(fmtDuration(durationMs));
  const ascentM = stats['ascentM'];
  if (typeof ascentM === 'number' && ascentM > 0) parts.push(`↗ ${Math.round(ascentM)} m`);
  return parts.join(' · ') || 'no stats';
}

/**
 * A track's line in a list: the recorded day first when the file has times —
 * imported runs share names like "Oslo Running", so the date is what tells
 * them apart — then the summary.
 */
export function trackListLine(stats: Record<string, number>, nowMs = Date.now()): string {
  const start = stats['startTime'];
  const summary = trackSummary(stats);
  return typeof start === 'number' ? `${fmtShortDate(start, nowMs)} · ${summary}` : summary;
}

/** Tag prefixes that tie an Atlas track to its Garmin record: an activity, or a saved course. */
export const GARMIN_ACTIVITY_TAG = 'garmin:';
export const GARMIN_COURSE_TAG = 'garmin-course:';
const isGarminIdTag = (tag: string) =>
  tag.startsWith(GARMIN_ACTIVITY_TAG) || tag.startsWith(GARMIN_COURSE_TAG);

const GARMIN_TYPE_NAMES: Record<string, string> = {
  running: 'Running',
  trail_running: 'Trail running',
  cycling: 'Cycling',
  road_biking: 'Road cycling',
  mountain_biking: 'Mountain biking',
  gravel_cycling: 'Gravel cycling',
  hiking: 'Hiking',
  walking: 'Walking',
  skating_ws: 'Ice skating',
  cross_country_skiing_ws: 'Cross-country skiing',
  skate_skiing_ws: 'Skate skiing',
};

/** Human-readable name for a Garmin `typeKey` (`trail_running` → "Trail running"). */
export function garminTypeLabel(typeKey: string): string {
  return (
    GARMIN_TYPE_NAMES[typeKey] ??
    typeKey
      .replace(/_ws$/, '') // Garmin's winter-sports suffix, never part of the name
      .replace(/[_-]+/g, ' ')
      .replace(/^\w/, (letter) => letter.toUpperCase())
  );
}

/**
 * The tags worth showing as chips: everything but the Garmin id tags, which
 * are bookkeeping (one unique number per activity) rather than a word anyone
 * filters by.
 */
export function userTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !isGarminIdTag(tag));
}

/** Human-readable Garmin activity from the raw type tag kept with an imported GPX. */
export function garminActivityLabel(tags: readonly string[]): string | null {
  if (!tags.some(isGarminIdTag)) return null;
  const type = tags.find((tag) => tag !== '' && !isGarminIdTag(tag));
  return type ? garminTypeLabel(type) : null;
}

// Order matters: skate skiing is skiing, not skating; trail and treadmill runs are running.
const GARMIN_SPORT_FAMILIES: readonly (readonly [RegExp, string])[] = [
  [/running|^run$|_run$/, 'Running'],
  [/cycling|biking|^bmx|^e_bike|cyclocross|_ride$/, 'Cycling'],
  [/skiing|snowboard|^ski_/, 'Skiing'],
  [/skating/, 'Skating'],
  [/hiking|mountaineering/, 'Hiking'],
  [/walking/, 'Walking'],
  [/swim/, 'Swimming'],
  [/kayak|canoe|rowing|paddl/, 'Paddling'],
];

/**
 * The sport folder a Garmin activity or course is filed under, so every kind of run sits
 * together and apart from hikes or skating. Unknown types get their own folder by name rather
 * than a catch-all, so a sport Garmin adds later still files separately.
 */
export function garminSportFolder(typeKey: string | null | undefined): string {
  if (!typeKey) return 'Other';
  for (const [pattern, folder] of GARMIN_SPORT_FAMILIES) if (pattern.test(typeKey)) return folder;
  return garminTypeLabel(typeKey);
}

const SPORT_ICONS: Record<string, string> = {
  Running: '🏃',
  Cycling: '🚴',
  Skiing: '⛷️',
  Skating: '⛸️',
  Hiking: '🥾',
  Walking: '🚶',
  Swimming: '🏊',
  Paddling: '🛶',
  Hunting: '🦌',
};

/** The icon a list row shows for a sport folder (`garminSportFolder`); a plain line otherwise. */
export function garminSportIcon(sport: string | null | undefined): string {
  return (sport && SPORT_ICONS[sport]) || '〰';
}

/**
 * The sports a Garmin course can be set to from Atlas. The bridge holds the matching Garmin
 * type ids (verified against Garmin's activity-type table 2026-10-04) and refuses any other key.
 */
export const GARMIN_COURSE_SPORTS = [
  'running',
  'trail_running',
  'cycling',
  'road_biking',
  'mountain_biking',
  'gravel_cycling',
  'hiking',
  'walking',
  'cross_country_skiing_ws',
  'backcountry_skiing',
] as const;
export type GarminCourseSport = (typeof GARMIN_COURSE_SPORTS)[number];
