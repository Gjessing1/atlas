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
  compactMatchTrace,
  compactNavState,
  compactPosition,
  DEFAULT_FACING_BLEND,
  FacingBlender,
  NAV_LIFECYCLE_INITIAL,
  navActivity,
  navDestination,
  navLifecycleReducer,
  navMayReroute,
  navOptionsForProfile,
  navPath,
  navPhase,
  navPlan,
  navTripProgress,
  navTripSample,
  NavigationSession,
  routeDigest,
  routeFingerprint,
  NavRouteLedger,
  NavTripStats,
  type HeadingSource,
  type NavActivity,
  type NavDiagnosticRecord,
  type NavDiagnosticsSink,
  type NavEvent,
  type NavFasterRoute,
  type NavLifecycle,
  type NavOriginFix,
  type NavPhase,
  type NavRouteReason,
  type NavState,
  type NavTripOutcome,
  type NavTripProgress,
  type NavTripSummary,
  type Position,
  type VoicePrompt,
} from '@atlas/navigation';
import {
  applyNvdbSpeedLimits,
  enrichRoute,
  routeAlternativeLabelPoint,
  sortRouteChoices,
  viaInsertIndex,
  type NvdbCameraTransport,
  type NvdbLimitTransport,
  type NvdbLaneTransport,
  type RoutePreferences,
  type RoutePath,
  type RoadWeatherRoute,
  type RoadWeatherWarning,
  type RouteProvider,
  type RoutingProfile,
  type ValhallaTransport,
} from '@atlas/routing';
import { type TrafficClosureTransport, type RoadWeatherTransport } from '@atlas/traffic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The lifecycle types belong to the navigation domain, not to this hook: the
 * state machine that owns them lives in `@atlas/navigation`, beside the
 * session it drives and testable without React. They are re-exported here
 * because both apps have always imported them from the controller.
 */
export type {
  NavActivity,
  NavFasterRoute,
  NavOriginFix,
  NavPhase,
  NavTripProgress,
  NavTripSummary,
} from '@atlas/navigation';

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
   * layered over `trace`'s tile limits inside Norway. Optional
   * and best-effort: absent, unreachable, or an empty result all just leave the
   * tile limits standing, so it can never cost a roundel that `trace` produced.
   */
  nvdbLimits?: NvdbLimitTransport;
  /** NVDB dedicated turn lanes, matched onto maneuver indexes. */
  nvdbLanes?: NvdbLaneTransport;
  /**
   * ATK speed cameras (points + average-speed sections) matched onto a route.
   * Same contract as `nvdbLimits`: optional and best-effort —
   * absent, unreachable, or empty simply means no camera guidance, exactly
   * the pre-camera behaviour and the everywhere-outside-Norway behaviour.
   */
  nvdbCameras?: NvdbCameraTransport;
  /** Live route-matched DATEX closures, for proactive mid-drive rerouting. */
  trafficClosures?: TrafficClosureTransport;
  /** Live measured/forecast road-surface conditions matched to a driving route. */
  roadWeather?: RoadWeatherTransport;
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
  /**
   * Where the navigation diagnostic log goes, when the platform keeps one.
   *
   * The trip logic is the only place that knows *why* anything happened — why
   * a route was asked for, what a faster-route probe decided, which prompt was
   * emitted for which maneuver — so it is the only place that can record it. A
   * platform with no log (the web) simply leaves this unset and nothing here
   * runs; Android turns the `trip-start` / `trip-end` records into files. Never
   * allowed to throw, and never awaited: navigation must not fail, or wait, on
   * its own diagnostics.
   */
  diagnostics?: NavDiagnosticsSink;
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
  /** Google-style muted route choices drawn beside the active route while driving. */
  routeAlternatives: readonly NavRouteAlternative[];
  /** Latest ground speed in m/s, or null when unknown/stationary. */
  speedMps: number | null;
  /** Latest GPS altitude in metres, or null when the platform has none. */
  altitudeM: number | null;
  /** Nearest ice-risk reading within 20 km ahead, refreshed with live traffic. */
  roadWeatherWarning: (RoadWeatherWarning & { distanceAheadM: number }) | null;
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
  /** Switch guidance to a drawn in-drive alternative. */
  selectRouteAlternative: (index: number) => void;
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

export interface NavRouteAlternative {
  path: RoutePath;
  /** Intermediate stops this candidate was calculated through. */
  vias: LatLng[];
  /** ETA difference against the active route; positive means slower. */
  deltaMs: number;
  /** Point on the visibly distinct branch where the relative-time badge sits. */
  labelAt: LatLng;
}

/** How long to wait for the fix that a preview is built from. */
const START_FIX_TIMEOUT_MS = 20_000;
/** Shorter at Start: the previewed path is a perfectly good fallback. */
const GO_FIX_TIMEOUT_MS = 8_000;
/** Beyond this age the preview's fix no longer describes where the traveller is. */
const ORIGIN_FRESH_MS = 30_000;
/** Below driving speed a phone course is manoeuvring noise, not a route constraint. */
const REROUTE_HEADING_MIN_SPEED_MPS = 5;
/** How often, while driving on-route, to ask whether a faster route exists. */
const FASTER_CHECK_INTERVAL_MS = 180_000;
/** Smallest saving worth interrupting a driver for. */
const FASTER_MIN_SAVING_MS = 120_000;
/** A non-slower route this much shorter is worth offering too. */
const FASTER_MIN_DISTANCE_FRACTION = 0.15;
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

/** A hand-held compass needs near-frame feedback; the map tree still stays outside this state. */
const FACING_REFRESH_MS = 50;
const FACING_REFRESH_DEG = 0.5;

/** Profiles where facing the device and direction of travel can diverge. */
const usesFacingHeading = (profile: RoutingProfile): boolean => profile !== 'car';

/** Stops that outlive a render: a plan with no vias always hands back this one. */
const NO_VIAS: LatLng[] = [];

function inDriveAlternatives(
  active: RoutePath,
  candidates: readonly RoutePath[],
  activeRemainingMs: number,
  vias: LatLng[] = [],
): NavRouteAlternative[] {
  const activeDigest = routeDigest(active.points);
  const seen = new Set([activeDigest]);
  const result: NavRouteAlternative[] = [];
  for (const path of candidates) {
    const digest = routeDigest(path.points);
    if (seen.has(digest)) continue;
    seen.add(digest);
    const labelAt = routeAlternativeLabelPoint(active.points, path.points);
    if (!labelAt) continue;
    result.push({ path, vias, deltaMs: path.timeMs - activeRemainingMs, labelAt });
    if (result.length === 2) break;
  }
  return result;
}

/**
 * The lifecycle machine, readable synchronously.
 *
 * Commands and asynchronous results both have to see the transition they have
 * just made — the fix handler asks "is this trip still mine?" microseconds
 * after Pause dispatched, and a fix already queued across the native bridge
 * must not be applied to a paused trip — while React state only becomes
 * visible at the next render. So the ref is the authority and the state exists
 * to schedule that render: exactly the discipline the two dozen refs it
 * replaces already followed, now in one place and behind one pure reducer.
 */
function useNavLifecycle(): {
  lifecycle: NavLifecycle;
  lifecycleRef: { current: NavLifecycle };
  dispatch: (event: NavEvent) => NavLifecycle;
} {
  const lifecycleRef = useRef<NavLifecycle>(NAV_LIFECYCLE_INITIAL);
  const [lifecycle, setLifecycle] = useState<NavLifecycle>(NAV_LIFECYCLE_INITIAL);
  const dispatch = useCallback((event: NavEvent): NavLifecycle => {
    const next = navLifecycleReducer(lifecycleRef.current, event);
    // An event that is not legal where it lands changes nothing, and must not
    // cost a render — several of those arrive on every fix.
    if (next !== lifecycleRef.current) {
      lifecycleRef.current = next;
      setLifecycle(next);
    }
    return next;
  }, []);
  return { lifecycle, lifecycleRef, dispatch };
}

export function useNavigationController(platform: NavPlatform): NavController {
  const platformRef = useLatest(platform);

  // The trip: which one is running, what it was planned as, which asynchronous
  // request may still land, what has been banked. One reducer, one ref.
  const { lifecycle, lifecycleRef, dispatch } = useNavLifecycle();
  const { stage } = lifecycle;
  const phase = navPhase(lifecycle);

  // Telemetry, deliberately outside the machine: it changes at sensor rate,
  // and folding it in would make every fix a lifecycle transition.
  const [state, setState] = useState<NavState | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [altitudeM, setAltitudeM] = useState<number | null>(null);
  const [facing, setFacing] = useState<{ deg: number; accuracyDeg: number | null } | null>(null);
  const [headingSource, setHeadingSourceState] = useState<HeadingSource>('auto');
  const [headingCalibrationNeeded, setHeadingCalibrationNeeded] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [routeAlternatives, setRouteAlternatives] = useState<NavRouteAlternative[]>([]);
  const [roadWeather, setRoadWeather] = useState<RoadWeatherRoute | null>(null);

  const sessionRef = useRef<NavigationSession | null>(null);
  // Read inside the fix handler (which closes over a stale `muted`), so keep a ref.
  const mutedRef = useRef(false);
  /** Latest NavState, readable from callbacks without a stale closure. */
  const lastStateRef = useRef<NavState | null>(null);
  /** Latest raw fix — the origin an accepted reroute offer recalculates from. */
  const lastFixRef = useRef<Position | null>(null);
  /** Measurement time of that fix; rejects delayed batches and Start-time races. */
  const lastFixMeasuredAtRef = useRef<number | null>(null);
  /** One spoken "off route" per episode in offer mode, not one per fix. */
  const offRouteSpokenRef = useRef(false);
  /** Compass-vs-course blending for the walking puck (speed hysteresis). */
  const facingBlender = useRef(new FacingBlender());
  const headingSourceRef = useRef<HeadingSource>('auto');
  /** Cancels an in-flight route-enrichment fetch (End, or a superseding reroute). */
  const enrichAbort = useRef<AbortController | null>(null);
  /** Reset the periodic watch after a reroute installs a new baseline route. */
  const resetFasterCheckRef = useRef<() => void>(() => undefined);
  /** Teardown for the active fix watch, if any. */
  const watchStopRef = useRef<(() => void) | null>(null);
  /**
   * Ownership token for the native fix stream. Stopping a native watch cannot
   * retract a callback already queued across the bridge, so the callback must
   * prove it still belongs to the watch that owns the current trip.
   */
  const watchSeq = useRef(0);
  /** Identity of the trip the diagnostic log is currently recording, if any. */
  const tripIdRef = useRef<string | null>(null);
  /** That trip's running summary, handed to `trip-end`. */
  const tripStatsRef = useRef<NavTripStats | null>(null);
  /** Route geometries already written down this trip, so each is stored once. */
  const routeLedgerRef = useRef<NavRouteLedger>(new NavRouteLedger());
  /** Whether the trip reached its destination, for the outcome End records. */
  const tripArrivedRef = useRef(false);

  /**
   * The diagnostic log, stamped with the trip it belongs to.
   *
   * Every record carries `trip` because the log is per trip on the device and
   * a support file may still be a concatenation of several; without the stamp
   * a reader has to infer boundaries from where the records happen to sit.
   */
  const diag = useCallback(
    (record: NavDiagnosticRecord): void => {
      const sink = platformRef.current.diagnostics;
      if (!sink) return;
      try {
        sink(tripIdRef.current === null ? record : { ...record, trip: tripIdRef.current });
      } catch {
        // A log that cannot be written is not a navigation failure.
      }
    },
    [platformRef],
  );

  /**
   * Close the running trip's log with the summary that triages it — duration,
   * distance, reroutes, time off-route, time without a live fix, share of
   * fixes snapped. Idempotent: whichever ending happens first owns the trip.
   */
  const endTripDiagnostics = useCallback(
    (outcome: NavTripOutcome): void => {
      const id = tripIdRef.current;
      if (id === null) return;
      const stats = tripStatsRef.current;
      diag({
        event: 'trip-end',
        outcome: tripArrivedRef.current && outcome === 'ended-early' ? 'arrived' : outcome,
        report: stats ? stats.report() : null,
      });
      tripIdRef.current = null;
      tripStatsRef.current = null;
      tripArrivedRef.current = false;
    },
    [diag],
  );

  /** Open a log for a trip that is beginning; any trip still open is abandoned. */
  const beginTripDiagnostics = useCallback(
    (context: Record<string, unknown>): void => {
      if (!platformRef.current.diagnostics) return;
      endTripDiagnostics('ended-early');
      tripIdRef.current = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .padStart(6, '0')}`;
      tripStatsRef.current = new NavTripStats();
      routeLedgerRef.current = new NavRouteLedger();
      tripArrivedRef.current = false;
      diag({ event: 'trip-start', ...context });
    },
    [platformRef, diag, endTripDiagnostics],
  );

  /** What a prompt was *about*, so a log can say whether the cue ever fired. */
  const promptContext = (prompt: VoicePrompt): Record<string, unknown> => ({
    kind: prompt.kind,
    maneuverIndex: prompt.maneuverIndex,
    thresholdM: prompt.thresholdM,
  });

  /**
   * Speak a voice prompt, unless muted; never let a TTS error interrupt nav.
   *
   * Logged either way, with `spoken` saying which: the uploaded log recorded
   * fixes, states, phases and routes but not one line about what the driver
   * heard, so "did that cue fire, twice, or never" could only be answered by
   * asking them.
   */
  const speak = useCallback(
    (text: string, context: Record<string, unknown> = {}): void => {
      const spoken = !mutedRef.current;
      diag({ event: 'voice-prompt', ...context, text, spoken });
      if (!spoken) return;
      try {
        platformRef.current.speak(text);
      } catch (err) {
        console.warn('tts failed', err);
      }
    },
    [platformRef, diag],
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
    watchSeq.current++;
    watchStopRef.current?.();
    watchStopRef.current = null;
  }, []);

  /**
   * Record a route the trip asked for. `route-request` used to carry the query
   * and nothing about *why* it was made, so first-fix, off-route, wrong-way,
   * closure, faster-probe, accepted offer and added stop were indistinguishable
   * in a log and the 3-minute probe cadence was the only way to guess.
   */
  const logRouteResult = useCallback(
    (reason: NavRouteReason, paths: RoutePath[], startedAtMs: number): void => {
      const first = paths[0];
      diag({
        event: 'route-result',
        reason,
        tookMs: Date.now() - startedAtMs,
        choices: paths.length,
        route: first ? routeFingerprint(first) : null,
      });
    },
    [diag],
  );

  /**
   * Record the route guidance is now following.
   *
   * `active-route` used to fire on object identity, so a mid-drive traffic
   * re-price that swapped in a path with *identical geometry* looked exactly
   * like a route change. The digest settles that, and doubles
   * as the key that stores each distinct line once instead of logging the
   * calculated route and then the adopted copy of it again.
   */
  const logRouteAdopted = useCallback(
    (
      reason: NavRouteReason | 'departure',
      path: RoutePath,
      accountingAdjustmentM: number,
    ): void => {
      tripStatsRef.current?.routeAdopted(accountingAdjustmentM);
      if (!platformRef.current.diagnostics) return;
      const { fingerprint, geometry } = routeLedgerRef.current.note(path);
      if (geometry) diag({ event: 'route-geometry', ...geometry });
      diag({
        event: 'route-adopted',
        reason,
        route: fingerprint,
        bankedM: Math.round(accountingAdjustmentM),
      });
    },
    [platformRef, diag],
  );

  /** The fastest route plus up to two alternatives, for preview or live guidance. */
  const fetchChoices = useCallback(
    async (
      reason: NavRouteReason,
      origin: LatLng,
      dest: LatLng,
      prof: RoutingProfile,
      preferences?: Partial<RoutePreferences>,
      vias: LatLng[] = [],
      headingDeg?: number,
    ): Promise<RoutePath[]> => {
      const startedAtMs = Date.now();
      diag({ event: 'route-request', reason, profile: prof, vias: vias.length });
      try {
        // With via stops the engine offers no alternates (a Valhalla limit for
        // multi-point queries), so the preview simply shows the one path.
        const result = await platformRef.current.provider.route({
          profile: prof,
          points: [origin, ...vias, dest],
          instructions: true,
          alternatives: true,
          details: prof === 'hike',
          ...(preferences ? { preferences } : {}),
          ...(typeof headingDeg === 'number' ? { headingDeg } : {}),
        });
        if (result.paths.length === 0) throw new Error('no route found');
        const sorted = sortRouteChoices(result.paths);
        logRouteResult(reason, sorted, startedAtMs);
        return sorted;
      } catch (err) {
        diag({ event: 'route-failed', reason, error: message(err) });
        throw err;
      }
    },
    [platformRef, diag, logRouteResult],
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
      const { trace, nvdbCameras, nvdbLanes } = platformRef.current;
      if (!trace && !nvdbCameras && !nvdbLanes) return;
      // The mode this route was built for. It cannot change under a running
      // trip — only a preview switches profile — so capturing it here is the
      // same value every continuation below would have read later.
      const profile = lifecycleRef.current.profile;
      const controller = new AbortController();
      enrichAbort.current = controller;
      // Speed cameras ride the same fire-and-forget contract, but not the
      // trace pipeline — they are their own dataset, useful even where the
      // tiles carry no attributes. Car only, like the NVDB limits: ATK
      // enforcement is about driving.
      if (nvdbCameras && profile === 'car') {
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
      if (nvdbLanes && profile === 'car') {
        void nvdbLanes(path, controller.signal)
          .then((overrides) => {
            if (sessionRef.current !== session || overrides.length === 0) return;
            const refreshed = session.setLanes(overrides);
            if (refreshed) {
              setState(refreshed);
              lastStateRef.current = refreshed;
            }
          })
          .catch(() => {
            // Optional by design: older offline pack, outside Norway, or no dataset.
          });
      }
      if (!trace) return;
      const nvdb = platformRef.current.nvdbLimits;
      void enrichRoute(path, profile, trace, { signal: controller.signal })
        .then(async (base) => {
          // Layer NVDB's authoritative Norwegian limits over the tile limits
          // for a car route. Its own best-effort: a failure (offline, no
          // dataset, outside Norway) falls back to exactly `base`, so the
          // roundel never disappears because NVDB was unreachable.
          if (!nvdb || profile !== 'car') return base;
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
    [platformRef, lifecycleRef],
  );

  /**
   * What both endings release: the enrichment fetch, the puck, and the sensor
   * readings behind it. What separates them is the session and its fix watch —
   * an arrival deliberately keeps both alive (see `finishArrived`).
   */
  const releaseTelemetry = useCallback(() => {
    enrichAbort.current?.abort();
    enrichAbort.current = null;
    setPosition(null);
    setSpeedMps(null);
    setAltitudeM(null);
    setFacing(null);
    setHeadingCalibrationNeeded(false);
    setRouteAlternatives([]);
    facingBlender.current.reset();
    lastFixRef.current = null;
    offRouteSpokenRef.current = false;
  }, []);

  /**
   * Done: release the session, the watch and every trace of the trip. The
   * machine's `end` clears the lifecycle in one transition — there is no
   * longer a list of fields to remember to reset.
   */
  const stop = useCallback(() => {
    stopWatch();
    sessionRef.current = null;
    releaseTelemetry();
    setState(null);
    // End before arriving is the *normal* way a diagnostic-worthy trip ends —
    // the drive that went wrong is exactly the one nobody drives to the finish
    // — so the log is closed and summarised here just as it is on arrival.
    endTripDiagnostics('ended-early');
    dispatch({ type: 'end' });
  }, [stopWatch, releaseTelemetry, dispatch, endTripDiagnostics]);

  /** Abandon a trip that could not be set up, keeping the reason on screen. */
  const fail = useCallback(
    (err: unknown) => {
      stopWatch();
      sessionRef.current = null;
      setRouteAlternatives([]);
      releaseTelemetry();
      endTripDiagnostics('failed');
      dispatch({ type: 'failed', message: message(err) });
    },
    [stopWatch, releaseTelemetry, dispatch, endTripDiagnostics],
  );

  /**
   * End the trip with an arrival: summary, spoken confirmation, `arrived`.
   * Fires once — fixes keep flowing through the arrival card, and each one
   * still reports `arrived`, which must not re-announce it every second. That
   * is the machine's doing rather than a flag's: only a trip still being
   * guided (or paused) can arrive, so the second report transitions nothing.
   */
  const finishArrived = useCallback(
    (session: NavigationSession, traveledM: number) => {
      const before = lifecycleRef.current;
      const arrived = dispatch({ type: 'arrived', atMs: Date.now(), traveledM });
      if (arrived === before) return;
      tripArrivedRef.current = true;
      diag({ event: 'trip-arrived', traveledM, report: tripStatsRef.current?.report() ?? null });
      speak(session.arrivalText(), { kind: 'arrival' });
      // Arrival is not the end of needing a position. The last hundred metres
      // are on foot — across a car park, round a courtyard, looking for the
      // door — and that is exactly where an accurate, live puck earns its
      // keep, so the fix watch and the session stay up while the arrival card
      // is on screen. The session is already `arrived`: it keeps producing
      // positions and stops producing guidance, prompts and reroutes. Done
      // (`stop`) is what releases both, which is what the traveller means by
      // pressing it.
      releaseTelemetry();
    },
    [lifecycleRef, dispatch, speak, releaseTelemetry, diag],
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
   * retaining the route and session in memory. The transition is dispatched
   * before the native watch is torn down, because tearing one down cannot
   * retract a fix already queued across the bridge — and `onFix` refuses to
   * apply one to a trip that is no longer being guided.
   */
  const pause = useCallback(() => {
    if (!sessionRef.current || lifecycleRef.current.stage.kind !== 'guiding') return;
    dispatch({
      type: 'pause',
      atMs: Date.now(),
      traveledM: lastStateRef.current?.traveledM ?? null,
    });
    diag({ event: 'navigation-phase', from: 'navigating', to: 'paused' });
    stopWatch();
    platformRef.current.stopSpeaking();
    setSpeedMps(null);
  }, [lifecycleRef, dispatch, stopWatch, platformRef, diag]);

  const reroute = useCallback(
    async (from: Position, reason: NavRouteReason, viasOverride?: LatLng[]) => {
      const before = lifecycleRef.current;
      if (before.stage.kind !== 'guiding') return;
      // A failed reroute must not retry on every 1 Hz off-route fix — back off
      // exponentially so an unreachable routing server isn't hammered.
      if (!navMayReroute(before, Date.now())) return;
      const { trip, profile: prof } = before;
      const { plan } = before.stage;
      dispatch({ type: 'reroute-started' });
      try {
        // Pass the travel direction (only meaningful when moving) so the new
        // route continues the way the traveller points, not via a U-turn.
        const heading =
          typeof from.speedMps === 'number' && from.speedMps >= REROUTE_HEADING_MIN_SPEED_MPS
            ? from.headingDeg
            : undefined;
        // Route through the stops still ahead only — a via already visited
        // must not pull the recalculated route back to it. The trimmed list
        // becomes authoritative only if this reroute succeeds; on failure the
        // old session (and its own passed-count) lives on. `viasOverride` is
        // addStop's already-updated list, which must not be re-trimmed with a
        // passed-count belonging to the outgoing route.
        const passedVias = lastStateRef.current?.viasPassed ?? 0;
        const remainingVias =
          viasOverride ?? (passedVias > 0 ? plan.vias.slice(passedVias) : plan.vias);
        const choices = await fetchChoices(
          reason,
          from,
          plan.destination,
          prof,
          plan.preferences,
          remainingVias,
          heading,
        );
        const path = choices[0];
        if (!path) throw new Error('no route found');
        // End, arrival or a whole new trip may have happened during the fetch;
        // applying now would resurrect a dead nav UI with a fresh session.
        const live = lifecycleRef.current;
        if (live.trip !== trip || live.stage.kind !== 'guiding') return;
        // Rerouting happens mid-drive: never regress to the pre-departure
        // framing (calm camera / no snap-lock) the fresh session starts in.
        const nextSession = new NavigationSession(
          path,
          navOptionsForProfile(prof, {
            startDeparted: lastStateRef.current?.departed ?? true,
          }),
        );
        sessionRef.current = nextSession;
        // The old session dies here — its driven distance is banked onto the
        // trip's total, the trimmed stops become the plan, and any faster-route
        // offer, measured against the route that just died, lapses with it.
        const bankedM = lastStateRef.current?.traveledM ?? 0;
        dispatch({ type: 'route-replaced', path, vias: remainingVias, bankedM });
        setRouteAlternatives(
          prof === 'car' ? inDriveAlternatives(path, choices, path.timeMs, remainingVias) : [],
        );
        logRouteAdopted(reason, path, bankedM);
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
        if (depart) speak(depart.text, promptContext(depart));
        // A reroute can itself choose a materially longer line (heading,
        // closures and transient costing all affect it). Judge that new route
        // now, from the same live fix, rather than waiting out whatever is
        // left of the old route's three-minute cadence.
        resetFasterCheckRef.current();
      } catch {
        if (lifecycleRef.current.trip !== trip) return;
        // Keep the old session (the traveller continues on the drawn line) and
        // back off before the next attempt: 5 s, 10 s, 20 s … capped at 60 s.
        dispatch({ type: 'reroute-failed', atMs: Date.now() });
      } finally {
        // Only the reroute that still belongs to the live trip may release the
        // guard: a superseded one would otherwise let a second reroute in.
        if (lifecycleRef.current.trip === trip) dispatch({ type: 'reroute-settled' });
      }
    },
    [lifecycleRef, dispatch, fetchChoices, speak, enrich, logRouteAdopted],
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
    const { stage: current } = lifecycleRef.current;
    if (current.kind !== 'guiding') return;
    const fix = lastFixRef.current;
    if (!fix) return;
    const passed = lastStateRef.current?.viasPassed ?? 0;
    if (passed >= current.plan.vias.length) return;
    void reroute(fix, 'continue-past-stop', current.plan.vias.slice(passed + 1));
  }, [lifecycleRef, reroute]);

  /** Accept an offered reroute: recalculate from the last known fix. */
  const rerouteNow = useCallback(() => {
    if (lifecycleRef.current.stage.kind !== 'guiding') return;
    const fix = lastFixRef.current;
    if (!fix || !sessionRef.current) return;
    // The tap is explicit consent — don't let a backoff from an earlier
    // failed automatic attempt swallow it.
    dispatch({ type: 'reroute-forced' });
    void reroute(fix, 'reroute-requested');
  }, [lifecycleRef, dispatch, reroute]);

  /**
   * Insert a stop into the running trip and recalculate through it. The stop
   * slots into the remaining vias by along-route position — "add the gas
   * station 3 km ahead" must not leapfrog a planned stop that comes first —
   * and the final destination stays the final destination.
   */
  const addStop = useCallback(
    (stop: LatLng) => {
      const { stage: current } = lifecycleRef.current;
      if (current.kind !== 'guiding') return;
      const fix = lastFixRef.current;
      if (!fix || !sessionRef.current) return;
      const { plan, path } = current;
      const passed = lastStateRef.current?.viasPassed ?? 0;
      const remaining = passed > 0 ? plan.vias.slice(passed) : plan.vias;
      // Order along the followed line: the same leg-picking rule the planner
      // uses for a tap on the drawn route.
      const waypoints = [{ lat: fix.lat, lng: fix.lng }, ...remaining, plan.destination];
      const insertAt = viaInsertIndex(path.points, waypoints, stop);
      const vias = [...remaining];
      vias.splice(insertAt - 1, 0, stop);
      // The tap is explicit intent — a backoff from an earlier automatic
      // failure must not swallow it.
      dispatch({ type: 'reroute-forced' });
      void reroute(fix, 'add-stop', vias);
    },
    [lifecycleRef, dispatch, reroute],
  );

  /** Refresh ice risk without changing or restarting the route being driven. */
  const refreshRoadWeather = useCallback(async (): Promise<void> => {
    const before = lifecycleRef.current;
    const transport = platformRef.current.roadWeather;
    if (!transport || before.stage.kind !== 'guiding' || before.profile !== 'car') return;
    const { trip } = before;
    const { path } = before.stage;
    try {
      // Progress moves the clock: a station 10 km ahead five hours into a
      // drive is reached in minutes, not five hours from now.
      const latest = await transport(
        path.points,
        path.timeMs,
        undefined,
        lastStateRef.current?.traveledM ?? 0,
      );
      const live = lifecycleRef.current;
      if (
        live.trip === trip &&
        live.stage.kind === 'guiding' &&
        live.stage.path.points === path.points
      ) {
        setRoadWeather(latest);
      }
    } catch {
      // Keep the last good reading while offline or while DATEX refreshes.
    }
  }, [lifecycleRef, platformRef]);

  /**
   * The faster-route watch: ask the engine for today's best route from where
   * the car actually is, and compare engine estimate against engine estimate.
   * Anything better by a real margin becomes an *offer* — never a silent
   * swap, which is exactly what the off-route reroute is not allowed to be
   * either when the traveller chose the line deliberately.
   */
  const checkFasterRoute = useCallback(
    async (skipClosureCheck = false) => {
      const before = lifecycleRef.current;
      const session = sessionRef.current;
      const fix = lastFixRef.current;
      const state = lastStateRef.current;
      if (!session || !fix || !state || before.stage.kind !== 'guiding') return;
      if (before.stage.probing || before.stage.reroute.inFlight) return;
      // Only a settled, on-route, live-fix drive is worth second-guessing.
      if (state.status !== 'navigating' || state.fix !== 'live' || !state.departed) return;
      const { trip, profile: prof } = before;
      const { plan, path: currentPath } = before.stage;
      dispatch({ type: 'faster-probe-started' });
      try {
        // A closure may make a different route useful, but an on-route driver
        // still decides whether to leave the line they deliberately chose.
        // The provider excludes the closure when calculating the candidate.
        const closureTransport = platformRef.current.trafficClosures;
        let closureAhead = false;
        if (closureTransport && !skipClosureCheck) {
          const fromIndex = Math.max(
            0,
            Math.floor(state.routeProgress * Math.max(0, currentPath.points.length - 1)) - 2,
          );
          closureAhead = (await closureTransport(currentPath.points.slice(fromIndex))).length > 0;
        }
        await refreshRoadWeather();
        if (lifecycleRef.current.trip !== trip || !sessionRef.current) return;
        const plannedMs = session.plannedRemainingMs();
        const plannedM = lastStateRef.current?.distanceRemainingM ?? state.distanceRemainingM;
        if (plannedMs === null || plannedMs <= 0 || plannedM <= 0) {
          diag({ event: 'faster-probe', verdict: 'skipped', plannedMs, plannedM });
          return;
        }
        const heading =
          typeof fix.speedMps === 'number' && fix.speedMps >= 2 ? fix.headingDeg : undefined;
        const passed = state.viasPassed;
        const vias = passed > 0 ? plan.vias.slice(passed) : plan.vias;
        const choices = await fetchChoices(
          'faster-probe',
          fix,
          plan.destination,
          prof,
          plan.preferences,
          vias,
          heading,
        );
        const candidate = choices[0];
        if (!candidate) return;
        const live = lifecycleRef.current;
        if (live.trip !== trip || !sessionRef.current || live.stage.kind !== 'guiding') return;
        setRouteAlternatives(inDriveAlternatives(live.stage.path, choices, plannedMs, vias));
        const savesMs = plannedMs - candidate.timeMs;
        const savesM = Math.max(0, plannedM - candidate.distanceM);
        const qualifiesOnTime = savesMs >= FASTER_MIN_SAVING_MS;
        const qualifiesOnDistance =
          candidate.timeMs <= plannedMs &&
          candidate.distanceM <= plannedM * (1 - FASTER_MIN_DISTANCE_FRACTION);
        // Re-cutting the same road from the latest fix is not a new choice.
        // In particular, a distant closure must not cause repeated prompts
        // when Valhalla still returns the line the driver is already on.
        const closureChoice =
          closureAhead && routeAlternativeLabelPoint(currentPath.points, candidate.points) !== null;
        const dismissed = live.stage.dismissedSavingMs;
        const dismissedFloor = dismissed === null ? 0 : dismissed + FASTER_REOFFER_STEP_MS;
        // A dismissal suppresses the same distance-only choice too: after the
        // driver has declined it, only a route with a meaningfully larger time
        // advantage may interrupt again.
        const clearsDismissal = dismissed === null || savesMs >= dismissedFloor;
        const offering =
          clearsDismissal && (closureChoice || qualifiesOnTime || qualifiesOnDistance);
        const reason = closureChoice ? 'closure' : qualifiesOnTime ? 'time' : 'distance';
        diag({
          event: 'faster-probe',
          verdict: offering ? 'offered' : 'rejected',
          plannedMs,
          plannedM,
          candidateMs: candidate.timeMs,
          candidateM: candidate.distanceM,
          savesMs,
          savesM,
          reason: offering ? reason : null,
          dismissedSavingMs: dismissed,
          route: routeFingerprint(candidate),
        });
        if (offering) {
          dispatch({
            type: 'faster-offered',
            offer: { path: candidate, vias, savesMs, savesM, reason, atMs: Date.now() },
          });
          if (reason === 'closure') {
            speak('Road closure ahead. Another route is available.', {
              kind: 'alert',
              cause: 'closure',
            });
          } else if (reason === 'time') {
            const minutes = Math.round(savesMs / 60_000);
            speak(
              `A faster route is available — it saves ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
              { kind: 'alert', cause: 'faster-route', savesMs },
            );
          } else {
            const distance =
              savesM < 1000
                ? `${Math.round(savesM / 10) * 10} metres`
                : `${(savesM / 1000).toFixed(savesM < 10_000 ? 1 : 0)} kilometres`;
            speak(`A shorter route is available — it saves ${distance}.`, {
              kind: 'alert',
              cause: 'faster-route',
              savesMs,
            });
          }
        } else {
          // The advantage evaporated before the driver acted on it.
          dispatch({ type: 'faster-withdrawn' });
        }
      } catch {
        // Offline, or no route right now — the next interval asks again.
      } finally {
        if (lifecycleRef.current.trip === trip) dispatch({ type: 'faster-probe-settled' });
      }
    },
    [lifecycleRef, dispatch, platformRef, fetchChoices, speak, refreshRoadWeather, diag],
  );

  /** Install a route the driver picked from a line already visible on the map. */
  const replaceWithRouteChoice = useCallback(
    (path: RoutePath, vias: LatLng[], reason: 'faster-probe' | 'alternative-selected') => {
      const current = lifecycleRef.current;
      if (current.stage.kind !== 'guiding' || !sessionRef.current) return;
      const nextSession = new NavigationSession(
        path,
        navOptionsForProfile(current.profile, {
          startDeparted: lastStateRef.current?.departed ?? true,
        }),
      );
      const oldTraveledM = lastStateRef.current?.traveledM ?? 0;
      const fix = lastFixRef.current;
      let seeded: ReturnType<NavigationSession['update']> | null = null;
      if (fix) {
        try {
          seeded = nextSession.update(fix, Date.now());
        } catch {
          // The next live fix populates the state instead.
        }
      }
      sessionRef.current = nextSession;
      // Preview-born alternatives still begin at the departure point. Offset
      // their already-traversed prefix so switching lines cannot count the
      // first part of the drive twice; freshly probed alternatives start here
      // and naturally contribute almost zero.
      const accountingDeltaM = oldTraveledM - (seeded?.state.traveledM ?? 0);
      dispatch({ type: 'route-replaced', path, vias, bankedM: accountingDeltaM });
      setRouteAlternatives([]);
      logRouteAdopted(reason, path, accountingDeltaM);
      enrich(nextSession, path);
      if (seeded) {
        setState(seeded.state);
        lastStateRef.current = seeded.state;
      }
      const depart = nextSession.departurePrompt();
      if (depart) speak(depart.text, promptContext(depart));
      // Rebuild the grey choices from this exact position; the tapped set may
      // have originated earlier in the drive.
      resetFasterCheckRef.current();
    },
    [lifecycleRef, dispatch, logRouteAdopted, enrich, speak],
  );

  /** Take the offered route, exactly as a successful reroute would. */
  const acceptFasterRoute = useCallback(() => {
    const current = lifecycleRef.current;
    if (current.stage.kind !== 'guiding') return;
    const { offer } = current.stage;
    if (!offer || !sessionRef.current) return;
    diag({ event: 'faster-probe', verdict: 'accepted', savesMs: offer.savesMs });
    replaceWithRouteChoice(offer.path, offer.vias, 'faster-probe');
  }, [lifecycleRef, diag, replaceWithRouteChoice]);

  const selectRouteAlternative = useCallback(
    (index: number) => {
      if (!Number.isInteger(index)) return;
      const alternative = routeAlternatives[index];
      if (!alternative) return;
      diag({
        event: 'route-alternative-selected',
        index,
        deltaMs: alternative.deltaMs,
        route: routeFingerprint(alternative.path),
      });
      replaceWithRouteChoice(alternative.path, alternative.vias, 'alternative-selected');
    },
    [routeAlternatives, diag, replaceWithRouteChoice],
  );

  /** Decline the offer; only a meaningfully better one may interrupt again. */
  const dismissFasterRoute = useCallback(() => {
    const offered =
      lifecycleRef.current.stage.kind === 'guiding' && lifecycleRef.current.stage.offer;
    diag({
      event: 'faster-probe',
      verdict: 'dismissed',
      savesMs: offered ? offered.savesMs : null,
    });
    dispatch({ type: 'faster-dismissed' });
  }, [lifecycleRef, dispatch, diag]);

  const onFix = useCallback(
    (fix: Position, measuredAtMs?: number) => {
      // Stopping an Android foreground watch is asynchronous at the native
      // boundary. A final queued sample belongs to the paused interval and
      // must not move progress, fire a prompt or start a reroute.
      if (lifecycleRef.current.stage.kind === 'paused') return;
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
      const current = lifecycleRef.current;
      // A faster-route offer describes a branch from where the car *was*; once
      // stale it may already be behind, so it quietly lapses.
      const offer = current.stage.kind === 'guiding' ? current.stage.offer : null;
      if (offer && Date.now() - offer.atMs > FASTER_OFFER_TTL_MS) {
        dispatch({ type: 'faster-withdrawn' });
      }
      setSpeedMps(typeof fix.speedMps === 'number' && fix.speedMps >= 0 ? fix.speedMps : null);
      setAltitudeM(
        typeof fix.altitudeM === 'number' && Number.isFinite(fix.altitudeM) ? fix.altitudeM : null,
      );
      setPosition(fix);
      if (usesFacingHeading(current.profile) && headingSourceRef.current === 'gps') {
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
        const { state: next, prompts, match } = session.update(fix, fixAtMs);
        const live = lifecycleRef.current;
        tripStatsRef.current?.sample(navTripSample(next, fix.accuracyM ?? null), fixAtMs);
        diag({
          event: 'navigation-state',
          src: 'fix',
          stage: live.stage.kind,
          measuredAtMs: fixAtMs,
          ageMs: Date.now() - fixAtMs,
          raw: compactPosition(fix),
          state: compactNavState(next),
          ...(match ? { match: compactMatchTrace(match) } : {}),
          ...(live.stage.kind === 'guiding' && live.stage.reroute.failed
            ? { rerouteFailed: true }
            : {}),
        });
        // The first fix after a resume re-anchors the visible route at the
        // traveller's current position, but excludes forward movement made
        // while Atlas was paused from the completed-trip distance, and does
        // not replay a cue that was crossed during the pause. From here on
        // new progress counts again.
        const anchor = live.stage.kind === 'guiding' ? live.stage.resumeAnchor : null;
        if (anchor) dispatch({ type: 'resume-anchored', traveledM: next.traveledM });
        setState(next);
        lastStateRef.current = next;
        if (!anchor) for (const prompt of prompts) speak(prompt.text, promptContext(prompt));
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
          if (navOptionsForProfile(live.profile).autoReroute ?? true) {
            void reroute(fix, 'off-route');
          } else if (!offRouteSpokenRef.current) {
            offRouteSpokenRef.current = true;
            speak('You are off the route', { kind: 'alert', cause: 'off-route' });
          }
        } else {
          // Back on the line: any lingering "can't reroute" notice is stale.
          dispatch({ type: 'reroute-recovered' });
          offRouteSpokenRef.current = false;
        }
      } catch (err) {
        console.warn('navigation fix failed', err);
      }
    },
    [lifecycleRef, dispatch, reroute, speak, finishArrived, diag],
  );

  /** Resume a deliberately paused in-memory session without replacing its route. */
  const continueTrip = useCallback(async (): Promise<void> => {
    const before = lifecycleRef.current;
    const session = sessionRef.current;
    if (!session || before.stage.kind !== 'paused') return;
    const claimed = dispatch({ type: 'continue-requested' });
    // Refused: a second Resume tap, while the first still owns this trip.
    if (claimed === before) return;
    const { trip } = claimed;
    const facingReady =
      usesFacingHeading(claimed.profile) && headingSourceRef.current !== 'gps'
        ? platformRef.current.prepareFacing?.()
        : undefined;
    try {
      // Obtain a measured anchor before accepting streaming fixes. It puts the
      // puck where the traveller is now without treating the paused interval
      // as dead reckoning or replaying guidance that belonged inside it.
      const origin = await platformRef.current.currentFix(START_FIX_TIMEOUT_MS);
      await facingReady?.catch(() => undefined);
      const fixed = lifecycleRef.current;
      if (fixed.trip !== trip || sessionRef.current !== session || fixed.stage.kind !== 'paused') {
        return;
      }
      const watch = ++watchSeq.current;
      const stopFixes = await platformRef.current.watchFixes((fix, measuredAtMs) => {
        if (watch === watchSeq.current) onFix(fix, measuredAtMs);
      }, 'guidance');
      const watching = lifecycleRef.current;
      if (
        watch !== watchSeq.current ||
        watching.trip !== trip ||
        sessionRef.current !== session ||
        watching.stage.kind !== 'paused'
      ) {
        stopFixes();
        return;
      }
      watchStopRef.current = stopFixes;
      lastFixMeasuredAtRef.current = null;
      dispatch({ type: 'continue-began', atMs: Date.now() });
      onFix(origin.fix, origin.atMs);
      diag({ event: 'navigation-phase', from: 'paused', to: 'navigating' });
      if (lifecycleRef.current.stage.kind !== 'arrived') {
        speak('Navigation resumed', { kind: 'alert', cause: 'continued' });
      }
    } catch (err) {
      // A failed restart leaves the route safely paused and retryable. It does
      // not become the terminal error phase, which would discard the only
      // useful route state the traveller still has.
      const live = lifecycleRef.current;
      if (live.trip === trip && sessionRef.current === session) {
        dispatch({ type: 'continue-failed', message: message(err) });
      }
    } finally {
      dispatch({ type: 'continue-settled', trip });
    }
  }, [lifecycleRef, dispatch, platformRef, onFix, speak, diag]);

  const start = useCallback(
    async (
      dest: LatLng,
      prof: RoutingProfile = 'car',
      preferences?: Partial<RoutePreferences>,
      vias: LatLng[] = [],
    ) => {
      if (lifecycleRef.current.pending !== null) return;
      // A route preview supersedes destination-free Explorer (or any previous
      // live trip) immediately. Leaving its watch alive until Go meant Android
      // had to hand the same foreground location task from the old activity to
      // guidance at the most timing-sensitive moment, and old fixes could keep
      // driving the outgoing session behind the preview meanwhile.
      stopWatch();
      sessionRef.current = null;
      setRouteAlternatives([]);
      beginTripDiagnostics({
        activity: 'guidance',
        profile: prof,
        destination: [dest.lat, dest.lng],
        vias: vias.length,
        preferences: preferences ?? null,
      });
      const { op } = dispatch({
        type: 'start',
        plan: { destination: dest, vias, preferences },
        profile: prof,
      });
      // Nothing of the outgoing trip may show through the new one's setup.
      setState(null);
      lastStateRef.current = null;
      setSpeedMps(null);
      setAltitudeM(null);
      try {
        const origin = await platformRef.current.currentFix(START_FIX_TIMEOUT_MS);
        if (lifecycleRef.current.op !== op) return;
        dispatch({ type: 'origin-fixed', origin });
        // Route choices: the fastest plus up to two alternatives, offered
        // before guidance starts. Selecting nothing keeps the fastest.
        const paths = await fetchChoices('preview', origin.fix, dest, prof, preferences, vias);
        if (lifecycleRef.current.op !== op) return;
        dispatch({ type: 'choices-loaded', choices: paths });
      } catch (err) {
        if (lifecycleRef.current.op !== op) return;
        fail(err);
      } finally {
        dispatch({ type: 'setup-settled', op });
      }
    },
    [lifecycleRef, dispatch, platformRef, stopWatch, fetchChoices, fail, beginTripDiagnostics],
  );

  /**
   * Start a destination-free live map. The one-off fix both obtains the
   * platform permission and gives the camera an immediate position; the same
   * continuous watch as guidance then keeps it current (and, on Android,
   * keeps doing so under the foreground location service).
   */
  const explore = useCallback(
    async (prof: RoutingProfile = 'car') => {
      if (lifecycleRef.current.pending !== null) return;
      const facingReady =
        usesFacingHeading(prof) && headingSourceRef.current !== 'gps'
          ? platformRef.current.prepareFacing?.()
          : undefined;
      stopWatch();
      sessionRef.current = null;
      setRouteAlternatives([]);
      beginTripDiagnostics({ activity: 'explorer', profile: prof, destination: null });
      const { op } = dispatch({ type: 'explore', profile: prof });
      setState(null);
      lastStateRef.current = null;
      setSpeedMps(null);
      setAltitudeM(null);
      setPosition(null);
      lastFixMeasuredAtRef.current = null;
      try {
        const origin = await platformRef.current.currentFix(START_FIX_TIMEOUT_MS);
        await facingReady?.catch(() => undefined);
        if (lifecycleRef.current.op !== op) return;
        onFix(origin.fix, origin.atMs);
        const watch = ++watchSeq.current;
        const stopFixes = await platformRef.current.watchFixes((fix, measuredAtMs) => {
          if (watch === watchSeq.current) onFix(fix, measuredAtMs);
        }, 'explorer');
        if (watch !== watchSeq.current || lifecycleRef.current.op !== op) {
          stopFixes();
          return;
        }
        watchStopRef.current = stopFixes;
      } catch (err) {
        if (lifecycleRef.current.op !== op) return;
        fail(err);
      } finally {
        dispatch({ type: 'setup-settled', op });
      }
    },
    [lifecycleRef, dispatch, platformRef, stopWatch, onFix, fail, beginTripDiagnostics],
  );

  // Profile switch on the preview card: refetch the choices for the same trip.
  // On failure the previous profile's choices stay up (with a note) — a dead
  // end here (no bike route, brief offline) must not kill the whole preview.
  const setProfile = useCallback(
    (prof: RoutingProfile) => {
      const current = lifecycleRef.current;
      if (current.stage.kind !== 'preview' || prof === current.profile) return;
      const { origin, plan } = current.stage;
      const { op } = dispatch({ type: 'profile-requested' });
      void (async () => {
        try {
          // The stops are the plan; only the costing changes with the profile.
          const paths = await fetchChoices(
            'preview-profile',
            origin.fix,
            plan.destination,
            prof,
            undefined,
            plan.vias,
          );
          if (lifecycleRef.current.op !== op) return;
          dispatch({ type: 'profile-loaded', profile: prof, choices: paths });
        } catch (err) {
          if (lifecycleRef.current.op !== op) return;
          dispatch({ type: 'profile-failed', message: message(err) });
        }
      })();
    },
    [lifecycleRef, dispatch, fetchChoices],
  );

  /**
   * Hand a chosen path to a fresh session and start guiding along it — the
   * moment a *plan* becomes a *trip*, shared by Start and by resuming an
   * interrupted one. Everything here is about the trip beginning: a session
   * that has not departed yet, a zeroed distance bank (or the interrupted
   * trip's own banks, restored), the fix watch, and the departure prompt that
   * answers "which way now?".
   */
  const beginGuidance = useCallback(
    async (
      path: RoutePath,
      origin: NavOriginFix | null,
      restoredProgress?: NavTripProgress,
      choices: readonly RoutePath[] = [],
    ) => {
      const begun = dispatch({
        type: 'guidance-began',
        path,
        atMs: Date.now(),
        progress: restoredProgress,
      });
      // Only a stage that still holds a plan can become a trip.
      if (begun.stage.kind !== 'guiding') return;
      const session = new NavigationSession(path, navOptionsForProfile(begun.profile));
      sessionRef.current = session;
      setRouteAlternatives(
        begun.profile === 'car'
          ? inDriveAlternatives(path, choices, path.timeMs, begun.stage.plan.vias)
          : [],
      );
      offRouteSpokenRef.current = false;
      logRouteAdopted('departure', path, 0);
      enrich(session, path);
      lastStateRef.current = null;
      setState(null);

      // A fresh trip owns a fresh ordering window. Set this before starting
      // the streams: if watchPositionAsync immediately emits a newer sample,
      // the origin applied below is correctly rejected rather than rewinding
      // the session.
      lastFixMeasuredAtRef.current = null;

      stopWatch();
      const watch = ++watchSeq.current;
      const stopFixes = await platformRef.current.watchFixes((fix, measuredAtMs) => {
        if (watch === watchSeq.current) onFix(fix, measuredAtMs);
      }, 'guidance');
      // End (or another trip) while the watch was starting: don't leave one live.
      if (watch !== watchSeq.current || sessionRef.current !== session) {
        stopFixes();
        return;
      }
      watchStopRef.current = stopFixes;
      // Guidance used to be silent until the first approach threshold —
      // exactly when the traveller wonders "which way?".
      const depart = session.departurePrompt();
      if (depart) speak(depart.text, promptContext(depart));
      // Show a state at once rather than waiting for the watch's first fix,
      // but only if the origin fix is still recent — someone who studied the
      // choices for a minute has moved, and a stale fix misplaces the puck.
      if (origin && Date.now() - origin.atMs < ORIGIN_FRESH_MS) onFix(origin.fix, origin.atMs);
    },
    [dispatch, platformRef, enrich, stopWatch, onFix, speak, logRouteAdopted],
  );

  const go = useCallback(async () => {
    const before = lifecycleRef.current;
    if (before.stage.kind !== 'preview') return;
    // Invoke this before the first await: iOS Safari accepts its orientation
    // prompt only while the Start button's user gesture is still on the stack.
    const facingReady =
      usesFacingHeading(before.profile) && headingSourceRef.current !== 'gps'
        ? platformRef.current.prepareFacing?.()
        : undefined;
    const { plan, choices, index } = before.stage;
    const previewPath = choices[index];
    if (!previewPath) return;
    const { op } = dispatch({ type: 'go' });
    try {
      let path = previewPath;
      let guidanceChoices = choices;
      let origin = before.stage.origin;
      // The traveller may have moved while studying the choices, so refresh
      // both the fix and the routes from it. Best-effort: starting on the
      // previewed path beats refusing to navigate because a Start-time
      // refresh was briefly unavailable.
      try {
        const fresh = await platformRef.current.currentFix(GO_FIX_TIMEOUT_MS);
        const refreshed = await fetchChoices(
          'depart-refresh',
          fresh.fix,
          plan.destination,
          before.profile,
          plan.preferences,
          plan.vias,
        );
        if (lifecycleRef.current.op !== op) return;
        path = refreshed[index] ?? refreshed[0] ?? previewPath;
        guidanceChoices = refreshed;
        origin = fresh;
        dispatch({ type: 'origin-refreshed', origin: fresh });
      } catch {
        // Keep the previewed path and its origin fix.
      }

      // Cancel or profile switch while the refresh was in flight invalidates it.
      if (lifecycleRef.current.op !== op) return;
      await facingReady?.catch(() => undefined);
      await beginGuidance(path, origin, undefined, guidanceChoices);
    } catch (err) {
      fail(err);
    } finally {
      // A no-op wherever this Start no longer owns the preview — which is
      // every path but a failure that left one standing.
      dispatch({ type: 'go-settled', op });
    }
  }, [lifecycleRef, dispatch, platformRef, fetchChoices, beginGuidance, fail]);

  const selectPreview = useCallback(
    (index: number) => {
      // Out of range, fractional, or not in the preview at all: the machine
      // refuses every one of them, so there is nothing to check here.
      dispatch({ type: 'preview-selected', index });
    },
    [dispatch],
  );

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
      if (lifecycleRef.current.pending !== null) return;
      const facingReady =
        usesFacingHeading(prof) && headingSourceRef.current !== 'gps'
          ? platformRef.current.prepareFacing?.()
          : undefined;
      beginTripDiagnostics({
        activity: 'guidance',
        profile: prof,
        destination: [dest.lat, dest.lng],
        vias: vias.length,
        resumed: true,
      });
      const { op } = dispatch({
        type: 'resume',
        plan: { destination: dest, vias, preferences: preferencesOverride },
        profile: prof,
      });
      setRouteAlternatives([]);
      setSpeedMps(null);
      setAltitudeM(null);
      try {
        const origin = await platformRef.current.currentFix(START_FIX_TIMEOUT_MS);
        if (lifecycleRef.current.op !== op) return;
        dispatch({ type: 'origin-fixed', origin });
        const choices = await fetchChoices(
          'resume',
          origin.fix,
          dest,
          prof,
          preferencesOverride,
          vias,
        );
        const path = choices[0];
        if (!path) throw new Error('no route found');
        if (lifecycleRef.current.op !== op) return;
        await facingReady?.catch(() => undefined);
        await beginGuidance(path, origin, progress, choices);
      } catch (err) {
        if (lifecycleRef.current.op !== op) return;
        fail(err);
      } finally {
        // Guidance has long since taken the machine past this operation, so
        // this releases nothing it does not still own. The double-tap guard
        // that had to be hand-cleared before `beginGuidance` — or it stayed
        // latched for good — went with the counter it used to live beside.
        dispatch({ type: 'setup-settled', op });
      }
    },
    [lifecycleRef, dispatch, platformRef, fetchChoices, beginGuidance, fail, beginTripDiagnostics],
  );

  const guiding = stage.kind === 'guiding';
  const liveFollowing = guiding || stage.kind === 'exploring';
  const profile = lifecycle.profile;
  const activePath = navPath(lifecycle);
  const viaPoints = navPlan(lifecycle)?.vias ?? NO_VIAS;
  // The drawn line is the followed path, not a second copy of it kept in step.
  const routeCoords = useMemo(
    () => activePath?.points.map((p) => [p.lng, p.lat]) ?? [],
    [activePath],
  );
  const offer = guiding ? stage.offer : null;
  const fasterRoute = useMemo<NavFasterRoute | null>(
    () => (offer ? { savesMs: offer.savesMs, savesM: offer.savesM, reason: offer.reason } : null),
    [offer],
  );
  const tripProgress = navTripProgress(lifecycle, Date.now(), state?.traveledM ?? 0);

  // A new/re-routed path arrives with the road-weather result fetched beside
  // its traffic price. Mid-drive refreshes then replace this local copy.
  useEffect(() => {
    setRoadWeather(activePath?.roadWeather ?? null);
  }, [activePath?.points]);

  // Warnings place stations along the path's own points, as `traveledM` does;
  // the engine's `distanceM` is a different metre and drifts over a long trip.
  const traveledOnPathM = activePath ? (state?.traveledM ?? 0) : 0;
  const roadWeatherWarning = useMemo(() => {
    const warning = roadWeather?.warnings.find((entry) => entry.atM >= traveledOnPathM - 500);
    if (!warning) return null;
    const distanceAheadM = Math.max(0, warning.atM - traveledOnPathM);
    return distanceAheadM <= 20_000 ? { ...warning, distanceAheadM } : null;
  }, [roadWeather, traveledOnPathM]);
  // Keyed by station (the warning id), not by reading: an observation that
  // refreshes during the approach is the same hazard, announced once.
  const spokenWeatherRef = useRef<string | null>(null);
  useEffect(() => {
    if (!guiding) {
      spokenWeatherRef.current = null;
      return;
    }
    if (
      roadWeatherWarning &&
      roadWeatherWarning.distanceAheadM <= 10_000 &&
      spokenWeatherRef.current !== roadWeatherWarning.id
    ) {
      spokenWeatherRef.current = roadWeatherWarning.id;
      speak(
        `${roadWeatherWarning.risk === 'high' ? 'Ice risk' : 'Possible ice'} ahead near ${roadWeatherWarning.stationName}.`,
        { kind: 'alert', cause: 'road-weather' },
      );
    }
  }, [guiding, roadWeatherWarning, speak]);

  // Session heartbeat: dead-reckons through GPS gaps (tunnels) and flips the
  // state to signal-lost when fixes stop, so the puck never just freezes.
  useEffect(() => {
    if (!guiding) return;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      try {
        const nowMs = Date.now();
        const update = session.tick(nowMs);
        if (!update) return;
        setState(update.state);
        lastStateRef.current = update.state;
        // Reckoned states are logged like measured ones (`src` tells them
        // apart): a tunnel transit is precisely the stretch a report needs,
        // and it is the stretch with no fixes to record.
        tripStatsRef.current?.sample(navTripSample(update.state, null), nowMs);
        diag({
          event: 'navigation-state',
          src: 'tick',
          measuredAtMs: nowMs,
          state: compactNavState(update.state),
        });
        for (const prompt of update.prompts) speak(prompt.text, promptContext(prompt));
      } catch (err) {
        console.warn('navigation tick failed', err);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [guiding, speak, diag]);

  // The faster-route watch. Driving modes only — the same modes that reroute
  // automatically: on foot the "fastest" route barely moves, and the walker
  // chose their path. Deliberately a slow cadence: this exists to catch a
  // world that changed (a closure ahead, a mistake at the preview), not to
  // second-guess every kilometre, and each check is a full route request.
  useEffect(() => {
    resetFasterCheckRef.current = () => undefined;
    if (!guiding) return;
    if (!(navOptionsForProfile(profile).autoReroute ?? true)) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let generation = 0;
    const schedule = (delayMs: number, skipClosureCheck = false) => {
      generation++;
      const scheduledGeneration = generation;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void checkFasterRoute(skipClosureCheck).finally(() => {
          // A successful reroute may have scheduled an immediate probe while
          // this probe was still running (the closure path). Do not let the
          // older completion overwrite that new schedule.
          if (generation === scheduledGeneration) schedule(FASTER_CHECK_INTERVAL_MS);
        });
      }, delayMs);
    };
    // The route just installed already handled any closure that caused its
    // replacement. Rechecking that same closure before the vehicle has moved
    // can loop forever when the engine has no avoiding line; this immediate
    // pass is for comparing the new route, while the next periodic pass owns
    // closure discovery again.
    const reset = () => schedule(0, true);
    resetFasterCheckRef.current = reset;
    schedule(FASTER_CHECK_INTERVAL_MS);
    return () => {
      generation++;
      if (timer !== null) clearTimeout(timer);
      if (resetFasterCheckRef.current === reset) resetFasterCheckRef.current = () => undefined;
    };
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
      // The Android rotation-vector feed arrives at 20 Hz. Preserve that
      // responsiveness while ignoring sub-degree sensor noise. It is active
      // only for non-driving live guidance, where the arrow is being watched.
      const delta =
        lastSetDeg === null ? 180 : Math.abs(((sample.deg - lastSetDeg + 540) % 360) - 180);
      if (now - lastSetMs < FACING_REFRESH_MS || delta < FACING_REFRESH_DEG) return;
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
        const live = lifecycleRef.current;
        const following = live.stage.kind === 'guiding' || live.stage.kind === 'exploring';
        if (usesFacingHeading(live.profile) && following) {
          void platformRef.current.prepareFacing?.().catch(() => undefined);
        }
      }
    },
    [lifecycleRef, platformRef],
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
    activity: navActivity(lifecycle),
    state,
    position,
    routeCoords,
    activePath,
    profile,
    preferences: navPlan(lifecycle)?.preferences ?? null,
    destination: navDestination(lifecycle),
    viaPoints,
    nextIntermediateStop: viaPoints[state?.viasPassed ?? 0] ?? null,
    previewPaths: stage.kind === 'preview' ? stage.choices : null,
    previewIndex: stage.kind === 'preview' ? stage.index : 0,
    previewLoading: stage.kind === 'preview' ? stage.loading : false,
    previewError: stage.kind === 'preview' ? stage.error : null,
    routeAlternatives,
    speedMps,
    altitudeM,
    roadWeatherWarning,
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
    selectRouteAlternative,
    addStop,
    continuePastIntermediateStop,
    tripSummary: stage.kind === 'arrived' ? stage.summary : null,
    tripProgress,
    rerouteFailed: guiding && stage.reroute.failed,
    error: stage.kind === 'failed' ? stage.message : stage.kind === 'paused' ? stage.error : null,
    start,
    explore,
    selectPreview,
    setProfile,
    go,
    resume,
    pause,
    continueTrip,
    toggleMute,
    setMuted,
    arriveNow,
    rerouteNow,
    stop,
  };
}
