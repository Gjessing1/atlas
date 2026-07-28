import {
  useBestSpots,
  useMapProfile,
  useMapProfilePreferences,
  useRegionPackJobs,
  useMapStyleEditor,
  useMeasure,
  routePlanState,
  useNavAddStop,
  useNavPrefs,
  useNavResume,
  usePotential,
  useRoutePlanPersistence,
  usePotentialExplain,
  usePotentialTarget,
  useThemeMode,
  type FetchNearbyFn,
} from '@atlas/app-hooks';
import {
  atlasRouteUrl,
  mapProfile,
  placeIsVisible,
  resolveInaturOffer,
  savedPlaceAt,
  type BBox,
  type LatLng,
  type MapAppearance,
  type NearbyPlaceArticle,
  type VisibilityFolder,
} from '@atlas/core';
import { buildGpx, trackBounds } from '@atlas/gpx';
import type { TrackRecord } from '@atlas/storage';
import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import {
  isRoutingProfile,
  ROUTING_PROFILES,
  routePathToTrackData,
  trackToRoutePoints,
  type RoutePath,
} from '@atlas/routing';
import { transitTripBounds, type TransitTrip } from '@atlas/transit';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Appearance,
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
import { useSpeedCameras } from './src/layers/useSpeedCameras';
import { useOverlayLabels } from './src/layers/useOverlayLabels';
import { PotentialPill, potentialPillVisible } from './src/layers/PotentialPill';
import { SpotsButton, SpotsSheet } from './src/ui/SpotsSheet';
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
import { shareText } from './src/share';
import { useSync } from './src/sync/useSync';
import { useDirections } from './src/routing/useDirections';
import { useRoute } from './src/routing/useRoute';
import { useTransitPlan } from './src/routing/useTransit';
import { AppSheets } from './src/ui/AppSheets';
import { DestinationCard, type DestinationTarget } from './src/ui/DestinationCard';
import { ExploreSheet } from './src/ui/ExploreSheet';
import { useDestination } from './src/ui/useDestination';
import { CloudOffIcon, CrosshairIcon } from './src/ui/icons';
import { useSideInsets } from './src/ui/insets';
import { theme } from './src/ui/theme';
import { MainMenuSheet } from './src/ui/MainMenuSheet';
import { MeasureSheet } from './src/ui/MeasureSheet';
import { MenuCluster } from './src/ui/MenuCluster';
import { MapActivityControls } from './src/ui/MapActivityControls';
import { OfflineRegionDrawControls } from './src/ui/OfflineRegionDrawControls';
import { PromptModal } from './src/ui/PromptModal';
import { RoutePanel } from './src/ui/RoutePanel';
import { ShareSheet, type ShareTarget } from './src/ui/ShareSheet';
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
  const nav = useNavigation();
  const route = useRoute();
  const transit = useTransitPlan(route);
  const directions = useDirections(route);
  // Geometry of the visible tracks, for the map's track line layer.
  const trackGeo = useTrackGeometry(data.storage, data.tracks);
  // The active profile and quick overlay state are device-local; the preferred
  // switcher layout syncs and is shared by Settings and the one-tap controls.
  const profiles = useMapProfile(data);
  const profilePreferences = useMapProfilePreferences(data);
  const mapAppearance = useMemo<MapAppearance>(
    () => ({
      colorScheme: appearance.colorScheme,
      profile: profiles.profile.id,
      custom: mapStyleEditor.value,
    }),
    [appearance.colorScheme, profiles.profile.id, mapStyleEditor.value],
  );
  const overlaysCtl = useOverlays(
    data,
    profiles.profile.id,
    profilePreferences.preferredLayers(profiles.profile.id),
    profilePreferences.customizedLayers(profiles.profile.id),
  );
  const serverOrigin = useServerOrigin();
  const regionJobs = useRegionPackJobs(data, serverOrigin);

  const [packs, setPacks] = useState<LocalPack[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // The expanded search overlay (the 🔍 button in the bottom-left cluster opens it).
  const [searchOpen, setSearchOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  // Place whose focused editor should open (map pin → Edit).
  const [editPlaceId, setEditPlaceId] = useState<string | null>(null);
  const [tracksOpen, setTracksOpen] = useState(false);
  // The measure / radius tool. While open it owns map taps — the same contract
  // web gives it — and its state is the shared useMeasure controller.
  const measure = useMeasure();
  const [navHeight, setNavHeight] = useState(0);
  const [offlineRegion, setOfflineRegion] = useState<{
    corner: LatLng | null;
    bbox: BBox | null;
  } | null>(null);
  const [pendingRegion, setPendingRegion] = useState<BBox | null>(null);
  // "Keep this area offline" (§N5 → E7): the framed area of the switched-on
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
  const [showPuck, setShowPuck] = useState(false);
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
  const camera = useBootCamera(data, cameraRef, onLinkPin);
  const { initialView, viewRef, mapZoom, getBias } = camera;
  // The half-built plan survives the app being killed in the background, and a
  // plan someone sent by link wins over it — the same hook, with the same
  // precedence, as the web app (§7.6). It sits below useBootCamera because the
  // link is what that hook resolves, and until it has, the saved plan waits.
  useRoutePlanPersistence(route, data, camera.linkPlan);
  // Downloaded tiles win wherever a pack covers the view (Settings can force
  // server tiles); everything else — search, routing, weather — stays online-first.
  // Resolved here rather than beside the other pack state below, because the
  // overlay list is built from it: a derived surface is drawn from a pack too.
  const tiles = useTileSource(data, packs, camera.viewCenter);
  const overlayLabels = useOverlayLabels(overlaysCtl.overlays, camera.labelCell);
  // Derived potential surfaces (§N5): prepare the cells under the viewport and
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
      // …and a surface the user kept offline (§N5 → E7) is then pointed at the
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
  // The shortlist a derived surface turns into a plan (§N5 → E6). Opened by
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
  });
  // "Keep this area offline" (§N5 → E7). Offered only for a derived surface
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
  // The ATK speed cameras as a map layer (the Drive signature overlay). The
  // *guidance* warnings are a separate, offline-first path (offlineNvdb) — this
  // is only the drawn layer.
  const speedCameras = useSpeedCameras(overlays, serverOrigin);

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
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const win = useWindowDimensions();
  // Leaving Atlas mid-trip shrinks it into a floating mini window instead of
  // hiding guidance. That window is its own tiny screen: no system bars, no
  // guidance rail, and only the compact card at the bottom to keep clear of.
  const pip = useNavigationPip(nav, data);
  const inPip = pip.inPictureInPicture;
  const viewport = useMemo(
    () =>
      inPip
        ? navViewport(
            win.width,
            win.height,
            NO_SIDE_INSETS,
            0,
            // Keep the puck clear of the guidance strip, whose height is the
            // window's own (NavPipCard scales with the size the user gave it).
            pipCardMetrics(win.width, win.height).height,
            true,
          )
        : navViewport(win.width, win.height, side, topInset, bottomInset),
    [win.width, win.height, side, topInset, bottomInset, inPip],
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
    dest.destination !== null ||
    offlineRegion !== null;
  // Landscape is short, so several pieces of chrome move into the leading
  // guidance rail and route fits get a narrower bottom pad.

  // Mid-trip taps must not fly the camera away from the follow view — the
  // card opens where the puck already is. Idle, the point is panned clear of
  // the card at the zoom the user is already on (pickOnMap).
  const pickPressTarget = useCallback(
    (target: DestinationTarget) => {
      if (following) dest.pickQuiet(target);
      else dest.pickOnMap(target);
    },
    [following, dest],
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
        name: `Spot ${index + 1}`,
        detail: spot.bandLabel,
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
  // A spot saved from the shortlist keeps its reasoning in the notes: the pin
  // syncs and comes along offline, where the surface that produced it will not.
  const onSaveSpot = useCallback(
    (spot: PotentialSpot, index: number) => {
      void data.savePlace(spotPlaceDraft(spot, index, { targetLabel: potentialTargetLabel }));
    },
    [data, potentialTargetLabel],
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
    spots: spotsOpen ? bestSpots.spots : undefined,
    pickSpot: onPickSpotById,
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

  // Route planning owns the bottom of the screen and repurposes map taps to add
  // stops, so it can't share the screen with a destination card.
  const planning = route.active;
  // Idle map actions are one region with one visibility rule. Navigation owns
  // that region from route startup through arrival/error, not only while its
  // follow camera is running.
  const showIdleChrome = !planning && !navActive && !idleSheetOpen;

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

  // Frame a track on the map, from a row in either sheet — its whole shape,
  // which is the only view that says which track this actually is. A track with
  // no parseable geometry simply doesn't move the camera.
  const showTrack = useCallback(
    (track: TrackRecord) => {
      void data.getTrackData(track.id).then((trackData) => {
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
    } catch {
      // Location unavailable — nothing to recentre on.
    }
  }, [following, resumeFollow]);

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
        speedCameras={speedCameras}
        spots={spotsOpen ? bestSpots.spots : EMPTY_SPOTS}
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
        navDot={navPuck.dot}
        // Switching light/dark remounts the scene (keyed on colorScheme) to
        // reload the restyled map; boot that fresh scene at wherever the camera
        // already is, not back at the persisted launch view — otherwise a theme
        // toggle jumps the map. viewRef holds the latest settled camera.
        initialView={viewRef.current ?? initialView}
        showIdleChrome={showIdleChrome}
        inPip={inPip}
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
        <NavPipCard nav={nav} />
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
            onHeight={setNavHeight}
            onRect={pip.setBannerRect}
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
              onPlanRoute={() => route.start()}
            />
          ) : null}

          {showIdleChrome ? (
            <MapActivityControls
              profile={profiles}
              visibleProfiles={profilePreferences.visibleProfiles}
              overlays={overlaysCtl}
              targets={potentialTargets}
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
            />
          ) : null}
          <UpdateNotices storage={data.storage} topInset={topInset} />

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

          <MainMenuSheet
            visible={menuOpen && !planning && !navActive}
            onClose={() => setMenuOpen(false)}
            onOpenFavorites={() => setFavoritesOpen(true)}
            onOpenTracks={() => setTracksOpen(true)}
            onOpenLayers={() => setLayersOpen(true)}
            onOpenExplore={() => setExploreOpen(true)}
            onOpenMeasure={() => measure.setOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            bottomInset={bottomInset}
          />

          {/* The ruler and range rings. A map sheet, because the next tap is
          meant to land on the map behind it. */}
          <MeasureSheet
            visible={measure.open && !planning && !navActive}
            measure={measure}
            bottomInset={bottomInset}
          />

          {/* Mid-drive quick add-a-stop: category sheet from the banner's +, and a
          one-question card for a tapped place. */}
          <AddStopSheet ctl={navAddStop} bottomInset={bottomInset} />
          {destination && following && !navAddStop.open ? (
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
              packs={packs}
              potential={potentialExplain.data}
              potentialTarget={potentialTargetLabel}
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
            visible={weatherTarget !== null}
            onClose={() => setWeatherTarget(null)}
            target={weatherTarget}
            weather={weather}
            data={data}
            bottomInset={bottomInset}
          />

          <ExploreSheet
            visible={exploreOpen && !planning && !navActive}
            packs={packs}
            getCenter={getBias}
            zoom={mapZoom}
            onPick={(result) => {
              setExploreOpen(false);
              dest.pickResult(result);
            }}
            onClose={() => setExploreOpen(false)}
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
            sync={sync}
            packs={packs}
            onPacksChanged={refreshPacks}
            bottomInset={bottomInset}
            favoritesOpen={favoritesOpen}
            onCloseFavorites={() => setFavoritesOpen(false)}
            editPlaceId={editPlaceId}
            onCloseEditPlace={() => setEditPlaceId(null)}
            tracksOpen={tracksOpen}
            onCloseTracks={() => setTracksOpen(false)}
            layersOpen={layersOpen}
            onCloseLayers={() => setLayersOpen(false)}
            keepOffline={keepOfflineControls}
            overlays={overlaysCtl}
            profilePreferences={profilePreferences}
            tiles={tiles}
            settingsOpen={settingsOpen}
            onCloseSettings={() => setSettingsOpen(false)}
            appearance={appearance}
            mapStyleEditor={mapStyleEditor}
            navPrefs={navPrefs}
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
                  setSettingsOpen(true);
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
              setSettingsOpen(true);
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
              onShowTransitTrip={showTransitTrip}
              getMyLocation={directions.getMyLocation}
              locatingOrigin={directions.locatingOrigin}
              bottomInset={bottomInset}
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
