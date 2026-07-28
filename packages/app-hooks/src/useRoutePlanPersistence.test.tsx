// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  planFromHash,
  useRoutePlanPersistence,
  type RoutePlanSettings,
} from './useRoutePlanPersistence.js';
import type { RoutePlanner, StoredRoutePlan } from './useRoute.js';

const PLAN_SETTING = 'local.route.plan';
const OSLO = { lat: 59.9139, lng: 10.7522 };
const BERGEN = { lat: 60.3913, lng: 5.3221 };

function settings(stored: Record<string, string> = {}, status = 'ready'): RoutePlanSettings {
  return {
    status,
    getSetting: vi.fn((key: string) => Promise.resolve(stored[key] ?? null)),
    setSetting: vi.fn((key: string, value: string) => {
      stored[key] = value;
    }),
  };
}

/** Only the two fields the hook touches; the rest of RoutePlanner is irrelevant here. */
function planner(plan: StoredRoutePlan | null, restore = vi.fn()): RoutePlanner {
  return { plan, restore } as unknown as RoutePlanner;
}

const savedPlan: StoredRoutePlan = {
  profile: 'car',
  waypoints: [{ pos: OSLO }, { pos: BERGEN, name: 'Bergen' }],
};

describe('planFromHash', () => {
  it('converts a link plan to the planner’s shape', () => {
    const plan = planFromHash({ profile: 'bike', points: [OSLO, BERGEN], roundTripKm: 12 });
    expect(plan).toEqual({
      profile: 'bike',
      waypoints: [{ pos: OSLO }, { pos: BERGEN }],
      roundTripKm: 12,
    });
  });

  it('refuses a profile this build does not know', () => {
    // The hash is user-editable text; an unknown profile would otherwise be
    // handed straight to the routing API.
    expect(planFromHash({ profile: 'teleport', points: [OSLO] })).toBeNull();
  });

  it('refuses an empty plan', () => {
    expect(planFromHash({ profile: 'car', points: [] })).toBeNull();
  });
});

describe('useRoutePlanPersistence', () => {
  it('restores the saved plan once storage is ready', async () => {
    const restore = vi.fn();
    const store = { [PLAN_SETTING]: JSON.stringify(savedPlan) };
    renderHook(() => useRoutePlanPersistence(planner(null, restore), settings(store), null));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(savedPlan));
  });

  it('waits for storage rather than writing the empty startup plan over it', async () => {
    const restore = vi.fn();
    const opening = settings({ [PLAN_SETTING]: JSON.stringify(savedPlan) }, 'opening');
    renderHook(() => useRoutePlanPersistence(planner(null, restore), opening, null));
    await Promise.resolve();
    expect(opening.getSetting).not.toHaveBeenCalled();
    expect(opening.setSetting).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('prefers a link’s plan over the saved one, without waiting for storage', async () => {
    const restore = vi.fn();
    const linked: StoredRoutePlan = { profile: 'bike', waypoints: [{ pos: BERGEN }] };
    const store = settings({ [PLAN_SETTING]: JSON.stringify(savedPlan) });
    renderHook(() => useRoutePlanPersistence(planner(null, restore), store, linked));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(linked));
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('holds the saved plan back while the launch link is still being read', async () => {
    // Android learns its launch URL from an async Linking call. Restoring the
    // saved plan meanwhile would let it win a race against the link the user
    // actually tapped — the bug this third `undefined` state exists to prevent.
    const restore = vi.fn();
    const store = settings({ [PLAN_SETTING]: JSON.stringify(savedPlan) });
    const linked: StoredRoutePlan = { profile: 'bike', waypoints: [{ pos: BERGEN }] };
    const { rerender } = renderHook(
      ({ link }: { link: StoredRoutePlan | null | undefined }) =>
        useRoutePlanPersistence(planner(null, restore), store, link),
      { initialProps: { link: undefined as StoredRoutePlan | null | undefined } },
    );
    await Promise.resolve();
    expect(store.getSetting).not.toHaveBeenCalled();

    rerender({ link: linked });
    await waitFor(() => expect(restore).toHaveBeenCalledWith(linked));
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('falls back to the saved plan once the launch link turns out to carry none', async () => {
    const restore = vi.fn();
    const store = settings({ [PLAN_SETTING]: JSON.stringify(savedPlan) });
    const { rerender } = renderHook(
      ({ link }: { link: StoredRoutePlan | null | undefined }) =>
        useRoutePlanPersistence(planner(null, restore), store, link),
      { initialProps: { link: undefined as StoredRoutePlan | null | undefined } },
    );
    rerender({ link: null });
    await waitFor(() => expect(restore).toHaveBeenCalledWith(savedPlan));
  });

  it('opens a link that arrives while the app is already running', async () => {
    // A shared link tapped in a chat app reaches a running Atlas as a `url`
    // event; it must replace whatever plan is open, not be ignored because
    // something was restored at boot.
    const restore = vi.fn();
    const store = settings({ [PLAN_SETTING]: JSON.stringify(savedPlan) });
    const received: StoredRoutePlan = { profile: 'bike', waypoints: [{ pos: BERGEN }] };
    const { rerender } = renderHook(
      ({ link }: { link: StoredRoutePlan | null | undefined }) =>
        useRoutePlanPersistence(planner(null, restore), store, link),
      { initialProps: { link: null as StoredRoutePlan | null | undefined } },
    );
    await waitFor(() => expect(restore).toHaveBeenCalledWith(savedPlan));

    rerender({ link: received });
    await waitFor(() => expect(restore).toHaveBeenCalledWith(received));
  });

  it('does not re-open the same link on a re-render', async () => {
    // Identity, not value: re-restoring would throw away the stops the user has
    // added to the shared plan since it opened.
    const restore = vi.fn();
    const linked: StoredRoutePlan = { profile: 'bike', waypoints: [{ pos: BERGEN }] };
    const store = settings();
    const { rerender } = renderHook(() =>
      useRoutePlanPersistence(planner(null, restore), store, linked),
    );
    await waitFor(() => expect(restore).toHaveBeenCalledWith(linked));
    rerender();
    rerender();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('treats a corrupt setting as nothing to restore', async () => {
    const restore = vi.fn();
    const store = settings({ [PLAN_SETTING]: '{not json' });
    renderHook(() => useRoutePlanPersistence(planner(null, restore), store, null));
    await waitFor(() => expect(store.getSetting).toHaveBeenCalled());
    expect(restore).not.toHaveBeenCalled();
  });

  it('saves every later change, and clears the setting when the plan closes', async () => {
    const stored: Record<string, string> = {};
    const store = settings(stored);
    const { rerender } = renderHook(
      ({ plan }: { plan: StoredRoutePlan | null }) =>
        useRoutePlanPersistence(planner(plan), store, null),
      { initialProps: { plan: null as StoredRoutePlan | null } },
    );
    await waitFor(() => expect(store.getSetting).toHaveBeenCalled());

    rerender({ plan: savedPlan });
    await waitFor(() => expect(stored[PLAN_SETTING]).toBe(JSON.stringify(savedPlan)));

    // Closing route mode clears the plan, and '' reads back as "nothing saved".
    rerender({ plan: null });
    await waitFor(() => expect(stored[PLAN_SETTING]).toBe(''));
  });
});
