import { packLayerFile, packUnzipDir, type LatLng } from '@atlas/core';
import { cellAt, cellId } from '@atlas/potential';

import type { ActiveOverlay } from '../layers/useOverlays';
import type { LocalPack } from './packs';

/**
 * Drawing a derived potential surface from a downloaded pack (ROADMAP § N5 →
 * E7), instead of from the derive service.
 *
 * The substitution is deliberately the *only* thing that changes: a pack's
 * tiles are the same PNGs the server would have sent, at the same z11–z13
 * addresses, so the surface, its legend and its opacity are untouched and the
 * rest of the app cannot tell the difference.
 *
 * **Coverage is judged by cell, not by the pack's bbox.** A pack is built from
 * the rectangle a user framed, but a surface exists only in whole z11 cells, so
 * the rectangle is the *intent* and the cell list is the fact. Asking the bbox
 * would blank the map along every edge where the two disagree — which is most
 * of them, since a framed area almost never lands on cell boundaries.
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
  return packs.find((pack) => packLayerFile(pack.manifest, layer, target)?.cells.includes(here));
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
 * The overlay list with any derived surface pointed at a downloaded pack.
 *
 * Downloaded tiles win over streamed ones, the same rule the basemap follows
 * and for the same reasons: the user chose to download this ground, and
 * re-streaming what is already on disk spends data and battery for nothing.
 * `preferOnline` — the existing Settings switch for a pack the user knows is
 * stale — is the way back to the live surface, which matters here because a
 * cell can be re-derived server-side long after it was packed.
 *
 * The source id carries the change, because MapLibre would otherwise keep
 * serving the tiles it already loaded under the old URL.
 */
export function withLocalSurfaces(
  overlays: readonly ActiveOverlay[],
  packs: readonly LocalPack[],
  center: LatLng | null,
  preferOnline: boolean,
): ActiveOverlay[] {
  if (preferOnline || packs.length === 0) return overlays as ActiveOverlay[];
  return overlays.map((overlay) => {
    if (!overlay.meta.derived) return overlay;
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
