import { haversineM, placeIsVisible, type SearchResult, type VisibilityFolder } from '@atlas/core';
import { buildGpx } from '@atlas/gpx';
import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import {
  ROUTING_PROFILES,
  routePathToTrackData,
  type RoutePath,
  type RoutingProfile,
} from '@atlas/routing';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import type { LatLng } from '@atlas/core';
import { MapScene } from './src/map/MapScene';
import { useMapStyle } from './src/map/useMapStyle';
import type { LocalPack } from './src/regions/packs';
import { NavBanner } from './src/nav/NavBanner';
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

  // While a trip is active the nav banner owns the top of the screen, so drop
  // the search bar + button column below its measured height (issue: the banner
  // was covering both). `following` also turns the map course-up (issue: no map
  // orientation while travelling).
  const navActive = nav.phase !== 'idle';
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const controlsTop = topInset + 8 + (navActive ? navHeight + 8 : 0);

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

  // One handler for every map tap: dismiss the ☰ menu if it's open, add a stop
  // while planning, otherwise hit-test the saved pins. Pins are picked here at
  // the map level because touches on Marker child views are not delivered
  // reliably on-device — the map press always is.
  const onMapPress = useCallback(
    (lng: number, lat: number) => {
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      if (route.active) {
        route.addWaypoint({ lat, lng });
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
        }
      })();
    },
    [menuOpen, route, visiblePlaces, pickDestination],
  );

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

  // Recentre on the user's position. While navigating this pulls the camera back
  // onto the (course-/north-up) follow after a manual pan; when idle it's a
  // one-shot fly-to that also reveals the location puck.
  const locate = useCallback(async () => {
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
  }, []);

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

  if (data.status === 'loading' || !originReady || mapStyle === null) {
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
        navFollow={navFollow}
        showPuck={showPuck}
        onMapPress={onMapPress}
        onPickPoint={onPickPoint}
      />

      <NavBanner nav={nav} topInset={topInset} onHeight={setNavHeight} />

      {/* Expanded search overlay (input at the top, clear of the keyboard);
          hidden while navigating — the banner owns the top then. */}
      {searchOpen && !following && !planning ? (
        <SearchBar
          packs={packs}
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

      {/* Bottom-right: recentre on the current position (RoutePanel owns the
          bottom while planning, so hide it then). */}
      {!planning ? (
        <View style={[styles.locateWrap, { bottom: bottomInset + 24 }]}>
          <Pressable style={styles.roundButton} onPress={() => void locate()} testID="locate">
            <CrosshairIcon />
          </Pressable>
        </View>
      ) : null}

      {/* Hidden while planning — the RoutePanel owns the bottom of the screen. */}
      {!planning ? (
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

      {useOffline && !planning ? (
        // Above the scalebar strip (bottom-centre) so the two never overlap.
        <View style={[styles.offlineBadge, { bottom: bottomInset + 116 }]}>
          <Text style={styles.offlineBadgeText}>offline map: {offlinePack?.manifest.name}</Text>
        </View>
      ) : null}
      {packs.length > 0 && !planning ? (
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
          onCancel={() => setDestination(null)}
          bottomInset={bottomInset}
        />
      ) : null}

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
