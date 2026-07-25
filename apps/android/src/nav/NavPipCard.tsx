import type { NavController } from '@atlas/app-hooks';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { theme } from '../ui/theme';
import { pipCardMetrics, pipGuidance } from './pipGuidance';
import { TurnIcon } from './TurnIcon';

/**
 * Navigation at picture-in-picture size: the live map, with a guidance strip
 * along the bottom carrying the turn arrow, how far to it, what it is, and the
 * arrival clock.
 *
 * The map is back in here, and it is the point. It briefly wasn't: the window
 * showed a large maneuver card over an opaque background, on the argument that
 * a glance at a floating window is a glance for one fact. In a car that turned
 * out to be exactly wrong — above 10 km the distance reads in whole kilometres
 * and the clock in whole minutes, so on a motorway the entire window can sit
 * unchanged for the better part of a minute and reads as frozen guidance. A map
 * moving under the puck is unmistakably live, and it answers the question the
 * card could not: not "which way", but "where am I".
 *
 * The strip still scales: the window is resizable, so type and arrow grow with
 * it, and the strip's own height is what the follow camera is told to keep
 * clear (App's `navViewport`), so the puck never sits behind it.
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
      style={[
        styles.strip,
        { minHeight: size.height, paddingHorizontal: size.padding, gap: size.gap },
      ]}
      pointerEvents="none"
      testID="nav-pip-card"
    >
      {guidance.instruction ? (
        <TurnIcon instruction={guidance.instruction} size={size.icon} color={theme.accent} />
      ) : null}
      <Text style={[styles.headline, { fontSize: size.headline }]} numberOfLines={1}>
        {guidance.headline}
      </Text>
      {guidance.detail ? (
        <Text style={[styles.detail, { fontSize: size.detail }]} numberOfLines={1}>
          {guidance.detail}
        </Text>
      ) : null}
      {guidance.footer && size.showFooter ? (
        <Text style={[styles.footer, { fontSize: size.footer }]} numberOfLines={1}>
          {guidance.footer}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Opaque rather than translucent: this sits over moving map, and guidance
  // that has to be read at a glance may not depend on what is under it.
  strip: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
  },
  headline: { color: theme.text, fontWeight: '800' },
  // The maneuver takes whatever room the fixed-width distance and clock leave.
  detail: { color: theme.textMuted, fontWeight: '600', flex: 1 },
  footer: { color: theme.text, fontWeight: '700' },
});
