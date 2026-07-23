import {
  EXPLORE_CATEGORIES,
  fmtDistanceM,
  type ExploreCategoryId,
  type LatLng,
  type SearchResult,
} from '@atlas/core';
import { useCallback, useEffect, useState } from 'react';
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { LocalPack } from '../regions/packs';
import { geoExplore } from '../search/geoExplore';
import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

function viewRadiusM(center: LatLng, zoom: number): number {
  const { width, height } = Dimensions.get('window');
  const metresPerPixel =
    (156_543.03392 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** Math.max(0, zoom);
  return Math.min(50_000, Math.max(500, (Math.hypot(width, height) / 2) * metresPerPixel));
}

/** Offline-capable category browse over the current Android map view. */
export function ExploreSheet({
  visible,
  packs,
  getCenter,
  zoom,
  onPick,
  onClose,
  bottomInset,
}: {
  visible: boolean;
  packs: LocalPack[];
  getCenter: () => Promise<LatLng | null>;
  zoom: number;
  onPick: (result: SearchResult) => void;
  onClose: () => void;
  bottomInset: number;
}) {
  const [category, setCategory] = useState<ExploreCategoryId>('food');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(async () => {
    const center = await getCenter();
    if (!center) return;
    setLoading(true);
    setError(false);
    try {
      const found = await geoExplore(packs, category, center, viewRadiusM(center, zoom));
      setResults(found.results);
      setOffline(found.offline);
    } catch {
      setResults([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [packs, category, getCenter, zoom]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load, refresh]);

  return (
    <BottomSheet
      visible={visible}
      mode="map"
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="explore-sheet"
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.heading}>Explore this area</Text>
          <Text style={styles.muted}>
            {offline ? 'From downloaded regions' : 'Top places in the current map view'}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.categories}>
        {EXPLORE_CATEGORIES.map((item) => (
          <Pressable
            key={item.id}
            style={[styles.category, category === item.id && styles.categorySelected]}
            onPress={() => setCategory(item.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: category === item.id }}
            testID={`explore-${item.id}`}
          >
            <Text style={styles.categoryText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.status}>
        <Text style={styles.muted}>
          {loading
            ? 'Looking nearby…'
            : error
              ? 'Explore is unavailable.'
              : `${results.length} places`}
        </Text>
        <Pressable onPress={() => setRefresh((value) => value + 1)}>
          <Text style={styles.refresh}>Refresh map view</Text>
        </Pressable>
      </View>
      {!loading && !error && results.length === 0 ? (
        <Text style={styles.empty}>No places in this category are indexed here.</Text>
      ) : null}
      <ScrollView style={styles.results}>
        {results.map((result, index) => (
          <Pressable
            style={styles.result}
            key={`${result.name}/${result.position.lat}/${result.position.lng}`}
            onPress={() => onPick(result)}
            testID={`explore-result-${index}`}
          >
            <View style={styles.resultText}>
              <Text style={styles.resultName} numberOfLines={1}>
                {result.name}
              </Text>
              {result.label ? (
                <Text style={styles.resultLabel} numberOfLines={1}>
                  {result.label}
                </Text>
              ) : null}
            </View>
            {result.distanceM !== undefined ? (
              <Text style={styles.distance}>{fmtDistanceM(result.distanceM)}</Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { color: theme.text, fontSize: 17, fontWeight: '700' },
  muted: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  close: { color: theme.textMuted, fontSize: 18, paddingHorizontal: 4 },
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  category: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  categorySelected: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  categoryText: { color: theme.text, fontWeight: '600', fontSize: 13 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  refresh: { color: theme.accent, fontWeight: '700', fontSize: 12 },
  empty: { color: theme.textMuted, fontSize: 13, marginTop: 18 },
  results: { marginTop: 6 },
  result: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    paddingVertical: 8,
  },
  resultText: { flex: 1, paddingRight: 10 },
  resultName: { color: theme.text, fontWeight: '700', fontSize: 15 },
  resultLabel: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  distance: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
});
