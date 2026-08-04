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
  const wms = layer.upstream.kind === 'wms' ? layer.upstream : undefined;
  if (!wms?.optionParams && !wms?.optionParamsFor) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(chosen)) {
    Object.assign(out, wms.optionParams?.[key]?.[value] ?? {});
  }
  // Last, so a parameter that depends on the whole selection wins over any
  // per-option guess at it (see `optionParamsFor`).
  Object.assign(out, wms.optionParamsFor?.(chosen) ?? {});
  return out;
}

/**
 * The QUERY_LAYERS a selected option asks about (see `optionIdentifyLayers`),
 * or `undefined` when the layer's identify does not vary.
 *
 * The tap must ask about the dataset the map is drawing. Where the option
 * *swaps the dataset* rather than filtering one — spawning grounds choosing
 * between spawning areas, nursery areas and the surveyed cod fields — an
 * unchanged QUERY_LAYERS would answer from a layer the user is not looking at,
 * which is worse than not answering at all.
 *
 * At most one option may decide the queried set; two would be a race between
 * whichever the caller listed first, so `api.test.ts` asserts the single key
 * rather than leaving it to whoever writes the third such row.
 */
export function optionQueryLayers(
  layer: OverlayLayer,
  chosen: Record<string, string>,
): string | undefined {
  const table = layer.upstream.kind === 'wms' ? layer.upstream.optionIdentifyLayers : undefined;
  if (!table) return undefined;
  for (const [key, value] of Object.entries(chosen)) {
    const layers = table[key]?.[value];
    if (layers) return layers;
  }
  return undefined;
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
