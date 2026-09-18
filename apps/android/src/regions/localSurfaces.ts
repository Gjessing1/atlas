import { packImageryFile, packLayerFile, packUnzipDir, type LatLng } from '@atlas/core';
import { cellAt, cellId } from '@atlas/potential';

import type { ActiveOverlay } from '../layers/useOverlays';
import type { LocalPack } from './packs';

/**
 * Drawing an overlay from a downloaded pack instead of from the server.
 *
 * Two artifacts, and they are drawn on opposite principles:
 *
 * - **A derived potential surface replaces the streamed one.** The pack's
 *   tiles are the same PNGs the server would have sent, at the same z11–z13
 *   addresses, so the surface, its legend and its opacity are untouched and the
 *   rest of the app cannot tell the difference. Downloaded wins, because the
 *   user chose to download this ground.
 * - **Offline imagery is drawn *beneath* the live layer, never instead of it.**
 *   The satellite layer is streamed Esri detail over a 10 m mosaic, and only
 *   the mosaic half can be kept (Esri's licence forbids storing it). Stacking
 *   is what makes that degrade by itself: with a connection the live layer
 *   covers the slab completely, and when it cannot load, the slab is what
 *   shows through. No connectivity check anywhere — MapLibre painting a source
 *   that has no tile is the whole mechanism.
 *
 * **A surface's coverage is judged by cell, not by the pack's bbox.** A pack is
 * built from the rectangle a user framed, but a surface exists only in whole
 * z11 cells, so the rectangle is the *intent* and the cell list is the fact.
 * Asking the bbox would blank the map along every edge where the two disagree —
 * which is most of them, since a framed area almost never lands on cell
 * boundaries. An imagery slab is the other way round: it is cut straight to the
 * rectangle, so the bbox is exactly its coverage.
 */

/** The pack that can draw this surface where the map is looking, if any. */
export function packWithSurface(
  packs: readonly LocalPack[],
  layer: string,
  target: string,
  center: LatLng | null,
): LocalPack | undefined {
  if (!center) return undefined;
  const here = cellId(cellAt(center.lat, center.lng));
  return packs.find((pack) => packLayerFile(pack.manifest, layer, target)?.cells?.includes(here));
}

/** The pack whose imagery slab covers where the map is looking, if any. */
export function packWithImagery(
  packs: readonly LocalPack[],
  layer: string,
  center: LatLng | null,
): LocalPack | undefined {
  if (!center) return undefined;
  return packs.find((pack) => {
    if (!packImageryFile(pack.manifest, layer)) return false;
    const { sw, ne } = pack.manifest.bbox;
    return (
      center.lat >= sw.lat && center.lat <= ne.lat && center.lng >= sw.lng && center.lng <= ne.lng
    );
  });
}

/**
 * The offline slab to draw beneath a layer, or null where no pack covers it.
 *
 * `maxzoom` is the archive's own, not the catalog's: the producer stops at
 * whatever depth fits its size budget for the region, so Oslo's slab reaches
 * z13 and Nord-Norge's z11. Handing MapLibre the real number is what makes it
 * overzoom from the deepest tile that exists instead of asking for one that
 * does not.
 */
export function localImageryBase(
  packs: readonly LocalPack[],
  layer: string,
  center: LatLng | null,
): { tileUrlTemplate: string; maxzoom: number } | null {
  const pack = packWithImagery(packs, layer, center);
  if (!pack) return null;
  const file = packImageryFile(pack.manifest, layer)!;
  return {
    tileUrlTemplate: `${pack.dir.replace(/\/+$/, '')}/${packUnzipDir(file)}/{z}/{x}/{y}.png`,
    maxzoom: file.maxzoom,
  };
}

/**
 * `file://` tile template for a downloaded surface, or null when no pack
 * carries this ground. The archive unpacks to its own name inside the pack
 * directory, and the tiles keep their `<z>/<x>/<y>.png` addresses.
 */
export function localSurfaceTemplate(
  packs: readonly LocalPack[],
  layer: string,
  target: string,
  center: LatLng | null,
): string | null {
  const pack = packWithSurface(packs, layer, target, center);
  if (!pack) return null;
  const file = packLayerFile(pack.manifest, layer, target)!;
  return `${pack.dir.replace(/\/+$/, '')}/${packUnzipDir(file)}/{z}/{x}/{y}.png`;
}

/**
 * The overlay list with anything a downloaded pack can draw pointed at it: a
 * derived surface *replaced* by the pack's copy, an imagery layer given a slab
 * to fall back onto.
 *
 * For a surface, downloaded tiles win over streamed ones — the same rule the
 * basemap follows and for the same reasons: the user chose to download this
 * ground, and re-streaming what is already on disk spends data and battery for
 * nothing. `preferOnline` — the existing Settings switch for a pack the user
 * knows is stale — is the way back to the live surface, which matters because a
 * cell can be re-derived server-side long after it was packed.
 *
 * `preferOnline` deliberately does **not** suppress the imagery slab. It cannot
 * hide anything the switch is meant to reveal: the slab is only ever visible
 * where the live layer failed to load, so honouring it there would trade a
 * stale-but-real picture for a blank one.
 *
 * The source id carries a surface's change, because MapLibre would otherwise
 * keep serving the tiles it already loaded under the old URL.
 */
export function withLocalSurfaces(
  overlays: readonly ActiveOverlay[],
  packs: readonly LocalPack[],
  center: LatLng | null,
  preferOnline: boolean,
): ActiveOverlay[] {
  if (packs.length === 0) return overlays as ActiveOverlay[];
  return overlays.map((overlay) => {
    if (overlay.meta.offlinePack) {
      const base = localImageryBase(packs, overlay.meta.id, center);
      return base ? { ...overlay, offlineBase: base } : overlay;
    }
    if (preferOnline || !overlay.meta.derived) return overlay;
    const template = localSurfaceTemplate(
      packs,
      overlay.meta.id,
      overlay.options['target'] ?? '',
      center,
    );
    if (!template) return overlay;
    return { ...overlay, tileUrlTemplate: template, sourceId: `${overlay.sourceId}--offline` };
  });
}
