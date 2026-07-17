import { followZoom } from '@atlas/navigation';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useWindowDimensions } from 'react-native';

import type { NavController } from './useNavigation';

/** A manual pan pauses the follow; it resumes by itself after this long. */
const AUTO_RESUME_MS = 12_000;

export interface NavCameraControls {
  /** True after a manual gesture — the camera holds still so the user can look around. */
  followPaused: boolean;
  /** Re-engage the follow now (the re-centre pill / locate button). */
  resumeFollow: () => void;
  /** MapScene reports user pan/zoom/rotate gestures here while navigating. */
  onUserGesture: () => void;
}

/**
 * The turn-by-turn follow camera, driven from JS on every navigation state
 * update (the native `trackUserLocation` modes can only centre the puck).
 * Standard driving-nav framing: the car sits in the lower quarter of the
 * screen (camera padding pushes the centre down) so the top three quarters
 * show the road ahead; course-up bearing comes from the route tangent, which
 * doesn't wobble the way raw GPS course does; the zoom tracks speed and leans
 * in for approaching turns; a pitched view stretches the visible distance.
 * Panning by hand pauses all of it, with an auto-resume so a glance around
 * never permanently breaks the follow.
 */
export function useNavCamera(
  cameraRef: RefObject<CameraRef | null>,
  nav: NavController,
  navFollow: 'course' | 'north',
): NavCameraControls {
  const win = useWindowDimensions();
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';

  const [followPaused, setFollowPaused] = useState(false);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Course held over fixes where the tangent is unavailable (degenerate route).
  const bearingRef = useRef(0);
  // Last framed position, so the end-of-trip reset can restore padding (the
  // native camera only applies padding on centre-carrying moves).
  const lastCenterRef = useRef<[number, number] | null>(null);

  const clearResumeTimer = useCallback(() => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = null;
  }, []);

  const resumeFollow = useCallback(() => {
    clearResumeTimer();
    setFollowPaused(false);
  }, [clearResumeTimer]);

  const onUserGesture = useCallback(() => {
    if (!following) return;
    setFollowPaused(true);
    clearResumeTimer();
    resumeTimer.current = setTimeout(() => setFollowPaused(false), AUTO_RESUME_MS);
  }, [following, clearResumeTimer]);

  // Pause state and timer reset with each trip.
  useEffect(() => {
    if (!following) {
      clearResumeTimer();
      setFollowPaused(false);
    }
  }, [following, clearResumeTimer]);
  useEffect(() => clearResumeTimer, [clearResumeTimer]);

  const state = nav.state;
  useEffect(() => {
    if (!following || followPaused || !state) return;
    const snapped = state.snapped;
    if (state.courseDeg !== null) bearingRef.current = state.courseDeg;
    const courseUp = navFollow === 'course';
    // Bottom-anchor (course-up only — in north-up "ahead" isn't up, so centre):
    // top padding of half the screen puts the car ~75% of the way down.
    const anchorTop = courseUp ? Math.round(win.height * 0.5) : 0;
    const forwardDp = Math.round(win.height * (courseUp ? 0.6 : 0.4));
    lastCenterRef.current = [snapped.lng, snapped.lat];
    cameraRef.current?.easeTo({
      center: [snapped.lng, snapped.lat],
      zoom: followZoom(nav.speedMps, snapped.lat, state.upcoming?.distanceToM ?? null, forwardDp),
      bearing: courseUp ? bearingRef.current : 0,
      pitch: courseUp ? 45 : 0,
      padding: { top: anchorTop },
      // Linear easing over roughly the fix interval keeps back-to-back
      // updates from stuttering (web-nav parity).
      duration: 800,
      easing: 'linear',
    });
  }, [cameraRef, following, followPaused, state, navFollow, nav.speedMps, win.height]);

  // Trip over: put the camera back the way the rest of the app expects it —
  // north-up, flat, un-padded (padding needs a centre-carrying move to reset).
  const wasFollowing = useRef(false);
  useEffect(() => {
    if (wasFollowing.current && !following && lastCenterRef.current) {
      cameraRef.current?.easeTo({
        center: lastCenterRef.current,
        bearing: 0,
        pitch: 0,
        padding: { top: 0 },
        duration: 600,
      });
      lastCenterRef.current = null;
    }
    wasFollowing.current = following;
  }, [cameraRef, following]);

  return { followPaused, resumeFollow, onUserGesture };
}
