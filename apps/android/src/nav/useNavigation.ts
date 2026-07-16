import type { LatLng } from '@atlas/core';
import { NavigationSession, type NavState } from '@atlas/navigation';
import { httpRouteProvider, type RoutePath, type RoutingProfile } from '@atlas/routing';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SERVER_ORIGIN } from '../config';
import { type LocationFix, NAV_LOCATION_TASK, setLocationHandler } from './locationTask';

export type NavPhase = 'idle' | 'starting' | 'navigating' | 'rerouting' | 'arrived' | 'error';

/** Speak a voice prompt, never letting a TTS engine error interrupt navigation. */
function speak(text: string): void {
  try {
    Speech.speak(text);
  } catch (err) {
    console.warn('tts failed', err);
  }
}

export interface NavController {
  phase: NavPhase;
  state: NavState | null;
  /** Active route geometry as [lng, lat] pairs, for the map line source. */
  routeCoords: number[][];
  profile: RoutingProfile;
  error: string | null;
  start: (destination: LatLng, profile?: RoutingProfile) => Promise<void>;
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
  const provider = useMemo(() => httpRouteProvider({ baseUrl: SERVER_ORIGIN }), []);

  const [phase, setPhase] = useState<NavPhase>('idle');
  const [state, setState] = useState<NavState | null>(null);
  const [routeCoords, setRouteCoords] = useState<number[][]>([]);
  const [profile, setProfile] = useState<RoutingProfile>('car');
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<NavigationSession | null>(null);
  const destRef = useRef<LatLng | null>(null);
  const profileRef = useRef<RoutingProfile>('car');
  const rerouteInFlight = useRef(false);

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
      if (!arrived) setState(null);
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
    [reroute, stop],
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
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    },
    [fetchPath, onFix],
  );

  // Tear down the foreground service if the app unmounts mid-trip.
  useEffect(() => () => stopUpdates(), [stopUpdates]);

  return { phase, state, routeCoords, profile, error, start, stop: () => stop(false) };
}
