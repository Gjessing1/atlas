import type { RegionPackManifest } from '@atlas/core';

/**
 * Ids of downloaded packs the server has a newer build of.
 *
 * A pack the server no longer publishes (a custom drawn region, whose job
 * artifacts expire) is *not* stale: there is nothing to update it to, so saying
 * so would be noise. Kept apart from the hook that calls it so it can be tested
 * without pulling React Native's Flow-typed entry point into the test runner.
 */
export function stalePackIds(
  installed: readonly { id: string; version: number }[],
  published: readonly Pick<RegionPackManifest, 'id' | 'version'>[],
): Set<string> {
  const newest = new Map(published.map((region) => [region.id, region.version]));
  const stale = new Set<string>();
  for (const pack of installed) {
    const server = newest.get(pack.id);
    if (server !== undefined && server > pack.version) stale.add(pack.id);
  }
  return stale;
}
