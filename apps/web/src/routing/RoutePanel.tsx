import { fmtClock, matchPlacesByName, type LatLng, type SearchResult } from '@atlas/core';
import { buildGpx } from '@atlas/gpx';
import {
  distanceToRouteM,
  pathViaLabels,
  photonBbox,
  ROUTING_PROFILES,
  routeSearchBounds,
  routePathToTrackData,
  ROUTE_SEARCH_CORRIDOR_M,
  type RoutePath,
} from '@atlas/routing';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useMemo, useState } from 'react';
import { fmtDuration, fmtKm } from '../format.js';
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

const fmtEta = (timeMs: number): string => fmtClock(Date.now() + timeMs);

/** Alternative chip: the fastest shows its duration, others their extra minutes. */
function altChipLabel(paths: RoutePath[], i: number, vias: (string | null)[]): string {
  const extraMin = Math.round((paths[i]!.timeMs - paths[0]!.timeMs) / 60000);
  const head =
    i === 0 ? fmtDuration(paths[0]!.timeMs) : extraMin < 1 ? '+<1 min' : `+${extraMin} min`;
  const via = vias[i];
  return via ? `${head} via ${via}` : head;
}

/**
 * Compact trip time for a mode chip: the duration, "—" when the mode can't
 * route this plan, or "…" while the background pass is still routing it.
 */
function modeTimeLabel(t: number | 'none' | undefined): string {
  if (t === undefined) return '…';
  if (t === 'none') return '—';
  return fmtDuration(t);
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

interface AlongRouteHit extends StopHit {
  insertIndex: number;
  extraTimeMs: number;
  extraDistanceM: number;
}

const stopHitKey = (hit: StopHit): string =>
  `${hit.position.lat.toFixed(5)}/${hit.position.lng.toFixed(5)}`;

function detourLabel(timeMs: number): string {
  if (timeMs < 60_000) return '+<1 min';
  return `+${Math.round(timeMs / 60_000)} min`;
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

/** POI/saved-place search constrained to the selected route, ranked by detour. */
function AlongRouteSearch({
  route,
  path,
  places,
}: {
  route: RoutePlanner;
  path: RoutePath;
  places: PlaceRecord[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<AlongRouteHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    const bounds = routeSearchBounds(path.points);
    if (!bounds) return;
    const controller = new AbortController();
    setHits([]);
    setLoading(true);

    const mergeEstimated = async (candidates: StopHit[]) => {
      if (candidates.length === 0) return;
      const estimates = await route.estimateDetours(
        candidates.map((hit) => hit.position),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const next: AlongRouteHit[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const estimate = estimates[i];
        if (estimate) next.push({ ...candidates[i]!, ...estimate });
      }
      setHits((previous) => {
        const merged = new Map(previous.map((hit) => [stopHitKey(hit), hit]));
        for (const hit of next) merged.set(stopHitKey(hit), hit);
        return [...merged.values()]
          .sort((a, b) => a.extraTimeMs - b.extraTimeMs || a.extraDistanceM - b.extraDistanceM)
          .slice(0, 6);
      });
    };

    // Saved places do not wait for the network: match and cost them now.
    const saved: StopHit[] = matchPlacesByName(places, q, 8)
      .map((place) => ({
        name: place.name,
        label: 'Saved place',
        position: { lat: place.lat, lng: place.lng },
        saved: true,
      }))
      .filter((hit) => distanceToRouteM(hit.position, path.points) <= ROUTE_SEARCH_CORRIDOR_M)
      .slice(0, 4);
    void mergeEstimated(saved);

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q,
          limit: '20',
          bbox: photonBbox(bounds),
        });
        const response = await fetch(`/api/search?${params}`, { signal: controller.signal });
        if (!response.ok) return;
        const savedKeys = new Set(saved.map(stopHitKey));
        const remote = ((await response.json()) as { results: SearchResult[] }).results
          .map<StopHit>((result) => ({
            name: result.name,
            label: result.label,
            position: result.position,
            saved: false,
          }))
          .filter((hit) => !savedKeys.has(stopHitKey(hit)))
          .filter((hit) => distanceToRouteM(hit.position, path.points) <= ROUTE_SEARCH_CORRIDOR_M)
          .slice(0, Math.max(6 - saved.length, 0));
        await mergeEstimated(remote);
      } catch {
        // Offline or superseded: already-matched saved places remain useful.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, path, places, route.estimateDetours]);

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
                      setQuery('');
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
        getBias={getBias}
        onPick={(position, name) => route.addWaypoint(position, name)}
      />

      {!route.roundTrip && !transitMode && path && route.waypoints.length >= 2 && (
        <AlongRouteSearch route={route} path={path} places={places} />
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
