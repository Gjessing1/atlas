import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { theme } from '../ui/theme';

/**
 * "Face north again" — Atlas's own compass, replacing MapLibre's native
 * ornament (`compass={false}` in MapScene).
 *
 * The native one appeared in the top-right corner, where it sat *behind* the
 * navigation banner for the whole trip, and it is drawn by the renderer from a
 * fixed bitmap, so it stayed the same light grey disc in dark mode while every
 * other Atlas control followed the theme. This is a normal round Atlas button
 * on the themed surface, in the bottom-right stack with locate and the map
 * setup row — within thumb reach, which is also where you are when you notice
 * the map is crooked.
 *
 * Only rendered while the map is genuinely rotated (see MapScene): on a
 * north-up map the button would be a control with nothing to do.
 */
export function MapCompass({
  bearing,
  bottom,
  right,
  onPress,
}: {
  /** Map bearing in degrees clockwise from north (what the camera faces). */
  bearing: number;
  bottom: number;
  right: number;
  onPress: () => void;
}) {
  return (
    <View style={[styles.wrap, { bottom, right }]}>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Map rotated ${Math.round(bearing)}°, face north`}
        testID="map-compass"
      >
        {/* The needle points where north actually is: the camera faces
            `bearing`, so north sits that many degrees anticlockwise on screen. */}
        <View style={{ transform: [{ rotate: `${-bearing}deg` }] }}>
          <Svg width={26} height={26} viewBox="0 0 26 26">
            <Circle cx={13} cy={13} r={11} fill="none" stroke={theme.icon} strokeWidth={1.2} />
            {/* North half in the accent, south half muted — the standard
                needle reading, so which end is north needs no label. */}
            <Path d="M13 3.5 17 15 13 12.6 9 15z" fill={theme.accent} />
            <Path d="M13 22.5 9 11l4 2.4 4-2.4z" fill={theme.icon} />
          </Svg>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute' },
  // Same 44 pt themed circle as locate and the map-setup triggers.
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  buttonPressed: { opacity: 0.75, transform: [{ scale: 0.94 }] },
});
