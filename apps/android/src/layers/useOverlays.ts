import {
  useOverlayPreferences,
  type OverlayEntry,
  type OverlayPreferences,
} from '@atlas/app-hooks';
import { LIGHTNING_OBSERVATIONS_ID, WEATHER_WARNINGS_ID } from '@atlas/conditions';
import {
  jsonSetting,
  layerOptionSignature,
  overlayTileUrl,
  PUBLIC_TOILETS_ID,
  readSetting,
  SATELLITES_ID,
  STARLINK_ID,
  type LayerMeta,
  type LayersResponse,
} from '@atlas/core';
import { useEffect, useMemo, useState } from 'react';

import type { OfflineImageryBase } from '../regions/localSurfaces';
import { useServerOrigin } from '../serverOrigin';
import type { UserData } from '../useUserData';

// Vector overlay ids MapScene knows how to draw as GeoJSON. Any vector layer
// outside this set is hidden from the panel until its renderer lands (see the
// `renderableLayers` filter below). Kept as an explicit id set rather than a
// clever heuristic — the vector layers genuinely differ in what drawing them
// means (hunting-field polygons vs. camera dots and average-speed lines).
const RENDERABLE_VECTOR_IDS = new Set([
  'statskog-jaktfelt',
  PUBLIC_TOILETS_ID,
  'speed-cameras',
  'ice-observations',
  'traffic',
  'road-weather',
  'transit-vehicles',
  SATELLITES_ID,
  STARLINK_ID,
  WEATHER_WARNINGS_ID,
  LIGHTNING_OBSERVATIONS_ID,
]);

/**
 * Last-seen catalog, so the panel works offline with known layers.
 *
 * Android-only and staying that way — a browser refetches `/api/layers` on
 * every load and has nothing to cache it for. What it shares with the web is
 * the *state* map ({@link useOverlayPreferences}, over `OVERLAY_STATE_SETTING`
 * in @atlas/core), which is the value both clients read and write.
 *
 * Decoded rather than cast: this is a cache of someone else's JSON, replayed
 * into the layer panel days later and possibly written by a backend two
 * versions older. An entry with no `id` used to reach the panel as a row that
 * could be switched on and would then request `/api/overlay/undefined/…`.
 */
const CATALOG_SETTING = jsonSetting<LayerMeta[]>({
  key: 'local.layers.catalog',
  scope: 'local',
  defaultValue: [],
  parse: (value) =>
    Array.isArray(value)
      ? value.filter(
          (entry): entry is LayerMeta =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as LayerMeta).id === 'string' &&
            typeof (entry as LayerMeta).title === 'string',
        )
      : undefined,
});

/**
 * An overlay the user has switched on (`OverlayEntry`, the shared decision),
 * ready for MapScene's RasterSource.
 */
export interface ActiveOverlay extends OverlayEntry {
  /** Absolute {z}/{x}/{y} template on the current server origin. */
  tileUrlTemplate: string;
  /**
   * Source id, carrying the option variant so that picking a different species
   * remounts the source instead of leaving the old tiles in place.
   */
  sourceId: string;
  /**
   * This layer's offline stand-in from a downloaded imagery pack, drawn
   * *beneath* it (`withLocalSurfaces`). Present only where a pack covers the
   * view. The layer above keeps streaming exactly as it would without one; this
   * is what remains on screen when it cannot.
   */
  offlineBase?: OfflineImageryBase;
}

export interface OverlaysController extends OverlayPreferences {
  /** Full cached/live catalog; profile settings configure inactive profiles from it. */
  allCatalog: LayerMeta[];
  overlays: ActiveOverlay[];
}

/**
 * The overlay catalog + per-device panel state (Android half of the shared
 * overlay controller). The preferences themselves — defaults, per-profile keys,
 * opacity, variants, the basemap switch and the active derived surface — are
 * `useOverlayPreferences` in @atlas/app-hooks, so the phone and the browser
 * cannot disagree about what is on (DR4).
 *
 * What is Android's own is offline-first catalog handling: GET /api/layers is
 * cached in a local setting, and the last-seen catalog keeps the sheet and any
 * cached tiles usable without connectivity. So is the renderability filter and
 * the tile URL / MapLibre source identity below, which are about drawing rather
 * than about choosing.
 */
export function useOverlays(
  data: UserData,
  profileId: string,
  preferredLayers: readonly string[] = [],
  customizedLayers = false,
): OverlaysController {
  const origin = useServerOrigin();
  const [allLayers, setAllLayers] = useState<LayerMeta[]>([]);
  const { status, getSetting, setSetting } = data;

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(CATALOG_SETTING.key).then((raw) => {
      if (cancelled) return;
      const cached = readSetting(CATALOG_SETTING, raw);
      if (cached.length === 0) return;
      // Only seed from the cache while the live fetch hasn't answered yet.
      setAllLayers((cur) => (cur.length > 0 ? cur : cached));
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${origin}/api/layers`);
        if (!res.ok) return;
        const body = (await res.json()) as LayersResponse;
        if (cancelled || !Array.isArray(body.layers)) return;
        setAllLayers(body.layers);
        void setSetting(CATALOG_SETTING.key, CATALOG_SETTING.encode(body.layers));
      } catch {
        // Offline: the cached catalog (if any) carries the sheet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, setSetting]);

  // Vector overlays are only offered once MapScene can draw them — a toggle
  // that draws nothing is worse than not offering it. Both current ones do:
  // the Statskog jaktfelt polygons (useHuntingFields) and the ATK cameras
  // (useSpeedCameras), each a GeoJSON overlay MapScene paints. The *stored*
  // catalog cache stays raw, so widening this set needs no migration.
  const renderableLayers = useMemo(
    () => allLayers.filter((meta) => !meta.vector || RENDERABLE_VECTOR_IDS.has(meta.id)),
    [allLayers],
  );

  const preferences = useOverlayPreferences(data, {
    catalog: renderableLayers,
    profileId,
    preferredLayers,
    customizedLayers,
  });

  const liveRefreshSeconds = preferences.overlays.reduce(
    (best, overlay) =>
      overlay.meta.refreshSeconds ? Math.min(best, overlay.meta.refreshSeconds) : best,
    Number.POSITIVE_INFINITY,
  );
  const [liveTick, setLiveTick] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(liveRefreshSeconds)) return;
    const timer = setInterval(() => setLiveTick((value) => value + 1), liveRefreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [liveRefreshSeconds]);

  const overlays = useMemo(
    () =>
      preferences.overlays.map((overlay) => {
        const signature = layerOptionSignature(overlay.options);
        return {
          ...overlay,
          tileUrlTemplate: overlayTileUrl(origin, overlay.meta, overlay.options),
          sourceId:
            `atlas-overlay-${overlay.meta.id}${signature ? `--${signature}` : ''}` +
            (overlay.meta.refreshSeconds ? `--live-${liveTick}` : ''),
        };
      }),
    [preferences.overlays, origin, liveTick],
  );

  return { ...preferences, allCatalog: renderableLayers, overlays };
}
