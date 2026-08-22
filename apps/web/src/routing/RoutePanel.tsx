import {
  altChipLabel,
  fmtDistanceM,
  fmtDuration,
  fmtEta,
  fmtKm,
  modeTimeLabel,
  stopAlongLabel,
  stopRole,
  stopTitle,
  waypointLabel,
  type LatLng,
} from '@atlas/core';
import {
  routeStopCategories,
  useRouteStops,
  useStopSearch,
  type FetchNearbyFn,
  type StopGeocodeFn,
} from '@atlas/app-hooks';
import { buildGpx, type TrackData } from '@atlas/gpx';
import {
  pathViaLabels,
  ROUTING_PROFILES,
  routePathToTrackData,
  routeSurfaceBreakdown,
  routeOptionsFor,
  routeActionsFor,
  type RouteActionInfo,
  type RouteActionKey,
  type RoutePath,
  vehicleChipLabel,
} from '@atlas/routing';
import type { CollectionRecord, PlaceRecord } from '@atlas/storage';
import type { TransitTrip } from '@atlas/transit';
import { formatTrafficDelay } from '@atlas/traffic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBottomSheet } from '../BottomSheet.js';
import { CarIcon, ROUTING_ICON, TrainIcon } from '../icons.js';
import { TransitResults } from './TransitResults.js';
import { useGeocode } from './useGeocode.js';
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

/** Search box that adds a stop by name: saved places first, then addresses (Photon). */
function StopSearch({
  places,
  geocode,
  placeholder,
  ariaLabel,
  initialQuery = '',
  autoFocus = false,
  transit,
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
  transit: boolean;
  onPick: (position: LatLng, name: string, transitStopId?: string) => void;
  /** Present when this box is re-pointing an existing stop — leaves it as is. */
  onCancel?: () => void;
}) {
  const { query, setQuery, hits, reset, statusText } = useStopSearch({
    geocode,
    places,
    initialQuery,
    limit: 8,
    transit,
  });
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="route-stop-search">
      <div className="route-stop-input-row">
        <input
          ref={input}
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
      {(hits.length > 0 || statusText) && (
        <ul>
          {statusText && <li className="route-stop-status">{statusText}</li>}
          {hits.map((hit, i) => (
            <li key={`${hit.position.lat}/${hit.position.lng}/${i}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(hit.position, hit.name, hit.transitStopId);
                  reset();
                  // Stay in the box: picking a result moves focus to the button
                  // that then disappears, so every further stop cost a click
                  // back into the field before it could be typed. A trip with
                  // five stops is five stops, not five stops and five clicks.
                  // (Not while re-pointing an existing stop — that editor closes.)
                  if (!onCancel) input.current?.focus();
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

/**
 * Stops on the route, browsed by category — the planner's twin of the mid-drive
 * "add a stop" panel (rules in `useRouteStops`). One tap per category, results
 * in route order with how far along and how far off each one is; picking one
 * inserts it into the right leg.
 */
function AlongRouteStops({
  route,
  path,
  fetchNearby,
  onPicked,
}: {
  route: RoutePlanner;
  path: RoutePath;
  fetchNearby: FetchNearbyFn;
  /** Close the browser once a stop has joined the plan. */
  onPicked: () => void;
}) {
  // Always open: the disclosure that used to live here is now the toolbar's
  // "Stops along route" button, which is where a driver looks for it (ROADMAP:
  // "Give each routing type an intentional toolbar"). Kept as a constant so
  // useRouteStops keeps its "only search while the panel is showing" contract.
  const open = true;
  const waypoints = useMemo(() => route.waypoints.map((w) => w.pos), [route.waypoints]);
  const { category, setCategory, hits, status } = useRouteStops({
    path,
    waypoints,
    profile: route.profile,
    active: open,
    fetchNearby,
  });
  const categories = routeStopCategories(route.profile);

  return (
    <div className="route-along-search">
      <div className="route-along-categories" role="tablist" aria-label="Stop category">
        {categories.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            className={`route-along-category${category === item.id ? ' on' : ''}`}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {status === 'loading' && <p className="route-hint">Looking along the route…</p>}
      {status === 'error' && <p className="route-hint">Search unavailable right now.</p>}
      {status === 'ready' && hits.length === 0 && (
        <p className="route-hint">Nothing in this category along this route.</p>
      )}
      {hits.length > 0 && (
        <ul>
          {hits.map((hit) => (
            <li key={`${hit.name}/${hit.position.lat}/${hit.position.lng}`}>
              <button
                type="button"
                onClick={() => {
                  route.insertWaypoint(hit.insertIndex, hit.position, hit.name);
                  onPicked();
                }}
              >
                <span className="result-name">{hit.name}</span>
                <span className="result-label">
                  <strong>{stopAlongLabel(hit.alongM)}</strong>
                  {/* Only worth saying when it is a real detour. */}
                  {hit.offRouteM > 250 ? ` · ${fmtDistanceM(hit.offRouteM)} off route` : ''}
                  {hit.label ? ` · ${hit.label}` : ''}
                </span>
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
  transit,
  places,
  collections,
  getBias,
  getMyLocation,
  locatingOrigin,
  fetchNearby,
  onNavigate,
  onOpenVehicleSettings,
  onStartTransitGuidance,
  onSaveTrack,
}: {
  route: RoutePlanner;
  /** Public transport for the same plan — a travel mode beside the road profiles. */
  transit: TransitPlan;
  /** Saved places, offered in the stop search alongside geocoder results. */
  places: PlaceRecord[];
  /** Destination folders for saving this plan as a synced track. */
  collections: CollectionRecord[];
  /** Current map center, biasing the geocoder towards the viewport. */
  getBias: () => LatLng | null;
  /** A GPS fix for the "My location" shortcut, or null when unavailable. */
  getMyLocation: () => Promise<LatLng | null>;
  /** A "Directions" hand-off is still waiting for the browser's fix. */
  locatingOrigin: boolean;
  /** Category POIs near a point — the same explore seam the mid-drive panel uses. */
  fetchNearby: FetchNearbyFn;
  /**
   * Start turn-by-turn to the last stop in the current profile, via the plan's
   * intermediate stops. This panel is the app's only travel-mode picker, so
   * guidance starts from here.
   */
  onNavigate: (destination: LatLng, viaPoints: LatLng[]) => void;
  /** Start a destination-free live map in the selected travel mode. */
  /** Open Settings → Navigation, where the vehicle is described. */
  onOpenVehicleSettings: () => void;
  /** Start the timetable-driven passenger companion for one selected journey. */
  onStartTransitGuidance: (trip: TransitTrip) => void;
  onSaveTrack: (data: TrackData, name: string, collectionId: string | null) => Promise<boolean>;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // Waypoint id whose search box is open for re-pointing, or null.
  const [editing, setEditing] = useState<number | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateFailed, setLocateFailed] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  // The mode-dependent toolbar's fold, and the category browser one of its
  // buttons opens. Both live here rather than in their own components so the
  // toolbar can own what it shows (ROADMAP: "an intentional toolbar").
  const [moreOpen, setMoreOpen] = useState(false);
  const [alongOpen, setAlongOpen] = useState(false);
  const [saveName, setSaveName] = useState('Planned route');
  const [saveCollection, setSaveCollection] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // On the phone layout this panel is a draggable bottom sheet; swiping it down
  // past its peek closes the planner, the same as the ✕. Inert on desktop.
  const sheet = useBottomSheet({ onDismiss: route.stop, initial: 'half' });
  const geocode = useGeocode(getBias);
  const path = route.paths?.[route.selectedPath];
  const surfaces = useMemo(
    () => routeSurfaceBreakdown(path?.enrichment, path?.distanceM ?? 0),
    [path],
  );
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

  // What the driving plan is actually being costed for. Read from the merged
  // preferences rather than the setting, so the chip can only ever say what was
  // sent to the engine.
  const vehicleLabel = vehicleChipLabel(route.profile, route.preferences.vehicle);

  const stops = route.waypoints;
  // Which end the add-a-stop box fills: the first stop is the start, anything
  // after it extends the route, which in transit mode means the destination.
  const nextRole = stops.length === 0 ? 'start' : 'destination';

  // A stop that disappears (cleared, removed, reversed away) must not leave an
  // orphaned editor bound to an id that no longer exists.
  useEffect(() => {
    if (editing !== null && !stops.some((w) => w.id === editing)) setEditing(null);
  }, [editing, stops]);

  // A cleared or shortened plan closes the stops browser. Without this, a fresh
  // plan re-opened it the moment it reached two stops — and firing an explore
  // request nobody asked for is worse than a panel that has to be re-opened.
  useEffect(() => {
    if (stops.length < 2) setAlongOpen(false);
  }, [stops.length]);

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
  useEffect(() => setSaved(false), [path]);

  const saveRoute = async () => {
    if (!path || !saveName.trim()) return;
    setSaving(true);
    const ok = await onSaveTrack(
      routePathToTrackData(path, saveName.trim()),
      saveName.trim(),
      saveCollection || null,
    );
    setSaving(false);
    setSaved(ok);
    if (ok) setSaveOpen(false);
  };

  /**
   * Whether each secondary action can currently act. Placement is the shared
   * descriptor's job (`routeActionsFor`); existence stays here, because it is
   * read off this panel's own state. An action that cannot act is absent from
   * both the visible row and the fold — never greyed out, and never a dead
   * entry behind "More".
   */
  const actionAvailable: Record<RouteActionKey, boolean> = {
    // Every one of these needs a computed path to act on, which a timetable
    // never produces: a journey is legs and times, not a track.
    alongRoute: Boolean(path) && !transitMode && !route.roundTrip && stops.length >= 2,
    saveTrack: Boolean(path) && !transitMode,
    exportGpx: Boolean(path) && !transitMode,
    // Reverse works in transit mode too — swapping the ends is the commonest
    // thing anyone does to a journey ("now get me home"), and unlike Optimize
    // it means something to a timetable, which ignores via points entirely.
    reverse: !route.roundTrip && stops.length >= 2,
    optimize: !transitMode && !route.roundTrip && stops.length >= 4,
    clear: stops.length > 0,
    share: stops.length > 0,
  };
  const toolbar = routeActionsFor(route.profile);
  const primaryActions = toolbar.primary.filter((action) => actionAvailable[action.key]);
  const moreActions = toolbar.more.filter((action) => actionAvailable[action.key]);

  const renderAction = (action: RouteActionInfo) => {
    switch (action.key) {
      case 'alongRoute':
        return (
          <button
            key={action.key}
            type="button"
            aria-expanded={alongOpen}
            onClick={() => setAlongOpen((open) => !open)}
          >
            {action.label}
          </button>
        );
      case 'saveTrack':
        return (
          <button
            key={action.key}
            type="button"
            onClick={() => {
              setSaved(false);
              setSaveOpen((open) => !open);
            }}
          >
            {saved ? 'Saved as track' : action.label}
          </button>
        );
      case 'exportGpx':
        return (
          <button key={action.key} type="button" onClick={exportGpx}>
            {action.label}
          </button>
        );
      case 'reverse':
        return (
          <button key={action.key} type="button" onClick={route.reverse}>
            {action.label}
          </button>
        );
      case 'optimize':
        return (
          <button
            key={action.key}
            type="button"
            onClick={route.optimize}
            title="Reorder intermediate stops for a shorter tour"
          >
            {action.label}
          </button>
        );
      case 'clear':
        return (
          <button key={action.key} type="button" onClick={route.clear}>
            {action.label}
          </button>
        );
      case 'share':
        return (
          <button
            key={action.key}
            type="button"
            onClick={copyLink}
            title="Copy a link that reopens this plan"
          >
            {copied ? 'Link copied' : action.label}
          </button>
        );
    }
  };

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

        {/* One row of chips for everything that shapes the route. It replaced a
          "Customize <profile>" disclosure, a full-width follow-position button
          and a round-trip row of its own (ROADMAP: "Declutter the navigation
          picker") — three stacked bands of chrome above the stops, of which the
          disclosure *hid* the controls that change the route and the button was
          not about routing at all. Chips state the constraint they impose, so
          the row reads as the plan's terms rather than as a settings list. */}
        {!transitMode && (
          <div className="route-options" role="group" aria-label="Route options">
            {routeOptionsFor(route.profile).map((option) => (
              <button
                key={option.key}
                type="button"
                className="route-chip"
                role="switch"
                aria-checked={route.preferences[option.key]}
                title={option.label}
                onClick={() => route.setPreference(option.key, !route.preferences[option.key])}
              >
                {option.chipLabel}
              </button>
            ))}
            <button
              type="button"
              className="route-chip"
              role="switch"
              aria-checked={route.roundTrip}
              onClick={() => route.setRoundTrip(!route.roundTrip)}
            >
              Round trip
            </button>
            {/* Driving only, and the whole reason this row exists: a described
              vehicle changes both the road chosen and the arrival time, but it
              lives in Settings → Navigation, where a motorhome driver planning
              a trip has no reason to look. Lit and carrying the height once one
              is set, so the plan says what it was built for; unlit and named
              when it is not, so the capability is discoverable from the panel
              that uses it. Reads `preferences.vehicle` — what will actually be
              sent to the engine — never the raw setting. */}
            {route.profile === 'car' && (
              <button
                type="button"
                className={vehicleLabel ? 'route-chip route-chip-set' : 'route-chip'}
                onClick={onOpenVehicleSettings}
                title="Height, width and cruising speed — opens Settings → Navigation"
                aria-label={
                  vehicleLabel
                    ? `Vehicle: ${vehicleLabel}. Change in settings`
                    : 'Vehicle: describe a taller or slower one'
                }
              >
                <CarIcon size={14} /> {vehicleLabel ?? 'Vehicle'}
              </button>
            )}
          </div>
        )}

        {/* The loop's length and direction, once there is a loop to describe.
          Folded away with the switch rather than sitting inert beside it. */}
        {route.roundTrip && !transitMode && (
          <div className="route-roundtrip">
            <input
              type="number"
              min={1}
              max={500}
              value={route.roundTripKm}
              onChange={(e) => route.setRoundTripKm(Math.max(Number(e.target.value) || 1, 1))}
              aria-label="Round trip distance in kilometers"
            />
            <span>km</span>
            <select
              value={route.roundTripDirection}
              onChange={(event) =>
                route.setRoundTripDirection(
                  event.currentTarget.value as typeof route.roundTripDirection,
                )
              }
              aria-label="Round trip direction"
            >
              <option value="either">Either direction</option>
              <option value="clockwise">Clockwise</option>
              <option value="counterclockwise">Counterclockwise</option>
            </select>
            <button type="button" onClick={route.newLoop} disabled={route.waypoints.length === 0}>
              New loop
            </button>
          </div>
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
                  draggable={!isEditing}
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
                        transit={transitMode}
                        onPick={(position, name, transitStopId) => {
                          route.replaceWaypoint(w.id, position, name, transitStopId);
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

        {/* The always-empty next stop, sitting at the end of the list where the
          stop it adds will appear — fill it and it clears itself for the one
          after, so a five-stop trip is typed in one pass. It used to sit above
          the list, which read as a search box for the plan rather than as its
          next row. While a stop is being re-pointed it stands down: two open
          search boxes with two different meanings is how you end up appending a
          stop you meant to replace. */}
        {editing === null && (
          <StopSearch
            places={places}
            geocode={geocode}
            placeholder={
              nextRole === 'start'
                ? 'Start: address or saved place…'
                : // A loop comes home to its start, so nothing entered after the
                  // first point is a destination — it is somewhere to go by way of.
                  route.roundTrip || stops.length >= 2
                  ? 'Add a stop…'
                  : 'Destination: address or saved place…'
            }
            ariaLabel={
              nextRole === 'start'
                ? 'Search for a start'
                : route.roundTrip
                  ? 'Search for a stop on the loop'
                  : 'Search for a destination'
            }
            transit={transitMode}
            onPick={(position, name, transitStopId) =>
              route.addWaypoint(position, name, transitStopId)
            }
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
        {!route.roundTrip && route.waypoints.length === 1 && (
          <p className="route-hint">Click the map to add the destination.</p>
        )}
        {/* Via points and route-line clicks belong to the road profiles: a
          timetable cannot honour either, so the advice would be a lie here.
          A loop's drawn line runs through synthesized shaping points as well as
          the traveller's own, so an insert index read off it would land in the
          wrong slot — clicking the line is off there, and the hint says only
          what a loop can actually do. */}
        {!transitMode && route.waypoints.length >= 2 && (
          <p className="route-hint route-hint-quiet">
            Drag to reorder · drag a marker to move it
            {route.roundTrip ? '' : ' · click the line for a via point'}
          </p>
        )}

        {!transitMode && route.error && <div className="route-error">{route.error}</div>}

        {/* The answer, and the one thing you do with it, in the same block.
          Both used to be somewhere else: "Start navigation" was a full-width
          accent slab directly under the stops, and the distance/time/ETA the
          panel was opened for sat last — under the slab, under six same-weight
          secondary buttons, off the bottom of a phone sheet. So the loudest
          thing on screen was the commitment and the quietest was what you were
          committing to. Now the trip time leads, the rest of the numbers read
          under it, and Start is a button beside them rather than a band across
          them. It is still the only accent-filled control in the panel.

          `route-stats` wraps the whole result — figures, ferry and surface —
          because those three are one readout of one path. */}
        {!transitMode && (path || destination) && (
          <div className="route-stats">
            <div className="route-summary">
              <div className="route-summary-figures">
                {path ? (
                  <>
                    <strong className="route-summary-time">{fmtDuration(path.timeMs)}</strong>
                    <span className="route-summary-detail">
                      {fmtKm(path.distanceM)} · ETA {fmtEta(path.timeMs)}
                      {/* The measured part of that time, named rather than
                          silently folded in — an ETA that moved for a reason
                          should say so. */}
                      {formatTrafficDelay(path.trafficDelayMs) && (
                        <span className="route-traffic-delay">
                          {' '}
                          · {formatTrafficDelay(path.trafficDelayMs)}
                        </span>
                      )}
                    </span>
                    {/* Climb gets its own line rather than a fourth clause on
                        the one above: with Start beside it the detail line has
                        about 190px, and "↗ 455 m ↘ 455 m" is what pushed it
                        into a wrap that read as a broken layout. The profile
                        adapter fills terrain heights where coverage exists;
                        0/0 still means "unknown" elsewhere. */}
                    {(path.ascentM > 0 || path.descentM > 0) && (
                      <span className="route-summary-detail">
                        ↗ {Math.round(path.ascentM)} m ↘ {Math.round(path.descentM)} m
                      </span>
                    )}
                  </>
                ) : (
                  <span className="route-summary-detail">
                    {route.loading
                      ? 'Routing…'
                      : // The place-card hand-off lands here with the destination
                        // alone, and no route can be drawn until there is a start.
                        // Say what Start will do rather than leaving the button
                        // beside an empty readout.
                        stops.length === 1
                        ? 'Guidance starts from where you are.'
                        : null}
                  </span>
                )}
              </div>
              {/* This panel is the only travel-mode picker, so guidance starts
                here. Transit has no turn-by-turn — it shows the journey board
                below instead of a button that would promise directions it
                cannot give. The visible word is short because the block it sits
                in already says what is being started; the accessible name keeps
                the full sentence. */}
              {destination && (
                <button
                  type="button"
                  className="route-navigate"
                  aria-label="Start navigation"
                  // Guidance replaces the planned origin with the live position,
                  // so the stops between first and last ride along as via points.
                  onClick={() =>
                    onNavigate(
                      destination,
                      route.waypoints.slice(1, -1).map((w) => w.pos),
                    )
                  }
                >
                  Start
                </button>
              )}
            </div>
            {/* A ferry is timetabled and, on foot or by bike, the one stretch you
              cannot simply set off along. Non-car routes avoid ferries where a
              land route exists, so if one survived, it is the only way across
              and the traveller needs to know before setting out. */}
            {path?.hasFerry && (
              <div className="route-ferry-note">
                ⛴️ This route crosses by ferry
                {route.profile === 'car'
                  ? '.'
                  : ' — there is no land route. Check sailing times, or try public transport.'}
              </div>
            )}
            {surfaces.length > 0 && (
              <div className="surface-breakdown" aria-label="Route surfaces">
                <strong>Surface</strong>
                {surfaces.map((surface) => (
                  <span key={surface.label}>
                    {surface.label} {surface.percent}%
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Beside the result, not below the toolbar: an alternative is a choice
          about the answer, so it belongs where the answer is read. */}
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

        {/* One toolbar per travel mode (`routeActionsFor`, @atlas/routing), not
          the same six buttons at one weight for everyone: driving leads with
          the stops along the way, walking with the track it will keep and
          carry, and the rest fold under "More" — one tap away, never gone.
          Availability still decides existence: an action that cannot act is
          absent from both rows rather than folded into a menu of dead entries,
          so with no stops the whole toolbar is gone. */}
        {(primaryActions.length > 0 || moreActions.length > 0) && (
          <div className="route-actions">
            {primaryActions.map(renderAction)}
            {moreActions.length > 0 && (
              <button
                type="button"
                className="route-more"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((open) => !open)}
              >
                More <span aria-hidden="true">{moreOpen ? '▴' : '▾'}</span>
              </button>
            )}
          </div>
        )}
        {moreOpen && moreActions.length > 0 && (
          <div className="route-actions route-actions-more">{moreActions.map(renderAction)}</div>
        )}

        {/* The category browser the toolbar's "Stops along route" opens: fuel,
          charging and rest areas on a drive, cafés and viewpoints on foot. */}
        {alongOpen && path && !route.roundTrip && !transitMode && route.waypoints.length >= 2 && (
          <AlongRouteStops
            route={route}
            path={path}
            fetchNearby={fetchNearby}
            onPicked={() => setAlongOpen(false)}
          />
        )}

        {saveOpen && path && !transitMode && (
          <div className="route-save-track">
            <label>
              Track name
              <input
                value={saveName}
                onChange={(event) => setSaveName(event.currentTarget.value)}
                autoFocus
              />
            </label>
            <label>
              Folder
              <select
                value={saveCollection}
                onChange={(event) => setSaveCollection(event.currentTarget.value)}
              >
                <option value="">No folder</option>
                {[...collections]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
              </select>
            </label>
            <div>
              <button
                type="button"
                className="primary"
                disabled={saving || !saveName.trim()}
                onClick={() => void saveRoute()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={() => setSaveOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {transitMode && route.waypoints.length > 2 && (
          <p className="route-hint">
            Public transport plans between the first and last stop; via points are ignored.
          </p>
        )}
        {transitMode && (
          <TransitResults transit={transit} onStartGuidance={onStartTransitGuidance} />
        )}
      </div>
    </div>
  );
}
