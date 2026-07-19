import type { LatLng } from '@atlas/core';
import { headingRateDegPerSec, NavigationSession, type NavState } from '@atlas/navigation';
import { type RoutePath, type RoutingProfile } from '@atlas/routing';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AudioFocus } from '../../modules/audiofocus';
import { makeRouteProvider } from '../routing/offlineRouting';
import { useServerOrigin } from '../serverOrigin';
import { type LocationFix, NAV_LOCATION_TASK, setLocationHandler } from './locationTask';

export type NavPhase =
  'idle' | 'starting' | 'preview' | 'navigating' | 'rerouting' | 'arrived' | 'error';

/** What the arrival card shows once the trip is over. */
export interface TripSummary {
  distanceM: number;
  durationMs: number;
}

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
  /** True while a profile switch is refetching the preview choices. */
  previewLoading: boolean;
  /** Why the last profile switch kept the old choices (no route, offline …). */
  previewError: string | null;
  /** Latest ground speed in m/s, or null when unknown/stationary. */
  speedMps: number | null;
  /** Whether voice prompts are muted. */
  muted: boolean;
  /** Distance/time of the finished trip (arrived phase only), else null. */
  tripSummary: TripSummary | null;
  error: string | null;
  start: (destination: LatLng, profile?: RoutingProfile) => Promise<void>;
  /** Pick one of the preview route choices (preview phase only). */
  selectPreview: (index: number) => void;
  /** Switch profile and refetch the preview choices (preview phase only). */
  setProfile: (profile: RoutingProfile) => void;
  /** Begin guidance along the selected preview choice. */
  go: () => Promise<void>;
  toggleMute: () => void;
  /** Set mute directly (the persisted preference applies through this). */
  setMuted: (muted: boolean) => void;
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
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [muted, setMutedState] = useState(false);
  const [tripSummary, setTripSummary] = useState<TripSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<NavigationSession | null>(null);
  const destRef = useRef<LatLng | null>(null);
  /** Where the preview was requested from, so a profile switch can refetch. */
  const originRef = useRef<LatLng | null>(null);
  /** Guards against an older profile fetch landing after a newer one. */
  const previewSeq = useRef(0);
  const profileRef = useRef<RoutingProfile>('car');
  const rerouteInFlight = useRef(false);
  // Read inside the fix handler (which closes over a stale `muted`), so keep a ref.
  const mutedRef = useRef(false);
  /** When guidance began, for the arrival card's elapsed time. */
  const tripStartRef = useRef<number | null>(null);
  /** Distance driven across reroutes (each reroute starts a fresh session). */
  const traveledBaseRef = useRef(0);
  /** Latest NavState, readable from callbacks without a stale closure. */
  const lastStateRef = useRef<NavState | null>(null);
  /** Utterances queued or playing — audio focus is held while it's non-zero. */
  const utterancesRef = useRef(0);

  /** Speak a voice prompt, unless muted; never let a TTS error interrupt navigation. */
  const speak = useCallback((text: string): void => {
    if (mutedRef.current) return;
    // Duck music/podcasts for the duration of the prompt (expo-speech never
    // asks for audio focus itself, so prompts used to talk over media). One
    // focus hold spans a whole queued burst of utterances.
    const focus = (on: boolean) => {
      try {
        if (on) AudioFocus?.requestDuck();
        else AudioFocus?.abandon();
      } catch (err) {
        console.warn('audio focus failed', err);
      }
    };
    if (utterancesRef.current === 0) focus(true);
    utterancesRef.current++;
    const release = () => {
      utterancesRef.current = Math.max(0, utterancesRef.current - 1);
      if (utterancesRef.current === 0) focus(false);
    };
    try {
      // Instructions are English; without a pinned language a Norwegian
      // device voice garbles them.
      Speech.speak(text, {
        language: 'en',
        onDone: release,
        onStopped: release,
        onError: release,
      });
    } catch (err) {
      release();
      console.warn('tts failed', err);
    }
  }, []);

  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    if (next) Speech.stop();
    setMutedState(next);
  }, []);

  const toggleMute = useCallback(() => setMuted(!mutedRef.current), [setMuted]);

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
      originRef.current = null;
      previewSeq.current++;
      rerouteInFlight.current = false;
      setRouteCoords([]);
      setActivePath(null);
      setPreviewPaths(null);
      setPreviewIndex(0);
      setPreviewLoading(false);
      setPreviewError(null);
      setSpeedMps(null);
      if (!arrived) {
        setState(null);
        setDestination(null);
        setTripSummary(null);
      }
      tripStartRef.current = null;
      traveledBaseRef.current = 0;
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
    (fix: LocationFix) => {
      const session = sessionRef.current;
      if (!session) return;
      // Runs on every GPS fix (incl. the headless background task); an uncaught
      // throw here would take the whole app down in a release build.
      try {
        const { state: next, prompts } = session.update(fix, Date.now());
        setState(next);
        lastStateRef.current = next;
        setSpeedMps(typeof fix.speedMps === 'number' && fix.speedMps >= 0 ? fix.speedMps : null);
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

        // getCurrentPositionAsync has no timeout of its own — indoors it can
        // simply never resolve, wedging the phase in `starting` forever (the
        // web hook already races a 20 s limit). Fall back to the last known
        // position: a slightly stale preview origin beats no preview, and
        // guidance reroutes from the first live fix anyway.
        const cur = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]);
        const pos = cur ?? (await Location.getLastKnownPositionAsync({ maxAge: 120_000 }));
        if (!pos) throw new Error('Could not get a GPS fix — is location on?');
        const origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };

        destRef.current = destination;
        originRef.current = origin;
        profileRef.current = prof;
        setProfile(prof);
        setDestination(destination);
        setSpeedMps(null);
        setState(null);
        setRouteCoords([]);
        setPreviewError(null);

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
        originRef.current = null;
        setDestination(null);
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    },
    [provider],
  );

  // Profile switch on the preview card: refetch the choices for the same trip.
  // On failure the previous profile's choices stay up (with a note) — a dead
  // end here (no bike route, brief offline) must not kill the whole preview.
  const setNavProfile = useCallback(
    (prof: RoutingProfile) => {
      const origin = originRef.current;
      const dest = destRef.current;
      if (!origin || !dest || prof === profileRef.current) return;
      const seq = ++previewSeq.current;
      setPreviewLoading(true);
      setPreviewError(null);
      void (async () => {
        try {
          const result = await provider.route({
            profile: prof,
            points: [origin, dest],
            instructions: true,
            alternatives: true,
          });
          if (seq !== previewSeq.current) return;
          if (result.paths.length === 0) throw new Error('no route found');
          profileRef.current = prof;
          setProfile(prof);
          setPreviewPaths(result.paths);
          setPreviewIndex(0);
        } catch (err) {
          if (seq !== previewSeq.current) return;
          setPreviewError(err instanceof Error ? err.message : String(err));
        } finally {
          if (seq === previewSeq.current) setPreviewLoading(false);
        }
      })();
    },
    [provider],
  );

  const go = useCallback(async () => {
    const path = previewPaths?.[previewIndex];
    if (!path) return;
    try {
      const session = new NavigationSession(path);
      sessionRef.current = session;
      tripStartRef.current = Date.now();
      traveledBaseRef.current = 0;
      lastStateRef.current = null;
      setTripSummary(null);
      setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
      setActivePath(path);
      previewSeq.current++;
      setPreviewPaths(null);
      setPreviewIndex(0);
      setPreviewLoading(false);
      setPreviewError(null);
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
      originRef.current = null;
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
        lastStateRef.current = update.state;
        for (const prompt of update.prompts) speak(prompt.text);
      } catch (err) {
        console.warn('navigation tick failed', err);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [guiding, speak]);
  // While dead reckoning (tunnel), feed the gyro's world-vertical yaw into the
  // session so it can notice the car turning off the assumed line — an
  // in-tunnel fork or roundabout exit that cross-track can't see without GPS.
  // The magnetometer is useless in a car in a tunnel; the gyro's relative yaw
  // since the last good fix is the reliable signal. Subscribed only during
  // gaps: while fixes flow the session ignores reports anyway.
  const reckoning = guiding && state?.fix === 'estimated';
  useEffect(() => {
    if (!reckoning) return;
    DeviceMotion.setUpdateInterval(100);
    let lastMs: number | null = null;
    const sub = DeviceMotion.addListener((m) => {
      const session = sessionRef.current;
      const rot = m.rotationRate;
      const grav = m.accelerationIncludingGravity;
      if (!session || !rot || !grav) return;
      const now = Date.now();
      const dtSec = lastMs === null ? 0 : Math.min(0.5, (now - lastMs) / 1000);
      lastMs = now;
      if (dtSec <= 0) return;
      // W3C device axes: beta about x, gamma about y, alpha about z (deg/s).
      const rate = headingRateDegPerSec(
        { x: rot.beta ?? 0, y: rot.gamma ?? 0, z: rot.alpha ?? 0 },
        grav,
      );
      if (rate !== null) session.reportHeadingDelta(rate * dtSec);
    });
    return () => sub.remove();
  }, [reckoning]);

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
    previewLoading,
    previewError,
    speedMps,
    muted,
    tripSummary,
    error,
    start,
    selectPreview: setPreviewIndex,
    setProfile: setNavProfile,
    go,
    toggleMute,
    setMuted,
    stop: () => stop(false),
  };
}
