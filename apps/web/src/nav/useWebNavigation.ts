import type { LatLng } from '@atlas/core';
import { NavigationSession, type NavState, type Position } from '@atlas/navigation';
import { fetchRoute, RoutingError, type RoutingProfile } from '@atlas/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

export type WebNavPhase = 'idle' | 'starting' | 'navigating' | 'rerouting' | 'arrived' | 'error';

export interface WebNavController {
  phase: WebNavPhase;
  state: NavState | null;
  /** Active route geometry as [lng, lat] pairs, for the map line source. */
  routeCoords: number[][];
  profile: RoutingProfile;
  /** Where the trip is headed (finish marker); null when idle. */
  destination: LatLng | null;
  /** Latest ground speed in m/s, or null when unknown/stationary. */
  speedMps: number | null;
  /** Latest compass course in degrees, for the course-up camera. */
  headingDeg: number | null;
  muted: boolean;
  error: string | null;
  start: (destination: LatLng, profile?: RoutingProfile) => Promise<void>;
  toggleMute: () => void;
  stop: () => void;
}

/** Promisified single geolocation fix. */
function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser has no geolocation'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => reject(new Error(err.message)), {
      enableHighAccuracy: true,
      timeout: 20_000,
    });
  });
}

/**
 * Turn-by-turn navigation for the web (Android useNavigation's browser twin):
 * drives @atlas/navigation's NavigationSession from the browser geolocation
 * watch, speaks voice prompts through the Web Speech API, and re-routes via
 * the server when the traveller leaves the line. No preview phase here — the
 * planner already offers route choices; navigation starts on the fastest.
 */
export function useWebNavigation(): WebNavController {
  const [phase, setPhase] = useState<WebNavPhase>('idle');
  const [state, setState] = useState<NavState | null>(null);
  const [routeCoords, setRouteCoords] = useState<number[][]>([]);
  const [profile, setProfile] = useState<RoutingProfile>('car');
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [headingDeg, setHeadingDeg] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<NavigationSession | null>(null);
  const destRef = useRef<LatLng | null>(null);
  const profileRef = useRef<RoutingProfile>('car');
  const watchIdRef = useRef<number | null>(null);
  const rerouteInFlight = useRef(false);
  const mutedRef = useRef(false);

  /** Speak a voice prompt, unless muted; never let speech errors break nav. */
  const speak = useCallback((text: string): void => {
    if (mutedRef.current || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } catch {
      // Speech is best-effort.
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      mutedRef.current = next;
      if (next && 'speechSynthesis' in window) window.speechSynthesis.cancel();
      return next;
    });
  }, []);

  const fetchPath = useCallback(async (origin: LatLng, dest: LatLng, prof: RoutingProfile) => {
    const result = await fetchRoute({
      profile: prof,
      points: [origin, dest],
      instructions: true,
    });
    const path = result.paths[0];
    if (!path) throw new Error('no route found');
    return path;
  }, []);

  const clearWatch = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const stop = useCallback(
    (arrived = false) => {
      clearWatch();
      sessionRef.current = null;
      destRef.current = null;
      rerouteInFlight.current = false;
      setRouteCoords([]);
      setSpeedMps(null);
      setHeadingDeg(null);
      if (!arrived) {
        setState(null);
        setDestination(null);
      }
      setPhase(arrived ? 'arrived' : 'idle');
    },
    [clearWatch],
  );

  const reroute = useCallback(
    async (from: LatLng) => {
      if (rerouteInFlight.current || !destRef.current) return;
      rerouteInFlight.current = true;
      setPhase('rerouting');
      try {
        const path = await fetchPath(from, destRef.current, profileRef.current);
        sessionRef.current = new NavigationSession(path);
        setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
      } catch {
        // Keep the old session; the next off-route fix retries.
      } finally {
        rerouteInFlight.current = false;
        setPhase('navigating');
      }
    },
    [fetchPath],
  );

  const onFix = useCallback(
    (geo: GeolocationPosition) => {
      const session = sessionRef.current;
      if (!session) return;
      const { coords } = geo;
      const fix: Position = { lat: coords.latitude, lng: coords.longitude };
      if (typeof coords.heading === 'number' && !Number.isNaN(coords.heading)) {
        fix.headingDeg = coords.heading;
        setHeadingDeg(coords.heading);
      }
      if (typeof coords.speed === 'number' && coords.speed >= 0) {
        fix.speedMps = coords.speed;
        setSpeedMps(coords.speed);
      } else {
        setSpeedMps(null);
      }
      const { state: next, prompts } = session.update(fix, Date.now());
      setState(next);
      for (const prompt of prompts) speak(prompt.text);
      if (next.status === 'arrived') {
        speak('You have arrived');
        stop(true);
      } else if (next.status === 'off-route') {
        void reroute(fix);
      }
    },
    [reroute, stop, speak],
  );

  const start = useCallback(
    async (dest: LatLng, prof: RoutingProfile = 'car') => {
      setError(null);
      setPhase('starting');
      try {
        const cur = await currentPosition();
        const origin = { lat: cur.coords.latitude, lng: cur.coords.longitude };

        destRef.current = dest;
        profileRef.current = prof;
        setProfile(prof);
        setDestination(dest);
        setSpeedMps(null);
        setState(null);

        const path = await fetchPath(origin, dest, prof);
        sessionRef.current = new NavigationSession(path);
        setRouteCoords(path.points.map((p) => [p.lng, p.lat]));

        clearWatch();
        watchIdRef.current = navigator.geolocation.watchPosition(
          onFix,
          () => {
            // A transient watch error is not fatal; the next fix resumes.
          },
          { enableHighAccuracy: true },
        );
        setPhase('navigating');
        // Process the first fix immediately rather than waiting for movement.
        onFix(cur);
      } catch (err) {
        clearWatch();
        sessionRef.current = null;
        destRef.current = null;
        setDestination(null);
        setError(err instanceof RoutingError || err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    },
    [fetchPath, onFix, clearWatch],
  );

  // Drop the geolocation watch if the app unmounts mid-trip.
  useEffect(() => clearWatch, [clearWatch]);

  return {
    phase,
    state,
    routeCoords,
    profile,
    destination,
    speedMps,
    headingDeg,
    muted,
    error,
    start,
    toggleMute,
    stop: () => stop(false),
  };
}
