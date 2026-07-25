import type { OverlayContext } from './context.js';
import { tileCoords, wmsBaseParams } from './wms.js';

/**
 * Tap-to-identify: a GetFeatureInfo proxy with a multi-format fallback
 * (geojson → GML → ESRI text/xml → text/plain; a ServiceException body means
 * "this server doesn't speak that format, try the next").
 *
 * The parsers below are the part with real edge cases, so they are plain
 * functions over a response body — testable without booting Fastify.
 */

/** Upstream attribute keys that are noise, not information. */
const NOISE_KEYS =
  /^(objectid|objtype|fid|gml_id|globalid|boundedby|bbox|styleurl|se_anno_cad_data|shape([._].*)?|geometri.*|symbol.*|ltema|opphav|kopidato|oppdateringsdato|datauttaksdato|malemetode|noyaktighet)$/i;

/**
 * `-1` is the "not measured" sentinel across NVE's depth attributes (a lake with
 * a surveyed max depth still reports `middeldyp=-1` and `volum_Mm3=-1` when only
 * the maximum was read off the paper chart). Passing it through would render as
 * "middeldyp: -1" — a depth of minus one metre, which is worse than saying
 * nothing. No layer we identify has a genuine -1, so drop it outright.
 */
const UNKNOWN_SENTINEL = /^-1(\.0+)?$/;

export function cleanProps(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (NOISE_KEYS.test(key)) continue;
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!text || text.toLowerCase() === 'null') continue;
    if (UNKNOWN_SENTINEL.test(text)) continue;
    out[key] = text.slice(0, 200);
  }
  return out;
}

/**
 * Narrow identify attributes to `identifyFields`, in that order. Anything not
 * listed is dropped; a feature left with nothing is dropped by the caller.
 */
export function selectFields(
  props: Record<string, string>,
  fields: string[] | undefined,
): Record<string, string> {
  if (!fields || fields.length === 0) return props;
  const byLower = new Map(
    Object.entries(props).map(([k, v]) => [k.toLowerCase(), [k, v] as const]),
  );
  const out: Record<string, string> = {};
  for (const want of fields) {
    const hit = byLower.get(want.toLowerCase());
    if (hit) out[hit[0]] = hit[1];
  }
  return out;
}

/**
 * Turn the upstream's database spelling into something readable: decode coded
 * values first, then rename the keys (see `identifyLabels`/`identifyValues`).
 *
 * Runs after `selectFields`, so it only ever sees the handful of attributes a
 * layer chose to show. A field with no mapping passes through untouched — the
 * catalog names what it knows how to translate and stays silent about the rest,
 * which is what keeps an unannotated layer working exactly as before.
 */
export function presentFields(
  props: Record<string, string>,
  labels: Record<string, string> | undefined,
  values: Record<string, Record<string, string>> | undefined,
): Record<string, string> {
  if (!labels && !values) return props;
  const lower = <T>(map: Record<string, T> | undefined) =>
    new Map(Object.entries(map ?? {}).map(([k, v]) => [k.toLowerCase(), v] as const));
  const labelBy = lower(labels);
  const valueBy = lower(values);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    const k = key.toLowerCase();
    // Numbers arrive as "1" or "1.0" depending on the identify dialect, so a
    // code lookup that missed by a trailing ".0" would silently show the raw
    // number — the exact failure this exists to prevent.
    const codes = valueBy.get(k);
    const decoded = codes?.[value] ?? codes?.[value.replace(/\.0+$/, '')] ?? value;
    out[labelBy.get(k) ?? key] = decoded;
  }
  return out;
}

export function parseGeojsonInfo(body: string): Record<string, string>[] | null {
  try {
    const json = JSON.parse(body) as { features?: { properties?: Record<string, unknown> }[] };
    if (!Array.isArray(json.features)) return null;
    return json.features.map((f) => cleanProps(f.properties ?? {}));
  } catch {
    return null;
  }
}

/**
 * Crude but serviceable GML reader: leaf elements become key/value pairs,
 * grouped per feature on featureMember/*_feature boundaries (covers both
 * MapServer msGMLOutput and ArcGIS WMS GML dialects).
 */
export function parseGmlInfo(body: string): Record<string, string>[] {
  const chunks = body.split(/<(?:\w+:)?(?:featureMember|\w+_feature)\b[^>]*>/).slice(1);
  const sources = chunks.length > 0 ? chunks : [body];
  return sources
    .map((chunk) => {
      const props: Record<string, unknown> = {};
      for (const m of chunk.matchAll(/<(?:(\w+):)?([\w.-]+)>([^<>]+)<\/(?:\w+:)?\2>/g)) {
        if (m[1] === 'gml') continue; // gml:name/gml:description are structural
        props[m[2]!] = m[3]!;
      }
      return cleanProps(props);
    })
    .filter((p) => Object.keys(p).length > 0);
}

/**
 * ESRI WMS text/xml FeatureInfoResponse (ArcGIS servers, e.g. NVE): one
 * self-closing `<FIELDS attr="value" …/>` element per feature.
 */
export function parseEsriXmlInfo(body: string): Record<string, string>[] | null {
  if (!body.includes('FeatureInfoResponse')) return null;
  const results: Record<string, string>[] = [];
  for (const m of body.matchAll(/<(?:\w+:)?FIELDS\b([^>]*)\/>/g)) {
    const props: Record<string, unknown> = {};
    for (const attr of m[1]!.matchAll(/([\w.()]+)="([^"]*)"/g)) props[attr[1]!] = attr[2]!;
    const cleaned = cleanProps(props);
    if (Object.keys(cleaned).length > 0) results.push(cleaned);
  }
  return results;
}

/** MapServer-style text/plain: indented `key = 'value'` lines. */
export function parseTextInfo(body: string): Record<string, string>[] {
  const props: Record<string, unknown> = {};
  for (const m of body.matchAll(/^\s+([\w.-]+)\s*=\s*'?([^'\n]*)'?\s*$/gm)) {
    props[m[1]!] = m[2]!;
  }
  const cleaned = cleanProps(props);
  return Object.keys(cleaned).length > 0 ? [cleaned] : [];
}

/**
 * The INFO_FORMATs to try, in order. A parser returns `null` for "this body is
 * not my format" (move on) and `[]` for "my format, nothing here" (stop).
 */
export const IDENTIFY_FORMATS: {
  format: string;
  parse: (body: string) => Record<string, string>[] | null;
}[] = [
  { format: 'application/json', parse: parseGeojsonInfo },
  { format: 'application/vnd.ogc.gml', parse: parseGmlInfo },
  { format: 'text/xml', parse: parseEsriXmlInfo },
  { format: 'text/plain', parse: parseTextInfo },
];

export function registerIdentifyRoute(ctx: OverlayContext): void {
  const { app, byId, fetchImpl } = ctx;

  app.get<{ Params: { id: string }; Querystring: { lat?: string; lng?: string; zoom?: string } }>(
    '/api/overlay/:id/identify',
    async (request, reply) => {
      const layer = byId.get(request.params.id);
      // Narrow onto a local: the per-format callbacks below re-read the
      // upstream, and narrowing on `layer.upstream` does not survive into them.
      const wms = layer?.upstream.kind === 'wms' ? layer.upstream : undefined;
      if (!layer || !wms?.identifyLayers) {
        return reply.code(404).send({ error: 'layer not identifiable' });
      }
      const lat = Number(request.query.lat);
      const lng = Number(request.query.lng);
      const zoom = Number(request.query.zoom);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85) {
        return reply.code(400).send({ error: 'invalid coordinates' });
      }
      const z = Math.min(
        layer.meta.maxzoom,
        Math.max(0, Number.isFinite(zoom) ? Math.round(zoom) : layer.meta.maxzoom),
      );
      const frac = tileCoords(lat, lng, z);
      const tx = Math.floor(frac.x);
      const ty = Math.floor(frac.y);
      const px = Math.min(255, Math.floor((frac.x - tx) * 256));
      const py = Math.min(255, Math.floor((frac.y - ty) * 256));

      let upstreamDown = false;
      for (const { format, parse } of IDENTIFY_FORMATS) {
        const url = wmsBaseParams(wms, z, tx, ty);
        const p = url.searchParams;
        p.set('REQUEST', 'GetFeatureInfo');
        p.set('QUERY_LAYERS', wms.identifyLayers);
        p.set('INFO_FORMAT', format);
        p.set('FEATURE_COUNT', '10');
        // 1.3.0 renamed the identify pixel params X/Y → I/J.
        p.set(wms.version === '1.3.0' ? 'I' : 'X', String(px));
        p.set(wms.version === '1.3.0' ? 'J' : 'Y', String(py));
        try {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) continue;
          const body = await res.text();
          if (/ServiceException|ExceptionReport/i.test(body)) continue; // format unsupported
          const results = parse(body);
          if (results === null) continue; // unparseable in this format
          ctx.record(layer.meta.id, true);
          const selected = results
            .map((r) => selectFields(r, wms.identifyFields))
            .filter((r) => Object.keys(r).length > 0)
            .map((r) => presentFields(r, wms.identifyLabels, wms.identifyValues));
          return { results: selected.slice(0, 8) };
        } catch (err) {
          request.log.warn({ err, layer: layer.meta.id, format }, 'identify upstream failed');
          upstreamDown = true;
        }
      }
      if (upstreamDown) {
        ctx.record(layer.meta.id, false, 'identify unreachable');
        return reply.code(502).send({ error: 'identify unavailable' });
      }
      ctx.record(layer.meta.id, true);
      return { results: [] };
    },
  );
}
