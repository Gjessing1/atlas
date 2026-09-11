import type { FastifyInstance } from 'fastify';
import { norwegianLayers } from './catalog.js';
import type { OverlayApiOptions, OverlayContext } from './context.js';
import { registerFeaturesRoute } from './features.js';
import { registerIdentifyRoute } from './identify.js';
import { registerLabelsRoute } from './labels.js';
import { registerTileRoute } from './tiles.js';

/**
 * Overlay layer registry + WMS/XYZ tile proxy + GetFeatureInfo identify proxy
 * + attribute labels, assembled here from four single-purpose modules:
 *
 * - `catalog.ts`  the curated Norwegian registry (data) and its types
 * - `wms.ts`      tile math + GetMap/GetFeatureInfo request building
 * - `tiles.ts`    /api/overlay/:id/:z/:x/:y.png and the disk cache
 * - `identify.ts` /api/overlay/:id/identify and the response parsers
 * - `labels.ts`   /api/overlay/:id/labels and the ArcGIS attribute fetch
 * - `features.ts` /api/overlay/:id/features — arcgis-vector GeoJSON
 *
 * `registerOverlayApi` is the only entry point the app uses; everything else is
 * exported for tests.
 */

export type { OverlayApiOptions } from './context.js';
export type { OverlayLayer } from './catalog.js';
import type { OverlayLayer } from './catalog.js';
export { norwegianLayers, speedCameraLayerMeta, topoFootpathsSld } from './catalog.js';

/**
 * Returns the layers it actually configured (tokenless ones already dropped) —
 * the N7 prober needs exactly that list, and re-deriving it would let the two
 * disagree about which layers this instance serves.
 */
export function registerOverlayApi(app: FastifyInstance, opts: OverlayApiOptions): OverlayLayer[] {
  const env = opts.env ?? process.env;
  // Tokened layers without their env var drop out silently (no broken rows).
  const layers = (opts.layers ?? norwegianLayers()).filter(
    (l) => !l.requiresEnv || Boolean(env[l.requiresEnv]),
  );

  // Each catalog source shows on the status page, unknown until a tile/identify
  // request actually exercises it.
  const status = opts.status;
  const probeId = (id: string) => `overlay:${id}`;
  for (const l of layers) status?.register(probeId(l.meta.id), l.meta.title, 'Overlays');

  const ctx: OverlayContext = {
    app,
    layers,
    byId: new Map(layers.map((l) => [l.meta.id, l])),
    fetchImpl: opts.fetchImpl ?? fetch,
    env,
    cacheDir: opts.cacheDir,
    record: (layerId, ok, detail) => status?.record(probeId(layerId), ok, detail),
  };

  // Public catalog: LayerMeta only — never the upstream config. `labels` is
  // derived from the upstream here rather than duplicated in `meta`, so a layer
  // can never advertise labels it has no source for. Vector extras (opts.extraMeta)
  // ride along at the end — panel display order puts the curated rasters first.
  app.get('/api/layers', () => ({
    layers: [
      ...layers.map((l) => {
        const labels = l.upstream.kind === 'wms' ? l.upstream.labels : undefined;
        return labels
          ? { ...l.meta, labels: { minzoom: labels.minzoom, unit: labels.unit } }
          : l.meta;
      }),
      ...(opts.extraMeta ?? []),
    ],
  }));

  registerTileRoute(ctx);
  registerIdentifyRoute(ctx);
  registerLabelsRoute(ctx);
  registerFeaturesRoute(ctx);
  return layers;
}
