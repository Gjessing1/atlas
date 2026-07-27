import {
  atlasShareUrl,
  decodeMapHash,
  fmtDistanceM,
  haversineM,
  mapProfile,
  placeIsVisible,
  placeTargetTitle,
  savedPlaceAt,
  shareMessage,
  type ColorScheme,
  type LatLng,
  type MapViewState,
  type NearbyPlaceArticle,
  type PlaceTarget,
  type SearchResult,
  type VisibilityFolder,
} from '@atlas/core';
import {
  useMapProfile,
  useMapProfilePreferences,
  useMapStyleEditor,
  useNavAddStop,
  useNavPrefs,
  useNavResume,
  usePotential,
  usePotentialExplain,
  useThemeMode,
  type FetchNearbyFn,
  type PotentialView,
} from '@atlas/app-hooks';
import { trackBounds, type TrackData } from '@atlas/gpx';
import { isRoutingProfile, routePathToTrackData } from '@atlas/routing';
import type { PlaceRecord, TrackRecord } from '@atlas/storage';
import maplibregl from 'maplibre-gl';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './MapView.js';
import { MeasureTool } from './MeasureTool.js';
import {
  CompassIcon,
  CrosshairIcon,
  RouteIcon,
  RulerIcon,
  SettingsIcon,
  StarIcon,
  SunIcon,
} from './icons.js';
import { ExplorePanel, type ExploreArea } from './explore/ExplorePanel.js';
import { LayerQuickSwitch } from './layers/LayerQuickSwitch.js';
import { PotentialPill } from './potential/PotentialPill.js';
import { MapProfileSwitch } from './layers/MapProfileSwitch.js';
import { useLayerCatalog } from './layers/useLayerCatalog.js';
import { useCameraPersistence } from './map/useCameraPersistence.js';
import { useNavLayers } from './map/useNavLayers.js';
import { useOverlayIdentify, useOverlayLabels, useOverlayLayers } from './map/useOverlayLayers.js';
import { useHuntingFieldsLayer } from './map/useHuntingFieldsLayer.js';
import { useSpeedCameraLayer } from './map/useSpeedCameraLayer.js';
import { useRouteLayers } from './map/useRouteLayers.js';
import { useTransitLayers } from './map/useTransitLayers.js';
import { useShareHash } from './map/useShareHash.js';
import { useTrackLayers } from './map/useTrackLayers.js';
import { NavAddStopPanel, NavStopTapCard } from './nav/NavAddStop.js';
import { NavBanner } from './nav/NavBanner.js';
import { RoutePreview } from './nav/RoutePreview.js';
import { useTunnelDim } from './nav/useTunnelDim.js';
import { useWebNavigation } from './nav/useWebNavigation.js';
import { getMyLocation } from './routing/geolocate.js';
import { reverseGeocode } from './routing/reverseGeocode.js';
import { useDirections } from './routing/useDirections.js';
import { useRoute } from './routing/useRoute.js';
import { useTransitPlan } from './routing/useTransit.js';
import { planFromHash, useRoutePlanPersistence } from './routing/useRoutePlanPersistence.js';
import { PlaceCard } from './place/PlaceCard.js';
import { SearchBox } from './SearchBox.js';
import { StorageBanner } from './storage/StorageBanner.js';
import { type ImportResult, useUserData } from './storage/useUserData.js';
import { useSync } from './sync/useSync.js';
import { useWeather } from './weather/useWeather.js';
import { useWeatherTarget } from './weather/useWeatherTarget.js';

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
  const [locateRequest, setLocateRequest] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<{
    track: TrackRecord;
    data: TrackData;
  } | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userData = useUserData();
  const sync = useSync(userData);
  const appearance = useThemeMode(userData, useSystemColorScheme());
  const mapStyleEditor = useMapStyleEditor(userData);
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
  // The place card's hand-off into the planner (seeds "My location" as start).
  const directions = useDirections(route);

  // The radius / measure tool (§4.7b): while open it owns map clicks.
  const [measureOpen, setMeasureOpen] = useState(false);
  const measuringRef = useRef(measureOpen);
  measuringRef.current = measureOpen;
  // Route mode or the measure tool own map clicks; identify + POI popups and
  // the route-click handler read this ref to yield.
  const blockPassiveClicksRef = useRef(false);
  blockPassiveClicksRef.current = route.active || measureOpen;

  useRouteLayers(map, route, transit.enabled, measuringRef);
  useTransitLayers(map, transit.enabled ? transit.trip : null);
  // The plan survives a reload, and rides along in the shareable URL hash.
  useRoutePlanPersistence(route, userData, linkedPlan);
  useShareHash(map, pin, route.plan);

  // ---- overlay layers (catalog + raster rendering + tap-to-identify) ----

  const profiles = useMapProfile(userData);
  const profilePreferences = useMapProfilePreferences(userData);
  const layers = useLayerCatalog(
    userData,
    profiles.profile.id,
    profilePreferences.preferredLayers(profiles.profile.id),
    profilePreferences.customizedLayers(profiles.profile.id),
  );
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
  // Rounded zoom for the panel's live "zoom in to z14+" hints, and the viewport
  // the derive service is asked to prepare (see usePotential).
  const [mapZoom, setMapZoom] = useState(Math.round(initialView.zoom));
  const [mapViewport, setMapViewport] = useState<PotentialView | null>(null);
  useEffect(() => {
    if (!map) return;
    const onMove = () => {
      setMapZoom(Math.round(map.getZoom()));
      const b = map.getBounds();
      setMapViewport({
        bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
        zoom: map.getZoom(),
      });
    };
    map.on('moveend', onMove);
    onMove();
    return () => {
      map.off('moveend', onMove);
    };
  }, [map]);

  // Derived potential surfaces (§N5): queue the cells under the viewport and
  // say what is happening while they build. `readyKey` rides into the raster
  // source id below so a cell that lands appears without a pan.
  const potential = usePotential(
    '',
    layers.derived,
    mapViewport,
    layers.derived?.meta.derived?.vocabulary,
  );
  const overlays = useMemo(
    () =>
      layers.overlays.map((overlay) =>
        overlay.meta.derived ? { ...overlay, variant: potential.readyKey } : overlay,
      ),
    [layers.overlays, potential.readyKey],
  );
  useOverlayLayers(map, overlays);
  useOverlayLabels(map, overlays);
  useOverlayIdentify(map, overlays, blockPassiveClicksRef);
  // "Why is this water good?" for whatever the place card is pointing at. The
  // derived layers are not identify-capable overlays — a tap on one is answered
  // with reasoning rather than upstream attributes, so it lands in the card
  // rather than in the identify popup.
  const potentialExplain = usePotentialExplain('', layers.derived, target?.position ?? null);
  const potentialTargetLabel = layers.derived?.meta.options
    ?.find((option) => option.key === 'target')
    ?.choices.find((choice) => choice.value === layers.derived?.target)?.label;
  // The drive profile's signature overlay: ATK speed cameras as map features.
  useSpeedCameraLayer(map, overlays, blockPassiveClicksRef);
  useHuntingFieldsLayer(map, overlays, blockPassiveClicksRef);

  // ---- turn-by-turn navigation ----

  const nav = useWebNavigation();
  const tunnelDim = useTunnelDim(nav.state?.fix, nav.state?.tunnel != null);
  // Category candidates from the explore endpoint, shared by the mid-drive
  // "add a stop" panel (what is still ahead) and the planner's "stops along
  // route" browse (the whole route). Both sets of rules live in @atlas/app-hooks.
  const fetchNearbyStops = useCallback<FetchNearbyFn>(async (category, center, radiusM, signal) => {
    const params = new URLSearchParams({
      category,
      lat: String(center.lat),
      lon: String(center.lng),
      radius: String(radiusM),
    });
    const response = await fetch(`/api/explore?${params}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()) as { results: SearchResult[] }).results;
  }, []);
  const addStop = useNavAddStop({ nav, fetchNearby: fetchNearbyStops });
  const navMoving = nav.phase === 'navigating' || nav.phase === 'rerouting';
  // Mute and map orientation survive across trips (device-local, Android parity).
  const navPrefs = useNavPrefs(userData, nav);
  // A reloaded or crashed tab loses the trip exactly as a killed Android
  // process does; the same record offers it back (device-local, never synced).
  const navResume = useNavResume(userData, {
    phase: nav.phase,
    destination: nav.destination,
    viaPoints: nav.viaPoints,
    viasPassed: nav.state?.viasPassed ?? 0,
    profile: nav.profile,
    preferences: nav.preferences,
    remainingM: nav.state?.distanceRemainingM ?? null,
    resume: nav.resume,
  });
  const follow = useNavLayers(map, nav, navPrefs.followMode);
  const { start: startNav } = nav;
  const { stop: stopRoute } = route;
  const onStartNavigation = useCallback(
    (dest: LatLng, viaPoints: LatLng[]) => {
      setPin(null);
      setTarget(null);
      const profile = route.profile;
      const preferences = route.preferences;
      stopRoute(); // navigation owns the map now; a plan would fight it
      void startNav(dest, profile, preferences, viaPoints);
    },
    [route.profile, route.preferences, startNav, stopRoute],
  );
  // "Directions" on the place card opens the planner with that point as the
  // destination (Android parity): the planner is the one travel-mode picker, so
  // public transport is offered there whether the trip started from a map pin
  // or from the Route button. Turn-by-turn then starts from the panel.
  const onDirectionsToTarget = useCallback(
    (dest: LatLng, name?: string) => {
      setPin(null);
      setTarget(null);
      directions.planTo(dest, name);
    },
    [directions],
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

  const getExploreArea = useCallback((): ExploreArea => {
    const current = mapRef.current;
    if (!current) return { center: DEFAULT_VIEW.center, radiusM: 5_000 };
    const center = current.getCenter();
    const bounds = current.getBounds();
    const northEast = bounds.getNorthEast();
    return {
      center: { lat: center.lat, lng: center.lng },
      radiusM: Math.min(
        50_000,
        Math.max(
          500,
          haversineM(
            { lat: center.lat, lng: center.lng },
            { lat: northEast.lat, lng: northEast.lng },
          ),
        ),
      ),
    };
  }, []);

  // ---- weather & conditions ----

  const weatherAt = useWeatherTarget(pin, getBias, DEFAULT_VIEW.center);
  const weatherTarget = weatherAt.target;
  const weather = useWeather(weatherTarget);

  const { followPin } = weatherAt;

  // A picked search result becomes a pin plus the same card a POI tap opens.
  const onSearchSelect = useCallback(
    (result: SearchResult) => {
      setExploreOpen(false);
      setPin(result.position);
      setTarget({
        source: 'search',
        position: result.position,
        name: result.name,
        address: result.address,
        category: result.address ? undefined : result.label || undefined,
      });
      followPin(result.position);
      const map = mapRef.current;
      if (map) {
        map.flyTo({ center: result.position, zoom: Math.max(map.getZoom(), 13) });
      }
    },
    [followPin],
  );

  // A described place picked from the card's nearby list becomes the card's
  // new subject: same treatment as a search hit (pin, card, camera), so the
  // article, its photo and the actions all follow. The card then looks the
  // place up by name, which for a title that came *from* Wikipedia matches.
  const onShowNearbyPlace = useCallback(
    (place: NearbyPlaceArticle) => {
      setPin(place.position);
      setTarget({ source: 'search', position: place.position, name: place.title });
      followPin(place.position);
      const map = mapRef.current;
      if (map) map.flyTo({ center: place.position, zoom: Math.max(map.getZoom(), 15) });
    },
    [followPin],
  );

  // Dropping, dragging or removing the pin keeps the card — and an open weather
  // panel — in step with it.
  const onPinChange = useCallback(
    (next: LatLng | null) => {
      setPin(next);
      setTarget(next ? { source: 'pin', position: next } : null);
      followPin(next);
    },
    [followPin],
  );

  // ---- user data on the map ----

  const { tracks, getTrackData, savePlace } = userData;

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
    setTarget({
      source: 'place',
      position: { lat: place.lat, lng: place.lng },
      name: place.name,
      address: place.address || undefined,
      category: place.notes.split('\n')[0] || undefined,
      placeId: place.id,
    });
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
      address: target.source === 'search' ? target.address : undefined,
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
  //
  // Where the browser has one, the OS share sheet gets it — that is what puts
  // the location into the recipient's messaging and maps apps rather than into
  // a page only Atlas users can open. The payload carries the plain coordinates
  // as well as the Atlas link, so someone on Google Maps or OsmAnd can still act
  // on it; the clipboard fallback copies the same text.
  const onShareTarget = useCallback(async (): Promise<'shared' | 'copied'> => {
    if (!target) return 'copied';
    const zoom = Math.max(mapRef.current?.getZoom() ?? 14, 14);
    const url = atlasShareUrl(
      `${window.location.origin}${window.location.pathname}`,
      target.position,
      zoom,
    );
    const text = shareMessage(target.position, target.name, url);
    if (navigator.share) {
      try {
        await navigator.share({ title: target.name ?? 'Location', text });
        return 'shared';
      } catch (err) {
        // A dismissed share sheet is not a failure — say nothing and stop.
        if (err instanceof DOMException && err.name === 'AbortError') return 'shared';
        // Anything else (no permission, unsupported payload): fall through to
        // the clipboard so the user still gets something they can paste.
      }
    }
    await navigator.clipboard.writeText(text);
    return 'copied';
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

  // Auto-save the camera; restore it on startup when the URL has no view hash.
  useCameraPersistence(map, userData, initialView, hashView === null);

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
        suppressPoiClicks={blockPassiveClicksRef}
        colorScheme={appearance.colorScheme}
        profile={profiles.profile.id}
        customStyle={mapStyleEditor.value}
        locateRequest={locateRequest}
      />
      {/* Sustained dead reckoning ≈ inside a tunnel: dim the map (the UI on
          top stays bright) until live GPS returns. */}
      <div className={`tunnel-dim${tunnelDim ? ' tunnel-dim-on' : ''}`} />
      <NavBanner
        nav={nav}
        followPaused={follow.followPaused}
        onResumeFollow={follow.resumeFollow}
        followMode={navPrefs.followMode}
        onToggleFollowMode={navPrefs.toggleFollowMode}
        overview={follow.overview}
        onToggleOverview={follow.toggleOverview}
        widgets={navPrefs.widgets}
        onToggleAddStop={() => addStop.setOpen(!addStop.open)}
        addStopOpen={addStop.open}
      />
      <NavAddStopPanel ctl={addStop} />
      {/* A tapped place mid-drive asks the only mid-drive question: stop here
          on the way? The full place card stays an idle-time surface. */}
      {target && navMoving && !addStop.open && (
        <NavStopTapCard
          title={placeTargetTitle(target)}
          onAdd={() => {
            nav.addStop(target.position);
            setPin(null);
            setTarget(null);
          }}
          onClose={() => {
            setPin(null);
            setTarget(null);
          }}
        />
      )}
      <RoutePreview nav={nav} />
      <div
        className={`topbar${nav.phase !== 'idle' && nav.phase !== 'preview' ? ' topbar-nav-hidden' : ''}`}
      >
        <SearchBox onSelect={onSearchSelect} getBias={getBias} places={userData.places} />
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Explore nearby places"
          title="Explore"
          aria-expanded={exploreOpen}
          onClick={() => {
            setExploreOpen((open) => !open);
            setTarget(null);
            setSidebarOpen(false);
            setSettingsOpen(false);
          }}
        >
          <CompassIcon size={18} />
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Collections"
          title="Collections"
          aria-expanded={sidebarOpen}
          onClick={() => {
            setExploreOpen(false);
            setSidebarOpen((open) => !open);
          }}
        >
          <StarIcon size={18} />
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Route"
          title="Route"
          aria-pressed={route.active}
          onClick={() => {
            setExploreOpen(false);
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
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Weather"
          title="Weather"
          aria-pressed={weatherTarget !== null}
          onClick={() => {
            setExploreOpen(false);
            weatherAt.toggle();
          }}
        >
          <SunIcon size={18} />
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Settings"
          title="Settings"
          aria-expanded={settingsOpen}
          onClick={() => {
            setExploreOpen(false);
            setSettingsOpen((open) => !open);
          }}
        >
          <SettingsIcon size={18} />
        </button>
      </div>
      {/* Only on an idle map: a trip in progress outranks a lost one. */}
      {nav.phase === 'idle' && navResume.resumable && (
        <div className="nav-resume" data-testid="nav-resume-card">
          <div className="nav-resume-text">
            <div className="nav-resume-title">Resume navigation?</div>
            <div className="nav-resume-detail">
              {navResume.resumable.remainingM !== null
                ? `${fmtDistanceM(navResume.resumable.remainingM)} to go`
                : 'Your last trip was interrupted'}
              {navResume.resumable.vias.length > 0
                ? ` · ${navResume.resumable.vias.length} stop${
                    navResume.resumable.vias.length === 1 ? '' : 's'
                  } left`
                : ''}
            </div>
          </div>
          <button type="button" className="nav-resume-go" onClick={navResume.resume}>
            Resume
          </button>
          <button
            type="button"
            className="nav-resume-dismiss"
            aria-label="Dismiss"
            onClick={navResume.dismiss}
          >
            ✕
          </button>
        </div>
      )}
      {/* What the derive service is doing for the water on screen. Sits under
          the search box because that is where "what is this map doing" belongs,
          and it is absent entirely once the surface is ready. */}
      {nav.phase === 'idle' && <PotentialPill prep={potential} />}
      {/* One real grid for all bottom-right map controls. It owns activity,
          layers, zoom and location so independent absolute offsets cannot
          overlap as catalogs/profile choices change. */}
      {nav.phase === 'idle' && (
        <div className="map-control-grid">
          <MapProfileSwitch
            active={profiles.profile.id}
            profiles={profilePreferences.visibleProfiles}
            onPick={onPickProfile}
          />
          <LayerQuickSwitch layers={layers} mapZoom={mapZoom} />
          <button
            type="button"
            className={`map-measure-control${measureOpen ? ' on' : ''}`}
            aria-label="Measure distance and radius"
            title="Measure"
            aria-pressed={measureOpen}
            onClick={() => setMeasureOpen((open) => !open)}
          >
            <RulerIcon size={19} />
          </button>
          <div className="map-zoom-controls" role="group" aria-label="Map view">
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => map?.zoomOut()}
            >
              −
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => map?.zoomIn()}
            >
              +
            </button>
            <button
              type="button"
              aria-label="Reset north"
              title="Reset north"
              onClick={() => map?.resetNorthPitch()}
            >
              <CompassIcon size={18} />
            </button>
          </div>
          <button
            type="button"
            className="map-locate-control"
            aria-label="Find my location"
            title="Find my location"
            onClick={() => setLocateRequest((request) => request + 1)}
          >
            <CrosshairIcon size={19} />
          </button>
        </div>
      )}
      {map && measureOpen && nav.phase === 'idle' && (
        <MeasureTool map={map} onClose={() => setMeasureOpen(false)} />
      )}
      {/* One card for pins, saved places, POIs and search hits. Hidden mid-trip
          along with the rest of the map chrome. */}
      {target && nav.phase === 'idle' && (
        <PlaceCard
          target={target}
          potential={potentialExplain.data}
          potentialTarget={potentialTargetLabel}
          saved={savedAtTarget}
          saveEnabled={userData.status === 'ready'}
          userAt={userAt}
          routeActive={route.active}
          shifted={sidebarOpen}
          onDirections={() => onDirectionsToTarget(target.position, target.name)}
          onSave={onSaveTarget}
          onShowSaved={(place) => {
            setSidebarOpen(true);
            showPlace(place);
          }}
          onAddStop={onAddStop}
          onShare={onShareTarget}
          onWeather={() => weatherAt.setTarget(target.position)}
          onRemovePin={() => onPinChange(null)}
          onShowNearby={onShowNearbyPlace}
          onClose={() => setTarget(null)}
        />
      )}
      {exploreOpen && nav.phase === 'idle' && (
        <ExplorePanel
          getArea={getExploreArea}
          onPick={(result) => {
            setExploreOpen(false);
            onSearchSelect(result);
          }}
          onClose={() => setExploreOpen(false)}
        />
      )}
      <StorageBanner storage={userData} />
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
            onRetarget={weatherAt.retarget}
            onClose={() => weatherAt.setTarget(null)}
          />
        )}
        {route.active && (
          <RoutePanel
            route={route}
            transit={transit}
            places={userData.places}
            getBias={getBias}
            getMyLocation={getMyLocation}
            locatingOrigin={directions.locatingOrigin}
            fetchNearby={fetchNearbyStops}
            onNavigate={onStartNavigation}
          />
        )}
        {sidebarOpen && (
          <Sidebar
            data={userData}
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
            storage={userData}
            appearance={appearance}
            mapStyle={mapStyleEditor}
            navPrefs={navPrefs}
            layers={layers}
            mapZoom={mapZoom}
            profilePreferences={profilePreferences}
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
