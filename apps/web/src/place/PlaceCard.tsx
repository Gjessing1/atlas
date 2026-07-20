import {
  fmtCoords,
  placeTargetSubtitle,
  placeTargetTitle,
  type LatLng,
  type PlaceTarget,
} from '@atlas/core';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useState } from 'react';

interface PlaceCardProps {
  target: PlaceTarget;
  /** The saved place at this position, if the user already has one. */
  saved: PlaceRecord | undefined;
  /** User's own position, for the "… away" line; null when unknown. */
  userAt: LatLng | null;
  /** A route is being planned, so "Add stop" is meaningful. */
  routeActive: boolean;
  /** The Saved sidebar is open and occupies the card's usual corner. */
  shifted: boolean;
  onNavigate: () => void;
  onSave: () => void;
  onShowSaved: (place: PlaceRecord) => void;
  onAddStop: () => void;
  /** Copy a share link to this spot; returns once the clipboard write settled. */
  onShare: () => void;
  /** Remove the dropped pin (pin targets only). */
  onRemovePin: () => void;
  onClose: () => void;
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
 */
export function PlaceCard({
  target,
  saved,
  userAt,
  routeActive,
  shifted,
  onNavigate,
  onSave,
  onShowSaved,
  onAddStop,
  onShare,
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
      <div className="place-card-actions">
        <button type="button" className="primary" onClick={onNavigate}>
          Navigate
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
          <button type="button" onClick={onSave}>
            Save
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            onShare();
            setCopied('link');
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
