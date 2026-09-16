import type { WeatherMapsController } from '@atlas/app-hooks';
import {
  timelineDayMarks,
  weatherFrameCaption,
  weatherFrameLabel,
  type WeatherLegendRow,
  type WeatherMapLegend,
} from '@atlas/conditions';
import { useEffect, useState } from 'react';

import { PauseIcon, PlayIcon } from '../icons.js';

/** A legend row as a CSS gradient; stops sharing a position make a hard edge. */
function gradient(row: WeatherLegendRow): string {
  return `linear-gradient(to right, ${row.stops
    .map((stop) => `${stop.color} ${(stop.at * 100).toFixed(2)}%`)
    .join(', ')})`;
}

/** Where a value sits along a bar whose ends are inset by half a label. */
const along = (at: number) => `${(at * 100).toFixed(2)}%`;

function WeatherLegend({ title, legend }: { title: string; legend: WeatherMapLegend }) {
  return (
    <div className="weather-legend" aria-label={`${title} colour scale in ${legend.unit}`}>
      <div className="weather-legend-head">
        <strong>{title}</strong>
        <span>{legend.unit}</span>
      </div>
      {legend.rows.map((row, index) => (
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
}

/**
 * The strip that appears along the bottom of the map while a weather layer is
 * on — and only then: the scale for what is drawn, and the time it is drawn
 * for. Play, scrub, jump back to now, and switch precipitation between radar
 * and forecast. Everything else (which layer, how opaque) stays in the layer
 * switcher like every other overlay.
 */
export function WeatherDock({ maps, title, shifted, compactHidden }: WeatherDockProps) {
  // Captions say "25 min ago": keep them honest while the dock sits open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const { frames, frame, frameIndex, nowIndex, legend } = maps;
  const last = Math.max(1, frames.length - 1);
  const className = [
    'weather-dock',
    shifted ? 'weather-dock-shifted' : '',
    compactHidden ? 'weather-dock-compact-hidden' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (!frame || frames.length === 0) {
    return (
      <div className={className} role="status">
        <div className="weather-timeline weather-timeline-status">
          {maps.status === 'error'
            ? `${title}: weather maps are unavailable right now.`
            : `Loading ${title.toLowerCase()}…`}
        </div>
      </div>
    );
  }

  const frameMs = Date.parse(frame.time);
  const label = weatherFrameLabel(frameMs, nowMs);
  const caption = weatherFrameCaption(frame, nowMs);
  const nowAt = nowIndex / last;
  // A day's name is only drawn where it has room: clear of "Now" and of the end
  // of the track, where it would run into the time readout.
  const marks = timelineDayMarks(frames, nowMs).map((mark) => ({
    ...mark,
    named: Math.abs(mark.at - nowAt) > 0.1 && mark.at < 0.86,
  }));

  return (
    <div className={className}>
      {legend && <WeatherLegend title={title} legend={legend} />}
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
                    ? 'Radar: the last 90 minutes and the next 90'
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
            aria-valuetext={`${label}, ${caption}`}
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
          aria-label={`${label}, ${caption}. Back to now`}
        >
          <strong>{label}</strong>
          <span>{caption}</span>
        </button>
      </div>
    </div>
  );
}
