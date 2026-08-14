import { normalizeLayerOptions } from '@atlas/core';
import type { FastifyBaseLogger } from 'fastify';
import type { OverlayLayer } from './overlay/catalog.js';
import { optionGetMapParams } from './overlay/options.js';
import { substituteEnv, tileCoords, wmsBaseParams } from './overlay/wms.js';
import type { StatusRegistry } from './status.js';

/**
 * Active upstream probes (ROADMAP § N7).
 *
 * The status page used to learn only from real traffic, and that has one hole
 * this file exists to close: **a source nobody opens is never checked**, and the
 * tile proxy answers later views from its disk cache without ever asking
 * upstream again. So a Norwegian government service can change under us and the
 * only symptom is a blank patch of map that nobody connects to anything.
 *
 * That is not hypothetical. Two concrete failures shaped this:
 *
 * - `statskog-jaktfelt` points at a **year-named** service (`Storvilt_2024`).
 *   The day Statskog publishes the next year we silently serve last year's
 *   hunting fields — wrong data, HTTP 200, no error anywhere — and the day they
 *   delete the old one it breaks outright.
 * - `kart.miljodirektoratet.no` stopped presenting a complete TLS chain, which
 *   killed the `wildlife-areas` overlay stone dead in production. Cached tiles
 *   kept drawing, so nothing *looked* wrong; it was found by hand, months could
 *   have passed. (See backend/certs/upstream-cas.pem.)
 *
 * So each source gets **one cheap request every few hours**, and each probe
 * asserts something stronger than "the socket opened":
 *
 * - a raster layer must return an image **with ink in it** at a place and zoom
 *   where it is known to draw — that is what catches a scale range moving or a
 *   dataset being republished empty;
 * - a feature layer must return a **plausible count**, not merely a count;
 * - a year-named service is asked whether its **successor has appeared**.
 *
 * The load is deliberately tiny (a few dozen requests a day against national
 * services), and **met.no is not swept at all** — its ToS asks for no synthetic
 * polling, and the weather proxy's own traffic already reports it.
 */

/** Identifying UA, same shape as the weather/elevation proxies use. */
const PROBE_USER_AGENT =
  process.env.GEONORGE_USER_AGENT ??
  'atlas-maps/1.0 git.gjessing.io/gjessing1/atlas lars@gjessing.io';

/** One probe's verdict. */
export interface ProbeOutcome {
  /** Did the upstream answer at all? */
  ok: boolean;
  /** Why not, when `ok` is false. */
  message?: string;
  /**
   * The silent failure: it answered, but the answer is not to be trusted.
   * Always set explicitly (null when clean) so a recovery clears the flag.
   */
  warning?: string | null;
  /** One line of context for the status page ("1 954 539 segments"). */
  detail?: string | null;
}

export interface ProbeSpec {
  /** Status-registry source id. Existing ids are reused so a probe and the */
  /** proxy traffic for the same upstream share one row. */
  id: string;
  label: string;
  group: string;
  run(fetchImpl: typeof fetch): Promise<ProbeOutcome>;
}

/** Where and how a catalog layer is checked for signs of life. */
export type LayerProbe =
  | {
      kind: 'tile';
      /** A place the layer is known to draw something. */
      lat: number;
      lng: number;
      /** A zoom inside the upstream's scale range (see `minzoom`). */
      z: number;
      /**
       * Bytes below which the tile counts as **blank**: the upstream answered
       * and drew nothing. This is the check that notices a scale range moving
       * or coverage vanishing, neither of which changes the HTTP status.
       *
       * Every value below was calibrated against the live services on
       * 2026-07-27, measuring both an inked tile and a deliberately empty one
       * (mid-North-Sea) per upstream, because the two software stacks have
       * different floors: **MapServer** (geonorge, NIBIO) returns a **334 B**
       * empty PNG, **ArcGIS** (NVE, Miljødirektoratet) an **888 B** one. A
       * single shared threshold would therefore either miss a dead ArcGIS layer
       * or cry wolf on a live MapServer one.
       *
       * Byte size is a proxy for detail, not for area, so a probe tile is
       * chosen where the layer draws *edges*: a tile filled flatly with one
       * colour compresses down towards the empty size and would read as blank.
       */
      minBytes: number;
    }
  | {
      kind: 'count';
      /**
       * Lowest plausible feature count. Set well under the count measured when
       * the row was written (see docs/DATA-SOURCES.md), so normal editing never
       * cries wolf but a republished-empty layer does.
       */
      minFeatures: number;
    };

/**
 * The reference point and expected ink for every catalog layer, in one table so
 * the whole monitoring surface reads at a glance. `probes.test.ts` asserts this
 * covers `norwegianLayers()` exactly — which is what stops a new Norwegian
 * layer from quietly shipping unwatched, the specific rot N7 exists to prevent.
 *
 * Points were chosen against the live services: several layers only draw where
 * their subject *is*, so a single national reference point would report a
 * healthy service as blank (bathymetry exists for 607 lakes, weakened ice for
 * regulated water, wildlife areas only where surveyed).
 */
export const OVERLAY_PROBES: Record<string, LayerProbe> = {
  // Nordmarka: forest, lakes, contours and a dense trail network in one tile —
  // the default reference point for anything with national coverage. Measured
  // ink / empty, 2026-07-27: 34.0 kB / 0.5, 13.4 / 0.3, 130.8 / 0.3,
  // 8.9 / 0.3, 8.3 / 0.3 kB.
  hillshade: { kind: 'tile', lat: 60.05, lng: 10.7, z: 12, minBytes: 2000 },
  'terrain-contours': { kind: 'tile', lat: 60.05, lng: 10.7, z: 13, minBytes: 2000 },
  'satellite-2025': { kind: 'tile', lat: 60.05, lng: 10.7, z: 12, minBytes: 2000 },
  // Esri World Imagery over central Oslo: one of Norway's genuine z19 detail
  // tiles, rather than the opaque 2.5 kB missing-image sentinel returned where
  // coverage stops at z18 (14.9 kB measured 2026-08-14).
  'world-imagery': { kind: 'tile', lat: 59.9139, lng: 10.7522, z: 19, minBytes: 5000 },
  'trails-hiking': { kind: 'tile', lat: 60.05, lng: 10.7, z: 13, minBytes: 2000 },
  'trails-ski': { kind: 'tile', lat: 60.05, lng: 10.7, z: 13, minBytes: 2000 },
  // AR5 refuses to draw below 1:50 000, so this one must be asked at z14+
  // (17.2 kB there, 0.3 at z13 — the scale floor and a dead layer look alike,
  // which is exactly why the probe zoom is pinned).
  'land-cover': { kind: 'tile', lat: 60.05, lng: 10.7, z: 14, minBytes: 2000 },
  // Steepness only inks where the ground is steep: Jotunheimen, not a forest
  // (16.1 kB / 0.9).
  'terrain-slope': { kind: 'tile', lat: 61.63, lng: 8.31, z: 12, minBytes: 2000 },
  // Semsvannet — one of the 607 surveyed lakes, and the acceptance lake of the
  // Fish & Hunt engine. A bathymetry probe over an unsurveyed lake proves
  // nothing, because blank is the correct answer there: 3.5 kB here against
  // 1.3 kB over the unsurveyed Dikemark lakes 5 km away.
  'lake-depth': { kind: 'tile', lat: 59.85834, lng: 10.42062, z: 13, minBytes: 2000 },
  // Maridalen: `elvenett` is scale-staged and starts at z13 (2.7 kB / 0.9).
  rivers: { kind: 'tile', lat: 60.0, lng: 10.79, z: 13, minBytes: 1500 },
  // Inner Oslofjord — sea depth needs sea (43.5 kB / 0.3 inland).
  'sea-depth': { kind: 'tile', lat: 59.7, lng: 10.55, z: 12, minBytes: 2000 },
  // Mjøsa's 369 km² weakened-ice area: the largest in the country, so this
  // stays true even if NVE re-draws the smaller ones. Asked at z11 rather than
  // a closer zoom on purpose — the whole-lake outline carries the most linework
  // (2.7 kB, against 1.9 at z13 and 0.9 empty), and area fills compress away.
  'ice-weak': { kind: 'tile', lat: 60.97, lng: 10.607, z: 11, minBytes: 1800 },
  // A surveyed moose area in Hardanger, probed with the layer's *default*
  // species filter (big game) so the probe exercises the SLD path a user gets —
  // the filter is the part of this layer that fails silently. 2.0 kB / 0.9.
  'wildlife-areas': { kind: 'tile', lat: 59.883, lng: 6.448, z: 13, minBytes: 1400 },
  // Cadastral lines need a built-up area and z14+ (89.0 kB / 0.3).
  property: { kind: 'tile', lat: 59.9139, lng: 10.7522, z: 14, minBytes: 2000 },
  // Hamar, by Mjøsa. Not Oslo: `Sykkelrute` in Turrutebasen is *recreational*
  // cycling, and central Oslo has none of it — the first probe point picked
  // reported a perfectly healthy layer as blank (4.2 kB here, 0.3 in Oslo).
  'trails-bike': { kind: 'tile', lat: 60.795, lng: 11.068, z: 13, minBytes: 1500 },
  // 922 hunting fields nationally (2026-07). A floor, not the count: Statskog
  // redraws fields between seasons.
  'statskog-jaktfelt': { kind: 'count', minFeatures: 400 },

  // --- Curiosities (ROADMAP §4.7) -------------------------------------------
  // Every point and threshold below measured against the live services on
  // 2026-08-03, ink tile / empty tile, with the same LAYERS string the catalog
  // sends. These registers only draw where their subject *is* — a national
  // reference point would report half of them as blank — and several are
  // scale-banded, so the zoom is part of the measurement, not a detail.
  //
  // Borre in Horten: the country's densest burial-mound landscape, asked at z15
  // because Askeladden's outlines stop at 1:25 000 and z14 comes back empty
  // (6.2 kB / 0.3).
  'heritage-sites': { kind: 'tile', lat: 59.3806, lng: 10.4436, z: 15, minBytes: 2000 },
  // Kongsvinger's Stollgruva and Hemgruva, the pair the caution zones were
  // first probed against. QGIS Server's empty tile is 355 B, its own floor
  // again — the zones are small polygons, so this is a thin but unambiguous
  // margin (1.3 kB / 0.36).
  'old-mines': { kind: 'tile', lat: 60.1855, lng: 11.9153, z: 14, minBytes: 800 },
  // Byfjorden outside Bergen. Wrecks are single chart symbols, so even a busy
  // tile is small (1.3 kB / 0.3 inland) — the check is that symbols are drawn
  // at all, which is what a scale-band change would take away.
  wrecks: { kind: 'tile', lat: 60.39, lng: 5.2, z: 12, minBytes: 700 },
  // Røros — the wooden mining town, where SEFRAK is dense and the buildings
  // are the reason anyone goes. z14 rather than the layer's z13 floor: the
  // floor is what a scale-band change would move, and z13 already halves the
  // ink (5.6 kB against 12.0), so probing at the edge would make a healthy
  // layer's next redraw look like a failure. 0.3 kB over open sea.
  'old-buildings': { kind: 'tile', lat: 62.5745, lng: 11.3855, z: 14, minBytes: 3000 },
  // Hovedøya and the Oslofjord geosites (7.7 kB).
  geoheritage: { kind: 'tile', lat: 59.91, lng: 10.75, z: 12, minBytes: 2000 },
  // Briksdalsbreen, an outlet of Jostedalsbreen and the largest block of ice in
  // mainland Europe — 6.1 kB at z10, against the 0.3 kB empty tile. Probed with
  // the default chip, so it exercises `Breflate` alone rather than any of the
  // event layers, which are 51 and 185 points nationally and would make a
  // healthy layer look dead anywhere but on top of one of them.
  glaciers: { kind: 'tile', lat: 61.66, lng: 6.95, z: 10, minBytes: 2000 },
  // Kongsberg: the silver, and the densest cluster in the ore register (3.8 kB
  // at z12, against 0.5 kB for a tile with a single occurrence in it and the
  // 0.3 kB empty floor). Asked with the default chip, so the probe exercises
  // the two-band LAYERS string the row is built on — `Punkt_Metaller` alone is
  // *empty* from z8 out and `Forekomster_zoom` alone from z9 in, so a band that
  // moves is the failure this catches.
  'metal-deposits': { kind: 'tile', lat: 59.6686, lng: 9.6497, z: 12, minBytes: 1500 },
  // The Vøring plateau. This point used to be probed at z7 for a 0.64 kB tile,
  // the thinnest margin in the table, because the layer drew mud volcanoes and
  // nothing else — 23 lit pixels nationally. Drawing the whole shallow-gas
  // group instead put a real measurement here: 20.1 kB at z8 (0.3 empty).
  'seabed-gas': { kind: 'tile', lat: 67.6, lng: 6.8, z: 8, minBytes: 4000 },
  // Nannestad on Romerike, where GRANADA has mapped springs as well as
  // boreholes. The probe goes through `optionGetMapParams` with the layer's
  // default chip, which is the whole register again from v0.146.0 — but the
  // point is kept as it was, on ground that has *springs*: it was chosen when
  // the default was springs-only and a suburban point reported the healthy
  // layer as dead, and a point that only works for the widest chip could not
  // catch that returning. 4.1 kB with springs alone, 0.3 kB empty.
  'groundwater-wells': { kind: 'tile', lat: 60.2, lng: 10.28, z: 13, minBytes: 1500 },
  // Loen in Stryn — the Lodalen rock avalanches, the most thoroughly recorded
  // slide ground in Norway. z13 is the first zoom where the release/runout
  // outlines draw beside the typed points (2.2 kB / 0.9).
  'landslide-events': { kind: 'tile', lat: 61.86, lng: 6.85, z: 13, minBytes: 1400 },
  // Same valley, the modelled zones rather than the recorded events. Asked at
  // z13, the last zoom of the generalized band: the detailed pair takes over
  // below it, so this point checks the band the panel opens at (2.4 kB / 0.9).
  'rockfall-hazard': { kind: 'tile', lat: 61.86, lng: 6.85, z: 13, minBytes: 1400 },
  // Oslo, with the layer's *default* chips (severe risk, all organisms) — the
  // probe goes through `optionGetMapParams` like a real request, so it
  // exercises the LAYERS override the chips are built on (51.8 kB / 0.3). z12
  // is also the layer's floor: Artsdatabanken caps the point layers at
  // 1:150 000 and z11 comes back empty, so a probe one zoom coarser would
  // report the healthy layer as dead.
  'alien-species': { kind: 'tile', lat: 59.91, lng: 10.75, z: 12, minBytes: 2000 },
  // Vestfjorden off Lofoten — the cod spawning grounds, and the reason the
  // dataset exists at all (5.1 kB / 0.9 inland).
  'spawning-areas': { kind: 'tile', lat: 68.2, lng: 14.0, z: 10, minBytes: 2000 },
  // Christiania, i.e. Oslo before 1925. The amtskart series is a scanned map,
  // so *any* covered tile is huge (169 kB) and an uncovered one is the 334 B
  // floor — the two are never close, and the risk this guards is a sheet index
  // that stops resolving rather than a thin drawing.
  'historic-maps': { kind: 'tile', lat: 59.91, lng: 10.75, z: 11, minBytes: 20000 },
};

/** ArcGIS answers errors with HTTP 200 and an `error` object — unwrap both. */
interface ArcGisReply {
  count?: number;
  error?: { code?: number; message?: string };
}

async function arcgisJson(url: string, fetchImpl: typeof fetch): Promise<ArcGisReply> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': PROBE_USER_AGENT },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ArcGisReply;
}

/** `?where=1=1&returnCountOnly=true` — the cheapest question a feature layer answers. */
function countUrl(layerQueryUrl: string, where = '1=1'): string {
  const url = new URL(layerQueryUrl);
  url.searchParams.set('where', where);
  url.searchParams.set('returnCountOnly', 'true');
  url.searchParams.set('f', 'json');
  return url.toString();
}

const PROBE_TIMEOUT_MS = 20_000;

/**
 * Thousands-grouped, matching how the docs write these counts (1 954 539).
 * Norwegian grouping uses a non-breaking space; it is normalised to a plain one
 * so the same string reads identically in a log line, a test and the status page.
 */
const groupDigits = (n: number): string => n.toLocaleString('nb-NO').replace(/\u00a0/g, ' ');

/**
 * Count probe: reachable, and still carrying a plausible number of features.
 * A count that collapses is the classic silent failure — a republished layer
 * answers 200 with zero rows and every map using it goes quietly blank.
 */
function countProbe(
  spec: Omit<ProbeSpec, 'run'>,
  queryUrl: string,
  minFeatures: number,
  unit = 'features',
): ProbeSpec {
  return {
    ...spec,
    async run(fetchImpl) {
      const body = await arcgisJson(countUrl(queryUrl), fetchImpl);
      if (body.error) {
        return {
          ok: false,
          message: `ArcGIS ${body.error.code ?? ''} ${body.error.message ?? ''}`.trim(),
        };
      }
      const count = body.count;
      if (typeof count !== 'number') return { ok: false, message: 'no count in reply' };
      const detail = `${groupDigits(count)} ${unit}`;
      return {
        ok: true,
        detail,
        warning:
          count < minFeatures
            ? `only ${groupDigits(count)} ${unit} — expected at least ${groupDigits(minFeatures)}`
            : null,
      };
    },
  };
}

/** Bytes → "12.0 kB", for the detail line. */
const kb = (bytes: number): string => `${(bytes / 1000).toFixed(1)} kB`;

/**
 * Fetch one image and judge it. Shared by the catalog tile probes and the
 * GetMap-only inputs (SR16), because "answered with an image that has ink in
 * it" is the same question in both places.
 */
async function imageProbe(
  url: URL | string,
  minBytes: number,
  fetchImpl: typeof fetch,
  what: string,
): Promise<ProbeOutcome> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': PROBE_USER_AGENT },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
  const contentType = res.headers.get('content-type') ?? '';
  const bytes = (await res.arrayBuffer()).byteLength;
  if (!contentType.startsWith('image/')) {
    // A 200 carrying XML is a ServiceException: the request is wrong or the
    // layer is gone. Unlike the tile proxy — where this legitimately means "out
    // of coverage" — the probe asks at a place the layer is known to draw, so
    // here it is a real failure.
    return { ok: false, message: `not an image (${contentType || 'no content-type'})` };
  }
  return {
    ok: true,
    detail: kb(bytes),
    warning:
      bytes < minBytes
        ? `answers but draws nothing at ${what} (${kb(bytes)}) — scale range or coverage may have changed`
        : null,
  };
}

/**
 * Build the probe for one catalog layer. Derived from the layer's own upstream
 * config and its **default** options, so the probe exercises the exact request
 * a user's first tap produces — including the SLD filtering that the wildlife
 * and river layers depend on and that fails silently when it breaks.
 */
export function overlayProbe(
  layer: OverlayLayer,
  probe: LayerProbe,
  env: Record<string, string | undefined>,
): ProbeSpec {
  const spec = {
    id: `overlay:${layer.meta.id}`,
    label: layer.meta.title,
    group: 'Overlays',
  };
  const up = layer.upstream;

  if (probe.kind === 'count') {
    if (up.kind !== 'arcgis-vector') {
      // A count probe on a raster layer would silently check nothing.
      return {
        ...spec,
        run: async () => ({ ok: false, message: 'count probe on a raster layer' }),
      };
    }
    return countProbe(spec, up.url, probe.minFeatures);
  }
  if (up.kind === 'arcgis-vector') {
    return { ...spec, run: async () => ({ ok: false, message: 'tile probe on a vector layer' }) };
  }

  const { x, y } = tileCoords(probe.lat, probe.lng, probe.z);
  const tile = { z: probe.z, x: Math.floor(x), y: Math.floor(y) };
  const at = `z${probe.z}`;
  return {
    ...spec,
    async run(fetchImpl) {
      let url: URL;
      if (up.kind === 'wms') {
        url = wmsBaseParams(up, tile.z, tile.x, tile.y);
        url.searchParams.set('REQUEST', 'GetMap');
        const chosen = normalizeLayerOptions(layer.meta.options, {});
        for (const [key, value] of Object.entries(optionGetMapParams(layer, chosen))) {
          url.searchParams.set(key, value);
        }
      } else {
        url = new URL(
          substituteEnv(up.template, env)
            .replace('{z}', String(tile.z))
            .replace('{x}', String(tile.x))
            .replace('{y}', String(tile.y)),
        );
      }
      return imageProbe(url, probe.minBytes, fetchImpl, at);
    },
  };
}

/**
 * Statskog's service name carries the season year, and the failure it invites
 * is the reason N7 was made a prerequisite: a new year appears, the old service
 * keeps answering, and Atlas serves last season's hunting fields with no error
 * anywhere. So the probe asks the same question a human would — *is there a
 * newer year?* — and says so on the status page while the old data still works.
 */
export function yearSuccessorProbe(layer: OverlayLayer): ProbeSpec | null {
  if (layer.upstream.kind !== 'arcgis-vector') return null;
  const url = layer.upstream.url;
  const match = /(19|20)\d{2}/.exec(url);
  if (!match) return null;
  const current = Number(match[0]);
  return {
    id: `overlay:${layer.meta.id}:year`,
    label: `${layer.meta.title} — season year`,
    group: 'Overlays',
    async run(fetchImpl) {
      // Two years ahead, because a publisher may skip one (or we may notice
      // late), and a probe that only ever looks one year forward would then
      // never fire again.
      for (const year of [current + 1, current + 2]) {
        const candidate = url.replace(match[0], String(year));
        let body: ArcGisReply;
        try {
          body = await arcgisJson(countUrl(candidate), fetchImpl);
        } catch {
          continue; // a missing service is the expected, healthy answer
        }
        if (body.error || typeof body.count !== 'number' || body.count === 0) continue;
        return {
          ok: true,
          detail: `serving ${current}`,
          warning:
            `${year} data has been published (${groupDigits(body.count)} features) — ` +
            `this layer still serves ${current}`,
        };
      }
      return { ok: true, detail: `${current} is the newest published`, warning: null };
    },
  };
}

// ---- The N5 engine inputs -------------------------------------------------
//
// A derived surface fails far less visibly than an overlay: nobody sees a
// missing input, they see a slightly different heatmap. These are the inputs
// docs/FISH-HUNT-ENGINE.md leans on, probed the same way.

const NVE_REST = 'https://kart.nve.no/enterprise/rest/services';
const MILJO_REST = 'https://kart.miljodirektoratet.no/arcgis/rest/services';

/**
 * The DTM is the linchpin of the whole derived engine: without elevation there
 * is no slope, no nearshore drop-off, no channel gradient. Probed as a real
 * (small) GetCoverage, because the failure mode that matters is the WCS
 * dialect changing — DescribeCoverage and WCS 2.0.1 are already known not to
 * work here, so a capabilities request would prove nothing about the one form
 * that does.
 */
function dtmProbe(): ProbeSpec {
  return {
    id: 'input:dtm',
    label: 'Kartverket DTM (elevation raster)',
    group: 'Engine inputs',
    async run(fetchImpl) {
      const url = new URL('https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833');
      const p = url.searchParams;
      p.set('SERVICE', 'WCS');
      p.set('VERSION', '1.0.0');
      p.set('REQUEST', 'GetCoverage');
      p.set('COVERAGE', 'nhm_dtm_topo_25833');
      p.set('CRS', 'EPSG:4326');
      p.set('BBOX', '10.41,59.85,10.43,59.87');
      p.set('WIDTH', '32');
      p.set('HEIGHT', '32');
      p.set('FORMAT', 'GeoTIFF');
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': PROBE_USER_AGENT },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      // A 32×32 float32 coverage is ~4 kB plus header; anything tiny is a
      // ServiceException wearing an image content-type.
      if (buf.length < 1000) {
        return { ok: false, message: `${buf.length} bytes — not a coverage` };
      }
      const magic = buf.subarray(0, 2).toString('latin1');
      if (magic !== 'II' && magic !== 'MM') {
        return { ok: false, message: 'reply is not a TIFF' };
      }
      return { ok: true, detail: `32² GeoTIFF, ${kb(buf.length)}`, warning: null };
    },
  };
}

/**
 * SR16 has no WCS, so classification off a GetMap PNG is the only raster path,
 * and `SRRHOYDEO` (dominant tree height) is the one field taken from it. The
 * probe asks over forest, where it must have ink.
 */
function sr16Probe(): ProbeSpec {
  return {
    id: 'input:sr16',
    label: 'NIBIO SR16 (stand maturity)',
    group: 'Engine inputs',
    async run(fetchImpl) {
      const { x, y } = tileCoords(60.05, 10.7, 14);
      const url = wmsBaseParams(
        {
          kind: 'wms',
          url: 'https://wms.nibio.no/cgi-bin/sr16',
          version: '1.3.0',
          layers: 'SRRHOYDEO',
        },
        14,
        Math.floor(x),
        Math.floor(y),
      );
      url.searchParams.set('REQUEST', 'GetMap');
      // 6.4 kB of classified stand heights over Nordmarka against NIBIO's
      // 334-byte empty PNG (measured 2026-07-27).
      return imageProbe(url, 1500, fetchImpl, 'z14 over forest');
    },
  };
}

/** HydAPI needs a free key; without one the probe reports the gap rather than failing. */
function hydapiProbe(env: Record<string, string | undefined>): ProbeSpec {
  return {
    id: 'input:hydapi',
    label: 'NVE HydAPI (live flow & water temp)',
    group: 'Engine inputs',
    async run(fetchImpl) {
      const key = env['NVE_HYDAPI_KEY'];
      if (!key) {
        return {
          ok: true,
          detail: 'no key configured — live flow and water temperature are off',
          warning: null,
        };
      }
      const res = await fetchImpl('https://hydapi.nve.no/api/v1/Parameters', {
        headers: { 'X-API-Key': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // 401/403 is the answer that matters: the key was revoked or mistyped,
      // and every conditions read would silently lose its measured series.
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `key rejected (HTTP ${res.status})` };
      }
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      return { ok: true, detail: 'key accepted', warning: null };
    },
  };
}

/**
 * The regional harvest prior behind the hunt surface's absolute tier: SSB's
 * felte-elg table, asked nationally.
 *
 * Probed on the national row rather than a kommune, because the failure that
 * matters is the query *shape* — StatBank renames a dimension or retires a
 * table long before it goes down — and a national figure has a floor worth
 * asserting: Norway shoots ~30 000 moose a season and has not been near 10 000
 * since the 1970s.
 */
function harvestProbe(): ProbeSpec {
  return {
    id: 'input:harvest',
    label: 'SSB felte elg (regional prior)',
    group: 'Engine inputs',
    async run(fetchImpl) {
      const res = await fetchImpl('https://data.ssb.no/api/v0/no/table/03432', {
        method: 'POST',
        headers: { 'User-Agent': PROBE_USER_AGENT, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: [
            { code: 'Region', selection: { filter: 'item', values: ['0'] } },
            { code: 'Dyr', selection: { filter: 'item', values: ['00a'] } },
            { code: 'Kjonn', selection: { filter: 'item', values: ['0'] } },
            { code: 'Tid', selection: { filter: 'top', values: ['1'] } },
          ],
          response: { format: 'json-stat2' },
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const body = (await res.json()) as {
        value?: (number | null)[];
        dimension?: { Tid?: { category?: { index?: Record<string, number> } } };
      };
      const felt = body.value?.[0];
      const season = Object.keys(body.dimension?.Tid?.category?.index ?? {})[0] ?? 'unknown season';
      if (typeof felt !== 'number') return { ok: false, message: 'no figure in the reply' };
      return {
        ok: true,
        detail: `${groupDigits(felt)} elg felt nationally, ${season}`,
        warning: felt < 10_000 ? `only ${groupDigits(felt)} — query shape may have changed` : null,
      };
    },
  };
}

/** Kommuneinfo turns a cell centre into the kommune the harvest prior needs. */
function kommuneProbe(): ProbeSpec {
  return {
    id: 'input:kommune',
    label: 'Kartverket kommuneinfo',
    group: 'Engine inputs',
    async run(fetchImpl) {
      const res = await fetchImpl(
        'https://api.kartverket.no/kommuneinfo/v1/punkt?nord=59.86&ost=10.42&koordsys=4258',
        {
          headers: { 'User-Agent': PROBE_USER_AGENT },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
      );
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const body = (await res.json()) as { kommunenummer?: string; kommunenavn?: string };
      // Asker is 3203 since the 2024 reform. A different answer here is a
      // renumbering, which is exactly what silently breaks the SSB join.
      if (body.kommunenummer !== '3203') {
        return {
          ok: true,
          detail: `answers ${body.kommunenavn ?? '?'} (${body.kommunenummer ?? '?'})`,
          warning: `expected Asker 3203 at this point, got ${body.kommunenummer ?? 'nothing'} — kommune numbers may have changed`,
        };
      }
      return { ok: true, detail: `${body.kommunenavn} ${body.kommunenummer}`, warning: null };
    },
  };
}

/** GBIF answers species presence keyless; used to sanity-check a target. */
function gbifProbe(): ProbeSpec {
  return {
    id: 'input:gbif',
    label: 'GBIF (species presence)',
    group: 'Engine inputs',
    async run(fetchImpl) {
      const url =
        'https://api.gbif.org/v1/occurrence/search' +
        '?scientificName=Salmo%20trutta&country=NO&hasCoordinate=true&limit=0';
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': PROBE_USER_AGENT },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const body = (await res.json()) as { count?: number };
      const count = body.count ?? 0;
      return {
        ok: true,
        detail: `${groupDigits(count)} Salmo trutta records in Norway`,
        // Over a million were recorded 2026-07; a five-figure answer means the
        // query shape changed, not that the trout left.
        warning:
          count < 100_000
            ? `only ${groupDigits(count)} records — query shape may have changed`
            : null,
      };
    },
  };
}

/**
 * Regobs is a rolling vector feed rather than a catalog WMS, so it cannot use
 * OVERLAY_PROBES. Ask for one Norwegian ice registration from the last year:
 * enough to catch a changed search contract or an empty republish without
 * manufacturing meaningful traffic.
 */
export function regobsProbe(): ProbeSpec {
  return {
    id: 'regobs',
    label: 'NVE Regobs (ice observations)',
    group: 'Hunting & fishing',
    async run(fetchImpl) {
      const now = Date.now();
      const res = await fetchImpl('https://api.regobs.no/v6/Search', {
        method: 'POST',
        headers: {
          'User-Agent': PROBE_USER_AGENT,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          LangKey: 2,
          SelectedGeoHazards: [70],
          FromDtObsTime: new Date(now - 365 * 24 * 60 * 60_000).toISOString(),
          ToDtObsTime: new Date(now).toISOString(),
          NumberOfRecords: 1,
          Offset: 0,
          OrderBy: 'DtObsTime',
          AscendingOrder: false,
          Extent: {
            TopLeft: { Latitude: 72, Longitude: 4 },
            BottomRight: { Latitude: 57, Longitude: 32 },
          },
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return { ok: false, message: 'search reply is not an array' };
      const first = body[0] as
        { RegId?: unknown; DtObsTime?: unknown; ObsLocation?: unknown } | undefined;
      if (!first) {
        return {
          ok: true,
          detail: 'search answered with no ice registrations in the last year',
          warning: 'Regobs search is unexpectedly empty',
        };
      }
      if (
        typeof first.RegId !== 'number' ||
        typeof first.DtObsTime !== 'string' ||
        !first.ObsLocation
      ) {
        return { ok: false, message: 'registration shape changed' };
      }
      return {
        ok: true,
        detail: `latest registration ${first.RegId} from ${first.DtObsTime.slice(0, 10)}`,
        warning: null,
      };
    },
  };
}

/**
 * Every non-catalog upstream the derived engine reads. Counts in the floors come
 * from docs/DATA-SOURCES.md, measured against the live services.
 */
export function inputProbes(env: Record<string, string | undefined>): ProbeSpec[] {
  const group = 'Engine inputs';
  return [
    dtmProbe(),
    countProbe(
      { id: 'input:lake-register', label: 'NVE lake register (Innsjødatabase2 · 5)', group },
      `${NVE_REST}/Innsjodatabase2/MapServer/5/query`,
      200_000,
      'lakes',
    ),
    countProbe(
      { id: 'input:lake-survey', label: 'NVE bathymetry index (Innsjødatabase2 · 4)', group },
      `${NVE_REST}/Innsjodatabase2/MapServer/4/query`,
      400,
      'surveyed lakes',
    ),
    countProbe(
      { id: 'input:soundings', label: 'NVE depth soundings (Innsjødatabase2 · 1)', group },
      `${NVE_REST}/Innsjodatabase2/MapServer/1/query`,
      20_000,
      'soundings',
    ),
    countProbe(
      { id: 'input:streams', label: 'NVE river network (Elvenett1 · 2)', group },
      `${NVE_REST}/Elvenett1/MapServer/2/query`,
      1_500_000,
      'segments',
    ),
    countProbe(
      { id: 'input:catchments', label: 'NVE catchments & discharge (Nedborfelt2 · 3)', group },
      `${NVE_REST}/Nedborfelt2/MapServer/3/query`,
      1_500,
      'catchments',
    ),
    sr16Probe(),
    countProbe(
      { id: 'input:anadromous', label: 'Anadromous stretches (Miljødirektoratet · 4)', group },
      `${MILJO_REST}/anadrome_laksefisk/MapServer/4/query`,
      300,
      'stretches',
    ),
    countProbe(
      { id: 'input:barriers', label: 'Migration barriers (Miljødirektoratet · 0)', group },
      `${MILJO_REST}/anadrome_laksefisk/MapServer/0/query`,
      400,
      'barriers',
    ),
    countProbe(
      { id: 'input:artfunksjon', label: 'Wildlife functional areas (Naturbase)', group },
      `${MILJO_REST}/artfunksjon/MapServer/0/query`,
      50_000,
      'areas',
    ),
    countProbe(
      { id: 'input:vern', label: 'Protected areas (Miljødirektoratet vern)', group },
      `${MILJO_REST}/vern/MapServer/0/query`,
      2_000,
      'areas',
    ),
    harvestProbe(),
    kommuneProbe(),
    hydapiProbe(env),
    gbifProbe(),
  ];
}

/** Build the whole sweep: every configured catalog layer plus the engine inputs. */
export function allProbes(
  layers: readonly OverlayLayer[],
  env: Record<string, string | undefined>,
): ProbeSpec[] {
  const specs: ProbeSpec[] = [];
  for (const layer of layers) {
    const probe = OVERLAY_PROBES[layer.meta.id];
    if (probe) specs.push(overlayProbe(layer, probe, env));
    const year = yearSuccessorProbe(layer);
    if (year) specs.push(year);
  }
  return [...specs, regobsProbe(), ...inputProbes(env)];
}

/**
 * Transport failures that say nothing about the upstream's health — a refused
 * or reset connection, a DNS hiccup, a timeout. These are worth one retry
 * before the status page calls a source dead.
 *
 * A TLS failure is deliberately **not** in this set. An incomplete chain or an
 * expired certificate is exactly the persistent, silent breakage this file
 * exists to catch (see the header), so it must be reported on the first sweep
 * rather than retried and delayed.
 *
 * The derive service's input loader shares this policy (`isTransient` is
 * exported for it): a cell derived through a blip records "this layer did not
 * answer" and then keeps that gap, because nothing re-derives a cell on its own.
 */
const TRANSIENT_CAUSES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'TimeoutError',
  'AbortError',
]);

/**
 * The cause code that identifies a transport failure, as undici attaches it.
 * Absent for anything that is not one — a probe's own `throw new Error(...)`
 * keeps reporting its message rather than the useless string "Error".
 */
export function causeCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = err.cause as { code?: string; name?: string } | undefined;
  return cause?.code ?? cause?.name;
}

/**
 * Is this worth one more try? `AbortSignal.timeout` throws a bare DOMException
 * with no `cause`, so the error's own name has to be consulted too.
 */
export function isTransient(err: unknown): boolean {
  const code = causeCode(err) ?? (err instanceof Error ? err.name : undefined);
  return code !== undefined && TRANSIENT_CAUSES.has(code);
}

export interface ProbeRunnerOptions {
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** How long a result stands before the source is re-probed. */
  intervalMs?: number;
  /**
   * How long a *failing* result stands. Far shorter than `intervalMs`, because
   * a source that is down is the one case where the answer is expected to
   * change — and leaving the page red for six hours after an upstream came back
   * teaches people to disbelieve it.
   */
  retryIntervalMs?: number;
  /**
   * How soon to confirm a transport failure that was seen for the first time.
   * The scheduler ticks every 15 minutes, so the 10-minute default makes the
   * next tick the confirmation without multiplying background traffic.
   */
  confirmIntervalMs?: number;
  /** Pause before the one retry of a transient transport error. */
  retryDelayMs?: number;
  /** How many probes run at once. Small: these are other people's servers. */
  concurrency?: number;
  now?: () => number;
}

/**
 * Runs the sweep, on a slow timer and on demand.
 *
 * Concurrency is 3 and the interval is hours, so the whole national fleet of
 * government services sees a few dozen requests a day from us — less than one
 * user panning the map once.
 */
export class ProbeRunner {
  private readonly specs: ProbeSpec[];
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly confirmIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  /** When each spec last ran and which cadence its next check should use. */
  private readonly lastRun = new Map<
    string,
    { at: number; result: 'ok' | 'confirming' | 'failed' }
  >();
  /** Consecutive sweeps whose retry also ended in a transport failure. */
  private readonly transportFailureSweeps = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweep: Promise<void> | undefined;
  private lastSweep: number | null = null;

  constructor(
    specs: ProbeSpec[],
    private readonly status: StatusRegistry,
    private readonly log: FastifyBaseLogger,
    options: ProbeRunnerOptions = {},
  ) {
    this.specs = specs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
    this.retryIntervalMs = options.retryIntervalMs ?? 30 * 60_000;
    this.confirmIntervalMs = options.confirmIntervalMs ?? 10 * 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.concurrency = options.concurrency ?? 3;
    this.now = options.now ?? Date.now;
    // Register every probed source up front so the status page lists it as
    // `unknown` before the first sweep rather than omitting it — a source
    // missing from the page reads as "fine".
    for (const spec of this.specs) {
      if (!status.has(spec.id)) status.register(spec.id, spec.label, spec.group);
    }
  }

  get snapshot(): { lastSweep: number | null; probing: boolean } {
    return { lastSweep: this.lastSweep, probing: this.sweep !== undefined };
  }

  /**
   * Start the background schedule. The first sweep is delayed rather than run
   * at boot: a deploy restarts the process, and a container that fired 27
   * upstream requests during startup would make a redeploy loop look like an
   * attack.
   */
  start(): void {
    if (this.timer) return;
    const tick = () => void this.run(false);
    // Check every 15 minutes which probes are due; `intervalMs` decides.
    this.timer = setInterval(tick, 15 * 60_000);
    this.timer.unref();
    const first = setTimeout(tick, 60_000);
    first.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Run the probes that are due (or all of them when `force`). Concurrent calls
   * share one sweep, so a user hammering "Check now" cannot multiply the load.
   */
  run(force: boolean): Promise<void> {
    this.sweep ??= this.execute(force).finally(() => {
      this.sweep = undefined;
      this.lastSweep = this.now();
    });
    return this.sweep;
  }

  private async execute(force: boolean): Promise<void> {
    const due = this.specs.filter((spec) => {
      const last = this.lastRun.get(spec.id);
      if (force || last === undefined) return true;
      const after =
        last.result === 'ok'
          ? this.intervalMs
          : last.result === 'confirming'
            ? this.confirmIntervalMs
            : this.retryIntervalMs;
      return this.now() - last.at >= after;
    });
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const spec = due[next++];
        if (!spec) return;
        await this.runOne(spec);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, due.length) }, () => worker()),
    );
  }

  /**
   * Run one probe, retrying **once** if it failed for a reason that says
   * nothing about the upstream. If that retry also fails, a later sweep must
   * confirm the transport failure before it is reported as an outage.
   *
   * This exists because a single refused connection used to paint a source red
   * until the next sweep six hours later. Five Miljødirektoratet probes tripped
   * over one such blip during a redeploy and the status page reported the whole
   * instance `down` while every one of those services was answering normally.
   * A page that cries wolf gets ignored, which costs more than the one extra
   * request this retry spends.
   */
  private async attempt(spec: ProbeSpec): Promise<ProbeOutcome> {
    try {
      return await spec.run(this.fetchImpl);
    } catch (err) {
      if (!isTransient(err)) throw err;
      this.log.debug(
        { probe: spec.id, code: causeCode(err) },
        'transient probe failure — retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      return await spec.run(this.fetchImpl);
    }
  }

  private async runOne(spec: ProbeSpec): Promise<void> {
    const started = this.now();
    const hadPendingTransportFailure = this.transportFailureSweeps.has(spec.id);
    let outcome: ProbeOutcome;
    let confirming = false;
    try {
      outcome = await this.attempt(spec);
      this.transportFailureSweeps.delete(spec.id);
    } catch (err) {
      // A TLS or DNS failure surfaces as a bare "fetch failed"; the cause code
      // is what actually identifies it, and it is the difference between "their
      // certificate broke" and "our network is down".
      const reason = causeCode(err) ?? (err instanceof Error ? err.message : String(err));
      outcome = { ok: false, message: reason, warning: null };
      if (isTransient(err)) {
        const failedSweeps = (this.transportFailureSweeps.get(spec.id) ?? 0) + 1;
        this.transportFailureSweeps.set(spec.id, failedSweeps);
        confirming = failedSweeps === 1;
      } else {
        this.transportFailureSweeps.delete(spec.id);
      }
    }
    this.lastRun.set(spec.id, {
      at: started,
      result: outcome.ok ? 'ok' : confirming ? 'confirming' : 'failed',
    });
    const latency = this.now() - started;

    // One sweep has already made two connection attempts. That is enough to
    // schedule a prompt confirmation, but not enough to claim an upstream is
    // down: the production failure that prompted this lasted through both
    // fixed-delay attempts and all five rows recovered together. Keeping the
    // row unknown (or at its earlier success) is the honest interim verdict.
    if (confirming) {
      this.status.setDetail(
        spec.id,
        `${outcome.message ?? 'transport failure'} twice — rechecking before reporting down`,
      );
      this.log.warn(
        { probe: spec.id, message: outcome.message },
        'upstream transport failure awaiting confirmation',
      );
      return;
    }

    this.status.record(spec.id, outcome.ok, outcome.message, latency);
    if (outcome.warning !== undefined) this.status.warn(spec.id, outcome.warning);
    if (outcome.detail !== undefined) this.status.setDetail(spec.id, outcome.detail);
    else if (hadPendingTransportFailure) this.status.setDetail(spec.id, null);
    if (!outcome.ok) {
      this.log.warn({ probe: spec.id, message: outcome.message }, 'upstream probe failed');
    } else if (outcome.warning) {
      this.log.warn({ probe: spec.id, warning: outcome.warning }, 'upstream probe warning');
    }
  }
}
