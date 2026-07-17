import { haversineM, placeIsVisible, type SearchResult, type VisibilityFolder } from '@atlas/core';
import { buildGpx } from '@atlas/gpx';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  Marker,
  UserLocation,
  type CameraRef,
  type MapRef,
} from '@maplibre/maplibre-react-native';
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
import { Pressable, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import type { LatLng } from '@atlas/core';
import { hydrateServerOrigin, useServerOrigin } from './src/serverOrigin';
import {
  buildOfflineStyle,
  buildOnlineStyle,
  FALLBACK_STYLE_URL,
  loadStyleTemplate,
} from './src/mapStyle';
import type { LocalPack } from './src/regions/packs';
import { NavBanner } from './src/nav/NavBanner';
import { useNavigation } from './src/nav/useNavigation';
import { listLocalPacks } from './src/regions/packs';
import { SearchBar } from './src/search/SearchBar';
import { useSync } from './src/sync/useSync';
import { useRoute } from './src/routing/useRoute';
import { shareText } from './src/share';
import { DestinationCard, type DestinationTarget } from './src/ui/DestinationCard';
import { FavoritesSheet } from './src/ui/FavoritesSheet';
import { CrosshairIcon, MenuIcon, NavArrowIcon, PlacePin, SearchIcon } from './src/ui/icons';
import { PromptModal } from './src/ui/PromptModal';
import { RoutePanel } from './src/ui/RoutePanel';
import { SettingsSheet } from './src/ui/SettingsSheet';
import { UpdateNotices } from './src/update/UpdateNotices';
import { TracksSheet } from './src/ui/TracksSheet';
import { useTrackGeometry } from './src/useTrackGeometry';
import { useUserData } from './src/useUserData';

function routeToGeoJSON(coords: number[][]) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: coords },
  };
}

/** Dashed rectangles showing what the downloaded offline packs cover. */
function packOutlinesGeoJSON(packs: LocalPack[]) {
  return {
    type: 'FeatureCollection' as const,
    features: packs.map((p) => {
      const { sw, ne } = p.manifest.bbox;
      return {
        type: 'Feature' as const,
        properties: { name: p.manifest.name },
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [sw.lng, sw.lat],
            [ne.lng, sw.lat],
            [ne.lng, ne.lat],
            [sw.lng, ne.lat],
            [sw.lng, sw.lat],
          ],
        },
      };
    }),
  };
}

/**
 * Follow-mode zoom from ground speed — the OsmAnd/Google approach: rather than
 * a fixed zoom, keep a constant look-ahead *time*, i.e. pick the zoom at which
 * the distance covered in the next ~12 s fits the forward part of the screen.
 * 78271.5 m is the ground size of one 512px tile pixel at zoom 0 on the
 * equator; cos(lat) corrects for Web Mercator stretch. Clamped to a sane
 * range and quantized so GPS jitter doesn't constantly re-target the camera.
 */
function zoomForSpeed(speedMps: number | null, lat: number | undefined): number {
  const LOOKAHEAD_S = 12;
  const FORWARD_DP = 400; // roughly the screen half ahead of the position puck
  const v = speedMps ?? 0;
  if (v < 1) return 17; // stationary/unknown: close-in city zoom
  const metersAhead = v * LOOKAHEAD_S;
  const scale = 78271.5 * Math.cos(((lat ?? 60) * Math.PI) / 180);
  const z = Math.log2((scale * FORWARD_DP) / metersAhead);
  return Math.round(Math.min(17.5, Math.max(15, z)) * 4) / 4;
}

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
  const win = useWindowDimensions();
  const data = useUserData();
  // Draw only effectively-visible places (own toggle on, no hiding folder). The
  // Favorites sheet still lists hidden ones so they can be shown again.
  const visiblePlaces = useMemo(() => {
    const folders = new Map<string, VisibilityFolder>(
      data.collections.map((c) => [c.id, { parentId: c.parentId, visible: c.visible }]),
    );
    return data.places.filter((p) => placeIsVisible(p, folders));
  }, [data.places, data.collections]);
  const serverOrigin = useServerOrigin();
  const sync = useSync(data.storage, data.refreshAll, data.places);
  const nav = useNavigation();
  const route = useRoute();
  // Geometry of the visible tracks, for the map's track line layer.
  const trackGeo = useTrackGeometry(data.storage, data.tracks);

  const [originReady, setOriginReady] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);
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

  // Camera follow: course-up / north-up while navigating; free pan when idle
  // (the locate button does a one-shot recentre instead of locking the camera).
  const trackUserLocation = following ? (navFollow === 'north' ? 'default' : 'course') : undefined;
  // Speed-appropriate follow zoom (constant look-ahead time, see zoomForSpeed).
  const navZoom = useMemo(
    () => zoomForSpeed(nav.speedMps, nav.state?.snapped.lat),
    [nav.speedMps, nav.state?.snapped.lat],
  );

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

  const startNavigation = useCallback(() => {
    if (!destination) return;
    setNavFollow('course');
    void nav.start({ lat: destination.lat, lng: destination.lng }, travelMode);
    setDestination(null);
  }, [destination, travelMode, nav]);

  // Route planning owns the bottom of the screen and repurposes map taps to add
  // stops, so it can't share the screen with a destination card.
  const planning = route.active;
  // The routed line to draw while planning (selected path, primary or alt).
  const planPath = route.paths?.[route.selectedPath] ?? null;

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

  // Load the persisted server override before any server request fires, so the
  // first health check / style fetch already targets the configured server.
  useEffect(() => {
    if (!data.storage) return;
    void hydrateServerOrigin(data.storage).finally(() => setOriginReady(true));
  }, [data.storage]);

  useEffect(() => {
    if (!originReady) return;
    setServerUp(null);
    void loadStyleTemplate().then(setTemplate);
    fetch(`${serverOrigin}/api/health`, { signal: AbortSignal.timeout(4000) })
      .then((res) => setServerUp(res.ok))
      .catch(() => setServerUp(false));
    refreshPacks();
  }, [originReady, serverOrigin, refreshPacks]);

  // Offline first: local pack when the server is unreachable (or forced);
  // otherwise the server-hosted style. Fallback keeps the map usable bare.
  const offlinePack = packs.find((p) => p.manifest.files.basemap);
  const useOffline = (forceOffline || serverUp === false) && offlinePack && template;
  const mapStyle = useMemo(() => {
    if (useOffline && offlinePack && template) return buildOfflineStyle(template, offlinePack.dir);
    if (template) return buildOnlineStyle(template);
    return serverUp === null ? null : FALLBACK_STYLE_URL;
  }, [useOffline, offlinePack, template, serverUp]);

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
      <MapLibreMap
        ref={mapRef}
        style={styles.map}
        mapStyle={mapStyle}
        // Edge-to-edge: the map draws behind the system nav bar, so lift the
        // MapLibre attribution/logo ornaments clear of it. Attribution sits
        // left of the bottom-right locate button; the logo takes the (now
        // empty) top-left corner, clear of the bottom button clusters.
        attributionPosition={{ bottom: bottomInset + 8, right: 64 }}
        logoPosition={{ top: topInset + 8, left: 8 }}
        // The scale bar was lost in the maplibre-react-native v11 upgrade (the
        // default flipped to off). Android's native ScaleBarPlugin only anchors
        // top-left, so bottom-centre is expressed as top/left margins computed
        // from the window size; the native side adds the status-bar inset to
        // the top margin, so subtract it here. The bar keeps the middle of the
        // bottom edge, between the menu cluster and the locate button.
        scaleBar
        scaleBarPosition={{
          top: Math.max(0, Math.round(win.height - bottomInset - 88 - topInset)),
          left: Math.round(win.width * 0.3),
        }}
        // While planning a route, a tap drops a stop; otherwise a tap dismisses
        // the ☰ menu or picks a saved pin (see onMapPress). Long-press picks any
        // point as a destination. Both gestures add a stop in plan mode so it
        // feels the same as the web map click.
        onPress={(e) => {
          const [lng, lat] = e.nativeEvent.lngLat;
          onMapPress(lng, lat);
        }}
        onLongPress={(e) => {
          const [lng, lat] = e.nativeEvent.lngLat;
          if (planning) {
            route.addWaypoint({ lat, lng });
            return;
          }
          pickDestination({
            lat,
            lng,
            name: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
            canSave: true,
          });
        }}
      >
        {/* Coverage of downloaded offline packs, so blank areas are explicable. */}
        {packs.length > 0 ? (
          <GeoJSONSource id="atlas-pack-outlines" data={packOutlinesGeoJSON(packs)}>
            <Layer
              type="line"
              id="atlas-pack-outlines-line"
              paint={{
                'line-color': '#1a73e8',
                'line-width': 1.5,
                'line-opacity': 0.45,
                'line-dasharray': [2, 2],
              }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Saved/imported tracks (visible ones), drawn under the routes. */}
        {trackGeo.features.length > 0 ? (
          <GeoJSONSource id="atlas-tracks" data={trackGeo}>
            <Layer
              type="line"
              id="atlas-tracks-line"
              paint={{ 'line-color': '#2a78d6', 'line-width': 4, 'line-opacity': 0.9 }}
            />
          </GeoJSONSource>
        ) : null}
        {nav.routeCoords.length > 1 ? (
          <GeoJSONSource id="atlas-route" data={routeToGeoJSON(nav.routeCoords)}>
            <Layer
              type="line"
              id="atlas-route-line"
              paint={{ 'line-color': '#2b6cff', 'line-width': 6, 'line-opacity': 0.85 }}
            />
          </GeoJSONSource>
        ) : null}
        {/* Planned route (route-planning panel): distinct colour from navigation. */}
        {planning && planPath ? (
          <GeoJSONSource
            id="atlas-plan"
            data={routeToGeoJSON(planPath.points.map((p) => [p.lng, p.lat]))}
          >
            <Layer
              type="line"
              id="atlas-plan-line"
              paint={{ 'line-color': '#7c3aed', 'line-width': 6, 'line-opacity': 0.85 }}
            />
            {/* Travel-direction chevrons — the only cue to which way a round
                trip runs. keep-upright must stay off or right-to-left segments
                would flip the glyph and point it backwards. */}
            <Layer
              type="symbol"
              id="atlas-plan-arrows"
              layout={{
                'symbol-placement': 'line',
                'symbol-spacing': 80,
                'text-field': '›',
                'text-font': ['Noto Sans Bold'],
                'text-size': 20,
                'text-offset': [0, -0.12],
                'text-keep-upright': false,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{ 'text-color': '#ffffff' }}
            />
          </GeoJSONSource>
        ) : null}
        {planning
          ? route.waypoints.map((w, i) => (
              <Marker key={w.id} lngLat={[w.pos.lng, w.pos.lat]} anchor="bottom">
                <View style={styles.wpMarker}>
                  <Text style={styles.wpMarkerText}>
                    {route.roundTrip || route.waypoints.length === 1
                      ? '⟳'
                      : i < 26
                        ? String.fromCharCode(65 + i)
                        : String(i + 1)}
                  </Text>
                </View>
              </Marker>
            ))
          : null}
        <Camera
          ref={cameraRef}
          initialViewState={{ center: [10.75, 59.91], zoom: 10 }}
          // Course-up / north-up follow while navigating (see `trackUserLocation`),
          // a plain centre-on-user when the locate button engaged it, else free pan.
          trackUserLocation={trackUserLocation}
          {...(following ? { zoom: navZoom } : {})}
        />
        {following || showPuck ? <UserLocation heading={following} animated /> : null}
        {nav.destination ? (
          <Marker lngLat={[nav.destination.lng, nav.destination.lat]} anchor="bottom">
            <PlacePin color="#16324f" icon="🏁" />
          </Marker>
        ) : destination ? (
          <Marker lngLat={[destination.lng, destination.lat]} anchor="bottom">
            <PlacePin color="#d33939" />
          </Marker>
        ) : null}
        {/* Saved places as colour-badged teardrop pins (web-parity markers).
            The marker view itself never handles touches (they aren't delivered
            reliably) — taps fall through to the map, and onMapPress hit-tests
            the pins to open the destination card (Navigate / Edit). */}
        {visiblePlaces.map((place) => (
          <Marker key={place.id} lngLat={[place.lng, place.lat]} anchor="bottom">
            <View pointerEvents="none" testID={`place-pin-${place.id}`}>
              <PlacePin color={place.color} icon={place.icon} />
            </View>
          </Marker>
        ))}
      </MapLibreMap>

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

      {/* Bottom-left cluster: hamburger menu (places, tracks, settings live in
          sheets it opens) + search + route planning. Hidden while planning —
          the RoutePanel owns the bottom of the screen then. */}
      {!planning ? (
        <View style={[styles.menuWrap, { bottom: bottomInset + 24 }]} pointerEvents="box-none">
          {menuOpen ? (
            <View style={styles.menuCard}>
              {(
                [
                  ['Places & folders', 'open-favorites', () => setFavoritesOpen(true)],
                  ['Tracks', 'open-tracks', () => setTracksOpen(true)],
                  ['Settings', 'open-settings', () => setSettingsOpen(true)],
                ] as const
              ).map(([label, testID, openSheet]) => (
                <Pressable
                  key={testID}
                  style={styles.menuItem}
                  testID={testID}
                  onPress={() => {
                    setMenuOpen(false);
                    openSheet();
                  }}
                >
                  <Text style={styles.menuItemText}>{label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.bottomRow}>
            <Pressable
              style={styles.roundButton}
              onPress={() => setMenuOpen((o) => !o)}
              testID="open-menu"
            >
              <MenuIcon />
            </Pressable>
            {!following ? (
              <Pressable
                style={styles.roundButton}
                onPress={() => setSearchOpen(true)}
                testID="search-open"
              >
                <SearchIcon />
              </Pressable>
            ) : null}
            {!following ? (
              <Pressable
                style={styles.roundButton}
                onPress={() => route.start()}
                testID="plan-route"
              >
                {/* Up-then-right arrow — the conventional "directions" glyph (OSM). */}
                <Text style={styles.routeArrow}>{'↱'}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
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

      <FavoritesSheet
        visible={favoritesOpen}
        onClose={() => {
          setFavoritesOpen(false);
          setEditPlaceId(null);
        }}
        editId={editPlaceId}
        places={data.places}
        collections={data.collections}
        onFlyTo={(p) => flyTo(p)}
        onNavigate={(p) => {
          setFavoritesOpen(false);
          pickDestination({ lat: p.lat, lng: p.lng, name: p.name ?? 'Favorite', canSave: false });
        }}
        onPatch={(id, patch) => void data.updatePlace(id, patch)}
        onDelete={(id) => void data.deletePlace(id)}
        onCreateFolder={(name) => void data.createCollection(name)}
        onRenameFolder={(id, name) => void data.renameCollection(id, name)}
        onSetFolderVisible={(id, v) => void data.setCollectionVisible(id, v)}
        onDeleteFolder={(id) => void data.deleteCollection(id)}
        onSetAllVisible={(v) => void data.setAllVisible(v)}
        onReorderPlaces={(ids) => void data.reorderPlaces(ids)}
        onReorderCollections={(ids) => void data.reorderCollections(ids)}
        bottomInset={bottomInset}
      />
      <TracksSheet
        visible={tracksOpen}
        onClose={() => setTracksOpen(false)}
        tracks={data.tracks}
        onSetVisible={(id, v) => void data.updateTrack(id, { visible: v })}
        onRename={(id, name) => void data.updateTrack(id, { name })}
        onExport={(id, format) => void data.exportTrack(id, format)}
        onDelete={(id) => void data.deleteTrack(id)}
        onImport={importTracks}
        bottomInset={bottomInset}
      />
      <SettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sync={sync}
        packs={packs}
        onPacksChanged={refreshPacks}
        storage={data.storage}
        onExportAll={() => void data.exportAll()}
        bottomInset={bottomInset}
      />
      <PromptModal
        visible={pendingPin !== null}
        title="Name this pin"
        placeholder="e.g. Home, Trailhead…"
        confirmLabel="Save pin"
        onCancel={() => setPendingPin(null)}
        onConfirm={(value) => {
          if (!pendingPin) return;
          const { lat, lng } = pendingPin;
          const name = value.trim() || `Pin ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
          void data.savePlace({ name, lat, lng });
          setPendingPin(null);
        }}
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
  map: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  buttonColumn: { position: 'absolute', right: 12, gap: 10, alignItems: 'center' },
  menuWrap: { position: 'absolute', left: 12, alignItems: 'flex-start', gap: 8 },
  bottomRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  locateWrap: { position: 'absolute', right: 12 },
  menuCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 4,
    minWidth: 180,
    elevation: 6,
  },
  menuItem: { paddingHorizontal: 16, paddingVertical: 12 },
  menuItemText: { fontSize: 15, color: '#1c2733' },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  routeArrow: { fontSize: 24, fontWeight: '800', color: '#1a73e8' },
  orientText: { fontSize: 18, fontWeight: '800', color: '#1a73e8' },
  wpMarker: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#7c3aed',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  wpMarkerText: { color: '#fff', fontWeight: '800', fontSize: 13 },
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
