/**
 * Tiny display helpers shared by the web panel and the Android sheet — pure
 * data mapping, no platform APIs.
 */

import { fmtClock } from '@atlas/core';

import type { SunDay } from './sun.js';

/** met.no symbol_code base → a weather emoji (variant suffixes like `_day` are ignored). */
const SYMBOL_EMOJI: Record<string, string> = {
  clearsky: '☀️',
  fair: '🌤️',
  partlycloudy: '⛅',
  cloudy: '☁️',
  fog: '🌫️',
  lightrain: '🌦️',
  lightrainshowers: '🌦️',
  rain: '🌧️',
  rainshowers: '🌧️',
  heavyrain: '🌧️',
  heavyrainshowers: '🌧️',
  sleet: '🌨️',
  sleetshowers: '🌨️',
  lightsleet: '🌨️',
  lightsleetshowers: '🌨️',
  heavysleet: '🌨️',
  heavysleetshowers: '🌨️',
  snow: '❄️',
  snowshowers: '❄️',
  lightsnow: '❄️',
  lightsnowshowers: '❄️',
  heavysnow: '❄️',
  heavysnowshowers: '❄️',
};

/** Weather emoji for a met.no `symbol_code` ('' or unknown → a neutral thermometer). */
export function symbolEmoji(symbol: string): string {
  const base = symbol.split('_')[0] ?? '';
  if (SYMBOL_EMOJI[base]) return SYMBOL_EMOJI[base];
  // Any thunder variant (rainandthunder, lightssleetandthunder, …) gets the storm cloud.
  if (base.includes('thunder')) return '⛈️';
  return '🌡️';
}

// Arrows point the way the wind BLOWS (i.e. FROM-direction + 180°), the yr.no
// convention: a north wind (FROM 0°) blows south, so it reads as ↓.
const WIND_ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'] as const;

/**
 * A single arrow glyph for a wind `FROM` bearing, pointing where the wind is
 * going. Snapped to the nearest of eight directions — enough to read a table
 * cell at a glance without a rotated icon.
 */
export function windArrow(windFromDir: number): string {
  const idx = Math.round((((windFromDir % 360) + 360) % 360) / 45) % 8;
  return WIND_ARROWS[idx]!;
}

/**
 * The day's light in one line: sunrise/sunset and how long the day is, or what
 * is happening instead when the sun does not cross the horizon at all. Empty
 * string when there is nothing to say, so a card can skip the row entirely.
 *
 * Both polar branches still check `dawn`/`dusk` rather than assuming twilight
 * exists. It does at Tromsø in December — the sun reaches about -3° at noon, so
 * there are usable hours — but not far enough north (Svalbard, deep winter),
 * where the sun stays below -6° all day and there is no twilight to name.
 */
export function describeSunDay(sun: SunDay): string {
  if (sun.polar === 'day') return 'Midnight sun — the sun stays up all day';
  if (sun.polar === 'night') {
    if (!sun.dawn || !sun.dusk) return 'Polar night — no daylight or twilight';
    return `Polar night — twilight ${fmtClock(sun.dawn.valueOf())}–${fmtClock(sun.dusk.valueOf())}`;
  }
  if (!sun.sunrise || !sun.sunset) return '';
  const hours = Math.floor(sun.daylightMs / 3600000);
  const minutes = Math.round((sun.daylightMs % 3600000) / 60000);
  return `↑ ${fmtClock(sun.sunrise.valueOf())} · ↓ ${fmtClock(sun.sunset.valueOf())} · ${hours} h ${minutes} min of daylight`;
}
