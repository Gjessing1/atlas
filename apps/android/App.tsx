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
  type RoutingProfile,
} from '@atlas/routing';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { getServerOrigin } from './src/serverOrigin';
import { useMapStyle } from './src/map/useMapStyle';
import type { LocalPack } from './src/regions/packs';
import { NavBanner } from './src/nav/NavBanner';
import { RoutePreview } from './src/nav/RoutePreview';
import { useNavCamera } from './src/nav/useNavCamera';
import { useNavigation } from './src/nav/useNavigation';
import { listLocalPacks } from './src/regions/packs';
import { SearchBar } from './src/search/SearchBar';
import { useSync } from './src/sync/useSync';
import { useRoute } from './src/routing/useRoute';
import { shareText } from './src/share';
import { AppSheets } from './src/ui/AppSheets';
import { DestinationCard, type DestinationTarget } from './src/ui/DestinationCard';
import { CrosshairIcon, NavArrowIcon } from './src/ui/icons';
import { MenuCluster } from './src/ui/MenuCluster';
import { RoutePanel } from './src/ui/RoutePanel';
import { UpdateNotices } from './src/update/UpdateNotices';
import { useTrackGeometry } from './src/useTrackGeometry';
import { useUserData } from './src/useUserData';

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
  // Geometry of the visible tracks, for the map's track line layer.
  const trackGeo = useTrackGeometry(data.storage, data.tracks);

  const [packs, setPacks] = useState<LocalPack[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // The expanded search overlay (the 🔍 button in the bottom-left cluster opens it).
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  // Place whose edit panel the Favorites sheet should open with (map pin → Edit).
  const [editPlaceId, setEditPlaceId] = useState<string | null>(null);
  const [tracksOpen, setTracksOpen] = useState(false);
  const [forceOffline, setForceOffline] = useState(false);
  const [navHeight, setNavHeight] = useState(0);
  // Coords awaiting a name before they're saved as a pin (name-on-save prompt).
  const [pendingPin, setPendingPin] = useState<LatLng | null>(null);
  // A picked destination awaiting a travel-mode choice + "Navigate" (search
  // result, long-press, place or favorite). Cleared once navigation starts.
  const [destination, setDestination] = useState<DestinationTarget | null>(null);
  const [travelMode, setTravelMode] = useState<RoutingProfile>('car');
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
  const navPuckVisible =
    following &&
    !navCam.followPaused &&
    nav.state !== null &&
    nav.state.status !== 'off-route' &&
    nav.state.offRouteM <= 40;
  // Anchor point of the follow camera (see useNavCamera): course-up pads the
  // centre down to 75% of the screen; north-up keeps it at the middle.
  const navPuckTop = navFollow === 'course' ? win.height * 0.75 : win.height * 0.5;
  // Course-up rotates the map to the course, so the chevron points straight
  // up; north-up leaves the map at bearing 0, so the chevron shows the course.
  const navPuckRotation = navFollow === 'course' ? 0 : Math.round(nav.state?.courseDeg ?? 0);

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

  const startNavigation = useCallback(() => {
    if (!destination) return;
    setNavFollow('course');
    void nav.start({ lat: destination.lat, lng: destination.lng }, travelMode);
    setDestination(null);
  }, [destination, travelMode, nav]);

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
        topInset={topInset}
        bottomInset={bottomInset}
        packs={packs}
        trackGeo={trackGeo}
        nav={nav}
        route={route}
        destination={destination}
        visiblePlaces={visiblePlaces}
        showPuck={showPuck}
        suppressPuck={navPuckVisible}
        initialView={initialView}
        onMapPress={onMapPress}
        onPickPoint={onPickPoint}
        onViewChange={onViewChange}
        onUserGesture={navCam.onUserGesture}
        onDestinationMoved={onDestinationMoved}
      />

      {/* The screen-fixed nav chevron (see navPuckVisible above). */}
      {navPuckVisible ? (
        <View
          pointerEvents="none"
          style={[styles.navPuckWrap, { top: navPuckTop - 21, left: win.width / 2 - 21 }]}
        >
          <View style={{ transform: [{ rotate: `${navPuckRotation}deg` }] }}>
            <NavArrowIcon color="#1a73e8" />
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
        />
      ) : null}

      {/* Top-right keeps only the map-orientation toggle during navigation. */}
      {following ? (
        <View style={[styles.buttonColumn, { top: controlsTop }]}>
          <Pressable
            style={styles.roundButton}
            onPress={() => setNavFollow((m) => (m === 'course' ? 'north' : 'course'))}
            testID="toggle-orientation"
          >
            {/* Course-up = blue arrow pointing forward (up on screen); north-up = N. */}
            {navFollow === 'north' ? <Text style={styles.orientText}>N</Text> : <NavArrowIcon />}
          </Pressable>
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
          bottom while planning, so hide it then). */}
      {!planning && !previewing ? (
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
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onPlanRoute={() => route.start()}
        />
      ) : null}

      {useOffline && !planning && !previewing ? (
        // Above the scalebar strip (bottom-centre) so the two never overlap.
        <View style={[styles.offlineBadge, { bottom: bottomInset + 116 }]}>
          <Text style={styles.offlineBadgeText}>offline map: {offlinePack?.manifest.name}</Text>
        </View>
      ) : null}
      {packs.length > 0 && !planning && !previewing ? (
        // Stacked above the bottom-right locate button.
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
          mode={travelMode}
          onModeChange={setTravelMode}
          onNavigate={startNavigation}
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
          onCancel={() => setDestination(null)}
          bottomInset={bottomInset}
        />
      ) : null}

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
          packs={packs}
          places={data.places}
          getBias={getBias}
          onExport={exportRoute}
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
  buttonColumn: { position: 'absolute', right: 12, gap: 10, alignItems: 'center' },
  locateWrap: { position: 'absolute', right: 12 },
  recentreWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  navPuckWrap: {
    position: 'absolute',
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
  recentrePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(17,17,17,0.9)',
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 10,
    elevation: 5,
  },
  recentreText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  orientText: { fontSize: 18, fontWeight: '800', color: '#1a73e8' },
  offlineBadge: {
    position: 'absolute',
    bottom: 96,
    alignSelf: 'center',
    backgroundColor: 'rgba(17,17,17,0.75)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  offlineBadgeText: { color: '#fff', fontSize: 12 },
  offlineToggle: {
    position: 'absolute',
    bottom: 36,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    elevation: 4,
    gap: 6,
  },
  offlineToggleText: { fontSize: 13, color: '#334' },
  banner: {
    position: 'absolute',
    top: 100,
    left: 12,
    right: 12,
    backgroundColor: '#b3261e',
    borderRadius: 8,
    padding: 10,
  },
  bannerText: { color: '#fff' },
});
