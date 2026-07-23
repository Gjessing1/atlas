import { bboxContains, type LatLng } from '@atlas/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { LocalPack } from '../regions/packs';

/** Device-local preference — `local.` keys never sync (see CLAUDE.md). */
const ONLINE_TILES_SETTING = 'local.map.online-tiles';

export interface TileSourceSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface TileSource {
  /**
   * The downloaded pack whose basemap covers what the map is looking at, or
   * undefined when none does (nothing downloaded, or the view has left the
   * downloaded area — where pack tiles would draw a blank map).
   */
  coveringPack: LocalPack | undefined;
  /**
   * Stream tiles from the server even where a pack covers the view — the way
   * out for a pack the user knows is stale. Off by default.
   */
  preferOnline: boolean;
  setPreferOnline: (value: boolean) => void;
}

/**
 * The first downloaded pack that can draw `center` on its own. Assets (glyphs
 * and sprites) count as much as the tiles do: without them the offline style
 * renders a map with no labels or icons, which is worse than streaming.
 */
export function packCoveringView(packs: LocalPack[], center: LatLng | null): LocalPack | undefined {
  if (!center) return undefined;
  return packs.find(
    (pack) =>
      pack.manifest.files.basemap &&
      pack.manifest.files.assets &&
      bboxContains(pack.manifest.bbox, center),
  );
}

/**
 * Which tiles the map should draw. Downloaded tiles win over streamed ones
 * wherever a pack covers the view: the basemap changes slowly, the user chose
 * when to download it, and re-streaming tiles already on disk spends mobile
 * data and battery for nothing. Only the basemap is decided here — search,
 * routing, elevation, weather and transit stay online-first, because those are
 * what actually benefit from being connected.
 */
export function useTileSource(
  settings: TileSourceSettings,
  packs: LocalPack[],
  center: LatLng | null,
): TileSource {
  const { status, getSetting, setSetting } = settings;
  const [preferOnline, setPreferOnlineState] = useState(false);

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(ONLINE_TILES_SETTING).then((raw) => {
      if (!cancelled && raw != null) setPreferOnlineState(raw === 'true');
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const setPreferOnline = useCallback(
    (value: boolean) => {
      setPreferOnlineState(value);
      setSetting(ONLINE_TILES_SETTING, String(value));
    },
    [setSetting],
  );

  const coveringPack = useMemo(() => packCoveringView(packs, center), [packs, center]);
  return { coveringPack, preferOnline, setPreferOnline };
}
