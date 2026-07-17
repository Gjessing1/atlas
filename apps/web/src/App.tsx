import {
  decodeMapHash,
  placeIsVisible,
  type LatLng,
  type MapViewState,
  type SearchResult,
  type VisibilityFolder,
} from '@atlas/core';
import { trackBounds, type TrackData } from '@atlas/gpx';
import { routePathToTrackData } from '@atlas/routing';
import type { PlaceRecord, TrackRecord } from '@atlas/storage';
import maplibregl from 'maplibre-gl';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './MapView.js';
import { useRouteLayers } from './map/useRouteLayers.js';
import { useTrackLayers } from './map/useTrackLayers.js';
import { useRoute } from './routing/useRoute.js';
import { SearchBox } from './SearchBox.js';
import { type ImportResult, useUserData } from './storage/useUserData.js';
import { useSync } from './sync/useSync.js';

// The side/overlay panels are code-split: none of them is needed for the
// initial map render, and Sidebar pulls in the GPX/KML import machinery.
const Sidebar = lazy(() => import('./Sidebar.js').then((m) => ({ default: m.Sidebar })));
const RoutePanel = lazy(() =>
  import('./routing/RoutePanel.js').then((m) => ({ default: m.RoutePanel })),
);
const ElevationProfile = lazy(() =>
  import('./ElevationProfile.js').then((m) => ({ default: m.ElevationProfile })),
);

const DEFAULT_VIEW: MapViewState = { center: { lat: 59.91, lng: 10.75 }, zoom: 5 }; // Oslo
const LAST_VIEW_SETTING = 'lastView';

// Decoded once at startup; afterwards the map keeps the hash in sync. A share
// link (hash) always wins over the persisted last view.
const hashView = decodeMapHash(window.location.hash);
const initialView = hashView ?? DEFAULT_VIEW;

export function App() {
  const [pin, setPin] = useState<LatLng | null>(initialView.pin ?? null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<{
    track: TrackRecord;
    data: TrackData;
  } | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userData = useUserData();
  const sync = useSync(userData);

  // ---- route planning ----

  const route = useRoute();
  useRouteLayers(map, route);
  // Route mode owns map clicks; MapView reads this ref to skip POI popups.
  const routeActiveRef = useRef(route.active);
  routeActiveRef.current = route.active;
  // The route elevation profile can be dismissed; it comes back per route session.
  const [routeProfileHidden, setRouteProfileHidden] = useState(false);
  useEffect(() => {
    if (route.active) setRouteProfileHidden(false);
  }, [route.active]);

  // Only draw places that are effectively visible — their own toggle on and no
  // ancestor folder hidden (@atlas/core placeIsVisible). The Sidebar still lists
  // every place so hidden ones can be shown again.
  const visiblePlaces = useMemo(() => {
    const folders = new Map<string, VisibilityFolder>(
      userData.collections.map((c) => [c.id, { parentId: c.parentId, visible: c.visible }]),
    );
    return userData.places.filter((p) => placeIsVisible(p, folders));
  }, [userData.places, userData.collections]);

  const routePath = route.active ? route.paths?.[route.selectedPath] : undefined;
  const routeTrackData = useMemo(
    () => (routePath ? routePathToTrackData(routePath, 'Planned route') : null),
    [routePath],
  );

  const getBias = useCallback((): LatLng | null => {
    const center = mapRef.current?.getCenter();
    return center ? { lat: center.lat, lng: center.lng } : null;
  }, []);

  const onSearchSelect = useCallback((result: SearchResult) => {
    setPin(result.position);
    const map = mapRef.current;
    if (map) {
      map.flyTo({ center: result.position, zoom: Math.max(map.getZoom(), 13) });
    }
  }, []);

  // ---- user data on the map ----

  const { tracks, getTrackData, setSetting, getSetting, savePlace } = userData;

  const selectTrack = useCallback(
    (id: string | null) => {
      if (id === null) {
        setSelectedTrack(null);
        return;
      }
      const track = tracks.find((t) => t.id === id);
      if (!track) return;
      void getTrackData(id).then((data) => {
        if (data) setSelectedTrack({ track, data });
      });
    },
    [tracks, getTrackData],
  );

  useTrackLayers(map, tracks, getTrackData, selectTrack);

  // Keep the selected track's metadata fresh; drop it when the track is deleted.
  useEffect(() => {
    setSelectedTrack((cur) => {
      if (!cur) return cur;
      const track = tracks.find((t) => t.id === cur.track.id);
      return track ? { ...cur, track } : null;
    });
  }, [tracks]);

  const showPlace = useCallback((place: PlaceRecord) => {
    const map = mapRef.current;
    map?.flyTo({ center: { lat: place.lat, lng: place.lng }, zoom: Math.max(map.getZoom(), 14) });
  }, []);

  const showTrack = useCallback(
    (track: TrackRecord) => {
      void getTrackData(track.id).then((data) => {
        if (!data) return;
        setSelectedTrack({ track, data });
        const bounds = trackBounds(data);
        if (bounds && mapRef.current) {
          mapRef.current.fitBounds(
            [
              [bounds.sw.lng, bounds.sw.lat],
              [bounds.ne.lng, bounds.ne.lat],
            ],
            { padding: 60, maxZoom: 15 },
          );
        }
      });
    },
    [getTrackData],
  );

  const onImported = useCallback(
    (result: ImportResult) => {
      const first = result.tracks[0];
      if (first) showTrack(first);
      else if (result.places[0]) showPlace(result.places[0]);
    },
    [showTrack, showPlace],
  );

  const onSavePin = useCallback(
    (pin: LatLng) => {
      void savePlace({
        name: `Pin ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`,
        lat: pin.lat,
        lng: pin.lng,
      });
      setSidebarOpen(true);
    },
    [savePlace],
  );

  // Elevation-profile hover → a small dot marker on the map.
  const hoverMarkerRef = useRef<maplibregl.Marker | null>(null);
  const onProfileHover = useCallback((point: LatLng | null) => {
    const map = mapRef.current;
    if (!point || !map) {
      hoverMarkerRef.current?.remove();
      return;
    }
    if (!hoverMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'track-hover-dot';
      hoverMarkerRef.current = new maplibregl.Marker({ element: el });
    }
    hoverMarkerRef.current.setLngLat(point).addTo(map);
  }, []);

  // Auto-dismiss the write-error toast; a new failure restarts the timer.
  const { writeError, clearWriteError } = userData;
  useEffect(() => {
    if (!writeError) return;
    const t = setTimeout(clearWriteError, 8000);
    return () => clearTimeout(t);
  }, [writeError, clearWriteError]);

  // Auto-save the camera; restore it on startup when the URL has no view hash.
  useEffect(() => {
    if (!map || userData.status !== 'ready') return;
    if (!hashView) {
      void getSetting(LAST_VIEW_SETTING).then((raw) => {
        if (!raw) return;
        // Don't fight the user: only restore while the camera still sits at
        // the startup default. (The URL hash is no signal here — the map
        // echoes the camera into it on load.)
        const center = map.getCenter();
        const untouched =
          Math.abs(map.getZoom() - initialView.zoom) < 0.01 &&
          Math.abs(center.lat - initialView.center.lat) < 1e-6 &&
          Math.abs(center.lng - initialView.center.lng) < 1e-6;
        if (!untouched) return;
        try {
          const view = JSON.parse(raw) as MapViewState;
          map.jumpTo({ center: view.center, zoom: view.zoom });
        } catch {
          // Ignore a corrupt setting; the default view is fine.
        }
      });
    }
    const save = () => {
      const center = map.getCenter();
      setSetting(
        LAST_VIEW_SETTING,
        JSON.stringify({ center: { lat: center.lat, lng: center.lng }, zoom: map.getZoom() }),
      );
    };
    map.on('moveend', save);
    return () => {
      map.off('moveend', save);
    };
  }, [map, userData.status, getSetting, setSetting]);

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <MapView
        initialView={initialView}
        pin={pin}
        places={visiblePlaces}
        onPinChange={setPin}
        onSavePin={onSavePin}
        onMapReady={(m) => {
          mapRef.current = m;
          setMap(m);
        }}
        suppressPoiClicks={routeActiveRef}
      />
      <div className="topbar">
        <SearchBox onSelect={onSearchSelect} getBias={getBias} />
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          ★ Saved
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-pressed={route.active}
          onClick={() => {
            // Starting from a dropped pin routes "from here".
            if (route.active) route.stop();
            else route.start(pin ?? undefined);
          }}
        >
          ⇄ Route
        </button>
      </div>
      {writeError && (
        <div className="write-error-toast" role="alert">
          <span>{writeError} — the change was not saved.</span>
          <button type="button" onClick={clearWriteError} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      <Suspense fallback={null}>
        {route.active && <RoutePanel route={route} places={userData.places} getBias={getBias} />}
        {sidebarOpen && (
          <Sidebar
            data={userData}
            sync={sync}
            selectedTrackId={selectedTrack?.track.id ?? null}
            onShowPlace={showPlace}
            onShowTrack={showTrack}
            onImported={onImported}
            onClose={() => setSidebarOpen(false)}
          />
        )}
        {/* Valhalla routes carry no elevation data — skip the profile rather
            than draw an empty chart. */}
        {routePath &&
        routeTrackData &&
        !routeProfileHidden &&
        routePath.points.some((p) => p.ele !== undefined) ? (
          <ElevationProfile
            title="Planned route"
            stats={{
              distanceM: routePath.distanceM,
              ascentM: routePath.ascentM,
              descentM: routePath.descentM,
              durationMs: routePath.timeMs,
            }}
            data={routeTrackData}
            onClose={() => setRouteProfileHidden(true)}
            onHoverPoint={onProfileHover}
          />
        ) : (
          selectedTrack &&
          !route.active && (
            <ElevationProfile
              title={selectedTrack.track.name}
              stats={selectedTrack.track.stats}
              data={selectedTrack.data}
              onClose={() => selectTrack(null)}
              onHoverPoint={onProfileHover}
            />
          )
        )}
      </Suspense>
    </div>
  );
}
