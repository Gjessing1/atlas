import type { NavController, NavFollowMode } from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import { tunnelChipLabel } from '@atlas/navigation';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { NavArrowIcon } from '../ui/icons';
import { theme } from '../ui/theme';
import type { NavViewport } from './navViewport';
import type { NavCameraControls } from './useNavCamera';

/** Where the position marker sits, and which marker the map should draw. */
export interface NavPuck {
  /** Draw the screen-fixed chevron at the follow camera's anchor point. */
  visible: boolean;
  /** Map-anchored dot for when the chevron isn't the right marker; else null. */
  dot: LatLng | null;
  /** Hide MapLibre's own puck for the whole trip. */
  suppressNative: boolean;
  x: number;
  y: number;
  rotation: number;
}

/**
 * While the follow camera is actively tracking, the puck is drawn as a
 * screen-fixed chevron at the camera's anchor point — the camera eases to the
 * road-snapped fix, so the chevron sits glued to the route line with none of
 * the native puck's raw-GPS wobble.
 *
 * The chevron shows on exactly the condition useNavCamera eases the camera to
 * `state.snapped` (following, not paused, not in overview, a fix in hand) — no
 * tighter. Gating it additionally on `departed`, a 25 m snap band, or off-route
 * meant the camera kept tracking the live position while the chevron vanished,
 * so the native puck's fuzzy accuracy blob showed for the whole drive instead —
 * even on a perfect fix a lane's width off the route centreline. The chevron
 * sits at the camera's centre, so wherever the camera points (glued to the line
 * or the raw fix, on-route or off) it is the honest marker; it simply greys
 * when the fix is genuinely lost.
 *
 * Once a trip has a position the native puck is never the right marker: the
 * fuzzy accuracy blob ("the cloud") looks like a bug next to our own puck, and
 * any flip between the two — a stray gesture, an overview toggle, a device
 * rotation that resizes the map — reads as the marker vanishing mid-drive. So
 * it is suppressed for the whole trip and one of ours is always drawn: the
 * chevron while the follow camera frames the position, a map-anchored dot
 * whenever it doesn't.
 */
export function useNavPuck(
  nav: NavController,
  navCam: NavCameraControls,
  followMode: NavFollowMode,
  viewport: NavViewport,
): NavPuck {
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const courseUp = followMode === 'course';
  const visible = following && !navCam.followPaused && !navCam.overview && nav.state !== null;
  const anchor = courseUp ? viewport.courseAnchor : viewport.flatAnchor;
  return {
    visible,
    dot: following && nav.state !== null && !visible ? nav.state.snapped : null,
    suppressNative: following && nav.state !== null,
    // Anchor point of the follow camera (see useNavCamera): course-up puts it
    // low for look-ahead; north-up centres it vertically. Landscape centres
    // both in the unobstructed right map pane. Track the exact same geometry so
    // the chevron lands where the camera actually centres.
    x: anchor.x,
    y: anchor.y,
    // Course-up rotates the map to the course, so the chevron points straight
    // up; otherwise the map is north-up (bearing 0), so the chevron shows it.
    rotation: courseUp ? 0 : Math.round(nav.state?.courseDeg ?? 0),
  };
}

export interface NavChromeProps {
  nav: NavController;
  navCam: NavCameraControls;
  puck: NavPuck;
  bottomInset: number;
  viewport: NavViewport;
}

/**
 * The map chrome that belongs to an active trip: the position chevron, the
 * current-road chip and the re-centre pill. The orientation and overview
 * controls live in NavBanner so every control in the guidance rail shares one
 * collision-free layout. All of this appears only while guidance is running.
 */
export function NavChrome({ nav, navCam, puck, bottomInset, viewport }: NavChromeProps) {
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';
  if (!following) return null;
  const roadLabel = nav.state?.tunnel ? tunnelChipLabel(nav.state.tunnel) : nav.state?.currentRoad;
  return (
    <>
      {puck.visible ? (
        <View
          pointerEvents="none"
          style={[styles.navPuckWrap, { top: puck.y - 21, left: puck.x - 21 }]}
        >
          <View style={{ transform: [{ rotate: `${puck.rotation}deg` }] }}>
            {/* Grey when the GPS signal is lost, so a frozen puck reads as
                "no signal", not "we're still here". */}
            <NavArrowIcon color={nav.state?.fix === 'lost' ? theme.icon : theme.accent} />
          </View>
        </View>
      ) : null}

      {/* The re-centre pill and road name are one ordered bottom stack. They
          can no longer land on the same coordinates when both are visible.
          In landscape the stack belongs only to the open map pane. */}
      {navCam.followPaused || roadLabel ? (
        <View
          style={[
            styles.mapBottomStack,
            {
              bottom: bottomInset + (viewport.landscape ? 16 : 70),
              left: viewport.landscape ? viewport.mapLeft : 0,
              width: viewport.landscape ? viewport.mapRight - viewport.mapLeft : undefined,
              right: viewport.landscape ? undefined : 0,
            },
          ]}
          pointerEvents="box-none"
        >
          {/* Free look-around during navigation: a pan pauses follow; this
              pill (or the 12 s timeout) re-engages it. */}
          {navCam.followPaused ? (
            <Pressable style={styles.recentrePill} onPress={navCam.resumeFollow} testID="recentre">
              <NavArrowIcon />
              <Text style={styles.recentreText}>Re-centre</Text>
            </Pressable>
          ) : null}
          {roadLabel ? (
            <View
              style={[styles.roadChip, viewport.landscape && styles.roadChipLandscape]}
              pointerEvents="none"
            >
              <Text style={styles.roadChipText} numberOfLines={1}>
                {roadLabel}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  navPuckWrap: {
    position: 'absolute',
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
  recentrePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.surface,
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 10,
    elevation: 5,
  },
  recentreText: { color: theme.text, fontWeight: '700', fontSize: 15 },
  mapBottomStack: {
    position: 'absolute',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  roadChipLandscape: { maxWidth: '74%' },
  roadChip: {
    backgroundColor: theme.surfaceOverlay,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 6,
    maxWidth: '70%',
    elevation: 4,
  },
  roadChipText: { color: theme.text, fontWeight: '700', fontSize: 14 },
});
