import { jsonSetting, readSetting, type LatLng, type RoutePlanState } from '@atlas/core';
import { isRoutingProfile } from '@atlas/routing';
import { useEffect, useRef } from 'react';

import type { RoutePlanner, StoredRoutePlan } from './useRoute.js';
import type { SettingsAccess } from './usePersistedSetting.js';

/**
 * The plan lives on this device only: it is scratch state, not user data, so
 * `local` keeps it out of sync (a half-finished plan should not appear on the
 * phone).
 *
 * The decoder is the part that used to be a bare cast. `JSON.parse(raw) as
 * StoredRoutePlan` accepted any object at all, and the two properties it went
 * on to check — the profile and that `waypoints` is an array — were checked at
 * the call site, in a `try` that also stood in for "no plan saved". An array of
 * anything got through: a waypoint without a `pos` reached the map as a marker
 * at `undefined`. Here the profile is validated (it is handed to the routing
 * API, and a share link is user-editable text) and every waypoint must actually
 * carry coordinates, with the rest of the plan kept only when it is the right
 * shape.
 */
export const ROUTE_PLAN_SETTING = jsonSetting<StoredRoutePlan | null>({
  key: 'local.route.plan',
  scope: 'local',
  defaultValue: null,
  parse: (value) => {
    if (typeof value !== 'object' || value === null) return null;
    const raw = value as Record<string, unknown>;
    if (!isRoutingProfile(raw['profile'])) return null;
    if (!Array.isArray(raw['waypoints'])) return null;
    const waypoints = raw['waypoints'].flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null) return [];
      const wp = item as Record<string, unknown>;
      const pos = wp['pos'];
      if (typeof pos !== 'object' || pos === null) return [];
      const { lat, lng } = pos as Record<string, unknown>;
      if (typeof lat !== 'number' || !Number.isFinite(lat)) return [];
      if (typeof lng !== 'number' || !Number.isFinite(lng)) return [];
      return [
        {
          pos: { lat, lng },
          ...(typeof wp['name'] === 'string' ? { name: wp['name'] } : {}),
          ...(typeof wp['transitStopId'] === 'string'
            ? { transitStopId: wp['transitStopId'] }
            : {}),
          ...(wp['straightAfter'] === true ? { straightAfter: true } : {}),
        },
      ];
    });
    const roundTripKm = raw['roundTripKm'];
    const preferences = raw['preferences'];
    return {
      profile: raw['profile'],
      waypoints,
      ...(typeof roundTripKm === 'number' && Number.isFinite(roundTripKm) ? { roundTripKm } : {}),
      ...(raw['roundTripDirection'] === 'clockwise' ||
      raw['roundTripDirection'] === 'counterclockwise'
        ? { roundTripDirection: raw['roundTripDirection'] }
        : {}),
      ...(typeof preferences === 'object' && preferences !== null
        ? { preferences: preferences as StoredRoutePlan['preferences'] }
        : {}),
    };
  },
});

/**
 * The settings seam this needs, which every client already has through
 * `useUserData`. Narrow on purpose: a plan-restoring hook has no business with
 * places, tracks or the storage handle.
 */
export type RoutePlanSettings = SettingsAccess;

/** A plan decoded from a share link, converted to the planner's shape. */
export function planFromHash(hashPlan: RoutePlanState): StoredRoutePlan | null {
  // The hash is user-editable text: a profile this build doesn't know about
  // would be handed straight to the routing API.
  if (!isRoutingProfile(hashPlan.profile) || hashPlan.points.length === 0) return null;
  const plan: StoredRoutePlan = {
    profile: hashPlan.profile,
    waypoints: hashPlan.points.map((pos: LatLng, index) => ({
      pos,
      ...(hashPlan.directLegs?.includes(index) ? { straightAfter: true } : {}),
    })),
  };
  if (hashPlan.roundTripKm !== undefined) plan.roundTripKm = hashPlan.roundTripKm;
  if (hashPlan.roundTripDirection !== undefined) {
    plan.roundTripDirection = hashPlan.roundTripDirection;
  }
  return plan;
}

/**
 * Keeps the open route plan across restarts: restores the saved plan on
 * startup, then writes every later change back. A plan carried by a link wins
 * and is passed in as `fromLink` — restoring the local plan over someone's link
 * would be the wrong plan entirely.
 *
 * `fromLink` has three states, and the third is what makes this work on the
 * phone: `undefined` means *the launch link has not been read yet*, and holds
 * the saved plan back until it has. Web knows its hash synchronously and never
 * passes it; Android learns the launch URL from an async `Linking` call, so
 * without the wait the saved plan would win a race against the link the user
 * actually tapped. A *new* plan arriving later (a link received while the app
 * is already running) is restored too, over whatever is open.
 *
 * Shared because losing a half-built plan is *worse* on the phone, which is
 * where the OS kills a backgrounded app: this lived in the web app for three
 * releases while Android silently dropped every plan on restart (the parity
 * checklist's rule 2 — "prefer @atlas/app-hooks for anything with state" — is
 * exactly this shape of bug). Nothing in it was ever web-specific.
 */
export function useRoutePlanPersistence(
  route: RoutePlanner,
  settings: RoutePlanSettings,
  fromLink: StoredRoutePlan | null | undefined,
): void {
  const { status, getSetting, setSetting } = settings;
  const { dragging } = route;
  const { restore, plan } = route;
  // Until the saved plan has been read, saving would write the empty startup
  // plan over it.
  const restoredRef = useRef(false);
  // The link plan already opened, by identity: a second link is a second plan
  // even when it names the same stops, and re-restoring the same one would
  // undo the edits the user has made to it since.
  const openedLinkRef = useRef<StoredRoutePlan | null>(null);

  // A link's plan is in hand already: open it without waiting for storage, so
  // a shared route still works in a tab where storage is unavailable (the
  // single-tab OPFS lock) — there is just nothing to save afterwards.
  useEffect(() => {
    if (!fromLink || fromLink === openedLinkRef.current) return;
    openedLinkRef.current = fromLink;
    restoredRef.current = true;
    restore(fromLink);
  }, [fromLink, restore]);

  useEffect(() => {
    if (restoredRef.current || status !== 'ready' || fromLink === undefined) return;
    let cancelled = false;
    void getSetting(ROUTE_PLAN_SETTING.key).then((raw) => {
      if (cancelled) return;
      restoredRef.current = true;
      // A corrupt or half-written row decodes to null, i.e. no plan to restore
      // — the definition owns that judgement now, not a `catch` here.
      const saved = readSetting(ROUTE_PLAN_SETTING, raw);
      if (saved) restore(saved);
    });
    return () => {
      cancelled = true;
    };
    // `fromLink` is a dependency for its *undefined* case only: the effect has
    // to run again once the launch link resolves to "no plan in it".
  }, [status, getSetting, restore, fromLink]);

  useEffect(() => {
    if (!restoredRef.current || status !== 'ready' || dragging) return;
    // Closing route mode clears the plan, and '' reads back as "nothing saved".
    void setSetting(ROUTE_PLAN_SETTING.key, plan ? ROUTE_PLAN_SETTING.encode(plan) : '');
  }, [plan, status, setSetting, dragging]);
}
