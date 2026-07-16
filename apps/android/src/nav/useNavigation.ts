import type { LatLng } from '@atlas/core';
import { NavigationSession, type NavState } from '@atlas/navigation';
import { httpRouteProvider, type RoutePath, type RoutingProfile } from '@atlas/routing';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useServerOrigin } from '../serverOrigin';
import { type LocationFix, NAV_LOCATION_TASK, setLocationHandler } from './locationTask';

export type NavPhase = 'idle' | 'starting' | 'navigating' | 'rerouting' | 'arrived' | 'error';

export interface NavController {
  phase: NavPhase;
  state: NavState | null;
  /** Active route geometry as [lng, lat] pairs, for the map line source. */
  routeCoords: number[][];
  profile: RoutingProfile;
  /** Where the trip is headed (for the finish marker); null when idle. */
  destination: LatLng | null;
  /** Latest ground speed in m/s, or null when unknown/stationary. */
  speedMps: number | null;
  /** Whether voice prompts are muted. */
  muted: boolean;
  error: string | null;
  start: (destination: LatLng, profile?: RoutingProfile) => Promise<void>;
  toggleMute: () => void;
  stop: () => void;
}

/**
 * Drives @atlas/navigation's NavigationSession from live device GPS, speaks its
 * voice prompts (expo-speech), and re-routes when the traveller leaves the line.
 * Routing goes through the online RouteProvider (the server's GraphHopper) —
 * offline on-device routing is deferred (see docs/ROADMAP.md Phase 7). Location
 * runs under an Android foreground service so guidance survives screen-off.
 */
export function useNavigation(): NavController {
  const serverOrigin = useServerOrigin();
  const provider = useMemo(() => httpRouteProvider({ baseUrl: serverOrigin }), [serverOrigin]);

  const [phase, setPhase] = useState<NavPhase>('idle');
  const [state, setState] = useState<NavState | null>(null);
  const [routeCoords, setRouteCoords] = useState<number[][]>([]);
  const [profile, setProfile] = useState<RoutingProfile>('car');
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<NavigationSession | null>(null);
  const destRef = useRef<LatLng | null>(null);
  const profileRef = useRef<RoutingProfile>('car');
  const rerouteInFlight = useRef(false);
  // Read inside the fix handler (which closes over a stale `muted`), so keep a ref.
  const mutedRef = useRef(false);

  /** Speak a voice prompt, unless muted; never let a TTS error interrupt navigation. */
  const speak = useCallback((text: string): void => {
    if (mutedRef.current) return;
    try {
      Speech.speak(text);
    } catch (err) {
      console.warn('tts failed', err);
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      mutedRef.current = next;
      if (next) Speech.stop();
      return next;
    });
  }, []);

  const fetchPath = useCallback(
    async (origin: LatLng, destination: LatLng, prof: RoutingProfile): Promise<RoutePath> => {
      const result = await provider.route({
        profile: prof,
        points: [origin, destination],
        instructions: true,
      });
      const path = result.paths[0];
      if (!path) throw new Error('no route found');
      return path;
    },
    [provider],
  );

  const stopUpdates = useCallback(() => {
    setLocationHandler(null);
    void Location.hasStartedLocationUpdatesAsync(NAV_LOCATION_TASK).then((started) => {
      if (started) void Location.stopLocationUpdatesAsync(NAV_LOCATION_TASK);
    });
  }, []);

  const stop = useCallback(
    (arrived = false) => {
      stopUpdates();
      sessionRef.current = null;
      destRef.current = null;
      rerouteInFlight.current = false;
      setRouteCoords([]);
      setSpeedMps(null);
      if (!arrived) {
        setState(null);
        setDestination(null);
      }
      setPhase(arrived ? 'arrived' : 'idle');
    },
    [stopUpdates],
  );

  const reroute = useCallback(
    async (from: LocationFix) => {
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
    (fix: LocationFix) => {
      const session = sessionRef.current;
      if (!session) return;
      // Runs on every GPS fix (incl. the headless background task); an uncaught
      // throw here would take the whole app down in a release build.
      try {
        const { state: next, prompts } = session.update(fix, Date.now());
        setState(next);
        setSpeedMps(typeof fix.speedMps === 'number' && fix.speedMps >= 0 ? fix.speedMps : null);
        for (const prompt of prompts) speak(prompt.text);
        if (next.status === 'arrived') {
          speak('You have arrived');
          stop(true);
        } else if (next.status === 'off-route') {
          void reroute(fix);
        }
      } catch (err) {
        console.warn('navigation fix failed', err);
      }
    },
    [reroute, stop, speak],
  );

  const start = useCallback(
    async (destination: LatLng, prof: RoutingProfile = 'car') => {
      setError(null);
      setPhase('starting');
      try {
        const fg = await Location.requestForegroundPermissionsAsync();
        if (!fg.granted) throw new Error('Location permission is required to navigate');
        // Background permission is best-effort: navigation still works while the
        // app is foregrounded even if the user declines "allow all the time".
        await Location.requestBackgroundPermissionsAsync().catch(() => undefined);

        const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        const origin = { lat: cur.coords.latitude, lng: cur.coords.longitude };

        destRef.current = destination;
        profileRef.current = prof;
        setProfile(prof);
        setDestination(destination);
        setSpeedMps(null);

        const path = await fetchPath(origin, destination, prof);
        sessionRef.current = new NavigationSession(path);
        setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
        setState(null);

        setLocationHandler(onFix);
        const already = await Location.hasStartedLocationUpdatesAsync(NAV_LOCATION_TASK);
        if (!already) {
          await Location.startLocationUpdatesAsync(NAV_LOCATION_TASK, {
            accuracy: Location.Accuracy.BestForNavigation,
            distanceInterval: 5,
            showsBackgroundLocationIndicator: true,
            foregroundService: {
              notificationTitle: 'Atlas navigation',
              notificationBody: 'Guiding you to your destination',
            },
          });
        }
        setPhase('navigating');
      } catch (err) {
        setLocationHandler(null);
        sessionRef.current = null;
        destRef.current = null;
        setDestination(null);
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    },
    [fetchPath, onFix],
  );

  // Tear down the foreground service if the app unmounts mid-trip.
  useEffect(() => () => stopUpdates(), [stopUpdates]);

  return {
    phase,
    state,
    routeCoords,
    profile,
    destination,
    speedMps,
    muted,
    error,
    start,
    toggleMute,
    stop: () => stop(false),
  };
}
