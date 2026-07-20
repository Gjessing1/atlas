import type { StoredRoutePlan } from '@atlas/app-hooks';
import type { RoutePlanState } from '@atlas/core';
import { isRoutingProfile } from '@atlas/routing';
import { useEffect, useRef } from 'react';
import type { RoutePlanner } from './useRoute.js';

/**
 * The plan lives on this device only: it is scratch state, not user data, so
 * `local.` keeps it out of sync (a half-finished plan should not appear on the
 * phone).
 */
const PLAN_SETTING = 'local.route.plan';

interface SettingsAccess {
  status: string;
  getSetting: (key: string) => Promise<string | null | undefined>;
  setSetting: (key: string, value: string) => void;
}

/** A plan decoded from a share link, converted to the planner's shape. */
export function planFromHash(hashPlan: RoutePlanState): StoredRoutePlan | null {
  // The hash is user-editable text: a profile this build doesn't know about
  // would be handed straight to the routing API.
  if (!isRoutingProfile(hashPlan.profile) || hashPlan.points.length === 0) return null;
  const plan: StoredRoutePlan = {
    profile: hashPlan.profile,
    waypoints: hashPlan.points.map((pos) => ({ pos })),
  };
  if (hashPlan.roundTripKm !== undefined) plan.roundTripKm = hashPlan.roundTripKm;
  return plan;
}

/**
 * Keeps the open route plan across reloads: restores the saved plan on
 * startup, then writes every later change back. A plan carried by the URL
 * (a shared link) wins and is passed in as `fromLink` — restoring the local
 * plan over someone's link would be the wrong plan entirely.
 */
export function useRoutePlanPersistence(
  route: RoutePlanner,
  settings: SettingsAccess,
  fromLink: StoredRoutePlan | null,
): void {
  const { status, getSetting, setSetting } = settings;
  const { restore, plan } = route;
  // Until the saved plan has been read, saving would write the empty startup
  // plan over it.
  const restoredRef = useRef(false);

  // A link's plan is in hand already: open it without waiting for storage, so
  // a shared route still works in a tab where storage is unavailable (the
  // single-tab OPFS lock) — there is just nothing to save afterwards.
  useEffect(() => {
    if (restoredRef.current || !fromLink) return;
    restoredRef.current = true;
    restore(fromLink);
  }, [fromLink, restore]);

  useEffect(() => {
    if (restoredRef.current || status !== 'ready') return;
    let cancelled = false;
    void getSetting(PLAN_SETTING).then((raw) => {
      if (cancelled) return;
      restoredRef.current = true;
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as StoredRoutePlan;
        if (isRoutingProfile(saved.profile) && Array.isArray(saved.waypoints)) restore(saved);
      } catch {
        // A corrupt setting just means no plan to restore.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting, restore]);

  useEffect(() => {
    if (!restoredRef.current || status !== 'ready') return;
    // Closing route mode clears the plan, and '' reads back as "nothing saved".
    setSetting(PLAN_SETTING, plan ? JSON.stringify(plan) : '');
  }, [plan, status, setSetting]);
}
