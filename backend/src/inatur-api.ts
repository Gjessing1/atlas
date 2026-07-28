import { parseOfferId } from '@atlas/core';
import type { InaturArea } from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';

/**
 * GET /api/inatur/resolve?offer=<id|url> — resolve an iNatur hunting/fishing
 * *offer* (the one a hunter bought) to its exact boundary, proxied from
 * Geodata's open Open-Inatur ArcGIS service (§4.1 / N5).
 *
 * Why proxy rather than call from the browser: the same reason as every other
 * upstream here — one place to hold the endpoint, one rate limiter, one origin,
 * and the client talks only to `/api/inatur/*`. The id ↔ boundary contract
 * (`InaturArea`, `parseOfferId`) lives in `@atlas/core` so the web tool and this
 * route agree on the shape.
 *
 * A well-formed id that no published boundary carries is a 404 ("that offer has
 * no drawn area"), distinct from a 400 (not an offer id at all) and a 502 (the
 * upstream is down) — three different things the UI phrases differently.
 */

const BASE = 'https://inatur.geodataonline.no/arcgis/rest/services/inatur/Open-Inatur/MapServer';
/**
 * Delområde feature-class layers to search, in priority order (proven in
 * nodemap): 3 = generic "Delområde" (most offers, incl. big game — the storvilt
 * view is empty upstream); 24/21 = Statskog småvilt; 23 = Statskog
 * innlandsfiske; 19 = laksefiske. All carry a `tilbudsid` keyed to the offer id.
 */
const DELOMRADE_LAYERS = [3, 24, 21, 23, 19];
/** Name attribute keys these layers use for a sub-area, in priority order. */
const NAME_KEYS = ['tekst', 'stedsnavn', 'navn', 'kommune_navn', 'knavn'];
const PROBE = 'inatur';
const UPSTREAM_TIMEOUT_MS = 12_000;

export interface InaturApiOptions {
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Health registry: Open-Inatur is one probed source. */
  status?: StatusRegistry;
}

interface GeoJsonFeature {
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

type Ring = [number, number][];
type Polygon = Ring[];

/**
 * Every polygon of a Polygon/MultiPolygon geometry, retaining its ring
 * topology. An offer can carve an un-permitted island out of its area (a hole
 * in the polygon: inatur.no draws it as a gap in the shading); flattening the
 * rings is fine for GPX line export but not for a filled map overlay.
 */
function allPolygons(geom: GeoJsonFeature['geometry']): Polygon[] {
  if (!geom?.coordinates) return [];
  if (geom.type === 'Polygon') {
    return [(geom.coordinates as Ring[]).filter((r): r is Ring => !!r)];
  }
  if (geom.type === 'MultiPolygon') {
    return (geom.coordinates as Ring[][]).map((polygon) => polygon.filter((r): r is Ring => !!r));
  }
  return [];
}

/** First present name attribute (sub-areas are often generically named). */
function pickName(props: Record<string, unknown> | null | undefined): string | undefined {
  if (!props) return undefined;
  for (const key of NAME_KEYS) {
    const v = props[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Build an InaturArea from the delområde features that carry the offer id. */
export function toInaturArea(offerId: string, features: GeoJsonFeature[]): InaturArea | null {
  const polygons: Polygon[] = [];
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const f of features) {
    for (const polygon of allPolygons(f.geometry)) {
      const usable = polygon.filter((ring) => ring.length >= 3);
      if (usable.length === 0) continue;
      polygons.push(usable);
      for (const ring of usable) {
        for (const [lng, lat] of ring) {
          if (lng < w) w = lng;
          if (lng > e) e = lng;
          if (lat < s) s = lat;
          if (lat > n) n = lat;
        }
      }
    }
  }
  if (!polygons.length || !Number.isFinite(w)) return null;
  return {
    offerId,
    name: pickName(features[0]?.properties),
    bbox: [w, s, e, n],
    polygons,
    rings: polygons.flat(),
    subAreas: features.length,
  };
}

export function registerInaturApi(app: FastifyInstance, opts: InaturApiOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const status = opts.status;
  status?.register(PROBE, 'iNatur (permit boundaries)', 'Hunting & fishing');

  const queryLayer = async (layer: number, offerId: string): Promise<GeoJsonFeature[]> => {
    const qs = new URLSearchParams({
      // offerId is validated 24-hex, so it cannot break out of the literal.
      where: `tilbudsid='${offerId}'`,
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'geojson',
    });
    const res = await fetchImpl(`${BASE}/${layer}/query?${qs.toString()}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Open-Inatur layer ${layer} upstream ${res.status}`);
    const fc = (await res.json()) as { type?: string; features?: GeoJsonFeature[] };
    return fc.type === 'FeatureCollection' && Array.isArray(fc.features) ? fc.features : [];
  };

  app.get<{ Querystring: { offer?: string } }>('/api/inatur/resolve', async (request, reply) => {
    const offerId = parseOfferId(request.query.offer ?? '');
    if (!offerId) {
      return reply.code(400).send({ error: 'paste an iNatur offer link or its id' });
    }
    try {
      let features: GeoJsonFeature[] = [];
      for (const layer of DELOMRADE_LAYERS) {
        features = await queryLayer(layer, offerId);
        if (features.length) break;
      }
      status?.record(PROBE, true);
      const area = toInaturArea(offerId, features);
      if (!area) {
        return reply.code(404).send({ error: 'no published boundary for that offer' });
      }
      // Never client-cacheable. This used to be `public, max-age=86400`, which
      // meant a wrong boundary (v0.86.0's dropped permit holes) survived both
      // the fix and the obvious user response to it — deleting the area and
      // pasting the link again just replayed the stored body. Resolving is a
      // rare, hand-triggered action, so going upstream every time costs nothing.
      return reply.header('cache-control', 'no-store').send(area);
    } catch (err) {
      request.log.warn({ err, offerId }, 'inatur resolve upstream failed');
      status?.record(PROBE, false, 'unreachable');
      return reply.code(502).send({ error: 'iNatur is unavailable right now' });
    }
  });
}
