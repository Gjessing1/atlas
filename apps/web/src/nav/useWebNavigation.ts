import type { LatLng } from '@atlas/core';
import { NavigationSession, type NavState, type Position } from '@atlas/navigation';
import { fetchRoute, RoutingError, type RoutePath, type RoutingProfile } from '@atlas/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

export type WebNavPhase = 'idle' | 'starting' | 'navigating' | 'rerouting' | 'arrived' | 'error';

/** What the arrival card shows once the trip is over. */
export interface TripSummary {
  distanceM: number;
  durationMs: number;
}

export interface WebNavController {
  phase: WebNavPhase;
  state: NavState | null;
  /** Active route geometry as [lng, lat] pairs, for the map line source. */
  routeCoords: number[][];
  /** The route being followed (instructions included, for on-map turn arrows). */
  activePath: RoutePath | null;
  profile: RoutingProfile;
  /** Where the trip is headed (finish marker); null when idle. */
  destination: LatLng | null;
  /** Latest ground speed in m/s, or null when unknown/stationary. */
  speedMps: number | null;
  /** Latest compass course in degrees, for the course-up camera. */
  headingDeg: number | null;
  muted: boolean;
  /** Distance/time of the finished trip (arrived phase only), else null. */
  tripSummary: TripSummary | null;
  error: string | null;
  start: (destination: LatLng, profile?: RoutingProfile) => Promise<void>;
  toggleMute: () => void;
  /** Set mute directly (the persisted preference applies through this). */
  setMuted: (muted: boolean) => void;
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
  const [activePath, setActivePath] = useState<RoutePath | null>(null);
  const [profile, setProfile] = useState<RoutingProfile>('car');
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [headingDeg, setHeadingDeg] = useState<number | null>(null);
  const [muted, setMutedState] = useState(false);
  const [tripSummary, setTripSummary] = useState<TripSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<NavigationSession | null>(null);
  const destRef = useRef<LatLng | null>(null);
  const profileRef = useRef<RoutingProfile>('car');
  const watchIdRef = useRef<number | null>(null);
  const rerouteInFlight = useRef(false);
  const mutedRef = useRef(false);
  /** When guidance began, for the arrival card's elapsed time. */
  const tripStartRef = useRef<number | null>(null);
  /** Distance driven across reroutes (each reroute starts a fresh session). */
  const traveledBaseRef = useRef(0);
  /** Latest NavState, readable from callbacks without a stale closure. */
  const lastStateRef = useRef<NavState | null>(null);

  /** Speak a voice prompt, unless muted; never let speech errors break nav. */
  const speak = useCallback((text: string): void => {
    if (mutedRef.current || !('speechSynthesis' in window)) return;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      // Instructions are English; without a pinned language a Norwegian
      // system voice garbles them.
      utterance.lang = 'en';
      window.speechSynthesis.speak(utterance);
    } catch {
      // Speech is best-effort.
    }
  }, []);

  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    if (next && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setMutedState(next);
  }, []);

  const toggleMute = useCallback(() => setMuted(!mutedRef.current), [setMuted]);

  const fetchPath = useCallback(
    async (origin: LatLng, dest: LatLng, prof: RoutingProfile, headingDeg?: number) => {
      const result = await fetchRoute({
        profile: prof,
        points: [origin, dest],
        instructions: true,
        ...(typeof headingDeg === 'number' ? { headingDeg } : {}),
      });
      const path = result.paths[0];
      if (!path) throw new Error('no route found');
      return path;
    },
    [],
  );

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
      setActivePath(null);
      setSpeedMps(null);
      setHeadingDeg(null);
      if (!arrived) {
        setState(null);
        setDestination(null);
        setTripSummary(null);
      }
      tripStartRef.current = null;
      traveledBaseRef.current = 0;
      setPhase(arrived ? 'arrived' : 'idle');
    },
    [clearWatch],
  );

  const reroute = useCallback(
    async (from: Position) => {
      if (rerouteInFlight.current || !destRef.current) return;
      rerouteInFlight.current = true;
      setPhase('rerouting');
      try {
        // Pass the travel direction (only meaningful when moving) so the new
        // route continues the way the car points instead of via a U-turn.
        const heading =
          typeof from.speedMps === 'number' && from.speedMps >= 2 ? from.headingDeg : undefined;
        const path = await fetchPath(from, destRef.current, profileRef.current, heading);
        // The old session dies here — bank its driven distance for the summary.
        traveledBaseRef.current += lastStateRef.current?.traveledM ?? 0;
        // Rerouting happens mid-drive: never regress to the pre-departure
        // framing (calm camera / no snap-lock) the fresh session starts in.
        sessionRef.current = new NavigationSession(path, {
          startDeparted: lastStateRef.current?.departed ?? true,
        });
        setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
        setActivePath(path);
        // "Which way now?" is most urgent right after recalculating.
        const depart = sessionRef.current.departurePrompt();
        if (depart) speak(depart.text);
      } catch {
        // Keep the old session; the next off-route fix retries.
      } finally {
        rerouteInFlight.current = false;
        setPhase('navigating');
      }
    },
    [fetchPath, speak],
  );

  const onFix = useCallback(
    (geo: GeolocationPosition) => {
      const session = sessionRef.current;
      if (!session) return;
      const { coords } = geo;
      const fix: Position = { lat: coords.latitude, lng: coords.longitude };
      if (typeof coords.accuracy === 'number' && coords.accuracy >= 0) {
        fix.accuracyM = coords.accuracy;
      }
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
      lastStateRef.current = next;
      for (const prompt of prompts) speak(prompt.text);
      if (next.status === 'arrived') {
        speak(session.arrivalText());
        setTripSummary({
          distanceM: traveledBaseRef.current + next.traveledM,
          durationMs: tripStartRef.current !== null ? Date.now() - tripStartRef.current : 0,
        });
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
        setTripSummary(null);
        lastStateRef.current = null;
        traveledBaseRef.current = 0;

        const path = await fetchPath(origin, dest, prof);
        const session = new NavigationSession(path);
        sessionRef.current = session;
        tripStartRef.current = Date.now();
        setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
        setActivePath(path);

        clearWatch();
        watchIdRef.current = navigator.geolocation.watchPosition(
          onFix,
          () => {
            // A transient watch error is not fatal; the next fix resumes.
          },
          { enableHighAccuracy: true },
        );
        setPhase('navigating');
        // Guidance used to be silent until the first approach threshold —
        // exactly when the driver wonders "which way?".
        const depart = session.departurePrompt();
        if (depart) speak(depart.text);
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
    [fetchPath, onFix, clearWatch, speak],
  );

  // Session heartbeat: dead-reckons through GPS gaps (tunnels) and flips the
  // state to signal-lost when fixes stop, so the puck never just freezes.
  const guiding = phase === 'navigating' || phase === 'rerouting';
  useEffect(() => {
    if (!guiding) return;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      const update = session.tick(Date.now());
      if (!update) return;
      setState(update.state);
      lastStateRef.current = update.state;
      for (const prompt of update.prompts) speak(prompt.text);
    }, 1000);
    return () => clearInterval(timer);
  }, [guiding, speak]);

  // A navigating phone browser is a dashboard: hold a screen wake lock for
  // the trip (best-effort — Safari < 16.4 has none). The lock is silently
  // released when the tab is hidden, so reacquire on return.
  useEffect(() => {
    if (!guiding || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      void navigator.wakeLock
        .request('screen')
        .then((sentinel) => {
          if (stopped) void sentinel.release();
          else lock = sentinel;
        })
        .catch(() => undefined);
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => undefined);
    };
  }, [guiding]);

  // Drop the geolocation watch if the app unmounts mid-trip.
  useEffect(() => clearWatch, [clearWatch]);

  return {
    phase,
    state,
    routeCoords,
    activePath,
    profile,
    destination,
    speedMps,
    headingDeg,
    muted,
    tripSummary,
    error,
    start,
    toggleMute,
    setMuted,
    stop: () => stop(false),
  };
}
