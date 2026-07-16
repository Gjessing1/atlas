import type { SearchResult } from '@atlas/core';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  UserLocation,
  type CameraRef,
} from '@maplibre/maplibre-react-native';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import type { LatLng } from '@atlas/core';
import type { PlaceRecord } from '@atlas/storage';
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
import { useTrackRecording } from './src/nav/useTrackRecording';
import { listLocalPacks } from './src/regions/packs';
import { SearchBar } from './src/search/SearchBar';
import { useSync } from './src/sync/useSync';
import { FavoritesSheet } from './src/ui/FavoritesSheet';
import { RecordControls } from './src/ui/RecordControls';
import { SettingsSheet } from './src/ui/SettingsSheet';
import { useUserData } from './src/useUserData';

function placesToGeoJSON(places: PlaceRecord[]) {
  return {
    type: 'FeatureCollection' as const,
    features: places.map((p) => ({
      type: 'Feature' as const,
      properties: { id: p.id, name: p.name },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    })),
  };
}

function routeToGeoJSON(coords: number[][]) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: coords },
  };
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
  const data = useUserData();
  const serverOrigin = useServerOrigin();
  const sync = useSync(data.storage, data.refreshAll, data.places);
  const nav = useNavigation();
  const rec = useTrackRecording(data.saveTrack);

  const [originReady, setOriginReady] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [packs, setPacks] = useState<LocalPack[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [forceOffline, setForceOffline] = useState(false);
  const [navHeight, setNavHeight] = useState(0);
  const cameraRef = useRef<CameraRef>(null);

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

  const refreshPacks = useCallback(() => {
    void listLocalPacks().then(setPacks);
  }, []);

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

  const onPickResult = useCallback((result: SearchResult) => {
    cameraRef.current?.flyTo({
      center: [result.position.lng, result.position.lat],
      zoom: 13,
      duration: 900,
    });
  }, []);

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
        style={styles.map}
        mapStyle={mapStyle}
        // Edge-to-edge: the map draws behind the system nav bar, so lift the
        // MapLibre attribution/logo ornaments clear of it.
        attributionPosition={{ bottom: bottomInset + 8, right: 8 }}
        logoPosition={{ bottom: bottomInset + 8, left: 8 }}
        onLongPress={(e) => {
          const [lng, lat] = e.nativeEvent.lngLat;
          Alert.alert(`${lat.toFixed(4)}, ${lng.toFixed(4)}`, undefined, [
            { text: 'Navigate here', onPress: () => void nav.start({ lat, lng }) },
            {
              text: 'Save pin',
              onPress: () =>
                void data.savePlace({ name: `Pin ${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng }),
            },
            { text: 'Cancel', style: 'cancel' },
          ]);
        }}
      >
        {nav.routeCoords.length > 1 ? (
          <GeoJSONSource id="atlas-route" data={routeToGeoJSON(nav.routeCoords)}>
            <Layer
              type="line"
              id="atlas-route-line"
              paint={{ 'line-color': '#2b6cff', 'line-width': 6, 'line-opacity': 0.85 }}
            />
          </GeoJSONSource>
        ) : null}
        <Camera
          ref={cameraRef}
          initialViewState={{ center: [10.75, 59.91], zoom: 10 }}
          // Course-up: centre on the traveller and rotate the map to the
          // direction of travel while navigating; released back to free pan
          // when the trip ends.
          trackUserLocation={following ? 'course' : undefined}
          {...(following ? { zoom: 16 } : {})}
        />
        {following ? <UserLocation heading animated /> : null}
        <GeoJSONSource
          id="atlas-places"
          data={placesToGeoJSON(data.places)}
          onPress={(e) => {
            const feature = e.nativeEvent.features[0];
            const props = feature?.properties as { id?: string; name?: string } | undefined;
            if (!props?.id) return;
            const [lng, lat] =
              feature!.geometry.type === 'Point'
                ? (feature!.geometry.coordinates as [number, number])
                : [undefined, undefined];
            Alert.alert(props.name ?? 'Place', undefined, [
              ...(lat !== undefined && lng !== undefined
                ? [{ text: 'Navigate here', onPress: () => void nav.start({ lat, lng }) }]
                : []),
              {
                text: 'Remove',
                style: 'destructive' as const,
                onPress: () => void data.deletePlace(props.id!),
              },
              { text: 'Keep', style: 'cancel' as const },
            ]);
          }}
        >
          <Layer
            type="circle"
            id="atlas-places-circles"
            paint={{
              'circle-radius': 6,
              'circle-color': '#d63f3f',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            }}
          />
        </GeoJSONSource>
      </MapLibreMap>

      <NavBanner nav={nav} topInset={topInset} onHeight={setNavHeight} />

      <SearchBar packs={packs} onPick={onPickResult} top={controlsTop} />

      <View style={[styles.buttonColumn, { top: controlsTop }]}>
        <Pressable
          style={styles.roundButton}
          onPress={() => setSettingsOpen(true)}
          testID="open-settings"
        >
          <Text style={styles.gearText}>⚙</Text>
        </Pressable>
        <Pressable
          style={styles.roundButton}
          onPress={() => setFavoritesOpen(true)}
          testID="open-favorites"
        >
          <Text style={styles.gearText}>★</Text>
        </Pressable>
        {rec.phase === 'idle' ? (
          <Pressable
            style={styles.roundButton}
            onPress={() => void rec.start()}
            testID="record-start"
          >
            <Text style={styles.recordDot}>⏺</Text>
          </Pressable>
        ) : null}
      </View>

      <RecordControls
        rec={rec}
        bottomInset={bottomInset}
        onSaved={(name) =>
          Alert.alert(name ? 'Track saved' : 'Nothing recorded', name ?? 'No fixes were recorded.')
        }
      />

      {useOffline && rec.phase === 'idle' ? (
        <View style={[styles.offlineBadge, { bottom: bottomInset + 84 }]}>
          <Text style={styles.offlineBadgeText}>offline map: {offlinePack?.manifest.name}</Text>
        </View>
      ) : null}
      {packs.length > 0 && rec.phase === 'idle' ? (
        <View style={[styles.offlineToggle, { bottom: bottomInset + 24 }]}>
          <Text style={styles.offlineToggleText}>Offline</Text>
          <Switch value={forceOffline} onValueChange={setForceOffline} testID="force-offline" />
        </View>
      ) : null}

      {data.status === 'error' ? (
        <View style={[styles.banner, { top: topInset + 60 }]}>
          <Text style={styles.bannerText}>Storage unavailable: {data.error}</Text>
        </View>
      ) : null}
      {rec.error ? (
        <View style={[styles.banner, { top: topInset + 60 }]}>
          <Text style={styles.bannerText}>Recording: {rec.error}</Text>
        </View>
      ) : null}

      <FavoritesSheet
        visible={favoritesOpen}
        onClose={() => setFavoritesOpen(false)}
        places={data.places}
        onFlyTo={(p) => flyTo(p)}
        onNavigate={(p) => void nav.start({ lat: p.lat, lng: p.lng })}
        onDelete={(id) => void data.deletePlace(id)}
        bottomInset={bottomInset}
      />
      <SettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sync={sync}
        packs={packs}
        onPacksChanged={refreshPacks}
        storage={data.storage}
        bottomInset={bottomInset}
      />
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
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  gearText: { fontSize: 22 },
  recordDot: { fontSize: 20, color: '#d63f3f' },
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
