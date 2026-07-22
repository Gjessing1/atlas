import {
  decodeMapHash,
  encodeMapHash,
  mapProfile,
  placeIsVisible,
  placeTargetTitle,
  savedPlaceAt,
  type ColorScheme,
  type LatLng,
  type MapViewState,
  type PlaceTarget,
  type SearchResult,
  type VisibilityFolder,
} from '@atlas/core';
import { useMapProfile, useThemeMode } from '@atlas/app-hooks';
import { trackBounds, type TrackData } from '@atlas/gpx';
import { isRoutingProfile, routePathToTrackData } from '@atlas/routing';
import type { PlaceRecord, TrackRecord } from '@atlas/storage';
import maplibregl from 'maplibre-gl';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './MapView.js';
import { RouteIcon, SettingsIcon, StarIcon, SunIcon } from './icons.js';
import { LayerQuickSwitch } from './layers/LayerQuickSwitch.js';
import { MapProfileSwitch } from './layers/MapProfileSwitch.js';
import { useLayerCatalog } from './layers/useLayerCatalog.js';
import { useNavLayers } from './map/useNavLayers.js';
import { useOverlayIdentify, useOverlayLabels, useOverlayLayers } from './map/useOverlayLayers.js';
import { useRouteLayers } from './map/useRouteLayers.js';
import { useTransitLayers } from './map/useTransitLayers.js';
import { useShareHash } from './map/useShareHash.js';
import { useTrackLayers } from './map/useTrackLayers.js';
import { NavBanner } from './nav/NavBanner.js';
import { RoutePreview } from './nav/RoutePreview.js';
import { useTunnelDim } from './nav/useTunnelDim.js';
import { useWebNavigation } from './nav/useWebNavigation.js';
import { reverseGeocode } from './routing/reverseGeocode.js';
import { useRoute } from './routing/useRoute.js';
import { useTransitPlan } from './routing/useTransit.js';
import { planFromHash, useRoutePlanPersistence } from './routing/useRoutePlanPersistence.js';
import { PlaceCard } from './place/PlaceCard.js';
import { SearchBox } from './SearchBox.js';
import { type ImportResult, useUserData } from './storage/useUserData.js';
import { useSync } from './sync/useSync.js';
import { useWeather } from './weather/useWeather.js';

// The side/overlay panels are code-split: none of them is needed for the
// initial map render, and Sidebar pulls in the GPX/KML import machinery.
const Sidebar = lazy(() => import('./Sidebar.js').then((m) => ({ default: m.Sidebar })));
const RoutePanel = lazy(() =>
  import('./routing/RoutePanel.js').then((m) => ({ default: m.RoutePanel })),
);
const ElevationProfile = lazy(() =>
  import('./ElevationProfile.js').then((m) => ({ default: m.ElevationProfile })),
);
const WeatherPanel = lazy(() =>
  import('./weather/WeatherPanel.js').then((m) => ({ default: m.WeatherPanel })),
);
const SettingsPanel = lazy(() =>
  import('./settings/SettingsPanel.js').then((m) => ({ default: m.SettingsPanel })),
);

const DEFAULT_VIEW: MapViewState = { center: { lat: 59.91, lng: 10.75 }, zoom: 5 }; // Oslo
const LAST_VIEW_SETTING = 'lastView';
// Nav preferences are device-local (`local.` keys never sync).
const NAV_MUTED_SETTING = 'local.nav.muted';
const NAV_FOLLOW_SETTING = 'local.nav.follow';

// Decoded once at startup; afterwards the map keeps the hash in sync. A share
// link (hash) always wins over the persisted last view.
const hashView = decodeMapHash(window.location.hash);
const initialView = hashView ?? DEFAULT_VIEW;
// A plan carried by the link the user opened; restored once storage is ready.
const linkedPlan = hashView?.route ? planFromHash(hashView.route) : null;

function useSystemColorScheme(): ColorScheme {
  const query = '(prefers-color-scheme: dark)';
  const [scheme, setScheme] = useState<ColorScheme>(() =>
    window.matchMedia(query).matches ? 'dark' : 'light',
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setScheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);
  return scheme;
}

export function App() {
  const [pin, setPin] = useState<LatLng | null>(initialView.pin ?? null);
  // The spot the place card is describing — a pin, saved place, POI or search
  // hit, all normalised to one PlaceTarget. Null = no card.
  const [target, setTarget] = useState<PlaceTarget | null>(
    initialView.pin ? { source: 'pin', position: initialView.pin } : null,
  );
  // Only set once the user asks to be located; the card shows distances from it.
  const [userAt, setUserAt] = useState<LatLng | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Weather is targeted at a point (pin / map centre); null = panel closed.
  const [weatherTarget, setWeatherTarget] = useState<LatLng | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<{
    track: TrackRecord;
    data: TrackData;
  } | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userData = useUserData();
  const sync = useSync(userData);
  const appearance = useThemeMode(userData, useSystemColorScheme());
  useEffect(() => {
    document.documentElement.dataset['theme'] = appearance.colorScheme;
    document.documentElement.style.colorScheme = appearance.colorScheme;
  }, [appearance.colorScheme]);

  // ---- route planning ----

  const route = useRoute();
  // Public transport for the same two endpoints — a travel mode beside the road
  // profiles. The panel lists the journeys; the map draws the selected one, and
  // the road line stands down while it does.
  const transit = useTransitPlan(route);
  useRouteLayers(map, route, transit.enabled);
  useTransitLayers(map, transit.enabled ? transit.trip : null);
  // The plan survives a reload, and rides along in the shareable URL hash.
  useRoutePlanPersistence(route, userData, linkedPlan);
  useShareHash(map, pin, route.plan);

  // Route mode owns map clicks; identify + POI popups read this ref to yield.
  const routeActiveRef = useRef(route.active);
  routeActiveRef.current = route.active;

  // ---- overlay layers (catalog + raster rendering + tap-to-identify) ----

  const profiles = useMapProfile(userData);
  const layers = useLayerCatalog(userData, profiles.profile.id);
  // Picking an activity also moves the planner's travel mode, when that
  // activity has one (Explore and Ski express no routing opinion). The planner
  // still offers every mode, so this is a default and not a restriction.
  const onPickProfile = useCallback(
    (id: string) => {
      profiles.setProfile(id);
      const routing = mapProfile(id).routing;
      if (routing !== null && isRoutingProfile(routing)) route.setProfile(routing);
    },
    [profiles, route],
  );
  useOverlayLayers(map, layers.overlays);
  useOverlayLabels(map, layers.overlays);
  useOverlayIdentify(map, layers.overlays, routeActiveRef);
  // Rounded zoom for the panel's live "zoom in to z14+" hints.
  const [mapZoom, setMapZoom] = useState(Math.round(initialView.zoom));
  useEffect(() => {
    if (!map) return;
    const onZoom = () => setMapZoom(Math.round(map.getZoom()));
    map.on('zoomend', onZoom);
    onZoom();
    return () => {
      map.off('zoomend', onZoom);
    };
  }, [map]);

  // ---- turn-by-turn navigation ----

  const nav = useWebNavigation();
  const tunnelDim = useTunnelDim(nav.state?.fix, nav.state?.tunnel != null);
  const follow = useNavLayers(map, nav);
  const { start: startNav } = nav;
  const { stop: stopRoute } = route;
  const onNavigateToTarget = useCallback(
    (dest: LatLng) => {
      setPin(null);
      setTarget(null);
      stopRoute(); // navigation owns the map now; a plan would fight it
      void startNav(dest);
    },
    [startNav, stopRoute],
  );
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

  // ---- weather & conditions ----

  const weather = useWeather(weatherTarget);
  const toggleWeather = useCallback(() => {
    // Open onto the dropped pin if there is one, else the current map centre.
    setWeatherTarget((cur) => (cur ? null : (pin ?? getBias() ?? DEFAULT_VIEW.center)));
  }, [pin, getBias]);
  const retargetWeather = useCallback(() => {
    setWeatherTarget(getBias() ?? DEFAULT_VIEW.center);
  }, [getBias]);

  // A picked search result becomes a pin plus the same card a POI tap opens.
  const onSearchSelect = useCallback((result: SearchResult) => {
    setPin(result.position);
    setTarget({
      source: 'search',
      position: result.position,
      name: result.name,
      category: result.label || undefined,
    });
    const map = mapRef.current;
    if (map) {
      map.flyTo({ center: result.position, zoom: Math.max(map.getZoom(), 13) });
    }
  }, []);

  // Dropping, dragging or removing the pin keeps the card in step with it.
  const onPinChange = useCallback((next: LatLng | null) => {
    setPin(next);
    setTarget(next ? { source: 'pin', position: next } : null);
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

  // ---- place card actions ----

  // The saved place *at* the card's spot, if any — so a POI the user already
  // saved offers "★ Saved" rather than a second, duplicate entry.
  const savedAtTarget = useMemo(
    () => (target ? savedPlaceAt(userData.places, target.position) : undefined),
    [target, userData.places],
  );

  const onSaveTarget = useCallback(() => {
    if (!target) return;
    void savePlace({
      name: placeTargetTitle(target),
      lat: target.position.lat,
      lng: target.position.lng,
    });
    // No sidebar pop-open: the button flipping to "★ Saved" is the confirmation,
    // and the sidebar would slide in over the card the user is still reading.
  }, [target, savePlace]);

  const onAddStop = useCallback(() => {
    if (!target) return;
    route.addWaypoint(target.position, target.name);
    setTarget(null);
  }, [target, route]);

  // A link to this exact spot, independent of where the camera happens to sit
  // (the address bar's hash follows the map, which is not what "share this
  // place" means).
  const onShareTarget = useCallback(() => {
    if (!target) return;
    const zoom = Math.max(mapRef.current?.getZoom() ?? 14, 14);
    const hash = encodeMapHash({ center: target.position, zoom, pin: target.position });
    void navigator.clipboard.writeText(
      `${window.location.origin}${window.location.pathname}${hash}`,
    );
  }, [target]);

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

  // The undo window for a delete. Long enough to notice a mistake, short enough
  // that the toast is not permanent chrome; a newer delete replaces the offer.
  const { undoable, clearUndoable } = userData;
  useEffect(() => {
    if (!undoable) return;
    const t = setTimeout(clearUndoable, 10000);
    return () => clearTimeout(t);
  }, [undoable, clearUndoable]);

  // Nav preferences survive across trips (device-local — `local.` never syncs).
  const { setMuted } = nav;
  const { setFollowMode } = follow;
  useEffect(() => {
    if (userData.status !== 'ready') return;
    void getSetting(NAV_MUTED_SETTING).then((raw) => {
      if (raw != null) setMuted(raw === 'true');
    });
    void getSetting(NAV_FOLLOW_SETTING).then((raw) => {
      if (raw === 'north' || raw === 'course') setFollowMode(raw);
    });
  }, [userData.status, getSetting, setMuted, setFollowMode]);
  const onToggleFollowMode = useCallback(() => {
    const next = follow.followMode === 'course' ? 'north' : 'course';
    setFollowMode(next);
    setSetting(NAV_FOLLOW_SETTING, next);
  }, [follow.followMode, setFollowMode, setSetting]);
  // Mute toggles through nav.toggleMute (banner button); persist the result.
  const prevMutedRef = useRef(nav.muted);
  useEffect(() => {
    if (prevMutedRef.current !== nav.muted) {
      prevMutedRef.current = nav.muted;
      if (userData.status === 'ready') setSetting(NAV_MUTED_SETTING, String(nav.muted));
    }
  }, [nav.muted, userData.status, setSetting]);

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
        onPinChange={onPinChange}
        onSelect={setTarget}
        onUserLocation={setUserAt}
        onMapReady={(m) => {
          mapRef.current = m;
          setMap(m);
        }}
        suppressPoiClicks={routeActiveRef}
        colorScheme={appearance.colorScheme}
        profile={profiles.profile.id}
      />
      {/* Sustained dead reckoning ≈ inside a tunnel: dim the map (the UI on
          top stays bright) until live GPS returns. */}
      <div className={`tunnel-dim${tunnelDim ? ' tunnel-dim-on' : ''}`} />
      <NavBanner
        nav={nav}
        followPaused={follow.followPaused}
        onResumeFollow={follow.resumeFollow}
        followMode={follow.followMode}
        onToggleFollowMode={onToggleFollowMode}
        overview={follow.overview}
        onToggleOverview={follow.toggleOverview}
      />
      <RoutePreview nav={nav} />
      <div
        className={`topbar${nav.phase !== 'idle' && nav.phase !== 'preview' ? ' topbar-nav-hidden' : ''}`}
      >
        <SearchBox onSelect={onSearchSelect} getBias={getBias} />
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Collections"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <StarIcon size={18} />
          <span className="topbar-label">Collections</span>
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Route"
          aria-pressed={route.active}
          onClick={() => {
            // Starting from a dropped pin routes "from here".
            if (route.active) {
              route.stop();
              return;
            }
            const seeded = route.start(pin ?? undefined);
            // Label that first stop like any other hand-placed one, so the plan
            // doesn't open with a row of decimals.
            if (seeded !== null && pin) {
              const at = pin;
              void reverseGeocode(at).then((name) => {
                if (name) route.nameWaypoint(seeded, name, at);
              });
            }
          }}
        >
          <RouteIcon size={18} />
          <span className="topbar-label">Route</span>
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Weather"
          aria-pressed={weatherTarget !== null}
          onClick={toggleWeather}
        >
          <SunIcon size={18} />
          <span className="topbar-label">Weather</span>
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Settings"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <SettingsIcon size={18} />
          <span className="topbar-label">Settings</span>
        </button>
      </div>
      {/* Overlay switcher, hidden mid-trip like the other map chrome — the
          driving view stays the banner plus the map. */}
      {nav.phase === 'idle' && (
        <MapProfileSwitch active={profiles.profile.id} onPick={onPickProfile} />
      )}
      {nav.phase === 'idle' && <LayerQuickSwitch layers={layers} mapZoom={mapZoom} />}
      {/* One card for pins, saved places, POIs and search hits. Hidden mid-trip
          along with the rest of the map chrome. */}
      {target && nav.phase === 'idle' && (
        <PlaceCard
          target={target}
          saved={savedAtTarget}
          saveEnabled={userData.status === 'ready'}
          userAt={userAt}
          routeActive={route.active}
          shifted={sidebarOpen}
          onNavigate={() => onNavigateToTarget(target.position)}
          onSave={onSaveTarget}
          onShowSaved={(place) => {
            setSidebarOpen(true);
            showPlace(place);
          }}
          onAddStop={onAddStop}
          onShare={onShareTarget}
          onWeather={() => setWeatherTarget(target.position)}
          onRemovePin={() => onPinChange(null)}
          onClose={() => setTarget(null)}
        />
      )}
      {writeError && (
        <div className="write-error-toast" role="alert">
          <span>{writeError} — the change was not saved.</span>
          <button type="button" onClick={clearWriteError} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {undoable && (
        <div className="undo-toast" role="status">
          <span>{undoable.message}</span>
          <button type="button" className="undo-action" onClick={() => void undoable.undo()}>
            Undo
          </button>
          <button type="button" onClick={clearUndoable} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      <Suspense fallback={null}>
        {weatherTarget && (
          <WeatherPanel
            target={weatherTarget}
            weather={weather}
            settings={userData}
            onRetarget={retargetWeather}
            onClose={() => setWeatherTarget(null)}
          />
        )}
        {route.active && (
          <RoutePanel route={route} transit={transit} places={userData.places} getBias={getBias} />
        )}
        {sidebarOpen && (
          <Sidebar
            data={userData}
            layers={layers}
            mapZoom={mapZoom}
            selectedTrackId={selectedTrack?.track.id ?? null}
            onShowPlace={showPlace}
            onShowTrack={showTrack}
            onImported={onImported}
            onClose={() => setSidebarOpen(false)}
          />
        )}
        {settingsOpen && (
          <SettingsPanel
            sync={sync}
            appearance={appearance}
            onClose={() => setSettingsOpen(false)}
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
