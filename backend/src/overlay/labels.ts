import { bboxToUtm33, polygonLabelPoint, snapLabelBbox } from '@atlas/core';
import type { LngLatBbox, OverlayLabel } from '@atlas/core';
import type { FastifyReply } from 'fastify';
import type { ArcGisLabelSource } from './catalog.js';
import type { OverlayContext } from './context.js';

/**
 * Map labels: numbers that live in an upstream's *attributes* rather than in
 * the raster it renders (NVE's `maksdyp_m` per surveyed lake), fetched per
 * viewport from ArcGIS REST and drawn client-side as a symbol layer.
 *
 * Viewports are snapped and cached in memory: panning a map produces a stream
 * of near-identical bboxes, and the underlying numbers change on the order of
 * decades.
 */

export interface ArcGisPolygonResponse {
  features?: { attributes?: Record<string, unknown>; geometry?: { rings?: number[][][] } }[];
  error?: { message?: string };
}

/** Labels change on the order of decades; an hour in memory is plenty. */
const LABEL_TTL_MS = 60 * 60 * 1000;
const LABEL_CACHE_MAX = 500;
const LABEL_MAX_AGE_S = 24 * 3600;

type LabelCache = Map<string, { features: OverlayLabel[]; expires: number }>;

export function parseBbox(raw: string | undefined): LngLatBbox | null {
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [w, s, e, n] = parts as [number, number, number, number];
  if (w >= e || s >= n || Math.abs(s) > 85 || Math.abs(n) > 85) return null;
  // A whole-world request would ask the upstream for every lake in Norway.
  if (e - w > 20 || n - s > 20) return null;
  return [w, s, e, n];
}

export function toLabelFeatures(
  body: ArcGisPolygonResponse,
  source: ArcGisLabelSource,
): OverlayLabel[] {
  const out: OverlayLabel[] = [];
  for (const feature of body.features ?? []) {
    const raw = feature.attributes?.[source.valueField];
    const value = typeof raw === 'number' ? raw : Number(raw);
    // -1 is the upstream's "not measured" marker (see UNKNOWN_SENTINEL in
    // identify.ts); a lake carrying it is surveyed but has no figure to draw.
    if (!Number.isFinite(value) || value <= 0) continue;
    const point = polygonLabelPoint(feature.geometry?.rings ?? []);
    if (!point) continue;
    const name = source.nameField ? feature.attributes?.[source.nameField] : undefined;
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
      properties: {
        label: `${trimNumber(value)} ${source.unit}`,
        value,
        ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
      },
    });
  }
  return out;
}

/** "21.5" not "21.50", "30" not "30.0". */
function trimNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function labelReply(reply: FastifyReply, features: OverlayLabel[]) {
  return reply
    .header('cache-control', `public, max-age=${LABEL_MAX_AGE_S}`)
    .send({ type: 'FeatureCollection', features });
}

export function registerLabelsRoute(ctx: OverlayContext): void {
  const { app, byId, fetchImpl } = ctx;
  // Per-registration, not module-level: two app instances (and two tests) must
  // not see each other's cached viewports.
  const labelCache: LabelCache = new Map();

  app.get<{ Params: { id: string }; Querystring: { bbox?: string; zoom?: string } }>(
    '/api/overlay/:id/labels',
    async (request, reply) => {
      const layer = byId.get(request.params.id);
      const source = layer?.upstream.kind === 'wms' ? layer.upstream.labels : undefined;
      if (!layer || !source) {
        return reply.code(404).send({ error: 'layer has no labels' });
      }
      const bbox = parseBbox(request.query.bbox);
      if (!bbox) return reply.code(400).send({ error: 'invalid bbox' });

      // Below the layer's own threshold the answer is "nothing to draw" — a
      // valid, cacheable result, not an error: at z8 a viewport holds hundreds
      // of lakes and the numbers would be an unreadable mat.
      const zoom = Number(request.query.zoom);
      if (Number.isFinite(zoom) && zoom < source.minzoom) {
        return labelReply(reply, []);
      }

      const key = `${layer.meta.id}:${snapLabelBbox(bbox).join(',')}`;
      const hit = labelCache.get(key);
      if (hit && hit.expires > Date.now()) return labelReply(reply, hit.features);

      const [minX, minY, maxX, maxY] = bboxToUtm33(snapLabelBbox(bbox));
      const url = new URL(source.url);
      const p = url.searchParams;
      p.set('where', '1=1');
      // The envelope goes in the service's *native* grid: NVE ignores `inSR`
      // and reads whatever it is given as metres, so lon/lat here would match
      // nothing at all rather than fail loudly.
      p.set('geometry', `${minX},${minY},${maxX},${maxY}`);
      p.set('geometryType', 'esriGeometryEnvelope');
      p.set('spatialRel', 'esriSpatialRelIntersects');
      p.set('outFields', [source.valueField, source.nameField].filter(Boolean).join(','));
      p.set('returnGeometry', 'true');
      p.set('maxAllowableOffset', String(source.simplifyDeg));
      p.set('outSR', '4326');
      p.set('f', 'json');

      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`labels upstream ${res.status}`);
        const body = (await res.json()) as ArcGisPolygonResponse;
        if (body.error) throw new Error(body.error.message ?? 'labels upstream error');
        const features = toLabelFeatures(body, source);
        labelCache.set(key, { features, expires: Date.now() + LABEL_TTL_MS });
        if (labelCache.size > LABEL_CACHE_MAX) {
          // Cheap eviction: the oldest insertion is the first key.
          const oldest = labelCache.keys().next();
          if (!oldest.done) labelCache.delete(oldest.value);
        }
        ctx.record(layer.meta.id, true);
        return labelReply(reply, features);
      } catch (err) {
        request.log.warn({ err, layer: layer.meta.id }, 'labels upstream failed');
        // Labels are an enhancement over a raster that still renders, so a dead
        // upstream must not blank the overlay — answer empty, briefly cached.
        return reply
          .header('cache-control', 'public, max-age=60')
          .send({ type: 'FeatureCollection', features: [] });
      }
    },
  );
}
