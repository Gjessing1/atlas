import type { BBox, LatLng } from '@atlas/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSideInsets } from './insets';
import { theme } from './theme';

/**
 * Lightweight map chrome for two-tap offline-region selection. The rectangle
 * itself is rendered by MapScene so it remains anchored while the map moves.
 */
export function OfflineRegionDrawControls({
  corner,
  bbox,
  topInset,
  bottomInset,
  onReset,
  onCancel,
  onBuild,
}: {
  corner: LatLng | null;
  bbox: BBox | null;
  topInset: number;
  bottomInset: number;
  onReset: () => void;
  onCancel: () => void;
  onBuild: () => void;
}) {
  const side = useSideInsets();
  const instruction = bbox
    ? 'Region selected. Pan or zoom to inspect it, or reset the corners.'
    : corner
      ? 'Tap the opposite corner of the region.'
      : 'Tap the first corner of the offline region.';

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          top: topInset + 12,
          bottom: bottomInset + 12,
          left: side.left + 12,
          right: side.right + 12,
        },
      ]}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Custom offline region</Text>
        <Text style={styles.instruction}>{instruction}</Text>
      </View>
      <View style={styles.buttons}>
        {corner ? (
          <Pressable style={[styles.button, styles.buttonQuiet]} onPress={onReset}>
            <Text style={styles.buttonQuietText}>Reset</Text>
          </Pressable>
        ) : null}
        <Pressable style={[styles.button, styles.buttonQuiet]} onPress={onCancel}>
          <Text style={styles.buttonQuietText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.button, !bbox && styles.buttonDisabled]}
          disabled={!bbox}
          onPress={onBuild}
          testID="offline-region-build"
        >
          <Text style={styles.buttonText}>Build region</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  card: {
    maxWidth: 420,
    backgroundColor: theme.surfaceOverlay,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 5,
  },
  title: { color: theme.text, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  instruction: { color: theme.textMuted, fontSize: 13, marginTop: 4, textAlign: 'center' },
  buttons: {
    flexDirection: 'row',
    gap: 8,
    padding: 8,
    borderRadius: 12,
    backgroundColor: theme.surfaceOverlay,
    elevation: 5,
  },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  buttonDisabled: { opacity: 0.42 },
  buttonText: { color: theme.onAccent, fontWeight: '700' },
  buttonQuiet: { backgroundColor: theme.surfaceMuted },
  buttonQuietText: { color: theme.text, fontWeight: '700' },
});
