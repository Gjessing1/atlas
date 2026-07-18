import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MenuIcon, SearchIcon } from './icons';

interface MenuClusterProps {
  bottomInset: number;
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** Hides search + route planning (they make no sense mid-trip). */
  following: boolean;
  onOpenFavorites: () => void;
  onOpenTracks: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onPlanRoute: () => void;
}

/**
 * Bottom-left cluster: hamburger menu (places, tracks, settings live in sheets
 * it opens) + search + route planning. The app hides the whole cluster while
 * planning — the RoutePanel owns the bottom of the screen then.
 */
export function MenuCluster({
  bottomInset,
  menuOpen,
  onToggleMenu,
  following,
  onOpenFavorites,
  onOpenTracks,
  onOpenSettings,
  onOpenSearch,
  onPlanRoute,
}: MenuClusterProps) {
  return (
    <View style={[styles.menuWrap, { bottom: bottomInset + 24 }]} pointerEvents="box-none">
      {menuOpen ? (
        <View style={styles.menuCard}>
          {(
            [
              ['Saved', 'open-favorites', onOpenFavorites],
              ['Tracks', 'open-tracks', onOpenTracks],
              ['Settings', 'open-settings', onOpenSettings],
            ] as const
          ).map(([label, testID, openSheet]) => (
            <Pressable
              key={testID}
              style={styles.menuItem}
              testID={testID}
              onPress={() => {
                onToggleMenu();
                openSheet();
              }}
            >
              <Text style={styles.menuItemText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.bottomRow}>
        <Pressable style={styles.roundButton} onPress={onToggleMenu} testID="open-menu">
          <MenuIcon />
        </Pressable>
        {!following ? (
          <Pressable style={styles.roundButton} onPress={onOpenSearch} testID="search-open">
            <SearchIcon />
          </Pressable>
        ) : null}
        {!following ? (
          <Pressable style={styles.roundButton} onPress={onPlanRoute} testID="plan-route">
            {/* Up-then-right arrow — the conventional "directions" glyph (OSM). */}
            <Text style={styles.routeArrow}>{'↱'}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  menuWrap: { position: 'absolute', left: 12, alignItems: 'flex-start', gap: 8 },
  bottomRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
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
});
