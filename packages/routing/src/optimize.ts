import { haversineM, type LatLng } from '@atlas/core';

/**
 * Suggest a better visiting order for waypoints (the classic "optimize route"
 * button). The first and last points stay fixed; intermediate stops are
 * reordered with a nearest-neighbor pass refined by 2-opt over straight-line
 * distances — an approximation that's near-instant for the handful of stops a
 * planned route has, without needing a server-side distance matrix.
 *
 * Returns the new order as indexes into `points` (identity when there's
 * nothing to optimize).
 */
export function optimizeWaypointOrder(points: LatLng[]): number[] {
  const n = points.length;
  const identity = points.map((_, i) => i);
  if (n < 4) return identity; // fewer than 2 intermediate stops: nothing to reorder

  const dist = (a: number, b: number) => haversineM(points[a]!, points[b]!);

  // Nearest neighbor: greedily walk from the start through the intermediates.
  const remaining = new Set(identity.slice(1, -1));
  const order: number[] = [0];
  while (remaining.size > 0) {
    const from = order[order.length - 1]!;
    let best = -1;
    let bestD = Infinity;
    for (const candidate of remaining) {
      const d = dist(from, candidate);
      if (d < bestD) {
        bestD = d;
        best = candidate;
      }
    }
    order.push(best);
    remaining.delete(best);
  }
  order.push(n - 1);

  // 2-opt: reverse any sub-path whose reversal shortens the tour, until stable.
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < order.length - 2; i++) {
      for (let j = i + 1; j < order.length - 1; j++) {
        const a = order[i - 1]!;
        const b = order[i]!;
        const c = order[j]!;
        const d = order[j + 1]!;
        if (dist(a, c) + dist(b, d) < dist(a, b) + dist(c, d) - 1e-9) {
          let lo = i;
          let hi = j;
          while (lo < hi) {
            [order[lo], order[hi]] = [order[hi]!, order[lo]!];
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
  }
  return order;
}
