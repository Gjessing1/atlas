import { useEffect, useState } from 'react';

import { stalePackIds } from './freshness';
import { fetchAvailableRegions, type LocalPack } from './packs';

/**
 * Which downloaded packs the server has since rebuilt.
 *
 * Downloaded tiles win over streamed ones wherever a pack reaches (see
 * useTileSource), which is right — but it also means a region downloaded months
 * ago keeps drawing months-old OSM data with no hint that it is doing so, and
 * the reader has no reason to suspect the map rather than the app. Settings has
 * always offered the update; this is what puts the *prompt* on the map.
 *
 * Best effort by design: no server, no answer, no warning — an offline phone is
 * not the moment to nag about being out of date.
 */
export function usePackFreshness(packs: LocalPack[]): Set<string> {
  const [stale, setStale] = useState<Set<string>>(new Set());
  // Only the installed versions matter, so a re-render with a fresh array
  // identity must not re-fetch the region list.
  const installed = packs.map((pack) => `${pack.manifest.id}@${pack.manifest.version}`).join(',');

  useEffect(() => {
    if (installed === '') {
      setStale((current) => (current.size === 0 ? current : new Set()));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const published = await fetchAvailableRegions();
        if (cancelled) return;
        setStale(
          stalePackIds(
            installed.split(',').map((entry) => {
              const at = entry.lastIndexOf('@');
              return { id: entry.slice(0, at), version: Number(entry.slice(at + 1)) };
            }),
            published,
          ),
        );
      } catch {
        // Offline or no server: say nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installed]);

  return stale;
}
