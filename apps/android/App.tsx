import { useMapProfile, useNavPrefs, useThemeMode } from '@atlas/app-hooks';
import { mapProfile, placeIsVisible, type MapAppearance, type VisibilityFolder } from '@atlas/core';
import { buildGpx } from '@atlas/gpx';
import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import {
  isRoutingProfile,
  ROUTING_PROFILES,
  routePathToTrackData,
  type RoutePath,
} from '@atlas/routing';
import { transitTripBounds, type TransitTrip } from '@atlas/transit';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Appearance,
  BackHandler,
  Pressable,
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

import type { LatLng } from '@atlas/core';
import { MapScene } from './src/map/MapScene';
import { useBootCamera } from './src/map/useBootCamera';
import { useMapPress } from './src/map/useMapPress';
import { useOverlayLabels } from './src/layers/useOverlayLabels';
import { useOverlays } from './src/layers/useOverlays';
import { useMapStyle } from './src/map/useMapStyle';
import { useTileSource } from './src/map/useTileSource';
import type { LocalPack } from './src/regions/packs';
import { NavBanner } from './src/nav/NavBanner';
import { NavChrome, useNavPuck } from './src/nav/NavChrome';
import { navViewport } from './src/nav/navViewport';
import { RoutePreview } from './src/nav/RoutePreview';
import { useNavCamera } from './src/nav/useNavCamera';
import { useNavigation } from './src/nav/useNavigation';
import { useTunnelDim } from './src/nav/useTunnelDim';
import { listLocalPacks } from './src/regions/packs';
import { SearchBar } from './src/search/SearchBar';
import { useServerOrigin } from './src/serverOrigin';
import { shareText } from './src/share';
import { useSync } from './src/sync/useSync';
import { useDirections } from './src/routing/useDirections';
import { useRoute } from './src/routing/useRoute';
import { useTransitPlan } from './src/routing/useTransit';
import { AppSheets } from './src/ui/AppSheets';
import { DestinationCard } from './src/ui/DestinationCard';
import { useDestination } from './src/ui/useDestination';
import { CloudOffIcon, CrosshairIcon } from './src/ui/icons';
import { useSideInsets } from './src/ui/insets';
import { theme } from './src/ui/theme';
import { MainMenuSheet } from './src/ui/MainMenuSheet';
import { MenuCluster } from './src/ui/MenuCluster';
import { MapActivityControls } from './src/ui/MapActivityControls';
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
  // Activity profile + overlay state are device-local and shared by the
  // one-tap map controls, the route default, and the full Layers sheet.
  const profiles = useMapProfile(data);
  const mapAppearance = useMemo<MapAppearance>(
    () => ({ colorScheme: appearance.colorScheme, profile: profiles.profile.id }),
    [appearance.colorScheme, profiles.profile.id],
  );
  const overlaysCtl = useOverlays(data, profiles.profile.id);
  const serverOrigin = useServerOrigin();

  const [packs, setPacks] = useState<LocalPack[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // The expanded search overlay (the 🔍 button in the bottom-left cluster opens it).
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  // Place whose focused editor should open (map pin → Edit).
  const [editPlaceId, setEditPlaceId] = useState<string | null>(null);
  const [tracksOpen, setTracksOpen] = useState(false);
  const [navHeight, setNavHeight] = useState(0);
  // Coords awaiting a name before they're saved as a pin (name-on-save prompt).
  const [pendingPin, setPendingPin] = useState<LatLng | null>(null);
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

  const flyTo = useCallback((p: LatLng) => {
    cameraRef.current?.flyTo({ center: [p.lng, p.lat], zoom: 14, duration: 900 });
  }, []);

  // Every picked point — map tap, long-press, search hit, favorite, link pin.
  const dest = useDestination(flyTo);
  const { pickPoint } = dest;
  // A pin carried by a launch/deep link opens its card; the camera is already
  // on its way there from the link's own view, so it must not fly again.
  const onLinkPin = useCallback((pin: LatLng) => pickPoint(pin, false), [pickPoint]);
  // Where the map opens, where it is now, and remembering that for next launch.
  const camera = useBootCamera(data, cameraRef, onLinkPin);
  const { initialView, viewRef, mapZoom, getBias } = camera;
  const overlayLabels = useOverlayLabels(overlaysCtl.overlays, camera.labelCell);

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
  const viewport = useMemo(
    () => navViewport(win.width, win.height, side, topInset, bottomInset),
    [win.width, win.height, side, topInset, bottomInset],
  );
  const landscape = viewport.landscape;
  // Mute and map orientation survive across trips (device-local, web parity).
  const navPrefs = useNavPrefs(data, nav);
  // The follow camera uses the same responsive viewport as the visible puck:
  // centred in portrait, or in the unobstructed right pane in landscape.
  const navCam = useNavCamera(cameraRef, nav, navPrefs.followMode, viewport, navHeight);
  const navPuck = useNavPuck(nav, navCam, navPrefs.followMode, viewport);
  const tunnelDim = useTunnelDim(nav.state?.fix, nav.state?.tunnel != null);
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
  const idleSheetOpen = searchOpen || menuOpen || dest.destination !== null;
  // Landscape is short, so several pieces of chrome move into the leading
  // guidance rail and route fits get a narrower bottom pad.

  const { onMapPress, onPickPoint } = useMapPress({
    mapRef,
    nav,
    route,
    places: visiblePlaces,
    overlays: overlaysCtl.overlays,
    origin: serverOrigin,
    menuOpen,
    closeMenu: () => setMenuOpen(false),
    pickDestination: dest.pick,
    showIdentify: dest.showIdentify,
  });

  // Picking an activity also chooses the route planner's starting mode where
  // one exists. Explore and Ski intentionally leave its last mode alone.
  const onPickMapProfile = useCallback(
    (id: string) => {
      const next = mapProfile(id);
      // Selecting an activity applies its signature layers. In particular,
      // Hike must immediately show Hiking trails, matching the web profile's
      // default instead of requiring a second trip through Layers.
      if (id !== profiles.profile.id) {
        for (const layerId of next.defaultLayers ?? []) overlaysCtl.setOn(layerId, true);
      }
      profiles.setProfile(id);
      const routing = next.routing;
      if (routing !== null && isRoutingProfile(routing)) route.setProfile(routing);
    },
    [profiles, overlaysCtl, route],
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
    (target: LatLng) => {
      // Route selection moves from the planner to Navigation's route-choice
      // preview. Close the planner immediately so it cannot cover that sheet,
      // and so its background route/mode requests are cancelled while
      // Navigation obtains a current-position route exactly once.
      route.stop();
      void nav.start(target, route.profile);
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

  // Downloaded tiles win wherever a pack covers the view (Settings can force
  // server tiles); everything else — search, routing, weather — stays online-first.
  const tiles = useTileSource(data, packs, camera.viewCenter);
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
        overlays={overlaysCtl.overlays}
        overlayLabels={overlayLabels}
        trackGeo={trackGeo}
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
        onMapPress={onMapPress}
        onPickPoint={onPickPoint}
        onViewChange={camera.onViewChange}
        onUserGesture={navCam.onUserGesture}
        onDestinationMoved={dest.onMoved}
      />

      {/* Sustained dead reckoning ≈ inside a tunnel: dim the map (the UI on
          top stays bright) until live GPS returns. */}
      {nav.state !== null ? (
        <Animated.View pointerEvents="none" style={[styles.tunnelDim, { opacity: tunnelDim }]} />
      ) : null}

      <NavBanner
        nav={nav}
        topInset={topInset}
        bottomInset={bottomInset}
        viewport={viewport}
        navCam={navCam}
        followMode={navPrefs.followMode}
        onToggleFollowMode={navPrefs.toggleFollowMode}
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
          overlays={overlaysCtl}
          mapZoom={mapZoom}
          // Bottom-edge row, immediately left of the locate button. Menus
          // expand upward, so profile switching no longer floats mid-map.
          bottom={bottomInset + 24}
          onPickProfile={onPickMapProfile}
        />
      ) : null}

      {useOffline && showIdleChrome && tiles.showOfflineBadge ? (
        // Above the scalebar strip (bottom-centre) so the two never overlap.
        // Hidden mid-trip: in landscape the bottom offsets put it across the
        // middle of the map, and which tile source is in use is not something
        // a driver needs told while the banner and road chip own the screen.
        // Icon only: which pack is drawing is a Settings detail, and the badge
        // was reading as a label on the map rather than as status.
        <View
          style={[
            styles.offlineBadge,
            { bottom: bottomInset + 116, marginLeft: side.left, marginRight: side.right },
          ]}
          accessibilityLabel={`Offline map${
            tiles.coveringPack ? `: ${tiles.coveringPack.manifest.name}` : ''
          }`}
          testID="offline-badge"
        >
          <CloudOffIcon />
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
      <UpdateNotices storage={data.storage} topInset={topInset} />

      <MainMenuSheet
        visible={menuOpen && !planning && !navActive}
        onClose={() => setMenuOpen(false)}
        onOpenFavorites={() => setFavoritesOpen(true)}
        onOpenTracks={() => setTracksOpen(true)}
        onOpenLayers={() => setLayersOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        bottomInset={bottomInset}
      />

      {destination && !planning && !navActive ? (
        <DestinationCard
          target={destination}
          onDirections={() => {
            dest.clear();
            directions.planTo({ lat: destination.lat, lng: destination.lng }, destination.name);
          }}
          onSave={
            destination.canSave
              ? () => {
                  void data.savePlace({
                    name: destination.name,
                    lat: destination.lat,
                    lng: destination.lng,
                  });
                  dest.clear();
                }
              : undefined
          }
          onEdit={
            destination.placeId
              ? () => {
                  setEditPlaceId(destination.placeId!);
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
        overlays={overlaysCtl}
        tiles={tiles}
        settingsOpen={settingsOpen}
        onCloseSettings={() => setSettingsOpen(false)}
        appearance={appearance}
        pendingPin={pendingPin}
        onDismissPendingPin={() => setPendingPin(null)}
        onFlyTo={flyTo}
        onPickDestination={dest.pick}
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
          onShowTransitTrip={showTransitTrip}
          getMyLocation={directions.getMyLocation}
          locatingOrigin={directions.locatingOrigin}
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
  offlineBadge: {
    position: 'absolute',
    bottom: 96,
    alignSelf: 'center',
    backgroundColor: theme.surfaceOverlay,
    borderRadius: 15,
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
  },
  banner: {
    position: 'absolute',
    top: 100,
    backgroundColor: theme.danger,
    borderRadius: 8,
    padding: 10,
  },
  bannerText: { color: theme.onAccent },
});
