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
  const weekday = d.toLocaleDateString([], { weekday: 'short' });
  return `${weekday} ${d.getDate()}`;
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
