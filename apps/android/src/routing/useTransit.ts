import { useTransitPlan as useSharedTransitPlan, type TransitFn } from '@atlas/app-hooks';
import { fetchTransitTrips } from '@atlas/transit';
import { useMemo } from 'react';

import { useServerOrigin } from '../serverOrigin';
import type { RoutePlanner } from './useRoute';

export type { TransitPlan } from '@atlas/app-hooks';

/**
 * Android journey planning. Unlike routing there is no offline provider to fall
 * back to: a timetable without the network is a lie, so this always goes to the
 * configured Atlas server, and the board says so when the fetch fails.
 */
export function useTransitPlan(route: RoutePlanner) {
  const baseUrl = useServerOrigin();
  const transit = useMemo<TransitFn>(
    () => (query, signal) => fetchTransitTrips(query, { baseUrl, signal }),
    [baseUrl],
  );
  return useSharedTransitPlan(route, transit);
}
