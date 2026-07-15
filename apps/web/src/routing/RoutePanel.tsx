import { buildGpx } from '@atlas/gpx';
import { ROUTING_PROFILES, routePathToTrackData } from '@atlas/routing';
import { useState } from 'react';
import { fmtDuration, fmtKm } from '../format.js';
import type { RoutePlanner } from './useRoute.js';

function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

const fmtEta = (timeMs: number): string =>
  new Date(Date.now() + timeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Waypoint label, matching the map markers: A, B, C… (⟳ for a round trip). */
function waypointLabel(index: number, roundTrip: boolean, count: number): string {
  if (roundTrip || count === 1) return '⟳';
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** Route-planning panel: profile, stops, round trip, result stats, GPX export. */
export function RoutePanel({ route }: { route: RoutePlanner }) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const path = route.paths?.[route.selectedPath];

  const exportGpx = () => {
    if (!path) return;
    const profile = ROUTING_PROFILES.find((p) => p.id === route.profile);
    const name = `Atlas ${profile?.label.toLowerCase() ?? route.profile} route`;
    downloadText(
      `atlas-route-${route.profile}.gpx`,
      buildGpx(routePathToTrackData(path, name)),
      'application/gpx+xml',
    );
  };

  return (
    <div className="route-panel">
      <div className="route-header">
        <strong>Route</strong>
        {route.loading && <span className="route-loading">Routing…</span>}
        <button
          type="button"
          className="icon-button"
          onClick={route.stop}
          aria-label="Close route planning"
        >
          ✕
        </button>
      </div>

      <div className="route-profiles" role="group" aria-label="Routing profile">
        {ROUTING_PROFILES.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={p.id === route.profile}
            onClick={() => route.setProfile(p.id)}
          >
            <span aria-hidden="true">{p.icon}</span> {p.label}
          </button>
        ))}
      </div>

      <div className="route-roundtrip">
        <label>
          <input
            type="checkbox"
            checked={route.roundTrip}
            onChange={(e) => route.setRoundTrip(e.target.checked)}
          />
          Round trip
        </label>
        {route.roundTrip && (
          <>
            <input
              type="number"
              min={1}
              max={500}
              value={route.roundTripKm}
              onChange={(e) => route.setRoundTripKm(Math.max(Number(e.target.value) || 1, 1))}
              aria-label="Round trip distance in kilometers"
            />
            <span>km</span>
            <button type="button" onClick={route.newLoop} disabled={route.waypoints.length === 0}>
              New loop
            </button>
          </>
        )}
      </div>

      {route.waypoints.length > 0 ? (
        <ol className="route-waypoints">
          {route.waypoints.map((w, i) => (
            <li
              key={w.id}
              className={dragIndex === i ? 'dragging' : undefined}
              draggable={!route.roundTrip}
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null) route.reorderWaypoint(dragIndex, i);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
            >
              <span className="route-wp-label" aria-hidden="true">
                {waypointLabel(i, route.roundTrip, route.waypoints.length)}
              </span>
              <span className="route-wp-coords">
                {w.pos.lat.toFixed(4)}, {w.pos.lng.toFixed(4)}
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() => route.removeWaypoint(w.id)}
                aria-label={`Remove stop ${waypointLabel(i, route.roundTrip, route.waypoints.length)}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="route-hint">
          {route.roundTrip
            ? 'Click the map to set the starting point.'
            : 'Click the map to add start and destination.'}
        </p>
      )}
      {!route.roundTrip && route.waypoints.length === 1 && (
        <p className="route-hint">Click the map to add the destination.</p>
      )}
      {!route.roundTrip && route.waypoints.length >= 2 && (
        <p className="route-hint">
          Drag rows to reorder · drag markers to move · click the route line to add a via point.
        </p>
      )}

      <div className="route-actions">
        <button
          type="button"
          onClick={route.reverse}
          disabled={route.roundTrip || route.waypoints.length < 2}
        >
          Reverse
        </button>
        <button
          type="button"
          onClick={route.optimize}
          disabled={route.roundTrip || route.waypoints.length < 4}
          title="Reorder intermediate stops for a shorter tour"
        >
          Optimize
        </button>
        <button type="button" onClick={route.clear} disabled={route.waypoints.length === 0}>
          Clear
        </button>
        <button type="button" onClick={exportGpx} disabled={!path}>
          Export GPX
        </button>
      </div>

      {route.error && <div className="route-error">{route.error}</div>}
      {path && (
        <div className="route-stats">
          <strong>{fmtKm(path.distanceM)}</strong> · {fmtDuration(path.timeMs)} · ETA{' '}
          {fmtEta(path.timeMs)} · ↗ {Math.round(path.ascentM)} m ↘ {Math.round(path.descentM)} m
        </div>
      )}
      {route.paths && route.paths.length > 1 && (
        <div className="route-alternatives" role="group" aria-label="Route alternatives">
          {route.paths.map((p, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={i === route.selectedPath}
              onClick={() => route.selectPath(i)}
            >
              {i === 0 ? 'Best' : `Alt ${i}`}: {fmtKm(p.distanceM)} · {fmtDuration(p.timeMs)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
