import {
  atlasShareUrl,
  booleanSetting,
  clampExploreRadiusM,
  decodeMapHash,
  decodePanelLink,
  fmtDistanceM,
  haversineM,
  mapProfile,
  mapProfileForRouting,
  mapProfileSupportsTerrain,
  placeIsVisible,
  placeTargetTitle,
  resolveInaturOffer,
  savedPlaceAt,
  SATELLITES_ID,
  STARLINK_ID,
  type ColorScheme,
  type LatLng,
  type MapViewState,
  type NearbyPlaceArticle,
  type OverlayIdentifyGroup,
  type PlaceTarget,
  type SearchResult,
  type SettingsSectionId,
  type ShareFormat,
  type VisibilityFolder,
} from '@atlas/core';
import {
  collectionTagSuggestions,
  useMapProfile,
  useMapProfilePreferences,
  useMapStyleEditor,
  useMeasure,
  useCommute,
  useNavAddStop,
  useNavPrefs,
  useVehicleProfile,
  useBestSpots,
  useStandBoard,
  type StandBoardRow,
  useNavResume,
  planFromHash,
  useRoutePlanPersistence,
  usePotential,
  usePotentialExplain,
  usePotentialTarget,
  useLayerFilters,
  usePlanningAreas,
  useThemeMode,
  usePersistedSetting,
  useWeatherMaps,
  type CommuteFn,
  type FetchNearbyFn,
  type PotentialView,
} from '@atlas/app-hooks';
import { fetchTransitCommute, type TransitTrip } from '@atlas/transit';
import { spotPlaceDraft, type PotentialSpot } from '@atlas/potential';
import { trackBounds, type TrackData } from '@atlas/gpx';
import { isRoutingProfile, routePathToTrackData, trackToRoutePoints } from '@atlas/routing';
import { trainOf, type SatelliteOmm } from '@atlas/satellites';
import type { PlaceRecord, TrackRecord } from '@atlas/storage';
import maplibregl from 'maplibre-gl';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './MapView.js';
import { MeasureTool } from './MeasureTool.js';
import {
  CompassIcon,
  CrosshairIcon,
  NavArrowIcon,
  RouteIcon,
  RulerIcon,
  SettingsIcon,
  StarIcon,
  SunIcon,
  TrainIcon,
} from './icons.js';
import { ExplorePanel, type ExploreArea } from './explore/ExplorePanel.js';
import { LayerFilterSwitch } from './layers/LayerFilterSwitch.js';
import { LayerQuickSwitch } from './layers/LayerQuickSwitch.js';
import { PotentialPill } from './potential/PotentialPill.js';
import { PotentialTargetSwitch } from './potential/PotentialTargetSwitch.js';
import { SpotsButton, SpotsPanel } from './potential/SpotsPanel.js';
import { StandBoardButton, StandBoardPanel } from './potential/StandBoardPanel.js';
import { MapProfileSwitch } from './layers/MapProfileSwitch.js';
import { TerrainControl } from './layers/TerrainControl.js';
import { useLayerCatalog } from './layers/useLayerCatalog.js';
import { useCameraPersistence } from './map/useCameraPersistence.js';
import { useNavLayers } from './map/useNavLayers.js';
import { useOverlayIdentify, useOverlayLabels, useOverlayLayers } from './map/useOverlayLayers.js';
import { useHuntingFieldsLayer } from './map/useHuntingFieldsLayer.js';
import { useIceObservationsLayer } from './map/useIceObservationsLayer.js';
import { useSatellitesLayer } from './map/useSatellitesLayer.js';
import { useExploreLayer } from './map/useExploreLayer.js';
import { useSpeedCameraLayer } from './map/useSpeedCameraLayer.js';
import { useTrafficFlowLayer } from './map/useTrafficFlowLayer.js';
import { useTrafficLayer } from './map/useTrafficLayer.js';
import { useRoadWeatherLayer } from './map/useRoadWeatherLayer.js';
import { useWeatherMapLayer } from './map/useWeatherMapLayer.js';
import { useTransitVehicleLayer } from './map/useTransitVehicleLayer.js';
import { useSavedStandLayer } from './map/useSavedStandLayer.js';
import { useSpotLayer } from './map/useSpotLayer.js';
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
import { prepareWebTransitAlarms, TransitGuidance } from './transit/TransitGuidance.js';
import { PlaceCard } from './place/PlaceCard.js';
import { PlaceEditDialog } from './place/PlaceEditDialog.js';
import { SatellitePassCard } from './satellites/SatellitePassCard.js';
import { SearchBox } from './SearchBox.js';
import { StorageBanner } from './storage/StorageBanner.js';
import { type ImportOptions, type ImportResult, useUserData } from './storage/useUserData.js';
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
const CommutePanel = lazy(() =>
  import('./transit/CommutePanel.js').then((m) => ({ default: m.CommutePanel })),
);

// `segments: true` asks for the per-leg boards too (TRANSIT.md §5) — one request that
// answers the whole dashboard rather than five the panel would have to
// orchestrate and fail independently.
// `commit` carries the journey the board is tracking (TRANSIT.md §7), so the answer
// still contains it once it has left — the moment the block is worth having.
const fetchCommute: CommuteFn = (query, signal, commit) =>
  fetchTransitCommute(query, { signal, segments: true, commit });

const DEFAULT_VIEW: MapViewState = { center: { lat: 59.91, lng: 10.75 }, zoom: 5 }; // Oslo
const TERRAIN_3D_SETTING = booleanSetting({
  key: 'local.map.terrain-3d',
  scope: 'local',
  defaultValue: false,
});

/**
 * How near an overlay's answer must land, on screen, to belong to the card that
 * is already open. A finger/cursor-sized radius — the same idea as Android's
 * pin tap tolerance.
 */
const IDENTIFY_SAME_SPOT_PX = 40;

// Decoded once at startup; afterwards the map keeps the hash in sync. A share
// link (hash) always wins over the persisted last view.
const hashView = decodeMapHash(window.location.hash);
const initialView = hashView ?? DEFAULT_VIEW;
// A plan carried by the link the user opened; restored once storage is ready.
const linkedPlan = hashView?.route ? planFromHash(hashView.route) : null;
// `#panel=commute` — the link the Android commute widget's tap follows, read
// here too so one URL opens the same board in a browser and on a phone.
const linkedPanel = decodePanelLink(window.location.hash);

/**
 * The four toolbar drawers. They are all `min(340px, 100vw - 24px)` wide and
 * anchored to one of the two top corners, so at phone width any two of them
 * cover each other — which makes "at most one is open" a property of the
 * layout, not a preference. One value carries it; five independent booleans
 * meant every toolbar button hand-closed a different subset of the others
 * (Settings closed Explore and Commute but left Collections up, Collections
 * closed Explore and Commute but left Settings up).
 */
type PanelId = 'collections' | 'explore' | 'commute' | 'settings';

interface SatelliteSelection {
  layerId: typeof SATELLITES_ID | typeof STARLINK_ID;
  noradId: number;
  observer: LatLng;
  observerSource: 'map' | 'location';
}

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
  const [satelliteSelection, setSatelliteSelection] = useState<SatelliteSelection | null>(null);
  // Shared by the pass list and the footprint drawn on the map — see
  // SatellitePassCardProps.minElevationDeg.
  const [satelliteMinElevation, setSatelliteMinElevation] = useState(10);
  const [satelliteLocating, setSatelliteLocating] = useState(false);
  const [satelliteLocationError, setSatelliteLocationError] = useState(false);
  // Only set once the user asks to be located; the card shows distances from it.
  const [userAt, setUserAt] = useState<LatLng | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [locateRequest, setLocateRequest] = useState(0);
  // The saved place whose editor is open, and the one the Collections tree
  // should reveal — both by id, so a rename or a delete elsewhere is followed
  // rather than leaving a stale copy of the record on screen.
  const [editPlaceId, setEditPlaceId] = useState<string | null>(null);
  const [revealPlaceId, setRevealPlaceId] = useState<string | null>(null);
  // Which drawer is open — see {@link PanelId}. The named booleans below are
  // read-only views of it, so the render tree still says which panel it means.
  const [panel, setPanel] = useState<PanelId | null>(linkedPanel === 'commute' ? 'commute' : null);
  const togglePanel = useCallback(
    (id: PanelId) => setPanel((current) => (current === id ? null : id)),
    [],
  );
  const closePanels = useCallback(() => setPanel(null), []);
  const sidebarOpen = panel === 'collections';
  const settingsOpen = panel === 'settings';
  // Which tab Settings opens on. Only ever set by a deep link from elsewhere —
  // the panel owns its own tab once it is up, so this seeds the mount and is
  // not a second source of truth for what is showing.
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('appearance');
  const openVehicleSettings = useCallback(() => {
    setSettingsSection('navigation');
    setPanel('settings');
  }, []);
  // The ordinary opener. Resets the tab, so a Settings opened from the sidebar
  // never inherits the section a previous deep link asked for.
  const toggleSettings = useCallback(() => {
    setSettingsSection('appearance');
    togglePanel('settings');
  }, [togglePanel]);
  const commuteOpen = panel === 'commute';
  const exploreOpen = panel === 'explore';
  const [exploreResults, setExploreResults] = useState<SearchResult[]>([]);
  const [exploreSelection, setExploreSelection] = useState<string | null>(null);
  // The two drawers anchored top-left, where the potential bar also lives.
  const leftPanelOpen = sidebarOpen || exploreOpen;
  const [selectedTrack, setSelectedTrack] = useState<{
    track: TrackRecord;
    data: TrackData;
  } | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userData = useUserData();
  const sync = useSync(userData);
  const commute = useCommute(userData, userData.places, fetchCommute, commuteOpen);
  const appearance = useThemeMode(userData, useSystemColorScheme());
  const mapStyleEditor = useMapStyleEditor(userData);
  useEffect(() => {
    document.documentElement.dataset['theme'] = appearance.colorScheme;
    document.documentElement.style.colorScheme = appearance.colorScheme;
  }, [appearance.colorScheme]);

  // ---- route planning ----

  // The described vehicle shapes both the planned route and the driven one, so
  // it is read before the planner and handed straight to it.
  const vehicle = useVehicleProfile(userData);
  const route = useRoute(vehicle.vehicle);
  // Public transport for the same two endpoints — a travel mode beside the road
  // profiles. The panel lists the journeys; the map draws the selected one, and
  // the road line stands down while it does.
  const transit = useTransitPlan(route);
  // The place card's hand-off into the planner (seeds "My location" as start).
  const directions = useDirections(route);

  // The radius / measure tool: while open it owns map clicks. State and geometry
  // are shared with Android through useMeasure (@atlas/app-hooks).
  const measure = useMeasure();
  const measuringRef = useRef(measure.open);
  measuringRef.current = measure.open;
  // Route mode or the measure tool own map clicks; identify, the POI card and
  // the route-click handler read this ref to yield.
  const blockPassiveClicksRef = useRef(false);
  blockPassiveClicksRef.current = route.active || measure.open;

  useRouteLayers(map, route, transit.enabled, measuringRef);
  useTransitLayers(map, transit.guidanceTrip ?? (transit.enabled ? transit.trip : null));
  // The plan survives a reload, and rides along in the shareable URL hash.
  useRoutePlanPersistence(route, userData, linkedPlan);
  useShareHash(map, pin, route.plan);

  // ---- overlay layers (catalog + raster rendering + tap-to-identify) ----

  const profiles = useMapProfile(userData);
  const terrainPreference = usePersistedSetting(userData, TERRAIN_3D_SETTING);
  const profilePreferences = useMapProfilePreferences(userData);
  const layers = useLayerCatalog(
    userData,
    profiles.profile.id,
    profilePreferences.preferredLayers(profiles.profile.id),
    profilePreferences.customizedLayers(profiles.profile.id),
  );
  const terrainAvailable = mapProfileSupportsTerrain(profiles.profile.id);
  const terrain3d = terrainAvailable && terrainPreference.value && layers.basemapOn;
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

  // Derived potential surfaces: queue the cells under the viewport and
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
  // "Why is this water good?" for whatever the place card is pointing at. The
  // derived layers are not identify-capable overlays — a tap on one is answered
  // with reasoning rather than upstream attributes, and both now land in the
  // same card.
  const potentialExplain = usePotentialExplain('', layers.derived, target?.position ?? null);
  // The Fish & Hunt sub-profile: which animal the derived surface is tuned for,
  // and the one-tap way to change it. Also the source of the target's *name*,
  // which the spots panel and a saved spot both label themselves with.
  const potentialTargets = usePotentialTarget(layers);
  const potentialTargetLabel = potentialTargets.active?.label;
  // The other half of that idea, for every layer the quarry switch does not own:
  // the chips of whatever is currently drawn, reachable from the map. What makes
  // Curiosities readable — every register in it is a filtered register.
  const layerFilters = useLayerFilters(layers);
  // The shortlist a derived surface turns into a plan: opened by
  // hand, because it is a real request against the derive service and the
  // router rather than a legend that could just appear.
  const [spotsOpen, setSpotsOpen] = useState(false);
  useEffect(() => {
    if (!layers.derived) setSpotsOpen(false);
  }, [layers.derived]);
  // The other half of a hunting season: not "where should I sit" but "which of
  // the stands I already have is on tonight". Opened by hand for the same reason
  // the shortlist is — it reads a forecast per stand.
  const [standBoardOpen, setStandBoardOpen] = useState(false);
  const standBoard = useStandBoard('', userData.places, {
    enabled: standBoardOpen,
    near: mapViewport
      ? {
          lat: (mapViewport.bbox[1] + mapViewport.bbox[3]) / 2,
          lng: (mapViewport.bbox[0] + mapViewport.bbox[2]) / 2,
        }
      : null,
  });
  const planningAreas = usePlanningAreas(userData.tracks, userData.getTrackData);
  const bestSpots = useBestSpots('', layers.derived, mapViewport, {
    enabled: spotsOpen,
    readyKey: potential.readyKey,
    vocabulary: layers.derived?.meta.derived?.vocabulary,
    areas: planningAreas,
  });
  // Picking a spot — from the list or from its marker — opens the *same* card a
  // tap on the water opens, so the reasoning, the elevation, the weather and
  // Save are the ones the user already knows. The number is carried in the
  // title so the card and the list agree about which spot this is.
  const onPickSpot = useCallback(
    (spot: PotentialSpot) => {
      const index = bestSpots.spots.findIndex((candidate) => candidate.id === spot.id);
      setPin(null);
      setTarget({
        source: 'poi',
        position: spot.position,
        name: `${spot.stand ? 'Stand' : 'Spot'} ${index + 1}`,
        category: spot.stand ? spot.reason : spot.bandLabel,
      });
      map?.easeTo({ center: [spot.position.lng, spot.position.lat], duration: 500 });
    },
    [bestSpots.spots, map],
  );
  // A board row opens the *saved place*, not a copy of it: the card at those
  // coordinates is the one carrying the stand block, the rose and the notes.
  const onPickStand = useCallback(
    (row: StandBoardRow) => {
      setPin(null);
      setTarget({ source: 'poi', position: row.position, name: row.name, category: 'Stand' });
      map?.easeTo({ center: [row.position.lng, row.position.lat], duration: 500 });
    },
    [map],
  );
  useSpotLayer(map, bestSpots.spots, onPickSpot, blockPassiveClicksRef);
  // The drive profile's signature overlay: ATK speed cameras as map features.
  useSpeedCameraLayer(map, overlays);
  useTrafficFlowLayer(map, overlays);
  useTrafficLayer(map, overlays);
  useRoadWeatherLayer(map, overlays);
  useTransitVehicleLayer(map, overlays, mapViewport);
  useHuntingFieldsLayer(map, overlays);
  useIceObservationsLayer(map, overlays);
  // Curiosities' two sky layers. Separate rows so the Starlink constellation's
  // eleven thousand objects stay opt-in beside the couple of hundred that make
  // up the stations and the naked-eye set.
  // The horizon circle is drawn against whichever point the card is predicting
  // for, so panning to "map centre" moves the disc with it and the two views
  // always answer the same question.
  const satelliteFootprint = useMemo(
    () =>
      satelliteSelection
        ? { minElevationDeg: satelliteMinElevation, observer: satelliteSelection.observer }
        : null,
    [satelliteSelection, satelliteMinElevation],
  );
  const satelliteLayer = useSatellitesLayer(
    map,
    overlays,
    SATELLITES_ID,
    satelliteSelection?.layerId === SATELLITES_ID ? satelliteSelection.noradId : null,
    satelliteSelection?.layerId === SATELLITES_ID ? satelliteFootprint : null,
  );
  const starlinkLayer = useSatellitesLayer(
    map,
    overlays,
    STARLINK_ID,
    satelliteSelection?.layerId === STARLINK_ID ? satelliteSelection.noradId : null,
    satelliteSelection?.layerId === STARLINK_ID ? satelliteFootprint : null,
  );
  const selectedSatellite = useMemo<SatelliteOmm | null>(() => {
    if (!satelliteSelection) return null;
    const source = satelliteSelection.layerId === SATELLITES_ID ? satelliteLayer : starlinkLayer;
    return (
      source.elements.find((element) => element.NORAD_CAT_ID === satelliteSelection.noradId) ?? null
    );
  }, [satelliteSelection, satelliteLayer.elements, starlinkLayer.elements]);

  // A card cannot outlive the row that supplied its elements. A refreshed set
  // may also retire a decayed object; the same derived lookup closes that case.
  useEffect(() => {
    if (!satelliteSelection) return;
    const source = satelliteSelection.layerId === SATELLITES_ID ? satelliteLayer : starlinkLayer;
    if (!source.active || (source.status === 'ready' && !selectedSatellite)) {
      setSatelliteSelection(null);
    }
  }, [satelliteSelection, satelliteLayer, starlinkLayer, selectedSatellite]);

  // ---- turn-by-turn navigation ----

  const nav = useWebNavigation();
  // The route mode owns cartography for the duration of guidance. In
  // particular, starting a drive from a Hike map must restore road-first Drive
  // styling and its contextual layers, while plain Walk restores Explore.
  useEffect(() => {
    if (nav.activity !== 'guidance') return;
    const next = mapProfileForRouting(nav.profile);
    if (next && next.id !== profiles.profile.id) profiles.setProfile(next.id);
  }, [nav.activity, nav.profile, profiles.profile.id, profiles.setProfile]);
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
    tripProgress: nav.tripProgress,
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
  const onStartExplorer = useCallback(() => {
    setPin(null);
    setTarget(null);
    const profile = route.profile;
    stopRoute();
    void nav.explore(profile);
  }, [nav, route.profile, stopRoute]);
  const startTransitGuidance = useCallback(
    (trip: TransitTrip) => {
      void prepareWebTransitAlarms();
      transit.startGuidance(trip);
      stopRoute();
    },
    [stopRoute, transit.startGuidance],
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
  // The Go button on a collection row. The planner takes the bottom of the
  // screen, so the panel that launched the trip steps aside — the same
  // hand-off the Android favourites sheet makes.
  const goToPlace = useCallback(
    (place: PlaceRecord) => {
      closePanels();
      onDirectionsToTarget({ lat: place.lat, lng: place.lng }, place.name);
    },
    [closePanels, onDirectionsToTarget],
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
  // A saved stand draws its own rose, so which way it faces is visible on the
  // map that planned it — and it follows the same visibility rules as its pin.
  useSavedStandLayer(map, visiblePlaces);

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
      radiusM: clampExploreRadiusM(
        haversineM(
          { lat: center.lat, lng: center.lng },
          { lat: northEast.lat, lng: northEast.lng },
        ),
      ),
    };
  }, []);
  const currentExploreArea = useMemo<ExploreArea | null>(() => {
    if (!mapViewport) return null;
    const center = {
      lat: (mapViewport.bbox[1] + mapViewport.bbox[3]) / 2,
      lng: (mapViewport.bbox[0] + mapViewport.bbox[2]) / 2,
    };
    return {
      center,
      radiusM: clampExploreRadiusM(
        haversineM(center, { lat: mapViewport.bbox[3], lng: mapViewport.bbox[2] }),
      ),
    };
  }, [mapViewport]);

  // ---- weather & conditions ----

  const weatherAt = useWeatherTarget(pin, getBias, DEFAULT_VIEW.center);
  const weatherTarget = weatherAt.target;
  const weather = useWeather(weatherTarget);
  const weatherMaps = useWeatherMaps('', weatherTarget !== null);
  useWeatherMapLayer(map, weatherMaps);

  const { followPin } = weatherAt;

  // A picked search result becomes a pin plus the same card a POI tap opens.
  const onSearchSelect = useCallback(
    (result: SearchResult) => {
      closePanels();
      setPin(result.position);
      setTarget({
        source: 'search',
        position: result.position,
        name: result.name,
        address: result.address,
        category: result.address ? undefined : result.label || undefined,
        transitStopId: result.transitStopId,
      });
      followPin(result.position);
      const map = mapRef.current;
      if (map) {
        map.flyTo({ center: result.position, zoom: Math.max(map.getZoom(), 13) });
      }
    },
    [closePanels, followPin],
  );
  const onPickExplore = useCallback(
    (result: SearchResult) => {
      setExploreSelection(
        `${result.name}/${result.position.lat.toFixed(6)}/${result.position.lng.toFixed(6)}`,
      );
      onSearchSelect(result);
    },
    [onSearchSelect],
  );
  useExploreLayer(map, exploreResults, onPickExplore, blockPassiveClicksRef);
  // A picked result keeps the rest of its numbered set on the map while its
  // card is open. Once the card changes subject or closes, the browse is over.
  useEffect(() => {
    if (!exploreSelection) return;
    const targetKey = target?.name
      ? `${target.name}/${target.position.lat.toFixed(6)}/${target.position.lng.toFixed(6)}`
      : null;
    if (targetKey === exploreSelection) return;
    setExploreSelection(null);
    setExploreResults([]);
  }, [exploreSelection, target]);
  useEffect(() => {
    if (panel !== 'explore' && exploreSelection === null) {
      setExploreResults((current) => (current.length ? [] : current));
    }
  }, [panel, exploreSelection]);

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

  // What the overlays say is under a click goes onto the card that click
  // opened — or opens one for the bare point, since a lake with a surveyed
  // depth is worth a card of its own. Same rule as Android's `showIdentify`,
  // and the reason the answers no longer get a popup of their own.
  //
  // The answers only join a card that is about *that* point, measured on
  // screen so the test means the same thing at every zoom. A POI's own
  // coordinate sits a few pixels from the click that opened it and belongs
  // together; the next lake along does not, and merging there would relabel a
  // card with another place's depth.
  const onIdentify = useCallback(
    (at: LatLng, groups: OverlayIdentifyGroup[]) => {
      const map = mapRef.current;
      if (target && map) {
        const a = map.project(target.position);
        const b = map.project(at);
        if (Math.hypot(a.x - b.x, a.y - b.y) <= IDENTIFY_SAME_SPOT_PX) {
          setTarget({ ...target, identify: groups });
          return;
        }
      }
      setPin(at);
      followPin(at);
      setTarget({ source: 'pin', position: at, identify: groups });
    },
    [target, followPin],
  );
  const onSatellitePick = useCallback(
    (hit: { layerId: string; noradId: number }) => {
      const layerId = hit.layerId === STARLINK_ID ? STARLINK_ID : SATELLITES_ID;
      const source = layerId === SATELLITES_ID ? satelliteLayer : starlinkLayer;
      if (!source.elements.some((element) => element.NORAD_CAT_ID === hit.noradId)) return;
      const center = mapRef.current?.getCenter();
      if (!center) return;
      setTarget(null);
      setSatelliteLocationError(false);
      setSatelliteSelection({
        layerId,
        noradId: hit.noradId,
        observer: { lat: center.lat, lng: center.lng },
        observerSource: 'map',
      });
    },
    [satelliteLayer, starlinkLayer],
  );
  useOverlayIdentify(map, overlays, blockPassiveClicksRef, onIdentify, onSatellitePick);

  const useMapCenterForSatellite = useCallback(() => {
    const center = mapRef.current?.getCenter();
    if (!center) return;
    setSatelliteLocationError(false);
    setSatelliteSelection((current) =>
      current
        ? {
            ...current,
            observer: { lat: center.lat, lng: center.lng },
            observerSource: 'map',
          }
        : null,
    );
  }, []);

  const useMyLocationForSatellite = useCallback(() => {
    if (satelliteLocating) return;
    setSatelliteLocating(true);
    setSatelliteLocationError(false);
    void getMyLocation().then((at) => {
      setSatelliteLocating(false);
      if (!at) {
        setSatelliteLocationError(true);
        return;
      }
      setUserAt(at);
      setSatelliteSelection((current) =>
        current ? { ...current, observer: at, observerSource: 'location' } : null,
      );
    });
  }, [satelliteLocating]);

  // A place selection supersedes an orbit selection; this also covers POIs
  // whose own layer-specific click handler runs before the shared map handler.
  useEffect(() => {
    if (target) setSatelliteSelection(null);
  }, [target]);

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

  const savePermit = useCallback(
    async (input: string, options?: ImportOptions): Promise<TrackRecord | null> => {
      const area = await resolveInaturOffer('', input);
      let collectionId = options?.collectionId ?? null;
      if (options?.newCollection) {
        const collection = await userData.createCollection(
          options.newCollection.name,
          options.newCollection.parentId ?? null,
        );
        if (!collection) return null;
        collectionId = collection.id;
      }
      return userData.savePermitArea(area, collectionId);
    },
    [userData],
  );

  const planTrack = useCallback(
    (track: TrackRecord) => {
      void getTrackData(track.id).then((data) => {
        if (!data) return;
        const points = trackToRoutePoints(data);
        if (points.length < 2) return;
        closePanels();
        setSelectedTrack(null);
        route.restore({
          profile: route.profile,
          waypoints: points.map((pos, index) => ({
            pos,
            ...(index === 0
              ? { name: `${track.name} start` }
              : index === points.length - 1
                ? { name: `${track.name} finish` }
                : {}),
          })),
        });
      });
    },
    [closePanels, getTrackData, route],
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

  // Identity-stable: it sits in the Sidebar's reveal effect deps, where a fresh
  // arrow per render would re-run that effect on every render.
  const onRevealed = useCallback(() => setRevealPlaceId(null), []);

  // Resolved from the live list rather than held as a record: deleting the
  // place — here, or on another device mid-edit — closes the editor instead of
  // leaving it editing something that no longer exists.
  const editPlace = useMemo(
    () => (editPlaceId ? (userData.places.find((p) => p.id === editPlaceId) ?? null) : null),
    [editPlaceId, userData.places],
  );
  const tagSuggestions = useMemo(
    () => collectionTagSuggestions([...userData.places, ...userData.tracks]),
    [userData.places, userData.tracks],
  );

  const onSaveTarget = useCallback(() => {
    if (!target) return;
    const name = placeTargetTitle(target);
    // A bare pin has no name to save — `placeTargetTitle` falls back to its
    // coordinates, which is not what the user would have called it. Saving is
    // still what they asked for, so it happens either way; the editor then
    // opens on the new place so naming it is the next keystroke rather than a
    // hunt through the sidebar. Anything that arrived with a name (a POI, a
    // search hit, a spot) is already called the right thing and is left alone.
    const needsName = !target.name?.trim();
    void savePlace({
      name,
      lat: target.position.lat,
      lng: target.position.lng,
      address: target.source === 'search' ? target.address : undefined,
    }).then((place) => {
      if (place && needsName) setEditPlaceId(place.id);
    });
    // No sidebar pop-open: the button flipping to "Edit" is the confirmation,
    // and the sidebar would slide in over the card the user is still reading.
  }, [target, savePlace]);

  // A spot saved from the shortlist keeps its reasoning in the notes: the pin
  // syncs and comes along offline, where the surface that produced it will not.
  const onSaveSpot = useCallback(
    (spot: PotentialSpot, index: number) => {
      void savePlace(spotPlaceDraft(spot, index, { targetLabel: potentialTargetLabel }));
    },
    [savePlace, potentialTargetLabel],
  );

  const onAddStop = useCallback(() => {
    if (!target) return;
    route.addWaypoint(target.position, target.name);
    setTarget(null);
  }, [target, route]);

  // A link to this exact spot, independent of where the camera happens to sit
  // (the address bar's hash follows the map, which is not what "share this
  // place" means).
  const shareUrl = useCallback(() => {
    if (!target) return window.location.href;
    const zoom = Math.max(mapRef.current?.getZoom() ?? 14, 14);
    return atlasShareUrl(
      `${window.location.origin}${window.location.pathname}`,
      target.position,
      zoom,
    );
  }, [target]);

  // Carry out whichever format the card's chooser produced (the list itself is
  // `shareFormats`, shared with Android).
  //
  // 'send' prefers the OS share sheet where the browser has one — that is what
  // puts the location into the recipient's messaging and maps apps rather than
  // into a page only Atlas users can open. Without one, or when it fails for
  // any reason other than being dismissed, the same text goes to the clipboard
  // so the user still gets something they can paste.
  const onShareTarget = useCallback(async (format: ShareFormat): Promise<'shared' | 'copied'> => {
    if (format.action === 'send' && navigator.share) {
      try {
        await navigator.share({ title: format.title, text: format.payload });
        return 'shared';
      } catch (err) {
        // A dismissed share sheet is not a failure — say nothing and stop.
        if (err instanceof DOMException && err.name === 'AbortError') return 'shared';
      }
    }
    await navigator.clipboard.writeText(format.payload);
    return 'copied';
  }, []);

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
        basemap={layers.basemapOn}
        terrain={terrain3d}
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
          aria-label="Commute"
          title="Commute"
          aria-expanded={commuteOpen}
          onClick={() => togglePanel('commute')}
        >
          <TrainIcon size={18} />
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Explore nearby places"
          title="Explore"
          aria-expanded={exploreOpen}
          onClick={() => {
            if (exploreOpen) setExploreResults([]);
            setExploreSelection(null);
            togglePanel('explore');
            // The list is the subject while it is up; a card left open from
            // before would sit on top of the results it has nothing to do with.
            setTarget(null);
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
          onClick={() => togglePanel('collections')}
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
            // Starting from a dropped pin routes "from here".
            if (route.active) {
              route.stop();
              return;
            }
            // The planner's own panel takes the same corner the drawers do, so
            // opening it stands them down — stopping it leaves them alone.
            closePanels();
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
            // Same corner again: the forecast opens over the drawers, so it
            // closes them — dismissing it does not.
            if (weatherTarget === null) closePanels();
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
          onClick={toggleSettings}
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
      {/* What the derive service is doing for the water on screen, and the
          shortlist it can turn into. Both sit under the search box because that
          is where "what is this map doing" belongs; the pill is absent entirely
          once the surface is ready, and the column keeps the panel below
          whatever the pill is saying rather than on top of it.

          It stands aside for the left-hand drawers, which take the same column
          and start 2 px below it: the bar's higher z-index meant the shortlist
          drew *through* an open Collections tree. `spotsOpen` is untouched
          while it is away and `useBestSpots` stays enabled, so closing the
          drawer brings the same shortlist back rather than re-asking the derive
          service for it. */}
      {nav.phase === 'idle' && layers.derived && !leftPanelOpen && (
        <div className="potential-bar">
          <PotentialPill prep={potential} />
          {layers.derived &&
            !spotsOpen &&
            potential.status !== 'zoom-in' &&
            potential.status !== 'outside' && (
              <SpotsButton
                onOpen={() => setSpotsOpen(true)}
                hunting={layers.derived.meta.derived?.vocabulary === 'hunt'}
              />
            )}
          {layers.derived && spotsOpen && (
            <SpotsPanel
              state={bestSpots}
              targetLabel={potentialTargetLabel}
              saveEnabled={userData.status === 'ready'}
              onPick={onPickSpot}
              onSave={onSaveSpot}
              onClose={() => setSpotsOpen(false)}
            />
          )}
          {/* The saved-stand board rides beside the shortlist because it is the
              same workflow's other half — but it is about places already saved,
              so it does not wait for a prepared cell. */}
          {layers.derived?.meta.derived?.vocabulary === 'hunt' && !standBoardOpen && (
            <StandBoardButton onOpen={() => setStandBoardOpen(true)} />
          )}
          {layers.derived?.meta.derived?.vocabulary === 'hunt' && standBoardOpen && (
            <StandBoardPanel
              state={standBoard}
              onPick={onPickStand}
              onClose={() => setStandBoardOpen(false)}
            />
          )}
        </div>
      )}
      {/* One real grid for all bottom-right map controls. It owns activity,
          layers, zoom and location so independent absolute offsets cannot
          overlap as catalogs/profile choices change. */}
      {nav.phase === 'idle' && (
        <div className="map-control-grid">
          {/* The Fish & Hunt sub-profile, one row above the layers it tunes.
              Renders nothing in the other profiles — their catalogs carry no
              derived surface. */}
          <PotentialTargetSwitch targets={potentialTargets} />
          {/* What the layers that *are* on are filtered to. Renders nothing
              when none of them has a variant to pick. */}
          <LayerFilterSwitch filters={layerFilters} />
          <MapProfileSwitch
            active={profiles.profile.id}
            profiles={profilePreferences.visibleProfiles}
            onPick={onPickProfile}
          />
          <LayerQuickSwitch layers={layers} mapZoom={mapZoom} />
          <TerrainControl
            available={terrainAvailable}
            enabled={terrain3d}
            basemap={layers.basemapOn}
            onToggle={() => void terrainPreference.setValue((current) => !current)}
          />
          <button
            type="button"
            className={`map-measure-control${measure.open ? ' on' : ''}`}
            aria-label="Measure distance and radius"
            title="Measure"
            aria-pressed={measure.open}
            onClick={measure.toggleOpen}
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
              onClick={() => map?.easeTo({ bearing: 0, pitch: terrain3d ? 55 : 0 })}
            >
              <CompassIcon size={18} />
            </button>
          </div>
          {/* Follow the live position with no destination. It spent a full row
              inside the route planner until v0.173.0, under the mode icons,
              where it read as a routing option and pushed the stops down the
              sheet — but it plans nothing. It belongs beside locate: both are
              "put the map on me", one once and one continuously. */}
          <button
            type="button"
            className="map-follow-control"
            aria-label="Follow my position without a destination"
            title="Follow my position"
            onClick={onStartExplorer}
          >
            <NavArrowIcon size={19} />
          </button>
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
      {map && measure.open && nav.phase === 'idle' && (
        <MeasureTool map={map} measure={measure} onClose={() => measure.setOpen(false)} />
      )}
      {satelliteSelection && selectedSatellite && nav.phase === 'idle' && (
        <SatellitePassCard
          element={selectedSatellite}
          layerId={satelliteSelection.layerId}
          observer={satelliteSelection.observer}
          observerSource={satelliteSelection.observerSource}
          minElevationDeg={satelliteMinElevation}
          onMinElevationChange={setSatelliteMinElevation}
          overhead={
            (satelliteSelection.layerId === SATELLITES_ID ? satelliteLayer : starlinkLayer).overhead
          }
          train={trainOf(
            (satelliteSelection.layerId === SATELLITES_ID ? satelliteLayer : starlinkLayer).trains,
            satelliteSelection.noradId,
          )}
          locating={satelliteLocating}
          locationError={satelliteLocationError}
          shifted={leftPanelOpen || spotsOpen || standBoardOpen}
          onUseMapCenter={useMapCenterForSatellite}
          onUseMyLocation={useMyLocationForSatellite}
          onClose={() => setSatelliteSelection(null)}
        />
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
          // Both left-hand panels push the card clear of themselves: picking a
          // spot from the shortlist would otherwise open the card *behind* the
          // list it was picked from.
          shifted={leftPanelOpen || spotsOpen || standBoardOpen}
          onDirections={() => onDirectionsToTarget(target.position, target.name)}
          onSave={onSaveTarget}
          onEdit={(place) => setEditPlaceId(place.id)}
          onAddStop={onAddStop}
          onShare={onShareTarget}
          shareUrl={shareUrl}
          onWeather={() => weatherAt.setTarget(target.position)}
          onRemovePin={() => onPinChange(null)}
          onShowNearby={onShowNearbyPlace}
          onClose={() => setTarget(null)}
        />
      )}
      {exploreOpen && nav.phase === 'idle' && (
        <ExplorePanel
          key={profiles.profile.id}
          getArea={getExploreArea}
          currentArea={currentExploreArea}
          profileId={profiles.profile.id}
          onPick={onPickExplore}
          onResultsChange={setExploreResults}
          onClose={() => {
            setExploreResults([]);
            setExploreSelection(null);
            closePanels();
          }}
        />
      )}
      {/* Opened from the card's Edit action, and straight after saving a pin
          that has only its coordinates for a name. Looked up by id every render
          so a delete (from here or from a synced device) closes it. */}
      {editPlace && (
        <PlaceEditDialog
          place={editPlace}
          collections={userData.collections}
          tagSuggestions={tagSuggestions}
          onPatch={(patch) => void userData.updatePlace(editPlace.id, patch)}
          onDelete={() => void userData.deletePlace(editPlace.id)}
          onShowInCollections={() => {
            setEditPlaceId(null);
            setRevealPlaceId(editPlace.id);
            setPanel('collections');
          }}
          onClose={() => setEditPlaceId(null)}
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
            maps={weatherMaps}
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
            collections={userData.collections}
            getBias={getBias}
            getMyLocation={getMyLocation}
            locatingOrigin={directions.locatingOrigin}
            fetchNearby={fetchNearbyStops}
            onNavigate={onStartNavigation}
            onOpenVehicleSettings={openVehicleSettings}
            onStartTransitGuidance={startTransitGuidance}
            onSaveTrack={async (data, name, collectionId) =>
              (await userData.saveTrack(data, name, collectionId)) !== null
            }
          />
        )}
        {transit.guidanceTrip && (
          <TransitGuidance trip={transit.guidanceTrip} onStop={transit.stopGuidance} />
        )}
        {sidebarOpen && (
          <Sidebar
            data={userData}
            selectedTrackId={selectedTrack?.track.id ?? null}
            placeCommutes={commute.placeCommutes}
            revealPlaceId={revealPlaceId}
            onRevealed={onRevealed}
            onShowPlace={showPlace}
            onShowTrack={showTrack}
            onPlanTrack={planTrack}
            onGoToPlace={goToPlace}
            onImported={onImported}
            onSavePermit={savePermit}
            onClose={closePanels}
          />
        )}
        {settingsOpen && (
          <SettingsPanel
            section={settingsSection}
            sync={sync}
            storage={userData}
            appearance={appearance}
            mapStyle={mapStyleEditor}
            navPrefs={navPrefs}
            vehicle={vehicle}
            layers={layers}
            mapZoom={mapZoom}
            profilePreferences={profilePreferences}
            onExportAll={() => void userData.exportAll()}
            onClose={closePanels}
          />
        )}
        {commuteOpen && (
          <CommutePanel
            commute={commute}
            places={userData.places}
            getBias={getBias}
            onClose={closePanels}
          />
        )}
        {/* Route detail samples terrain heights; outside coverage, skip the
            profile rather than draw an empty chart. */}
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
            enrichment={routePath.enrichment}
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
