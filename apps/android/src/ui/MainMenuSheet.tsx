import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

interface MenuItem {
  label: string;
  detail: string;
  testID: string;
  onPress: () => void;
}

/** The hamburger's destinations, presented in the same bottom-sheet language. */
export function MainMenuSheet({
  visible,
  onClose,
  onOpenFavorites,
  onOpenTracks,
  onOpenLayers,
  onOpenExplore,
  onOpenMeasure,
  onOpenSettings,
  bottomInset,
}: {
  visible: boolean;
  onClose: () => void;
  onOpenFavorites: () => void;
  onOpenTracks: () => void;
  onOpenLayers: () => void;
  onOpenExplore: () => void;
  onOpenMeasure: () => void;
  onOpenSettings: () => void;
  bottomInset: number;
}) {
  const items: MenuItem[] = [
    {
      label: 'Explore',
      detail: 'Nearby places by category',
      testID: 'open-explore',
      onPress: onOpenExplore,
    },
    {
      label: 'Collections',
      detail: 'Saved places, tracks and folders',
      testID: 'open-favorites',
      onPress: onOpenFavorites,
    },
    {
      label: 'Tracks',
      detail: 'Import and profiles',
      testID: 'open-tracks',
      onPress: onOpenTracks,
    },
    {
      label: 'Layers',
      detail: 'Map overlays and sources',
      testID: 'open-layers',
      onPress: onOpenLayers,
    },
    {
      label: 'Measure',
      detail: 'Distance and range rings',
      testID: 'open-measure',
      onPress: onOpenMeasure,
    },
    {
      label: 'Settings',
      detail: 'Account, regions and app',
      testID: 'open-settings',
      onPress: onOpenSettings,
    },
  ];

  return (
    <BottomSheet
      visible={visible}
      mode="map"
      onClose={onClose}
      initialSnap="peek"
      peekHeight={330}
      bottomInset={bottomInset}
      testID="main-menu-sheet"
    >
      <View style={styles.header}>
        <Text style={styles.heading}>Atlas</Text>
        <Pressable onPress={onClose} hitSlop={10} testID="menu-close">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.grid}>
        {items.map((item) => (
          <Pressable
            key={item.testID}
            style={styles.item}
            testID={item.testID}
            onPress={() => {
              onClose();
              item.onPress();
            }}
          >
            <Text style={styles.label}>{item.label}</Text>
            <Text style={styles.detail}>{item.detail}</Text>
          </Pressable>
        ))}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  heading: { fontSize: 17, fontWeight: '700', color: theme.text },
  close: { fontSize: 18, color: theme.textMuted, paddingHorizontal: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  item: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 64,
    borderRadius: 14,
    backgroundColor: theme.surfaceActive,
    paddingHorizontal: 14,
    paddingVertical: 11,
    justifyContent: 'center',
  },
  label: { fontSize: 15, fontWeight: '700', color: theme.text },
  detail: { marginTop: 2, fontSize: 12, color: theme.textMuted },
});
