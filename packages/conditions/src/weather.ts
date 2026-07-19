/**
 * Weather forecast shapes shared across clients and backend.
 *
 * Source is the Norwegian Meteorological Institute's free **MET Norway
 * Locationforecast 2.0** (`api.met.no`, the engine behind Yr). Clients never
 * call the upstream directly — the backend proxies it at `/api/weather`
 * (per MET's terms: identifying User-Agent, coordinate rounding, honour
 * `Expires`) and hands the client this normalised series. Weather is
 * inherently live, so it is an online-only enhancement — absent is never an
 * error.
 */

/** One forecast step. Wind direction is meteorological: the bearing the wind blows FROM. */
export interface WeatherPoint {
  /** ISO-8601 UTC timestamp of this step. */
  time: string;
  /** Air temperature, °C. */
  temp: number;
  /** Sustained wind speed, m/s. */
  windSpeed: number;
  /** Gust speed, m/s, or null when the product omits it. */
  windGust: number | null;
  /** Direction the wind comes FROM, degrees (0 = N, 90 = E). */
  windFromDir: number;
  /** Total cloud cover, %. */
  cloud: number;
  /** Relative humidity, %. */
  humidity: number;
  /** Air pressure at sea level, hPa, or null when the product omits it. */
  pressure: number | null;
  /** Precipitation expected in the hour after `time`, mm (null past the hourly horizon). */
  precip: number | null;
  /** Probability of precipitation in that hour, % (null when unavailable). */
  precipProb: number | null;
  /**
   * MET `symbol_code` for the period after `time` (e.g. `clearsky_day`,
   * `lightrain`). Keeps the `_day`/`_night`/`_polartwilight` variant so the
   * client can pick the right icon; '' when absent.
   */
  symbol: string;
}

/** A point forecast: the normalised series plus provenance for cache/"updated …" display. */
export interface WeatherForecast {
  /** Echoed request coordinates (rounded as sent upstream). */
  lat: number;
  lon: number;
  /** Upstream `Last-Modified` (when the forecast was produced), ISO-8601. */
  updatedAt: string;
  /** Forecast steps in chronological order (hourly for the first days, then coarser). */
  series: WeatherPoint[];
}
