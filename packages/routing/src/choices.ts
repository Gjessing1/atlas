import type { RoutePath } from './model.js';

/**
 * Route choices in the order a preview should offer them: quickest first.
 *
 * Valhalla returns its primary path first and the alternatives in its own
 * order, which is not sorted by time — a preview listing them raw reads like a
 * bug ("10 min" above "9 min") and, worse, pre-selects a choice that isn't the
 * quickest. Ties keep the engine's order, so the primary stays first when an
 * alternative merely matches it.
 */
export function sortRouteChoices(paths: readonly RoutePath[]): RoutePath[] {
  return [...paths].sort((a, b) => a.timeMs - b.timeMs);
}
