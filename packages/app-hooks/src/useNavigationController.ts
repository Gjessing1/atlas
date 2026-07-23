/**
 * Turn-by-turn navigation, shared by web and Android.
 *
 * Both apps drive the same `NavigationSession` the same way — two-step start
 * (preview the choices, then go), speak the prompts, re-route when the
 * traveller leaves the line, bank distance across re-routes for the arrival
 * card — and differ only in *where* a fix, a voice and a wake lock come from.
 * So the trip logic lives here and the platform is a seam.
 *
 * Everything the seam hides is genuinely platform-shaped: the browser's
 * geolocation watch versus an Android foreground service, Web Speech versus
 * expo-speech with audio ducking, a wake lock that the tab loses on hide
 * versus expo-keep-awake, and a gyro that only Android has.
 */

import type { LatLng } from '@atlas/core';
import {
  FacingBlender,
  navOptionsForProfile,
  NavigationSession,
  type NavState,
  type Position,
} from '@atlas/navigation';
import {
  enrichRoute,
  sortRouteChoices,
  type RoutePreferences,
  type RoutePath,
  type RouteProvider,
  type RoutingProfile,
  type ValhallaTransport,
} from '@atlas/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

export type NavPhase =
  'idle' | 'starting' | 'preview' | 'navigating' | 'rerouting' | 'arrived' | 'error';

/** What the arrival card shows once the trip is over. */
export interface NavTripSummary {
  distanceM: number;
  durationMs: number;
}

/** A one-off fix, with the wall-clock time it was *measured* (not received). */
export interface NavOriginFix {
  fix: Position;
  atMs: number;
}

/** Everything a navigation controller needs from the device it runs on. */
export interface NavPlatform {
  /** Where routes come from — server on web, offline-first pack engine on Android. */
  provider: RouteProvider;
  /**
   * Transport for `trace_attributes` (speed limits, tunnels). Optional: a
   * platform with no way to ask simply shows no roundel.
   */
  trace?: ValhallaTransport;
  /**
   * One fix now, for the preview origin. Should reject with a
   * user-presentable message — it becomes the error phase's text — and must
   * not outlive `timeoutMs` by much, or the phase wedges in `starting`.
   */
  currentFix(timeoutMs: number): Promise<NavOriginFix>;
  /**
   * Start continuous fixes for a trip; resolves with the teardown. Async
   * because Android's foreground service is, and a failure to start it is a
   * real error rather than a silent no-fix trip.
   */
  watchFixes(onFix: (fix: Position) => void): Promise<() => void>;
  /** Speak a prompt. Muting is handled here, so this is called only when audible. */
  speak(text: string): void;
  /** Cut off anything queued or playing (on mute, and at the end of a trip). */
  stopSpeaking(): void;
  /** Hold the screen awake for the trip; returns the release. */
  keepAwake?(): () => void;
  /**
   * Report yaw *change* in degrees (with the interval it covers) while dead
   * reckoning, so the session can notice a turn taken inside a tunnel.
   * Subscribed only during GPS gaps — the follow camera subscribes to the same
   * source separately, for the whole trip.
   */
  watchHeadingRate?(onDelta: (deltaDeg: number, dtSec: number) => void): () => void;
  /**
   * Report absolute device orientation (compass heading, deg from true north,
   * plus the sensor's declared ± accuracy where it has one) — which way the
   * *traveller faces*, as opposed to where the route goes. Subscribed only for
   * walking modes: a pedestrian standing at a junction has no GPS course and
   * the route tangent points down a path they may not have chosen, so the
   * compass is the only signal that answers "which way do I start walking?".
   * Optional because a desktop browser genuinely has no compass — the puck
   * then keeps the route-tangent fallback rather than pretending.
   */
  watchFacing?(onFacing: (deg: number, accuracyDeg: number | null) => void): () => void;
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
  /** Latest GPS altitude in metres, or null when the platform has none. */
  altitudeM: number | null;
  /**
   * Which way the traveller faces (deg from north), from the device compass —
   * only while a walking mode is navigating at walking speed on a platform
   * with a compass; null otherwise. The *puck* reads this; the camera keeps
   * `state.courseDeg`, so the map does not spin with every turn of the head.
   */
  facingDeg: number | null;
  /** Sensor-declared ± accuracy of `facingDeg` — widens the uncertainty cone. */
  facingAccuracyDeg: number | null;
  /**
   * True while the session is off-route but this mode leaves rerouting to the
   * traveller (walking modes): the UI shows "Off route — reroute?" instead of
   * a silently recalculated line. `rerouteNow` accepts the offer.
   */
  rerouteOffered: boolean;
  /** Whether voice prompts are muted. */
  muted: boolean;
  /** Distance/time of the finished trip (arrived phase only), else null. */
  tripSummary: NavTripSummary | null;
  /** True while off-route but the reroute keeps failing (routing unreachable). */
  rerouteFailed: boolean;
  error: string | null;
  /** Look up route choices to a destination and enter the preview phase. */
  start: (
    destination: LatLng,
    profile?: RoutingProfile,
    preferences?: Partial<RoutePreferences>,
  ) => Promise<void>;
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
  /** Accept an offered reroute (walking modes' off-route banner). */
  rerouteNow: () => void;
  stop: () => void;
}

/** How long to wait for the fix that a preview is built from. */
const START_FIX_TIMEOUT_MS = 20_000;
/** Shorter at Start: the previewed path is a perfectly good fallback. */
const GO_FIX_TIMEOUT_MS = 8_000;
/** Beyond this age the preview's fix no longer describes where the traveller is. */
const ORIGIN_FRESH_MS = 30_000;

/**
 * Read a value in a callback without rebuilding the callback when the value's
 * identity changes — the platform object is rebuilt whenever its own inputs
 * (a server origin) change, and every callback below would otherwise churn.
 */
function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function useNavigationController(platform: NavPlatform): NavController {
  const platformRef = useLatest(platform);

  const [phase, setPhase] = useState<NavPhase>('idle');
  const [state, setState] = useState<NavState | null>(null);
  const [routeCoords, setRouteCoords] = useState<number[][]>([]);
  const [activePath, setActivePath] = useState<RoutePath | null>(null);
  const [profile, setProfileState] = useState<RoutingProfile>('car');
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [previewPaths, setPreviewPaths] = useState<RoutePath[] | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [altitudeM, setAltitudeM] = useState<number | null>(null);
  const [facing, setFacing] = useState<{ deg: number; accuracyDeg: number | null } | null>(null);
  const [muted, setMutedState] = useState(false);
  const [tripSummary, setTripSummary] = useState<NavTripSummary | null>(null);
  const [rerouteFailed, setRerouteFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<NavigationSession | null>(null);
  const destRef = useRef<LatLng | null>(null);
  /** The fix the preview was built from: refetch origin, and the seed for Start. */
  const originRef = useRef<NavOriginFix | null>(null);
  /** Guards preview fetches: a late response for an abandoned one is dropped. */
  const previewSeq = useRef(0);
  /**
   * Bumped whenever the trip identity changes (Start, End, arrival). An async
   * reroute captures it and touches nothing once it no longer matches — the
   * one race a merged controller lets us fix in a single place, since either
   * app could otherwise have an old reroute flip a fresh preview into
   * `navigating` as it lands.
   */
  const tripSeq = useRef(0);
  /** Prevents a quick double tap from starting two location/route requests. */
  const startInFlight = useRef(false);
  const profileRef = useRef<RoutingProfile>('car');
  /** Planner preferences survive preview refreshes and every mid-trip reroute. */
  const preferencesRef = useRef<Partial<RoutePreferences> | undefined>(undefined);
  const rerouteInFlight = useRef(false);
  /** Earliest time (epoch ms) a failed reroute may be retried (backoff). */
  const rerouteBackoffUntil = useRef(0);
  /** Consecutive reroute failures, driving the backoff exponent. */
  const rerouteFailCount = useRef(0);
  // Read inside the fix handler (which closes over a stale `muted`), so keep a ref.
  const mutedRef = useRef(false);
  /** When guidance began, for the arrival card's elapsed time. */
  const tripStartRef = useRef<number | null>(null);
  /** Distance driven across reroutes (each reroute starts a fresh session). */
  const traveledBaseRef = useRef(0);
  /** Latest NavState, readable from callbacks without a stale closure. */
  const lastStateRef = useRef<NavState | null>(null);
  /** Latest raw fix — the origin an accepted reroute offer recalculates from. */
  const lastFixRef = useRef<Position | null>(null);
  /** One spoken "off route" per episode in offer mode, not one per fix. */
  const offRouteSpokenRef = useRef(false);
  /** Compass-vs-course blending for the walking puck (speed hysteresis). */
  const facingBlender = useRef(new FacingBlender());
  /** Cancels an in-flight route-enrichment fetch (End, or a superseding reroute). */
  const enrichAbort = useRef<AbortController | null>(null);
  /** Teardown for the active fix watch, if any. */
  const watchStopRef = useRef<(() => void) | null>(null);
  // The preview selection is read inside `go`, which must stay identity-stable.
  const previewPathsRef = useLatest(previewPaths);
  const previewIndexRef = useLatest(previewIndex);

  /** Speak a voice prompt, unless muted; never let a TTS error interrupt nav. */
  const speak = useCallback(
    (text: string): void => {
      if (mutedRef.current) return;
      try {
        platformRef.current.speak(text);
      } catch (err) {
        console.warn('tts failed', err);
      }
    },
    [platformRef],
  );

  const setMuted = useCallback(
    (next: boolean) => {
      mutedRef.current = next;
      if (next) platformRef.current.stopSpeaking();
      setMutedState(next);
    },
    [platformRef],
  );

  const toggleMute = useCallback(() => setMuted(!mutedRef.current), [setMuted]);

  const stopWatch = useCallback(() => {
    watchStopRef.current?.();
    watchStopRef.current = null;
  }, []);

  const fetchPath = useCallback(
    async (
      origin: LatLng,
      dest: LatLng,
      prof: RoutingProfile,
      preferences?: Partial<RoutePreferences>,
      headingDeg?: number,
    ): Promise<RoutePath> => {
      const result = await platformRef.current.provider.route({
        profile: prof,
        points: [origin, dest],
        instructions: true,
        ...(preferences ? { preferences } : {}),
        ...(typeof headingDeg === 'number' ? { headingDeg } : {}),
      });
      const path = result.paths[0];
      if (!path) throw new Error('no route found');
      return path;
    },
    [platformRef],
  );

  /** The fastest route plus up to two alternatives, for the preview card. */
  const fetchChoices = useCallback(
    async (
      origin: LatLng,
      dest: LatLng,
      prof: RoutingProfile,
      preferences?: Partial<RoutePreferences>,
    ): Promise<RoutePath[]> => {
      const result = await platformRef.current.provider.route({
        profile: prof,
        points: [origin, dest],
        instructions: true,
        alternatives: true,
        ...(preferences ? { preferences } : {}),
      });
      if (result.paths.length === 0) throw new Error('no route found');
      return sortRouteChoices(result.paths);
    },
    [platformRef],
  );

  /**
   * Fetch road attributes (speed limits, tunnels) for a route and hand them to
   * its session. Fire-and-forget by design: guidance never waits on this, and
   * a failure — offline, or no transport on this platform — only costs the
   * roundel.
   */
  const enrich = useCallback(
    (session: NavigationSession, path: RoutePath): void => {
      enrichAbort.current?.abort();
      enrichAbort.current = null;
      const trace = platformRef.current.trace;
      if (!trace) return;
      const controller = new AbortController();
      enrichAbort.current = controller;
      void enrichRoute(path, profileRef.current, trace, { signal: controller.signal })
        .then((enrichment) => {
          // A reroute (or End) may have replaced this session mid-request;
          // attributes measured along the old line would mislabel the new one,
          // where the same distances mean different roads.
          if (sessionRef.current !== session) return;
          const refreshed = session.setEnrichment(enrichment);
          if (refreshed) {
            setState(refreshed);
            lastStateRef.current = refreshed;
          }
        })
        .catch(() => {
          // Optional by design: offline, or the server is unreachable.
        });
    },
    [platformRef],
  );

  /** Drop every trace of an offered-but-unstarted preview. */
  const clearPreview = useCallback(() => {
    previewSeq.current++;
    setPreviewPaths(null);
    setPreviewIndex(0);
    setPreviewLoading(false);
    setPreviewError(null);
  }, []);

  const stop = useCallback(
    (arrived = false) => {
      tripSeq.current++;
      stopWatch();
      clearPreview();
      enrichAbort.current?.abort();
      enrichAbort.current = null;
      sessionRef.current = null;
      destRef.current = null;
      originRef.current = null;
      preferencesRef.current = undefined;
      startInFlight.current = false;
      rerouteInFlight.current = false;
      rerouteBackoffUntil.current = 0;
      rerouteFailCount.current = 0;
      setRerouteFailed(false);
      setRouteCoords([]);
      setActivePath(null);
      setSpeedMps(null);
      setAltitudeM(null);
      setFacing(null);
      facingBlender.current.reset();
      lastFixRef.current = null;
      offRouteSpokenRef.current = false;
      if (!arrived) {
        setState(null);
        setDestination(null);
        setTripSummary(null);
      }
      tripStartRef.current = null;
      traveledBaseRef.current = 0;
      setPhase(arrived ? 'arrived' : 'idle');
    },
    [stopWatch, clearPreview],
  );

  /** Abandon a trip that could not be set up, keeping the reason on screen. */
  const fail = useCallback(
    (err: unknown) => {
      stopWatch();
      clearPreview();
      sessionRef.current = null;
      destRef.current = null;
      originRef.current = null;
      preferencesRef.current = undefined;
      setDestination(null);
      setError(message(err));
      setPhase('error');
    },
    [stopWatch, clearPreview],
  );

  /** End the trip with an arrival: summary, spoken confirmation, `arrived`. */
  const finishArrived = useCallback(
    (session: NavigationSession, traveledM: number) => {
      speak(session.arrivalText());
      setTripSummary({
        distanceM: traveledBaseRef.current + traveledM,
        durationMs: tripStartRef.current !== null ? Date.now() - tripStartRef.current : 0,
      });
      stop(true);
    },
    [speak, stop],
  );

  /**
   * "I've arrived" — the traveller's own escape hatch, for when neither
   * automatic rule can fire. Ends the trip exactly as a detected arrival does
   * rather than as a cancellation, which is the difference the button exists
   * to express.
   */
  const arriveNow = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const next = session.declareArrived();
    if (next) {
      setState(next);
      lastStateRef.current = next;
    }
    finishArrived(session, next?.traveledM ?? 0);
  }, [finishArrived]);

  const reroute = useCallback(
    async (from: Position) => {
      if (rerouteInFlight.current || !destRef.current) return;
      // A failed reroute must not retry on every 1 Hz off-route fix — back off
      // exponentially so an unreachable routing server isn't hammered.
      if (Date.now() < rerouteBackoffUntil.current) return;
      const trip = tripSeq.current;
      rerouteInFlight.current = true;
      setPhase('rerouting');
      try {
        // Pass the travel direction (only meaningful when moving) so the new
        // route continues the way the traveller points, not via a U-turn.
        const heading =
          typeof from.speedMps === 'number' && from.speedMps >= 2 ? from.headingDeg : undefined;
        const path = await fetchPath(
          from,
          destRef.current,
          profileRef.current,
          preferencesRef.current,
          heading,
        );
        // End, arrival or a whole new trip may have happened during the fetch;
        // applying now would resurrect a dead nav UI with a fresh session.
        if (trip !== tripSeq.current || !destRef.current) return;
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
        setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
        setActivePath(path);
        rerouteFailCount.current = 0;
        rerouteBackoffUntil.current = 0;
        setRerouteFailed(false);
        enrich(nextSession, path);
        // Seed the new session with the fix that triggered the reroute, so
        // the shown state (and an off-route offer banner) flips to the new
        // line now rather than at the next fix. Its prompts are discarded —
        // the departure prompt below already answers "which way now?".
        try {
          const seeded = nextSession.update(from, Date.now());
          setState(seeded.state);
          lastStateRef.current = seeded.state;
        } catch {
          // The next live fix populates the state instead.
        }
        // "Which way now?" is most urgent right after recalculating.
        const depart = nextSession.departurePrompt();
        if (depart) speak(depart.text);
      } catch {
        if (trip !== tripSeq.current) return;
        // Keep the old session (the traveller continues on the drawn line) and
        // back off before the next attempt: 5 s, 10 s, 20 s … capped at 60 s.
        rerouteFailCount.current++;
        rerouteBackoffUntil.current =
          Date.now() + Math.min(60_000, 5_000 * 2 ** (rerouteFailCount.current - 1));
        setRerouteFailed(true);
      } finally {
        // Only the reroute that still belongs to the live trip may clear the
        // flag or restore the phase: a superseded one would otherwise let a
        // second reroute in, or flip a fresh preview to `navigating`.
        if (trip === tripSeq.current) {
          rerouteInFlight.current = false;
          if (sessionRef.current) setPhase('navigating');
        }
      }
    },
    [fetchPath, speak, enrich],
  );

  /** Accept an offered reroute: recalculate from the last known fix. */
  const rerouteNow = useCallback(() => {
    const fix = lastFixRef.current;
    if (!fix || !sessionRef.current) return;
    // The tap is explicit consent — don't let a backoff from an earlier
    // failed automatic attempt swallow it.
    rerouteBackoffUntil.current = 0;
    void reroute(fix);
  }, [reroute]);

  const onFix = useCallback(
    (fix: Position) => {
      const session = sessionRef.current;
      if (!session) return;
      lastFixRef.current = fix;
      setSpeedMps(typeof fix.speedMps === 'number' && fix.speedMps >= 0 ? fix.speedMps : null);
      setAltitudeM(
        typeof fix.altitudeM === 'number' && Number.isFinite(fix.altitudeM) ? fix.altitudeM : null,
      );
      // Runs on every GPS fix (incl. Android's headless background task); an
      // uncaught throw here would take the whole app down in a release build.
      try {
        const { state: next, prompts } = session.update(fix, Date.now());
        setState(next);
        lastStateRef.current = next;
        for (const prompt of prompts) speak(prompt.text);
        if (next.status === 'arrived') {
          finishArrived(session, next.traveledM);
        } else if (next.status === 'off-route') {
          // Driving modes recalculate silently — a driver who left the
          // corridor has missed a turn and has no hands free. Walking modes
          // *offer* instead (`rerouteOffered` in the returned controller):
          // the walker who leaves the path is usually doing it on purpose,
          // and on a mountain the honest answer may be "back to the trail",
          // not a new line. One spoken notice per episode, so eyes can stay
          // off the screen without the banner going unnoticed.
          if (navOptionsForProfile(profileRef.current).autoReroute ?? true) {
            void reroute(fix);
          } else if (!offRouteSpokenRef.current) {
            offRouteSpokenRef.current = true;
            speak('You are off the route');
          }
        } else {
          // Back on the line: any lingering "can't reroute" notice is stale.
          setRerouteFailed(false);
          offRouteSpokenRef.current = false;
        }
      } catch (err) {
        console.warn('navigation fix failed', err);
      }
    },
    [reroute, speak, finishArrived],
  );

  const start = useCallback(
    async (dest: LatLng, prof: RoutingProfile = 'car', preferences?: Partial<RoutePreferences>) => {
      if (startInFlight.current) return;
      startInFlight.current = true;
      const seq = ++previewSeq.current;
      setError(null);
      setPhase('starting');
      try {
        const origin = await platformRef.current.currentFix(START_FIX_TIMEOUT_MS);
        if (seq !== previewSeq.current) return;

        destRef.current = dest;
        originRef.current = origin;
        profileRef.current = prof;
        preferencesRef.current = preferences;
        setProfileState(prof);
        setDestination(dest);
        setSpeedMps(null);
        setAltitudeM(null);
        setState(null);
        setTripSummary(null);
        setRouteCoords([]);
        setActivePath(null);
        setPreviewError(null);
        lastStateRef.current = null;
        traveledBaseRef.current = 0;

        // Route choices: the fastest plus up to two alternatives, offered
        // before guidance starts. Selecting nothing keeps the fastest.
        const paths = await fetchChoices(origin.fix, dest, prof, preferences);
        if (seq !== previewSeq.current) return;
        setPreviewPaths(paths);
        setPreviewIndex(0);
        setPhase('preview');
      } catch (err) {
        if (seq !== previewSeq.current) return;
        fail(err);
      } finally {
        if (seq === previewSeq.current) startInFlight.current = false;
      }
    },
    [platformRef, fetchChoices, fail],
  );

  // Profile switch on the preview card: refetch the choices for the same trip.
  // On failure the previous profile's choices stay up (with a note) — a dead
  // end here (no bike route, brief offline) must not kill the whole preview.
  const setProfile = useCallback(
    (prof: RoutingProfile) => {
      const origin = originRef.current;
      const dest = destRef.current;
      if (!origin || !dest || prof === profileRef.current) return;
      const seq = ++previewSeq.current;
      setPreviewLoading(true);
      setPreviewError(null);
      void (async () => {
        try {
          const paths = await fetchChoices(origin.fix, dest, prof);
          if (seq !== previewSeq.current) return;
          profileRef.current = prof;
          preferencesRef.current = undefined;
          setProfileState(prof);
          setPreviewPaths(paths);
          setPreviewIndex(0);
        } catch (err) {
          if (seq !== previewSeq.current) return;
          setPreviewError(message(err));
        } finally {
          if (seq === previewSeq.current) setPreviewLoading(false);
        }
      })();
    },
    [fetchChoices],
  );

  const go = useCallback(async () => {
    const index = previewIndexRef.current;
    const previewPath = previewPathsRef.current?.[index];
    if (!previewPath) return;
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    try {
      let path = previewPath;
      let origin = originRef.current;
      const dest = destRef.current;
      if (dest) {
        // The traveller may have moved while studying the choices, so refresh
        // both the fix and the routes from it. Best-effort: starting on the
        // previewed path beats refusing to navigate because a Start-time
        // refresh was briefly unavailable.
        try {
          const fresh = await platformRef.current.currentFix(GO_FIX_TIMEOUT_MS);
          const choices = await fetchChoices(
            fresh.fix,
            dest,
            profileRef.current,
            preferencesRef.current,
          );
          if (seq !== previewSeq.current) return;
          path = choices[index] ?? choices[0] ?? previewPath;
          origin = fresh;
          originRef.current = fresh;
        } catch {
          // Keep the previewed path and its origin fix.
        }
      }

      // Cancel or profile switch while the refresh was in flight invalidates it.
      if (seq !== previewSeq.current || !destRef.current) return;
      tripSeq.current++;
      const session = new NavigationSession(path, navOptionsForProfile(profileRef.current));
      sessionRef.current = session;
      offRouteSpokenRef.current = false;
      enrich(session, path);
      tripStartRef.current = Date.now();
      traveledBaseRef.current = 0;
      lastStateRef.current = null;
      setTripSummary(null);
      setState(null);
      setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
      setActivePath(path);
      clearPreview();

      stopWatch();
      const stopFixes = await platformRef.current.watchFixes(onFix);
      // End (or another trip) while the watch was starting: don't leave one live.
      if (sessionRef.current !== session) {
        stopFixes();
        return;
      }
      watchStopRef.current = stopFixes;
      setPhase('navigating');
      // Guidance used to be silent until the first approach threshold —
      // exactly when the traveller wonders "which way?".
      const depart = session.departurePrompt();
      if (depart) speak(depart.text);
      // Show a state at once rather than waiting for the watch's first fix,
      // but only if the origin fix is still recent — someone who studied the
      // choices for a minute has moved, and a stale fix misplaces the puck.
      if (origin && Date.now() - origin.atMs < ORIGIN_FRESH_MS) onFix(origin.fix);
    } catch (err) {
      fail(err);
    } finally {
      // A no-op on the happy path (clearPreview already bumped the sequence);
      // this only rescues the early returns above from a stuck spinner.
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  }, [
    platformRef,
    previewPathsRef,
    previewIndexRef,
    fetchChoices,
    enrich,
    clearPreview,
    stopWatch,
    onFix,
    speak,
    fail,
  ]);

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

  // While dead reckoning, feed device yaw into the session so it can notice a
  // turn off the assumed line — an in-tunnel fork or roundabout exit that
  // cross-track cannot see without GPS. Subscribed only during gaps: while
  // fixes flow the session ignores the reports anyway.
  const reckoning = guiding && state?.fix === 'estimated';
  useEffect(() => {
    if (!reckoning) return;
    return platformRef.current.watchHeadingRate?.((deltaDeg) => {
      sessionRef.current?.reportHeadingDelta(deltaDeg);
    });
  }, [reckoning, platformRef]);

  // Which way the walker faces, from the device compass. Subscribed only for
  // walking modes during guidance: in a car the magnetometer is junk (steel
  // body, cradle magnet) and the course machinery is right; on foot it is the
  // only signal that works standing still. The blender applies the speed
  // hysteresis (compass while walking, GPS course when moving fast enough for
  // it to be trustworthy) and drops readings the sensor itself flags as bad —
  // Google's degrade-to-a-dot behaviour, minus the figure-8 nag.
  const walkingProfile = profile === 'foot' || profile === 'hike';
  const speedRef = useLatest(speedMps);
  useEffect(() => {
    if (!guiding || !walkingProfile) return;
    const watch = platformRef.current.watchFacing;
    if (!watch) return;
    const blender = facingBlender.current;
    blender.reset();
    let lastSetMs = 0;
    let lastSetDeg: number | null = null;
    const unsubscribe = watch((deg, accuracyDeg) => {
      const now = Date.now();
      blender.updateCompass(deg, accuracyDeg, now);
      const sample = blender.current(speedRef.current, now);
      if (!sample) {
        if (lastSetDeg !== null) {
          lastSetDeg = null;
          setFacing(null);
        }
        return;
      }
      // Compass events arrive at sensor rate; re-render at most ~5 Hz and
      // only for a visible change, or the puck costs more than it shows.
      const delta =
        lastSetDeg === null ? 180 : Math.abs(((sample.deg - lastSetDeg + 540) % 360) - 180);
      if (now - lastSetMs < 200 || delta < 2) return;
      lastSetMs = now;
      lastSetDeg = sample.deg;
      setFacing(sample);
    });
    return () => {
      unsubscribe();
      setFacing(null);
    };
  }, [guiding, walkingProfile, platformRef, speedRef]);

  // Speeding up hands the puck back to the course even between compass events
  // (a cyclist pushing off from a walk would otherwise keep a stale facing).
  useEffect(() => {
    if (facing && facingBlender.current.current(speedMps, Date.now()) === null) setFacing(null);
  }, [speedMps, facing]);

  // A navigating device is a dashboard: keep the screen on for the whole trip.
  useEffect(() => {
    if (!guiding) return;
    return platformRef.current.keepAwake?.();
  }, [guiding, platformRef]);

  // Drop the fix watch if the app unmounts mid-trip.
  useEffect(() => stopWatch, [stopWatch]);

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
    altitudeM,
    facingDeg: facing?.deg ?? null,
    facingAccuracyDeg: facing?.accuracyDeg ?? null,
    rerouteOffered:
      phase === 'navigating' &&
      state?.status === 'off-route' &&
      !(navOptionsForProfile(profile).autoReroute ?? true),
    muted,
    tripSummary,
    rerouteFailed,
    error,
    start,
    selectPreview: setPreviewIndex,
    setProfile,
    go,
    toggleMute,
    setMuted,
    arriveNow,
    rerouteNow,
    stop: useCallback(() => stop(false), [stop]),
  };
}
