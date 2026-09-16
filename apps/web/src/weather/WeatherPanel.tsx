import { useTerrainSlope } from '@atlas/app-hooks';
import {
  bestWindows,
  buildPlanner,
  compass16,
  forecastTable,
  sunDay,
  symbolEmoji,
  windArrow,
  type ConditionsKind,
  type ForecastPeriodCell,
  type PlannerHour,
} from '@atlas/conditions';
import { fmtClock, fmtDayClock, fmtDayLabel, type LatLng } from '@atlas/core';
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
  origin?: string;
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
  const precipAmount =
    p.precipMin != null && p.precipMax != null && Math.abs(p.precipMax - p.precipMin) >= 0.1
      ? `${p.precipMin.toFixed(1)}–${p.precipMax.toFixed(1)} mm`
      : p.precip != null
        ? `${p.precip.toFixed(1)} mm`
        : null;
  const precip =
    p.precip != null && p.precip > 0
      ? `${precipAmount}${p.precipProb != null ? ` · ${Math.round(p.precipProb)}%` : ''}`
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
        <span>Humidity {Math.round(p.humidity)}%</span>
        <span>🌧 {precip}</span>
        {p.apparentTemp != null && Math.abs(p.apparentTemp - p.temp) >= 1 && (
          <span>Feels {Math.round(p.apparentTemp)}°</span>
        )}
        {p.dewPoint != null && <span>Dew {Math.round(p.dewPoint)}°</span>}
        {p.uvIndex != null && p.uvIndex >= 1 && <span>UV {p.uvIndex.toFixed(1)}</span>}
        {p.thunderProb != null && p.thunderProb >= 10 && (
          <span>⚡ {Math.round(p.thunderProb)}%</span>
        )}
        {p.fog != null && p.fog >= 10 && <span>Fog {Math.round(p.fog)}%</span>}
        {p.pressure != null && (
          <span>
            {Math.round(p.pressure)} hPa{trend}
          </span>
        )}
      </div>
    </div>
  );
}

/** Precipitation cell text — millimetres when wet, an em-dash when dry/unknown. */
function precipText(mm: number | null): string {
  return mm != null && mm > 0 ? `${mm.toFixed(mm < 1 ? 1 : 0)}` : '–';
}

/** The wind cell: arrow (blowing direction) + sustained speed, gust muted. */
function WindCell({
  fromDir,
  speed,
  gust,
}: {
  fromDir: number;
  speed: number;
  gust: number | null;
}) {
  return (
    <span
      className="wx-wind"
      title={`${Math.round(speed)}${gust != null ? ` (${Math.round(gust)})` : ''} m/s from ${compass16(fromDir)}`}
    >
      <span className="wx-arrow" aria-hidden="true">
        {windArrow(fromDir)}
      </span>
      {Math.round(speed)}
      {gust != null && <span className="wx-gust">({Math.round(gust)})</span>}
    </span>
  );
}

/** One period row plus, when expanded, its hourly breakdown. */
function PeriodRow({
  cell,
  expanded,
  selectedMs,
  onToggle,
  onPickHour,
}: {
  cell: ForecastPeriodCell;
  expanded: boolean;
  selectedMs: number;
  onToggle: () => void;
  onPickHour: (row: PlannerHour) => void;
}) {
  const first = cell.hours[0]!.timeMs;
  const last = cell.hours[cell.hours.length - 1]!.timeMs;
  const active = selectedMs >= first && selectedMs <= last;
  const tempSpan = Math.round(cell.tempMin) !== Math.round(cell.tempMax);
  return (
    <>
      <button
        type="button"
        className={`wx-row wx-period${active ? ' wx-active' : ''}`}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="wx-when">
          <span className="wx-period-name">{cell.label}</span>
          <span className="wx-hours">{cell.hoursLabel}</span>
        </span>
        <span className="wx-sym" aria-hidden="true">
          {symbolEmoji(cell.symbol)}
        </span>
        <span className="wx-temp">
          {Math.round(cell.tempMax)}°
          {tempSpan && <span className="wx-temp-lo">{Math.round(cell.tempMin)}°</span>}
        </span>
        <span className={`wx-precip${cell.precipMm && cell.precipMm > 0 ? ' wx-wet' : ''}`}>
          {precipText(cell.precipMm)}
        </span>
        <WindCell fromDir={cell.windFromDir} speed={cell.windMax} gust={cell.gustMax} />
        <span className="wx-chevron" aria-hidden="true">
          {expanded ? '⌄' : '›'}
        </span>
      </button>
      {expanded &&
        cell.hours.map((h) => {
          const p = h.point;
          const hActive = h.timeMs === selectedMs;
          return (
            <button
              key={p.time}
              type="button"
              className={`wx-row wx-hour${hActive ? ' wx-active' : ''}`}
              onClick={() => onPickHour(h)}
            >
              <span className="wx-when">{fmtClock(h.timeMs)}</span>
              <span className="wx-sym" aria-hidden="true">
                {symbolEmoji(p.symbol)}
              </span>
              <span className="wx-temp">{Math.round(p.temp)}°</span>
              <span className={`wx-precip${p.precip && p.precip > 0 ? ' wx-wet' : ''}`}>
                {precipText(p.precip)}
              </span>
              <WindCell fromDir={p.windFromDir} speed={p.windSpeed} gust={p.windGust} />
              <span className="wx-chevron" />
            </button>
          );
        })}
    </>
  );
}

/**
 * The browsable forecast: a yr.no-style table where a whole day reads at a
 * glance — a row per Night/Morning/Afternoon/Evening with symbol, temperature,
 * precipitation and wind, expandable to the hours behind it. Selecting any row
 * drives the same scrubber selection the map-side conditions layer follows.
 */
function WeatherTable({
  rows,
  selected,
  onSelect,
}: {
  rows: PlannerHour[];
  selected: number;
  onSelect: (idx: number) => void;
}) {
  const days = useMemo(() => forecastTable(rows), [rows]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const selectedMs = rows[selected]?.timeMs ?? -1;
  const pickHour = (row: PlannerHour) => {
    const idx = rows.indexOf(row);
    if (idx >= 0) onSelect(idx);
  };
  return (
    <div className="wx-table">
      {days.map((day) => (
        <section key={day.dateMs} className="wx-day">
          <h4 className="wx-day-label">{fmtDayLabel(day.dateMs)}</h4>
          {day.periods.map((cell) => {
            const key = `${day.dateMs}-${cell.period}`;
            return (
              <PeriodRow
                key={key}
                cell={cell}
                expanded={expanded.has(key)}
                selectedMs={selectedMs}
                onToggle={() => {
                  onSelect(cell.selectIndex);
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  });
                }}
                onPickHour={pickHour}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}

/**
 * The weather & conditions planner: a browsable yr.no-style day table over the
 * proxied met.no forecast (the default reading surface), backed by a time
 * scrubber that drives the map-side conditions layer, plus an optional
 * transparent fishing/hunting conditions layer (score + why + best windows).
 */
export function WeatherPanel({
  origin = '',
  target,
  weather,
  settings,
  onRetarget,
  onClose,
}: WeatherPanelProps) {
  const [mode, setMode] = useState<Mode>('weather');
  const [species, setSpecies] = useState<string>('trout');
  const [selected, setSelected] = useState(0);
  const terrain = useTerrainSlope(origin, target, mode === 'hunting');
  const { status: settingsStatus, getSetting, setSetting } = settings;

  // Restore persisted mode/species once storage is ready.
  useEffect(() => {
    if (settingsStatus !== 'ready') return;
    void getSetting(MODE_SETTING).then((raw) => {
      // 'maps' was a tab until weather maps became layers; it reads as the forecast.
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
            kind: mode === 'fishing' || mode === 'hunting' ? mode : null,
            species,
            slopeDeg: mode === 'hunting' ? terrain.fit?.slopeDeg : undefined,
            aspectDeg: mode === 'hunting' ? terrain.fit?.aspectDeg : undefined,
          })
        : [],
    [weather.forecast, mode, species, terrain.fit],
  );
  const windows = useMemo(
    () => (mode === 'fishing' || mode === 'hunting' ? bestWindows(rows) : []),
    [rows, mode],
  );

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
            {m === 'weather' ? 'Forecast' : m === 'fishing' ? 'Fishing' : 'Hunting'}
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

          <WeatherTable rows={rows} selected={selected} onSelect={setSelected} />

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
