import type { NavController } from '@atlas/app-hooks';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../ui/theme';
import { pipGuidance } from './pipGuidance';
import { TurnIcon } from './TurnIcon';

/**
 * The whole navigation UI at picture-in-picture size: turn arrow, distance to
 * it, what it is, and the arrival clock. One strip along the bottom of the mini
 * window, so the map above it — still on the follow camera, still drawing the
 * route and the puck — stays the biggest thing in a window that is only about
 * 150 dp tall.
 *
 * Deliberately not interactive: at this size every control is a mis-tap, and the
 * one gesture that matters (tap to expand) belongs to the system.
 */
export function NavPipCard({ nav }: { nav: NavController }) {
  const guidance = pipGuidance(nav);
  return (
    <View style={styles.wrap} pointerEvents="none" testID="nav-pip-card">
      {guidance.instruction ? (
        <View style={styles.turn}>
          <TurnIcon instruction={guidance.instruction} size={30} color="#fff" />
        </View>
      ) : null}
      <View style={styles.text}>
        <Text style={styles.headline} numberOfLines={1}>
          {guidance.headline}
        </Text>
        {guidance.detail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {guidance.detail}
          </Text>
        ) : null}
      </View>
      {guidance.footer ? (
        <Text style={styles.footer} numberOfLines={1}>
          {guidance.footer}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: theme.surfaceOverlay,
  },
  turn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.accent,
  },
  text: { flex: 1 },
  headline: { color: theme.text, fontSize: 17, fontWeight: '800' },
  detail: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  footer: { color: theme.text, fontSize: 12, fontWeight: '700' },
});
