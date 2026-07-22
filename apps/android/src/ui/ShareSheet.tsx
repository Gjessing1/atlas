import { encodeMapHash, type LatLng } from '@atlas/core';
import { Linking, Modal, Pressable, Share, StyleSheet, Text } from 'react-native';

import { getServerOrigin } from '../serverOrigin';
import { theme } from './theme';

export interface ShareTarget extends LatLng {
  name: string;
}

/** Coordinates the way people paste them: "59.80563, 10.36701". */
function coordText(t: LatLng): string {
  return `${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}`;
}

/**
 * A small chooser for *how* to share a point, because one format never suits
 * everyone: an Atlas link opens the map here, plain coordinates paste anywhere,
 * and a `geo:` link hands the point to whatever map app the user actually
 * prefers. Presented as a compact bottom sheet over the destination card.
 */
export function ShareSheet({
  target,
  zoom,
  onClose,
  bottomInset = 0,
}: {
  /** The point to share, or null when the sheet is closed. */
  target: ShareTarget | null;
  /** Current map zoom, so the shared Atlas link opens at a sensible scale. */
  zoom: number;
  onClose: () => void;
  bottomInset?: number;
}) {
  if (!target) return null;
  const pin = { lat: target.lat, lng: target.lng };

  const shareLink = () => {
    const hash = encodeMapHash({ center: pin, zoom, pin });
    void Share.share({ message: `${target.name} — ${getServerOrigin()}/${hash}` });
    onClose();
  };
  const shareCoords = () => {
    void Share.share({ message: coordText(target) });
    onClose();
  };
  const openInMaps = () => {
    // geo: lets Android offer every installed map app; q= drops a labelled pin
    // in the ones that honour it, and the raw coordinate is the fallback.
    const label = encodeURIComponent(target.name);
    void Linking.openURL(`geo:${target.lat},${target.lng}?q=${target.lat},${target.lng}(${label})`);
    onClose();
  };

  const options: { key: string; title: string; subtitle: string; onPress: () => void }[] = [
    {
      key: 'link',
      title: 'Atlas link',
      subtitle: 'Opens the map here, in any browser',
      onPress: shareLink,
    },
    {
      key: 'coords',
      title: 'Coordinates',
      subtitle: coordText(target),
      onPress: shareCoords,
    },
    {
      key: 'geo',
      title: 'Open in a map app',
      subtitle: 'Google Maps, Organic Maps, OsmAnd…',
      onPress: openInMaps,
    },
  ];

  return (
    <Modal
      visible
      animationType="fade"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} testID="share-backdrop">
        {/* Stop taps on the card itself from dismissing the sheet. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: bottomInset + 16 }]}
          onPress={() => {}}
          testID="share-sheet"
        >
          <Text style={styles.heading} numberOfLines={1}>
            Share {target.name}
          </Text>
          {options.map((option) => (
            <Pressable
              key={option.key}
              style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
              onPress={option.onPress}
              testID={`share-${option.key}`}
            >
              <Text style={styles.optionTitle}>{option.title}</Text>
              <Text style={styles.optionSubtitle} numberOfLines={1}>
                {option.subtitle}
              </Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.backdrop, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 18,
    gap: 8,
    elevation: 16,
  },
  heading: { fontSize: 15, fontWeight: '700', color: theme.text, marginBottom: 4 },
  option: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: theme.surfaceMuted,
  },
  optionPressed: { backgroundColor: theme.surfaceActive },
  optionTitle: { fontSize: 15, fontWeight: '700', color: theme.text },
  optionSubtitle: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
});
