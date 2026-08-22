import { Pressable, StyleSheet, View } from 'react-native';

import { MenuIcon, NavArrowIcon, SearchIcon } from './icons';
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
  /** Follow the live position with no destination (nav's `exploring` phase). */
  onExplore: () => void;
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
  onExplore,
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
        {/* Follow the live position with no destination. It spent a full row
          inside the route planner until v0.173.0, under the mode icons, where
          it read as a routing option and pushed the stops down a sheet with no
          room to spare — but it plans nothing. Beside "plan a route" it is what
          it actually is: the other way to start moving. Hidden mid-trip with
          its neighbours, since it is already running. */}
        {!following ? (
          <Pressable
            style={styles.roundButton}
            onPress={onExplore}
            accessibilityRole="button"
            accessibilityLabel="Follow my position without a destination"
            testID="follow-position"
          >
            <NavArrowIcon />
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
