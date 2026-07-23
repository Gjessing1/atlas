import { sunDay, type SunDay } from '@atlas/conditions';
import {
  fmtClock,
  fmtCoords,
  placeTargetSubtitle,
  placeTargetTitle,
  type LatLng,
  type PlaceTarget,
} from '@atlas/core';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useMemo, useState } from 'react';
import { useElevation } from './useElevation.js';

interface PlaceCardProps {
  target: PlaceTarget;
  /** The saved place at this position, if the user already has one. */
  saved: PlaceRecord | undefined;
  /** Saving is unavailable until persistent user storage has finished opening. */
  saveEnabled: boolean;
  /** User's own position, for the "… away" line; null when unknown. */
  userAt: LatLng | null;
  /** A route is being planned, so "Add stop" is meaningful. */
  routeActive: boolean;
  /** The Collections sidebar is open and occupies the card's usual corner. */
  shifted: boolean;
  /** Open the route planner with this point as the destination. */
  onDirections: () => void;
  onSave: () => void;
  onShowSaved: (place: PlaceRecord) => void;
  onAddStop: () => void;
  /**
   * Share this spot. Resolves with how it went out: the OS share sheet took it
   * ('shared'), or it went to the clipboard instead ('copied' — the only case
   * the button needs to confirm, since a share sheet is its own feedback).
   */
  onShare: () => Promise<'shared' | 'copied'>;
  /** Open the forecast panel on this spot rather than on the map centre. */
  onWeather: () => void;
  /** Remove the dropped pin (pin targets only). */
  onRemovePin: () => void;
  onClose: () => void;
}

/**
 * The day's light in one line: sunrise/sunset and how long the day is, or what
 * is happening instead when the sun does not cross the horizon at all.
 *
 * Both polar branches still check `dawn`/`dusk` rather than assuming twilight
 * exists. It does at Tromsø in December — the sun reaches about -3° at noon, so
 * there are usable hours — but not far enough north (Svalbard, deep winter),
 * where the sun stays below -6° all day and there is no twilight to name.
 */
function describeLight(sun: SunDay): string {
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

/**
 * One card for every way of pointing at a spot: a dropped pin, a saved place, a
 * POI tapped on the map, a picked search result.
 *
 * It replaces three ad-hoc MapLibre popups that showed different information and
 * offered different actions for the same underlying thing — a POI could not be
 * navigated to, a saved place could only show its name, and only the pin could
 * be shared. The actions are the same set every time; only the ones that cannot
 * apply are left out.
 *
 * Like the Android card, it deliberately does **not** choose a travel mode:
 * "Directions" opens the route planner with this point as the destination, and
 * every mode decision — including public transport, which needs a journey board
 * this card has no room for — lives there, in one place.
 */
export function PlaceCard({
  target,
  saved,
  saveEnabled,
  userAt,
  routeActive,
  shifted,
  onDirections,
  onSave,
  onShowSaved,
  onAddStop,
  onShare,
  onWeather,
  onRemovePin,
  onClose,
}: PlaceCardProps) {
  const [copied, setCopied] = useState<'coords' | 'link' | null>(null);
  // Clear the "Copied" confirmation; a second copy restarts the timer.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const coords = fmtCoords(target.position);
  const subtitle = placeTargetSubtitle(target, userAt);
  const title = placeTargetTitle(target);
  // A bare pin already shows its coordinates as the heading; don't repeat them.
  const showCoords = title !== coords;

  const elevation = useElevation(target.position);
  // Sun times are pure local maths (no network, no coverage limits), so unlike
  // elevation they are always available — recomputed per position, and per day
  // only in the sense that the card is short-lived.
  const sun = useMemo(
    () => sunDay(new Date(), target.position.lat, target.position.lng),
    [target.position.lat, target.position.lng],
  );
  const light = describeLight(sun);

  return (
    <div className={`place-card${shifted ? ' place-card-shifted' : ''}`} role="dialog">
      <div className="place-card-head">
        <div className="place-card-titles">
          <strong>{title}</strong>
          {subtitle && <span className="place-card-sub">{subtitle}</span>}
          {showCoords && <code className="place-card-coords">{coords}</code>}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {/* What this spot is like, as opposed to what you can do with it. Elevation
          is fetched and Norway-only, so it states its own absence rather than
          silently leaving the row short. */}
      <dl className="place-card-facts">
        <div>
          <dt>Elevation</dt>
          <dd>
            {elevation.status === 'loading' && '…'}
            {elevation.status === 'error' && 'unavailable'}
            {elevation.status === 'ready' &&
              (elevation.elevationM === null
                ? 'no data here'
                : `${Math.round(elevation.elevationM)} m`)}
          </dd>
        </div>
        {light && (
          <div>
            <dt>Light</dt>
            <dd>{light}</dd>
          </div>
        )}
      </dl>
      <div className="place-card-actions">
        <button type="button" className="primary" onClick={onDirections}>
          Directions
        </button>
        {routeActive && (
          <button type="button" onClick={onAddStop}>
            Add stop
          </button>
        )}
        {saved ? (
          <button type="button" onClick={() => onShowSaved(saved)}>
            ★ Saved
          </button>
        ) : (
          <button
            type="button"
            onClick={onSave}
            disabled={!saveEnabled}
            title={saveEnabled ? undefined : 'Opening your collections…'}
          >
            Save
          </button>
        )}
        <button type="button" onClick={onWeather}>
          Weather
        </button>
        <button
          type="button"
          onClick={() => {
            void onShare().then((how) => {
              if (how === 'copied') setCopied('link');
            });
          }}
        >
          {copied === 'link' ? 'Copied' : 'Share'}
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(coords);
            setCopied('coords');
          }}
        >
          {copied === 'coords' ? 'Copied' : 'Copy coords'}
        </button>
        {target.source === 'pin' && (
          <button type="button" onClick={onRemovePin}>
            Remove pin
          </button>
        )}
      </div>
    </div>
  );
}
