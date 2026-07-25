import { normalizeLayerOptions } from '@atlas/core';
import type { OverlayLayer } from './catalog.js';

/**
 * Layer options on the backend side (see `LayerMeta.options` in @atlas/core):
 * resolving what the client asked for, turning it into upstream request
 * parameters, and applying the identify-side equivalent.
 *
 * The split exists because the two halves of an option are not symmetric on
 * real services: ArcGIS honours `SLD_BODY` on GetMap but rejects it outright on
 * GetFeatureInfo ("Can't parse XML request"), so a species filter that the
 * raster applies upstream has to be applied to identify results here instead.
 */

/**
 * The option values a request asked for, reduced to what the layer declares.
 *
 * Everything downstream — cache path segments included — is built from this,
 * so it must never pass an unknown value through: `normalizeLayerOptions`
 * substitutes the layer's default, which is what keeps a hand-typed
 * `?species=../../etc` out of the cache path.
 */
export function resolveOptions(
  layer: OverlayLayer,
  query: Record<string, string | undefined>,
): Record<string, string> {
  return normalizeLayerOptions(layer.meta.options, query);
}

/** Extra GetMap parameters the selected options contribute (see `optionParams`). */
export function optionGetMapParams(
  layer: OverlayLayer,
  chosen: Record<string, string>,
): Record<string, string> {
  const table = layer.upstream.kind === 'wms' ? layer.upstream.optionParams : undefined;
  if (!table) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(chosen)) {
    Object.assign(out, table[key]?.[value] ?? {});
  }
  return out;
}

/**
 * Whether an identify result survives the selected options — the tap-side twin
 * of the upstream draw filter. A choice that lists no values keeps everything
 * ("all species"), and a feature missing the field is kept rather than dropped:
 * the filter exists to match the map, not to hide answers we can't classify.
 */
export function optionKeeps(
  layer: OverlayLayer,
  chosen: Record<string, string>,
  props: Record<string, string>,
): boolean {
  const filter = layer.upstream.kind === 'wms' ? layer.upstream.optionFilter : undefined;
  if (!filter) return true;
  const field = Object.entries(props).find(
    ([key]) => key.toLowerCase() === filter.field.toLowerCase(),
  );
  if (!field) return true;
  for (const [key, value] of Object.entries(chosen)) {
    const keep = filter.values[key]?.[value];
    if (keep && keep.length > 0 && !keep.includes(field[1])) return false;
  }
  return true;
}
