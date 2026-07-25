import type { NavController } from '@atlas/app-hooks';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { theme } from '../ui/theme';
import { pipCardMetrics, pipGuidance } from './pipGuidance';
import { TurnIcon } from './TurnIcon';

/**
 * Navigation at picture-in-picture size: the turn arrow, how far to it, what it
 * is, and the arrival clock — filling the window, on its own background.
 *
 * The map is deliberately *not* in here. It used to be: the window showed the
 * live map with a thin guidance strip along the bottom, and at 150 dp tall that
 * meant a postage stamp of road, framed on wherever the camera happened to be
 * rather than on anything the driver needed. Every navigator that does this well
 * shows the maneuver instead, because a glance at a floating window is a glance
 * for one fact: which way, and how far. The map is one tap away, full size,
 * where it is worth looking at.
 *
 * It also scales: the window is resizable, so the arrow and the distance grow
 * with it instead of leaving a large window mostly empty.
 *
 * Deliberately not interactive: at this size every control is a mis-tap, and the
 * one gesture that matters (tap to expand) belongs to the system.
 */
export function NavPipCard({ nav }: { nav: NavController }) {
  const guidance = pipGuidance(nav);
  const win = useWindowDimensions();
  const size = pipCardMetrics(win.width, win.height);
  return (
    <View
      style={[styles.wrap, { padding: size.padding, gap: size.gap }]}
      pointerEvents="none"
      testID="nav-pip-card"
    >
      <View style={styles.row}>
        {guidance.instruction ? (
          <View
            style={[
              styles.turn,
              { width: size.icon, height: size.icon, borderRadius: Math.round(size.icon / 4) },
            ]}
          >
            <TurnIcon
              instruction={guidance.instruction}
              size={Math.round(size.icon * 0.78)}
              color="#fff"
            />
          </View>
        ) : null}
        <View style={styles.text}>
          <Text style={[styles.headline, { fontSize: size.headline }]} numberOfLines={1}>
            {guidance.headline}
          </Text>
          {guidance.detail ? (
            <Text style={[styles.detail, { fontSize: size.detail }]} numberOfLines={2}>
              {guidance.detail}
            </Text>
          ) : null}
        </View>
      </View>
      {guidance.footer && size.showFooter ? (
        <Text style={[styles.footer, { fontSize: size.footer }]} numberOfLines={1}>
          {guidance.footer}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Opaque and edge to edge: the window is the card, not an overlay on a map
  // the driver cannot read anyway.
  wrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.surface,
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  turn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.accent,
  },
  text: { flex: 1 },
  headline: { color: theme.text, fontWeight: '800' },
  detail: { color: theme.textMuted, fontWeight: '600' },
  footer: { color: theme.text, fontWeight: '700' },
});
