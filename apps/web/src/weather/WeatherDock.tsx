import type { SkyLayersController, WeatherMapsController } from '@atlas/app-hooks';
import {
  lightningLegendBands,
  timelineDayMarks,
  weatherFrameCaption,
  weatherFrameLabel,
  type WeatherLegendRow,
  type WeatherMapLegend,
} from '@atlas/conditions';
import { type PoiCategoryId } from '@atlas/core';
import { useEffect, useState } from 'react';

import { PauseIcon, PlayIcon } from '../icons.js';
import { PoiCategoryDock } from '../poi/PoiCategoryDock.js';

/** A legend row as a CSS gradient; stops sharing a position make a hard edge. */
function gradient(row: WeatherLegendRow): string {
  return `linear-gradient(to right, ${row.stops
    .map((stop) => `${stop.color} ${(stop.at * 100).toFixed(2)}%`)
    .join(', ')})`;
}

const LEGEND_STATE_KEY = 'atlas.weather.legend';

/** Where a value sits along a bar whose ends are inset by half a label. */
const along = (at: number) => `${(at * 100).toFixed(2)}%`;

function WeatherLegend({
  title,
  legend,
  open,
  onToggle,
}: {
  title: string;
  legend: WeatherMapLegend;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="weather-legend" aria-label={`${title} colour scale in ${legend.unit}`}>
      <button type="button" className="weather-legend-head" aria-expanded={open} onClick={onToggle}>
        <strong>{title}</strong>
        <span>
          {legend.unit} · Legend {open ? '⌃' : '⌄'}
        </span>
      </button>
      {open &&
        legend.rows.map((row, index) => (
          <div key={row.label ?? index} className="weather-legend-row">
            {row.label && <span className="weather-legend-row-label">{row.label}</span>}
            <div className="weather-legend-scale">
              <div className="weather-legend-bar" style={{ background: gradient(row) }} />
              {row.ticks.length > 0 && (
                <div className="weather-legend-ticks" aria-hidden="true">
                  {row.ticks.map((tick) => (
                    <span key={tick.label} style={{ left: along(tick.at) }}>
                      {tick.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
    </div>
  );
}

interface WeatherDockProps {
  maps: WeatherMapsController;
  /** The switched-on layer's title ("Wind"). */
  title: string;
  /** Room is taken on the left (a panel or the place card is open there). */
  shifted: boolean;
  /** A bottom sheet or card owns the bottom of a phone screen right now. */
  compactHidden: boolean;
  sky: SkyLayersController;
  lightningOn: boolean;
  auroraOn: boolean;
  poiOn: boolean;
  poiCategories: readonly PoiCategoryId[];
  onTogglePoiCategory: (id: PoiCategoryId) => void;
  onShowAllPois: () => void;
}

/**
 * The strip that appears along the bottom of the map while a weather layer is
 * on — and only then: the scale for what is drawn, and the time it is drawn
 * for. Play, scrub, jump back to now, and switch precipitation between radar
 * and forecast. Everything else (which layer, how opaque) stays in the layer
 * switcher like every other overlay.
 */
export function WeatherDock({
  maps,
  title,
  shifted,
  compactHidden,
  sky,
  lightningOn,
  auroraOn,
  poiOn,
  poiCategories,
  onTogglePoiCategory,
  onShowAllPois,
}: WeatherDockProps) {
  // Remembered for the browser session only: shown by default so a first
  // activation explains its colours, collapsible once they are understood.
  const [legendOpen, setLegendOpen] = useState(() => {
    try {
      return window.sessionStorage.getItem(LEGEND_STATE_KEY) !== 'collapsed';
    } catch {
      return true;
    }
  });
  // Captions say "25 min ago": keep them honest while the dock sits open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(LEGEND_STATE_KEY, legendOpen ? 'expanded' : 'collapsed');
    } catch {
      // Blocked storage only costs the memory, never the dock.
    }
  }, [legendOpen]);

  const { frames, frame, frameIndex, nowIndex, legend } = maps;
  const last = Math.max(1, frames.length - 1);
  const className = [
    'weather-dock',
    shifted ? 'weather-dock-shifted' : '',
    compactHidden ? 'weather-dock-compact-hidden' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const weatherOn = maps.layerId !== null;
  const forecastMs = sky.aurora.forecast
    ? Date.parse(sky.aurora.forecast.forecastTime)
    : Number.NaN;

  if (weatherOn && (!frame || frames.length === 0) && !lightningOn && !auroraOn && !poiOn) {
    return (
      <div className={className}>
        <div role="status" className="weather-timeline weather-timeline-status">
          {maps.status === 'error'
            ? `${title}: weather maps are unavailable right now.`
            : `Loading ${title.toLowerCase()}…`}
        </div>
      </div>
    );
  }

  const nowAt = nowIndex / last;
  const marks = timelineDayMarks(frames, nowMs).map((mark) => ({
    ...mark,
    named: Math.abs(mark.at - nowAt) > 0.1 && mark.at < 0.86,
  }));
  const weatherTimeline = frame ? (
    <div className="weather-timeline" role="group" aria-label={`${title} timeline`}>
      <button
        type="button"
        className="weather-play"
        onClick={maps.togglePlaying}
        aria-label={maps.playing ? 'Pause' : 'Play'}
        title={maps.playing ? 'Pause' : 'Play'}
      >
        {maps.playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
      </button>
      {maps.timelineIds.length > 1 && (
        <div className="weather-timeline-switch" role="group" aria-label="Precipitation source">
          {maps.timelineIds.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={maps.timeline?.id === id}
              onClick={() => maps.setTimeline(id)}
              title={
                id === 'radar'
                  ? 'Radar: the last day and the next 90 minutes'
                  : 'Forecast: the next three days'
              }
            >
              {id === 'radar' ? 'Radar' : 'Forecast'}
            </button>
          ))}
        </div>
      )}
      <div className="weather-track">
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          step={1}
          value={frameIndex}
          onChange={(event) => maps.selectFrame(Number(event.target.value))}
          aria-label={`${title} time`}
          aria-valuetext={`${weatherFrameLabel(Date.parse(frame.time), nowMs)}, ${weatherFrameCaption(frame, nowMs)}`}
        />
        <span
          className="weather-track-now"
          style={{ '--at': nowAt } as React.CSSProperties}
          aria-hidden="true"
        >
          <span>Now</span>
        </span>
        {marks.map((mark) => (
          <span
            key={`${mark.at}`}
            className="weather-track-day"
            style={{ '--at': mark.at } as React.CSSProperties}
            aria-hidden="true"
          >
            {mark.named && <span>{mark.label}</span>}
          </span>
        ))}
      </div>
      <button
        type="button"
        className={`weather-time${maps.followingNow ? '' : ' weather-time-away'}`}
        onClick={maps.goToNow}
        title="Back to now"
        aria-label={`${weatherFrameLabel(Date.parse(frame.time), nowMs)}, ${weatherFrameCaption(frame, nowMs)}. Back to now`}
      >
        <strong>{weatherFrameLabel(Date.parse(frame.time), nowMs)}</strong>
        <span>{weatherFrameCaption(frame, nowMs)}</span>
      </button>
    </div>
  ) : weatherOn ? (
    <div className="weather-timeline weather-timeline-status" role="status">
      {maps.status === 'error' ? 'Weather maps unavailable' : `Loading ${title.toLowerCase()}…`}
    </div>
  ) : null;

  return (
    <div className={className}>
      {poiOn && (
        <PoiCategoryDock
          categories={poiCategories}
          onToggle={onTogglePoiCategory}
          onShowAll={onShowAllPois}
        />
      )}
      {(legend || weatherTimeline) && (
        <div className="weather-map-control">
          {legend && (
            <WeatherLegend
              title={title}
              legend={legend}
              open={legendOpen}
              onToggle={() => setLegendOpen((open) => !open)}
            />
          )}
          {weatherTimeline}
        </div>
      )}
      {lightningOn && (
        <div
          className="weather-timeline sky-control"
          role="group"
          aria-label="Lightning time window"
        >
          <strong className="sky-control-title">Lightning</strong>
          <div className="weather-timeline-switch">
            {sky.lightning.windows.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={sky.lightning.window === candidate.id}
                onClick={() => sky.lightning.setWindow(candidate.id)}
              >
                {candidate.id === '1h' ? 'Last hour' : candidate.label}
              </button>
            ))}
          </div>
          <span className="sky-age-key" aria-label="Lightning strike age">
            {lightningLegendBands(sky.lightning.window).map((band, index) => (
              <span key={band.age} className={`sky-age-band sky-age-${band.age}`}>
                <i
                  style={{
                    background: band.color,
                    opacity: Math.max(band.opacity, 0.55),
                    width: `${Math.max(5, band.radius * 1.6)}px`,
                    height: `${Math.max(5, band.radius * 1.6)}px`,
                  }}
                />
                {index === 0 ? `< ${band.label}` : band.label}
              </span>
            ))}
          </span>
        </div>
      )}
      {auroraOn && (
        <div className="weather-timeline sky-control" aria-label="Aurora forecast time">
          <div className="aurora-scale" aria-hidden="true" />
          <div className="sky-control-copy">
            <strong>Aurora viewing chance</strong>
            <span>NOAA intensity · darkness · MET clouds · VIIRS light pollution</span>
          </div>
          <div className="weather-time sky-forecast-time">
            <strong>
              {Number.isFinite(forecastMs)
                ? weatherFrameLabel(forecastMs, nowMs)
                : sky.aurora.status === 'error'
                  ? 'Unavailable'
                  : 'Loading…'}
            </strong>
            <span>30-minute forecast</span>
          </div>
        </div>
      )}
    </div>
  );
}
