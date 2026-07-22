import {
  altChipLabel,
  detourLabel,
  fmtDuration,
  fmtEta,
  fmtKm,
  modeTimeLabel,
  stopHitKey,
  stopTitle,
  waypointLabel,
  type LatLng,
  type SearchResult,
} from '@atlas/core';
import { useAlongRouteSearch, useStopSearch, type StopGeocodeFn } from '@atlas/app-hooks';
import { buildGpx } from '@atlas/gpx';
import {
  pathViaLabels,
  ROUTING_PROFILES,
  routePathToTrackData,
  type RoutePath,
} from '@atlas/routing';
import type { PlaceRecord } from '@atlas/storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROUTING_ICON, TrainIcon } from '../icons.js';
import { TransitResults } from './TransitResults.js';
import type { RoutePlanner } from './useRoute.js';
import type { TransitPlan } from './useTransit.js';

function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Geocoding for the stop searches: the same-origin Photon proxy. Viewport bias
 * applies only to the free stop search — an along-route search is already
 * constrained by the route's bounding box, and biasing it towards the map
 * centre would fight that.
 */
function useGeocode(getBias: () => LatLng | null): StopGeocodeFn {
  return useCallback(
    async ({ text, bbox, limit, signal }) => {
      const params = new URLSearchParams({ q: text });
      if (limit !== undefined) params.set('limit', String(limit));
      if (bbox) params.set('bbox', bbox);
      else {
        const bias = getBias();
        if (bias) {
          params.set('lat', String(bias.lat));
          params.set('lon', String(bias.lng));
        }
      }
      const res = await fetch(`/api/search?${params}`, { signal });
      if (!res.ok) return [];
      return ((await res.json()) as { results: SearchResult[] }).results;
    },
    [getBias],
  );
}

/** Search box that adds a stop by name: saved places first, then addresses (Photon). */
function StopSearch({
  places,
  geocode,
  onPick,
}: {
  places: PlaceRecord[];
  geocode: StopGeocodeFn;
  onPick: (position: LatLng, name: string) => void;
}) {
  const { query, setQuery, hits, reset } = useStopSearch({ geocode, places, limit: 8 });

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
                  reset();
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

/** POI/saved-place search constrained to the selected route, ranked by detour. */
function AlongRouteSearch({
  route,
  path,
  places,
  geocode,
}: {
  route: RoutePlanner;
  path: RoutePath;
  places: PlaceRecord[];
  geocode: StopGeocodeFn;
}) {
  const [open, setOpen] = useState(false);
  const { query, setQuery, hits, loading, reset } = useAlongRouteSearch({
    geocode,
    places,
    path,
    estimateDetours: route.estimateDetours,
    active: open,
  });

  return (
    <div className="route-along-search">
      <button
        type="button"
        className="route-along-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Search along route
      </button>
      {open && (
        <>
          <input
            type="search"
            autoFocus
            placeholder="Fuel, food, or a saved place…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search along route"
          />
          {loading && <p className="route-hint">Finding the smallest detours…</p>}
          {!loading && query.trim().length >= 2 && hits.length === 0 && (
            <p className="route-hint">No matches near this route.</p>
          )}
          {hits.length > 0 && (
            <ul>
              {hits.map((hit) => (
                <li key={stopHitKey(hit)}>
                  <button
                    type="button"
                    onClick={() => {
                      route.insertWaypoint(hit.insertIndex, hit.position, hit.name);
                      setOpen(false);
                      reset();
                    }}
                  >
                    <span className="result-name">
                      {hit.saved ? '★ ' : ''}
                      {hit.name}
                    </span>
                    <span className="result-label">
                      {hit.label ? `${hit.label} · ` : ''}
                      <strong>{detourLabel(hit.extraTimeMs)}</strong> detour
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** Route-planning panel: profile, stops, round trip, result stats, GPX export. */
export function RoutePanel({
  route,
  transit,
  places,
  getBias,
}: {
  route: RoutePlanner;
  /** Public transport for the same plan — a travel mode beside the road profiles. */
  transit: TransitPlan;
  /** Saved places, offered in the stop search alongside geocoder results. */
  places: PlaceRecord[];
  /** Current map center, biasing the geocoder towards the viewport. */
  getBias: () => LatLng | null;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const geocode = useGeocode(getBias);
  const path = route.paths?.[route.selectedPath];
  const transitMode = transit.enabled;
  // Trip times sit under the mode icons only for a point-to-point plan, where
  // comparing modes makes sense; a loop or a single stop has nothing to compare.
  const showModeTimes = !route.roundTrip && route.waypoints.length >= 2;
  // Transit's chip time comes from its own board, not a costing; the board is
  // asked as soon as the plan has two ends, so this fills in alongside the
  // other modes rather than only after transit is picked.
  const transitTimeMs = transit.trips?.[0]?.durationMs;
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

  // The URL hash already carries the plan (useShareHash), so the current URL
  // is the share link — same contract as the pin popup's "Copy link".
  const copyLink = () => {
    void navigator.clipboard.writeText(window.location.href).then(
      () => setCopied(true),
      () => setCopied(false), // clipboard denied: leave the button as-is
    );
  };
  // Any edit to the plan invalidates the "copied" confirmation.
  useEffect(() => setCopied(false), [route.waypoints, route.profile, route.roundTripKm]);

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
        {ROUTING_PROFILES.map((p) => {
          const Icon = ROUTING_ICON[p.id];
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={!transitMode && p.id === route.profile}
              onClick={() => {
                transit.setEnabled(false);
                route.setProfile(p.id);
              }}
            >
              <span className="mode-label">
                <Icon size={18} /> {p.label}
              </span>
              {showModeTimes && (
                <span className="mode-time">{modeTimeLabel(route.modeTimes[p.id])}</span>
              )}
            </button>
          );
        })}
        {transit.offered && (
          <button
            type="button"
            aria-pressed={transitMode}
            onClick={() => transit.setEnabled(true)}
            title="Public transport departures (Norway, live from Entur)"
          >
            <span>
              <TrainIcon size={18} /> Transit
            </span>
            {showModeTimes && transitTimeMs !== undefined && (
              <span className="mode-time">{fmtDuration(transitTimeMs)}</span>
            )}
          </button>
        )}
      </div>

      <div className="route-roundtrip" hidden={transitMode}>
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
        geocode={geocode}
        onPick={(position, name) => route.addWaypoint(position, name)}
      />

      {!route.roundTrip && !transitMode && path && route.waypoints.length >= 2 && (
        <AlongRouteSearch route={route} path={path} places={places} geocode={geocode} />
      )}

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
                {stopTitle(w)}
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
      {/* Via points and route-line clicks belong to the road profiles: a
          timetable cannot honour either, so the advice would be a lie here. */}
      {!route.roundTrip && !transitMode && route.waypoints.length >= 2 && (
        <p className="route-hint">
          Drag rows to reorder · drag markers to move · click the route line to add a via point.
        </p>
      )}

      {/* Each action appears only once it can do something, rather than sitting
          there greyed out: Reverse needs two ends, Optimize a tour to shorten,
          Export a computed track, and Clear/Share something to act on. With no
          stops the whole row is gone rather than a strip of dead buttons. */}
      {route.waypoints.length > 0 && (
        <div className="route-actions">
          {!route.roundTrip && route.waypoints.length >= 2 && (
            <button type="button" onClick={route.reverse}>
              Reverse
            </button>
          )}
          {!route.roundTrip && route.waypoints.length >= 4 && (
            <button
              type="button"
              onClick={route.optimize}
              title="Reorder intermediate stops for a shorter tour"
            >
              Optimize
            </button>
          )}
          <button type="button" onClick={route.clear}>
            Clear
          </button>
          {/* A journey is a timetable, not a track: there is nothing to export. */}
          {path && !transitMode && (
            <button type="button" onClick={exportGpx}>
              Export GPX
            </button>
          )}
          <button type="button" onClick={copyLink} title="Copy a link that reopens this plan">
            {copied ? 'Link copied' : 'Share'}
          </button>
        </div>
      )}

      {transitMode && route.waypoints.length > 2 && (
        <p className="route-hint">
          Public transport plans between the first and last stop; via points are ignored.
        </p>
      )}
      {transitMode && <TransitResults transit={transit} />}

      {!transitMode && route.error && <div className="route-error">{route.error}</div>}
      {!transitMode && path && (
        <div className="route-stats">
          <strong>{fmtKm(path.distanceM)}</strong> · {fmtDuration(path.timeMs)} · ETA{' '}
          {fmtEta(path.timeMs)}
          {/* Valhalla tiles carry no elevation data, so 0/0 means "unknown". */}
          {path.ascentM > 0 || path.descentM > 0
            ? ` · ↗ ${Math.round(path.ascentM)} m ↘ ${Math.round(path.descentM)} m`
            : null}
          {/* A ferry is timetabled and, on foot or by bike, the one stretch you
              cannot simply set off along. Non-car routes avoid ferries where a
              land route exists, so if one survived, it is the only way across
              and the traveller needs to know before setting out. */}
          {path.hasFerry && (
            <div className="route-ferry-note">
              ⛴️ This route crosses by ferry
              {route.profile === 'car'
                ? '.'
                : ' — there is no land route. Check sailing times, or try public transport.'}
            </div>
          )}
        </div>
      )}
      {!transitMode && route.paths && route.paths.length > 1 && (
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
