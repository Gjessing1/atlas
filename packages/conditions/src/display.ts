/**
 * Tiny display helpers shared by the web panel and the Android sheet — pure
 * data mapping, no platform APIs.
 */

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
