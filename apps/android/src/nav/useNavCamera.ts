import type { NavController } from '@atlas/app-hooks';
import { followZoom, remainingRouteBounds } from '@atlas/navigation';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useWindowDimensions } from 'react-native';

import type { NavViewport } from './navViewport';

/** A manual pan pauses the follow; it resumes by itself after this long. */
const AUTO_RESUME_MS = 12_000;
/** The overview camera returns to the follow by itself after this long. */
const OVERVIEW_RESUME_MS = 20_000;

export interface NavCameraControls {
  /** True after a manual gesture — the camera holds still so the user can look around. */
  followPaused: boolean;
  /** Re-engage the follow now (the re-centre pill / locate button). */
  resumeFollow: () => void;
  /** MapScene reports user pan/zoom/rotate gestures here while navigating. */
  onUserGesture: () => void;
  /** Whole-remaining-route overview instead of the follow camera. */
  overview: boolean;
  toggleOverview: () => void;
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
  viewport: NavViewport,
  guidanceHeight: number,
): NavCameraControls {
  const win = useWindowDimensions();
  const following = nav.phase === 'navigating' || nav.phase === 'rerouting';

  const [followPaused, setFollowPaused] = useState(false);
  const [overview, setOverview] = useState(false);
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
    setOverview(false);
  }, [clearResumeTimer]);

  const onUserGesture = useCallback(() => {
    if (!following) return;
    setFollowPaused(true);
    setOverview(false);
    clearResumeTimer();
    resumeTimer.current = setTimeout(() => setFollowPaused(false), AUTO_RESUME_MS);
  }, [following, clearResumeTimer]);

  // Pause state and timer reset with each trip.
  useEffect(() => {
    if (!following) {
      clearResumeTimer();
      setFollowPaused(false);
      setOverview(false);
    }
  }, [following, clearResumeTimer]);
  useEffect(() => clearResumeTimer, [clearResumeTimer]);

  // Overview: fit the whole remaining route flat and north-up; back to the
  // follow on tap (toggle/re-centre), a map gesture, or by itself on timeout.
  const toggleOverview = useCallback(() => {
    clearResumeTimer();
    setFollowPaused(false);
    setOverview((o) => !o);
  }, [clearResumeTimer]);
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    if (!overview) return;
    const points = navRef.current.activePath?.points;
    const bounds = points
      ? remainingRouteBounds(points, navRef.current.state?.traveledM ?? 0)
      : null;
    if (bounds) {
      // Fit once per toggle — refitting on every fix would fight the driver.
      // Flat and north-up: the follow camera's course bearing and pitch would
      // make an overview unreadable.
      cameraRef.current?.fitBounds([bounds.sw.lng, bounds.sw.lat, bounds.ne.lng, bounds.ne.lat], {
        padding: viewport.overviewPadding,
        bearing: 0,
        pitch: 0,
        duration: 600,
      });
    }
    const timer = setTimeout(() => setOverview(false), OVERVIEW_RESUME_MS);
    return () => clearTimeout(timer);
  }, [overview, cameraRef, viewport]);

  const state = nav.state;
  useEffect(() => {
    if (!following || followPaused || overview || !state) return;
    const snapped = state.snapped;
    if (state.courseDeg !== null) bearingRef.current = state.courseDeg;
    // Course-up from the first fix, not from the first movement: the driving
    // frame is what "Start" promises, and the route tangent already gives a
    // stable bearing while stationary (courseDeg comes from the line, not from
    // jittery GPS course). Waiting for `departed` meant every trip opened in a
    // north-up frame that then swung round on pulling away — the one moment
    // the driver is looking for the road ahead, not a camera animation.
    const courseUp = navFollow === 'course';
    const padding = courseUp ? viewport.coursePadding : viewport.flatPadding;
    // On a portrait screen the header hides the top of the route, so zoom for
    // the genuinely visible road between its bottom and the puck. Landscape's
    // right map pane is open all the way to the status bar.
    const visibleTop = viewport.landscape
      ? viewport.flatPadding.top
      : viewport.flatPadding.top + 8 + guidanceHeight;
    const forwardDp = courseUp
      ? Math.max(160, Math.round(viewport.courseAnchor.y - visibleTop - 12))
      : Math.round(win.height * 0.4);
    lastCenterRef.current = [snapped.lng, snapped.lat];
    cameraRef.current?.easeTo({
      center: [snapped.lng, snapped.lat],
      zoom: followZoom(nav.speedMps, snapped.lat, state.upcoming?.distanceToM ?? null, forwardDp),
      bearing: courseUp ? bearingRef.current : 0,
      pitch: courseUp ? 45 : 0,
      padding,
      // Linear easing over roughly the fix interval keeps back-to-back
      // updates from stuttering (web-nav parity).
      duration: 800,
      easing: 'linear',
    });
  }, [
    cameraRef,
    following,
    followPaused,
    overview,
    state,
    navFollow,
    nav.speedMps,
    win.height,
    viewport,
    guidanceHeight,
  ]);

  // Trip over: put the camera back the way the rest of the app expects it —
  // north-up, flat, un-padded (padding needs a centre-carrying move to reset).
  const wasFollowing = useRef(false);
  useEffect(() => {
    if (wasFollowing.current && !following && lastCenterRef.current) {
      cameraRef.current?.easeTo({
        center: lastCenterRef.current,
        bearing: 0,
        pitch: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        duration: 600,
      });
      lastCenterRef.current = null;
    }
    wasFollowing.current = following;
  }, [cameraRef, following]);

  return { followPaused, resumeFollow, onUserGesture, overview, toggleOverview };
}
