import type { RoutePath } from './model.js';

/**
 * Route choices in the order a preview should offer them: quickest first.
 *
 * Valhalla returns its primary path first and the alternatives in its own
 * order, which is not sorted by time — a preview listing them raw reads like a
 * bug ("10 min" above "9 min") and, worse, pre-selects a choice that isn't the
 * quickest. Ties keep the engine's order, so the primary stays first when an
 * alternative merely matches it.
 *
 * Measured congestion is deliberately **excluded from the comparison** while
 * still being shown in each choice's time. NPRA instruments 202 corridors, not
 * the network: ranking on the adjusted time would let a route win for having no
 * measurement rather than for being quicker, and quietly turn an ETA correction
 * into traffic-aware routing on data too sparse to support it (§2.2). So the
 * order is the engine's own like-for-like judgement, and the "+6 min traffic"
 * label is what explains a slower number sitting first.
 */
export function sortRouteChoices(paths: readonly RoutePath[]): RoutePath[] {
  const scheduled = (path: RoutePath) => path.timeMs - (path.trafficDelayMs ?? 0);
  return [...paths].sort((a, b) => scheduled(a) - scheduled(b));
}
