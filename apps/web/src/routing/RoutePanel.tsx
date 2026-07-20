import { matchPlacesByName, type LatLng, type SearchResult } from '@atlas/core';
import { buildGpx } from '@atlas/gpx';
import {
  pathViaLabels,
  ROUTING_PROFILES,
  routePathToTrackData,
  type RoutePath,
} from '@atlas/routing';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useMemo, useState } from 'react';
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

/** Alternative chip: the fastest shows its duration, others their extra minutes. */
function altChipLabel(paths: RoutePath[], i: number, vias: (string | null)[]): string {
  const extraMin = Math.round((paths[i]!.timeMs - paths[0]!.timeMs) / 60000);
  const head =
    i === 0 ? fmtDuration(paths[0]!.timeMs) : extraMin < 1 ? '+<1 min' : `+${extraMin} min`;
  const via = vias[i];
  return via ? `${head} via ${via}` : head;
}

/** Waypoint label, matching the map markers: A, B, C… (⟳ for a round trip). */
function waypointLabel(index: number, roundTrip: boolean, count: number): string {
  if (roundTrip || count === 1) return '⟳';
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

interface StopHit {
  name: string;
  label: string;
  position: LatLng;
  /** True for the user's saved places — listed first, marked with a star. */
  saved: boolean;
}

/** Search box that adds a stop by name: saved places first, then addresses (Photon). */
function StopSearch({
  places,
  getBias,
  onPick,
}: {
  places: PlaceRecord[];
  getBias: () => LatLng | null;
  onPick: (position: LatLng, name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StopHit[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const saved: StopHit[] = matchPlacesByName(places, q, 4).map((p) => ({
        name: p.name,
        label: 'Saved place',
        position: { lat: p.lat, lng: p.lng },
        saved: true,
      }));
      let remote: StopHit[] = [];
      try {
        const params = new URLSearchParams({ q });
        const bias = getBias();
        if (bias) {
          params.set('lat', String(bias.lat));
          params.set('lon', String(bias.lng));
        }
        const res = await fetch(`/api/search?${params}`, { signal: controller.signal });
        if (res.ok) {
          remote = ((await res.json()) as { results: SearchResult[] }).results.map((r) => ({
            name: r.name,
            label: r.label,
            position: r.position,
            saved: false,
          }));
        }
      } catch {
        // Aborted or offline — saved places still match.
      }
      if (!controller.signal.aborted) setHits([...saved, ...remote].slice(0, 8));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, places, getBias]);

  return (
    <div className="route-stop-search">
      <input
        type="search"
        placeholder="Add stop: address or saved place…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search for a stop"
      />
      {hits.length > 0 && (
        <ul>
          {hits.map((hit, i) => (
            <li key={`${hit.position.lat}/${hit.position.lng}/${i}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(hit.position, hit.name);
                  setQuery('');
                  setHits([]);
                }}
              >
                <span className="result-name">
                  {hit.saved ? '★ ' : ''}
                  {hit.name}
                </span>
                {hit.label && <span className="result-label">{hit.label}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Route-planning panel: profile, stops, round trip, result stats, GPX export. */
export function RoutePanel({
  route,
  places,
  getBias,
}: {
  route: RoutePlanner;
  /** Saved places, offered in the stop search alongside geocoder results. */
  places: PlaceRecord[];
  /** Current map center, biasing the geocoder towards the viewport. */
  getBias: () => LatLng | null;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const path = route.paths?.[route.selectedPath];
  // "via …" labels distinguishing the alternatives (needs instructions).
  const vias = useMemo(() => (route.paths ? pathViaLabels(route.paths) : []), [route.paths]);

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

      <StopSearch
        places={places}
        getBias={getBias}
        onPick={(position, name) => route.addWaypoint(position, name)}
      />

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
              {/* Named stops read as a plan ("Home → Oslo S"); an unlabelled
                  map click still shows where it is. */}
              <span className={w.name ? 'route-wp-name' : 'route-wp-coords'} title={w.name}>
                {w.name ?? `${w.pos.lat.toFixed(4)}, ${w.pos.lng.toFixed(4)}`}
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
          {fmtEta(path.timeMs)}
          {/* Valhalla tiles carry no elevation data, so 0/0 means "unknown". */}
          {path.ascentM > 0 || path.descentM > 0
            ? ` · ↗ ${Math.round(path.ascentM)} m ↘ ${Math.round(path.descentM)} m`
            : null}
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
              {altChipLabel(route.paths!, i, vias)} · {fmtKm(p.distanceM)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
