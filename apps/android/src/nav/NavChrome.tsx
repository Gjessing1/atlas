import type { NavController, NavFollowMode } from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import { tunnelChipLabel } from '@atlas/navigation';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MapOverviewIcon, NavArrowIcon } from '../ui/icons';
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
  const courseUp = followMode === 'course' && (nav.state?.departed ?? false);
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
  followMode: NavFollowMode;
  onToggleFollowMode: () => void;
  /** Top of the button column — below the status bar and the nav banner. */
  controlsTop: number;
  bottomInset: number;
  viewport: NavViewport;
}

/**
 * The map chrome that belongs to an active trip: the position chevron, the
 * orientation and overview buttons, the current-road chip and the re-centre
 * pill. All of it appears only while guidance is running — the idle map has
 * its own controls, and the route-choice preview has none of these.
 */
export function NavChrome({
  nav,
  navCam,
  puck,
  followMode,
  onToggleFollowMode,
  controlsTop,
  bottomInset,
  viewport,
}: NavChromeProps) {
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';
  if (!following) return null;
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

      {/* Portrait: below the banner on the right. Landscape: a horizontal pair
          in the leading guidance rail, between its header and bottom actions. */}
      <View
        style={[
          styles.buttonColumn,
          viewport.landscape && styles.buttonRow,
          viewport.landscape
            ? { top: controlsTop, left: viewport.guidanceLeft }
            : { top: controlsTop, right: 12 },
        ]}
      >
        <Pressable
          style={styles.roundButton}
          onPress={onToggleFollowMode}
          testID="toggle-orientation"
          accessibilityRole="button"
          accessibilityLabel={
            followMode === 'course' ? 'Switch to north-up' : 'Switch to course-up'
          }
        >
          {/* Course-up = blue arrow pointing forward (up on screen); north-up = N. */}
          {followMode === 'north' ? <Text style={styles.orientText}>N</Text> : <NavArrowIcon />}
        </Pressable>
        {/* Whole-remaining-route overview; tap again (or wait) to re-follow. */}
        <Pressable
          style={[styles.roundButton, navCam.overview && styles.roundButtonActive]}
          onPress={navCam.toggleOverview}
          testID="toggle-overview"
          accessibilityRole="button"
          accessibilityLabel={navCam.overview ? 'Back to follow view' : 'Show route overview'}
          accessibilityState={{ selected: navCam.overview }}
        >
          <MapOverviewIcon />
        </Pressable>
      </View>

      {/* Name of the road being driven, pinned bottom-centre (Google-style).
          Inside a mapped tunnel it names the tunnel and counts it down
          instead — the road underneath is still E6, but "Brynstunnelen ·
          1.2 km" is what the driver can check against the world outside. */}
      {nav.state?.tunnel || nav.state?.currentRoad ? (
        <View
          style={[
            styles.roadChipWrap,
            {
              bottom: bottomInset + (viewport.landscape ? 18 : 74),
              left: viewport.landscape ? viewport.mapLeft : 0,
              right: viewport.landscape ? undefined : 0,
              width: viewport.landscape ? viewport.mapRight - viewport.mapLeft : undefined,
            },
          ]}
          pointerEvents="none"
        >
          <View style={[styles.roadChip, viewport.landscape && styles.roadChipLandscape]}>
            <Text style={styles.roadChipText} numberOfLines={1}>
              {nav.state.tunnel ? tunnelChipLabel(nav.state.tunnel) : nav.state.currentRoad}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Free look-around during navigation: a pan pauses the follow camera;
          this pill (or the locate button, or a 12 s timeout) re-engages it. */}
      {navCam.followPaused ? (
        <View
          style={[
            styles.recentreWrap,
            {
              bottom: bottomInset + (viewport.landscape ? 64 : 122),
              left: viewport.landscape ? viewport.mapLeft : 0,
              right: viewport.landscape ? undefined : 0,
              width: viewport.landscape ? viewport.mapRight - viewport.mapLeft : undefined,
            },
          ]}
          pointerEvents="box-none"
        >
          <Pressable style={styles.recentrePill} onPress={navCam.resumeFollow} testID="recentre">
            <NavArrowIcon />
            <Text style={styles.recentreText}>Re-centre</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  // Edge and top positions come from the shared navigation viewport.
  buttonColumn: { position: 'absolute', gap: 10, alignItems: 'center' },
  buttonRow: { flexDirection: 'row' },
  recentreWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
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
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  orientText: { fontSize: 18, fontWeight: '800', color: theme.accent },
  roundButtonActive: { backgroundColor: theme.surfaceActive },
  roadChipWrap: { position: 'absolute', alignItems: 'center' },
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
