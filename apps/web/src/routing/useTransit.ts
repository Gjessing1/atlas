import {
  useTransitPlan as useSharedTransitPlan,
  type TransitFn,
  type TransitPlan,
} from '@atlas/app-hooks';
import { fetchTransitTrips } from '@atlas/transit';
import type { RoutePlanner } from './useRoute.js';

export type { TransitPlan } from '@atlas/app-hooks';

/** Web journey planning goes straight to the same-origin backend proxy. */
const transit: TransitFn = (query, signal) => fetchTransitTrips(query, { signal });

/**
 * Public transport for the current plan. The offered/enabled/selected glue
 * lives in `@atlas/app-hooks` so Android shares it; the web binds it to the
 * same-origin fetcher.
 */
export function useTransitPlan(route: RoutePlanner): TransitPlan {
  return useSharedTransitPlan(route, transit);
}
