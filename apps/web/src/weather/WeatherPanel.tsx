import {
  bestWindows,
  buildPlanner,
  compass16,
  sunDay,
  symbolEmoji,
  type ConditionsKind,
  type PlannerHour,
} from '@atlas/conditions';
import { fmtClock, fmtDayClock, type LatLng } from '@atlas/core';
import { useEffect, useMemo, useState } from 'react';
import type { WeatherState } from './useWeather.js';

// Panel prefs are device-local (`local.` keys never sync).
const MODE_SETTING = 'local.weather.mode';
const SPECIES_SETTING = 'local.weather.species';

type Mode = 'weather' | ConditionsKind;

interface SettingsAccess {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

interface WeatherPanelProps {
  target: LatLng;
  weather: WeatherState;
  settings: SettingsAccess;
  /** Re-target the forecast to the current map centre. */
  onRetarget: () => void;
  onClose: () => void;
}

const fmtTime = fmtClock;

const fmtStep = fmtDayClock;

const SPECIES = ['trout', 'perch', 'pike', 'char'] as const;

/** One line of forecast facts for the selected step. */
function WeatherFacts({ row }: { row: PlannerHour }) {
  const p = row.point;
  const gust = p.windGust != null ? ` (${Math.round(p.windGust)})` : '';
  const precip =
    p.precip != null && p.precip > 0
      ? `${p.precip.toFixed(1)} mm${p.precipProb != null ? ` · ${Math.round(p.precipProb)}%` : ''}`
      : 'dry';
  const trend =
    row.pressureTrendHpa != null
      ? ` ${row.pressureTrendHpa > 0 ? '↗' : row.pressureTrendHpa < 0 ? '↘' : '→'}`
      : '';
  return (
    <div className="weather-facts">
      <div className="weather-headline">
        <span className="weather-emoji">{symbolEmoji(p.symbol)}</span>
        <span className="weather-temp">{Math.round(p.temp)}°</span>
        <span>
          {Math.round(p.windSpeed)}
          {gust} m/s from {compass16(p.windFromDir)}
        </span>
      </div>
      <div className="weather-details">
        <span>☁ {Math.round(p.cloud)}%</span>
        <span>🌧 {precip}</span>
        {p.pressure != null && (
          <span>
            {Math.round(p.pressure)} hPa{trend}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The weather & conditions planner: a time scrubber over the proxied met.no
 * forecast with sunrise/sunset, plain weather first, and an optional
 * transparent fishing/hunting conditions layer (score + why + best windows).
 */
export function WeatherPanel({
  target,
  weather,
  settings,
  onRetarget,
  onClose,
}: WeatherPanelProps) {
  const [mode, setMode] = useState<Mode>('weather');
  const [species, setSpecies] = useState<string>('trout');
  const [selected, setSelected] = useState(0);
  const { status: settingsStatus, getSetting, setSetting } = settings;

  // Restore persisted mode/species once storage is ready.
  useEffect(() => {
    if (settingsStatus !== 'ready') return;
    void getSetting(MODE_SETTING).then((raw) => {
      if (raw === 'weather' || raw === 'fishing' || raw === 'hunting') setMode(raw);
    });
    void getSetting(SPECIES_SETTING).then((raw) => {
      if (raw && (SPECIES as readonly string[]).includes(raw)) setSpecies(raw);
    });
  }, [settingsStatus, getSetting]);

  const pickMode = (m: Mode) => {
    setMode(m);
    setSetting(MODE_SETTING, m);
  };
  const pickSpecies = (s: string) => {
    setSpecies(s);
    setSetting(SPECIES_SETTING, s);
  };

  const rows = useMemo(
    () =>
      weather.forecast
        ? buildPlanner(weather.forecast, {
            kind: mode === 'weather' ? null : mode,
            species,
          })
        : [],
    [weather.forecast, mode, species],
  );
  const windows = useMemo(() => (mode === 'weather' ? [] : bestWindows(rows)), [rows, mode]);

  // Keep the selection inside the (re)loaded series.
  const row = rows[Math.min(selected, Math.max(0, rows.length - 1))];

  const sun = useMemo(
    () => (row ? sunDay(new Date(row.timeMs), target.lat, target.lng) : null),
    [row, target.lat, target.lng],
  );

  return (
    <aside className="weather-panel" aria-label="Weather and conditions">
      <div className="weather-header">
        <strong>Weather</strong>
        <span className="weather-coords">
          {target.lat.toFixed(3)}, {target.lng.toFixed(3)}
        </span>
        <button
          type="button"
          className="icon-button"
          title="Forecast for the current map centre"
          aria-label="Use map centre"
          onClick={onRetarget}
        >
          ⌖
        </button>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close weather">
          ✕
        </button>
      </div>

      <div className="weather-modes" role="tablist">
        {(['weather', 'fishing', 'hunting'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            aria-pressed={mode === m}
            onClick={() => pickMode(m)}
          >
            {m === 'weather' ? 'Weather' : m === 'fishing' ? 'Fishing' : 'Hunting'}
          </button>
        ))}
      </div>
      {mode === 'fishing' && (
        <div className="weather-species">
          {SPECIES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={species === s}
              onClick={() => pickSpecies(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {weather.status === 'error' && (
        <p className="weather-note">Forecast unavailable right now — try again in a bit.</p>
      )}
      {weather.status === 'loading' && rows.length === 0 && (
        <p className="weather-note">Loading forecast…</p>
      )}

      {row && (
        <>
          <div className="weather-time">
            <span className="weather-step">{fmtStep(row.timeMs)}</span>
            {sun && (
              <span className="weather-sun">
                {sun.sunrise && sun.sunset
                  ? `☀ ${fmtTime(sun.sunrise.getTime())}–${fmtTime(sun.sunset.getTime())}`
                  : sun.noonAltitude > 0
                    ? '☀ midnight sun'
                    : '☀ polar night'}
              </span>
            )}
          </div>
          <input
            type="range"
            className="weather-scrub"
            min={0}
            max={rows.length - 1}
            value={Math.min(selected, rows.length - 1)}
            onChange={(e) => setSelected(Number(e.target.value))}
            aria-label="Forecast time"
          />
          {mode !== 'weather' && (
            <div className="weather-strip" aria-hidden="true">
              {rows.map((r, i) => (
                <button
                  key={r.point.time}
                  type="button"
                  tabIndex={-1}
                  className={`weather-tick rating-${r.assessment?.rating ?? 'none'}${
                    i === selected ? ' tick-selected' : ''
                  }`}
                  onClick={() => setSelected(i)}
                  title={`${fmtStep(r.timeMs)} — ${r.assessment?.score ?? ''}`}
                />
              ))}
            </div>
          )}

          <WeatherFacts row={row} />

          {mode !== 'weather' && row.assessment && (
            <div className="weather-assessment">
              <div className="weather-score-row">
                <span className={`weather-score rating-${row.assessment.rating}`}>
                  {row.assessment.score}
                </span>
                <span className="weather-summary">{row.assessment.summary}</span>
              </div>
              {windows.length > 0 && (
                <div className="weather-windows">
                  <span className="weather-windows-label">Best windows:</span>
                  {windows.map((w) => (
                    <button
                      key={w.startIdx}
                      type="button"
                      onClick={() => setSelected(w.peakIdx)}
                      title={`Peak score ${w.peakScore}`}
                    >
                      {fmtStep(rows[w.startIdx]!.timeMs)}–
                      {fmtTime(rows[w.endIdx]!.timeMs + 3600_000)}
                    </button>
                  ))}
                </div>
              )}
              <ul className="weather-factors">
                {row.assessment.factors.map((f) => (
                  <li key={f.key}>
                    <span className={`factor-dot factor-${f.rating}`} />
                    <div>
                      <span className="factor-label">{f.label}</span>
                      <span className="factor-detail">{f.detail}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {weather.forecast && (
            <p className="weather-attribution">
              Forecast: MET Norway (met.no), updated{' '}
              {fmtTime(new Date(weather.forecast.updatedAt).getTime())}
            </p>
          )}
        </>
      )}
    </aside>
  );
}
