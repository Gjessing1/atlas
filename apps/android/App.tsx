import {
  useBestSpots,
  useMapProfile,
  useMapProfilePreferences,
  useRegionPackJobs,
  useMapStyleEditor,
  useMeasure,
  useCommute,
  plannedCommuteFromWaypoints,
  routePlanFromCommute,
  routePlanState,
  useNavAddStop,
  useNavPrefs,
  useVehicleProfile,
  useTransitPreferences,
  useNavResume,
  usePotential,
  useRoutePlanPersistence,
  usePotentialExplain,
  usePotentialTarget,
  usePoiList,
  usePoiViewport,
  useLayerFilters,
  usePlanningAreas,
  useStandBoard,
  useSkyLayers,
  useThemeMode,
  type FetchNearbyFn,
  type ExploreArea,
  type CommuteFn,
  type StandBoardRow,
  type StopLinesFn,
  type PoiViewportFetch,
} from '@atlas/app-hooks';
import {
  atlasRouteUrl,
  bboxContains,
  clampExploreRadiusM,
  haversineM,
  mapProfile,
  mapProfileForRouting,
  placeIsVisible,
  poiTilesUrl,
  resolveInaturOffer,
  SATELLITES_ID,
  savedPlaceAt,
  STARLINK_ID,
  type BBox,
  type LatLng,
  type MapAppearance,
  type NearbyPlaceArticle,
  type PoiResult,
  type PoiTileResults,
  type SearchResult,
  type VisibilityFolder,
  type SettingsSectionId,
} from '@atlas/core';
import {
  AURORA_FORECAST_ID,
  LIGHTNING_OBSERVATIONS_ID,
  weatherPointIdentify,
  weatherPointUrl,
  type WeatherPointSample,
} from '@atlas/conditions';
import { buildGpx, trackBounds, type TrackData } from '@atlas/gpx';
import { trainOf, type SatelliteOmm } from '@atlas/satellites';
import type { TrackRecord } from '@atlas/storage';
import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import {
  isRoutingProfile,
  ROUTING_PROFILES,
  routePathToTrackData,
  trackToRoutePoints,
  type RoutePath,
} from '@atlas/routing';
import {
  fetchTransitCommute,
  fetchTransitStopLines,
  transitTripBounds,
  type TransitTrip,
} from '@atlas/transit';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Appearance,
  AppState,
  BackHandler,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { DEFAULT_VIEW, MapScene } from './src/map/MapScene';
import { useBootCamera } from './src/map/useBootCamera';
import { useMapPress } from './src/map/useMapPress';
import { useHuntingFields } from './src/layers/useHuntingFields';
import { useIceObservations } from './src/layers/useIceObservations';
import { useLightning } from './src/layers/useLightning';
import { useSatellites } from './src/layers/useSatellites';
import { useSpeedCameras } from './src/layers/useSpeedCameras';
import { useTraffic } from './src/layers/useTraffic';
import { useTrafficFlow } from './src/layers/useTrafficFlow';
import { useRoadWeather } from './src/layers/useRoadWeather';
import { useWeatherLayers, useWeatherWarnings } from './src/layers/useWeatherLayers';
import { useTransitVehicles } from './src/layers/useTransitVehicles';
import { useOverlayLabels } from './src/layers/useOverlayLabels';
import { PotentialPill, potentialPillVisible } from './src/layers/PotentialPill';
import {
  useNavigationDiagnostics,
  useNavigationDiagnosticState,
} from './src/nav/useNavigationDiagnostics';
import { SpotsButton, SpotsSheet } from './src/ui/SpotsSheet';
import { StandBoardButton, StandBoardSheet } from './src/ui/StandBoardSheet';
import { spotPlaceDraft, type PotentialSpot } from '@atlas/potential';
import { useOverlays } from './src/layers/useOverlays';
import { useMapStyle } from './src/map/useMapStyle';
import { useTileSource } from './src/map/useTileSource';
import type { LocalPack } from './src/regions/packs';
import { AddStopSheet, NavStopTapCard } from './src/nav/AddStopSheet';
import { NavResumeCard } from './src/nav/NavResumeCard';
import { NavBanner } from './src/nav/NavBanner';
import { NavChrome, useNavPuck } from './src/nav/NavChrome';
import { NavPipCard } from './src/nav/NavPipCard';
import { pipCardMetrics } from './src/nav/pipGuidance';
import { pipWindowSize } from './modules/pip';
import { navViewport } from './src/nav/navViewport';
import { RoutePreview } from './src/nav/RoutePreview';
import { useNavCamera } from './src/nav/useNavCamera';
import { useNavigation } from './src/nav/useNavigation';
import { useNavigationPip } from './src/nav/useNavigationPip';
import { useTunnelDim } from './src/nav/useTunnelDim';
import { packWithSurface, withLocalSurfaces } from './src/regions/localSurfaces';
import { requestPotentialPack, viewBbox } from './src/regions/potentialPack';
import { listLocalPacks } from './src/regions/packs';
import { useOfflinePrefs } from './src/regions/useOfflinePrefs';
import { usePackDownloads } from './src/regions/usePackDownloads';
import { useAutoPackUpdate, usePackFreshness } from './src/regions/usePackFreshness';
import { geoExplore } from './src/search/geoExplore';
import { SearchBar } from './src/search/SearchBar';
import { useServerOrigin } from './src/serverOrigin';
import {
  configureCommuteWidget,
  configureCommuteWidgetV2,
  readCommuteWidgetCommit,
  reportCommutePlace,
  setCommuteWidgetCommit,
} from './src/commuteWidget';
import { shareText } from './src/share';
import { useSync } from './src/sync/useSync';
import { useDirections } from './src/routing/useDirections';
import { useRoute } from './src/routing/useRoute';
import { useTransitPlan } from './src/routing/useTransit';
import { cancelTransitAlarms, scheduleTransitAlarms } from './modules/transitguidance';
import { AppSheets } from './src/ui/AppSheets';
import { DestinationCard, type DestinationTarget } from './src/ui/DestinationCard';
import { ExploreSheet } from './src/ui/ExploreSheet';
import { useDestination } from './src/ui/useDestination';
import { CloudOffIcon, CrosshairIcon } from './src/ui/icons';
import { useSideInsets } from './src/ui/insets';
import { theme } from './src/ui/theme';
import { MainMenuSheet } from './src/ui/MainMenuSheet';
import { CommuteSheet } from './src/ui/CommuteSheet';
import { useGeocode } from './src/ui/useGeocode';
import { MeasureSheet } from './src/ui/MeasureSheet';
import { MenuCluster } from './src/ui/MenuCluster';
import { MapActivityControls } from './src/ui/MapActivityControls';
import { WeatherDock } from './src/ui/WeatherDock';
import { POI_SHEET_HANDLE, POI_SHEET_PEEK, PoiListSheet } from './src/ui/PoiListSheet';
import { OfflineRegionDrawControls } from './src/ui/OfflineRegionDrawControls';
import { PromptModal } from './src/ui/PromptModal';
import { RoutePanel } from './src/ui/RoutePanel';
import { TransitGuidance } from './src/ui/TransitGuidance';
import { ShareSheet, type ShareTarget } from './src/ui/ShareSheet';
import { SatellitePassSheet } from './src/ui/SatellitePassSheet';
import { TrackProfileSheet } from './src/ui/TrackProfileSheet';
import { WeatherSheet } from './src/ui/WeatherSheet';
import { UpdateNotices } from './src/update/UpdateNotices';
import { useTrackGeometry } from './src/useTrackGeometry';
import { useUserData, type ImportOptions } from './src/useUserData';
import { useWeather } from './src/weather/useWeather';

/**
 * Fallback system-bar sizes (dp) used only when the measured safe-area inset is
 * 0 — a defence against Android edge-to-edge occasionally not delivering the
 * window insets to JS, which would otherwise leave our controls hidden under the
 * system navigation bar. A real gesture/3-button bar always reports a non-zero
 * inset, so these never over-pad a correctly-measured layout.
 */
const NAV_BAR_FALLBACK = 48;
const STATUS_BAR_FALLBACK = 28;

/** A picture-in-picture window has no system bars to clear. */
const NO_SIDE_INSETS = { left: 0, right: 0 };

/** Stable identity for "no shortlist", so a closed sheet never re-renders the scene. */
const EMPTY_SPOTS: readonly PotentialSpot[] = [];

function AppInner() {
  const insets = useSafeAreaInsets();
  const bottomInset = insets.bottom || NAV_BAR_FALLBACK;
  const topInset = insets.top || STATUS_BAR_FALLBACK;
  // Landscape moves the system navigation bar to a side of the screen, so
  // edge-anchored chrome has to clear it there too (0 in portrait; each piece
  // of chrome reads the same insets for itself — see src/ui/insets.ts).
  const side = useSideInsets();
  const data = useUserData();
  const planningAreas = usePlanningAreas(data.tracks, data.getTrackData);
  const systemColorScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const appearance = useThemeMode(data, systemColorScheme);
  const mapStyleEditor = useMapStyleEditor(data);
  useEffect(() => {
    Appearance.setColorScheme(appearance.mode === 'system' ? 'unspecified' : appearance.mode);
  }, [appearance.mode]);
  // Draw only effectively-visible places (own toggle on, no hiding folder). The
  // Favorites sheet still lists hidden ones so they can be shown again.
  const visiblePlaces = useMemo(() => {
    const folders = new Map<string, VisibilityFolder>(
      data.collections.map((c) => [c.id, { parentId: c.parentId, visible: c.visible }]),
    );
    return data.places.filter((p) => placeIsVisible(p, folders));
  }, [data.places, data.collections]);
  const sync = useSync(data.storage, data.refreshAll, data.places);
  const navDiagnostics = useNavigationDiagnostics(data, sync.email, sync.status);
  const nav = useNavigation();
  useNavigationDiagnosticState(nav);
  // The described vehicle shapes both the planned route and the driven one.
  const vehicle = useVehicleProfile(data);
  const route = useRoute(vehicle.vehicle);
  const transitPreferences = useTransitPreferences(data);
  const transit = useTransitPlan(route, transitPreferences.value);
  const plannedCommute = useMemo(
    () => plannedCommuteFromWaypoints(route.waypoints),
    [route.waypoints],
  );
  // Reveal the position puck once any planner action has obtained a fix. This
  // includes the automatic "Directions" origin, not only the idle locate
  // button, so walking-route planning can show the live native compass.
  const [showPuck, setShowPuck] = useState(false);
  const revealPuck = useCallback(() => setShowPuck(true), []);
  const directions = useDirections(route, revealPuck);
  // Geometry of the visible tracks, for the map's track line layer.
  const trackGeo = useTrackGeometry(data.storage, data.tracks);
  // The active profile and quick overlay state are device-local; the preferred
  // switcher layout syncs and is shared by Settings and the one-tap controls.
  const profiles = useMapProfile(data);
  // Navigation's route mode owns the matching map cartography. A Drive trip
  // cannot retain Hike styling just because that was the previous activity;
  // plain Walk uses the general-purpose Explore map.
  useEffect(() => {
    if (nav.activity !== 'guidance') return;
    const next = mapProfileForRouting(nav.profile);
    if (next && next.id !== profiles.profile.id) profiles.setProfile(next.id);
  }, [nav.activity, nav.profile, profiles.profile.id, profiles.setProfile]);
  const profilePreferences = useMapProfilePreferences(data);
  const overlaysCtl = useOverlays(
    data,
    profiles.profile.id,
    profilePreferences.preferredLayers(profiles.profile.id),
    profilePreferences.customizedLayers(profiles.profile.id),
  );
  // After `useOverlays`, because whether the basemap draws at all is part of the
  // same per-profile overlay state — the style is rebuilt when it changes, which
  // is the whole mechanism (there is no basemap layer left to hide).
  const mapAppearance = useMemo<MapAppearance>(
    () => ({
      colorScheme: appearance.colorScheme,
      profile: profiles.profile.id,
      custom: mapStyleEditor.value,
      basemap: overlaysCtl.basemapOn,
      poi: overlaysCtl.poiOn,
      poiCategories: overlaysCtl.poiCategories,
    }),
    [
      appearance.colorScheme,
      profiles.profile.id,
      mapStyleEditor.value,
      overlaysCtl.basemapOn,
      overlaysCtl.poiOn,
      overlaysCtl.poiCategories,
    ],
  );
  const serverOrigin = useServerOrigin();
  const regionJobs = useRegionPackJobs(data, serverOrigin);

  const [packs, setPacks] = useState<LocalPack[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // The expanded search overlay (the 🔍 button in the bottom-left cluster opens it).
  const [searchOpen, setSearchOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [exploreResults, setExploreResults] = useState<SearchResult[]>([]);
  const [exploreSelection, setExploreSelection] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which section Settings drills into on open. Only ever set by a deep link
  // from elsewhere — the sheet owns the drill-down once it is up.
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);
  /**
   * Open Settings, optionally straight into one section. Every caller goes
   * through this: the sheet stays mounted between opens, so an opener that only
   * flipped `settingsOpen` would inherit whichever section a *previous* deep
   * link left behind.
   */
  const openSettings = useCallback((section: SettingsSectionId | null = null) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const openVehicleSettings = useCallback(() => openSettings('navigation'), [openSettings]);
  const [commuteOpen, setCommuteOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  // Place whose focused editor should open (map pin → Edit).
  const [editPlaceId, setEditPlaceId] = useState<string | null>(null);
  // The track whose elevation profile is open, with the geometry the row tap
  // already loaded to frame it — one gesture, map *and* profile.
  const [trackProfile, setTrackProfile] = useState<{
    track: TrackRecord;
    data: TrackData | null;
  } | null>(null);
  const [satelliteSelection, setSatelliteSelection] = useState<{
    layerId: typeof SATELLITES_ID | typeof STARLINK_ID;
    noradId: number;
    observer: LatLng;
    observerSource: 'map' | 'location';
  } | null>(null);
  // Shared by the pass sheet and the footprint drawn on the map — see
  // SatellitePassSheet's minElevationDeg.
  const [satelliteMinElevation, setSatelliteMinElevation] = useState(10);
  const [satelliteLocating, setSatelliteLocating] = useState(false);
  const [satelliteLocationError, setSatelliteLocationError] = useState(false);
  const commuteFetch = useMemo<CommuteFn>(
    () => (query, signal, commit) =>
      // `segments: true` brings the per-leg boards back in the same request
      // (TRANSIT.md §5) — one round trip over a phone's link, one failure to handle.
      // `commit` is the journey the board is tracking (TRANSIT.md §7), which a board
      // asked "from now" could not otherwise contain once it has departed.
      fetchTransitCommute(query, { baseUrl: serverOrigin, signal, segments: true, commit }),
    [serverOrigin],
  );
  // The commute board picks stops and lines with the same seams the route
  // planner uses — one stop search, one line list, so the two cannot disagree
  // about what a stop is.
  const stopLinesFetch = useMemo<StopLinesFn>(
    () => (stopId, signal) => fetchTransitStopLines(stopId, { baseUrl: serverOrigin, signal }),
    [serverOrigin],
  );
  const commute = useCommute(data, data.places, commuteFetch, commuteOpen);
  const makePlannedCommute = useCallback(() => {
    if (!plannedCommute || !commute.ready) return;
    commute.saveCommute(plannedCommute.config, plannedCommute.name);
    route.stop();
    setCommuteOpen(true);
  }, [commute, plannedCommute, route]);
  const openCommuteJourney = useCallback(
    (trip: TransitTrip) => {
      if (!commute.query) return;
      route.restore(routePlanFromCommute(commute.query));
      transit.prepareJourney(trip.startMs, commute.query.filter.modes);
      transit.setEnabled(true);
      setCommuteOpen(false);
    },
    [commute.query, route, transit],
  );
  // Only speak for the home-screen widget once the saved commute has actually
  // been read. Every launch passes through `query === null` first, and handing
  // that to the widget clears its stored question and blanks it to "Open Atlas
  // to set up your commute" — for a moment normally, and permanently if the app
  // is killed before storage answers. A widget's whole point is working without
  // the app, so it must never be reset by the app merely starting.
  useEffect(() => {
    if (!commute.ready) return;
    // Both widgets, from the one saved commute: v1 ("Atlas commute") and v2
    // ("Atlas commute (live)", docs/TRANSIT.md §W1–§W7) coexist on the home screen while v2
    // is being commuted with, and each keeps its own native store — so each is
    // told separately rather than through one call with a flag.
    void configureCommuteWidget(serverOrigin, commute.widgetQuery);
    void configureCommuteWidgetV2(serverOrigin, commute.widgetQuery);
  }, [commute.widgetQuery, commute.ready, serverOrigin]);
  const widgetCommuteRef = useRef<string | null>(null);
  useEffect(() => {
    if (!commute.ready) return;
    if (widgetCommuteRef.current === null) {
      widgetCommuteRef.current = commute.widgetCommuteId;
      return;
    }
    if (widgetCommuteRef.current === commute.widgetCommuteId) return;
    widgetCommuteRef.current = commute.widgetCommuteId;
    // A commitment identifies a journey inside the previous query. Carrying
    // it across a deliberate widget-commute change could make the new board
    // follow a similarly numbered service from the wrong corridor.
    void setCommuteWidgetCommit(null);
  }, [commute.ready, commute.widgetCommuteId]);
  // TRANSIT.md §7's last piece: the journey the board tracks is the journey the
  // widget tracks. Every *change* goes down, including a release, which clears
  // every instance.
  //
  // Every change, and pointedly not the value the app started with. That value
  // is not a decision — it is what was already on disk — and pushing it at
  // launch would clear a commitment made by tapping the widget while the app
  // was closed, before the read below could ever see it. A widget pinned after
  // a commitment was made therefore starts untracked and catches up on the next
  // tap, which is the right way round: TRANSIT.md §W3 forbids inventing a commitment,
  // never withholding one.
  const pushedCommitRef = useRef(false);
  useEffect(() => {
    if (!commute.ready) return;
    // Looking at another saved commute must not retarget or clear the widget's
    // tracked journey. Only the commute explicitly marked for the home screen
    // shares this decision with native widget instances.
    if (commute.activeId !== commute.widgetCommuteId) return;
    if (!pushedCommitRef.current) {
      pushedCommitRef.current = true;
      return;
    }
    void setCommuteWidgetCommit(commute.commit);
  }, [commute.activeId, commute.commit, commute.ready, commute.widgetCommuteId]);
  // The other direction: a tap made on the *widget*, which happens on the home
  // screen with the app in the background or gone. Read on every return to the
  // foreground — not when the board opens, because Atlas comes back from the
  // launcher with the sheet it left open and "the board opened" would never
  // fire for the one journey that needs it.
  //
  // Adopted only when it is *newer* than what the board holds, and never the
  // absence of one. That asymmetry is the load-bearing part: a released widget
  // and a home screen with no v2 widget on it answer identically here (null),
  // so adopting null would quietly drop the commitment of every user who has
  // never pinned one.
  const commitRef = useRef(commute.commit);
  commitRef.current = commute.commit;
  const setCommuteCommit = commute.setCommit;
  useEffect(() => {
    if (!commute.ready) return;
    if (commute.activeId !== commute.widgetCommuteId) return;
    let current = true;
    const adopt = () => {
      void readCommuteWidgetCommit().then((pinned) => {
        if (!current || !pinned) return;
        if ((pinned.committedAtMs ?? 0) <= (commitRef.current?.committedAtMs ?? 0)) return;
        setCommuteCommit(pinned);
      });
    };
    adopt();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') adopt();
    });
    return () => {
      current = false;
      subscription.remove();
    };
  }, [commute.activeId, commute.ready, commute.widgetCommuteId, setCommuteCommit]);
  // The measure / radius tool. While open it owns map taps — the same contract
  // web gives it — and its state is the shared useMeasure controller.
  const measure = useMeasure();
  const [navHeight, setNavHeight] = useState(0);
  const [offlineRegion, setOfflineRegion] = useState<{
    corner: LatLng | null;
    bbox: BBox | null;
  } | null>(null);
  const [pendingRegion, setPendingRegion] = useState<BBox | null>(null);
  // "Keep this area offline": the framed area of the switched-on
  // derived surface, waiting for a name, and whether one is being packed.
  const [keepArea, setKeepArea] = useState<{ layer: string; target: string; bbox: BBox } | null>(
    null,
  );
  const [keeping, setKeeping] = useState(false);
  // Point the weather & conditions sheet is showing (null = closed).
  const [weatherTarget, setWeatherTarget] = useState<LatLng | null>(null);
  const weather = useWeather(weatherTarget);
  // Point whose share-format chooser is open (null = closed).
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  // Show the location puck once the user has asked to be located (also true
  // while navigating). Idle recentres are one-shot fly-tos, so tapping locate
  // never locks the camera and fights a pan.
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);

  // Bring a picked point into view. `minZoom` is a floor, never a target: with
  // it, a place picked from a search or a list is guaranteed to be readable;
  // without it the zoom is left exactly where the user set it (see pickOnMap —
  // a long-press used to snap the whole map to z14 under the user's finger).
  const flyTo = useCallback((p: LatLng, minZoom?: number) => {
    void (async () => {
      const current = minZoom === undefined ? undefined : await mapRef.current?.getZoom();
      cameraRef.current?.flyTo({
        center: [p.lng, p.lat],
        duration: 900,
        // Omitted entirely (not `undefined`) so the native stop keeps the zoom.
        ...(minZoom === undefined ? {} : { zoom: Math.max(minZoom, current ?? minZoom) }),
      });
    })();
  }, []);

  // Every picked point — map tap, long-press, search hit, favorite, link pin.
  const dest = useDestination(flyTo);
  const { pickPoint } = dest;
  // A pin carried by a launch/deep link opens its card; the camera is already
  // on its way there from the link's own view, so it must not fly again.
  const onLinkPin = useCallback((pin: LatLng) => pickPoint(pin, false), [pickPoint]);
  // With the weather sheet open, picking or dragging a pin re-aims the forecast.
  // Placing a pin somewhere is the user pointing at a place; leaving the sheet
  // describing the previous one is simply the wrong answer. Only while it is
  // open — this never opens the sheet by itself.
  // The saved place the card's spot already *is*, if any — the identity it was
  // picked with when it has one, otherwise the shared proximity match. Deciding
  // from `canSave` alone offered "Save pin" a second time when the user tapped
  // the POI rather than the pin they had saved on it, and made a duplicate; web
  // has keyed off `savedPlaceAt` since the card shipped.
  const savedAtDestination = useMemo(() => {
    const at = dest.destination;
    if (!at) return undefined;
    if (at.placeId) {
      const byId = data.places.find((place) => place.id === at.placeId);
      if (byId) return byId;
    }
    return savedPlaceAt(data.places, { lat: at.lat, lng: at.lng });
  }, [dest.destination, data.places]);
  const pickedLat = dest.destination?.lat;
  const pickedLng = dest.destination?.lng;
  useEffect(() => {
    if (pickedLat === undefined || pickedLng === undefined) return;
    setWeatherTarget((cur) => (cur ? { lat: pickedLat, lng: pickedLng } : cur));
  }, [pickedLat, pickedLng]);
  // Where the map opens, where it is now, and remembering that for next launch.
  // The commute widget's tap arrives as `#panel=commute` — open the board it was
  // showing, rather than dropping the user wherever the app was last.
  const onLinkPanel = useCallback((panel: 'commute') => {
    if (panel === 'commute') setCommuteOpen(true);
  }, []);
  const camera = useBootCamera(data, cameraRef, onLinkPin, onLinkPanel);
  const { initialView, viewRef, mapZoom, getBias } = camera;
  const currentExploreArea = useMemo<ExploreArea | null>(() => {
    if (!camera.mapViewport) return null;
    const center = {
      lat: (camera.mapViewport.bbox[1] + camera.mapViewport.bbox[3]) / 2,
      lng: (camera.mapViewport.bbox[0] + camera.mapViewport.bbox[2]) / 2,
    };
    return {
      center,
      radiusM: clampExploreRadiusM(
        haversineM(center, {
          lat: camera.mapViewport.bbox[3],
          lng: camera.mapViewport.bbox[2],
        }),
      ),
    };
  }, [camera.mapViewport]);
  const fetchPois = useCallback<PoiViewportFetch>(
    async ({ tiles, categories, signal }) => {
      const response = await fetch(poiTilesUrl(serverOrigin, tiles, categories), { signal });
      if (!response.ok) throw new Error(`POIs: HTTP ${response.status}`);
      return ((await response.json()) as { tiles: PoiTileResults[] }).tiles;
    },
    [serverOrigin],
  );
  // POI distance is ambient, not navigation state: one fix when the layer opens
  // and another when the user refreshes the list, so the numbers are as old as
  // the list they sit in and no watcher runs for a card nobody opened.
  //
  // It never asks for the permission itself. Turning a layer on is not where a
  // person expects a location prompt; the locate button and navigation are, and
  // once either has been granted this reads the fix they already produced. No
  // permission and no fix are the same ordinary outcome — the rows keep their
  // names and show no distance (the test AVD is always in that state).
  const [poiOrigin, setPoiOrigin] = useState<LatLng | null>(null);
  const readPoiOrigin = useCallback(async () => {
    try {
      const permission = await Location.getForegroundPermissionsAsync();
      if (!permission.granted) return;
      const cached = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 });
      const position =
        cached ??
        (await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
        ]));
      if (position) {
        setPoiOrigin({ lat: position.coords.latitude, lng: position.coords.longitude });
      }
    } catch {
      // A missing provider or a timed-out fix both simply mean no distance.
    }
  }, []);
  useEffect(() => {
    if (overlaysCtl.poiOn) void readPoiOrigin();
  }, [overlaysCtl.poiOn, readPoiOrigin]);
  const viewportPois = usePoiViewport({
    active: overlaysCtl.poiOn,
    viewport: camera.mapViewport,
    categories: overlaysCtl.poiCategories,
    fetchPois,
  });
  // Refreshing the list is also the moment to re-ask where the user is.
  const refreshPoiList = useCallback(() => {
    void readPoiOrigin();
    viewportPois.refresh();
  }, [readPoiOrigin, viewportPois]);
  const poiList = usePoiList({
    active: overlaysCtl.poiOn,
    viewport: camera.mapViewport,
    categories: overlaysCtl.poiCategories,
    liveResults: viewportPois.results,
    loading: viewportPois.loading,
    liveRevision: viewportPois.revision,
    origin: poiOrigin,
    refreshLive: refreshPoiList,
  });
  // Stop search for the commute board's ends, biased to where the map is looking.
  const stopGeocode = useGeocode(packs, getBias);
  // The half-built plan survives the app being killed in the background, and a
  // plan someone sent by link wins over it — the same hook, with the same
  // precedence, as the web app. It sits below useBootCamera because the
  // link is what that hook resolves, and until it has, the saved plan waits.
  useRoutePlanPersistence(route, data, camera.linkPlan);
  // Downloaded tiles win wherever a pack covers the view (Settings can force
  // server tiles); everything else — search, routing, weather — stays online-first.
  // Resolved here rather than beside the other pack state below, because the
  // overlay list is built from it: a derived surface is drawn from a pack too.
  const tiles = useTileSource(data, packs, camera.viewCenter);
  const overlayLabels = useOverlayLabels(overlaysCtl.overlays, camera.labelCell);
  // Derived potential surfaces: prepare the cells under the viewport and
  // say what is happening while they build. `readyKey` rides into the raster
  // source id below, so a cell that lands appears without a pan.
  const potential = usePotential(
    serverOrigin,
    overlaysCtl.derived,
    camera.mapViewport,
    overlaysCtl.derived?.meta.derived?.vocabulary,
  );
  const overlays = useMemo(
    () =>
      // …and a surface the user kept offline is then pointed at the
      // pack's own tiles instead of the derive service.
      withLocalSurfaces(
        overlaysCtl.overlays.map((overlay) =>
          overlay.meta.derived && potential.readyKey
            ? { ...overlay, sourceId: `${overlay.sourceId}--${potential.readyKey}` }
            : overlay,
        ),
        packs,
        camera.viewCenter,
        tiles.preferOnline,
      ),
    [overlaysCtl.overlays, potential.readyKey, packs, camera.viewCenter, tiles.preferOnline],
  );
  // The Statskog jaktfelt vector overlay's coverage (one GeoJSON fetch), drawn
  // by MapScene while the overlay is on — the Fish & Hunt signature layer.
  // "Why is this water good?" for the point the card is describing. The derived
  // layers are not identify-capable overlays — a tap is answered with reasoning
  // rather than upstream attributes — so this lands on the card directly.
  const potentialExplain = usePotentialExplain(
    serverOrigin,
    overlaysCtl.derived,
    pickedLat === undefined || pickedLng === undefined ? null : { lat: pickedLat, lng: pickedLng },
  );
  // The Fish & Hunt sub-profile: which animal the derived surface is tuned for,
  // and the one-tap way to change it. Also the source of the target's *name*,
  // which the spots sheet and a saved spot both label themselves with.
  const potentialTargets = usePotentialTarget(overlaysCtl);
  const potentialTargetLabel = potentialTargets.active?.label;
  // The other half of that idea, for every layer the quarry switch does not own:
  // the chips of whatever is currently drawn, reachable from the map. What makes
  // Curiosities readable — every register in it is a filtered register.
  const layerFilters = useLayerFilters(overlaysCtl);
  // The shortlist a derived surface turns into a plan. Opened by
  // hand: it is a real request against the derive service and the router, not a
  // legend that could just appear.
  const [spotsOpen, setSpotsOpen] = useState(false);
  useEffect(() => {
    if (!overlaysCtl.derived) setSpotsOpen(false);
  }, [overlaysCtl.derived]);
  const bestSpots = useBestSpots(serverOrigin, overlaysCtl.derived, camera.mapViewport, {
    enabled: spotsOpen,
    readyKey: potential.readyKey,
    vocabulary: overlaysCtl.derived?.meta.derived?.vocabulary,
    areas: planningAreas,
  });
  // The other half of a hunting season: not "where should I sit" but "which of
  // the stands I already have is on tonight". Opened by hand for the same reason
  // the shortlist is — it reads a forecast per stand.
  const [standBoardOpen, setStandBoardOpen] = useState(false);
  const standBoard = useStandBoard(serverOrigin, data.places, {
    enabled: standBoardOpen,
    near: camera.mapViewport
      ? {
          lat: (camera.mapViewport.bbox[1] + camera.mapViewport.bbox[3]) / 2,
          lng: (camera.mapViewport.bbox[0] + camera.mapViewport.bbox[2]) / 2,
        }
      : null,
  });
  // "Keep this area offline". Offered only for a derived surface
  // that is switched on and has a settled viewport, because what it keeps is
  // the area on screen — and it reports "kept" instead once a downloaded pack
  // already carries this ground, since a second copy is never what was wanted.
  const keptOffline =
    overlaysCtl.derived !== null &&
    packWithSurface(
      packs,
      overlaysCtl.derived.layer,
      overlaysCtl.derived.target,
      camera.viewCenter,
    ) !== undefined;
  const keepOfflineControls = useMemo(() => {
    const derived = overlaysCtl.derived;
    const view = camera.mapViewport;
    if (!derived || !view) return undefined;
    return {
      busy: keeping,
      kept: keptOffline,
      onKeep: () => {
        // The sheet covers the map it is about to pack; close it so the naming
        // prompt sits over the area being kept.
        setLayersOpen(false);
        setKeepArea({ layer: derived.layer, target: derived.target, bbox: viewBbox(view.bbox) });
      },
    };
  }, [overlaysCtl.derived, camera.mapViewport, keeping, keptOffline]);
  const huntingFields = useHuntingFields(overlays, serverOrigin);
  const iceObservations = useIceObservations(overlays, serverOrigin, camera.mapViewport);
  const lightningOn = overlays.some((overlay) => overlay.meta.id === LIGHTNING_OBSERVATIONS_ID);
  const auroraOn = overlays.some((overlay) => overlay.meta.id === AURORA_FORECAST_ID);
  const skyLayers = useSkyLayers(serverOrigin, auroraOn);
  const lightning = useLightning(
    overlays,
    serverOrigin,
    camera.mapViewport,
    skyLayers.lightning.window,
  );
  // The horizon circle is drawn against whatever point the sheet is predicting
  // for, so switching to "map centre" moves the disc with it.
  const satelliteFootprint = useMemo(
    () =>
      satelliteSelection
        ? { minElevationDeg: satelliteMinElevation, observer: satelliteSelection.observer }
        : null,
    [satelliteSelection, satelliteMinElevation],
  );
  const satellites = useSatellites(
    overlays,
    serverOrigin,
    SATELLITES_ID,
    satelliteSelection?.layerId === SATELLITES_ID ? satelliteSelection.noradId : null,
    satelliteSelection?.layerId === SATELLITES_ID ? satelliteFootprint : null,
  );
  const starlink = useSatellites(
    overlays,
    serverOrigin,
    STARLINK_ID,
    satelliteSelection?.layerId === STARLINK_ID ? satelliteSelection.noradId : null,
    satelliteSelection?.layerId === STARLINK_ID ? satelliteFootprint : null,
  );
  const selectedSatellite = useMemo<SatelliteOmm | null>(() => {
    if (!satelliteSelection) return null;
    const source = satelliteSelection.layerId === SATELLITES_ID ? satellites : starlink;
    return (
      source.elements.find((element) => element.NORAD_CAT_ID === satelliteSelection.noradId) ?? null
    );
  }, [satelliteSelection, satellites.elements, starlink.elements]);
  useEffect(() => {
    if (!satelliteSelection) return;
    const source = satelliteSelection.layerId === SATELLITES_ID ? satellites : starlink;
    if (!source.active || (source.status === 'ready' && !selectedSatellite)) {
      setSatelliteSelection(null);
    }
  }, [satelliteSelection, satellites, starlink, selectedSatellite]);
  // The ATK speed cameras as a map layer (the Drive signature overlay). The
  // *guidance* warnings are a separate, offline-first path (offlineNvdb) — this
  // is only the drawn layer.
  const speedCameras = useSpeedCameras(overlays, serverOrigin);
  const traffic = useTraffic(overlays, serverOrigin);
  const trafficFlow = useTrafficFlow(overlays, serverOrigin);
  const roadWeather = useRoadWeather(overlays, serverOrigin);
  // Weather layers: a field's timeline, grid labels and the dock that appears
  // while one is on, plus MET's warnings — the same catalog rows as the web.
  const weatherLayers = useWeatherLayers(overlays, serverOrigin, camera.mapViewport);
  const weatherWarnings = useWeatherWarnings(overlays, serverOrigin);
  const weatherTitle = overlays.find((overlay) => overlay.meta.weather)?.meta.title ?? '';
  const timeDockOn = Boolean(weatherLayers.maps.layerId) || lightningOn || auroraOn;
  const mapDockOn = timeDockOn || overlaysCtl.poiOn;
  const [weatherDockHeight, setWeatherDockHeight] = useState(0);
  const weatherMapsRef = useRef(weatherLayers.maps);
  weatherMapsRef.current = weatherLayers.maps;
  // With a weather map up, a tap asks what the weather is there, at the time shown.
  const weatherAtTap = useCallback(
    async (at: LatLng) => {
      const { layerId, frame } = weatherMapsRef.current;
      if (!layerId || !frame) return [];
      const res = await fetch(weatherPointUrl(serverOrigin, at, Date.parse(frame.time)));
      if (!res.ok) return [];
      const group = weatherPointIdentify((await res.json()) as WeatherPointSample, layerId);
      return group ? [group] : [];
    },
    [serverOrigin],
  );
  const transitVehicles = useTransitVehicles(overlays, serverOrigin, camera.mapViewport);

  // The system consumes the first Back press while the keyboard is visible.
  // Once it is hidden, keep the next press inside Atlas by closing the search
  // overlay instead of letting Android background the whole activity.
  useEffect(() => {
    if (!searchOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setSearchOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [searchOpen]);

  // While a trip is active the nav banner owns the top of the screen, so drop
  // the search bar + button column below its measured height (issue: the banner
  // was covering both). `following` also turns the map course-up (issue: no map
  // orientation while travelling).
  const navActive = nav.phase !== 'idle';
  const guiding = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const following = nav.phase === 'exploring' || guiding;
  const win = useWindowDimensions();
  // Leaving Atlas mid-trip shrinks it into a floating mini window instead of
  // hiding guidance. That window is its own tiny screen: no system bars, no
  // guidance rail, and only the compact card at the bottom to keep clear of.
  const pip = useNavigationPip(nav, data);
  const inPip = pip.inPictureInPicture;
  // Android's configuration stays in dp when React Native briefly reports the
  // physical PiP task bounds. Both camera and card must use the same real size.
  const compactWin = inPip ? pipWindowSize(win) : win;
  const viewport = useMemo(
    () =>
      inPip
        ? navViewport(
            compactWin.width,
            compactWin.height,
            NO_SIDE_INSETS,
            0,
            // Keep the puck clear of the guidance strip, whose height is the
            // window's own (NavPipCard scales with the size the user gave it).
            pipCardMetrics(compactWin.width, compactWin.height).height,
            true,
          )
        : navViewport(win.width, win.height, side, topInset, bottomInset),
    [
      win.width,
      win.height,
      compactWin.width,
      compactWin.height,
      side,
      topInset,
      bottomInset,
      inPip,
    ],
  );
  const landscape = viewport.landscape;
  // Mute and map orientation survive across trips (device-local, web parity).
  const navPrefs = useNavPrefs(data, nav);
  // A trip that died with the process — killed foreground service, crash, a
  // cold start after too long away — is offered back on the next launch.
  const navResume = useNavResume(data, {
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
  // The follow camera uses the same responsive viewport as the visible puck:
  // centred in portrait, or in the unobstructed right pane in landscape.
  const navCam = useNavCamera(cameraRef, nav, navPrefs.followMode, viewport, inPip ? 0 : navHeight);
  // Shrinking into the mini window re-engages the follow camera. A map left
  // panned aside or in route overview would otherwise fold into a floating
  // window that never moves — the one thing that window exists to show — and
  // at that size there is no re-centre control to get it back.
  const { resumeFollow } = navCam;
  useEffect(() => {
    if (inPip) resumeFollow();
  }, [inPip, resumeFollow]);
  const navPuck = useNavPuck(nav, navCam, navPrefs.followMode, viewport);
  const tunnelDim = useTunnelDim(nav.state?.fix, nav.state?.tunnel != null);
  // Category candidates via the online explore endpoint with the downloaded
  // pack index as fallback (geoExplore) — shared by the mid-drive "add a stop"
  // panel (what is still ahead) and the planner's "stops along route" browse
  // (the whole route). Both sets of rules live in @atlas/app-hooks.
  const fetchNearbyStops = useCallback<FetchNearbyFn>(
    async (category, center, radiusM) =>
      (await geoExplore(packs, category, center, radiusM)).results,
    [packs],
  );
  const navAddStop = useNavAddStop({ nav, fetchNearby: fetchNearbyStops });
  // Route-choice preview: the choice card owns the bottom of the screen and
  // map taps switch between the drawn choices (no banner at the top).
  const previewing = nav.phase === 'preview';
  const attributionPosition =
    navActive && !previewing
      ? landscape
        ? { top: topInset + 8, left: viewport.mapLeft + 8 }
        : { top: topInset + navHeight + 20, left: side.left + 8 }
      : { top: topInset + 8, left: side.left + 8 };
  // A bottom sheet owns the lower screen while open. Hide the idle map chrome
  // below it instead of letting later-rendered buttons float over its content.
  const idleSheetOpen =
    searchOpen ||
    exploreOpen ||
    menuOpen ||
    measure.open ||
    commuteOpen ||
    dest.destination !== null ||
    satelliteSelection !== null ||
    offlineRegion !== null;
  // Landscape is short, so several pieces of chrome move into the leading
  // guidance rail and route fits get a narrower bottom pad.

  // Mid-trip taps must not fly the camera away from the follow view — the
  // card opens where the puck already is. Idle, the point is panned clear of
  // the card at the zoom the user is already on (pickOnMap).
  const pickPressTarget = useCallback(
    (target: DestinationTarget) => {
      setSatelliteSelection(null);
      if (guiding) dest.pickQuiet(target);
      else if (nav.phase !== 'exploring') dest.pickOnMap(target);
    },
    [guiding, nav.phase, dest],
  );
  // Picking a spot — from the sheet or from its marker — opens the *same* card
  // a tap on the water opens, so the reasoning and Save are the ones the user
  // already knows. The number rides in the title so card and list agree about
  // which spot this is.
  const { pickOnMap } = dest;
  const onPickSpot = useCallback(
    (spot: PotentialSpot, index: number) => {
      pickOnMap({
        lat: spot.position.lat,
        lng: spot.position.lng,
        name: `${spot.stand ? 'Stand' : 'Spot'} ${index + 1}`,
        detail: spot.stand ? spot.reason : spot.bandLabel,
        canSave: true,
      });
    },
    [pickOnMap],
  );
  // A board row opens the *saved place*, not a copy of it: the card at those
  // coordinates is the one carrying the stand block, the rose and the notes.
  const onPickStand = useCallback(
    (row: StandBoardRow) => {
      pickOnMap({
        lat: row.position.lat,
        lng: row.position.lng,
        name: row.name,
        detail: 'Stand',
        canSave: true,
      });
    },
    [pickOnMap],
  );
  const onPickSpotById = useCallback(
    (id: string) => {
      const index = bestSpots.spots.findIndex((candidate) => candidate.id === id);
      const spot = bestSpots.spots[index];
      if (spot) onPickSpot(spot, index);
    },
    [bestSpots.spots, onPickSpot],
  );
  const onPickPoi = useCallback(
    (result: PoiResult) => {
      pickOnMap({
        lat: result.position.lat,
        lng: result.position.lng,
        name: result.name,
        detail: result.category,
        poiCategoryId: result.categoryId,
        address: result.address,
        phone: result.phone,
        openingHours: result.openingHours,
        website: result.website,
        osmUrl: result.osmUrl,
        canSave: true,
        showMapMarker: false,
      });
    },
    [pickOnMap],
  );
  const onPickPoiFromList = useCallback(
    (result: PoiResult) => {
      // The list is a snapshot, so the map may have been panned away from the
      // row the user just picked; bring it into view only then, and otherwise
      // leave the map exactly where they left it.
      const bbox = camera.mapViewport?.bbox;
      const inView =
        bbox &&
        bboxContains(
          { sw: { lng: bbox[0], lat: bbox[1] }, ne: { lng: bbox[2], lat: bbox[3] } },
          result.position,
        );
      if (!inView) flyTo(result.position);
      dest.pick({
        lat: result.position.lat,
        lng: result.position.lng,
        name: result.name,
        detail: result.category,
        poiCategoryId: result.categoryId,
        address: result.address,
        phone: result.phone,
        openingHours: result.openingHours,
        website: result.website,
        osmUrl: result.osmUrl,
        canSave: true,
        showMapMarker: false,
      });
    },
    [camera.mapViewport, dest, flyTo],
  );
  const onPickExplore = useCallback(
    (result: SearchResult) => {
      setExploreSelection(
        `${result.name}/${result.position.lat.toFixed(6)}/${result.position.lng.toFixed(6)}`,
      );
      setExploreOpen(false);
      dest.pickResult(result);
    },
    [dest],
  );
  useEffect(() => {
    if (!exploreSelection) return;
    const destinationKey = dest.destination?.name
      ? `${dest.destination.name}/${dest.destination.lat.toFixed(6)}/${dest.destination.lng.toFixed(6)}`
      : null;
    if (destinationKey === exploreSelection) return;
    setExploreSelection(null);
    setExploreResults([]);
  }, [dest.destination, exploreSelection]);
  // A spot saved from the shortlist keeps its reasoning in the notes: the pin
  // syncs and comes along offline, where the surface that produced it will not.
  const onSaveSpot = useCallback(
    (spot: PotentialSpot, index: number) => {
      void data.savePlace(spotPlaceDraft(spot, index, { targetLabel: potentialTargetLabel }));
    },
    [data, potentialTargetLabel],
  );
  const onPickSatellite = useCallback(
    (hit: { layerId: string; noradId: number }) => {
      const layerId = hit.layerId === STARLINK_ID ? STARLINK_ID : SATELLITES_ID;
      const source = layerId === SATELLITES_ID ? satellites : starlink;
      if (!source.elements.some((element) => element.NORAD_CAT_ID === hit.noradId)) return;
      const center = viewRef.current?.center ?? DEFAULT_VIEW.center;
      dest.clear();
      setSatelliteLocationError(false);
      setSatelliteSelection({
        layerId,
        noradId: hit.noradId,
        observer: center,
        observerSource: 'map',
      });
    },
    [dest, satellites, starlink, viewRef],
  );
  const { onMapPress: onRegularMapPress, onPickPoint: onRegularPickPoint } = useMapPress({
    mapRef,
    nav,
    route,
    places: visiblePlaces,
    overlays,
    origin: serverOrigin,
    menuOpen,
    closeMenu: () => setMenuOpen(false),
    pickDestination: pickPressTarget,
    showIdentify: dest.showIdentify,
    pickSatellite: onPickSatellite,
    spots: spotsOpen ? bestSpots.spots : undefined,
    pickSpot: onPickSpotById,
    exploreResults,
    pickExplore: onPickExplore,
    poiResults: viewportPois.results,
    pickPoi: onPickPoi,
    leadingIdentify: weatherAtTap,
  });
  const selectOfflineRegionPoint = useCallback((point: LatLng) => {
    setOfflineRegion((current) => {
      if (!current) return current;
      if (!current.corner) return { corner: point, bbox: null };
      return {
        corner: current.corner,
        bbox: {
          sw: {
            lat: Math.min(current.corner.lat, point.lat),
            lng: Math.min(current.corner.lng, point.lng),
          },
          ne: {
            lat: Math.max(current.corner.lat, point.lat),
            lng: Math.max(current.corner.lng, point.lng),
          },
        },
      };
    });
  }, []);
  // `addPoint` keeps its identity across mode changes (it reads the mode through
  // a ref), so these handlers stay stable while the tool is open.
  const { open: measuring, addPoint: addMeasurePoint } = measure;
  const onMapPress = useCallback(
    (point: LatLng, pixel: { x: number; y: number }) => {
      if (measuring) {
        addMeasurePoint(point);
        return;
      }
      if (offlineRegion) {
        selectOfflineRegionPoint(point);
        return;
      }
      onRegularMapPress(point, pixel);
    },
    [measuring, addMeasurePoint, offlineRegion, onRegularMapPress, selectOfflineRegionPoint],
  );
  const onPickPoint = useCallback(
    (point: LatLng) => {
      // A long press measures too, like it adds a stop while planning: a tool
      // that owns the map must own both gestures, or the other one drops a
      // destination pin behind the sheet.
      if (measuring) {
        addMeasurePoint(point);
        return;
      }
      if (offlineRegion) {
        selectOfflineRegionPoint(point);
        return;
      }
      onRegularPickPoint(point);
    },
    [measuring, addMeasurePoint, offlineRegion, onRegularPickPoint, selectOfflineRegionPoint],
  );

  // A described place picked from the card's nearby list becomes the card's new
  // subject — the same treatment as a search hit, so the article, its photo and
  // the actions all follow it. Panned into view without changing the zoom, like
  // every other pick that comes from the map surface.
  const onPickNearbyPlace = useCallback(
    (place: NearbyPlaceArticle) => {
      dest.pickOnMap({
        lat: place.position.lat,
        lng: place.position.lng,
        name: place.title,
        canSave: true,
      });
    },
    [dest],
  );

  // Picking an activity also chooses the route planner's starting mode where
  // one exists. Explore and Ski intentionally leave its last mode alone.
  const onPickMapProfile = useCallback(
    (id: string) => {
      const next = mapProfile(id);
      profiles.setProfile(id);
      const routing = next.routing;
      if (routing !== null && isRoutingProfile(routing)) route.setProfile(routing);
    },
    [profiles, route],
  );

  // Entering the route-choice preview (or switching choice): fit the whole
  // selected route on screen, clear of the top inset and the choice card.
  useEffect(() => {
    if (nav.phase !== 'preview') return;
    const path = nav.previewPaths?.[nav.previewIndex];
    if (!path) return;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const p of path.points) {
      if (p.lng < west) west = p.lng;
      if (p.lng > east) east = p.lng;
      if (p.lat < south) south = p.lat;
      if (p.lat > north) north = p.lat;
    }
    if (!Number.isFinite(west) || west === east || south === north) return;
    // The choice card covers the bottom in portrait but the left in landscape
    // (a 300 dp bottom pad would swallow a landscape screen whole).
    // Mirrors the RoutePreview card width so the fit clears it exactly.
    const cardW = Math.min(420, Math.round(win.width * 0.45));
    cameraRef.current?.fitBounds([west, south, east, north], {
      padding: landscape
        ? {
            top: topInset + 48,
            right: side.right + 48,
            bottom: bottomInset + 48,
            left: side.left + cardW + 40,
          }
        : {
            top: topInset + 48,
            right: side.right + 48,
            bottom: bottomInset + 300,
            left: side.left + 48,
          },
      duration: 700,
    });
  }, [
    nav.phase,
    nav.previewPaths,
    nav.previewIndex,
    topInset,
    bottomInset,
    side,
    landscape,
    win.width,
  ]);

  // A journey card can collapse the planner and ask to see its actual shape.
  // Frame every walk/ride leg, leaving room for the peek sheet that remains.
  const showTransitTrip = useCallback(
    (trip: TransitTrip) => {
      const bounds = transitTripBounds(trip);
      if (!bounds) return;
      cameraRef.current?.fitBounds(bounds, {
        padding: {
          top: topInset + 40,
          right: side.right + 40,
          bottom: bottomInset + (landscape ? 220 : 300),
          left: side.left + 40,
        },
        duration: 700,
      });
    },
    [bottomInset, landscape, side, topInset],
  );

  /** Start guidance to the planner's destination in the chosen road profile. */
  const startNavigation = useCallback(
    (target: LatLng, viaPoints: LatLng[]) => {
      // Route selection moves from the planner to Navigation's route-choice
      // preview. Close the planner immediately so it cannot cover that sheet,
      // and so its background route/mode requests are cancelled while
      // Navigation obtains a current-position route exactly once.
      const profile = route.profile;
      const preferences = route.preferences;
      route.stop();
      void nav.start(target, profile, preferences, viaPoints);
    },
    [nav, route],
  );
  const startExplorer = useCallback(() => {
    const profile = route.profile;
    route.stop();
    void nav.explore(profile);
  }, [nav, route]);
  const startTransitGuidance = useCallback(
    (trip: TransitTrip) => {
      transit.startGuidance(trip);
      showTransitTrip(trip);
      route.stop();
      void scheduleTransitAlarms(trip);
    },
    [route, showTransitTrip, transit.startGuidance],
  );
  const stopTransitGuidance = useCallback(() => {
    transit.stopGuidance();
    void cancelTransitAlarms();
  }, [transit.stopGuidance]);

  // Route planning owns the bottom of the screen and repurposes map taps to add
  // stops, so it can't share the screen with a destination card.
  const planning = route.active;
  // Keep the selected route in the map that remains above/beside the planner,
  // instead of fitting it to pixels hidden behind the sheet.
  useEffect(() => {
    if (!planning || transit.enabled) return;
    const path = route.paths?.[route.selectedPath];
    if (!path || path.points.length < 2) return;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const point of path.points) {
      west = Math.min(west, point.lng);
      east = Math.max(east, point.lng);
      south = Math.min(south, point.lat);
      north = Math.max(north, point.lat);
    }
    if (!Number.isFinite(west) || west === east || south === north) return;
    cameraRef.current?.fitBounds([west, south, east, north], {
      padding: landscape
        ? {
            top: topInset + 40,
            right: side.right + 40,
            bottom: bottomInset + 40,
            left: side.left + Math.min(430, Math.round(win.width * 0.5)),
          }
        : {
            top: topInset + 40,
            right: side.right + 36,
            bottom: bottomInset + Math.min(390, Math.round(win.height * 0.48)),
            left: side.left + 36,
          },
      duration: 650,
    });
  }, [
    planning,
    transit.enabled,
    route.paths,
    route.selectedPath,
    landscape,
    topInset,
    bottomInset,
    side,
    win.width,
    win.height,
  ]);
  // Idle map actions are one region with one visibility rule. Navigation owns
  // that region from route startup through arrival/error, not only while its
  // follow camera is running.
  const showIdleChrome = !planning && !navActive && !idleSheetOpen;
  // MapActivityControls stacks a row per quarry and filter switch over its
  // bottom row; the weather dock sits above all of them, and the scale bar and
  // compass step up over the dock.
  const activityRows =
    (potentialTargets.groups.length > 0 ? 1 : 0) + (layerFilters.groups.length > 0 ? 1 : 0);
  // The POI selector is the peeked list sheet, which stands on the same rows the
  // weather dock does — and above the dock when both are up. The scale bar and
  // compass step over whichever reaches higher.
  const poiSheetLift =
    showIdleChrome && overlaysCtl.poiOn
      ? POI_SHEET_PEEK +
        POI_SHEET_HANDLE +
        52 * activityRows +
        (timeDockOn ? weatherDockHeight + 6 : 0)
      : 0;
  const weatherDockLift = Math.max(
    showIdleChrome && mapDockOn ? weatherDockHeight + 52 * activityRows : 0,
    poiSheetLift,
  );

  // Route planning and guidance both repurpose map taps, so the measure tool
  // cannot stay open into either: its sheet is hidden there, and a hidden tool
  // still owning taps would swallow every stop the planner expects.
  const { open: measureOpen, setOpen: setMeasureOpen } = measure;
  useEffect(() => {
    if (measureOpen && (planning || navActive)) setMeasureOpen(false);
  }, [measureOpen, planning, navActive, setMeasureOpen]);

  // Share the planned route as GPX (parity with the web RoutePanel export).
  const exportRoute = useCallback(
    (path: RoutePath) => {
      const profile = ROUTING_PROFILES.find((p) => p.id === route.profile);
      const name = `Atlas ${profile?.label.toLowerCase() ?? route.profile} route`;
      void shareText(
        `atlas-route-${route.profile}.gpx`,
        buildGpx(routePathToTrackData(path, name)),
      );
    },
    [route.profile],
  );

  // Share the plan as a link that reopens it — web copies the URL its address
  // bar already carries, and an Android phone has neither an address bar nor a
  // clipboard the recipient can reach, so the same link goes to the OS share
  // sheet. The link is the *plan*, not the routed line: the recipient's app
  // re-routes the stops with its own settings and current data.
  const shareRouteLink = useCallback(() => {
    const plan = route.plan;
    if (!plan) return;
    // Before the first settled camera event, the boot view is what the map is
    // showing; DEFAULT_VIEW covers the moment before even that resolves.
    const view = viewRef.current ?? initialView ?? DEFAULT_VIEW;
    void Share.share({ message: atlasRouteUrl(`${serverOrigin}/`, routePlanState(plan), view) });
  }, [route.plan, viewRef, initialView, serverOrigin]);

  // Pick GPX/KML/KMZ files from the device and import them (parser validates by
  // name/content, so we allow any type through the picker). `options` carries
  // the folder the sheet asked for; backups keep their own structure regardless.
  const importTracks = useCallback(
    async (options?: ImportOptions) => {
      const res = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return null;
      return data.importFiles(
        res.assets.map((a) => ({ name: a.name, uri: a.uri })),
        options,
      );
    },
    [data],
  );

  // Frame a track on the map from its Collections row — its whole shape, which
  // is the only view that says which track this actually is — and read out its
  // climb underneath, which is the other half of the same question and the half
  // web has always answered. A track with no parseable geometry opens the
  // profile saying so, and simply doesn't move the camera.
  const showTrack = useCallback(
    (track: TrackRecord) => {
      setTrackProfile({ track, data: null });
      void data.getTrackData(track.id).then((trackData) => {
        setTrackProfile((current) =>
          current?.track.id === track.id ? { track, data: trackData } : current,
        );
        if (!trackData) return;
        const bounds = trackBounds(trackData);
        if (!bounds) return;
        cameraRef.current?.fitBounds([bounds.sw.lng, bounds.sw.lat, bounds.ne.lng, bounds.ne.lat], {
          padding: {
            top: topInset + 48,
            right: side.right + 48,
            bottom: bottomInset + 48,
            left: side.left + 48,
          },
          duration: 700,
        });
      });
    },
    [data, topInset, bottomInset, side],
  );

  // Follow the record while the profile is up: a rename shows through, and a
  // delete — here or from a synced device — closes it rather than leaving a
  // chart of a track that no longer exists.
  useEffect(() => {
    setTrackProfile((current) => {
      if (!current) return current;
      const track = data.tracks.find((candidate) => candidate.id === current.track.id);
      if (!track) return null;
      return track === current.track ? current : { ...current, track };
    });
  }, [data.tracks]);

  const planTrack = useCallback(
    (track: TrackRecord) => {
      void data.getTrackData(track.id).then((trackData) => {
        if (!trackData) return;
        const points = trackToRoutePoints(trackData);
        if (points.length < 2) return;
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
    [data, route],
  );

  const savePermit = useCallback(
    async (input: string, options?: ImportOptions) => {
      const area = await resolveInaturOffer(serverOrigin, input);
      let collectionId = options?.collectionId ?? null;
      if (options?.newCollection) {
        const collection = await data.createCollection(
          options.newCollection.name,
          options.newCollection.parentId ?? null,
        );
        if (!collection) return null;
        collectionId = collection.id;
      }
      return data.savePermitArea(area, collectionId);
    },
    [serverOrigin, data],
  );

  // The older Tracks entry uses the same area-overlay save and keeps its
  // existing import-summary contract for the status line.
  const importInatur = useCallback(
    async (input: string, options?: ImportOptions) => {
      const track = await savePermit(input, options);
      return track ? { tracks: [track], places: [], errors: [], restored: null } : null;
    },
    [savePermit],
  );

  // Recentre on the user's position. While navigating this re-engages the
  // follow camera after a manual pan; when idle it's a one-shot fly-to that
  // also reveals the location puck.
  const locate = useCallback(async () => {
    if (following) {
      resumeFollow();
      return;
    }
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) return;
      setShowPuck(true);
      const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      cameraRef.current?.flyTo({
        center: [cur.coords.longitude, cur.coords.latitude],
        duration: 700,
      });
      // TRANSIT.md §W2's cached coarse fix, written where a fix is already in hand:
      // this is the app in the foreground with a position the user asked for, so
      // it costs no extra permission and no extra battery. The v2 widget may use
      // it to choose AUTO's *presentation* and nothing else — never the journey,
      // the state or the committed leg — and it is ignored once stale.
      void reportCommutePlace(commute.query, {
        lat: cur.coords.latitude,
        lng: cur.coords.longitude,
      });
    } catch {
      // Location unavailable — nothing to recentre on.
    }
  }, [commute.query, following, resumeFollow]);

  const useMapCenterForSatellite = useCallback(() => {
    const center = viewRef.current?.center ?? DEFAULT_VIEW.center;
    setSatelliteLocationError(false);
    setSatelliteSelection((current) =>
      current ? { ...current, observer: center, observerSource: 'map' } : null,
    );
  }, [viewRef]);

  const useMyLocationForSatellite = useCallback(async () => {
    if (satelliteLocating) return;
    setSatelliteLocating(true);
    setSatelliteLocationError(false);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) throw new Error('location permission denied');
      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const observer = { lat: current.coords.latitude, lng: current.coords.longitude };
      setShowPuck(true);
      setSatelliteSelection((selection) =>
        selection ? { ...selection, observer, observerSource: 'location' } : null,
      );
    } catch {
      setSatelliteLocationError(true);
    } finally {
      setSatelliteLocating(false);
    }
  }, [satelliteLocating, viewRef]);

  const refreshPacks = useCallback(() => {
    void listLocalPacks().then(setPacks);
  }, []);

  // Auto-dismiss the write-error banner; a new failure restarts the timer.
  const { writeError, clearWriteError } = data;
  useEffect(() => {
    if (!writeError) return;
    const t = setTimeout(clearWriteError, 8000);
    return () => clearTimeout(t);
  }, [writeError, clearWriteError]);

  // The undo window for a delete (web parity). Long enough to notice a mistake,
  // short enough that the banner is not permanent chrome; a newer delete
  // replaces the offer. Until this existed, the confirmation Alert's promise
  // that "you can undo this right after" was the only undo on the device.
  const { undoable, clearUndoable } = data;
  useEffect(() => {
    if (!undoable) return;
    const t = setTimeout(clearUndoable, 10000);
    return () => clearTimeout(t);
  }, [undoable, clearUndoable]);

  // Whether the pack currently drawing the map has been rebuilt on the server.
  const freshness = usePackFreshness(packs);
  const packStale =
    tiles.coveringPack !== undefined && freshness.stale.has(tiles.coveringPack.manifest.id);
  // Pack downloads run in a native foreground service, so they survive leaving
  // Atlas; this reconciles them on every return (installing whatever finished
  // meanwhile) and keeps rebuilt regions current by themselves over Wi-Fi.
  const downloads = usePackDownloads(refreshPacks);
  const offlinePrefs = useOfflinePrefs(data);
  useAutoPackUpdate(freshness, offlinePrefs.autoUpdate);
  const { mapStyle, originReady, useOffline } = useMapStyle(
    data.storage,
    tiles.coveringPack,
    tiles.preferOnline,
    mapAppearance,
    refreshPacks,
  );

  if (data.status === 'loading' || !originReady || mapStyle === null || initialView === null) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Loading map…</Text>
      </View>
    );
  }

  const destination = dest.destination;

  return (
    <View key={appearance.colorScheme} style={styles.container}>
      <MapScene
        mapRef={mapRef}
        cameraRef={cameraRef}
        mapStyle={mapStyle}
        bottomInset={bottomInset}
        attributionPosition={attributionPosition}
        packs={packs}
        overlays={overlays}
        overlayLabels={overlayLabels}
        huntingFields={huntingFields}
        iceObservations={iceObservations}
        lightning={lightning}
        satellites={satellites}
        starlink={starlink}
        speedCameras={speedCameras}
        traffic={traffic}
        trafficFlow={trafficFlow}
        roadWeather={roadWeather}
        transitVehicles={transitVehicles}
        weather={weatherLayers}
        weatherWarnings={weatherWarnings}
        chromeLift={weatherDockLift}
        spots={spotsOpen ? bestSpots.spots : EMPTY_SPOTS}
        exploreResults={exploreResults}
        poiResults={viewportPois.results}
        measure={measure.open ? measure.features : null}
        trackGeo={trackGeo}
        offlineRegionCorner={offlineRegion?.corner ?? null}
        offlineRegionBbox={offlineRegion?.bbox ?? null}
        nav={nav}
        route={route}
        transit={transit}
        destination={destination}
        visiblePlaces={visiblePlaces}
        showPuck={showPuck}
        suppressPuck={navPuck.suppressNative}
        // NavChrome owns the screen-fixed chevron full-screen, but that whole
        // chrome is absent in PiP. Anchor a smaller dot to the live map there
        // so the compact cartography still has an unmistakably moving puck.
        navDot={inPip ? (nav.state?.snapped ?? nav.position) : navPuck.dot}
        // Switching light/dark remounts the scene (keyed on colorScheme) to
        // reload the restyled map; boot that fresh scene at wherever the camera
        // already is, not back at the persisted launch view — otherwise a theme
        // toggle jumps the map. viewRef holds the latest settled camera.
        initialView={viewRef.current ?? initialView}
        showIdleChrome={showIdleChrome}
        inPip={inPip}
        onMapRect={pip.setMapRect}
        onMapPress={onMapPress}
        onPickPoint={onPickPoint}
        onViewChange={camera.onViewChange}
        onUserGesture={navCam.onUserGesture}
        onDestinationMoved={dest.onMoved}
      />
      {/* In the mini window the map keeps running under a compact guidance
          strip, and that strip replaces every other piece of chrome: no sheet,
          banner or control is rendered at a size where it could only be
          mis-tapped. The map is what makes the window read as live — the
          distance and clock in the strip change only every whole kilometre and
          whole minute, so on a motorway they can sit still for the better part
          of a minute. Expanding restores everything else — the same trip,
          camera and follow mode, because MapScene and the navigation session
          were never unmounted. */}
      {inPip ? (
        <NavPipCard
          nav={nav}
          width={compactWin.width}
          height={compactWin.height}
          fontScale={win.fontScale}
        />
      ) : (
        <>
          {offlineRegion ? (
            <OfflineRegionDrawControls
              corner={offlineRegion.corner}
              bbox={offlineRegion.bbox}
              topInset={topInset}
              bottomInset={bottomInset}
              onReset={() => setOfflineRegion({ corner: null, bbox: null })}
              onCancel={() => setOfflineRegion(null)}
              onBuild={() => {
                if (!offlineRegion.bbox) return;
                setPendingRegion(offlineRegion.bbox);
                setOfflineRegion(null);
              }}
            />
          ) : null}

          {/* Sustained dead reckoning ≈ inside a tunnel: dim the map (the UI on
          top stays bright) until live GPS returns. */}
          {nav.state !== null ? (
            <Animated.View
              pointerEvents="none"
              style={[styles.tunnelDim, { opacity: tunnelDim }]}
            />
          ) : null}

          <NavBanner
            nav={nav}
            topInset={topInset}
            bottomInset={bottomInset}
            viewport={viewport}
            navCam={navCam}
            followMode={navPrefs.followMode}
            onToggleFollowMode={navPrefs.toggleFollowMode}
            widgets={navPrefs.widgets}
            onAddStop={() => navAddStop.setOpen(!navAddStop.open)}
            onMark={navDiagnostics.enabled ? navDiagnostics.mark : undefined}
            onHeight={setNavHeight}
          />

          {/* Position chevron, orientation/overview buttons, road chip, re-centre. */}
          <NavChrome
            nav={nav}
            navCam={navCam}
            puck={navPuck}
            bottomInset={bottomInset}
            viewport={viewport}
          />

          {/* Search shares the bottom-sheet model and stays above the keyboard;
          hidden while navigating because the guidance UI owns the screen. */}
          {searchOpen && !navActive && !planning ? (
            <SearchBar
              packs={packs}
              places={data.places}
              getBias={getBias}
              onPick={dest.pickResult}
              onClose={() => setSearchOpen(false)}
              bottomInset={bottomInset}
              getSetting={data.getSetting}
              setSetting={data.setSetting}
            />
          ) : null}

          {/* Bottom-right: recentre on the current position (RoutePanel owns the
          bottom while planning, so hide it then; while navigating the follow
          camera + Re-centre pill cover it, so it's hidden too). */}
          {showIdleChrome ? (
            <View style={[styles.locateWrap, { bottom: bottomInset + 24, right: side.right + 12 }]}>
              {/* Press feedback (dim + shrink) so the tap visibly registers — the
              fix can take a second to arrive and the button looked dead until
              the camera moved. */}
              <Pressable
                style={({ pressed }) => [styles.roundButton, pressed && styles.roundButtonPressed]}
                onPress={() => void locate()}
                testID="locate"
              >
                <CrosshairIcon />
              </Pressable>
            </View>
          ) : null}

          {/* The whole idle toolbar disappears for every navigation phase. This
          includes route startup and terminal/error states, not only the
          follow-camera phases, so it cannot share coordinates with End. */}
          {showIdleChrome ? (
            <MenuCluster
              bottomInset={bottomInset}
              onToggleMenu={() => setMenuOpen((o) => !o)}
              following={following}
              onOpenSearch={() => setSearchOpen(true)}
              onExplore={startExplorer}
            />
          ) : null}

          {showIdleChrome && timeDockOn ? (
            <WeatherDock
              maps={weatherLayers.maps}
              title={weatherTitle}
              // Above the bottom control row and the activity rows stacked on it.
              bottom={bottomInset + 24 + 52 * (1 + activityRows)}
              onHeight={setWeatherDockHeight}
              sky={skyLayers}
              lightningOn={lightningOn}
              auroraOn={auroraOn}
            />
          ) : null}

          {showIdleChrome && overlaysCtl.poiOn ? (
            <PoiListSheet
              list={poiList}
              categories={overlaysCtl.poiCategories}
              loading={viewportPois.loading}
              error={viewportPois.error}
              tooWide={viewportPois.tooWide}
              onToggleCategory={overlaysCtl.togglePoiCategory}
              onShowAll={overlaysCtl.showAllPoiCategories}
              onPick={onPickPoiFromList}
              bottomInset={
                bottomInset +
                24 +
                52 * (1 + activityRows) +
                (timeDockOn ? weatherDockHeight + 6 : 0)
              }
            />
          ) : null}

          {showIdleChrome ? (
            <MapActivityControls
              profile={profiles}
              visibleProfiles={profilePreferences.visibleProfiles}
              overlays={overlaysCtl}
              targets={potentialTargets}
              filters={layerFilters}
              mapZoom={mapZoom}
              // Bottom-edge row, immediately left of the locate button. Menus
              // expand upward, so profile switching no longer floats mid-map.
              bottom={bottomInset + 24}
              onPickProfile={onPickMapProfile}
            />
          ) : null}

          {useOffline && showIdleChrome && tiles.showOfflineBadge ? (
            // The native attribution/contributions button occupies the first cell
            // of this top-left grid; offline status owns the second. A shared row
            // prevents the two independent renderers from overlapping.
            <View
              style={[
                styles.topLeftStatusGrid,
                { top: attributionPosition.top, left: attributionPosition.left },
              ]}
              pointerEvents="box-none"
            >
              <View style={styles.attributionCell} pointerEvents="none" />
              {/* The badge says the map is coming from disk. When the server has
              since rebuilt that region it also says *that*, because otherwise a
              months-old download keeps drawing months-old data and the reader
              blames the app rather than the pack. Settings does the updating. */}
              <View
                style={[styles.offlineBadge, packStale && styles.offlineBadgeStale]}
                accessibilityLabel={`Offline map${
                  tiles.coveringPack ? `: ${tiles.coveringPack.manifest.name}` : ''
                }${packStale ? ' · update available in Settings' : ''}`}
                testID="offline-badge"
              >
                <CloudOffIcon color={packStale ? theme.warning : undefined} />
                {packStale ? <Text style={styles.offlineBadgeStaleText}>Update</Text> : null}
              </View>
            </View>
          ) : null}
          {data.status === 'error' ? (
            <View
              style={[
                styles.banner,
                { top: topInset + 60, left: side.left + 12, right: side.right + 12 },
              ]}
            >
              <Text style={styles.bannerText}>Storage unavailable: {data.error}</Text>
            </View>
          ) : null}
          {writeError ? (
            <Pressable
              style={[
                styles.banner,
                { top: topInset + 60, left: side.left + 12, right: side.right + 12 },
              ]}
              onPress={clearWriteError}
              testID="write-error-banner"
            >
              <Text style={styles.bannerText}>{writeError} — the change was not saved.</Text>
            </Pressable>
          ) : null}
          {/* Undo a delete. Not danger-coloured: nothing is wrong, and the
              banner sits below the write-error one so a failed write — which
              the user does need to act on — is never the thing that moves. */}
          {undoable ? (
            <View
              style={[
                styles.banner,
                styles.undoBanner,
                {
                  top: topInset + 60 + (writeError ? 48 : 0),
                  left: side.left + 12,
                  right: side.right + 12,
                },
              ]}
              testID="undo-banner"
            >
              <Text style={[styles.bannerText, styles.undoText]} numberOfLines={2}>
                {undoable.message}
              </Text>
              <Pressable onPress={() => void undoable.undo()} hitSlop={8} testID="undo-action">
                <Text style={styles.undoAction}>Undo</Text>
              </Pressable>
              <Pressable
                onPress={clearUndoable}
                hitSlop={8}
                accessibilityLabel="Dismiss"
                testID="undo-dismiss"
              >
                <Text style={styles.undoDismiss}>✕</Text>
              </Pressable>
            </View>
          ) : null}
          {/* What the derive service is doing for the water on screen. Hidden
          mid-trip along with the rest of the idle chrome — a driver is not
          reading a fishing surface. */}
          {!navActive && !planning ? (
            <PotentialPill
              prep={potential}
              top={topInset + 60}
              left={side.left + 12}
              right={side.right + 12}
            />
          ) : null}
          {/* The shortlist's affordance, stacked under whatever the pill is
          saying. Absent below z11 and outside Norway, where there is nothing to
          rank and the pill has already said so. */}
          {!navActive &&
          !planning &&
          overlaysCtl.derived &&
          !spotsOpen &&
          potential.status !== 'zoom-in' &&
          potential.status !== 'outside' ? (
            <SpotsButton
              top={topInset + 60 + (potentialPillVisible(potential) ? 40 : 0)}
              left={side.left + 12}
              onPress={() => setSpotsOpen(true)}
              hunting={overlaysCtl.derived.meta.derived?.vocabulary === 'hunt'}
            />
          ) : null}
          <UpdateNotices storage={data.storage} topInset={topInset} />

          {/* The saved-stand board rides beside the shortlist because it is the
          same workflow's other half — but it is about places already saved, so
          it does not wait for a prepared cell. */}
          {!navActive &&
          !planning &&
          overlaysCtl.derived?.meta.derived?.vocabulary === 'hunt' &&
          !standBoardOpen &&
          !spotsOpen ? (
            <StandBoardButton
              top={topInset + 60 + (potentialPillVisible(potential) ? 40 : 0) + 40}
              left={side.left + 12}
              onPress={() => setStandBoardOpen(true)}
            />
          ) : null}

          <StandBoardSheet
            visible={standBoardOpen && !planning && !navActive}
            state={standBoard}
            onPick={onPickStand}
            onClose={() => setStandBoardOpen(false)}
            bottomInset={bottomInset}
          />

          <SpotsSheet
            visible={spotsOpen && !planning && !navActive}
            state={bestSpots}
            targetLabel={potentialTargetLabel}
            saveEnabled={data.status === 'ready'}
            onPick={onPickSpot}
            onSave={onSaveSpot}
            onClose={() => setSpotsOpen(false)}
            bottomInset={bottomInset}
          />

          {satelliteSelection ? (
            <SatellitePassSheet
              element={selectedSatellite}
              layerId={satelliteSelection.layerId}
              observer={satelliteSelection.observer}
              observerSource={satelliteSelection.observerSource}
              minElevationDeg={satelliteMinElevation}
              onMinElevationChange={setSatelliteMinElevation}
              overhead={
                (satelliteSelection.layerId === SATELLITES_ID ? satellites : starlink).overhead
              }
              train={trainOf(
                (satelliteSelection.layerId === SATELLITES_ID ? satellites : starlink).trains,
                satelliteSelection.noradId,
              )}
              locating={satelliteLocating}
              locationError={satelliteLocationError}
              onUseMapCenter={useMapCenterForSatellite}
              onUseMyLocation={() => void useMyLocationForSatellite()}
              onClose={() => setSatelliteSelection(null)}
              bottomInset={bottomInset}
            />
          ) : null}

          {/* A track row's other half: the climb, under the shape the camera
          has just framed. Stands down while planning or navigating, like every
          other map sheet. */}
          <TrackProfileSheet
            track={planning || navActive ? null : (trackProfile?.track ?? null)}
            data={trackProfile?.data ?? null}
            onClose={() => setTrackProfile(null)}
            bottomInset={bottomInset}
          />

          <MainMenuSheet
            visible={menuOpen && !planning && !navActive}
            onClose={() => setMenuOpen(false)}
            onOpenFavorites={() => setFavoritesOpen(true)}
            onOpenLayers={() => setLayersOpen(true)}
            onOpenWeather={() => {
              void getBias().then((center) =>
                setWeatherTarget(center ?? viewRef.current?.center ?? DEFAULT_VIEW.center),
              );
            }}
            onOpenExplore={() => {
              setExploreSelection(null);
              setExploreOpen(true);
            }}
            onOpenMeasure={() => measure.setOpen(true)}
            onOpenCommute={() => setCommuteOpen(true)}
            onOpenSettings={() => openSettings()}
            bottomInset={bottomInset}
          />

          {/* The ruler and range rings. A map sheet, because the next tap is
          meant to land on the map behind it. */}
          <MeasureSheet
            visible={measure.open && !planning && !navActive}
            measure={measure}
            bottomInset={bottomInset}
          />
          <CommuteSheet
            visible={commuteOpen && !planning && !navActive}
            commute={commute}
            places={data.places}
            geocode={stopGeocode}
            fetchStopLines={stopLinesFetch}
            onClose={() => setCommuteOpen(false)}
            onOpenJourney={openCommuteJourney}
            bottomInset={bottomInset}
          />

          {/* Mid-drive quick add-a-stop: category sheet from the banner's +, and a
          one-question card for a tapped place. */}
          <AddStopSheet ctl={navAddStop} bottomInset={bottomInset} />
          {destination && guiding && !navAddStop.open ? (
            <NavStopTapCard
              name={destination.name}
              bottom={bottomInset + 16}
              left={side.left + 12}
              right={side.right + 12}
              onAdd={() => {
                nav.addStop({ lat: destination.lat, lng: destination.lng });
                dest.clear();
              }}
              onClose={dest.clear}
            />
          ) : null}

          {/* Offered on an idle map only: while planning or navigating, the trip
          the user is busy with wins over the one they lost. */}
          {navResume.resumable && showIdleChrome ? (
            <NavResumeCard
              trip={navResume.resumable}
              bottom={bottomInset + 16}
              left={side.left + 12}
              right={side.right + 12}
              onResume={navResume.resume}
              onDismiss={navResume.dismiss}
            />
          ) : null}

          {destination && !planning && !navActive ? (
            <DestinationCard
              target={destination}
              userAt={poiOrigin}
              packs={packs}
              potential={potentialExplain.data}
              potentialTarget={potentialTargetLabel}
              stand={savedAtDestination?.stand ?? null}
              onPickNearby={onPickNearbyPlace}
              onDirections={() => {
                dest.clear();
                directions.planTo({ lat: destination.lat, lng: destination.lng }, destination.name);
              }}
              onSave={
                destination.canSave && !savedAtDestination
                  ? () => {
                      void data
                        .savePlace({
                          name: destination.name,
                          lat: destination.lat,
                          lng: destination.lng,
                          address: destination.address,
                        })
                        .then((place) => {
                          // A long-pressed point is saved under its own
                          // coordinates; open the editor on it so naming it is
                          // the next tap rather than a hunt through Favorites.
                          // Anything picked with a name is already called the
                          // right thing and keeps the card, where Save has just
                          // become Edit.
                          if (place && destination.unnamed) {
                            dest.clear();
                            setEditPlaceId(place.id);
                          }
                        });
                    }
                  : undefined
              }
              onEdit={
                savedAtDestination
                  ? () => {
                      setEditPlaceId(savedAtDestination.id);
                      dest.clear();
                    }
                  : undefined
              }
              // Open the share-format chooser (Atlas link, plain coordinates, or a
              // geo: hand-off to the user's preferred map app).
              onShare={() =>
                setShareTarget({
                  lat: destination.lat,
                  lng: destination.lng,
                  name: destination.name,
                })
              }
              onWeather={() => setWeatherTarget({ lat: destination.lat, lng: destination.lng })}
              onCancel={dest.clear}
              bottomInset={bottomInset}
            />
          ) : null}

          <WeatherSheet
            origin={serverOrigin}
            visible={weatherTarget !== null}
            onClose={() => setWeatherTarget(null)}
            target={weatherTarget}
            weather={weather}
            data={data}
            bottomInset={bottomInset}
          />

          <ExploreSheet
            key={profiles.profile.id}
            visible={exploreOpen && !planning && !navActive}
            packs={packs}
            getCenter={getBias}
            currentArea={currentExploreArea}
            zoom={mapZoom}
            profileId={profiles.profile.id}
            onPick={onPickExplore}
            onResultsChange={setExploreResults}
            onClose={() => {
              setExploreOpen(false);
              setExploreSelection(null);
              setExploreResults([]);
            }}
            bottomInset={bottomInset}
          />

          <ShareSheet
            target={shareTarget}
            zoom={viewRef.current?.zoom ?? 14}
            onClose={() => setShareTarget(null)}
            bottomInset={bottomInset}
          />

          <RoutePreview nav={nav} bottomInset={bottomInset} />

          <AppSheets
            data={data}
            placeCommutes={commute.placeCommutes}
            sync={sync}
            packs={packs}
            onPacksChanged={refreshPacks}
            bottomInset={bottomInset}
            favoritesOpen={favoritesOpen}
            onCloseFavorites={() => setFavoritesOpen(false)}
            editPlaceId={editPlaceId}
            onCloseEditPlace={() => setEditPlaceId(null)}
            layersOpen={layersOpen}
            onCloseLayers={() => setLayersOpen(false)}
            keepOffline={keepOfflineControls}
            overlays={overlaysCtl}
            profilePreferences={profilePreferences}
            tiles={tiles}
            settingsOpen={settingsOpen}
            settingsSection={settingsSection}
            onCloseSettings={() => setSettingsOpen(false)}
            appearance={appearance}
            mapStyleEditor={mapStyleEditor}
            navPrefs={navPrefs}
            vehicle={vehicle}
            transitPreferences={transitPreferences}
            navDiagnostics={navDiagnostics}
            pip={pip}
            regionJobs={regionJobs}
            downloads={downloads}
            offlinePrefs={offlinePrefs}
            onDrawRegion={() => {
              setSettingsOpen(false);
              setOfflineRegion({ corner: null, bbox: null });
            }}
            onPickDestination={dest.pick}
            onShowTrack={showTrack}
            onPlanTrack={planTrack}
            onImportTracks={importTracks}
            onImportInatur={importInatur}
          />
          <PromptModal
            visible={keepArea !== null}
            title="Keep this area offline"
            placeholder="e.g. Elgvaldet"
            confirmLabel="Keep"
            onCancel={() => setKeepArea(null)}
            onConfirm={(value) => {
              const area = keepArea;
              if (!area) return;
              setKeepArea(null);
              setKeeping(true);
              void requestPotentialPack(serverOrigin, {
                name: value.trim() || 'Offline area',
                bbox: area.bbox,
                surfaces: [{ layer: area.layer, target: area.target }],
              })
                .then((manifest) => {
                  // Straight into the same background download every pack uses,
                  // and into the screen that shows its progress.
                  downloads.start(manifest);
                  openSettings('offline');
                })
                .catch((error: unknown) =>
                  Alert.alert(
                    'Keep this area offline',
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setKeeping(false));
            }}
          />
          <PromptModal
            visible={pendingRegion !== null}
            title="Name offline region"
            placeholder="e.g. Jotunheimen trip"
            confirmLabel="Queue build"
            onCancel={() => setPendingRegion(null)}
            onConfirm={(value) => {
              if (!pendingRegion) return;
              const bbox = pendingRegion;
              const name = value.trim() || 'Custom offline region';
              setPendingRegion(null);
              openSettings('offline');
              void regionJobs.create(name, bbox);
            }}
          />
          {planning ? (
            <RoutePanel
              route={route}
              transit={transit}
              packs={packs}
              places={data.places}
              collections={data.collections}
              getBias={getBias}
              fetchNearby={fetchNearbyStops}
              onExport={exportRoute}
              onShareLink={shareRouteLink}
              onSaveTrack={async (trackData, name, collectionId) =>
                (await data.saveTrack(trackData, name, collectionId)) !== null
              }
              onNavigate={startNavigation}
              onOpenVehicleSettings={openVehicleSettings}
              onShowTransitTrip={showTransitTrip}
              onStartTransitGuidance={startTransitGuidance}
              onMakeCommute={
                plannedCommute &&
                commute.ready &&
                (commute.canAddCommute ||
                  (commute.commutes.length === 1 && !commute.config.from && !commute.config.to))
                  ? makePlannedCommute
                  : undefined
              }
              getMyLocation={directions.getMyLocation}
              locatingOrigin={directions.locatingOrigin}
              bottomInset={bottomInset}
            />
          ) : null}
          {transit.guidanceTrip ? (
            <TransitGuidance
              trip={transit.guidanceTrip}
              onStop={stopTransitGuidance}
              top={topInset + 8}
              left={side.left + 12}
              right={side.right + 12}
            />
          ) : null}
        </>
      )}
      <StatusBar style="auto" />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AppInner />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
  },
  loadingText: { color: theme.text },
  tunnelDim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(4, 8, 16, 0.4)',
  },
  locateWrap: { position: 'absolute' },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  roundButtonPressed: { backgroundColor: theme.surfaceActive, transform: [{ scale: 0.9 }] },
  topLeftStatusGrid: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  attributionCell: { width: 32, height: 32 },
  offlineBadge: {
    backgroundColor: theme.surfaceOverlay,
    borderRadius: 15,
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
  },
  // Wider when it has a word to say, so the glyph is not squeezed by the label.
  offlineBadgeStale: {
    flexDirection: 'row',
    gap: 5,
    width: 'auto',
    paddingHorizontal: 9,
    borderWidth: 1,
    borderColor: theme.warning,
  },
  offlineBadgeStaleText: { color: theme.warning, fontSize: 11, fontWeight: '800' },
  banner: {
    position: 'absolute',
    top: 100,
    backgroundColor: theme.danger,
    borderRadius: 8,
    padding: 10,
  },
  bannerText: { color: theme.onAccent },
  // Fixed slate, matching web's undo toast — a theme-following surface would
  // have to carry a theme-following text colour, and the banner's own white
  // text would then vanish into it in dark mode.
  undoBanner: {
    backgroundColor: '#26313a',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  undoText: { flexShrink: 1, flexGrow: 1 },
  undoAction: { color: '#7cc4ff', fontWeight: '700' },
  undoDismiss: { color: theme.onAccent, fontWeight: '700' },
});
