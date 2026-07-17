import type { RoutePath } from './model.js';

/**
 * Google-style "via …" labels that tell route alternatives apart: for each
 * path, the road name carrying the most distance that the *other* paths don't
 * meaningfully use. Needs instructions (street names ride on maneuvers), so
 * paths routed without them get null — as does a path whose distinguishing
 * stretch is too short to be a useful description (< 500 m or < 5% of the
 * trip, e.g. two alternatives that differ only in a ramp).
 */
export function pathViaLabels(paths: RoutePath[]): (string | null)[] {
  // Distance travelled per street name, per path.
  const tallies = paths.map((path) => {
    const tally = new Map<string, number>();
    for (const ins of path.instructions ?? []) {
      if (!ins.streetName) continue;
      tally.set(ins.streetName, (tally.get(ins.streetName) ?? 0) + ins.distanceM);
    }
    return tally;
  });

  return paths.map((path, i) => {
    let best: string | null = null;
    let bestScore = 0;
    for (const [name, dist] of tallies[i]!) {
      // Score = how much more of this road we ride than any other alternative.
      let elsewhere = 0;
      for (let j = 0; j < tallies.length; j++) {
        if (j !== i) elsewhere = Math.max(elsewhere, tallies[j]!.get(name) ?? 0);
      }
      const score = dist - elsewhere;
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    const minM = Math.max(500, path.distanceM * 0.05);
    return bestScore >= minM ? best : null;
  });
}
