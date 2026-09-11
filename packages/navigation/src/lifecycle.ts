/**
 * The navigation lifecycle as one explicit state machine.
 *
 * `NavigationSession` owns the high-frequency half of navigation — fixes in,
 * guidance out. What was left in the controller was the low-frequency half:
 * which trip is running, what it was planned as, which asynchronous request is
 * still allowed to land, and what has already been banked. That half used to be
 * two dozen independent React states beside a similar number of refs, so states
 * like "idle but still holding a destination", "preview built from a superseded
 * request" or "an old reroute taking ownership of a newer trip" were
 * representable and prevented only by every command clearing the right subset
 * of fields by hand.
 *
 * Here they are not representable. Each stage carries the data that is legal in
 * it and nothing else, every transition has a name, and both identities — the
 * trip, and the setup operation — live on the machine instead of in counters
 * beside it. The reducer is pure and takes each clock reading as an event
 * field, so the whole lifecycle is testable without React, a platform or a
 * route provider.
 *
 * Deliberately *not* modelled here: `NavState`, speed, altitude and facing.
 * They change at sensor rate, and folding them in would make every fix a
 * lifecycle transition for no gain — the controller keeps them as telemetry.
 */

import type { LatLng } from '@atlas/core';
import type { RoutePath, RoutePreferences, RoutingProfile } from '@atlas/routing';

import type { Position } from './model.js';

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

/** A one-off fix, with the wall-clock time it was *measured* (not received). */
export interface NavOriginFix {
  fix: Position;
  atMs: number;
}

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

/** A better route the periodic watch found, offered rather than imposed. */
export interface NavFasterRoute {
  /** Time it saves over the engine's own estimate for the current route. */
  savesMs: number;
  /** Distance it saves over the remaining followed route. */
  savesM: number;
  /** The threshold that made this route worth interrupting the driver for. */
  reason: 'time' | 'distance';
}

/**
 * What the traveller asked for, as opposed to what is being followed: the
 * destination, the stops still owed, and the planner's routing choices. Every
 * reroute is calculated from this, which is why it outlives each route.
 */
export interface NavPlan {
  destination: LatLng;
  /** Intermediate stops the *current* route still visits, in visiting order. */
  vias: LatLng[];
  /** Planner choices (avoid tolls, ferries …), or undefined for profile defaults. */
  preferences?: Partial<RoutePreferences>;
}

/**
 * Trip clocks and distance banks. They survive each reroute — every reroute
 * starts a fresh `NavigationSession` whose own totals restart at zero — so the
 * arrival card can describe the whole trip rather than its last leg.
 */
export interface NavAccounting {
  /** The engine's estimate at departure, deliberately unchanged by reroutes. */
  originalEstimateMs: number;
  /** Active (not paused) time banked before the segment now running. */
  elapsedMsBanked: number;
  /** When the running segment started; null while paused. */
  segmentStartedAtMs: number | null;
  /** Distance completed on earlier sessions of this trip. */
  traveledBaseM: number;
}

/** Automatic rerouting's own health: in flight, and how long it must wait. */
export interface NavRerouteState {
  inFlight: boolean;
  /** True while off-route but the recalculation keeps failing. */
  failed: boolean;
  /** Consecutive failures, driving the backoff exponent. */
  failures: number;
  /** Earliest time (epoch ms) a failed reroute may be retried. */
  backoffUntilMs: number;
}

const IDLE_REROUTE: NavRerouteState = {
  inFlight: false,
  failed: false,
  failures: 0,
  backoffUntilMs: 0,
};

/** The faster-route offer's payload; the public controller shows only the saving. */
export interface NavFasterOffer {
  path: RoutePath;
  vias: LatLng[];
  savesMs: number;
  savesM: number;
  reason: 'time' | 'distance';
  atMs: number;
}

export type NavStage =
  | { kind: 'idle' }
  /** A trip is being set up: waiting for a fix, then for routes. */
  | {
      kind: 'starting';
      /** Whether this ends in a preview card or straight in guidance. */
      intent: 'preview' | 'resume';
      plan: NavPlan;
      /** The fix the routes will be built from, once it has arrived. */
      origin: NavOriginFix | null;
    }
  /** Route choices offered, none of them being followed yet. */
  | {
      kind: 'preview';
      plan: NavPlan;
      origin: NavOriginFix;
      choices: RoutePath[];
      index: number;
      /** True while a profile switch or the Start-time refresh is in flight. */
      loading: boolean;
      /** Why the last profile switch kept the old choices (no route, offline …). */
      error: string | null;
    }
  /** Following the traveller with no destination, route, prompts or rerouting. */
  | { kind: 'exploring' }
  | {
      kind: 'guiding';
      plan: NavPlan;
      /** The route being followed. */
      path: RoutePath;
      accounting: NavAccounting;
      reroute: NavRerouteState;
      offer: NavFasterOffer | null;
      /** Saving the driver last declined — the bar a new offer must clear. */
      dismissedSavingMs: number | null;
      /** One faster-route probe at a time; a slow answer must not stack more. */
      probing: boolean;
      /**
       * Set for the first fix after a resume: it re-anchors the puck without
       * counting the paused interval as travel, and without replaying a cue
       * that was crossed while the trip stood still.
       */
      resumeAnchor: { fromTraveledM: number | null } | null;
    }
  /** Frozen in place: no fixes, prompts, reroutes, PiP or wake lock. */
  | {
      kind: 'paused';
      plan: NavPlan;
      path: RoutePath;
      accounting: NavAccounting;
      /** Along-route progress at Pause, so the gap is not counted as travel. */
      pausedAtTraveledM: number | null;
      /**
       * A Continue is in flight. It lives on the stage rather than on the
       * machine's `pending` because it guards *this paused trip*, not a new
       * one: a Resume waiting on a slow fix must not stop the traveller
       * abandoning the trip and starting a different one.
       */
      resuming: boolean;
      /** Why the last Continue failed; the trip stays safely paused. */
      error: string | null;
    }
  /** The trip is over. The fix watch and session stay up behind the card. */
  | { kind: 'arrived'; destination: LatLng; summary: NavTripSummary }
  /** Setup failed; the reason stays on screen with the activity that failed. */
  | { kind: 'failed'; activity: Exclude<NavActivity, null>; message: string };

export interface NavLifecycle {
  /**
   * Trip identity. Bumped whenever ownership changes (Start, Go, Pause, End,
   * arrival) so an asynchronous reroute, faster-route probe or traffic
   * re-pricing that captured it can tell that it no longer speaks for the
   * running trip — the race that would otherwise flip a fresh preview into
   * `navigating` as an abandoned trip's route lands.
   */
  readonly trip: number;
  /**
   * Setup-operation identity. Bumped whenever a request for *choices* is
   * superseded (a new Start, a profile switch, Go, Explore, or anything that
   * drops the preview), so a late response for an abandoned one is discarded.
   */
  readonly op: number;
  /**
   * The `op` of the setup command in flight (Start, Explore or Resume — the
   * commands that claim a new trip), or null when none is. It is the double-tap guard *and* its own
   * release token: a command settles the machine only while it still owns the
   * operation, so a superseded one can no longer unlatch the guard a newer
   * command is holding.
   */
  readonly pending: number | null;
  /**
   * The routing mode. Machine-wide rather than per stage: it is the mode the
   * planner is in, it is legal in every stage, and it deliberately outlives a
   * trip so the next one starts in the mode the traveller last chose.
   */
  readonly profile: RoutingProfile;
  readonly stage: NavStage;
}

export const NAV_LIFECYCLE_INITIAL: NavLifecycle = {
  trip: 0,
  op: 0,
  pending: null,
  profile: 'car',
  stage: { kind: 'idle' },
};

export type NavEvent =
  /** Look up route choices to a destination: the two-step start's first step. */
  | { type: 'start'; plan: NavPlan; profile: RoutingProfile }
  /** Pick an interrupted trip back up — same plan, no preview. */
  | { type: 'resume'; plan: NavPlan; profile: RoutingProfile }
  /** Follow the live position with no destination. */
  | { type: 'explore'; profile: RoutingProfile }
  /** A setup command is over, however it went — it releases only its own guard. */
  | { type: 'setup-settled'; op: number }
  /** The fix a setup request was waiting for. */
  | { type: 'origin-fixed'; origin: NavOriginFix }
  /** A fresher fix, taken when Start is pressed on a preview that has aged. */
  | { type: 'origin-refreshed'; origin: NavOriginFix }
  | { type: 'choices-loaded'; choices: RoutePath[] }
  | { type: 'preview-selected'; index: number }
  /** A profile switch on the preview card is in flight. */
  | { type: 'profile-requested' }
  | { type: 'profile-loaded'; profile: RoutingProfile; choices: RoutePath[] }
  | { type: 'profile-failed'; message: string }
  /** Start pressed: the choices are settled and a refresh may be in flight. */
  | { type: 'go' }
  /** That refresh is over, however it went (the preview may still be up). */
  | { type: 'go-settled'; op: number }
  /** A plan has become a trip: this is where guidance owns the machine. */
  | { type: 'guidance-began'; path: RoutePath; atMs: number; progress?: NavTripProgress }
  | { type: 'reroute-started' }
  /**
   * The followed route was replaced — by a reroute, an accepted faster route or
   * a continuation past a stop. `bankedM` is the dying session's distance.
   */
  | { type: 'route-replaced'; path: RoutePath; vias: LatLng[]; bankedM: number }
  | { type: 'reroute-failed'; atMs: number }
  | { type: 'reroute-settled' }
  /** Back on the drawn line: a lingering "can't reroute" notice is stale. */
  | { type: 'reroute-recovered' }
  /** An explicit tap consents to recalculating now, backoff or not. */
  | { type: 'reroute-forced' }
  | { type: 'faster-probe-started' }
  | { type: 'faster-probe-settled' }
  | { type: 'faster-offered'; offer: NavFasterOffer }
  /** The offer lapsed, expired or was overtaken by a new route. */
  | { type: 'faster-withdrawn' }
  | { type: 'faster-dismissed' }
  /** Same roads, new schedule: live traffic re-priced the followed route. */
  | { type: 'path-repriced'; path: RoutePath }
  /** The first fix after a resume has been applied. */
  | { type: 'resume-anchored'; traveledM: number }
  | { type: 'pause'; atMs: number; traveledM: number | null }
  | { type: 'continue-requested' }
  | { type: 'continue-began'; atMs: number }
  | { type: 'continue-failed'; message: string }
  /** That Continue is over, however it went; only its own trip's guard opens. */
  | { type: 'continue-settled'; trip: number }
  | { type: 'arrived'; atMs: number; traveledM: number }
  /** Done: release everything and go back to idle. */
  | { type: 'end' }
  /** A trip that could not be set up, keeping the reason on screen. */
  | { type: 'failed'; message: string };

/** The plan a stage is working on, or null where a plan would be meaningless. */
export function navPlan(state: NavLifecycle): NavPlan | null {
  const { stage } = state;
  switch (stage.kind) {
    case 'starting':
    case 'preview':
    case 'guiding':
    case 'paused':
      return stage.plan;
    default:
      return null;
  }
}

/** Where the trip is headed, for the finish marker. */
export function navDestination(state: NavLifecycle): LatLng | null {
  if (state.stage.kind === 'arrived') return state.stage.destination;
  return navPlan(state)?.destination ?? null;
}

/** The route being followed, or null when nothing is. */
export function navPath(state: NavLifecycle): RoutePath | null {
  const { stage } = state;
  if (stage.kind === 'guiding' || stage.kind === 'paused') return stage.path;
  return null;
}

function navAccounting(state: NavLifecycle): NavAccounting | null {
  const { stage } = state;
  if (stage.kind === 'guiding' || stage.kind === 'paused') return stage.accounting;
  return null;
}

export function navPhase(state: NavLifecycle): NavPhase {
  const { stage } = state;
  switch (stage.kind) {
    case 'idle':
      return 'idle';
    case 'starting':
      return 'starting';
    case 'preview':
      return 'preview';
    case 'exploring':
      return 'exploring';
    case 'guiding':
      return stage.reroute.inFlight ? 'rerouting' : 'navigating';
    case 'paused':
      return 'paused';
    case 'arrived':
      return 'arrived';
    case 'failed':
      return 'error';
  }
}

/** The kind of live-location session, retained on its error card until End. */
export function navActivity(state: NavLifecycle): NavActivity {
  const { stage } = state;
  switch (stage.kind) {
    case 'idle':
      return null;
    case 'exploring':
      return 'explorer';
    case 'failed':
      return stage.activity;
    default:
      return 'guidance';
  }
}

/** Running totals for process restoration; null outside an active trip. */
export function navTripProgress(state: NavLifecycle, nowMs: number, traveledM: number) {
  const accounting = navAccounting(state);
  if (!accounting) return null;
  return {
    distanceM: Math.max(0, accounting.traveledBaseM + traveledM),
    elapsedMs:
      accounting.elapsedMsBanked +
      (accounting.segmentStartedAtMs === null
        ? 0
        : Math.max(0, nowMs - accounting.segmentStartedAtMs)),
    originalEstimateMs: accounting.originalEstimateMs,
  } satisfies NavTripProgress;
}

/** Whether a reroute may be attempted now: not already running, and past the backoff. */
export function navMayReroute(state: NavLifecycle, nowMs: number): boolean {
  const { stage } = state;
  if (stage.kind !== 'guiding') return false;
  return !stage.reroute.inFlight && nowMs >= stage.reroute.backoffUntilMs;
}

/** Bank the running segment's time exactly once (Pause, arrival or End). */
function bank(accounting: NavAccounting, atMs: number): NavAccounting {
  if (accounting.segmentStartedAtMs === null) return accounting;
  return {
    ...accounting,
    elapsedMsBanked: accounting.elapsedMsBanked + Math.max(0, atMs - accounting.segmentStartedAtMs),
    segmentStartedAtMs: null,
  };
}

/** A failed reroute waits 5 s, 10 s, 20 s … capped at a minute. */
function backoffMs(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * The lifecycle's one transition function.
 *
 * Every event that is not legal where it arrives returns the state unchanged
 * rather than throwing: the controller's asynchronous work checks trip and
 * operation identity before dispatching, and this is the second line of that
 * same defence — a result belonging to a trip that has ended can only be a
 * no-op, never a resurrection.
 */
export function navLifecycleReducer(state: NavLifecycle, event: NavEvent): NavLifecycle {
  const { stage } = state;
  switch (event.type) {
    case 'start':
      return {
        trip: state.trip + 1,
        op: state.op + 1,
        pending: state.op + 1,
        profile: event.profile,
        stage: { kind: 'starting', intent: 'preview', plan: event.plan, origin: null },
      };

    case 'resume':
      // Unlike Start this does not claim a new trip yet: the trip begins when
      // guidance does, and until then a reroute from whatever came before is
      // already dead for its own reasons.
      return {
        ...state,
        op: state.op + 1,
        pending: state.op + 1,
        profile: event.profile,
        stage: { kind: 'starting', intent: 'resume', plan: event.plan, origin: null },
      };

    case 'explore':
      return {
        ...state,
        op: state.op + 1,
        pending: state.op + 1,
        profile: event.profile,
        stage: { kind: 'exploring' },
      };

    case 'setup-settled':
      return state.pending === event.op ? { ...state, pending: null } : state;

    case 'origin-fixed':
      if (stage.kind !== 'starting') return state;
      return { ...state, stage: { ...stage, origin: event.origin } };

    case 'origin-refreshed':
      if (stage.kind !== 'preview') return state;
      return { ...state, stage: { ...stage, origin: event.origin } };

    case 'choices-loaded':
      if (stage.kind !== 'starting' || stage.origin === null) return state;
      return {
        ...state,
        stage: {
          kind: 'preview',
          plan: stage.plan,
          origin: stage.origin,
          choices: event.choices,
          index: 0,
          loading: false,
          error: null,
        },
      };

    case 'preview-selected':
      if (stage.kind !== 'preview') return state;
      if (!Number.isInteger(event.index)) return state;
      if (event.index < 0 || event.index >= stage.choices.length) return state;
      return { ...state, stage: { ...stage, index: event.index } };

    case 'profile-requested':
      if (stage.kind !== 'preview') return state;
      return { ...state, op: state.op + 1, stage: { ...stage, loading: true, error: null } };

    case 'profile-loaded':
      if (stage.kind !== 'preview') return state;
      return {
        ...state,
        profile: event.profile,
        stage: {
          ...stage,
          // The stops are the plan; only the costing changed, and the previous
          // profile's planner preferences do not carry to a different mode.
          plan: { ...stage.plan, preferences: undefined },
          choices: event.choices,
          index: 0,
          loading: false,
          error: null,
        },
      };

    case 'profile-failed':
      if (stage.kind !== 'preview') return state;
      return { ...state, stage: { ...stage, loading: false, error: event.message } };

    case 'go':
      if (stage.kind !== 'preview') return state;
      return { ...state, op: state.op + 1, stage: { ...stage, loading: true } };

    case 'go-settled':
      // Only while this Start still owns the preview: a newer operation has
      // its own spinner, and clearing that one would be a lie.
      if (stage.kind !== 'preview' || state.op !== event.op) return state;
      return { ...state, stage: { ...stage, loading: false } };

    case 'guidance-began': {
      const plan = navPlan(state);
      if (!plan) return state;
      return {
        ...state,
        trip: state.trip + 1,
        // Whatever preview stood behind this is gone with it.
        op: state.op + 1,
        pending: null,
        stage: {
          kind: 'guiding',
          plan,
          path: event.path,
          accounting: {
            originalEstimateMs: event.progress?.originalEstimateMs ?? event.path.timeMs,
            elapsedMsBanked: event.progress?.elapsedMs ?? 0,
            segmentStartedAtMs: event.atMs,
            traveledBaseM: event.progress?.distanceM ?? 0,
          },
          reroute: IDLE_REROUTE,
          offer: null,
          dismissedSavingMs: null,
          probing: false,
          resumeAnchor: null,
        },
      };
    }

    case 'reroute-started':
      if (stage.kind !== 'guiding') return state;
      return { ...state, stage: { ...stage, reroute: { ...stage.reroute, inFlight: true } } };

    case 'route-replaced':
      if (stage.kind !== 'guiding') return state;
      return {
        ...state,
        stage: {
          ...stage,
          plan: { ...stage.plan, vias: event.vias },
          path: event.path,
          accounting: {
            ...stage.accounting,
            traveledBaseM: stage.accounting.traveledBaseM + event.bankedM,
          },
          reroute: IDLE_REROUTE,
          // Any offer was measured against the route that just died.
          offer: null,
        },
      };

    case 'reroute-failed': {
      if (stage.kind !== 'guiding') return state;
      const failures = stage.reroute.failures + 1;
      return {
        ...state,
        stage: {
          ...stage,
          reroute: {
            inFlight: false,
            failed: true,
            failures,
            backoffUntilMs: event.atMs + backoffMs(failures),
          },
        },
      };
    }

    case 'reroute-settled':
      if (stage.kind !== 'guiding' || !stage.reroute.inFlight) return state;
      return { ...state, stage: { ...stage, reroute: { ...stage.reroute, inFlight: false } } };

    case 'reroute-recovered':
      if (stage.kind !== 'guiding' || !stage.reroute.failed) return state;
      return { ...state, stage: { ...stage, reroute: { ...stage.reroute, failed: false } } };

    case 'reroute-forced':
      if (stage.kind !== 'guiding') return state;
      return { ...state, stage: { ...stage, reroute: { ...stage.reroute, backoffUntilMs: 0 } } };

    case 'faster-probe-started':
      if (stage.kind !== 'guiding') return state;
      return { ...state, stage: { ...stage, probing: true } };

    case 'faster-probe-settled':
      if (stage.kind !== 'guiding' || !stage.probing) return state;
      return { ...state, stage: { ...stage, probing: false } };

    case 'faster-offered':
      if (stage.kind !== 'guiding') return state;
      return { ...state, stage: { ...stage, offer: event.offer } };

    case 'faster-withdrawn':
      if (stage.kind !== 'guiding' || stage.offer === null) return state;
      return { ...state, stage: { ...stage, offer: null } };

    case 'faster-dismissed':
      if (stage.kind !== 'guiding' || stage.offer === null) return state;
      return { ...state, stage: { ...stage, offer: null, dismissedSavingMs: stage.offer.savesMs } };

    case 'path-repriced':
      if (stage.kind !== 'guiding') return state;
      return { ...state, stage: { ...stage, path: event.path } };

    case 'resume-anchored': {
      if (stage.kind !== 'guiding' || stage.resumeAnchor === null) return state;
      const from = stage.resumeAnchor.fromTraveledM;
      return {
        ...state,
        stage: {
          ...stage,
          accounting:
            from === null
              ? stage.accounting
              : {
                  ...stage.accounting,
                  traveledBaseM:
                    stage.accounting.traveledBaseM - Math.max(0, event.traveledM - from),
                },
          resumeAnchor: null,
        },
      };
    }

    case 'pause':
      if (stage.kind !== 'guiding') return state;
      return {
        ...state,
        // A paused trip owns no in-flight work: anything still running belongs
        // to the interval that just ended.
        trip: state.trip + 1,
        stage: {
          kind: 'paused',
          plan: stage.plan,
          path: stage.path,
          accounting: bank(stage.accounting, event.atMs),
          pausedAtTraveledM: event.traveledM,
          resuming: false,
          error: null,
        },
      };

    case 'continue-requested':
      if (stage.kind !== 'paused' || stage.resuming) return state;
      return { ...state, stage: { ...stage, resuming: true, error: null } };

    case 'continue-settled':
      // Only for the paused trip that asked: `pause` claims a new trip id, so
      // a Continue that lost its trip cannot open a later one's guard.
      if (stage.kind !== 'paused' || state.trip !== event.trip || !stage.resuming) return state;
      return { ...state, stage: { ...stage, resuming: false } };

    case 'continue-began':
      if (stage.kind !== 'paused') return state;
      return {
        ...state,
        stage: {
          kind: 'guiding',
          plan: stage.plan,
          path: stage.path,
          accounting: { ...stage.accounting, segmentStartedAtMs: event.atMs },
          reroute: IDLE_REROUTE,
          offer: null,
          dismissedSavingMs: null,
          probing: false,
          resumeAnchor: { fromTraveledM: stage.pausedAtTraveledM },
        },
      };

    case 'continue-failed':
      if (stage.kind !== 'paused') return state;
      return {
        ...state,
        stage: {
          ...stage,
          accounting: { ...stage.accounting, segmentStartedAtMs: null },
          resuming: false,
          error: event.message,
        },
      };

    case 'arrived': {
      if (stage.kind !== 'guiding' && stage.kind !== 'paused') return state;
      const accounting = bank(stage.accounting, event.atMs);
      return {
        ...state,
        trip: state.trip + 1,
        op: state.op + 1,
        pending: null,
        stage: {
          kind: 'arrived',
          destination: stage.plan.destination,
          summary: {
            distanceM: accounting.traveledBaseM + event.traveledM,
            durationMs: accounting.elapsedMsBanked,
            originalEstimateMs: accounting.originalEstimateMs,
          },
        },
      };
    }

    case 'end':
      return {
        ...state,
        trip: state.trip + 1,
        op: state.op + 1,
        pending: null,
        stage: { kind: 'idle' },
      };

    case 'failed':
      return {
        ...state,
        op: state.op + 1,
        pending: null,
        stage: {
          kind: 'failed',
          // The card says which kind of live-location session failed, so
          // Explorer's permission refusal does not read as a routing failure.
          activity: navActivity(state) ?? 'guidance',
          message: event.message,
        },
      };
  }
}
