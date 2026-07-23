import { NAV_STOP_CATEGORIES, type NavAddStop } from '@atlas/app-hooks';
import { fmtDistanceM, fmtKm } from '@atlas/core';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BottomSheet } from '../ui/BottomSheet';
import { theme } from '../ui/theme';

/**
 * The mid-drive "add a stop" quick search (web NavAddStopPanel's twin):
 * category chips over the nearest matches still ahead on the route. One tap
 * inserts the stop and guidance recalculates — nobody types at 90 km/h.
 */
export function AddStopSheet({ ctl, bottomInset }: { ctl: NavAddStop; bottomInset: number }) {
  return (
    <BottomSheet
      visible={ctl.open}
      mode="map"
      onClose={() => ctl.setOpen(false)}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="add-stop-sheet"
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.heading}>Add a stop</Text>
          <Text style={styles.muted}>Ahead on the route, nearest first</Text>
        </View>
        <Pressable onPress={() => ctl.setOpen(false)} hitSlop={10}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.categories}>
        {NAV_STOP_CATEGORIES.map((item) => (
          <Pressable
            key={item.id}
            style={[styles.category, ctl.category === item.id && styles.categorySelected]}
            onPress={() => ctl.setCategory(item.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: ctl.category === item.id }}
            testID={`add-stop-${item.id}`}
          >
            <Text style={styles.categoryText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      {ctl.status === 'loading' ? (
        <Text style={styles.empty}>Searching along the route…</Text>
      ) : ctl.status === 'error' ? (
        <Text style={styles.empty}>Search unavailable — tap a place on the map instead.</Text>
      ) : ctl.hits.length === 0 ? (
        <Text style={styles.empty}>Nothing in this category ahead on the route.</Text>
      ) : (
        <ScrollView style={styles.results}>
          {ctl.hits.map((hit, index) => (
            <Pressable
              style={styles.result}
              key={`${hit.name}/${hit.position.lat}/${hit.position.lng}`}
              onPress={() => ctl.pick(hit)}
              testID={`add-stop-result-${index}`}
            >
              <View style={styles.resultText}>
                <Text style={styles.resultName} numberOfLines={1}>
                  {hit.name}
                </Text>
                {hit.label ? (
                  <Text style={styles.resultLabel} numberOfLines={1}>
                    {hit.label}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.distance}>
                in {fmtKm(hit.aheadM)}
                {/* A place well off the line is honest about the detour. */}
                {hit.offRouteM > 250 ? ` · ${fmtDistanceM(hit.offRouteM)} off` : ''}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </BottomSheet>
  );
}

/**
 * A tapped place while navigating: the one question that matters mid-drive is
 * "stop here on the way?", so this card is that question and nothing else —
 * the full destination card stays an idle-time surface.
 */
export function NavStopTapCard({
  name,
  bottom,
  left,
  right,
  onAdd,
  onClose,
}: {
  name: string;
  bottom: number;
  left: number;
  right: number;
  onAdd: () => void;
  onClose: () => void;
}) {
  return (
    <View style={[styles.tapCard, { bottom, left, right }]}>
      <Text style={styles.tapTitle} numberOfLines={1}>
        {name}
      </Text>
      <Pressable
        style={styles.tapAdd}
        onPress={onAdd}
        testID="nav-add-stop-here"
        accessibilityRole="button"
        accessibilityLabel={`Add ${name} as a stop`}
      >
        <Text style={styles.tapAddText}>Add stop</Text>
      </Pressable>
      <Pressable
        onPress={onClose}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Text style={styles.close}>✕</Text>
      </Pressable>
    </View>
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
  empty: { color: theme.textMuted, fontSize: 13, marginTop: 18 },
  results: { marginTop: 8 },
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
  tapCard: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: theme.surfaceOverlay,
    elevation: 7,
  },
  tapTitle: { flex: 1, minWidth: 0, color: theme.text, fontSize: 14, fontWeight: '700' },
  tapAdd: {
    minHeight: 38,
    justifyContent: 'center',
    backgroundColor: theme.accent,
    borderRadius: 19,
    paddingHorizontal: 16,
  },
  tapAddText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});
