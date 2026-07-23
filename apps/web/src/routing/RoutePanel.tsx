import {
  altChipLabel,
  detourLabel,
  fmtDuration,
  fmtEta,
  fmtKm,
  modeTimeLabel,
  stopHitKey,
  stopRole,
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
  type RoutePreferences,
} from '@atlas/routing';
import type { PlaceRecord } from '@atlas/storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBottomSheet } from '../BottomSheet.js';
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
  placeholder,
  ariaLabel,
  initialQuery = '',
  autoFocus = false,
  onPick,
  onCancel,
}: {
  places: PlaceRecord[];
  geocode: StopGeocodeFn;
  /** Says which end this box fills, so the box is not a mystery slot. */
  placeholder: string;
  ariaLabel: string;
  /**
   * Pre-filled text when editing an existing stop — selected on focus, so the
   * first keystroke replaces the old name instead of appending to it.
   */
  initialQuery?: string;
  autoFocus?: boolean;
  onPick: (position: LatLng, name: string) => void;
  /** Present when this box is re-pointing an existing stop — leaves it as is. */
  onCancel?: () => void;
}) {
  const { query, setQuery, hits, reset } = useStopSearch({
    geocode,
    places,
    initialQuery,
    limit: 8,
  });

  return (
    <div className="route-stop-search">
      <div className="route-stop-input-row">
        <input
          type="search"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          onFocus={autoFocus ? (e) => e.currentTarget.select() : undefined}
        />
        {onCancel && (
          <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel edit">
            ✕
          </button>
        )}
      </div>
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

const CUSTOM_OPTIONS: readonly {
  key: keyof RoutePreferences;
  label: string;
  profiles: readonly string[];
}[] = [
  {
    key: 'avoidFerries',
    label: 'Avoid ferries',
    profiles: ['car', 'bike', 'foot', 'hike', 'run'],
  },
  { key: 'avoidHighways', label: 'Avoid highways', profiles: ['car'] },
  { key: 'avoidTolls', label: 'Avoid toll roads', profiles: ['car'] },
  { key: 'avoidHills', label: 'Prefer flatter ways', profiles: ['bike', 'foot', 'hike', 'run'] },
  { key: 'preferTrails', label: 'Prefer trails', profiles: ['bike', 'hike', 'run'] },
];

/** Route-planning panel: profile, stops, round trip, result stats, GPX export. */
export function RoutePanel({
  route,
  transit,
  places,
  getBias,
  getMyLocation,
  locatingOrigin,
  onNavigate,
}: {
  route: RoutePlanner;
  /** Public transport for the same plan — a travel mode beside the road profiles. */
  transit: TransitPlan;
  /** Saved places, offered in the stop search alongside geocoder results. */
  places: PlaceRecord[];
  /** Current map center, biasing the geocoder towards the viewport. */
  getBias: () => LatLng | null;
  /** A GPS fix for the "My location" shortcut, or null when unavailable. */
  getMyLocation: () => Promise<LatLng | null>;
  /** A "Directions" hand-off is still waiting for the browser's fix. */
  locatingOrigin: boolean;
  /**
   * Start turn-by-turn to the last stop in the current profile, via the plan's
   * intermediate stops. This panel is the app's only travel-mode picker, so
   * guidance starts from here.
   */
  onNavigate: (destination: LatLng, viaPoints: LatLng[]) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // Waypoint id whose search box is open for re-pointing, or null.
  const [editing, setEditing] = useState<number | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateFailed, setLocateFailed] = useState(false);
  // On the phone layout this panel is a draggable bottom sheet; swiping it down
  // past its peek closes the planner, the same as the ✕. Inert on desktop.
  const sheet = useBottomSheet({ onDismiss: route.stop, initial: 'half' });
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
  // Turn-by-turn goes to the plan's last stop; a loop has no destination to
  // be guided to that isn't where the traveller already is.
  const destination = !route.roundTrip
    ? route.waypoints[route.waypoints.length - 1]?.pos
    : undefined;
  // "via …" labels distinguishing the alternatives (needs instructions).
  const vias = useMemo(() => (route.paths ? pathViaLabels(route.paths) : []), [route.paths]);

  const stops = route.waypoints;
  // Which end the add-a-stop box fills: the first stop is the start, anything
  // after it extends the route, which in transit mode means the destination.
  const nextRole = stops.length === 0 ? 'start' : 'destination';

  // A stop that disappears (cleared, removed, reversed away) must not leave an
  // orphaned editor bound to an id that no longer exists.
  useEffect(() => {
    if (editing !== null && !stops.some((w) => w.id === editing)) setEditing(null);
  }, [editing, stops]);

  /**
   * Put the current position at the front of the plan. Always the start, never
   * the destination: "navigate to where I already am" is not a journey anyone
   * plans, and a control whose meaning flips with the stop count is worse than
   * one that does a single predictable thing.
   */
  const addMyLocation = async () => {
    setLocating(true);
    setLocateFailed(false);
    try {
      const here = await getMyLocation();
      if (!here) {
        setLocateFailed(true);
        return;
      }
      if (stops.length === 0) route.addWaypoint(here, 'My location');
      else route.insertWaypoint(0, here, 'My location');
    } finally {
      setLocating(false);
    }
  };

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
    <div className="route-panel" ref={sheet.sheetRef} data-sheet-snap={sheet.snap}>
      {/* Phone-only drag handle; hidden on desktop, where the panel floats. A
          field gaining focus raises the sheet so the keyboard can't bury it. */}
      <div className="sheet-grabber" {...sheet.grabberProps}>
        <span className="sheet-grabber-pill" aria-hidden="true" />
      </div>
      <div
        className="route-panel-body"
        onFocusCapture={(e) => {
          if (e.target instanceof HTMLInputElement) sheet.ensureVisible();
        }}
      >
        <div className="route-header">
          <strong>Route</strong>
          {route.loading && <span className="route-loading">Routing…</span>}
          {locatingOrigin && <span className="route-loading">Getting location…</span>}
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

        {!transitMode && (
          <details className="route-custom">
            <summary>
              Customize {ROUTING_PROFILES.find((p) => p.id === route.profile)?.label}
            </summary>
            <div className="route-custom-options">
              {CUSTOM_OPTIONS.filter((option) => option.profiles.includes(route.profile)).map(
                (option) => (
                  <label key={option.key}>
                    <input
                      type="checkbox"
                      checked={route.preferences[option.key]}
                      onChange={(event) =>
                        route.setPreference(option.key, event.currentTarget.checked)
                      }
                    />
                    {option.label}
                  </label>
                ),
              )}
            </div>
          </details>
        )}

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

        {/* While a stop is being re-pointed, the add-a-stop box stands down — two
          open search boxes with two different meanings is how you end up
          appending a stop you meant to replace. */}
        {editing === null && (
          <StopSearch
            places={places}
            geocode={geocode}
            placeholder={
              nextRole === 'start'
                ? 'Start: address or saved place…'
                : stops.length >= 2
                  ? 'Add a stop…'
                  : 'Destination: address or saved place…'
            }
            ariaLabel={nextRole === 'start' ? 'Search for a start' : 'Search for a destination'}
            onPick={(position, name) => route.addWaypoint(position, name)}
          />
        )}

        {/* "My location" always seeds the start — the commonest plan begins where
          you are. Kept beside the "or click the map" reminder so both ways of
          setting the start sit together. */}
        {editing === null && (
          <div className="route-source-row">
            <button
              type="button"
              className="route-my-location"
              disabled={locating}
              onClick={() => void addMyLocation()}
            >
              {locating ? 'Locating…' : '◎ My location as start'}
            </button>
            <span className="route-hint">or click the map</span>
          </div>
        )}
        {/* A silent no-op would read as a dead button; say why nothing happened. */}
        {locateFailed && (
          <p className="route-hint">
            No location fix — check location permission, or click the map.
          </p>
        )}

        {!route.roundTrip && !transitMode && path && route.waypoints.length >= 2 && (
          <AlongRouteSearch route={route} path={path} places={places} geocode={geocode} />
        )}

        {route.waypoints.length > 0 ? (
          <ol className="route-waypoints">
            {route.waypoints.map((w, i) => {
              const role = stopRole(i, route.waypoints.length, route.roundTrip);
              const isEditing = editing === w.id;
              return (
                <li
                  key={w.id}
                  className={dragIndex === i ? 'dragging' : undefined}
                  draggable={!route.roundTrip && !isEditing}
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIndex !== null) route.reorderWaypoint(dragIndex, i);
                    setDragIndex(null);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                >
                  {/* Named ends read as a plan ("From … To …"); a multi-stop road
                    route keeps the lettered markers that match the map pins. */}
                  <span
                    className={role ? 'route-wp-role' : 'route-wp-label'}
                    aria-hidden={role ? undefined : 'true'}
                  >
                    {role ?? waypointLabel(i, route.roundTrip, route.waypoints.length)}
                  </span>
                  {isEditing ? (
                    <div className="route-wp-edit">
                      <StopSearch
                        places={places}
                        geocode={geocode}
                        placeholder="Change this stop…"
                        ariaLabel="Change this stop"
                        initialQuery={w.name ?? ''}
                        autoFocus
                        onPick={(position, name) => {
                          route.replaceWaypoint(w.id, position, name);
                          setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    </div>
                  ) : (
                    <>
                      {/* A stop that cannot be changed without deleting it is the
                        thing every other maps app lets you click. Editing in
                        place also keeps its position in the order. */}
                      <button
                        type="button"
                        className={`route-wp-tap ${w.name ? 'route-wp-name' : 'route-wp-coords'}`}
                        title={w.name}
                        onClick={() => setEditing(w.id)}
                        aria-label={`Change ${stopTitle(w)}`}
                      >
                        {stopTitle(w)}
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => route.removeWaypoint(w.id)}
                        aria-label={`Remove stop ${waypointLabel(i, route.roundTrip, route.waypoints.length)}`}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </li>
              );
            })}
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

        {/* This panel is the only travel-mode picker, so guidance starts here.
          Transit has no turn-by-turn — it shows the journey board below instead
          of a button that would promise directions it cannot give. */}
        {!transitMode && destination && (
          <button
            type="button"
            className="route-navigate"
            // Guidance replaces the planned origin with the live position, so
            // the stops between first and last ride along as via points.
            onClick={() =>
              onNavigate(
                destination,
                route.waypoints.slice(1, -1).map((w) => w.pos),
              )
            }
          >
            Start navigation
          </button>
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
    </div>
  );
}
