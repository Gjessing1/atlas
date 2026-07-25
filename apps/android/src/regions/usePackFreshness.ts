import type { RegionPackManifest } from '@atlas/core';
import { useEffect, useRef, useState } from 'react';

import { packDownloads } from './downloads';
import { stalePackIds } from './freshness';
import { fetchAvailableRegions, type LocalPack } from './packs';

export interface PackFreshness {
  /** Ids of downloaded packs the server has since rebuilt. */
  stale: Set<string>;
  /** What the server currently publishes, or empty when it could not be asked. */
  published: RegionPackManifest[];
}

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
export function usePackFreshness(packs: LocalPack[]): PackFreshness {
  const [freshness, setFreshness] = useState<PackFreshness>({ stale: new Set(), published: [] });
  // Only the installed versions matter, so a re-render with a fresh array
  // identity must not re-fetch the region list.
  const installed = packs.map((pack) => `${pack.manifest.id}@${pack.manifest.version}`).join(',');

  useEffect(() => {
    if (installed === '') {
      setFreshness((current) =>
        current.stale.size === 0 && current.published.length === 0
          ? current
          : { stale: new Set(), published: [] },
      );
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const published = await fetchAvailableRegions();
        if (cancelled) return;
        setFreshness({
          stale: stalePackIds(
            installed.split(',').map((entry) => {
              const at = entry.lastIndexOf('@');
              return { id: entry.slice(0, at), version: Number(entry.slice(at + 1)) };
            }),
            published,
          ),
          published,
        });
      } catch {
        // Offline or no server: say nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installed]);

  return freshness;
}

/**
 * Keep downloaded regions current by themselves, over Wi-Fi.
 *
 * A rebuilt region is queued as an unmetered background download, so the system
 * holds it until the phone is on Wi-Fi and Atlas doesn't have to be open for it
 * to finish. The install (verify, unpack, swap) still waits for the app to be
 * opened — that is when the routing engine can be closed safely. Each region is
 * offered once per app run: a download the user cancels stays cancelled.
 */
export function useAutoPackUpdate(freshness: PackFreshness, enabled: boolean): void {
  const offered = useRef(new Set<string>());
  const { stale, published } = freshness;

  useEffect(() => {
    if (!enabled) return;
    for (const id of stale) {
      if (offered.current.has(id)) continue;
      const manifest = published.find((region) => region.id === id);
      if (!manifest || packDownloads.job(id)) continue;
      offered.current.add(id);
      void packDownloads.start(manifest, true);
    }
  }, [enabled, stale, published]);
}
