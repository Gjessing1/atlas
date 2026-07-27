import { bboxToUtm33, type LngLatBbox } from '@atlas/core';
import { createGrid, type Grid, type PotentialInputRecord } from '@atlas/potential';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fromArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';
import type { CellRaster } from './cells.js';
import { cellId } from './cells.js';

/**
 * The upstream half of the derive service: fetch each input for one cell, cache
 * it on disk, and hand the engine plain data.
 *
 * `@atlas/potential` is pure — no network, no fs — so everything that talks to
 * NVE or Kartverket lives here, and the engine only ever sees `Grid`s and arrays
 * of records. That split is what lets the models be unit-tested in the quality
 * gate and, eventually, run on a phone.
 *
 * Two ground rules from docs/DATA-SOURCES.md are enforced here rather than left
 * to each call site: an identifying user agent on every request, and one fetch
 * per input per cell, disk-cached — these are public services on someone else's
 * budget.
 */

/** How long a cached input answer stands. Government topo data moves in months. */
const INPUT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** ArcGIS page size; the layers here cap `maxRecordCount` at 1000–2000. */
const PAGE_SIZE = 1000;
/** Refuse a runaway pull rather than fill the disk. */
const MAX_PAGES = 12;

/**
 * Server-side generalization, **in degrees** because we ask for `outSR=4326`.
 * ~3 m: a third of a raster pixel, so shoreline structure survives while the
 * payload stays in the tens of kB. The unit is the trap here — a value meant as
 * metres silently collapses every ring to a single vertex (see
 * `ArcGisLabelSource.simplifyDeg`).
 */
const SIMPLIFY_DEG = 0.00003;

/**
 * The same, for catchment polygons — ~55 m, nearly twenty times coarser.
 *
 * A main catchment is a national-scale polygon: the Drammensvassdraget is
 * 17 108 km² and its full boundary is ~1 MB of JSON for a cell that only needs
 * to know *which* catchment each channel pixel sits in. At 55 m the same four
 * catchments come back in 92 kB and the only thing that moves is the divide —
 * ground where the channels are first-order trickles whose Strahler order
 * decides their size anyway.
 */
const CATCHMENT_SIMPLIFY_DEG = 0.0005;

const NVE_REST = 'https://kart.nve.no/enterprise/rest/services';
const MILJO_REST = 'https://kart.miljodirektoratet.no/arcgis/rest/services';
const DTM_WCS = 'https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833';
const AR5_WMS = 'https://wms.nibio.no/cgi-bin/ar5';

/**
 * AR5 `Arealtype` palette → `artype` code, **measured against the live service
 * 2026-07-27**, not taken from cartographic documentation.
 *
 * Reverse-engineering this by eye is a trap and was caught being one: the
 * obvious reading of `145,231,255` (a pale blue) is Myr, and it is in fact
 * `81 Ferskvann`; Myr is the *other* pale blue, `181,236,252`. Every row below
 * was confirmed by drawing the layer and then asking its own GetFeatureInfo
 * what sits at that pixel, which is the only method that cannot be fooled by a
 * plausible-looking colour.
 *
 * Exact matches only. MapServer antialiases class boundaries — about 13 % of a
 * lowland tile is blended edge pixels — and a nearest-colour fallback would
 * assign every one of them to a class it is merely closest to. An edge pixel is
 * genuinely ambiguous, so it stays nodata, which the models already read as
 * "unknown" rather than as bad ground.
 */
const AR5_PALETTE: Readonly<Record<string, number>> = {
  '252,219,214': 11, // Bebygd
  '179,120,76': 12, // Samferdsel
  '255,209,110': 21, // Fulldyrka jord
  '255,255,76': 22, // Overflatedyrka jord
  '255,255,173': 23, // Innmarksbeite
  '158,204,115': 30, // Skog
  '217,217,217': 50, // Åpen fastmark
  '181,236,252': 60, // Myr
  '145,231,255': 81, // Ferskvann
  '204,254,254': 82, // Hav
  // 99 "Ikke kartlagt" (255,255,255) is deliberately absent: AR5 stops at the
  // tree line, and "not mapped" must read as unknown, never as barren ground.
};

/**
 * How many sub-requests the AR5 GetMap is split into, per axis.
 *
 * **The layer refuses to draw below roughly 9 m/px** — its sub-layers carry a
 * `MaxScaleDenominator`, and past it MapServer answers 200 with a blank image
 * rather than an error. Measured 2026-07-27: 8.73 m/px draws, 9.25 m/px comes
 * back a uniform white 5 933-byte PNG. A padded derive cell is 9.60 m/px, i.e.
 * just the wrong side of the line, so a single whole-cell request would silently
 * return "this area has no land cover" for the entire country.
 *
 * Splitting 2×2 puts each quadrant at 4.8 m/px with comfortable margin; the
 * halves are then box-downsampled back onto the cell grid.
 */
const AR5_SPLIT = 2;

/** `ltema` — the clean three-way classifier for the river network. */
export const STREAM_REAL_CHANNEL = 3211;
export const STREAM_LAKE_CENTRELINE = 3103;
export const STREAM_FICTITIOUS = 3299;

export interface PotentialContext {
  /** Test seam: upstream HTTP. */
  fetchImpl: typeof fetch;
  /** Disposable input cache root (wipe freely — it only costs re-fetches). */
  cacheDir: string;
  userAgent: string;
  /** Records upstream reachability against the N7 status page. */
  record(inputId: string, ok: boolean, message?: string): void;
  log: { warn: (obj: unknown, msg: string) => void };
}

/**
 * What one input contributed to a cell, recorded verbatim in the cell manifest.
 *
 * This is the provenance half of D4 ("nothing scores without saying why"): when
 * a surface looks wrong six months from now, the manifest says which services
 * answered, with how much data, and when — instead of leaving us to re-probe and
 * guess. It travels to the client inside the manifest, so like the manifest
 * itself the shape is declared once in `@atlas/potential` and only named here.
 */
export type InputRecord = PotentialInputRecord;

export interface LakeFeature {
  /** NVE's lake number — the join key to Elvenett and the weakened-ice layer. */
  readonly vatnlnr: number | null;
  readonly name: string | null;
  readonly elevationM: number | null;
  readonly areaKm2: number | null;
  readonly catchmentKm2: number | null;
  /** NVE `objekttype`; `InnsjøRegulert` is a regulated lake (drawdown zone). */
  readonly kind: string | null;
  /** NVE holds a depth survey (`dybdekart='J'`) — true for ~607 of 267 194 lakes. */
  readonly surveyed: boolean;
  /** Reservoir purposes, e.g. `Vannforsyning` (fishing is often banned). */
  readonly reservoirPurpose: string | null;
  /** Rings in WGS84; ring 0 is the exterior, the rest are islands. */
  readonly rings: readonly (readonly (readonly [number, number])[])[];
}

export interface StreamFeature {
  /** 3211 real channel · 3103 lake through-flow · 3299 fictitious connector. */
  readonly ltema: number;
  /** Strahler order — the per-segment size proxy. Complete on real channels. */
  readonly strahler: number | null;
  /** `elvenavnhierarki`: present on 99.7 % of channels, properly cased. */
  readonly name: string | null;
  readonly vatnlnr: number | null;
  readonly paths: readonly (readonly (readonly [number, number])[])[];
}

export interface DepthContour {
  readonly depthM: number;
  readonly vatnlnr: number | null;
  readonly paths: readonly (readonly (readonly [number, number])[])[];
}

/**
 * One main catchment — the only honest source of *how much water* a river
 * carries, and the reason `arealregineenhet_km2` on the stream network is not
 * used for anything.
 *
 * These tile the country rather than nesting: a single 10 km cell near Drammen
 * holds the 17 108 km² Drammensvassdraget and the 7.8 km² Ebbestadelva side by
 * side, so the figure has to be assigned per pixel and not per cell.
 */
export interface CatchmentFeature {
  readonly name: string | null;
  /** REGINE watercourse number, e.g. `012.Z`. */
  readonly vassdragsnr: string | null;
  readonly areaKm2: number | null;
  /** Normal annual runoff, million m³/yr. Glomma: 24 376 ⇒ 772 m³/s. */
  readonly qnormalMm3aar: number | null;
  readonly rings: readonly (readonly (readonly [number, number])[])[];
}

/** A stretch of river that laks and sjøørret can physically reach. */
export interface AnadromousStretch {
  readonly river: string | null;
  readonly vassdragsNr: string | null;
  /** A nasjonalt laksevassdrag — the strongest protection Norway gives a river. */
  readonly national: boolean;
  /**
   * Deep link into Lakseregisteret for this watercourse. **The primary call to
   * action on any anadromous water**, because whether a river is open this week
   * is decided by emergency forskrift and exists in no machine-readable form.
   */
  readonly lakseregUrl: string | null;
  readonly paths: readonly (readonly (readonly [number, number])[])[];
}

/** A wall the sea-run fish cannot pass, and stack up underneath. */
export interface MigrationBarrier {
  /**
   * Which target this barrier belongs to, taken from the **layer** rather than
   * from the row's own `art` field: the layer is unambiguous (0 = laks,
   * 1 = sjøørret) where the field's spelling is not ours to rely on.
   */
  readonly species: 'laks' | 'sjoorret';
  /**
   * `hindertype` — nominally a class, in practice free text: the national table
   * holds `Vandringsstopp`, `Foss`, `Temporært hinder`, `TemporærtHinder`, null
   * and one row reading *"Noe uenighet om hvor langt fisken går."*.
   *
   * Matched on in exactly one direction, by `isAbsoluteBarrier()` — never to
   * decide what a barrier *is*, only whether we have been told plainly enough
   * to say the run ends here.
   */
  readonly kind: string | null;
  /** `hinderaarsak` — Foss, Demning, Kulvert, Terskel… */
  readonly cause: string | null;
  readonly info: string | null;
  readonly position: readonly [number, number];
}

/**
 * Is this obstacle the end of the run, rather than one fish get past?
 *
 * `hindertype` is free text, so this asks the question in the safe direction:
 * only an explicit `Vandringsstopp` earns the strong reading, and everything
 * else — a ladder, a prose remark, a null — falls back to the weaker sentence.
 * Matched the other way round, one unrecognised spelling would promote a
 * passable falls into a wall and tell the user no salmon go above Hellefoss,
 * which has a ladder in it and a fishery for kilometres upstream.
 */
export function isAbsoluteBarrier(barrier: MigrationBarrier): boolean {
  return (barrier.kind ?? '').toLowerCase().replace(/\s+/g, '') === 'vandringsstopp';
}

/** Everything one derive run has to work with. */
export interface CellInputs {
  readonly raster: CellRaster;
  /**
   * Elevation in metres on the padded raster, or null when the DTM did not
   * answer. Never a zero-filled stand-in: a model must be able to tell "no
   * elevation here" from "sea level", and silently substituting flat ground
   * would make every coastal cell read as a plain.
   */
  readonly terrain: Grid | null;
  readonly lakes: readonly LakeFeature[];
  readonly streams: readonly StreamFeature[];
  readonly depthContours: readonly DepthContour[];
  /**
   * AR5 `artype` codes on the padded raster, or null when not requested / not
   * answered. Nodata above the tree line, where AR5 simply stops — which the
   * models read as unknown, never as barren.
   */
  readonly landCover: Grid | null;
  readonly catchments: readonly CatchmentFeature[];
  readonly anadromous: readonly AnadromousStretch[];
  readonly barriers: readonly MigrationBarrier[];
  /**
   * How every requested input actually went. **The list-valued fields above
   * cannot carry their own failure** the way `terrain` and `landCover` can — an
   * upstream that did not answer falls back to `[]`, which is the same value a
   * genuinely empty area returns. A model that draws a conclusion from a list
   * being empty must therefore check `inputFailed()` first, or it will state as
   * fact about the ground what is really a fact about the network.
   */
  readonly records: readonly InputRecord[];
}

/**
 * Did this input fail outright, as opposed to answering with nothing?
 *
 * The distinction is the whole point. A cell with no mapped anadromous water is
 * ordinary and worth saying so; a cell whose anadromous fetch 502'd looks
 * identical from the array alone, and saying "no anadromous water is mapped
 * here" about it is a lie the map has no way to notice. Miljødirektoratet has
 * already served a broken TLS chain for months once (see `backend/certs/`), so
 * this is a state the derive will really be in, not a theoretical one.
 */
export function inputFailed(inputs: CellInputs, id: keyof typeof INPUT_META): boolean {
  return inputs.records.some((r) => r.id === id && !r.ok);
}

/** Which inputs a model wants; nothing else is fetched. */
export interface InputRequest {
  readonly terrain?: boolean;
  readonly lakes?: boolean;
  readonly streams?: boolean;
  readonly depthContours?: boolean;
  readonly landCover?: boolean;
  readonly catchments?: boolean;
  readonly anadromous?: boolean;
  readonly barriers?: boolean;
}

// ---- disk cache -----------------------------------------------------------

function cachePath(ctx: PotentialContext, input: string, raster: CellRaster, ext: string): string {
  const { z, x, y } = raster.cell;
  return path.join(ctx.cacheDir, 'potential-inputs', input, String(z), String(x), `${y}.${ext}`);
}

async function writeAtomic(ctx: PotentialContext, file: string, data: Buffer): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    // A cache miss only costs a re-fetch, so this never fails the derive.
    ctx.log.warn({ err, file }, 'potential input cache write failed');
  }
}

/** Read a fresh cache entry, or null. Gzipped: elevation floats halve, JSON better. */
async function readCache(file: string): Promise<Buffer | null> {
  const fresh = await stat(file)
    .then((s) => Date.now() - s.mtimeMs < INPUT_TTL_MS)
    .catch(() => false);
  if (!fresh) return null;
  try {
    return gunzipSync(await readFile(file));
  } catch {
    return null; // truncated or half-written entry: treat as a miss
  }
}

// ---- ArcGIS vector inputs -------------------------------------------------

interface GeoJsonFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

/**
 * One cell's worth of an NVE feature layer, paged, as GeoJSON.
 *
 * The envelope is sent in **UTM33 with an explicit `spatialReference`**. Both
 * that and a lon/lat envelope were verified to give identical counts on these
 * layers, but a bare comma-separated bbox is read in the layer's *native* grid —
 * which for a lon/lat value matches nothing at all and reads exactly like "this
 * area has no data". Sending the service its own grid removes the question.
 */
async function arcgisFeatures(
  ctx: PotentialContext,
  layerUrl: string,
  bounds: LngLatBbox,
  outFields: string,
  opts: { simplifyDeg?: number } = {},
): Promise<GeoJsonFeature[]> {
  const [xmin, ymin, xmax, ymax] = bboxToUtm33(bounds);
  const envelope = JSON.stringify({
    xmin,
    ymin,
    xmax,
    ymax,
    spatialReference: { wkid: 25833 },
  });
  const features: GeoJsonFeature[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(layerUrl);
    const p = url.searchParams;
    p.set('geometry', envelope);
    p.set('geometryType', 'esriGeometryEnvelope');
    p.set('inSR', '25833');
    p.set('spatialRel', 'esriSpatialRelIntersects');
    p.set('outFields', outFields);
    p.set('returnGeometry', 'true');
    p.set('outSR', '4326');
    p.set('maxAllowableOffset', String(opts.simplifyDeg ?? SIMPLIFY_DEG));
    p.set('resultOffset', String(page * PAGE_SIZE));
    p.set('resultRecordCount', String(PAGE_SIZE));
    p.set('f', 'geojson');
    const res = await ctx.fetchImpl(url, {
      headers: { 'User-Agent': ctx.userAgent },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      type?: string;
      features?: GeoJsonFeature[];
      exceededTransferLimit?: boolean;
      error?: { message?: string };
    };
    // ArcGIS reports failures with HTTP 200 and an error object.
    if (body.error) throw new Error(body.error.message ?? 'ArcGIS error');
    if (!Array.isArray(body.features)) throw new Error('unexpected payload');
    features.push(...body.features);
    if (!body.exceededTransferLimit || body.features.length < PAGE_SIZE) break;
  }
  return features;
}

/** GeoJSON rings/paths → arrays of [lng, lat] pairs, whatever the wrapping. */
function coordinateGroups(
  geometry: { type: string; coordinates: unknown } | null,
): (readonly [number, number])[][] {
  if (!geometry) return [];
  const asPath = (raw: unknown): (readonly [number, number])[] =>
    Array.isArray(raw)
      ? raw
          .filter(
            (pt): pt is [number, number] =>
              Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number',
          )
          .map((pt) => [pt[0], pt[1]] as const)
      : [];
  const c = geometry.coordinates;
  switch (geometry.type) {
    case 'LineString':
      return [asPath(c)];
    case 'MultiLineString':
    case 'Polygon':
      return Array.isArray(c) ? c.map(asPath) : [];
    case 'MultiPolygon':
      // Flattened deliberately: the models care about water edges, not which
      // polygon a ring belongs to, and a lake's islands are edges too.
      return Array.isArray(c)
        ? c.flatMap((poly) => (Array.isArray(poly) ? poly.map(asPath) : []))
        : [];
    default:
      return [];
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The national lake register (Innsjødatabase2 layer 5) — **all 267 194 lakes**,
 * not just the surveyed ones. It answers in one attribute several things the
 * plan had intended to derive: whether a survey exists, lake elevation,
 * catchment size, and whether the lake is regulated.
 */
async function loadLakes(ctx: PotentialContext, bounds: LngLatBbox): Promise<LakeFeature[]> {
  const features = await arcgisFeatures(
    ctx,
    `${NVE_REST}/Innsjodatabase2/MapServer/5/query`,
    bounds,
    'vatnlnr,navn,hoyde,areal_km2,nedborfeltareal_km2,objekttype,dybdekart,magformal_liste',
  );
  return features.map((f) => {
    const p = f.properties ?? {};
    return {
      vatnlnr: num(p['vatnlnr']),
      name: str(p['navn']),
      elevationM: num(p['hoyde']),
      areaKm2: num(p['areal_km2']),
      catchmentKm2: num(p['nedborfeltareal_km2']),
      kind: str(p['objekttype']),
      // 'J' for ja. Null on the 266 587 lakes with no survey, which is the
      // normal case — see the 2.9 % coverage finding in FISH-HUNT-ENGINE.md.
      surveyed: str(p['dybdekart'])?.toUpperCase() === 'J',
      reservoirPurpose: str(p['magformal_liste']),
      rings: coordinateGroups(f.geometry),
    };
  });
}

/**
 * The river network (Elvenett1 layer 2). Classified on `ltema`, never on
 * `objekttype` — the latter carries 25 spellings for ~6 classes in a national
 * dataset (`ElvBekkMidtlije`, `FiltivElv`, a literal `"20.08.2014"`), so
 * equality matching on it is documented as unusable.
 */
async function loadStreams(ctx: PotentialContext, bounds: LngLatBbox): Promise<StreamFeature[]> {
  const features = await arcgisFeatures(
    ctx,
    `${NVE_REST}/Elvenett1/MapServer/2/query`,
    bounds,
    'ltema,elveordenstrahler,elvenavnhierarki,vatnlnr',
  );
  return features.map((f) => {
    const p = f.properties ?? {};
    return {
      ltema: num(p['ltema']) ?? 0,
      strahler: num(p['elveordenstrahler']),
      name: str(p['elvenavnhierarki']),
      vatnlnr: num(p['vatnlnr']),
      paths: coordinateGroups(f.geometry),
    };
  });
}

/**
 * Depth contours (Innsjødatabase2 layer 2). The bathymetric model's input, and
 * the reason it is *contours* rather than points: many surveyed lakes were
 * digitised off a paper chart and carry **no** `DybdePunkt` at all — Semsvannet
 * has 17 contour features and zero soundings.
 */
async function loadDepthContours(
  ctx: PotentialContext,
  bounds: LngLatBbox,
): Promise<DepthContour[]> {
  const features = await arcgisFeatures(
    ctx,
    `${NVE_REST}/Innsjodatabase2/MapServer/2/query`,
    bounds,
    'dybde_m,vatnlnr,innsjonavn',
  );
  return features
    .map((f) => ({
      depthM: num(f.properties?.['dybde_m']) ?? Number.NaN,
      vatnlnr: num(f.properties?.['vatnlnr']),
      paths: coordinateGroups(f.geometry),
    }))
    .filter((c) => Number.isFinite(c.depthM));
}

/**
 * Main catchments (Nedborfelt2 layer 3, `Hovedfelt_Nedborfelt_til_hav`) with
 * their mean discharge.
 *
 * `qnormal_mm3aar` is the *catchment's* figure, i.e. the flow where it reaches
 * the sea — the largest number anywhere in it. The river model therefore uses it
 * as a **ceiling** on a reach's size rather than as the reach's own discharge,
 * with Strahler order saying where in the network that reach sits.
 */
async function loadCatchments(
  ctx: PotentialContext,
  bounds: LngLatBbox,
): Promise<CatchmentFeature[]> {
  const features = await arcgisFeatures(
    ctx,
    `${NVE_REST}/Nedborfelt2/MapServer/3/query`,
    bounds,
    'vassdragsnr,nedborfeltnavn,areal_km2,qnormal_mm3aar',
    { simplifyDeg: CATCHMENT_SIMPLIFY_DEG },
  );
  return features.map((f) => {
    const p = f.properties ?? {};
    return {
      name: str(p['nedborfeltnavn']),
      vassdragsnr: str(p['vassdragsnr']),
      areaKm2: num(p['areal_km2']),
      qnormalMm3aar: num(p['qnormal_mm3aar']),
      rings: coordinateGroups(f.geometry),
    };
  });
}

/**
 * Anadromous stretches (`anadrome_laksefisk` layer 4) — where sea-run fish can
 * get to, and nothing at all about where fishing is allowed.
 *
 * The two are routinely confused and must not be here: Norwegian salmon rivers
 * are closed mid-season by emergency forskrift (Gaula, Orkla and Verdalselva
 * from 1 August 2026), the open/closed list lives in a Lovdata vedlegg with no
 * machine-readable form, and a map that says "fish here" about a closed river is
 * a different class of wrong from a heatmap being imprecise. So the model reads
 * channel character and hands the user `lakseregURL`.
 */
async function loadAnadromous(
  ctx: PotentialContext,
  bounds: LngLatBbox,
): Promise<AnadromousStretch[]> {
  const features = await arcgisFeatures(
    ctx,
    `${MILJO_REST}/anadrome_laksefisk/MapServer/4/query`,
    bounds,
    'elvenavn,vassdragsNR,nasjonaltLaksevassdrag,lakseregURL',
  );
  return features.map((f) => {
    const p = f.properties ?? {};
    return {
      river: str(p['elvenavn']),
      vassdragsNr: str(p['vassdragsNR']),
      national: str(p['nasjonaltLaksevassdrag'])?.toLowerCase() === 'ja',
      lakseregUrl: str(p['lakseregURL']),
      paths: coordinateGroups(f.geometry),
    };
  });
}

/** Which barrier layer belongs to which target species. */
const BARRIER_LAYERS: readonly { readonly layer: number; readonly species: 'laks' | 'sjoorret' }[] =
  [
    { layer: 0, species: 'laks' },
    { layer: 1, species: 'sjoorret' },
  ];

/**
 * Migration barriers for both sea-run species (layers 0 and 1), tagged with the
 * one they belong to.
 *
 * Fetched together and filtered by the model rather than fetched per target: the
 * input cache is keyed by cell, so two targets of the same cell would otherwise
 * pull two overlapping halves of the same national table.
 */
async function loadBarriers(
  ctx: PotentialContext,
  bounds: LngLatBbox,
): Promise<MigrationBarrier[]> {
  const out: MigrationBarrier[] = [];
  for (const { layer, species } of BARRIER_LAYERS) {
    const features = await arcgisFeatures(
      ctx,
      `${MILJO_REST}/anadrome_laksefisk/MapServer/${layer}/query`,
      bounds,
      'hindertype,hinderaarsak,informasjon',
    );
    for (const f of features) {
      const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
      if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
      const p = f.properties ?? {};
      out.push({
        species,
        kind: str(p['hindertype']),
        cause: str(p['hinderaarsak']),
        info: str(p['informasjon']),
        position: [c[0], c[1]],
      });
    }
  }
  return out;
}

// ---- elevation ------------------------------------------------------------

/**
 * The Kartverket national DTM for one padded cell, as a float32 grid.
 *
 * WCS **1.0.0** with a plain lon/lat `BBOX` is the only form that works: GDAL's
 * WCS driver and 2.0.1 `SUBSET=` both 400 here, and DescribeCoverage fails to
 * parse. The server also caps a request near ~2000 px per side, and a padded
 * cell is 1088 — comfortably inside, so no mosaicking is needed.
 *
 * **Trap:** the coverage declares *no* nodata value, and sea or out-of-model
 * ground comes back as a plain `0`. Since −0.4 m is a real measured value in
 * this model, 0 cannot be distinguished from a true shoreline height, so this
 * returns the raster as given and leaves the water mask to the lake polygons,
 * which are authoritative about where water is.
 */
async function loadTerrain(
  ctx: PotentialContext,
  raster: CellRaster,
): Promise<{ grid: Grid; bytes: number }> {
  const url = new URL(DTM_WCS);
  const p = url.searchParams;
  p.set('SERVICE', 'WCS');
  p.set('VERSION', '1.0.0');
  p.set('REQUEST', 'GetCoverage');
  p.set('COVERAGE', 'nhm_dtm_topo_25833');
  p.set('CRS', 'EPSG:4326');
  p.set('BBOX', raster.bounds.join(','));
  p.set('WIDTH', String(raster.size));
  p.set('HEIGHT', String(raster.size));
  p.set('FORMAT', 'GeoTIFF');
  const res = await ctx.fetchImpl(url, {
    headers: { 'User-Agent': ctx.userAgent },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const grid = await decodeTerrain(buffer, raster);
  return { grid, bytes: buffer.byteLength };
}

/** GeoTIFF bytes → a Grid, checking the shape rather than trusting it. */
export async function decodeTerrain(buffer: ArrayBuffer, raster: CellRaster): Promise<Grid> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  if (width !== raster.size || height !== raster.size) {
    throw new Error(`coverage is ${width}×${height}, expected ${raster.size}²`);
  }
  const [band] = (await image.readRasters()) as unknown as ArrayLike<number>[];
  if (!band || band.length !== width * height) throw new Error('coverage has no readable band');
  const grid = createGrid(width, height, raster.cellSizeM);
  for (let i = 0; i < grid.data.length; i++) grid.data[i] = band[i]!;
  return grid;
}

// ---- land cover -----------------------------------------------------------

/**
 * NIBIO AR5 land cover for one padded cell, as `artype` codes on the derive
 * raster (nodata where AR5 does not map, which above the tree line is most of
 * it).
 *
 * Four requests, not one, because of the scale gate documented on `AR5_SPLIT`.
 * Each quadrant is fetched at twice the cell's resolution and averaged down by
 * **majority**, never by mixing channels: land-cover codes are labels, so the
 * mean of "forest" and "bog" is not a class. A block with no clear winner —
 * all four sub-pixels antialiased — comes back unknown.
 */
async function loadLandCover(ctx: PotentialContext, raster: CellRaster): Promise<Grid> {
  const [west, south, east, north] = raster.bounds;
  const grid = createGrid(raster.size, raster.size, raster.cellSizeM);
  const half = raster.size / AR5_SPLIT;
  if (!Number.isInteger(half)) throw new Error(`raster ${raster.size} is not divisible by 2`);

  for (let qy = 0; qy < AR5_SPLIT; qy++) {
    for (let qx = 0; qx < AR5_SPLIT; qx++) {
      const qWest = west + ((east - west) * qx) / AR5_SPLIT;
      const qEast = west + ((east - west) * (qx + 1)) / AR5_SPLIT;
      const qNorth = north - ((north - south) * qy) / AR5_SPLIT;
      const qSouth = north - ((north - south) * (qy + 1)) / AR5_SPLIT;

      const url = new URL(AR5_WMS);
      const p = url.searchParams;
      p.set('SERVICE', 'WMS');
      p.set('VERSION', '1.3.0');
      p.set('REQUEST', 'GetMap');
      p.set('LAYERS', 'Arealtype');
      p.set('STYLES', '');
      p.set('CRS', 'EPSG:4326');
      // WMS 1.3.0 with EPSG:4326 is **lat,lon** ordered. Getting this backwards
      // returns a blank image rather than an error, which is indistinguishable
      // from the scale gate above — so both traps look the same and neither
      // announces itself.
      p.set('BBOX', [qSouth, qWest, qNorth, qEast].join(','));
      // Twice the cell's pixel density: this is the whole point of the split.
      p.set('WIDTH', String(half * AR5_SPLIT));
      p.set('HEIGHT', String(half * AR5_SPLIT));
      p.set('FORMAT', 'image/png');
      const res = await ctx.fetchImpl(url, {
        headers: { 'User-Agent': ctx.userAgent },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
      if (png.width !== half * AR5_SPLIT || png.height !== half * AR5_SPLIT) {
        throw new Error(`AR5 returned ${png.width}×${png.height}`);
      }
      classifyInto(png, grid, qx * half, qy * half, half);
    }
  }
  return grid;
}

/** Majority-vote one AR5 quadrant down onto its half of the cell raster. */
function classifyInto(
  png: { width: number; data: Buffer },
  grid: Grid,
  originX: number,
  originY: number,
  size: number,
): void {
  const votes = new Map<number, number>();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      votes.clear();
      for (let dy = 0; dy < AR5_SPLIT; dy++) {
        for (let dx = 0; dx < AR5_SPLIT; dx++) {
          const i = ((y * AR5_SPLIT + dy) * png.width + (x * AR5_SPLIT + dx)) * 4;
          // Transparent pixels carry no class; MapServer also emits fully
          // transparent areas outside coverage.
          if (png.data[i + 3]! < 128) continue;
          const code =
            AR5_PALETTE[`${png.data[i]!},${png.data[i + 1]!},${png.data[i + 2]!}`] ?? null;
          if (code === null) continue;
          votes.set(code, (votes.get(code) ?? 0) + 1);
        }
      }
      let best = Number.NaN;
      let bestCount = 0;
      for (const [code, count] of votes) {
        if (count > bestCount) {
          bestCount = count;
          best = code;
        }
      }
      grid.data[(originY + y) * grid.width + (originX + x)] = best;
    }
  }
}

/** What arrived: the classes present, so a blank answer is visible as blank. */
function describeLandCover(grid: Grid): string {
  const counts = new Map<number, number>();
  let known = 0;
  for (const v of grid.data) {
    if (!Number.isFinite(v)) continue;
    known++;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (known === 0) return 'no mapped land cover';
  const share = Math.round((known / grid.data.length) * 100);
  const top = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code]) => code)
    .join('/');
  return `${share} % classified, mainly artype ${top}`;
}

// ---- the gather -----------------------------------------------------------

/** One adapter's identity on the status page and in the manifest. */
const INPUT_META: Record<string, { label: string; source: string; probe: string }> = {
  terrain: {
    label: 'Elevation',
    source: 'Kartverket nasjonal høydemodell (WCS)',
    probe: 'input:dtm',
  },
  lakes: {
    label: 'Lake register',
    source: 'NVE Innsjødatabase2 layer 5',
    probe: 'input:lake-register',
  },
  streams: { label: 'River network', source: 'NVE Elvenett1 layer 2', probe: 'input:streams' },
  depthContours: {
    label: 'Depth contours',
    source: 'NVE Innsjødatabase2 layer 2',
    probe: 'input:soundings',
  },
  landCover: {
    label: 'Land cover',
    source: 'NIBIO AR5 Arealtype (WMS)',
    probe: 'input:ar5',
  },
  catchments: {
    label: 'Catchments & discharge',
    source: 'NVE Nedborfelt2 layer 3',
    probe: 'input:catchments',
  },
  anadromous: {
    label: 'Anadromous water',
    source: 'Miljødirektoratet anadrome_laksefisk layer 4',
    probe: 'input:anadromous',
  },
  barriers: {
    label: 'Migration barriers',
    source: 'Miljødirektoratet anadrome_laksefisk layers 0/1',
    probe: 'input:barriers',
  },
};

/**
 * Fetch every requested input for a cell, cached, and describe what arrived.
 *
 * A failed input is **not** a failed derive: it is recorded as `ok: false` with
 * its reason, and the model decides whether it can still say anything. That is
 * the per-pixel coverage-gate rule from the calibration notes applied one level
 * up — a missing input must read as "unknown", never as "bad ground".
 */
export async function gatherInputs(
  raster: CellRaster,
  need: InputRequest,
  ctx: PotentialContext,
): Promise<CellInputs> {
  const records: InputRecord[] = [];

  /** Run one input: cache read, else fetch, and record the outcome either way. */
  const load = async <T>(
    id: keyof typeof INPUT_META,
    ext: string,
    fromCache: (buf: Buffer) => T,
    toCache: (value: T) => Buffer,
    fetchFresh: () => Promise<{ value: T; detail: string }>,
    describe: (value: T) => string,
    fallback: T,
  ): Promise<T> => {
    const meta = INPUT_META[id]!;
    const file = cachePath(ctx, id, raster, ext);
    const cached = await readCache(file);
    if (cached) {
      try {
        const value = fromCache(cached);
        records.push({
          id,
          label: meta.label,
          source: meta.source,
          ok: true,
          detail: describe(value),
          cached: true,
          fetchedAt: (await stat(file)).mtimeMs,
        });
        return value;
      } catch {
        // Unreadable entry: fall through and re-fetch.
      }
    }
    try {
      const { value, detail } = await fetchFresh();
      await writeAtomic(ctx, file, toCache(value));
      ctx.record(meta.probe, true);
      records.push({
        id,
        label: meta.label,
        source: meta.source,
        ok: true,
        detail,
        cached: false,
        fetchedAt: Date.now(),
      });
      return value;
    } catch (err) {
      const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
      const reason = cause?.code ?? (err instanceof Error ? err.message : String(err));
      ctx.record(meta.probe, false, reason);
      ctx.log.warn({ err, input: id, cell: cellId(raster.cell) }, 'potential input failed');
      records.push({
        id,
        label: meta.label,
        source: meta.source,
        ok: false,
        detail: reason,
        cached: false,
        fetchedAt: Date.now(),
      });
      return fallback;
    }
  };

  const json = <T>(buf: Buffer): T => JSON.parse(buf.toString('utf8')) as T;
  const toJson = (value: unknown): Buffer => gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));

  const terrain = need.terrain
    ? await load<Grid | null>(
        'terrain',
        'f32.gz',
        (buf) => {
          const floats = new Float32Array(
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          );
          if (floats.length !== raster.size * raster.size) throw new Error('wrong size');
          return {
            width: raster.size,
            height: raster.size,
            cellSizeM: raster.cellSizeM,
            data: floats,
          };
        },
        (grid) => gzipSync(Buffer.from(grid!.data.buffer)),
        async () => {
          const { grid, bytes } = await loadTerrain(ctx, raster);
          return { value: grid, detail: `${raster.size}² float32, ${Math.round(bytes / 1024)} kB` };
        },
        (grid) => (grid ? `${grid.width}² float32` : 'absent'),
        null,
      )
    : null;

  const lakes = need.lakes
    ? await load<LakeFeature[]>(
        'lakes',
        'json.gz',
        (buf) => json<LakeFeature[]>(buf),
        toJson,
        async () => {
          const value = await loadLakes(ctx, raster.bounds);
          return { value, detail: describeLakes(value) };
        },
        describeLakes,
        [],
      )
    : [];

  const streams = need.streams
    ? await load<StreamFeature[]>(
        'streams',
        'json.gz',
        (buf) => json<StreamFeature[]>(buf),
        toJson,
        async () => {
          const value = await loadStreams(ctx, raster.bounds);
          return { value, detail: describeStreams(value) };
        },
        describeStreams,
        [],
      )
    : [];

  const depthContours = need.depthContours
    ? await load<DepthContour[]>(
        'depthContours',
        'json.gz',
        (buf) => json<DepthContour[]>(buf),
        toJson,
        async () => {
          const value = await loadDepthContours(ctx, raster.bounds);
          return { value, detail: `${value.length} contours` };
        },
        (value) => `${value.length} contours`,
        [],
      )
    : [];

  const landCover = need.landCover
    ? await load<Grid | null>(
        'landCover',
        'u8.gz',
        (buf) => {
          if (buf.byteLength !== raster.size * raster.size) throw new Error('wrong size');
          const grid = createGrid(raster.size, raster.size, raster.cellSizeM);
          // 0 is the on-disk stand-in for nodata: `artype` has no 0 class, so
          // the codes round-trip without needing a second plane.
          for (let i = 0; i < grid.data.length; i++) {
            grid.data[i] = buf[i] === 0 ? Number.NaN : buf[i]!;
          }
          return grid;
        },
        (grid) => {
          const bytes = Buffer.alloc(raster.size * raster.size);
          for (let i = 0; i < bytes.length; i++) {
            const v = grid!.data[i]!;
            bytes[i] = Number.isFinite(v) ? v : 0;
          }
          return gzipSync(bytes);
        },
        async () => {
          const value = await loadLandCover(ctx, raster);
          return { value, detail: describeLandCover(value) };
        },
        (grid) => (grid ? describeLandCover(grid) : 'absent'),
        null,
      )
    : null;

  const catchments = need.catchments
    ? await load<CatchmentFeature[]>(
        'catchments',
        'json.gz',
        (buf) => json<CatchmentFeature[]>(buf),
        toJson,
        async () => {
          const value = await loadCatchments(ctx, raster.bounds);
          return { value, detail: describeCatchments(value) };
        },
        describeCatchments,
        [],
      )
    : [];

  const anadromous = need.anadromous
    ? await load<AnadromousStretch[]>(
        'anadromous',
        'json.gz',
        (buf) => json<AnadromousStretch[]>(buf),
        toJson,
        async () => {
          const value = await loadAnadromous(ctx, raster.bounds);
          return { value, detail: describeAnadromous(value) };
        },
        describeAnadromous,
        [],
      )
    : [];

  const barriers = need.barriers
    ? await load<MigrationBarrier[]>(
        'barriers',
        'json.gz',
        (buf) => json<MigrationBarrier[]>(buf),
        toJson,
        async () => {
          const value = await loadBarriers(ctx, raster.bounds);
          return { value, detail: `${value.length} barriers` };
        },
        (value) => `${value.length} barriers`,
        [],
      )
    : [];

  return {
    raster,
    terrain,
    lakes,
    streams,
    depthContours,
    landCover,
    catchments,
    anadromous,
    barriers,
    records,
  };
}

function describeLakes(lakes: readonly LakeFeature[]): string {
  const surveyed = lakes.filter((l) => l.surveyed).length;
  return `${lakes.length} lakes, ${surveyed} surveyed`;
}

function describeStreams(streams: readonly StreamFeature[]): string {
  const real = streams.filter((s) => s.ltema === STREAM_REAL_CHANNEL).length;
  return `${streams.length} segments, ${real} real channel`;
}

function describeCatchments(catchments: readonly CatchmentFeature[]): string {
  if (catchments.length === 0) return 'no catchment mapped';
  const biggest = catchments.reduce((a, b) => ((b.areaKm2 ?? 0) > (a.areaKm2 ?? 0) ? b : a));
  return `${catchments.length} catchments, largest ${biggest.name ?? '?'} (${Math.round(biggest.areaKm2 ?? 0)} km²)`;
}

function describeAnadromous(stretches: readonly AnadromousStretch[]): string {
  if (stretches.length === 0) return 'no anadromous water here';
  const rivers = [...new Set(stretches.map((s) => s.river).filter(Boolean))];
  return `${stretches.length} stretches${rivers.length ? ` — ${rivers.slice(0, 3).join(', ')}` : ''}`;
}
