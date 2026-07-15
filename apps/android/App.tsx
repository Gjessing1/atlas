import type { SearchResult } from '@atlas/core';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  type CameraRef,
} from '@maplibre/maplibre-react-native';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import type { PlaceRecord } from '@atlas/storage';
import { SERVER_ORIGIN } from './src/config';
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

export default function App() {
  const data = useUserData();
  const sync = useSync(data.storage, data.refreshAll, data.places);
  const nav = useNavigation();

  const [template, setTemplate] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [packs, setPacks] = useState<LocalPack[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [forceOffline, setForceOffline] = useState(false);
  const cameraRef = useRef<CameraRef>(null);

  const refreshPacks = useCallback(() => {
    void listLocalPacks().then(setPacks);
  }, []);

  useEffect(() => {
    void loadStyleTemplate().then(setTemplate);
    fetch(`${SERVER_ORIGIN}/api/health`, { signal: AbortSignal.timeout(4000) })
      .then((res) => setServerUp(res.ok))
      .catch(() => setServerUp(false));
    refreshPacks();
  }, [refreshPacks]);

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

  if (data.status === 'loading' || mapStyle === null) {
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
        <Camera ref={cameraRef} initialViewState={{ center: [10.75, 59.91], zoom: 10 }} />
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

      <NavBanner nav={nav} />

      <SearchBar packs={packs} onPick={onPickResult} />

      <Pressable style={styles.gear} onPress={() => setSettingsOpen(true)} testID="open-settings">
        <Text style={styles.gearText}>⚙</Text>
      </Pressable>

      {useOffline ? (
        <View style={styles.offlineBadge}>
          <Text style={styles.offlineBadgeText}>offline map: {offlinePack?.manifest.name}</Text>
        </View>
      ) : null}
      {packs.length > 0 ? (
        <View style={styles.offlineToggle}>
          <Text style={styles.offlineToggleText}>Offline</Text>
          <Switch value={forceOffline} onValueChange={setForceOffline} testID="force-offline" />
        </View>
      ) : null}

      {data.status === 'error' ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Storage unavailable: {data.error}</Text>
        </View>
      ) : null}

      <SettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sync={sync}
        packs={packs}
        onPacksChanged={refreshPacks}
      />
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  gear: {
    position: 'absolute',
    top: 48,
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  gearText: { fontSize: 22 },
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
