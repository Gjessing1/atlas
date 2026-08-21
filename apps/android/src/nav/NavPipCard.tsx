import type { NavController } from '@atlas/app-hooks';
import { StyleSheet, Text, View } from 'react-native';

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
 * clear (App's `navViewport`), so the puck never sits behind it. It also
 * reshapes: the window Atlas asks for is portrait (3:4, for map rather than
 * letterbox), and one row of arrow · distance · clock does not fit across
 * ~110 dp. In that window the clock takes a line of its own under the turn
 * instead of being the thing that falls off the right-hand edge.
 *
 * Deliberately not interactive: at this size every control is a mis-tap, and the
 * one gesture that matters (tap to expand) belongs to the system.
 */
export function NavPipCard({
  nav,
  width,
  height,
  fontScale,
}: {
  nav: NavController;
  width: number;
  height: number;
  fontScale: number;
}) {
  const guidance = pipGuidance(nav);
  const size = pipCardMetrics(width, height, fontScale);
  const turn = (
    <>
      {guidance.instruction ? (
        <TurnIcon instruction={guidance.instruction} size={size.icon} color={theme.accent} />
      ) : null}
      <Text
        style={[styles.headline, { fontSize: size.headline }]}
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
      >
        {guidance.headline}
      </Text>
      {guidance.detail && size.showDetail ? (
        <Text
          style={[styles.detail, { fontSize: size.detail }]}
          numberOfLines={1}
          maxFontSizeMultiplier={1.3}
        >
          {guidance.detail}
        </Text>
      ) : null}
    </>
  );
  const clock = guidance.footer ? (
    <Text
      style={[
        styles.footer,
        size.stack ? styles.centred : null,
        size.stack ? styles.stackedFooter : null,
        size.stack
          ? {
              right: size.padding,
              bottom: Math.max(2, Math.round(size.gap / 3)),
              left: size.padding,
            }
          : null,
        { fontSize: size.footer },
      ]}
      numberOfLines={1}
      maxFontSizeMultiplier={1.3}
    >
      {guidance.footer}
    </Text>
  ) : null;
  return (
    <View
      style={[
        styles.strip,
        size.stack ? styles.stacked : styles.row,
        {
          height: size.height,
          paddingHorizontal: size.padding,
          paddingBottom: size.stack && clock ? size.footer + Math.round(size.gap / 2) : 0,
          gap: size.gap,
        },
      ]}
      pointerEvents="none"
      testID="nav-pip-card"
    >
      {size.stack ? (
        <>
          <View style={[styles.row, styles.turnRow, { gap: size.gap }]}>{turn}</View>
          {clock}
        </>
      ) : (
        <>
          {turn}
          {clock}
        </>
      )}
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
    backgroundColor: theme.surface,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  // Two lines: the turn reads first, the clock sits under it, both centred so
  // the strip stays legible however narrow the system made the window.
  stacked: { flexDirection: 'column' },
  turnRow: { alignSelf: 'stretch', justifyContent: 'center', flex: 1 },
  // Android can deliver the PiP resize before React has reconciled both rows.
  // Pin the retained ETA inside the known strip height so it cannot become the
  // child that falls below the clipped task surface during that first layout.
  stackedFooter: { position: 'absolute' },
  centred: { textAlign: 'center' },
  headline: { color: theme.text, fontWeight: '800' },
  // The maneuver takes whatever room the fixed-width distance and clock leave.
  detail: { color: theme.textMuted, fontWeight: '600', flex: 1 },
  footer: { color: theme.text, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
