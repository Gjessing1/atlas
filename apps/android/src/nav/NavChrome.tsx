import type { NavFollowMode } from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import { tunnelChipLabel } from '@atlas/navigation';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { MapOverviewIcon, NavArrowIcon } from '../ui/icons';
import { useSideInsets } from '../ui/insets';
import { theme } from '../ui/theme';
import type { NavCameraControls } from './useNavCamera';
import type { NavController } from './useNavigation';

/** Where the position marker sits, and which marker the map should draw. */
export interface NavPuck {
  /** Draw the screen-fixed chevron at the follow camera's anchor point. */
  visible: boolean;
  /** Map-anchored dot for when the chevron isn't the right marker; else null. */
  dot: LatLng | null;
  /** Hide MapLibre's own puck for the whole trip. */
  suppressNative: boolean;
  top: number;
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
): NavPuck {
  const win = useWindowDimensions();
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const courseUp = followMode === 'course' && (nav.state?.departed ?? false);
  const visible = following && !navCam.followPaused && !navCam.overview && nav.state !== null;
  return {
    visible,
    dot: following && nav.state !== null && !visible ? nav.state.snapped : null,
    suppressNative: following && nav.state !== null,
    // Anchor point of the follow camera (see useNavCamera): course-up pads the
    // centre down to 75% of the screen; otherwise (north-up, or before the
    // drive has begun) it keeps the centre at the middle. Track the same
    // `courseUp` the camera frames with, so the chevron lands where the camera
    // actually centres.
    top: courseUp ? win.height * 0.75 : win.height * 0.5,
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
  landscape: boolean;
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
  landscape,
}: NavChromeProps) {
  const win = useWindowDimensions();
  // Landscape puts the system navigation bar on one side; every control that
  // hugs a vertical edge has to clear it (in portrait both insets are 0).
  const side = useSideInsets();
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';
  if (!following) return null;
  return (
    <>
      {puck.visible ? (
        <View
          pointerEvents="none"
          style={[styles.navPuckWrap, { top: puck.top - 21, left: win.width / 2 - 21 }]}
        >
          <View style={{ transform: [{ rotate: `${puck.rotation}deg` }] }}>
            {/* Grey when the GPS signal is lost, so a frozen puck reads as
                "no signal", not "we're still here". */}
            <NavArrowIcon color={nav.state?.fix === 'lost' ? theme.icon : theme.accent} />
          </View>
        </View>
      ) : null}

      {/* Top-right during navigation: map orientation + route overview. */}
      <View style={[styles.buttonColumn, { top: controlsTop, right: side.right + 12 }]}>
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
            landscape && styles.roadChipWrapLandscape,
            {
              bottom: bottomInset + 26,
              paddingLeft: (landscape ? 76 : 0) + side.left,
              paddingRight: side.right,
            },
          ]}
          pointerEvents="none"
        >
          <View style={[styles.roadChip, landscape && styles.roadChipLandscape]}>
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
            { bottom: bottomInset + 88, left: side.left, right: side.right },
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
  // `right` (12 dp plus the safe-area inset) and `top` are applied inline.
  buttonColumn: { position: 'absolute', gap: 10, alignItems: 'center' },
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
  roadChipWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  // Landscape: hug the left edge so the centred nav chevron stays uncovered
  // (the 76 dp indent is applied inline, on top of the left safe-area inset).
  roadChipWrapLandscape: { alignItems: 'flex-start' },
  // …and keep a long road name from growing back into the chevron's column;
  // the name ellipsises instead (numberOfLines is already 1).
  roadChipLandscape: { maxWidth: '40%' },
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
