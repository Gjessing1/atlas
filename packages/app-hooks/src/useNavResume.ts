/**
 * Surviving a trip's death: remember what was being navigated, offer it back.
 *
 * A navigating phone is the one phone most likely to lose its app. The
 * foreground service can be killed under memory pressure, a crash takes the
 * process with it, and the driver who switched to a podcast for ten minutes can
 * come back to a cold start — and until now every one of those ended the trip
 * silently, with no trace of where it was going. Re-entering a destination
 * while driving is exactly the thing turn-by-turn exists to avoid.
 *
 * So guidance keeps a small device-local record of the trip's *identity* — the
 * destination, the stops still ahead, the mode and the planner's preferences —
 * and the next launch offers it back with one tap. The record is deliberately
 * not the route: what the traveller wants after a gap is a route from where
 * they are *now*, and a saved line drawn from a position ten minutes behind
 * them would be wrong in the one way that matters.
 */

import { jsonSetting, readSetting, type LatLng } from '@atlas/core';
import type { RoutePreferences, RoutingProfile } from '@atlas/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { NavTripProgress } from './useNavigationController.js';
import type { SettingsAccess } from './usePersistedSetting.js';

/**
 * How stale a record may be and still be worth offering.
 *
 * The heartbeat below dates the record while guidance runs, so this is the gap
 * between the trip dying and the app being opened again — not the trip's own
 * length. Long enough to cover a crash, a reboot or a phone that sat in a
 * pocket through a coffee stop; short enough that yesterday's commute is never
 * offered back this morning.
 */
const MAX_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * How often a running trip re-dates its record. Cheap — one `local.` settings
 * upsert, which writes no outbox row — and it is what makes the age above mean
 * "since guidance stopped" rather than "since guidance started".
 */
const HEARTBEAT_MS = 30_000;

/** A trip that was being navigated when the app went away. */
export interface ResumableTrip {
  destination: LatLng;
  /** Stops still ahead at the last heartbeat (already-passed ones are gone). */
  vias: LatLng[];
  profile: RoutingProfile;
  /** The planner's choices (avoid tolls, ferries …) that shaped the route. */
  preferences: Partial<RoutePreferences> | null;
  /** Distance left when the record was last written — the offer's "12 km to go". */
  remainingM: number | null;
  /** Totals already earned, so a process restart cannot reset the final summary. */
  progress: NavTripProgress | null;
  /** When guidance last confirmed it was alive (epoch ms). */
  atMs: number;
}

/**
 * The settings seam, which is the shared one — every persisted value in the app
 * reaches storage through the same three members, and a hook-shaped copy of
 * them per feature was one of the things DR3 removed.
 */
export type NavResumeSettings = SettingsAccess;

/** The slice of a navigation controller this hook records and restarts. */
export interface NavResumeTarget {
  phase: string;
  destination: LatLng | null;
  /** Stops of the active route in visiting order (including passed ones). */
  viaPoints: LatLng[];
  /** How many of those the traveller has already visited. */
  viasPassed: number;
  profile: RoutingProfile;
  preferences: Partial<RoutePreferences> | null;
  remainingM: number | null;
  /** Original estimate plus active time/distance already accumulated. */
  tripProgress: NavTripProgress | null;
  /** Pick the trip back up: route from here and start guiding, no preview. */
  resume: (
    destination: LatLng,
    profile: RoutingProfile,
    preferences: Partial<RoutePreferences> | undefined,
    vias: LatLng[],
    progress?: NavTripProgress,
  ) => Promise<void>;
}

export interface NavResumeController {
  /** The interrupted trip to offer, or null when there is nothing to resume. */
  resumable: ResumableTrip | null;
  /** Take the offer: guidance restarts from the current position. */
  resume: () => void;
  /** Decline it. The record is dropped — declining once is an answer. */
  dismiss: () => void;
}

/** Whether a route is still a live trip, including a deliberate pause. */
const isGuiding = (phase: string): boolean =>
  phase === 'navigating' || phase === 'rerouting' || phase === 'paused';

const isLatLng = (value: unknown): value is LatLng =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LatLng).lat === 'number' &&
  typeof (value as LatLng).lng === 'number' &&
  Number.isFinite((value as LatLng).lat) &&
  Number.isFinite((value as LatLng).lng);

/**
 * The record itself: device-local, like every navigation preference.
 *
 * `local.` is not a naming habit here — it is the storage layer's actual rule
 * (`LOCAL_SETTING_PREFIX`), and the definition states the scope in words so a
 * dropped prefix fails at import instead of publishing one phone's live trip to
 * every other device on the account. The decoder is deliberately the strictest
 * in the app: this is the one setting acted on *automatically* at launch, so a
 * half-written or hand-edited row has to degrade to "nothing to resume" rather
 * than to a trip toward `NaN`.
 *
 * Age is not decoded here. Whether a record is *readable* is a property of the
 * row; whether it is still worth offering is a question about the clock, asked
 * fresh every time it is read — see {@link parseResumableTrip}.
 */
export const NAV_TRIP_SETTING = jsonSetting<ResumableTrip | null>({
  key: 'local.nav.trip',
  scope: 'local',
  defaultValue: null,
  parse: (value) => {
    if (typeof value !== 'object' || value === null) return null;
    const raw = value as Record<string, unknown>;
    const destination = raw['destination'];
    const atMs = raw['atMs'];
    if (!isLatLng(destination)) return null;
    if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null;
    const vias = Array.isArray(raw['vias']) ? raw['vias'].filter(isLatLng) : [];
    const profile = typeof raw['profile'] === 'string' ? (raw['profile'] as RoutingProfile) : 'car';
    const preferences =
      typeof raw['preferences'] === 'object' && raw['preferences'] !== null
        ? (raw['preferences'] as Partial<RoutePreferences>)
        : null;
    const remainingM = raw['remainingM'];
    const rawProgress = raw['progress'];
    const progress =
      typeof rawProgress === 'object' &&
      rawProgress !== null &&
      typeof (rawProgress as Record<string, unknown>)['distanceM'] === 'number' &&
      Number.isFinite((rawProgress as Record<string, unknown>)['distanceM']) &&
      typeof (rawProgress as Record<string, unknown>)['elapsedMs'] === 'number' &&
      Number.isFinite((rawProgress as Record<string, unknown>)['elapsedMs']) &&
      typeof (rawProgress as Record<string, unknown>)['originalEstimateMs'] === 'number' &&
      Number.isFinite((rawProgress as Record<string, unknown>)['originalEstimateMs'])
        ? (rawProgress as unknown as NavTripProgress)
        : null;
    return {
      destination,
      vias,
      profile,
      preferences,
      remainingM: typeof remainingM === 'number' && Number.isFinite(remainingM) ? remainingM : null,
      progress,
      atMs,
    };
  },
});

/**
 * A stored record that is still worth offering, or null.
 *
 * Shape comes from {@link NAV_TRIP_SETTING}; the age check is here because it
 * is not a property of the value. A record from the *future* is a clock that
 * moved (travel, NTP) and stays offerable — the trip in it is still real.
 */
export function parseResumableTrip(
  raw: string | null | undefined,
  now: number,
): ResumableTrip | null {
  const trip = readSetting(NAV_TRIP_SETTING, raw);
  if (!trip) return null;
  return trip.atMs < now - MAX_AGE_MS ? null : trip;
}

export function useNavResume(
  settings: NavResumeSettings,
  nav: NavResumeTarget,
): NavResumeController {
  const { status, getSetting, setSetting } = settings;
  const [resumable, setResumable] = useState<ResumableTrip | null>(null);
  /** Everything about the live trip, read by the heartbeat without re-arming it. */
  const trip = useRef(nav);
  trip.current = nav;
  /** The record's own text, so an unchanged trip is not rewritten every beat. */
  const written = useRef<string | null>(null);
  /** True once the stored record has been read — before that, nothing may clear it. */
  const loaded = useRef(false);

  const guiding = isGuiding(nav.phase);

  useEffect(() => {
    if (status !== 'ready' || loaded.current) return;
    let cancelled = false;
    void getSetting(NAV_TRIP_SETTING.key).then((raw) => {
      if (cancelled) return;
      loaded.current = true;
      // A trip already running (storage went ready mid-drive) is not an offer.
      if (isGuiding(trip.current.phase)) return;
      setResumable(parseResumableTrip(raw, Date.now()));
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const clear = useCallback(() => {
    written.current = null;
    setResumable(null);
    // Written rather than deleted: `removeSetting` is not part of every
    // platform's storage seam, and an empty value parses to "nothing to
    // resume" through exactly the same path a missing row does.
    if (loaded.current) void setSetting(NAV_TRIP_SETTING.key, '');
  }, [setSetting]);

  /** Write the live trip's identity, unless it is already the stored one. */
  const record = useCallback(() => {
    const current = trip.current;
    if (!current.destination) return;
    const ahead =
      current.viasPassed > 0 ? current.viaPoints.slice(current.viasPassed) : current.viaPoints;
    const snapshot: ResumableTrip = {
      destination: current.destination,
      vias: ahead,
      profile: current.profile,
      preferences: current.preferences,
      // Rounded: a metre-by-metre remaining distance would rewrite the record
      // on every beat for a number the offer shows as "12 km".
      remainingM: current.remainingM === null ? null : Math.round(current.remainingM / 100) * 100,
      progress: current.tripProgress,
      atMs: Date.now(),
    };
    // Written through the definition, so the shape read back at launch and the
    // shape written here are one decision rather than two.
    const text = NAV_TRIP_SETTING.encode(snapshot);
    // Compare without the timestamp: the beat exists to re-date the record, but
    // an unchanged trip should not churn the row between beats.
    const identity = NAV_TRIP_SETTING.encode({ ...snapshot, atMs: 0 });
    if (identity === written.current) return;
    written.current = identity;
    void setSetting(NAV_TRIP_SETTING.key, text);
  }, [setSetting]);

  // Keep the record current while guiding, and drop it the moment the trip ends
  // on purpose — arrival, "End", or a failure the traveller has already seen.
  // Nothing is cleared before the stored record has been read, or the launch
  // that should have offered it would erase it first.
  useEffect(() => {
    if (!guiding) return;
    setResumable(null);
    record();
    const timer = setInterval(record, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      // Unmount mid-trip is the *un*intended ending — the process is going away
      // with guidance running, which is precisely what resume exists for — so
      // the record stays. Only an ended trip clears it, below.
      if (isGuiding(trip.current.phase)) return;
      clear();
    };
  }, [guiding, nav.phase, record, clear]);

  const resume = useCallback(() => {
    const offer = resumable;
    if (!offer) return;
    setResumable(null);
    void trip.current
      .resume(
        offer.destination,
        offer.profile,
        offer.preferences ?? undefined,
        offer.vias,
        offer.progress ?? undefined,
      )
      .catch(() => {
        // The controller's own error phase carries the reason; the offer is
        // spent either way — a failed resume must not re-offer on every render.
      });
  }, [resumable]);

  return { resumable, resume, dismiss: clear };
}
