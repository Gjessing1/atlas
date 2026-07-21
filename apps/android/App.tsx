import {
  decodeMapLink,
  encodeMapHash,
  haversineM,
  placeIsVisible,
  POI_LAYER_IDS,
  type SearchResult,
  type VisibilityFolder,
} from '@atlas/core';
import { buildGpx } from '@atlas/gpx';
import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import {
  ROUTING_PROFILES,
  routePathToTrackData,
  viaInsertIndex,
  type RoutePath,
} from '@atlas/routing';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Linking,
  Pressable,
  Share,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import type { LatLng } from '@atlas/core';
import {
  DEFAULT_VIEW,
  MapScene,
  NAV_PREVIEW_LAYER_IDS,
  PLAN_LINE_LAYER_ID,
} from './src/map/MapScene';
import { tunnelChipLabel } from '@atlas/navigation';
import { getServerOrigin } from './src/serverOrigin';
import { useOverlays } from './src/layers/useOverlays';
import { useMapStyle } from './src/map/useMapStyle';
import type { LocalPack } from './src/regions/packs';
import { NavBanner } from './src/nav/NavBanner';
import { RoutePreview } from './src/nav/RoutePreview';
import { useNavCamera } from './src/nav/useNavCamera';
import { useNavigation } from './src/nav/useNavigation';
import { useTunnelDim } from './src/nav/useTunnelDim';
import { listLocalPacks } from './src/regions/packs';
import { SearchBar } from './src/search/SearchBar';
import { useSync } from './src/sync/useSync';
import { useRoute } from './src/routing/useRoute';
import { useTransitPlan } from './src/routing/useTransit';
import { shareText } from './src/share';
import { AppSheets } from './src/ui/AppSheets';
import { DestinationCard, type DestinationTarget } from './src/ui/DestinationCard';
import { CrosshairIcon, NavArrowIcon } from './src/ui/icons';
import { theme } from './src/ui/theme';
import { MenuCluster } from './src/ui/MenuCluster';
import { RoutePanel } from './src/ui/RoutePanel';
import { WeatherSheet } from './src/ui/WeatherSheet';
import { UpdateNotices } from './src/update/UpdateNotices';
import { useTrackGeometry } from './src/useTrackGeometry';
import { useUserData } from './src/useUserData';
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

/** Settings key for the persisted camera (device-local — `local.` never syncs). */
const CAMERA_SETTING = 'local.map.camera';
/** Nav preferences that survive across trips (device-local, web parity). */
const NAV_MUTED_SETTING = 'local.nav.muted';
const NAV_FOLLOW_SETTING = 'local.nav.follow';

const coordName = (p: LatLng) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

type MapView = { center: LatLng; zoom: number };

/** Parse a persisted camera setting; null when absent or malformed. */
function parseCameraSetting(raw: string | null): MapView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { lat?: number; lng?: number; zoom?: number };
    if (![v.lat, v.lng, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n)))
      return null;
    return { center: { lat: v.lat!, lng: v.lng! }, zoom: v.zoom! };
  } catch {
    return null;
  }
}

function AppInner() {
  const insets = useSafeAreaInsets();
  const bottomInset = insets.bottom || NAV_BAR_FALLBACK;
  const topInset = insets.top || STATUS_BAR_FALLBACK;
  const data = useUserData();
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
  // Geometry of the visible tracks, for the map's track line layer.
  const trackGeo = useTrackGeometry(data.storage, data.tracks);
  // Overlay catalog + per-device visibility/opacity (☰ → Layers sheet).
  const overlaysCtl = useOverlays(data);

  const [packs, setPacks] = useState<LocalPack[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // The expanded search overlay (the 🔍 button in the bottom-left cluster opens it).
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  // Place whose edit panel the Favorites sheet should open with (map pin → Edit).
  const [editPlaceId, setEditPlaceId] = useState<string | null>(null);
  const [tracksOpen, setTracksOpen] = useState(false);
  const [forceOffline, setForceOffline] = useState(false);
  const [navHeight, setNavHeight] = useState(0);
  // Coords awaiting a name before they're saved as a pin (name-on-save prompt).
  const [pendingPin, setPendingPin] = useState<LatLng | null>(null);
  // A picked place awaiting an action (search result, long-press, place or
  // favorite). Cleared once the route planner takes it over. The travel mode is
  // not decided here — the RoutePanel is the app's single mode picker.
  const [destination, setDestination] = useState<DestinationTarget | null>(null);
  // Point the weather & conditions sheet is showing (null = closed).
  const [weatherTarget, setWeatherTarget] = useState<LatLng | null>(null);
  const weather = useWeather(weatherTarget);
  // Map orientation while navigating: course-up (direction of travel) or north-up.
  const [navFollow, setNavFollow] = useState<'course' | 'north'>('course');
  // Show the location puck once the user has asked to be located (also true
  // while navigating). Idle recentres are one-shot fly-tos, so tapping locate
  // never locks the camera and fights a pan.
  const [showPuck, setShowPuck] = useState(false);
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);
  // Boot camera: a #map= launch link wins, else the persisted last view. Null
  // until resolved — the map holds at the loading screen so the first frame is
  // already at the right place (no Oslo flash).
  const [initialView, setInitialView] = useState<MapView | null>(null);
  // Latest settled camera — feeds the search bias, share links and persistence.
  const viewRef = useRef<MapView | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // While a trip is active the nav banner owns the top of the screen, so drop
  // the search bar + button column below its measured height (issue: the banner
  // was covering both). `following` also turns the map course-up (issue: no map
  // orientation while travelling).
  const navActive = nav.phase !== 'idle';
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';
  // The follow camera: bottom-anchored, course-up, speed/turn-aware zoom; a
  // manual pan pauses it (re-centre pill / locate button / timeout resume it).
  const navCam = useNavCamera(cameraRef, nav, navFollow);
  const tunnelDim = useTunnelDim(nav.state?.fix, nav.state?.tunnel != null);
  // Route-choice preview: the choice card owns the bottom of the screen and
  // map taps switch between the drawn choices (no banner at the top).
  const previewing = nav.phase === 'preview';
  const controlsTop = topInset + 8 + (navActive && !previewing ? navHeight + 8 : 0);

  // While the follow camera is actively tracking, the puck is drawn as a
  // screen-fixed chevron at the camera's anchor point — the camera eases to
  // the road-snapped fix, so the chevron sits glued to the route line with
  // none of the native puck's raw-GPS wobble. Falls back to the native puck
  // when paused/off-route (the map moves freely under the true position then).
  const win = useWindowDimensions();
  // Show the chevron on exactly the condition useNavCamera eases the camera to
  // `state.snapped` (following, not paused, not in overview, a fix in hand) —
  // no tighter. Gating it additionally on `departed`, a 25 m snap band, or
  // off-route meant the camera kept tracking the live position while the
  // chevron vanished, so the native puck's fuzzy accuracy blob showed for the
  // whole drive instead — even on a perfect fix a lane's width off the route
  // centreline. The chevron sits at the camera's centre, so wherever the
  // camera points (glued to the line or the raw fix, on-route or off) it is
  // the honest marker; it simply greys when the fix is genuinely lost.
  const courseUp = navFollow === 'course' && (nav.state?.departed ?? false);
  const navPuckVisible =
    following && !navCam.followPaused && !navCam.overview && nav.state !== null;
  // Once a trip has a position, the native puck is never the right marker: the
  // fuzzy accuracy blob ("the cloud") looks like a bug next to our own puck, and
  // any flip between the two — a stray gesture, an overview toggle, a device
  // rotation that resizes the map — reads as the marker vanishing mid-drive.
  // So suppress it for the whole trip and always draw one of ours: the
  // screen-fixed chevron while the follow camera frames the position, a
  // map-anchored dot whenever it doesn't.
  const navDot = following && nav.state !== null && !navPuckVisible ? nav.state.snapped : null;
  const suppressNativePuck = following && nav.state !== null;
  // Anchor point of the follow camera (see useNavCamera): course-up pads the
  // centre down to 75% of the screen; otherwise (north-up, or before the drive
  // has begun) it keeps the centre at the middle. Track the same `courseUp` the
  // camera frames with, so the chevron lands where the camera actually centres.
  const navPuckTop = courseUp ? win.height * 0.75 : win.height * 0.5;
  // Course-up rotates the map to the course, so the chevron points straight
  // up; otherwise the map is north-up (bearing 0), so the chevron shows the course.
  const navPuckRotation = courseUp ? 0 : Math.round(nav.state?.courseDeg ?? 0);
  // Landscape is short: the camera anchor at 75% leaves only a quarter of a
  // ~400 dp viewport below the chevron, which the bottom-centred road chip was
  // sitting in — the chip covered the puck. Portrait has the room, so keep the
  // centred chip there and move it out of the chevron's column in landscape,
  // where the extra width is free.
  const landscape = win.width > win.height;

  const flyTo = useCallback((p: LatLng) => {
    cameraRef.current?.flyTo({ center: [p.lng, p.lat], zoom: 14, duration: 900 });
  }, []);

  // Show a destination card (mode picker + Navigate) for any picked point.
  const pickDestination = useCallback(
    (target: DestinationTarget) => {
      setDestination(target);
      flyTo({ lat: target.lat, lng: target.lng });
    },
    [flyTo],
  );

  // Resolve the boot camera once storage has settled: a #map= launch link
  // (share link / atlas: deep link) wins, else the persisted last view.
  const { getSetting, setSetting } = data;
  useEffect(() => {
    if (data.status === 'loading' || initialView !== null) return;
    let cancelled = false;
    void (async () => {
      const launch = decodeMapLink((await Linking.getInitialURL().catch(() => null)) ?? '');
      if (cancelled) return;
      if (launch) {
        setInitialView({ center: launch.center, zoom: launch.zoom });
        if (launch.pin) {
          const p = launch.pin;
          setDestination({ lat: p.lat, lng: p.lng, name: coordName(p), canSave: true });
        }
        return;
      }
      const saved = parseCameraSetting(await getSetting(CAMERA_SETTING));
      if (!cancelled) setInitialView(saved ?? DEFAULT_VIEW);
    })();
    return () => {
      cancelled = true;
    };
  }, [data.status, initialView, getSetting]);

  // #map= links arriving while the app is running: fly there, pin included.
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      const view = decodeMapLink(url);
      if (!view) return;
      if (view.pin) {
        const p = view.pin;
        setDestination({ lat: p.lat, lng: p.lng, name: coordName(p), canSave: true });
      }
      cameraRef.current?.flyTo({
        center: [view.center.lng, view.center.lat],
        zoom: view.zoom,
        duration: 900,
      });
    });
    return () => sub.remove();
  }, []);

  // Nav preferences (mute, course-up/north-up) survive across trips.
  const { setMuted: setNavMuted } = nav;
  useEffect(() => {
    if (data.status !== 'ready') return;
    void getSetting(NAV_MUTED_SETTING).then((raw) => {
      if (raw != null) setNavMuted(raw === 'true');
    });
    void getSetting(NAV_FOLLOW_SETTING).then((raw) => {
      if (raw === 'north' || raw === 'course') setNavFollow(raw);
    });
  }, [data.status, getSetting, setNavMuted]);
  const toggleNavFollow = useCallback(() => {
    setNavFollow((m) => {
      const next = m === 'course' ? 'north' : 'course';
      setSetting(NAV_FOLLOW_SETTING, next);
      return next;
    });
  }, [setSetting]);
  // Mute toggles through nav.toggleMute (banner button); persist the result.
  const prevMutedRef = useRef(nav.muted);
  useEffect(() => {
    if (prevMutedRef.current !== nav.muted) {
      prevMutedRef.current = nav.muted;
      if (data.status === 'ready') setSetting(NAV_MUTED_SETTING, String(nav.muted));
    }
  }, [nav.muted, data.status, setSetting]);

  // Track the settled camera and persist it (debounced) as the boot view.
  const onViewChange = useCallback(
    (view: MapView) => {
      viewRef.current = view;
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        setSetting(
          CAMERA_SETTING,
          JSON.stringify({
            lat: Number(view.center.lat.toFixed(5)),
            lng: Number(view.center.lng.toFixed(5)),
            zoom: Number(view.zoom.toFixed(2)),
          }),
        );
      }, 800);
    },
    [setSetting],
  );

  // Viewport bias for geocoding (web parity: SearchBox sends lat/lon).
  const getBias = useCallback(async () => viewRef.current?.center ?? null, []);

  // Share the destination as a web #map= link (opens in any browser; the
  // installed app also answers atlas: links with the same fragment).
  const shareDestination = useCallback(() => {
    if (!destination) return;
    const pin = { lat: destination.lat, lng: destination.lng };
    const hash = encodeMapHash({ center: pin, zoom: viewRef.current?.zoom ?? 14, pin });
    void Share.share({ message: `${destination.name} — ${getServerOrigin()}/${hash}` });
  }, [destination]);

  // The red pin was dragged: the destination becomes that adjusted point.
  const onDestinationMoved = useCallback((p: LatLng) => {
    setDestination((d) => (d ? { lat: p.lat, lng: p.lng, name: coordName(p), canSave: true } : d));
  }, []);

  // One handler for every map tap: dismiss the ☰ menu if it's open; while
  // planning, a tap on the routed line inserts a via into that leg and any
  // other tap appends a stop; otherwise hit-test the saved pins, then the
  // basemap POIs. Pins are picked here at the map level because touches on
  // Marker child views are not delivered reliably on-device — the map press
  // always is.
  const onMapPress = useCallback(
    ({ lat, lng }: LatLng, pixel: { x: number; y: number }) => {
      // Finger-sized query box for layer hit-tests (a 1px point is too strict).
      const pixelBounds: [[number, number], [number, number]] = [
        [pixel.x - 12, pixel.y - 12],
        [pixel.x + 12, pixel.y + 12],
      ];
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      if (nav.phase === 'preview') {
        // A tap on one of the drawn route choices makes it the selection.
        void (async () => {
          const hits = await mapRef.current
            ?.queryRenderedFeatures(pixelBounds, { layers: NAV_PREVIEW_LAYER_IDS })
            .catch(() => undefined);
          const index = hits?.[0]?.properties?.['index'] as number | undefined;
          if (typeof index === 'number') nav.selectPreview(index);
        })();
        return;
      }
      if (route.active) {
        void (async () => {
          // Tap on the selected line: insert a via there (web parity — the
          // shared viaInsertIndex picks the leg the tapped point belongs to).
          const path = route.paths?.[route.selectedPath];
          if (path && !route.roundTrip && route.waypoints.length >= 2) {
            const hits = await mapRef.current
              ?.queryRenderedFeatures(pixelBounds, { layers: [PLAN_LINE_LAYER_ID] })
              .catch(() => undefined);
            if (hits && hits.length > 0) {
              const at = { lat, lng };
              route.insertWaypoint(
                viaInsertIndex(
                  path.points,
                  route.waypoints.map((w) => w.pos),
                  at,
                ),
                at,
              );
              return;
            }
          }
          route.addWaypoint({ lat, lng });
        })();
        return;
      }
      void (async () => {
        const zoom = await mapRef.current?.getZoom();
        if (zoom === undefined) return;
        // Ground size of one screen pixel at this zoom (512px tiles) makes the
        // tap tolerance a constant ~36 px at any zoom level.
        const metersPerPx = (78271.5 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
        let best: (typeof visiblePlaces)[number] | undefined;
        let bestM = Infinity;
        for (const place of visiblePlaces) {
          const d = haversineM({ lat, lng }, { lat: place.lat, lng: place.lng });
          if (d < bestM) {
            bestM = d;
            best = place;
          }
        }
        if (best && bestM <= 36 * metersPerPx) {
          pickDestination({
            lat: best.lat,
            lng: best.lng,
            name: best.name,
            canSave: false,
            placeId: best.id,
          });
          return;
        }
        // No pin hit — try the basemap POIs (name/class popup, web parity).
        const pois = await mapRef.current
          ?.queryRenderedFeatures(pixelBounds, { layers: POI_LAYER_IDS })
          .catch(() => undefined);
        const poi = pois?.[0];
        if (!poi) return;
        const props = (poi.properties ?? {}) as Record<string, unknown>;
        const name = (props['name'] ?? props['name:latin']) as string | undefined;
        if (!name) return;
        const kind = [props['class'], props['subclass']]
          .filter((v): v is string => typeof v === 'string' && v !== name)
          .join(' · ');
        // Anchor on the POI's own coordinate when it has one, not the tap.
        const [poiLng, poiLat] =
          poi.geometry?.type === 'Point' ? (poi.geometry.coordinates as number[]) : [lng, lat];
        pickDestination({
          lat: poiLat ?? lat,
          lng: poiLng ?? lng,
          name,
          detail: kind || undefined,
          canSave: true,
        });
      })();
    },
    [menuOpen, nav, route, visiblePlaces, pickDestination],
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
    const landscape = win.width > win.height;
    // Mirrors the RoutePreview card width so the fit clears it exactly.
    const cardW = Math.min(420, Math.round(win.width * 0.45));
    cameraRef.current?.fitBounds([west, south, east, north], {
      padding: landscape
        ? { top: topInset + 48, right: 48, bottom: bottomInset + 48, left: cardW + 40 }
        : { top: topInset + 48, right: 48, bottom: bottomInset + 300, left: 48 },
      duration: 700,
    });
  }, [nav.phase, nav.previewPaths, nav.previewIndex, topInset, bottomInset, win.width, win.height]);

  // Long-press outside route planning: pick any point as a destination.
  const onPickPoint = useCallback(
    ({ lat, lng }: LatLng) => {
      pickDestination({
        lat,
        lng,
        name: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
        canSave: true,
      });
    },
    [pickDestination],
  );

  /**
   * A GPS fix for the route planner's "My location" shortcut, or null when the
   * permission is refused or no fix is available — the panel then just says so
   * rather than silently doing nothing.
   */
  const getMyLocation = useCallback(async (): Promise<LatLng | null> => {
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) return null;
      const cur = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      return { lat: cur.coords.latitude, lng: cur.coords.longitude };
    } catch {
      return null;
    }
  }, []);

  /**
   * "Directions" on the place card: hand the point to the route planner, which
   * is where every travel-mode decision now happens. The place's *name* goes
   * with it — the old transit hand-off dropped it and the planner opened
   * showing bare coordinates for somewhere the user had just picked by name.
   * Seeding the current position as the start is a convenience, not a
   * requirement: with no fix the panel opens asking for a start.
   */
  const planTo = useCallback(() => {
    if (!destination) return;
    const dest = { lat: destination.lat, lng: destination.lng };
    const name = destination.name;
    const hadPlan = route.waypoints.length > 0;
    void (async () => {
      const origin = await getMyLocation();
      setDestination(null);
      // Open the panel first, then fill it. The destination is added
      // unconditionally — seeding the origin is the optional half, so a missing
      // fix costs you the start row, never the place you actually asked for.
      route.start();
      // A loop has one anchor, so asking for directions to a place has to leave
      // loop mode. Coming from a loop the origin is still dropped (the
      // addWaypoint closure below predates this state change) — the
      // destination survives, which is the half the user asked for.
      route.setRoundTrip(false);
      if (!hadPlan && origin) route.addWaypoint(origin, 'My location');
      route.addWaypoint(dest, name);
    })();
  }, [destination, route, getMyLocation]);

  /** Start guidance to the planner's destination in the chosen road profile. */
  const startNavigation = useCallback(
    (dest: LatLng) => {
      setNavFollow('course');
      void nav.start(dest, route.profile);
    },
    [nav, route.profile],
  );

  // Route planning owns the bottom of the screen and repurposes map taps to add
  // stops, so it can't share the screen with a destination card.
  const planning = route.active;

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

  // Pick GPX/KML/KMZ files from the device and import them (parser validates by
  // name/content, so we allow any type through the picker).
  const importTracks = useCallback(async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (res.canceled) return null;
    return data.importFiles(res.assets.map((a) => ({ name: a.name, uri: a.uri })));
  }, [data]);

  // Recentre on the user's position. While navigating this re-engages the
  // follow camera after a manual pan; when idle it's a one-shot fly-to that
  // also reveals the location puck.
  const { resumeFollow } = navCam;
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

  const offlinePack = packs.find((p) => p.manifest.files.basemap);
  const { mapStyle, originReady, useOffline } = useMapStyle(
    data.storage,
    offlinePack,
    forceOffline,
    refreshPacks,
  );

  const onPickResult = useCallback(
    (result: SearchResult) => {
      pickDestination({
        lat: result.position.lat,
        lng: result.position.lng,
        name: result.name || result.label || 'Dropped pin',
        canSave: true,
      });
    },
    [pickDestination],
  );

  if (data.status === 'loading' || !originReady || mapStyle === null || initialView === null) {
    return (
      <View style={styles.loading}>
        <Text>Loading map…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapScene
        mapRef={mapRef}
        cameraRef={cameraRef}
        mapStyle={mapStyle}
        bottomInset={bottomInset}
        packs={packs}
        overlays={overlaysCtl.overlays}
        trackGeo={trackGeo}
        nav={nav}
        route={route}
        transit={transit}
        destination={destination}
        visiblePlaces={visiblePlaces}
        showPuck={showPuck}
        suppressPuck={suppressNativePuck}
        navDot={navDot}
        initialView={initialView}
        onMapPress={onMapPress}
        onPickPoint={onPickPoint}
        onViewChange={onViewChange}
        onUserGesture={navCam.onUserGesture}
        onDestinationMoved={onDestinationMoved}
      />

      {/* Sustained dead reckoning ≈ inside a tunnel: dim the map (the UI on
          top stays bright) until live GPS returns. */}
      {nav.state !== null ? (
        <Animated.View pointerEvents="none" style={[styles.tunnelDim, { opacity: tunnelDim }]} />
      ) : null}

      {/* The screen-fixed nav chevron (see navPuckVisible above). */}
      {navPuckVisible ? (
        <View
          pointerEvents="none"
          style={[styles.navPuckWrap, { top: navPuckTop - 21, left: win.width / 2 - 21 }]}
        >
          <View style={{ transform: [{ rotate: `${navPuckRotation}deg` }] }}>
            {/* Grey when the GPS signal is lost, so a frozen puck reads as
                "no signal", not "we're still here". */}
            <NavArrowIcon color={nav.state?.fix === 'lost' ? '#9aa0a6' : '#1a73e8'} />
          </View>
        </View>
      ) : null}

      <NavBanner nav={nav} topInset={topInset} onHeight={setNavHeight} />

      {/* Expanded search overlay (input at the top, clear of the keyboard);
          hidden while navigating — the banner owns the top then. */}
      {searchOpen && !following && !planning && !previewing ? (
        <SearchBar
          packs={packs}
          getBias={getBias}
          onPick={onPickResult}
          onClose={() => setSearchOpen(false)}
          top={controlsTop}
          getSetting={getSetting}
          setSetting={setSetting}
        />
      ) : null}

      {/* Top-right during navigation: map orientation + route overview. */}
      {following ? (
        <View style={[styles.buttonColumn, { top: controlsTop }]}>
          <Pressable
            style={styles.roundButton}
            onPress={toggleNavFollow}
            testID="toggle-orientation"
          >
            {/* Course-up = blue arrow pointing forward (up on screen); north-up = N. */}
            {navFollow === 'north' ? <Text style={styles.orientText}>N</Text> : <NavArrowIcon />}
          </Pressable>
          {/* Whole-remaining-route overview; tap again (or wait) to re-follow. */}
          <Pressable
            style={[styles.roundButton, navCam.overview && styles.roundButtonActive]}
            onPress={navCam.toggleOverview}
            testID="toggle-overview"
          >
            <Text style={styles.orientText}>{'🗺'}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Name of the road being driven, pinned bottom-centre (Google-style).
          Inside a mapped tunnel it names the tunnel and counts it down
          instead — the road underneath is still E6, but "Brynstunnelen ·
          1.2 km" is what the driver can check against the world outside. */}
      {following && (nav.state?.tunnel || nav.state?.currentRoad) ? (
        <View
          style={[
            styles.roadChipWrap,
            landscape && styles.roadChipWrapLandscape,
            { bottom: bottomInset + 26 },
          ]}
          pointerEvents="none"
        >
          <View style={[styles.roadChip, landscape && styles.roadChipLandscape]}>
            <Text style={styles.roadChipText} numberOfLines={1}>
              {nav.state.tunnel ? tunnelChipLabel(nav.state.tunnel) : nav.state.currentRoad}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Free look-around during navigation: a pan pauses the follow camera;
          this pill (or the locate button, or a 12 s timeout) re-engages it. */}
      {following && navCam.followPaused ? (
        <View style={[styles.recentreWrap, { bottom: bottomInset + 88 }]} pointerEvents="box-none">
          <Pressable style={styles.recentrePill} onPress={navCam.resumeFollow} testID="recentre">
            <NavArrowIcon />
            <Text style={styles.recentreText}>Re-centre</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Bottom-right: recentre on the current position (RoutePanel owns the
          bottom while planning, so hide it then; while navigating the follow
          camera + Re-centre pill cover it, so it's hidden too). */}
      {!planning && !previewing && !following ? (
        <View style={[styles.locateWrap, { bottom: bottomInset + 24 }]}>
          <Pressable style={styles.roundButton} onPress={() => void locate()} testID="locate">
            <CrosshairIcon />
          </Pressable>
        </View>
      ) : null}

      {/* Hidden while planning/previewing — a panel owns the bottom then. */}
      {!planning && !previewing ? (
        <MenuCluster
          bottomInset={bottomInset}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen((o) => !o)}
          following={following}
          onOpenFavorites={() => setFavoritesOpen(true)}
          onOpenTracks={() => setTracksOpen(true)}
          onOpenLayers={() => setLayersOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onPlanRoute={() => route.start()}
        />
      ) : null}

      {useOffline && !planning && !previewing && !following ? (
        // Above the scalebar strip (bottom-centre) so the two never overlap.
        // Hidden mid-trip: in landscape the bottom offsets put it across the
        // middle of the map, and which tile source is in use is not something
        // a driver needs told while the banner and road chip own the screen.
        <View style={[styles.offlineBadge, { bottom: bottomInset + 116 }]}>
          <Text style={styles.offlineBadgeText}>offline map: {offlinePack?.manifest.name}</Text>
        </View>
      ) : null}
      {packs.length > 0 && !planning && !previewing && !following ? (
        // Stacked above the bottom-right locate button. Hidden mid-trip: the
        // offline fallback is automatic (useMapStyle), the switch only forces it.
        <View style={[styles.offlineToggle, { bottom: bottomInset + 84 }]}>
          <Text style={styles.offlineToggleText}>Offline</Text>
          <Switch value={forceOffline} onValueChange={setForceOffline} testID="force-offline" />
        </View>
      ) : null}

      {data.status === 'error' ? (
        <View style={[styles.banner, { top: topInset + 60 }]}>
          <Text style={styles.bannerText}>Storage unavailable: {data.error}</Text>
        </View>
      ) : null}
      {writeError ? (
        <Pressable
          style={[styles.banner, { top: topInset + 60 }]}
          onPress={clearWriteError}
          testID="write-error-banner"
        >
          <Text style={styles.bannerText}>{writeError} — the change was not saved.</Text>
        </Pressable>
      ) : null}
      <UpdateNotices storage={data.storage} topInset={topInset} />

      {destination && !planning ? (
        <DestinationCard
          target={destination}
          onDirections={planTo}
          onSave={
            destination.canSave
              ? () => {
                  void data.savePlace({
                    name: destination.name,
                    lat: destination.lat,
                    lng: destination.lng,
                  });
                  setDestination(null);
                }
              : undefined
          }
          onEdit={
            destination.placeId
              ? () => {
                  setEditPlaceId(destination.placeId!);
                  setFavoritesOpen(true);
                  setDestination(null);
                }
              : undefined
          }
          onShare={shareDestination}
          onWeather={() => setWeatherTarget({ lat: destination.lat, lng: destination.lng })}
          onCancel={() => setDestination(null)}
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

      <RoutePreview nav={nav} bottomInset={bottomInset} />

      <AppSheets
        data={data}
        sync={sync}
        packs={packs}
        onPacksChanged={refreshPacks}
        bottomInset={bottomInset}
        favoritesOpen={favoritesOpen}
        onCloseFavorites={() => {
          setFavoritesOpen(false);
          setEditPlaceId(null);
        }}
        editPlaceId={editPlaceId}
        tracksOpen={tracksOpen}
        onCloseTracks={() => setTracksOpen(false)}
        layersOpen={layersOpen}
        onCloseLayers={() => setLayersOpen(false)}
        overlays={overlaysCtl}
        settingsOpen={settingsOpen}
        onCloseSettings={() => setSettingsOpen(false)}
        pendingPin={pendingPin}
        onDismissPendingPin={() => setPendingPin(null)}
        onFlyTo={flyTo}
        onPickDestination={pickDestination}
        onImportTracks={importTracks}
      />
      {planning ? (
        <RoutePanel
          route={route}
          transit={transit}
          packs={packs}
          places={data.places}
          getBias={getBias}
          onExport={exportRoute}
          onNavigate={startNavigation}
          getMyLocation={getMyLocation}
          bottomInset={bottomInset}
        />
      ) : null}
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
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tunnelDim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(4, 8, 16, 0.4)',
  },
  buttonColumn: { position: 'absolute', right: 12, gap: 10, alignItems: 'center' },
  locateWrap: { position: 'absolute', right: 12 },
  recentreWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  navPuckWrap: {
    position: 'absolute',
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
  recentrePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.surface,
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 10,
    elevation: 5,
  },
  recentreText: { color: theme.text, fontWeight: '700', fontSize: 15 },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  orientText: { fontSize: 18, fontWeight: '800', color: theme.accent },
  roundButtonActive: { backgroundColor: theme.surfaceActive },
  roadChipWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  // Landscape: hug the left edge so the centred nav chevron stays uncovered.
  roadChipWrapLandscape: { alignItems: 'flex-start', paddingLeft: 16 },
  // …and keep a long road name from growing back into the chevron's column;
  // the name ellipsises instead (numberOfLines is already 1).
  roadChipLandscape: { maxWidth: '40%' },
  roadChip: {
    backgroundColor: theme.surfaceOverlay,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 6,
    maxWidth: '70%',
    elevation: 4,
  },
  roadChipText: { color: theme.text, fontWeight: '700', fontSize: 14 },
  offlineBadge: {
    position: 'absolute',
    bottom: 96,
    alignSelf: 'center',
    backgroundColor: theme.surfaceOverlay,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
    elevation: 2,
  },
  offlineBadgeText: { color: theme.text, fontSize: 12 },
  offlineToggle: {
    position: 'absolute',
    bottom: 36,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    elevation: 4,
    gap: 6,
  },
  offlineToggleText: { fontSize: 13, color: theme.textMuted },
  banner: {
    position: 'absolute',
    top: 100,
    left: 12,
    right: 12,
    backgroundColor: theme.danger,
    borderRadius: 8,
    padding: 10,
  },
  bannerText: { color: '#fff' },
});
