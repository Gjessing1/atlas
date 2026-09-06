import {
  ELEMENT_STALE_DAYS,
  elementAgeDays,
  orbitalPeriodMinutes,
  predictPasses,
  skyGetsDark,
  subpointAt,
  type Observer,
  type SatelliteOmm,
  type SatellitePass,
  type SatelliteTrain,
} from '@atlas/satellites';
import { useEffect, useMemo, useState } from 'react';

const SEARCH_HOURS = 72;
const PASS_LIMIT = 8;

const timeOnly = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

function compass(degrees: number): string {
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16]!;
}

function duration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} min`;
}

function passTime(pass: SatellitePass): string {
  return `${dayAndTime.format(new Date(pass.start))}–${timeOnly.format(new Date(pass.end))}`;
}

function groupLabel(element: SatelliteOmm, layerId: string): string {
  if (element.ATLAS_GROUP === 'stations') return 'Space station';
  if (layerId === 'starlink') return 'Starlink satellite';
  return 'Naked-eye catalog';
}

function elementAgeLabel(ageDays: number): string {
  if (!Number.isFinite(ageDays)) return 'unknown';
  if (ageDays < 1 / 24) return 'less than an hour';
  if (ageDays < 1) return `${Math.max(1, Math.round(ageDays * 24))} h`;
  return `${ageDays.toFixed(ageDays < 10 ? 1 : 0)} days`;
}

export interface SatellitePassCardProps {
  element: SatelliteOmm;
  layerId: string;
  observer: Observer;
  observerSource: 'map' | 'location';
  /**
   * Lifted out of this card because the map draws the same floor as a circle:
   * two copies of it would let the ring and the list disagree about what
   * counts as a sighting.
   */
  minElevationDeg: number;
  onMinElevationChange: (deg: number) => void;
  /** Whether the object is above the observer's horizon this second. */
  overhead: boolean | null;
  /** The batch this object is still flying in formation with, if any. */
  train: SatelliteTrain | null;
  locating: boolean;
  locationError: boolean;
  shifted?: boolean;
  onUseMapCenter: () => void;
  onUseMyLocation: () => void;
  onClose: () => void;
}

/**
 * One selected orbit and the practical answer: when to walk outside, where to
 * look, and whether the prediction is built on fresh enough elements.
 *
 * Prediction stays on-device with the map propagation. The card therefore
 * still works after the network disappears, and changing observer/elevation is
 * a local calculation rather than a request carrying the user's position.
 */
export function SatellitePassCard({
  element,
  layerId,
  observer,
  observerSource,
  minElevationDeg,
  onMinElevationChange,
  overhead,
  train,
  locating,
  locationError,
  shifted,
  onUseMapCenter,
  onUseMyLocation,
  onClose,
}: SatellitePassCardProps) {
  const [visibleOnly, setVisibleOnly] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now);

  // The live facts move with the dot. Passes are deliberately not keyed on
  // this tick: recomputing a 72-hour scan every second would turn a clock into
  // a battery drain, while a prediction that starts a few seconds earlier is
  // indistinguishable to a person looking up.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const prediction = useMemo(() => {
    const from = new Date();
    const passes = predictPasses(element, observer, {
      from,
      hours: SEARCH_HOURS,
      minElevationDeg,
      visibleOnly,
      limit: PASS_LIMIT,
    });
    const allPasses =
      visibleOnly && passes.length === 0
        ? predictPasses(element, observer, {
            from,
            hours: SEARCH_HOURS,
            minElevationDeg,
            visibleOnly: false,
            limit: 1,
          })
        : passes;
    return {
      passes,
      hasAnyPass: allPasses.length > 0,
      getsDark: skyGetsDark(observer, from, SEARCH_HOURS),
    };
  }, [element, observer.lat, observer.lng, observer.altitudeM, visibleOnly, minElevationDeg]);

  const fix = subpointAt(element, new Date(nowMs));
  const ageDays = elementAgeDays(element, nowMs);
  const stale = ageDays >= ELEMENT_STALE_DAYS;

  let emptyMessage = `This orbit does not climb above ${minElevationDeg}° here in the next 3 days.`;
  if (visibleOnly && prediction.hasAnyPass) {
    emptyMessage = prediction.getsDark
      ? 'It passes overhead, but is not sunlit against a dark sky in the next 3 days.'
      : 'The sky does not get dark enough here in the next 3 days.';
  }

  return (
    <div
      className={`place-card satellite-card${shifted ? ' place-card-shifted' : ''}`}
      role="dialog"
      aria-label={`${element.OBJECT_NAME} passes`}
      data-testid="satellite-pass-card"
    >
      <div className="place-card-head">
        <div className="place-card-titles">
          <strong>{element.OBJECT_NAME}</strong>
          <span className="place-card-sub">
            {groupLabel(element, layerId)} · NORAD {element.NORAD_CAT_ID}
          </span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {/* The one thing about a freshly launched object worth saying before its
        altitude and speed: it is not alone up there. The spacing is the part a
        person can act on — it says how long to keep watching after the first
        one crosses. Always under a minute, by the definition of a train. */}
      {train && (
        <p className="satellite-train">
          Flying as a train — {train.noradIds.length} objects from launch {train.launchId}, one
          every {Math.round(train.spacingSeconds)} s
        </p>
      )}

      <dl className="place-card-facts satellite-facts">
        <div>
          <dt>Now</dt>
          <dd>
            {fix
              ? `${Math.round(fix.altitudeKm)} km · ${Math.round(fix.speedKmS * 3600).toLocaleString()} km/h`
              : 'position unavailable'}
          </dd>
        </div>
        <div>
          <dt>Light</dt>
          <dd>{fix ? (fix.sunlit ? 'Sunlit' : 'In Earth’s shadow') : 'unavailable'}</dd>
        </div>
        <div>
          <dt>Orbit</dt>
          <dd>{Math.round(orbitalPeriodMinutes(element))} min</dd>
        </div>
        <div>
          <dt>Elements</dt>
          <dd className={stale ? 'satellite-stale' : undefined}>
            {elementAgeLabel(ageDays)} old{stale ? ' · predictions may drift' : ''}
          </dd>
        </div>
      </dl>

      <section className="satellite-observer" aria-label="Observer location">
        <div>
          <strong>
            Passes over {observerSource === 'location' ? 'my location' : 'map centre'}
          </strong>
          <code>
            {observer.lat.toFixed(4)}, {observer.lng.toFixed(4)}
          </code>
          {overhead !== null && (
            <p className={overhead ? 'satellite-overhead on' : 'satellite-overhead'} role="status">
              {overhead
                ? `Above your horizon now — over ${minElevationDeg}° up`
                : `Below your horizon — outside the circle on the map`}
            </p>
          )}
        </div>
        <div className="satellite-observer-actions">
          <button type="button" onClick={onUseMapCenter}>
            Map centre
          </button>
          <button type="button" onClick={onUseMyLocation} disabled={locating}>
            {locating ? 'Locating…' : 'My location'}
          </button>
        </div>
        {locationError && (
          <p role="status">Location was unavailable. The map-centre forecast is unchanged.</p>
        )}
      </section>

      <div className="satellite-pass-controls">
        <div role="group" aria-label="Pass visibility">
          <button
            type="button"
            className={visibleOnly ? 'on' : ''}
            aria-pressed={visibleOnly}
            onClick={() => setVisibleOnly(true)}
          >
            Visible
          </button>
          <button
            type="button"
            className={!visibleOnly ? 'on' : ''}
            aria-pressed={!visibleOnly}
            onClick={() => setVisibleOnly(false)}
          >
            All
          </button>
        </div>
        <div role="group" aria-label="Minimum elevation">
          {[10, 30].map((elevation) => (
            <button
              type="button"
              key={elevation}
              className={minElevationDeg === elevation ? 'on' : ''}
              aria-pressed={minElevationDeg === elevation}
              onClick={() => onMinElevationChange(elevation)}
            >
              {elevation}°+
            </button>
          ))}
        </div>
      </div>

      <div className="satellite-pass-heading">
        <strong>{visibleOnly ? 'Visible passes' : 'All passes'}</strong>
        <span>next 3 days</span>
      </div>
      {prediction.passes.length > 0 ? (
        <ol className="satellite-pass-list">
          {prediction.passes.map((pass) => (
            <li key={`${pass.noradId}/${pass.start}`}>
              <time dateTime={pass.start}>{passTime(pass)}</time>
              <span>
                {compass(pass.startAzimuth)} → {compass(pass.endAzimuth)} · peaks{' '}
                {Math.round(pass.maxElevationDeg)}° · {duration(pass.durationSeconds)}
              </span>
              <small>
                {pass.magnitude !== undefined ? `${pass.magnitude.toFixed(1)} mag · ` : ''}
                {visibleOnly
                  ? 'sunlit after dark'
                  : `${pass.sunlit ? 'sunlit' : 'in shadow'} · ${pass.darkSky ? 'dark sky' : 'daylight'}`}
              </small>
            </li>
          ))}
        </ol>
      ) : (
        <p className="satellite-pass-empty">{emptyMessage}</p>
      )}
      <p className="satellite-pass-note">
        “Visible” means the satellite is sunlit while your sky is darker than civil twilight. Clouds
        and local obstructions are not included.
      </p>
    </div>
  );
}
