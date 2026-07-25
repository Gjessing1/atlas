import type { LatLng, PlaceContent } from '@atlas/core';
import { useEffect, useState } from 'react';

import { deviceLanguage } from '../deviceLanguage';
import type { LocalPack } from '../regions/packs';
import { getServerOrigin } from '../serverOrigin';
import { packSearchDb } from '../search/offlineSearch';

export type PlaceContentState =
  | { status: 'idle' | 'loading'; content: PlaceContent[] }
  | { status: 'ready'; content: PlaceContent[] };

async function offlineContent(
  packs: LocalPack[],
  name: string,
  at: LatLng,
): Promise<PlaceContent[]> {
  // About 120 m at Norway's latitude; exact name matching keeps neighbouring
  // POIs from borrowing one another's article.
  const latDelta = 0.0011;
  const lngDelta = 0.0022;
  for (const pack of packs.filter((item) => item.manifest.files.search)) {
    try {
      const db = await packSearchDb(pack);
      const tables = await db.getAllAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='place_content'",
      );
      if (tables.length === 0) continue;
      const rows = await db.getAllAsync<{
        source: 'wikipedia' | 'wikivoyage';
        language: string;
        title: string;
        extract: string;
        url: string;
      }>(
        `SELECT c.source, c.language, c.title, c.extract, c.url
           FROM place_content c
           JOIN places p ON p.rowid = c.place_rowid
          WHERE lower(p.name) = lower(?)
            AND p.lat BETWEEN ? AND ?
            AND p.lng BETWEEN ? AND ?`,
        [name, at.lat - latDelta, at.lat + latDelta, at.lng - lngDelta, at.lng + lngDelta],
      );
      if (rows.length > 0) return rows.map((row) => ({ ...row, offline: true }));
    } catch {
      // Try another pack, then online.
    }
  }
  return [];
}

/**
 * Pack article first so something shows instantly and offline — then the online
 * lookup *upgrades* it.
 *
 * The pack used to win outright, which quietly meant a downloaded region turned
 * photos off: packs carry article text only (by design — images would multiply
 * their size), so a phone with a region downloaded over Asker showed the same
 * card it would have shown on a plane, with the network sitting right there.
 * Offline the pack answer stands; online the richer answer replaces it.
 */
export function usePlaceContent(
  packs: LocalPack[],
  name: string | undefined,
  at: LatLng,
): PlaceContentState {
  const [state, setState] = useState<PlaceContentState>({ status: 'idle', content: [] });

  useEffect(() => {
    if (!name?.trim()) {
      setState({ status: 'idle', content: [] });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', content: [] });
    void (async () => {
      const local = await offlineContent(packs, name, at);
      if (cancelled) return;
      // Shown while the network is asked, not instead of asking it.
      if (local.length > 0) setState({ status: 'ready', content: local });
      try {
        const params = new URLSearchParams({
          name,
          lat: String(at.lat),
          lon: String(at.lng),
          // Without this the proxy assumed English and a Norwegian hut, church
          // or farm — described on no.wikipedia and nowhere else — read as a
          // place nobody had ever written about.
          lang: deviceLanguage(),
        });
        const response = await fetch(`${getServerOrigin()}/api/place-content?${params}`, {
          signal: AbortSignal.timeout(5_000),
        });
        const content = response.ok
          ? ((await response.json()) as { content: PlaceContent[] }).content
          : [];
        // An empty online answer must not wipe a pack article that *did* match:
        // the pack's name index is exact, so where it matched it is right.
        if (!cancelled && (content.length > 0 || local.length === 0)) {
          setState({ status: 'ready', content });
        }
      } catch {
        // Offline (or a slow upstream): the pack article stands.
        if (!cancelled && local.length === 0) setState({ status: 'ready', content: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [packs, name, at.lat, at.lng]);

  return state;
}
