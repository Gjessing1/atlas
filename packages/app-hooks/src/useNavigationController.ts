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
  DEFAULT_FACING_BLEND,
  FacingBlender,
  navOptionsForProfile,
  NavigationSession,
  type HeadingSource,
  type NavState,
  type Position,
} from '@atlas/navigation';
import {
  applyNvdbSpeedLimits,
  enrichRoute,
  sortRouteChoices,
  viaInsertIndex,
  type NvdbCameraTransport,
  type NvdbLimitTransport,
  type RoutePreferences,
  type RoutePath,
  type RouteProvider,
  type RoutingProfile,
  type ValhallaTransport,
} from '@atlas/routing';
import {
  applyTrafficDelay,
  type TrafficClosureTransport,
  type TrafficDelayTransport,
} from '@atlas/traffic';
import { useCallback, useEffect, useRef, useState } from 'react';

export type NavPhase =
  | 'idle'
  | 'starting'
  | 'preview'
  | 'exploring'
  | 'navigating'
  | 'rerouting'
  | 'paused'
  | 'arrived'
  | 'error';

/** Whether the location watch is following a route or simply following the traveller. */
export type NavActivity = 'guidance' | 'explorer' | null;

/** What the arrival card shows once the trip is over. */
export interface NavTripSummary {
  distanceM: number;
  durationMs: number;
  /** The route engine's estimate when Start was pressed, before any reroutes. */
  originalEstimateMs: number;
}

/** Session totals persisted with an interrupted trip so its final summary remains whole. */
export interface NavTripProgress {
  distanceM: number;
  elapsedMs: number;
  originalEstimateMs: number;
}

/** A one-off fix, with the wall-clock time it was *measured* (not received). */
export interface NavOriginFix {
  fix: Position;
  atMs: number;
}

/** A better route the periodic watch found, offered rather than imposed. */
export interface NavFasterRoute {
  /** Time it saves over the engine's own estimate for the current route. */
  savesMs: number;
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
   * Authoritative Norwegian speed limits (NVDB) for a route's distance ranges,
   * layered over `trace`'s tile limits inside Norway (ROADMAP §2.1). Optional
   * and best-effort: absent, unreachable, or an empty result all just leave the
   * tile limits standing, so it can never cost a roundel that `trace` produced.
   */
  nvdbLimits?: NvdbLimitTransport;
  /**
   * ATK speed cameras (points + average-speed sections) matched onto a route
   * (ROADMAP §2.1). Same contract as `nvdbLimits`: optional and best-effort —
   * absent, unreachable, or empty simply means no camera guidance, exactly
   * the pre-camera behaviour and the everywhere-outside-Norway behaviour.
   */
  nvdbCameras?: NvdbCameraTransport;
  /** Live route-matched DATEX closures, for proactive mid-drive rerouting. */
  trafficClosures?: TrafficClosureTransport;
  /**
   * Live corridor travel times matched onto a route, for re-pricing the trip
   * being driven (§2.2). Optional and best-effort in exactly the way the other
   * traffic seam is: without it the trip keeps the schedule it departed with,
   * which is the pre-v0.136.0 behaviour and the behaviour everywhere the feed
   * has nothing to say.
   */
  trafficDelay?: TrafficDelayTransport;
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
  watchFixes(
    onFix: (fix: Position, measuredAtMs?: number) => void,
    activity?: Exclude<NavActivity, null>,
  ): Promise<() => void>;
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
  /**
   * Ask for access to device orientation from a user gesture when the platform
   * requires it (iOS Safari). A denial is an honest no-compass fallback, not a
   * navigation failure.
   */
  prepareFacing?(): Promise<void>;
}

export interface NavController {
  phase: NavPhase;
  /** The kind of live-location session, retained on its error card until End. */
  activity: NavActivity;
  state: NavState | null;
  /** Latest raw GPS fix. Explorer mode follows this without manufacturing a route. */
  position: Position | null;
  /** Active route geometry as [lng, lat] pairs, for the map line source. */
  routeCoords: number[][];
  /** The route being followed (instructions included, for on-map turn arrows). */
  activePath: RoutePath | null;
  profile: RoutingProfile;
  /**
   * The planner's routing choices this trip was built with (avoid tolls,
   * ferries …), or null when it uses the profile's defaults. Exposed so a trip
   * can be recorded and restarted exactly as planned — a resumed drive that
   * quietly dropped "avoid tolls" would be a different drive.
   */
  preferences: Partial<RoutePreferences> | null;
  /** Where the trip is headed (for the finish marker); null when idle. */
  destination: LatLng | null;
  /**
   * Intermediate stops the active route runs through, in visiting order —
   * the planner's via points on a multi-stop trip. Stops already passed at
   * the last (re)route are dropped, so for map markers render
   * `viaPoints.slice(state?.viasPassed ?? 0)`. Empty for ordinary trips.
   */
  viaPoints: LatLng[];
  /** The next intermediate stop still owed by this route, or null. */
  nextIntermediateStop: LatLng | null;
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
   * Which way the traveller faces (deg from north): the device compass while
   * standing, crossfading to the stable route course as they pick up walking
   * pace (`FacingBlender`), smoothed so it no longer jitters. Set only while a
   * walking mode navigates on a platform with a compass; null otherwise (the
   * puck then falls back to `state.courseDeg`). The *puck* reads this; the
   * camera keeps `state.courseDeg`, so the map does not spin with the head.
   */
  facingDeg: number | null;
  /** Sensor-declared ± accuracy of `facingDeg` (deg), or null when unknown. */
  facingAccuracyDeg: number | null;
  /** Direction-arrow source selected in Settings. */
  headingSource: HeadingSource;
  setHeadingSource: (source: HeadingSource) => void;
  /** False when the selected source has no trustworthy direction to draw. */
  headingArrowVisible: boolean;
  /** The sensor explicitly reports that a figure-8 calibration is needed. */
  headingCalibrationNeeded: boolean;
  /**
   * True while the session is off-route but this mode leaves rerouting to the
   * traveller (walking modes): the UI shows "Off route — reroute?" instead of
   * a silently recalculated line. `rerouteNow` accepts the offer.
   */
  rerouteOffered: boolean;
  /**
   * A faster route the periodic mid-drive watch has found (driving modes
   * only): the saving is real — engine estimate against engine estimate from
   * the same position — and the offer waits for the driver's word instead of
   * tearing up the line they are following. Null when the current route is
   * (still) the best known.
   */
  fasterRoute: NavFasterRoute | null;
  /** Switch to the offered faster route (keeps the stops still ahead). */
  acceptFasterRoute: () => void;
  /** Decline it; no new offer until one saves meaningfully more than this. */
  dismissFasterRoute: () => void;
  /**
   * Insert a stop into the running trip — a tapped POI or a quick "nearest
   * gas" pick. It slots into the remaining stops by along-route position and
   * guidance recalculates from the last fix; the final destination stays.
   */
  addStop: (stop: LatLng) => void;
  /**
   * Mark the next intermediate stop visited and route onward from the current
   * fix. The final destination and every later stop stay in place.
   */
  continuePastIntermediateStop: () => void;
  /** Whether voice prompts are muted. */
  muted: boolean;
  /** Distance/time of the finished trip (arrived phase only), else null. */
  tripSummary: NavTripSummary | null;
  /** Running totals used by process restoration; null outside an active trip. */
  tripProgress: NavTripProgress | null;
  /** True while off-route but the reroute keeps failing (routing unreachable). */
  rerouteFailed: boolean;
  error: string | null;
  /**
   * Look up route choices to a destination and enter the preview phase.
   * `vias` are stops to visit on the way (the planner's intermediate
   * waypoints); guidance announces each and reroutes only through the ones
   * still ahead.
   */
  start: (
    destination: LatLng,
    profile?: RoutingProfile,
    preferences?: Partial<RoutePreferences>,
    vias?: LatLng[],
  ) => Promise<void>;
  /** Follow the live position without a destination, route, prompts or rerouting. */
  explore: (profile?: RoutingProfile) => Promise<void>;
  /** Pick one of the preview route choices (preview phase only). */
  selectPreview: (index: number) => void;
  /** Switch profile and refetch the preview choices (preview phase only). */
  setProfile: (profile: RoutingProfile) => void;
  /** Begin guidance along the selected preview choice. */
  go: () => Promise<void>;
  /**
   * Pick an interrupted trip back up: route from the current position to the
   * same destination through the stops still ahead, and start guiding — no
   * preview, because the traveller already chose this trip once and is being
   * offered it back after a crash or a process death, not asked to plan it
   * again. The route is fetched fresh for exactly that reason: after a gap the
   * useful line starts from where they are now.
   */
  resume: (
    destination: LatLng,
    profile: RoutingProfile,
    preferences?: Partial<RoutePreferences>,
    vias?: LatLng[],
    progress?: NavTripProgress,
  ) => Promise<void>;
  /** Freeze this trip in place: no fixes, prompts, reroutes, PiP or wake lock. */
  pause: () => void;
  /** Continue the same in-memory route and session from a fresh position fix. */
  continueTrip: () => Promise<void>;
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
/** How often, while driving on-route, to ask whether a faster route exists. */
const FASTER_CHECK_INTERVAL_MS = 180_000;
/** Smallest saving worth interrupting a driver for. */
const FASTER_MIN_SAVING_MS = 120_000;
/** An unaccepted offer expires — the road it branches from recedes behind. */
const FASTER_OFFER_TTL_MS = 120_000;
/** After a dismissal, only an offer this much better may interrupt again. */
const FASTER_REOFFER_STEP_MS = 60_000;

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

/** Profiles where facing the device and direction of travel can diverge. */
const usesFacingHeading = (profile: RoutingProfile): boolean => profile !== 'car';

export function useNavigationController(platform: NavPlatform): NavController {
  const platformRef = useLatest(platform);

  const [phase, setPhase] = useState<NavPhase>('idle');
  const [activity, setActivity] = useState<NavActivity>(null);
  const [state, setState] = useState<NavState | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [routeCoords, setRouteCoords] = useState<number[][]>([]);
  const [activePath, setActivePath] = useState<RoutePath | null>(null);
  const [profile, setProfileState] = useState<RoutingProfile>('car');
  const [preferences, setPreferencesState] = useState<Partial<RoutePreferences> | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [viaPoints, setViaPoints] = useState<LatLng[]>([]);
  const [previewPaths, setPreviewPaths] = useState<RoutePath[] | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [altitudeM, setAltitudeM] = useState<number | null>(null);
  const [facing, setFacing] = useState<{ deg: number; accuracyDeg: number | null } | null>(null);
  const [headingSource, setHeadingSourceState] = useState<HeadingSource>('auto');
  const [headingCalibrationNeeded, setHeadingCalibrationNeeded] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [fasterRoute, setFasterRoute] = useState<NavFasterRoute | null>(null);
  const [tripSummary, setTripSummary] = useState<NavTripSummary | null>(null);
  const [rerouteFailed, setRerouteFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<NavigationSession | null>(null);
  const destRef = useRef<LatLng | null>(null);
  /** Via stops the *current* route still visits; passed ones are dropped on reroute. */
  const viasRef = useRef<LatLng[]>([]);
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
  /** Original engine estimate, deliberately unchanged by reroutes or live traffic. */
  const originalEstimateMsRef = useRef(0);
  /** Active (not paused) elapsed time banked before the current running segment. */
  const activeElapsedMsRef = useRef(0);
  /** Start of the current active segment; null while paused/outside guidance. */
  const activeStartedAtRef = useRef<number | null>(null);
  /** Distance driven across reroutes (each reroute starts a fresh session). */
  const traveledBaseRef = useRef(0);
  /** Latest NavState, readable from callbacks without a stale closure. */
  const lastStateRef = useRef<NavState | null>(null);
  /** Latest raw fix — the origin an accepted reroute offer recalculates from. */
  const lastFixRef = useRef<Position | null>(null);
  /** Measurement time of that fix; rejects delayed batches and Start-time races. */
  const lastFixMeasuredAtRef = useRef<number | null>(null);
  /** One spoken "off route" per episode in offer mode, not one per fix. */
  const offRouteSpokenRef = useRef(false);
  /** The faster-route offer's payload; the state above only carries the saving. */
  const fasterOfferRef = useRef<{
    path: RoutePath;
    vias: LatLng[];
    savesMs: number;
    atMs: number;
  } | null>(null);
  /** Saving the driver last dismissed — the bar a new offer must clear. */
  const fasterDismissedMsRef = useRef<number | null>(null);
  /** One faster-route probe at a time; a slow answer must not stack more. */
  const fasterCheckInFlight = useRef(false);
  /** The followed path, readable from callbacks (addStop's insert ordering). */
  const activePathRef = useLatest(activePath);
  /** Compass-vs-course blending for the walking puck (speed hysteresis). */
  const facingBlender = useRef(new FacingBlender());
  const headingSourceRef = useRef<HeadingSource>('auto');
  /** Cancels an in-flight route-enrichment fetch (End, or a superseding reroute). */
  const enrichAbort = useRef<AbortController | null>(null);
  /** Teardown for the active fix watch, if any. */
  const watchStopRef = useRef<(() => void) | null>(null);
  /** Synchronous guard for a final queued fix after a pause tears its watch down. */
  const pausedRef = useRef(false);
  /** Prevent two quick Resume taps from starting competing location watches. */
  const continueInFlightRef = useRef(false);
  /** Along-route progress at Pause; the first resumed fix must not count the gap as travel. */
  const resumeFromTraveledRef = useRef<number | null>(null);
  /** The re-anchor fix updates state but does not replay a cue crossed during the pause. */
  const suppressPromptsOnceRef = useRef(false);
  /**
   * True from the moment the trip is declared arrived until it is released.
   * Fixes keep arriving through the arrival card (see `stop`), and every one
   * of them still reports `arrived` — this is what keeps that from being
   * announced, summarised and re-summarised once a second.
   */
  const arrivedRef = useRef(false);
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

  /** Bank the current active segment exactly once (Pause, arrival or End). */
  const bankActiveTime = useCallback((now = Date.now()) => {
    if (activeStartedAtRef.current === null) return;
    activeElapsedMsRef.current += Math.max(0, now - activeStartedAtRef.current);
    activeStartedAtRef.current = null;
  }, []);

  const fetchPath = useCallback(
    async (
      origin: LatLng,
      dest: LatLng,
      prof: RoutingProfile,
      preferences?: Partial<RoutePreferences>,
      headingDeg?: number,
      vias: LatLng[] = [],
    ): Promise<RoutePath> => {
      const result = await platformRef.current.provider.route({
        profile: prof,
        points: [origin, ...vias, dest],
        instructions: true,
        // Hike guidance draws the remaining elevation profile and ascent from
        // this active path. Other modes avoid the extra elevation/trace work.
        details: prof === 'hike',
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
      vias: LatLng[] = [],
    ): Promise<RoutePath[]> => {
      // With via stops the engine offers no alternates (a Valhalla limit for
      // multi-point queries), so the preview simply shows the one path.
      const result = await platformRef.current.provider.route({
        profile: prof,
        points: [origin, ...vias, dest],
        instructions: true,
        alternatives: true,
        details: prof === 'hike',
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
      const { trace, nvdbCameras } = platformRef.current;
      if (!trace && !nvdbCameras) return;
      const controller = new AbortController();
      enrichAbort.current = controller;
      // Speed cameras ride the same fire-and-forget contract, but not the
      // trace pipeline — they are their own dataset, useful even where the
      // tiles carry no attributes. Car only, like the NVDB limits: ATK
      // enforcement is about driving.
      if (nvdbCameras && profileRef.current === 'car') {
        void nvdbCameras(
          path.points.map((p) => ({ lat: p.lat, lng: p.lng })),
          controller.signal,
        )
          .then((cameras) => {
            if (sessionRef.current !== session) return;
            if (cameras.points.length === 0 && cameras.sections.length === 0) return;
            const refreshed = session.setCameras(cameras);
            if (refreshed) {
              setState(refreshed);
              lastStateRef.current = refreshed;
            }
          })
          .catch(() => {
            // Optional by design: offline, or no dataset on the server.
          });
      }
      if (!trace) return;
      const nvdb = platformRef.current.nvdbLimits;
      void enrichRoute(path, profileRef.current, trace, { signal: controller.signal })
        .then(async (base) => {
          // Layer NVDB's authoritative Norwegian limits over the tile limits
          // for a car route. Its own best-effort: a failure (offline, no
          // dataset, outside Norway) falls back to exactly `base`, so the
          // roundel never disappears because NVDB was unreachable.
          if (!nvdb || profileRef.current !== 'car') return base;
          try {
            const overrides = await nvdb(
              path.points.map((p) => ({ lat: p.lat, lng: p.lng })),
              controller.signal,
            );
            return applyNvdbSpeedLimits(base, overrides);
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            return base;
          }
        })
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

  /** Withdraw a pending faster-route offer (route changed, expired, ended). */
  const clearFasterOffer = useCallback(() => {
    fasterOfferRef.current = null;
    setFasterRoute((current) => (current === null ? current : null));
  }, []);

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
      bankActiveTime();
      // Arrival is not the end of needing a position. The last hundred metres
      // are on foot — across a car park, round a courtyard, looking for the
      // door — and that is exactly where an accurate, live puck earns its
      // keep, so the fix watch and the session stay up while the arrival card
      // is on screen. The session is already `arrived`: it keeps producing
      // positions and stops producing guidance, prompts and reroutes. Done
      // (`stop(false)`) is what releases both, which is what the traveller
      // means by pressing it.
      if (!arrived) {
        stopWatch();
        sessionRef.current = null;
        arrivedRef.current = false;
      }
      clearPreview();
      enrichAbort.current?.abort();
      enrichAbort.current = null;
      destRef.current = null;
      viasRef.current = [];
      setViaPoints([]);
      originRef.current = null;
      preferencesRef.current = undefined;
      setPreferencesState(null);
      startInFlight.current = false;
      rerouteInFlight.current = false;
      rerouteBackoffUntil.current = 0;
      rerouteFailCount.current = 0;
      setRerouteFailed(false);
      clearFasterOffer();
      fasterDismissedMsRef.current = null;
      fasterCheckInFlight.current = false;
      setRouteCoords([]);
      setActivePath(null);
      setPosition(null);
      setSpeedMps(null);
      setAltitudeM(null);
      setFacing(null);
      setHeadingCalibrationNeeded(false);
      facingBlender.current.reset();
      lastFixRef.current = null;
      offRouteSpokenRef.current = false;
      pausedRef.current = false;
      continueInFlightRef.current = false;
      resumeFromTraveledRef.current = null;
      suppressPromptsOnceRef.current = false;
      if (!arrived) {
        setState(null);
        setDestination(null);
        setTripSummary(null);
        setActivity(null);
      }
      originalEstimateMsRef.current = 0;
      activeElapsedMsRef.current = 0;
      activeStartedAtRef.current = null;
      traveledBaseRef.current = 0;
      setPhase(arrived ? 'arrived' : 'idle');
    },
    [stopWatch, clearPreview, clearFasterOffer, bankActiveTime],
  );

  /** Abandon a trip that could not be set up, keeping the reason on screen. */
  const fail = useCallback(
    (err: unknown) => {
      stopWatch();
      clearPreview();
      sessionRef.current = null;
      arrivedRef.current = false;
      destRef.current = null;
      viasRef.current = [];
      setViaPoints([]);
      originRef.current = null;
      preferencesRef.current = undefined;
      setPreferencesState(null);
      clearFasterOffer();
      setDestination(null);
      setPosition(null);
      startInFlight.current = false;
      setError(message(err));
      setPhase('error');
    },
    [stopWatch, clearPreview, clearFasterOffer],
  );

  /**
   * End the trip with an arrival: summary, spoken confirmation, `arrived`.
   * Fires once — fixes keep flowing through the arrival card, and each one
   * still reports `arrived`, which must not re-announce it every second.
   */
  const finishArrived = useCallback(
    (session: NavigationSession, traveledM: number) => {
      if (arrivedRef.current) return;
      arrivedRef.current = true;
      bankActiveTime();
      speak(session.arrivalText());
      setTripSummary({
        distanceM: traveledBaseRef.current + traveledM,
        durationMs: activeElapsedMsRef.current,
        originalEstimateMs: originalEstimateMsRef.current,
      });
      stop(true);
    },
    [speak, stop, bankActiveTime],
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

  /**
   * Deliberately stop the trip clock and every active delivery surface while
   * retaining the route/session in memory. `pausedRef` is set before native
   * watch teardown so a queued final fix cannot sneak progress into the pause.
   */
  const pause = useCallback(() => {
    if (!sessionRef.current || (phase !== 'navigating' && phase !== 'rerouting')) return;
    pausedRef.current = true;
    resumeFromTraveledRef.current = lastStateRef.current?.traveledM ?? null;
    tripSeq.current++;
    bankActiveTime();
    stopWatch();
    platformRef.current.stopSpeaking();
    rerouteInFlight.current = false;
    rerouteBackoffUntil.current = 0;
    setRerouteFailed(false);
    clearFasterOffer();
    fasterCheckInFlight.current = false;
    setSpeedMps(null);
    setError(null);
    setPhase('paused');
  }, [phase, bankActiveTime, stopWatch, platformRef, clearFasterOffer]);

  const reroute = useCallback(
    async (from: Position, viasOverride?: LatLng[]) => {
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
        // Route through the stops still ahead only — a via already visited
        // must not pull the recalculated route back to it. The trimmed list
        // becomes authoritative only if this reroute succeeds; on failure the
        // old session (and its own passed-count) lives on. `viasOverride` is
        // addStop's already-updated list, which must not be re-trimmed with a
        // passed-count belonging to the outgoing route.
        const passedVias = lastStateRef.current?.viasPassed ?? 0;
        const remainingVias =
          viasOverride ?? (passedVias > 0 ? viasRef.current.slice(passedVias) : viasRef.current);
        const path = await fetchPath(
          from,
          destRef.current,
          profileRef.current,
          preferencesRef.current,
          heading,
          remainingVias,
        );
        // End, arrival or a whole new trip may have happened during the fetch;
        // applying now would resurrect a dead nav UI with a fresh session.
        if (trip !== tripSeq.current || !destRef.current) return;
        // The old session dies here — bank its driven distance for the summary.
        traveledBaseRef.current += lastStateRef.current?.traveledM ?? 0;
        // Rerouting happens mid-drive: never regress to the pre-departure
        // framing (calm camera / no snap-lock) the fresh session starts in.
        const nextSession = new NavigationSession(
          path,
          navOptionsForProfile(profileRef.current, {
            startDeparted: lastStateRef.current?.departed ?? true,
          }),
        );
        sessionRef.current = nextSession;
        viasRef.current = remainingVias;
        setViaPoints(remainingVias);
        setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
        setActivePath(path);
        rerouteFailCount.current = 0;
        rerouteBackoffUntil.current = 0;
        setRerouteFailed(false);
        // Any faster-route offer was measured against the route that just
        // died; it cannot be accepted on top of this one.
        clearFasterOffer();
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
    [fetchPath, speak, enrich, clearFasterOffer],
  );

  /**
   * The stop marker and the road a traveller can actually reach are not
   * always the same point (petrol forecourt versus POI, station entrance
   * versus platform). Let the traveller settle that ambiguity explicitly:
   * remove only the next unvisited via and calculate the continuation from
   * the measured position. The old route remains authoritative if that
   * calculation fails, just like every other reroute.
   */
  const continuePastIntermediateStop = useCallback(() => {
    if (phase !== 'navigating' && phase !== 'rerouting') return;
    const fix = lastFixRef.current;
    if (!fix) return;
    const passed = lastStateRef.current?.viasPassed ?? 0;
    if (passed >= viasRef.current.length) return;
    const remaining = viasRef.current.slice(passed + 1);
    void reroute(fix, remaining);
  }, [phase, reroute]);

  /** Accept an offered reroute: recalculate from the last known fix. */
  const rerouteNow = useCallback(() => {
    const fix = lastFixRef.current;
    if (!fix || !sessionRef.current) return;
    // The tap is explicit consent — don't let a backoff from an earlier
    // failed automatic attempt swallow it.
    rerouteBackoffUntil.current = 0;
    void reroute(fix);
  }, [reroute]);

  /**
   * Insert a stop into the running trip and recalculate through it. The stop
   * slots into the remaining vias by along-route position — "add the gas
   * station 3 km ahead" must not leapfrog a planned stop that comes first —
   * and the final destination stays the final destination.
   */
  const addStop = useCallback(
    (stop: LatLng) => {
      const fix = lastFixRef.current;
      const path = activePathRef.current;
      if (!fix || !path || !sessionRef.current || !destRef.current) return;
      const passed = lastStateRef.current?.viasPassed ?? 0;
      const remaining = passed > 0 ? viasRef.current.slice(passed) : viasRef.current;
      // Order along the followed line: the same leg-picking rule the planner
      // uses for a tap on the drawn route.
      const waypoints = [{ lat: fix.lat, lng: fix.lng }, ...remaining, destRef.current];
      const insertAt = viaInsertIndex(path.points, waypoints, stop);
      const vias = [...remaining];
      vias.splice(insertAt - 1, 0, stop);
      // The tap is explicit intent — a backoff from an earlier automatic
      // failure must not swallow it.
      rerouteBackoffUntil.current = 0;
      void reroute(fix, vias);
    },
    [reroute, activePathRef],
  );

  /**
   * Re-price the route being driven against the newest corridor measurements.
   *
   * The correction used to be applied only when a route was *built*, so a jam
   * that formed after departure reached the driver at the next reroute or not
   * at all — on a motorway with no turns left, "not at all" was the usual
   * answer. The roads do not change here and the trip does not restart: only
   * the maneuver schedule is replaced, which the session now accepts in place
   * (`setSchedule`), so prompts already fired, the banked distance and the
   * section-control anchor all survive.
   *
   * Deliberately re-priced over the *whole* line rather than the part ahead:
   * the schedule already sheds a delay as its maneuvers are passed, and asking
   * only about the remainder would make the same jam count twice for anything
   * reading the path's own total.
   */
  const repriceTraffic = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    const path = activePathRef.current;
    const delays = platformRef.current.trafficDelay;
    // Car only: the corridors measure motor traffic, and it is the only
    // profile whose provider prices a route in the first place.
    if (!session || !path || !delays || profileRef.current !== 'car') return;
    const trip = tripSeq.current;
    let priced: RoutePath;
    try {
      priced = applyTrafficDelay(path, await delays(path.points));
    } catch {
      // Offline, or the feed is down: the trip keeps the schedule it has.
      return;
    }
    // A reroute (or End) during the request leaves this measurement describing
    // a line nobody is driving any more.
    if (trip !== tripSeq.current) return;
    if (sessionRef.current !== session || activePathRef.current !== path) return;
    if (priced.timeMs === path.timeMs) return;
    const refreshed = session.setSchedule(priced, Date.now());
    setActivePath(priced);
    if (refreshed) {
      setState(refreshed);
      lastStateRef.current = refreshed;
    }
  }, [platformRef, activePathRef]);

  /**
   * The faster-route watch: ask the engine for today's best route from where
   * the car actually is, and compare engine estimate against engine estimate.
   * Anything better by a real margin becomes an *offer* — never a silent
   * swap, which is exactly what the off-route reroute is not allowed to be
   * either when the traveller chose the line deliberately.
   */
  const checkFasterRoute = useCallback(async () => {
    const session = sessionRef.current;
    const fix = lastFixRef.current;
    const state = lastStateRef.current;
    if (!session || !fix || !state || !destRef.current) return;
    if (fasterCheckInFlight.current || rerouteInFlight.current) return;
    // Only a settled, on-route, live-fix drive is worth second-guessing; and a
    // trip nearly over cannot save enough to matter.
    if (state.status !== 'navigating' || state.fix !== 'live' || !state.departed) return;
    const trip = tripSeq.current;
    fasterCheckInFlight.current = true;
    try {
      // A closure appearing on the line already being followed is not an
      // optional faster-route offer: the old route has become invalid, so
      // recalculate proactively. The provider adds the same closure to
      // Valhalla's exclude_locations when it builds the replacement.
      const closureTransport = platformRef.current.trafficClosures;
      const currentPath = activePathRef.current;
      if (closureTransport && currentPath) {
        const fromIndex = Math.max(
          0,
          Math.floor(state.routeProgress * Math.max(0, currentPath.points.length - 1)) - 2,
        );
        const closures = await closureTransport(currentPath.points.slice(fromIndex));
        if (closures.length > 0) {
          clearFasterOffer();
          rerouteBackoffUntil.current = 0;
          speak('Road closure ahead. Rerouting.');
          await reroute(fix);
          return;
        }
      }
      // Before comparing anything: bring the followed route's schedule up to
      // the current measurements. It is the point of the poll in its own right
      // — the ETA moves without the driver doing anything — and it is what
      // makes the comparison below fair, since the candidate is priced by the
      // provider against *now* while the followed route was priced at
      // departure. Judging one against the other was measuring a jam that has
      // since cleared against one that has not.
      await repriceTraffic();
      if (trip !== tripSeq.current || !sessionRef.current) return;
      const plannedMs = session.plannedRemainingMs();
      if (plannedMs === null || plannedMs <= FASTER_MIN_SAVING_MS) return;
      const heading =
        typeof fix.speedMps === 'number' && fix.speedMps >= 2 ? fix.headingDeg : undefined;
      const passed = state.viasPassed;
      const vias = passed > 0 ? viasRef.current.slice(passed) : viasRef.current;
      const candidate = await fetchPath(
        fix,
        destRef.current,
        profileRef.current,
        preferencesRef.current,
        heading,
        vias,
      );
      if (trip !== tripSeq.current || !sessionRef.current) return;
      const savesMs = plannedMs - candidate.timeMs;
      const dismissedFloor =
        fasterDismissedMsRef.current === null
          ? 0
          : fasterDismissedMsRef.current + FASTER_REOFFER_STEP_MS;
      if (savesMs >= Math.max(FASTER_MIN_SAVING_MS, dismissedFloor)) {
        fasterOfferRef.current = { path: candidate, vias, savesMs, atMs: Date.now() };
        setFasterRoute({ savesMs });
        const minutes = Math.max(1, Math.round(savesMs / 60_000));
        speak(
          `A faster route is available — it saves ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
        );
      } else if (fasterOfferRef.current) {
        // The advantage evaporated before the driver acted on it.
        clearFasterOffer();
      }
    } catch {
      // Offline, or no route right now — the next interval asks again.
    } finally {
      if (trip === tripSeq.current) fasterCheckInFlight.current = false;
    }
  }, [platformRef, activePathRef, fetchPath, speak, clearFasterOffer, reroute, repriceTraffic]);

  /** Take the offered faster route, exactly as a successful reroute would. */
  const acceptFasterRoute = useCallback(() => {
    const offer = fasterOfferRef.current;
    if (!offer || !sessionRef.current || !destRef.current) return;
    clearFasterOffer();
    const { path, vias } = offer;
    // The old session dies here — bank its driven distance for the summary.
    traveledBaseRef.current += lastStateRef.current?.traveledM ?? 0;
    const nextSession = new NavigationSession(
      path,
      navOptionsForProfile(profileRef.current, {
        startDeparted: lastStateRef.current?.departed ?? true,
      }),
    );
    sessionRef.current = nextSession;
    viasRef.current = vias;
    setViaPoints(vias);
    setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
    setActivePath(path);
    rerouteFailCount.current = 0;
    rerouteBackoffUntil.current = 0;
    setRerouteFailed(false);
    enrich(nextSession, path);
    const fix = lastFixRef.current;
    if (fix) {
      try {
        const seeded = nextSession.update(fix, Date.now());
        setState(seeded.state);
        lastStateRef.current = seeded.state;
      } catch {
        // The next live fix populates the state instead.
      }
    }
    const depart = nextSession.departurePrompt();
    if (depart) speak(depart.text);
  }, [clearFasterOffer, enrich, speak]);

  /** Decline the offer; only a meaningfully better one may interrupt again. */
  const dismissFasterRoute = useCallback(() => {
    const offer = fasterOfferRef.current;
    if (offer) fasterDismissedMsRef.current = offer.savesMs;
    clearFasterOffer();
  }, [clearFasterOffer]);

  const onFix = useCallback(
    (fix: Position, measuredAtMs?: number) => {
      // Stopping an Android foreground watch is asynchronous at the native
      // boundary. A final queued sample belongs to the paused interval and
      // must not move progress, fire a prompt or start a reroute.
      if (pausedRef.current) return;
      const explicitlyMeasured = typeof measuredAtMs === 'number' && Number.isFinite(measuredAtMs);
      let fixAtMs = explicitlyMeasured ? measuredAtMs : Date.now();
      const previousAtMs = lastFixMeasuredAtRef.current;
      if (previousAtMs !== null && fixAtMs <= previousAtMs) {
        // Real platform timestamps are authoritative: a delayed TaskManager
        // batch or the older Start origin must not rewind a newer direct fix.
        if (explicitlyMeasured) return;
        // Test/custom seams without timestamps still represent ordered callback
        // delivery, even when several arrive inside one wall-clock millisecond.
        fixAtMs = previousAtMs + 1;
      }
      lastFixMeasuredAtRef.current = fixAtMs;
      const session = sessionRef.current;
      lastFixRef.current = fix;
      // A faster-route offer describes a branch from where the car *was*; once
      // stale it may already be behind, so it quietly lapses.
      const offer = fasterOfferRef.current;
      if (offer && Date.now() - offer.atMs > FASTER_OFFER_TTL_MS) clearFasterOffer();
      setSpeedMps(typeof fix.speedMps === 'number' && fix.speedMps >= 0 ? fix.speedMps : null);
      setAltitudeM(
        typeof fix.altitudeM === 'number' && Number.isFinite(fix.altitudeM) ? fix.altitudeM : null,
      );
      setPosition(fix);
      if (usesFacingHeading(profileRef.current) && headingSourceRef.current === 'gps') {
        const speed = typeof fix.speedMps === 'number' ? fix.speedMps : 0;
        const deg = typeof fix.headingDeg === 'number' ? fix.headingDeg : null;
        setFacing(
          deg !== null && Number.isFinite(deg) && speed >= 0.5
            ? { deg: ((deg % 360) + 360) % 360, accuracyDeg: null }
            : null,
        );
      }
      // Explorer mode is deliberately only a live fix and follow camera. It
      // has no synthetic route state, so no arrival/off-route/reroute logic can
      // accidentally leak into a destination-free trip.
      if (!session) return;
      // Runs on every GPS fix (incl. Android's headless background task); an
      // uncaught throw here would take the whole app down in a release build.
      try {
        const { state: next, prompts } = session.update(fix, fixAtMs);
        const pausedAtM = resumeFromTraveledRef.current;
        if (pausedAtM !== null) {
          // Re-anchor the visible route at the traveller's current position,
          // but exclude any forward movement made while Atlas was paused from
          // the completed-trip distance. From here onward new progress counts.
          traveledBaseRef.current -= Math.max(0, next.traveledM - pausedAtM);
          resumeFromTraveledRef.current = null;
        }
        const suppressPrompts = suppressPromptsOnceRef.current;
        suppressPromptsOnceRef.current = false;
        setState(next);
        lastStateRef.current = next;
        if (!suppressPrompts) for (const prompt of prompts) speak(prompt.text);
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
    [reroute, speak, finishArrived, clearFasterOffer],
  );

  /** Resume a deliberately paused in-memory session without replacing its route. */
  const continueTrip = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || !pausedRef.current || continueInFlightRef.current) return;
    continueInFlightRef.current = true;
    const facingReady =
      usesFacingHeading(profileRef.current) && headingSourceRef.current !== 'gps'
        ? platformRef.current.prepareFacing?.()
        : undefined;
    const trip = tripSeq.current;
    setError(null);
    try {
      // Obtain a measured anchor before accepting streaming fixes. It puts the
      // puck where the traveller is now without treating the paused interval
      // as dead reckoning or replaying guidance that belonged inside it.
      const origin = await platformRef.current.currentFix(START_FIX_TIMEOUT_MS);
      await facingReady?.catch(() => undefined);
      if (trip !== tripSeq.current || sessionRef.current !== session || !pausedRef.current) return;
      const stopFixes = await platformRef.current.watchFixes(onFix, 'guidance');
      if (trip !== tripSeq.current || sessionRef.current !== session || !pausedRef.current) {
        stopFixes();
        return;
      }
      watchStopRef.current = stopFixes;
      lastFixMeasuredAtRef.current = null;
      activeStartedAtRef.current = Date.now();
      pausedRef.current = false;
      setPhase('navigating');
      suppressPromptsOnceRef.current = true;
      onFix(origin.fix, origin.atMs);
      if (!arrivedRef.current) speak('Navigation resumed');
    } catch (err) {
      // A failed restart leaves the route safely paused and retryable. It does
      // not become the terminal error phase, which would discard the only
      // useful route state the traveller still has.
      if (trip === tripSeq.current && sessionRef.current === session) {
        pausedRef.current = true;
        activeStartedAtRef.current = null;
        setError(message(err));
        setPhase('paused');
      }
    } finally {
      continueInFlightRef.current = false;
    }
  }, [platformRef, onFix, speak]);

  const start = useCallback(
    async (
      dest: LatLng,
      prof: RoutingProfile = 'car',
      preferences?: Partial<RoutePreferences>,
      vias: LatLng[] = [],
    ) => {
      if (startInFlight.current) return;
      startInFlight.current = true;
      // A route preview supersedes destination-free Explorer (or any previous
      // live trip) immediately. Leaving its watch alive until Go meant Android
      // had to hand the same foreground location task from the old activity to
      // guidance at the most timing-sensitive moment, and old fixes could keep
      // driving the outgoing session behind the preview meanwhile.
      stopWatch();
      sessionRef.current = null;
      tripSeq.current++;
      const seq = ++previewSeq.current;
      setError(null);
      setActivity('guidance');
      setPhase('starting');
      try {
        const origin = await platformRef.current.currentFix(START_FIX_TIMEOUT_MS);
        if (seq !== previewSeq.current) return;

        destRef.current = dest;
        viasRef.current = vias;
        setViaPoints(vias);
        originRef.current = origin;
        profileRef.current = prof;
        preferencesRef.current = preferences;
        setPreferencesState(preferences ?? null);
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
        const paths = await fetchChoices(origin.fix, dest, prof, preferences, vias);
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
    [platformRef, stopWatch, fetchChoices, fail],
  );

  /**
   * Start a destination-free live map. The one-off fix both obtains the
   * platform permission and gives the camera an immediate position; the same
   * continuous watch as guidance then keeps it current (and, on Android,
   * keeps doing so under the foreground location service).
   */
  const explore = useCallback(
    async (prof: RoutingProfile = 'car') => {
      if (startInFlight.current) return;
      startInFlight.current = true;
      const facingReady =
        usesFacingHeading(prof) && headingSourceRef.current !== 'gps'
          ? platformRef.current.prepareFacing?.()
          : undefined;
      stopWatch();
      sessionRef.current = null;
      clearPreview();
      const seq = ++previewSeq.current;
      setError(null);
      setActivity('explorer');
      setPhase('exploring');
      profileRef.current = prof;
      setProfileState(prof);
      setPreferencesState(null);
      preferencesRef.current = undefined;
      destRef.current = null;
      setDestination(null);
      viasRef.current = [];
      setViaPoints([]);
      setState(null);
      lastStateRef.current = null;
      setRouteCoords([]);
      setActivePath(null);
      setTripSummary(null);
      setSpeedMps(null);
      setAltitudeM(null);
      setPosition(null);
      lastFixMeasuredAtRef.current = null;
      try {
        const origin = await platformRef.current.currentFix(START_FIX_TIMEOUT_MS);
        await facingReady?.catch(() => undefined);
        if (seq !== previewSeq.current) return;
        onFix(origin.fix, origin.atMs);
        const stopFixes = await platformRef.current.watchFixes(onFix, 'explorer');
        if (seq !== previewSeq.current) {
          stopFixes();
          return;
        }
        watchStopRef.current = stopFixes;
      } catch (err) {
        if (seq !== previewSeq.current) return;
        fail(err);
      } finally {
        if (seq === previewSeq.current) startInFlight.current = false;
      }
    },
    [platformRef, stopWatch, clearPreview, onFix, fail],
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
          // The stops are the plan; only the costing changes with the profile.
          const paths = await fetchChoices(origin.fix, dest, prof, undefined, viasRef.current);
          if (seq !== previewSeq.current) return;
          profileRef.current = prof;
          preferencesRef.current = undefined;
          setPreferencesState(null);
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

  /**
   * Hand a chosen path to a fresh session and start guiding along it — the
   * moment a *plan* becomes a *trip*, shared by Start and by resuming an
   * interrupted one. Everything here is about the trip beginning: a session
   * that has not departed yet, a zeroed distance bank, the fix watch, and the
   * departure prompt that answers "which way now?".
   */
  const beginGuidance = useCallback(
    async (path: RoutePath, origin: NavOriginFix | null, restoredProgress?: NavTripProgress) => {
      tripSeq.current++;
      setActivity('guidance');
      const session = new NavigationSession(path, navOptionsForProfile(profileRef.current));
      sessionRef.current = session;
      offRouteSpokenRef.current = false;
      arrivedRef.current = false;
      pausedRef.current = false;
      resumeFromTraveledRef.current = null;
      enrich(session, path);
      originalEstimateMsRef.current = restoredProgress?.originalEstimateMs ?? path.timeMs;
      activeElapsedMsRef.current = restoredProgress?.elapsedMs ?? 0;
      activeStartedAtRef.current = Date.now();
      traveledBaseRef.current = restoredProgress?.distanceM ?? 0;
      lastStateRef.current = null;
      setTripSummary(null);
      setState(null);
      setRouteCoords(path.points.map((p) => [p.lng, p.lat]));
      setActivePath(path);
      clearPreview();

      // A fresh trip owns a fresh ordering window. Set this before starting
      // the streams: if watchPositionAsync immediately emits a newer sample,
      // the origin applied below is correctly rejected rather than rewinding
      // the session.
      lastFixMeasuredAtRef.current = null;

      stopWatch();
      const stopFixes = await platformRef.current.watchFixes(onFix, 'guidance');
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
      if (origin && Date.now() - origin.atMs < ORIGIN_FRESH_MS) onFix(origin.fix, origin.atMs);
    },
    [platformRef, enrich, clearPreview, stopWatch, onFix, speak],
  );

  const go = useCallback(async () => {
    // Invoke this before the first await: iOS Safari accepts its orientation
    // prompt only while the Start button's user gesture is still on the stack.
    const facingReady =
      usesFacingHeading(profileRef.current) && headingSourceRef.current !== 'gps'
        ? platformRef.current.prepareFacing?.()
        : undefined;
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
            viasRef.current,
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
      await facingReady?.catch(() => undefined);
      await beginGuidance(path, origin);
    } catch (err) {
      fail(err);
    } finally {
      // A no-op on the happy path (clearPreview already bumped the sequence);
      // this only rescues the early returns above from a stuck spinner.
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  }, [platformRef, previewPathsRef, previewIndexRef, fetchChoices, beginGuidance, fail]);

  /**
   * Restart an interrupted trip: same destination, same stops still ahead, same
   * mode and preferences — routed from wherever the traveller is now, and
   * guiding immediately. No preview, because this is not a new decision: it is
   * the trip they were already on, handed back after the process died under
   * them. The route is deliberately re-fetched rather than restored: minutes
   * may have passed, and a line drawn from where they *were* is the one thing
   * that would make resuming worse than starting over.
   */
  const resume = useCallback(
    async (
      dest: LatLng,
      prof: RoutingProfile,
      preferencesOverride?: Partial<RoutePreferences>,
      vias: LatLng[] = [],
      progress?: NavTripProgress,
    ) => {
      if (startInFlight.current) return;
      startInFlight.current = true;
      const facingReady =
        usesFacingHeading(prof) && headingSourceRef.current !== 'gps'
          ? platformRef.current.prepareFacing?.()
          : undefined;
      const seq = ++previewSeq.current;
      setError(null);
      setPhase('starting');
      try {
        const origin = await platformRef.current.currentFix(START_FIX_TIMEOUT_MS);
        if (seq !== previewSeq.current) return;

        destRef.current = dest;
        viasRef.current = vias;
        setViaPoints(vias);
        originRef.current = origin;
        profileRef.current = prof;
        preferencesRef.current = preferencesOverride;
        setPreferencesState(preferencesOverride ?? null);
        setProfileState(prof);
        setDestination(dest);
        setSpeedMps(null);
        setAltitudeM(null);

        const path = await fetchPath(origin.fix, dest, prof, preferencesOverride, undefined, vias);
        if (seq !== previewSeq.current) return;
        await facingReady?.catch(() => undefined);
        // Cleared here rather than in `finally`: `beginGuidance` bumps the
        // preview sequence itself (it clears any preview), so by the time the
        // finally runs this resume no longer looks like the current one and
        // would leave the double-tap guard latched on for good.
        startInFlight.current = false;
        await beginGuidance(path, origin, progress);
      } catch (err) {
        if (seq !== previewSeq.current) return;
        fail(err);
      } finally {
        if (seq === previewSeq.current) startInFlight.current = false;
      }
    },
    [platformRef, fetchPath, beginGuidance, fail],
  );

  const guiding = phase === 'navigating' || phase === 'rerouting';
  const liveFollowing = guiding || phase === 'exploring';
  const activeTrip = guiding || phase === 'paused';
  const tripProgress: NavTripProgress | null = activeTrip
    ? {
        distanceM: Math.max(0, traveledBaseRef.current + (state?.traveledM ?? 0)),
        elapsedMs:
          activeElapsedMsRef.current +
          (activeStartedAtRef.current === null
            ? 0
            : Math.max(0, Date.now() - activeStartedAtRef.current)),
        originalEstimateMs: originalEstimateMsRef.current,
      }
    : null;

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

  // The faster-route watch. Driving modes only — the same modes that reroute
  // automatically: on foot the "fastest" route barely moves, and the walker
  // chose their path. Deliberately a slow cadence: this exists to catch a
  // world that changed (a closure ahead, a mistake at the preview), not to
  // second-guess every kilometre, and each check is a full route request.
  useEffect(() => {
    if (!guiding) return;
    if (!(navOptionsForProfile(profile).autoReroute ?? true)) return;
    const timer = setInterval(() => void checkFasterRoute(), FASTER_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [guiding, profile, checkFasterRoute]);

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
  const facingProfile = usesFacingHeading(profile);
  const speedRef = useLatest(speedMps);
  useEffect(() => {
    if (!liveFollowing || !facingProfile || headingSource === 'gps') return;
    const watch = platformRef.current.watchFacing;
    if (!watch) return;
    const blender = facingBlender.current;
    blender.reset();
    let lastSetMs = 0;
    let lastSetDeg: number | null = null;
    const unsubscribe = watch((deg, accuracyDeg) => {
      const now = Date.now();
      if (accuracyDeg !== null) {
        setHeadingCalibrationNeeded((needed) =>
          needed
            ? accuracyDeg > DEFAULT_FACING_BLEND.accuracyRecoveryDeg
            : accuracyDeg > DEFAULT_FACING_BLEND.maxAccuracyDeg,
        );
      }
      blender.updateCompass(deg, accuracyDeg, now);
      const sample =
        headingSource === 'compass'
          ? blender.current(null, null, now)
          : blender.current(speedRef.current, lastStateRef.current?.courseDeg ?? null, now);
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
      setHeadingCalibrationNeeded(false);
    };
  }, [liveFollowing, facingProfile, headingSource, platformRef, speedRef]);

  // Speeding up leans the puck onto the course even between compass events (a
  // cyclist pushing off from a walk would otherwise keep a stale facing); a
  // compass that has since gone quiet drops it entirely.
  useEffect(() => {
    if (headingSource !== 'auto') return;
    const course = lastStateRef.current?.courseDeg ?? null;
    if (facing && facingBlender.current.current(speedMps, course, Date.now()) === null) {
      setFacing(null);
    }
  }, [speedMps, facing, headingSource]);

  const setHeadingSource = useCallback(
    (source: HeadingSource) => {
      headingSourceRef.current = source;
      setHeadingSourceState(source);
      facingBlender.current.reset();
      setHeadingCalibrationNeeded(false);
      if (source === 'gps') {
        const fix = lastFixRef.current;
        const speed = typeof fix?.speedMps === 'number' ? fix.speedMps : 0;
        const deg = typeof fix?.headingDeg === 'number' ? fix.headingDeg : null;
        setFacing(
          deg !== null && Number.isFinite(deg) && speed >= 0.5
            ? { deg: ((deg % 360) + 360) % 360, accuracyDeg: null }
            : null,
        );
      } else {
        setFacing(null);
        // Changing this setting is itself a user gesture. If Safari was
        // started in GPS-only mode, this is the only valid moment to ask for
        // orientation access without forcing the traveller to restart.
        if (
          usesFacingHeading(profileRef.current) &&
          (phase === 'navigating' || phase === 'rerouting' || phase === 'exploring')
        ) {
          void platformRef.current.prepareFacing?.().catch(() => undefined);
        }
      }
    },
    [phase, platformRef],
  );

  const headingArrowVisible = !facingProfile
    ? true
    : headingSource === 'auto'
      ? !headingCalibrationNeeded && (facing !== null || state?.courseDeg != null)
      : facing !== null;

  // A navigating device is a dashboard: keep the screen on for the whole trip.
  useEffect(() => {
    if (!liveFollowing) return;
    return platformRef.current.keepAwake?.();
  }, [liveFollowing, platformRef]);

  // Drop the fix watch if the app unmounts mid-trip.
  useEffect(() => stopWatch, [stopWatch]);

  return {
    phase,
    activity,
    state,
    position,
    routeCoords,
    activePath,
    profile,
    preferences,
    destination,
    viaPoints,
    nextIntermediateStop: viaPoints[state?.viasPassed ?? 0] ?? null,
    previewPaths,
    previewIndex,
    previewLoading,
    previewError,
    speedMps,
    altitudeM,
    facingDeg: facing?.deg ?? null,
    facingAccuracyDeg: facing?.accuracyDeg ?? null,
    headingSource,
    setHeadingSource,
    headingArrowVisible,
    headingCalibrationNeeded,
    rerouteOffered:
      phase === 'navigating' &&
      state?.status === 'off-route' &&
      !(navOptionsForProfile(profile).autoReroute ?? true),
    muted,
    fasterRoute,
    acceptFasterRoute,
    dismissFasterRoute,
    addStop,
    continuePastIntermediateStop,
    tripSummary,
    tripProgress,
    rerouteFailed,
    error,
    start,
    explore,
    selectPreview: setPreviewIndex,
    setProfile,
    go,
    resume,
    pause,
    continueTrip,
    toggleMute,
    setMuted,
    arriveNow,
    rerouteNow,
    stop: useCallback(() => stop(false), [stop]),
  };
}
