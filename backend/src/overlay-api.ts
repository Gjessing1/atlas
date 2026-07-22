import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LayerMeta } from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';

/**
 * Overlay layer registry + WMS/XYZ tile proxy + GetFeatureInfo identify proxy.
 *
 * The registry is data, not code: a new overlay = a new `OverlayLayer` record
 * in `norwegianLayers()`. Clients get the stripped catalog at /api/layers
 * (LayerMeta only — upstream URLs/tokens never leave the backend) and fetch
 * tiles through /api/overlay/:id/:z/:x/:y.png, which converts z/x/y to WMS
 * GetMap requests in EPSG:3857 and caches results on disk. The cache dir is
 * disposable — government topo data changes on the order of months, so tiles
 * are cached indefinitely and the directory can be wiped freely.
 */

// ---- registry ----

interface WmsUpstream {
  kind: 'wms';
  url: string;
  version: '1.1.1' | '1.3.0';
  /** Comma-separated WMS layer names for GetMap. */
  layers: string;
  /** QUERY_LAYERS for GetFeatureInfo; unset = not identifiable. */
  identifyLayers?: string;
  /**
   * Ordered allow-list of identify attributes worth showing. Unset = pass
   * everything through (the generic noise filter still applies).
   *
   * Needed because a rich upstream answers with far more than a reader wants:
   * NVE's lake polygon returns ~25 attributes (catchment area, normal runoff,
   * PDF filenames, municipality number), and clients render the *first* handful
   * in upstream order — so without a list the depth gets crowded out by
   * bookkeeping. Names are matched case-insensitively, since the same field is
   * `maksdyp` over WMS and `maksdyp_m` over the REST service.
   */
  identifyFields?: string[];
  styles?: string;
  /**
   * Render GetMap tiles at this multiple of 256 px (with a matching DPI hint),
   * so fine linework and labels stay crisp on high-density phone screens
   * instead of being drawn at 256 px and stretched. 1 (or unset) = plain 256 px.
   * Only meaningful for sources whose symbology carries thin lines or text
   * (bathymetry contours + soundings); a shaded raster gains nothing from it.
   */
  renderScale?: number;
}

interface XyzUpstream {
  kind: 'xyz';
  /** A {z}/{x}/{y} URL template. May reference env tokens as ${VAR}. */
  template: string;
}

export interface OverlayLayer {
  meta: LayerMeta;
  upstream: WmsUpstream | XyzUpstream;
  /**
   * Env var that must be set for this layer to exist (tokened sources).
   * Unset ⇒ the layer silently drops out of the catalog — no broken entries,
   * no leaked endpoint. Reference the value in upstream URLs as ${VAR}.
   */
  requiresEnv?: string;
}

const KARTKATALOG = 'https://kartkatalog.geonorge.no/search?text=';

/** The curated Norwegian catalog (docs/DATA-SOURCES.md is the reference). */
export function norwegianLayers(): OverlayLayer[] {
  return [
    {
      meta: {
        id: 'hillshade',
        title: 'Hillshade',
        description: 'Terrain relief shading from the national elevation model.',
        group: 'Terrain',
        attribution: '© Kartverket',
        metadataUrl: `${KARTKATALOG}h%C3%B8ydemodell`,
        maxzoom: 15,
        defaultOpacity: 0.35,
        identify: false,
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.hoyde-dtm-nhm-25833',
        version: '1.3.0',
        layers: 'NHM_DTM_25833:skyggerelieff',
      },
    },
    {
      meta: {
        id: 'lake-depth',
        title: 'Lake depth',
        description: 'Bathymetry of surveyed lakes: depth shading, contours and soundings.',
        group: 'Water & depth',
        attribution: '© NVE',
        metadataUrl: `${KARTKATALOG}innsj%C3%B8database`,
        maxzoom: 15,
        defaultOpacity: 0.8,
        identify: true,
        coverageNote: 'Only surveyed lakes carry depth data — blank water is normal.',
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.nve.no/enterprise/services/Innsjodatabase2/MapServer/WMSServer',
        version: '1.3.0',
        // DybdePunkt (the individual depth soundings) is drawn last so the
        // single depth numbers land on top of the shading and contours — it was
        // previously only in identifyLayers, so the numbers a lake carries never
        // appeared on the map, only on a tap.
        layers: 'Dybdekart,DybdeKurve,DybdePunkt',
        // `Dybdekart` is the per-lake *polygon*, and it is the only one of the
        // three that answers for a lake NVE surveyed but drew no vectors for:
        // it carries `maksdyp_m`/`middeldyp_m` as attributes. Verkensvannet
        // (vatnlnr 2478, 59.813/10.370) is exactly that case — 21.5 m max depth
        // recorded in 1965, yet zero DybdePunkt and zero DybdeKurve features, so
        // identifying only the vector layers returned nothing at all. Listed
        // last so a real sounding or contour still wins when one exists.
        identifyLayers: 'DybdePunkt,DybdeKurve,Dybdekart',
        // Depth first, then just enough provenance to judge it — these surveys
        // are often decades old (Verkensvannet's is from 1965) and the contour
        // interval says how precise the reading is. `dybde_m` answers for a
        // sounding/contour hit, `maksdyp`/`middeldyp` for the lake polygon;
        // both spellings of the name are listed because the layers disagree.
        identifyFields: [
          'navn',
          'innsjonavn',
          'dybde_m',
          'maksdyp',
          'middeldyp',
          'oppmaltAar',
          'ekv_m',
          'kommune',
        ],
        // Contours + sounding labels are thin/small; render at 2× so they stay
        // legible on a phone instead of a stretched, muddy 256 px tile.
        renderScale: 2,
      },
    },
    {
      meta: {
        id: 'sea-depth',
        title: 'Sea depth',
        description: 'Coastal depth shading, contours and soundings.',
        group: 'Water & depth',
        attribution: '© Kartverket',
        metadataUrl: `${KARTKATALOG}dybdedata`,
        maxzoom: 15,
        defaultOpacity: 0.8,
        identify: false,
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.dybdedata2',
        version: '1.3.0',
        layers: 'Dybdedata2',
      },
    },
    {
      meta: {
        id: 'property',
        title: 'Property boundaries',
        description: 'Cadastral parcel boundaries (eiendomsgrenser) from Matrikkelen.',
        group: 'Property',
        attribution: '© Kartverket',
        metadataUrl: `${KARTKATALOG}matrikkelen`,
        minzoom: 14,
        maxzoom: 18,
        defaultOpacity: 0.9,
        identify: true,
        coverageNote: 'Tap-to-identify a parcel (gnr/bnr) is reliable from z18.',
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.matrikkelkart',
        version: '1.3.0',
        layers: 'eiendomsgrense',
        identifyLayers: 'teig',
      },
    },
    {
      meta: {
        id: 'trails-hiking',
        title: 'Hiking trails',
        description: 'Marked walking routes (Fotrute) from the national trail database.',
        group: 'Trails',
        attribution: '© Kartverket',
        metadataUrl: `${KARTKATALOG}tur-%20og%20friluftsruter`,
        maxzoom: 15,
        defaultOpacity: 0.9,
        identify: false,
        profiles: ['hiking'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.friluftsruter2',
        version: '1.3.0',
        layers: 'Fotrute',
      },
    },
    {
      meta: {
        id: 'trails-ski',
        title: 'Ski tracks',
        description: 'Marked cross-country ski routes (Skiløype).',
        group: 'Trails',
        attribution: '© Kartverket',
        metadataUrl: `${KARTKATALOG}tur-%20og%20friluftsruter`,
        maxzoom: 15,
        defaultOpacity: 0.9,
        identify: false,
        profiles: ['ski'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.friluftsruter2',
        version: '1.3.0',
        layers: 'Skiløype',
      },
    },
    {
      meta: {
        id: 'trails-bike',
        title: 'Bike routes',
        description: 'Marked cycling routes (Sykkelrute).',
        group: 'Trails',
        attribution: '© Kartverket',
        metadataUrl: `${KARTKATALOG}tur-%20og%20friluftsruter`,
        maxzoom: 15,
        defaultOpacity: 0.9,
        identify: false,
        profiles: ['bike'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.friluftsruter2',
        version: '1.3.0',
        layers: 'Sykkelrute',
      },
    },
  ];
}

// ---- tile math (EPSG:3857) ----

const WEB_MERCATOR_EXTENT = 20037508.342789244;

/** [minx, miny, maxx, maxy] of a z/x/y tile in EPSG:3857 metres. */
export function tileBbox3857(z: number, x: number, y: number): [number, number, number, number] {
  const size = (2 * WEB_MERCATOR_EXTENT) / 2 ** z;
  const minX = -WEB_MERCATOR_EXTENT + x * size;
  const maxY = WEB_MERCATOR_EXTENT - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

/** Fractional web-mercator tile coordinates of a lat/lng at zoom z. */
function tileCoords(lat: number, lng: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

/**
 * `size` is the GetMap image edge in px. Identify keeps the default 256 (its
 * I/J pixel is computed against a 256 px tile); GetMap can ask for a larger
 * image over the same bbox for hi-dpi rendering (see `renderScale`).
 */
function wmsBaseParams(u: WmsUpstream, z: number, x: number, y: number, size = 256): URL {
  const url = new URL(u.url);
  const p = url.searchParams;
  p.set('SERVICE', 'WMS');
  p.set('VERSION', u.version);
  p.set('LAYERS', u.layers);
  p.set('STYLES', u.styles ?? '');
  p.set('FORMAT', 'image/png');
  p.set('TRANSPARENT', 'TRUE');
  p.set('WIDTH', String(size));
  p.set('HEIGHT', String(size));
  // A bigger image over the same bbox is only crisper if the server also scales
  // its symbology; the DPI hint asks it to (ArcGIS honours DPI, MapServer/
  // GeoServer MAP_RESOLUTION — both are set, unknown params are ignored). Left
  // off at 256 px so plain tiles keep their existing request shape.
  if (size !== 256) {
    const dpi = String(Math.round((96 * size) / 256));
    p.set('DPI', dpi);
    p.set('MAP_RESOLUTION', dpi);
  }
  // 1.3.0 uses CRS, 1.1.1 uses SRS; EPSG:3857 keeps x,y axis order in both.
  p.set(u.version === '1.3.0' ? 'CRS' : 'SRS', 'EPSG:3857');
  p.set('BBOX', tileBbox3857(z, x, y).join(','));
  return url;
}

function substituteEnv(template: string, env: Record<string, string | undefined>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '');
}

// ---- identify response parsing (multi-format fallback) ----

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

function cleanProps(props: Record<string, unknown>): Record<string, string> {
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
function selectFields(
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

function parseGeojsonInfo(body: string): Record<string, string>[] | null {
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
function parseGmlInfo(body: string): Record<string, string>[] {
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
function parseEsriXmlInfo(body: string): Record<string, string>[] | null {
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
function parseTextInfo(body: string): Record<string, string>[] {
  const props: Record<string, unknown> = {};
  for (const m of body.matchAll(/^\s+([\w.-]+)\s*=\s*'?([^'\n]*)'?\s*$/gm)) {
    props[m[1]!] = m[2]!;
  }
  const cleaned = cleanProps(props);
  return Object.keys(cleaned).length > 0 ? [cleaned] : [];
}

// ---- the API ----

/** 1×1 fully transparent PNG — the "blank ≠ broken" fallback tile. */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);

const TILE_MAX_AGE_S = 7 * 24 * 3600; // upstream data changes on the order of months

export interface OverlayApiOptions {
  /** Disk tile cache root (disposable volume — wipe freely). */
  cacheDir: string;
  /** Test seam: replaces the built-in Norwegian registry. */
  layers?: OverlayLayer[];
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Test seam: env for token gating / URL substitution. */
  env?: Record<string, string | undefined>;
  /** Health registry: each configured layer is a probed source. */
  status?: StatusRegistry;
}

export function registerOverlayApi(app: FastifyInstance, opts: OverlayApiOptions): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  // Tokened layers without their env var drop out silently (no broken rows).
  const layers = (opts.layers ?? norwegianLayers()).filter(
    (l) => !l.requiresEnv || Boolean(env[l.requiresEnv]),
  );
  const byId = new Map(layers.map((l) => [l.meta.id, l]));

  // Each catalog source shows on the status page, unknown until a tile/identify
  // request actually exercises it.
  const status = opts.status;
  const probeId = (id: string) => `overlay:${id}`;
  for (const l of layers) status?.register(probeId(l.meta.id), l.meta.title, 'Overlays');

  // Public catalog: LayerMeta only — never the upstream config.
  app.get('/api/layers', () => ({ layers: layers.map((l) => l.meta) }));

  const cachePath = (id: string, z: number, x: number, y: number) =>
    path.join(opts.cacheDir, id, String(z), String(x), `${y}.png`);

  async function writeCache(file: string, data: Buffer): Promise<void> {
    // Temp-file + rename so a concurrent reader never sees a half tile; cache
    // failures only cost a re-fetch, so they log instead of failing the request.
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch (err) {
      app.log.warn({ err, file }, 'overlay tile cache write failed');
    }
  }

  app.get<{ Params: { id: string; z: string; x: string; y: string } }>(
    '/api/overlay/:id/:z/:x/:y.png',
    async (request, reply) => {
      const layer = byId.get(request.params.id);
      if (!layer) return reply.code(404).send({ error: 'unknown layer' });
      const z = Number(request.params.z);
      const x = Number(request.params.x);
      const y = Number(request.params.y);
      const valid =
        Number.isInteger(z) &&
        Number.isInteger(x) &&
        Number.isInteger(y) &&
        z >= 0 &&
        z <= layer.meta.maxzoom &&
        x >= 0 &&
        y >= 0 &&
        x < 2 ** z &&
        y < 2 ** z;
      if (!valid) return reply.code(400).send({ error: 'invalid tile coordinates' });

      const servePng = (data: Buffer, maxAge = TILE_MAX_AGE_S) =>
        reply
          .header('content-type', 'image/png')
          .header('cache-control', `public, max-age=${maxAge}`)
          .send(data);

      const file = cachePath(layer.meta.id, z, x, y);
      const cached = await readFile(file).catch(() => null);
      if (cached) return servePng(cached);

      const upstream =
        layer.upstream.kind === 'wms'
          ? wmsBaseParams(
              layer.upstream,
              z,
              x,
              y,
              256 * Math.max(1, Math.round(layer.upstream.renderScale ?? 1)),
            )
          : new URL(
              substituteEnv(layer.upstream.template, env)
                .replace('{z}', String(z))
                .replace('{x}', String(x))
                .replace('{y}', String(y)),
            );
      if (layer.upstream.kind === 'wms') upstream.searchParams.set('REQUEST', 'GetMap');

      try {
        const res = await fetchImpl(upstream, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          request.log.error({ layer: layer.meta.id, status: res.status }, 'overlay upstream error');
          status?.record(probeId(layer.meta.id), false, `HTTP ${res.status}`);
          return reply.code(502).send({ error: 'overlay unavailable' });
        }
        const contentType = res.headers.get('content-type') ?? '';
        // The upstream answered either way — a non-image ServiceException means
        // "no data here", not "service down", so both count as reachable.
        status?.record(probeId(layer.meta.id), true);
        if (!contentType.startsWith('image/')) {
          // A 200 with XML is a ServiceException (out of coverage, bad layer,
          // …): serve a transparent tile so the map shows blank, not broken —
          // short-lived so recovery isn't cached away.
          const body = (await res.text()).slice(0, 300);
          request.log.warn({ layer: layer.meta.id, contentType, body }, 'overlay non-image reply');
          return servePng(TRANSPARENT_PNG, 60);
        }
        const data = Buffer.from(await res.arrayBuffer());
        await writeCache(file, data);
        return servePng(data);
      } catch (err) {
        request.log.error({ err, layer: layer.meta.id }, 'overlay upstream unreachable');
        status?.record(probeId(layer.meta.id), false, 'unreachable');
        return reply.code(502).send({ error: 'overlay unavailable' });
      }
    },
  );

  // Tap-to-identify: GetFeatureInfo with nodemap's multi-format fallback
  // (geojson → GML → text/plain; a ServiceException body means try the next).
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

      const formats: {
        format: string;
        parse: (body: string) => Record<string, string>[] | null;
      }[] = [
        { format: 'application/json', parse: parseGeojsonInfo },
        { format: 'application/vnd.ogc.gml', parse: parseGmlInfo },
        { format: 'text/xml', parse: parseEsriXmlInfo },
        { format: 'text/plain', parse: parseTextInfo },
      ];
      let upstreamDown = false;
      for (const { format, parse } of formats) {
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
          status?.record(probeId(layer.meta.id), true);
          const selected = results
            .map((r) => selectFields(r, wms.identifyFields))
            .filter((r) => Object.keys(r).length > 0);
          return { results: selected.slice(0, 8) };
        } catch (err) {
          request.log.warn({ err, layer: layer.meta.id, format }, 'identify upstream failed');
          upstreamDown = true;
        }
      }
      if (upstreamDown) {
        status?.record(probeId(layer.meta.id), false, 'identify unreachable');
        return reply.code(502).send({ error: 'identify unavailable' });
      }
      status?.record(probeId(layer.meta.id), true);
      return { results: [] };
    },
  );
}
