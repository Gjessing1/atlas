import type { LatLng } from '@atlas/core';
import { NavigationSession, type NavState } from '@atlas/navigation';
import { type RoutePath, type RoutingProfile } from '@atlas/routing';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { makeRouteProvider } from '../routing/offlineRouting';
import { useServerOrigin } from '../serverOrigin';
import { type LocationFix, NAV_LOCATION_TASK, setLocationHandler } from './locationTask';

export type NavPhase =
  'idle' | 'starting' | 'preview' | 'navigating' | 'rerouting' | 'arrived' | 'error';

export interface NavController {
  phase: NavPhase;
  state: NavState | null;
  /** Active route geometry as [lng, lat] pairs, for the map line source. */
  routeCoords: number[][];
  /** The route being followed (instructions included, for on-map turn arrows). */
  activePath: RoutePath | null;
  profile: RoutingProfile;
  /** Where the trip is headed (for the finish marker); null when idle. */
  destination: LatLng | null;
  /** Route choices while in the preview phase (fastest first); null otherwise. */
  previewPaths: RoutePath[] | null;
  /** Index into previewPaths of the choice guidance will follow. */
  previewIndex: number;
  /** Latest ground speed in m/s, or null when unknown/stationary. */
  speedMps: number | null;
  /** Whether voice prompts are muted. */
  muted: boolean;
  error: string | null;
  start: (destination: LatLng, profile?: RoutingProfile) => Promise<void>;
  /** Pick one of the preview route choices (preview phase only). */
  selectPreview: (index: number) => void;
  /** Begin guidance along the selected preview choice. */
  go: () => Promise<void>;
  toggleMute: () => void;
  stop: () => void;
}

/**
 * Drives @atlas/navigation's NavigationSession from live device GPS, speaks its
 * voice prompts (expo-speech), and re-routes when the traveller leaves the line.
 * Routing goes through the shared offline-first provider: the embedded Valhalla
 * engine when a downloaded pack covers the trip, otherwise the server. Location
 * runs under an Android foreground service so guidance survives screen-off.
 *
 * Starting a trip is two-step (Google-style): `start` fetches the route plus
 * up to two alternatives and enters the `preview` phase — the fastest is
 * pre-selected, the map shows all choices — then `go` begins guidance along
 * the selected one. Re-routes after leaving the line always take the fastest.
 */
export function useNavigation(): NavController {
  const serverOrigin = useServerOrigin();
  const provider = useMemo(() => makeRouteProvider(serverOrigin), [serverOrigin]);

  const [phase, setPhase] = useState<NavPhase>('idle');
  const [state, setState] = useState<NavState | null>(null);
  const [routeCoords, setRouteCoords] = useState<number[][]>([]);
  const [activePath, setActivePath] = useState<RoutePath | null>(null);
  const [profile, setProfile] = useState<RoutingProfile>('car');
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [previewPaths, setPreviewPaths] = useState<RoutePath[] | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
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
      // Instructions are English; without a pinned language a Norwegian
      // device voice garbles them.
      Speech.speak(text, { language: 'en' });
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
    async (
      origin: LatLng,
      destination: LatLng,
      prof: RoutingProfile,
      headingDeg?: number,
    ): Promise<RoutePath> => {
      const result = await provider.route({
        profile: prof,
        points: [origin, destination],
        instructions: true,
        ...(typeof headingDeg === 'number' ? { headingDeg } : {}),
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
      setActivePath(null);
      setPreviewPaths(null);
      setPreviewIndex(0);
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
        // Pass the travel direction (only meaningful when moving) so the new
        // route continues the way the car points instead of via a U-turn.
        const heading =
          typeof from.speedMps === 'number' && from.speedMps >= 2 ? from.headingDeg : undefined;
        const path = await fetchPath(from, destRef.current, profileRef.current, heading);
        sessionRef.current = new NavigationSession(path);
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
          speak(session.arrivalText());
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
        setState(null);
        setRouteCoords([]);

        // Route choices: the fastest plus up to two alternatives, offered
        // before guidance starts. Selecting nothing keeps the fastest.
        const result = await provider.route({
          profile: prof,
          points: [origin, destination],
          instructions: true,
          alternatives: true,
        });
        if (result.paths.length === 0) throw new Error('no route found');
        setPreviewPaths(result.paths);
        setPreviewIndex(0);
        setPhase('preview');
      } catch (err) {
        setLocationHandler(null);
        sessionRef.current = null;
        destRef.current = null;
        setDestination(null);
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    },
    [provider],
  );

  const go = useCallback(async () => {
    const path = previewPaths?.[previewIndex];
    if (!path) return;
    try {
      const session = new NavigationSession(path);
      sessionRef.current = session;
      setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
      setActivePath(path);
      setPreviewPaths(null);
      setPreviewIndex(0);
      setState(null);

      setLocationHandler(onFix);
      const already = await Location.hasStartedLocationUpdatesAsync(NAV_LOCATION_TASK);
      if (!already) {
        await Location.startLocationUpdatesAsync(NAV_LOCATION_TASK, {
          accuracy: Location.Accuracy.BestForNavigation,
          // Time-based, not distance-based: with a distance filter no fixes
          // arrive at a standstill, freezing the ETA at every red light.
          timeInterval: 1000,
          distanceInterval: 0,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'Atlas navigation',
            notificationBody: 'Guiding you to your destination',
          },
        });
      }
      setPhase('navigating');
      // Guidance used to be silent until the first approach threshold —
      // exactly when the driver wonders "which way?".
      const depart = session.departurePrompt();
      if (depart) speak(depart.text);
    } catch (err) {
      setLocationHandler(null);
      sessionRef.current = null;
      destRef.current = null;
      setDestination(null);
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [previewPaths, previewIndex, onFix, speak]);

  // Tear down the foreground service if the app unmounts mid-trip.
  useEffect(() => () => stopUpdates(), [stopUpdates]);

  // A navigating phone is a dashboard: keep the screen on for the whole trip.
  const guiding = phase === 'navigating' || phase === 'rerouting';

  // Session heartbeat: dead-reckons through GPS gaps (tunnels) and flips the
  // state to signal-lost when fixes stop, so the puck never just freezes.
  useEffect(() => {
    if (!guiding) return;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      try {
        const update = session.tick(Date.now());
        if (!update) return;
        setState(update.state);
        for (const prompt of update.prompts) speak(prompt.text);
      } catch (err) {
        console.warn('navigation tick failed', err);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [guiding, speak]);
  useEffect(() => {
    if (!guiding) return;
    void activateKeepAwakeAsync('atlas-nav').catch(() => undefined);
    return () => {
      void deactivateKeepAwake('atlas-nav').catch(() => undefined);
    };
  }, [guiding]);

  return {
    phase,
    state,
    routeCoords,
    activePath,
    profile,
    destination,
    previewPaths,
    previewIndex,
    speedMps,
    muted,
    error,
    start,
    selectPreview: setPreviewIndex,
    go,
    toggleMute,
    stop: () => stop(false),
  };
}
