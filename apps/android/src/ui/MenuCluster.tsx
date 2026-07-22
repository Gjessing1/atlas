import { Pressable, StyleSheet, View } from 'react-native';

import { MenuIcon, SearchIcon } from './icons';
import { useSideInsets } from './insets';
import { DirectionsIcon } from './modeIcons';
import { theme } from './theme';

interface MenuClusterProps {
  bottomInset: number;
  onToggleMenu: () => void;
  /** Hides search + route planning (they make no sense mid-trip). */
  following: boolean;
  onOpenSearch: () => void;
  onPlanRoute: () => void;
}

/**
 * Bottom-left primary actions: menu, search and route planning. The menu's
 * destinations live in MainMenuSheet; this component is only the map launcher.
 */
export function MenuCluster({
  bottomInset,
  onToggleMenu,
  following,
  onOpenSearch,
  onPlanRoute,
}: MenuClusterProps) {
  // Landscape moves the system navigation bar to a side: start inside it.
  const side = useSideInsets();
  return (
    <View
      style={[styles.menuWrap, { bottom: bottomInset + 24, left: side.left + 12 }]}
      pointerEvents="box-none"
    >
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
            <DirectionsIcon color={theme.accent} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  menuWrap: { position: 'absolute' },
  bottomRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
});
