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
  onOpenLayers,
  onOpenWeather,
  onOpenExplore,
  onOpenMeasure,
  onOpenCommute,
  onOpenSettings,
  bottomInset,
}: {
  visible: boolean;
  onClose: () => void;
  onOpenFavorites: () => void;
  onOpenLayers: () => void;
  onOpenWeather: () => void;
  onOpenExplore: () => void;
  onOpenMeasure: () => void;
  onOpenCommute: () => void;
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
      // What the user is looking for, not how the surface is built: everything
      // they have saved or brought in, in one place. There used to be a second
      // entry here ("Tracks — Import and profiles") over the same records, and
      // the pair of them was a question rather than a destination.
      detail: 'Everything you have saved or imported',
      testID: 'open-favorites',
      onPress: onOpenFavorites,
    },
    {
      label: 'Layers',
      detail: 'Map overlays and sources',
      testID: 'open-layers',
      onPress: onOpenLayers,
    },
    {
      label: 'Weather',
      detail: 'Forecast for the map centre',
      testID: 'open-weather',
      onPress: onOpenWeather,
    },
    {
      label: 'Measure',
      detail: 'Distance and range rings',
      testID: 'open-measure',
      onPress: onOpenMeasure,
    },
    {
      label: 'Commute',
      detail: 'Live favorite journeys',
      testID: 'open-commute',
      onPress: onOpenCommute,
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
      peekHeight={410}
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
