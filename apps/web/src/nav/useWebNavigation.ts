import type { LatLng } from '@atlas/core';
import {
  navOptionsForProfile,
  NavigationSession,
  type NavState,
  type Position,
} from '@atlas/navigation';
import {
  enrichRoute,
  fetchRoute,
  httpTraceTransport,
  RoutingError,
  sortRouteChoices,
  type RoutePath,
  type RoutingProfile,
} from '@atlas/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

export type WebNavPhase =
  'idle' | 'starting' | 'preview' | 'navigating' | 'rerouting' | 'arrived' | 'error';

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
  /** True while off-route but the reroute keeps failing (routing unreachable). */
  rerouteFailed: boolean;
  /** Route choices while in the preview phase (fastest first); null otherwise. */
  previewPaths: RoutePath[] | null;
  /** Index into previewPaths of the choice guidance will follow. */
  previewIndex: number;
  /** True while a profile switch is refetching the preview choices. */
  previewLoading: boolean;
  /** Why the last profile switch failed (the old choices stay up); else null. */
  previewError: string | null;
  error: string | null;
  /** Look up route choices to a destination and enter the preview phase. */
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
  /**
   * End the trip as *arrived* on the traveller's say-so. Offered because both
   * automatic rules can miss at the destination — a fix that never gets
   * accurate enough, or a destination the road data puts across a wall.
   */
  arriveNow: () => void;
  stop: () => void;
}

/** Promisified single geolocation fix. */
function currentPosition(timeout = 20_000): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser has no geolocation'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => reject(new Error(err.message)), {
      enableHighAccuracy: true,
      timeout,
    });
  });
}

/**
 * Turn-by-turn navigation for the web (Android useNavigation's browser twin):
 * drives @atlas/navigation's NavigationSession from the browser geolocation
 * watch, speaks voice prompts through the Web Speech API, and re-routes via
 * the server when the traveller leaves the line. `start` fetches the fastest
 * route plus up to two alternatives and enters the `preview` phase; `go`
 * begins guidance along the selected choice.
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
  const [rerouteFailed, setRerouteFailed] = useState(false);
  const [previewPaths, setPreviewPaths] = useState<RoutePath[] | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<NavigationSession | null>(null);
  const destRef = useRef<LatLng | null>(null);
  /** Where the preview was requested from, so a profile switch can refetch. */
  const originRef = useRef<LatLng | null>(null);
  /** Guards preview refetches: a late response for an abandoned profile is dropped. */
  const previewSeq = useRef(0);
  /** The fix the preview was built from, replayed on Start if still fresh. */
  const originFixRef = useRef<GeolocationPosition | null>(null);
  const profileRef = useRef<RoutingProfile>('car');
  const watchIdRef = useRef<number | null>(null);
  const rerouteInFlight = useRef(false);
  /** Earliest time (epoch ms) a failed reroute may be retried (backoff). */
  const rerouteBackoffUntil = useRef(0);
  /** Consecutive reroute failures, driving the backoff exponent. */
  const rerouteFailCount = useRef(0);
  const mutedRef = useRef(false);
  /** When guidance began, for the arrival card's elapsed time. */
  const tripStartRef = useRef<number | null>(null);
  /** Distance driven across reroutes (each reroute starts a fresh session). */
  const traveledBaseRef = useRef(0);
  /** Latest NavState, readable from callbacks without a stale closure. */
  const lastStateRef = useRef<NavState | null>(null);
  /** Cancels an in-flight route-enrichment fetch (End, or a reroute superseding it). */
  const enrichAbort = useRef<AbortController | null>(null);

  /**
   * Fetch the road attributes for a route and hand them to its session — speed
   * limits, in practice. Deliberately fire-and-forget: guidance starts on the
   * previous line, and a slow or failed enrichment only costs the roundel.
   */
  const enrich = useCallback((session: NavigationSession, path: RoutePath): void => {
    enrichAbort.current?.abort();
    const controller = new AbortController();
    enrichAbort.current = controller;
    void enrichRoute(path, profileRef.current, httpTraceTransport(), {
      signal: controller.signal,
    })
      .then((enrichment) => {
        // A reroute (or End) may have replaced this session while the request
        // was out; attributes measured along the old line must not be applied
        // to the new one, where the same distances mean different roads.
        if (sessionRef.current !== session) return;
        const refreshed = session.setEnrichment(enrichment);
        if (refreshed) {
          setState(refreshed);
          lastStateRef.current = refreshed;
        }
      })
      .catch(() => {
        // Enrichment is optional by design — no limit is shown, nav continues.
      });
  }, []);

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

  /** The fastest route plus up to two alternatives, for the preview card. */
  const fetchChoices = useCallback(async (origin: LatLng, dest: LatLng, prof: RoutingProfile) => {
    const result = await fetchRoute({
      profile: prof,
      points: [origin, dest],
      instructions: true,
      alternatives: true,
    });
    if (result.paths.length === 0) throw new Error('no route found');
    return sortRouteChoices(result.paths);
  }, []);

  /** Drop every trace of an offered-but-unstarted preview. */
  const clearPreview = useCallback(() => {
    previewSeq.current++;
    setPreviewPaths(null);
    setPreviewIndex(0);
    setPreviewLoading(false);
    setPreviewError(null);
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
      clearPreview();
      enrichAbort.current?.abort();
      enrichAbort.current = null;
      sessionRef.current = null;
      destRef.current = null;
      originRef.current = null;
      rerouteInFlight.current = false;
      rerouteBackoffUntil.current = 0;
      rerouteFailCount.current = 0;
      setRerouteFailed(false);
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
    [clearWatch, clearPreview],
  );

  /**
   * "I've arrived" — the driver's own escape hatch, for when neither automatic
   * rule can fire. Ends the trip exactly as a detected arrival does (summary,
   * spoken confirmation, `arrived` phase) rather than as a cancellation, which
   * is the difference the button exists to express.
   */
  const arriveNow = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const next = session.declareArrived();
    if (next) {
      setState(next);
      lastStateRef.current = next;
    }
    speak(session.arrivalText());
    setTripSummary({
      distanceM: traveledBaseRef.current + (next?.traveledM ?? 0),
      durationMs: tripStartRef.current !== null ? Date.now() - tripStartRef.current : 0,
    });
    stop(true);
  }, [speak, stop]);

  const reroute = useCallback(
    async (from: Position) => {
      if (rerouteInFlight.current || !destRef.current) return;
      // A failed reroute must not retry on every 1 Hz off-route fix — back off
      // exponentially so an unreachable routing server isn't hammered.
      if (Date.now() < rerouteBackoffUntil.current) return;
      rerouteInFlight.current = true;
      setPhase('rerouting');
      try {
        // Pass the travel direction (only meaningful when moving) so the new
        // route continues the way the car points instead of via a U-turn.
        const heading =
          typeof from.speedMps === 'number' && from.speedMps >= 2 ? from.headingDeg : undefined;
        const path = await fetchPath(from, destRef.current, profileRef.current, heading);
        // End (or arrival) may have fired during the fetch — stop() clears the
        // in-flight flag and destination. Applying now would resurrect a dead
        // nav UI with a fresh session, so bail out.
        if (!rerouteInFlight.current || !destRef.current) return;
        // The old session dies here — bank its driven distance for the summary.
        traveledBaseRef.current += lastStateRef.current?.traveledM ?? 0;
        // Rerouting happens mid-drive: never regress to the pre-departure
        // framing (calm camera / no snap-lock) the fresh session starts in.
        const previousSession = sessionRef.current;
        const nextSession = new NavigationSession(
          path,
          navOptionsForProfile(profileRef.current, {
            startDeparted: lastStateRef.current?.departed ?? true,
          }),
        );
        if (previousSession) nextSession.inheritPaceFrom(previousSession);
        sessionRef.current = nextSession;
        enrich(sessionRef.current, path);
        setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
        setActivePath(path);
        rerouteFailCount.current = 0;
        rerouteBackoffUntil.current = 0;
        setRerouteFailed(false);
        // "Which way now?" is most urgent right after recalculating.
        const depart = sessionRef.current.departurePrompt();
        if (depart) speak(depart.text);
      } catch {
        // Keep the old session (the driver continues on the drawn line) and
        // back off before the next attempt: 5 s, 10 s, 20 s … capped at 60 s.
        rerouteFailCount.current++;
        rerouteBackoffUntil.current =
          Date.now() + Math.min(60_000, 5_000 * 2 ** (rerouteFailCount.current - 1));
        setRerouteFailed(true);
      } finally {
        rerouteInFlight.current = false;
        // Only resume the navigating UI if the trip is still alive; a race with
        // End/arrival leaves the session null and must not flip us back.
        if (sessionRef.current) setPhase('navigating');
      }
    },
    [fetchPath, speak, enrich],
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
      // Match the Android handler: a thrown session error must not silently
      // stop the whole watch (one bad fix would freeze the UI otherwise).
      try {
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
        } else {
          // Back on the line: any lingering "can't reroute" notice is stale.
          setRerouteFailed(false);
        }
      } catch (err) {
        console.warn('navigation fix failed', err);
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
        originFixRef.current = cur;

        destRef.current = dest;
        originRef.current = origin;
        profileRef.current = prof;
        setProfile(prof);
        setDestination(dest);
        setSpeedMps(null);
        setState(null);
        setTripSummary(null);
        setRouteCoords([]);
        setActivePath(null);
        setPreviewError(null);
        lastStateRef.current = null;
        traveledBaseRef.current = 0;

        // Route choices: the fastest plus up to two alternatives, offered
        // before guidance starts. Selecting nothing keeps the fastest.
        const paths = await fetchChoices(origin, dest, prof);
        previewSeq.current++;
        setPreviewPaths(paths);
        setPreviewIndex(0);
        setPhase('preview');
      } catch (err) {
        clearWatch();
        sessionRef.current = null;
        destRef.current = null;
        originRef.current = null;
        setDestination(null);
        setError(err instanceof RoutingError || err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    },
    [fetchChoices, clearWatch],
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
          const paths = await fetchChoices(origin, dest, prof);
          if (seq !== previewSeq.current) return;
          profileRef.current = prof;
          setProfile(prof);
          setPreviewPaths(paths);
          setPreviewIndex(0);
        } catch (err) {
          if (seq !== previewSeq.current) return;
          setPreviewError(err instanceof Error ? err.message : String(err));
        } finally {
          if (seq === previewSeq.current) setPreviewLoading(false);
        }
      })();
    },
    [fetchChoices],
  );

  const go = useCallback(async () => {
    const previewPath = previewPaths?.[previewIndex];
    if (!previewPath) return;
    const seq = ++previewSeq.current;
    setPreviewLoading(true);

    let path = previewPath;
    let freshFix: GeolocationPosition | null = null;
    const dest = destRef.current;
    if (dest) {
      try {
        freshFix = await currentPosition(8_000);
        const origin = { lat: freshFix.coords.latitude, lng: freshFix.coords.longitude };
        const choices = await fetchChoices(origin, dest, profileRef.current);
        path = choices[previewIndex] ?? choices[0] ?? previewPath;
        originRef.current = origin;
        originFixRef.current = freshFix;
      } catch {
        // Starting on the previewed path is still better than refusing to
        // navigate when the Start-time refresh is briefly unavailable.
      }
    }

    // Cancel/profile-switch while the refresh was in flight invalidates it.
    if (seq !== previewSeq.current || !destRef.current) return;
    const session = new NavigationSession(path, navOptionsForProfile(profileRef.current));
    sessionRef.current = session;
    enrich(session, path);
    tripStartRef.current = Date.now();
    traveledBaseRef.current = 0;
    lastStateRef.current = null;
    setTripSummary(null);
    setState(null);
    setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
    setActivePath(path);
    clearPreview();

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
    // Show a state at once rather than waiting for the watch's first fix, but
    // only if the preview's fix is still recent — a driver who studied the
    // choices for a minute has moved, and a stale fix would misplace the puck.
    const origin = freshFix ?? originFixRef.current;
    if (origin && Date.now() - origin.timestamp < 30_000) onFix(origin);
  }, [previewPaths, previewIndex, fetchChoices, onFix, clearWatch, clearPreview, speak, enrich]);

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
    rerouteFailed,
    previewPaths,
    previewIndex,
    previewLoading,
    previewError,
    error,
    start,
    selectPreview: setPreviewIndex,
    setProfile: setNavProfile,
    go,
    toggleMute,
    setMuted,
    arriveNow,
    stop: () => stop(false),
  };
}
