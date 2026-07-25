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

import type { LatLng } from '@atlas/core';
import type { RoutePreferences, RoutingProfile } from '@atlas/routing';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Device-local, like every navigation preference: `local.` keys never sync. */
const TRIP_SETTING = 'local.nav.trip';

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
  /** When guidance last confirmed it was alive (epoch ms). */
  atMs: number;
}

export interface NavResumeSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

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
  /** Pick the trip back up: route from here and start guiding, no preview. */
  resume: (
    destination: LatLng,
    profile: RoutingProfile,
    preferences: Partial<RoutePreferences> | undefined,
    vias: LatLng[],
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

/** Whether guidance is running (either phase writes the same record). */
const isGuiding = (phase: string): boolean => phase === 'navigating' || phase === 'rerouting';

const isLatLng = (value: unknown): value is LatLng =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LatLng).lat === 'number' &&
  typeof (value as LatLng).lng === 'number' &&
  Number.isFinite((value as LatLng).lat) &&
  Number.isFinite((value as LatLng).lng);

/**
 * Parse a stored record, rejecting anything that is not a usable trip.
 *
 * Defensive on purpose: this is the one setting whose value is acted on
 * automatically at launch, and a half-written or hand-edited row must degrade
 * to "nothing to resume" rather than to a trip toward `NaN`.
 */
export function parseResumableTrip(raw: string | null, now: number): ResumableTrip | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const destination = value['destination'];
    const atMs = value['atMs'];
    if (!isLatLng(destination)) return null;
    if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null;
    // A record from the future is a clock that moved (travel, NTP); treat it as
    // fresh rather than as unreadable — the trip in it is still real.
    if (atMs < now - MAX_AGE_MS) return null;
    const vias = Array.isArray(value['vias']) ? value['vias'].filter(isLatLng) : [];
    const profile =
      typeof value['profile'] === 'string' ? (value['profile'] as RoutingProfile) : 'car';
    const preferences =
      typeof value['preferences'] === 'object' && value['preferences'] !== null
        ? (value['preferences'] as Partial<RoutePreferences>)
        : null;
    const remainingM = value['remainingM'];
    return {
      destination,
      vias,
      profile,
      preferences,
      remainingM: typeof remainingM === 'number' && Number.isFinite(remainingM) ? remainingM : null,
      atMs,
    };
  } catch {
    return null;
  }
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
    void getSetting(TRIP_SETTING).then((raw) => {
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
    if (loaded.current) setSetting(TRIP_SETTING, '');
  }, [setSetting]);

  /** Write the live trip's identity, unless it is already the stored one. */
  const record = useCallback(() => {
    const current = trip.current;
    if (!current.destination) return;
    const ahead =
      current.viasPassed > 0 ? current.viaPoints.slice(current.viasPassed) : current.viaPoints;
    const snapshot = {
      destination: current.destination,
      vias: ahead,
      profile: current.profile,
      preferences: current.preferences,
      // Rounded: a metre-by-metre remaining distance would rewrite the record
      // on every beat for a number the offer shows as "12 km".
      remainingM: current.remainingM === null ? null : Math.round(current.remainingM / 100) * 100,
      atMs: Date.now(),
    };
    const text = JSON.stringify(snapshot);
    // Compare without the timestamp: the beat exists to re-date the record, but
    // an unchanged trip should not churn the row between beats.
    const identity = JSON.stringify({ ...snapshot, atMs: 0 });
    if (identity === written.current) return;
    written.current = identity;
    setSetting(TRIP_SETTING, text);
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
  }, [guiding, record, clear]);

  const resume = useCallback(() => {
    const offer = resumable;
    if (!offer) return;
    setResumable(null);
    void trip.current
      .resume(offer.destination, offer.profile, offer.preferences ?? undefined, offer.vias)
      .catch(() => {
        // The controller's own error phase carries the reason; the offer is
        // spent either way — a failed resume must not re-offer on every render.
      });
  }, [resumable]);

  return { resumable, resume, dismiss: clear };
}
