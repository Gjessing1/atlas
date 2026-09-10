import {
  useOverlayPreferences,
  type OverlayPreferences,
  type SettingsAccess,
} from '@atlas/app-hooks';
import { type LayerMeta, type LayersResponse } from '@atlas/core';
import { useEffect, useState } from 'react';

/**
 * The shared overlay controller plus the one thing the browser adds: the whole
 * catalog, which the profile settings need to configure profiles that are not
 * the active one. `overlays` are `OverlayEntry`s — `useOverlayLayers` widens
 * them with its own generation marker.
 */
export interface LayerCatalog extends OverlayPreferences {
  /** Full server catalog; profile settings use it to configure inactive profiles. */
  allCatalog: LayerMeta[];
}

/**
 * Fetches the overlay catalog (GET /api/layers) once and hands it to the shared
 * overlay controller, which owns everything about the *preferences* — defaults,
 * per-profile keys, opacity, variants, the basemap switch and the active
 * derived surface (`useOverlayPreferences`, @atlas/app-hooks, DR4). What is
 * left here is the browser's half: it refetches on every load and has nothing
 * to cache the catalog for, where Android keeps a last-seen copy to stay usable
 * offline.
 */
export function useLayerCatalog(
  userData: SettingsAccess,
  profileId: string,
  preferredLayers: readonly string[] = [],
  customizedLayers = false,
): LayerCatalog {
  const [allLayers, setAllLayers] = useState<LayerMeta[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/layers')
      .then((res) => (res.ok ? (res.json() as Promise<LayersResponse>) : { layers: [] }))
      .then((body) => {
        if (!cancelled) setAllLayers(body.layers ?? []);
      })
      .catch(() => {
        // No catalog (backend down / old server): the panel simply stays empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const preferences = useOverlayPreferences(userData, {
    catalog: allLayers,
    profileId,
    preferredLayers,
    customizedLayers,
  });

  return { ...preferences, allCatalog: allLayers };
}
