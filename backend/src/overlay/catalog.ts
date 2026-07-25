import type { LayerMeta } from '@atlas/core';

/**
 * The overlay registry: data, not code. A new overlay = a new `OverlayLayer`
 * record in `norwegianLayers()`. Clients only ever see the stripped `LayerMeta`
 * (see the /api/layers route) — upstream URLs and tokens stay in the backend.
 */

export interface WmsUpstream {
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
  /**
   * Display names for identify keys, matched case-insensitively. Both clients
   * render the attributes as plain `key: value` rows, so without this a tap
   * answers in the upstream's database spelling — `vurdert`, `hrv`. Units
   * belong in the label ("Regulated high water (m)"): the value is a bare
   * number and there is no unit machinery to invent for a handful of layers.
   */
  identifyLabels?: Record<string, string>;
  /**
   * Per-field code → meaning, matched case-insensitively on the field name and
   * exactly on the value. Government layers encode their most important
   * attribute as a small integer — NVE's weakened ice is `vurdert` 0/1/2/3, and
   * "Ice conditions: 2" tells a reader on a frozen lake precisely nothing. The
   * mappings are the upstream's own legend, not our interpretation.
   */
  identifyValues?: Record<string, Record<string, string>>;
  /**
   * Optional ArcGIS REST source for map labels — a number the raster tile can
   * never show because it lives in the upstream's *attributes*, not its
   * symbology. NVE's lake bathymetry is the motivating case: a surveyed lake
   * carries `maksdyp_m` on its `Dybdekart` polygon, and lakes surveyed off a
   * paper chart have no sounding or contour features at all, so the WMS draws
   * an outline and nothing else.
   */
  labels?: ArcGisLabelSource;
  styles?: string;
  /**
   * Extra GetMap parameters contributed by a selected layer option
   * (`LayerMeta.options` → option key → choice value → params). Data, not code,
   * so the whole variant surface of a layer is readable in one place and
   * testable without a server.
   */
  optionParams?: Record<string, Record<string, Record<string, string>>>;
  /**
   * The identify-side twin of `optionParams`, for upstreams that cannot apply
   * the same filter to GetFeatureInfo — ArcGIS accepts `SLD_BODY` on GetMap and
   * faults on it for identify, so the tap is filtered here instead. Keep only
   * features whose `field` is in the choice's list; an empty list keeps all.
   */
  optionFilter?: { field: string; values: Record<string, Record<string, string[]>> };
  /**
   * `optionFilter`'s always-on sibling: keep only identify results whose `field`
   * holds one of these values, whatever the user has selected.
   *
   * For the layers that draw a *subset* of what they query. The river network is
   * the motivating case: the SLD draws only real channels, but GetFeatureInfo
   * still answers from the lake through-flow centrelines underneath, so a tap on
   * open water returns a river the map is not drawing — a confident answer about
   * nothing visible. A feature missing the field is kept (same rule as
   * `optionFilter`): this exists to match the map, not to hide what it cannot
   * classify.
   */
  identifyKeep?: { field: string; values: string[] };
  /**
   * Render GetMap tiles at this multiple of 256 px (with a matching DPI hint),
   * so fine linework and labels stay crisp on high-density phone screens
   * instead of being drawn at 256 px and stretched. 1 (or unset) = plain 256 px.
   * Only meaningful for sources whose symbology carries thin lines or text
   * (bathymetry contours + soundings); a shaded raster gains nothing from it.
   */
  renderScale?: number;
}

export interface ArcGisLabelSource {
  /** Layer query endpoint, e.g. `…/MapServer/4/query`. */
  url: string;
  /** Numeric attribute drawn as the label. */
  valueField: string;
  /** Attribute holding a display name, when the layer has one. */
  nameField?: string;
  /** Unit suffix appended to the number. */
  unit: string;
  /** Below this zoom labels are omitted — too many lakes, too little room. */
  minzoom: number;
  /**
   * `maxAllowableOffset` for the query, **in degrees** — ArcGIS reads this in
   * the units of `outSR`, and we ask for WGS84. Getting the unit wrong fails
   * silently and expensively: a value of 50 (intended as metres) is 50 degrees,
   * which collapses every ring to a single repeated vertex, so the response
   * still looks well-formed and simply yields no labels. Only a label point is
   * derived from the geometry, so a coarse outline is plenty.
   */
  simplifyDeg: number;
}

export interface XyzUpstream {
  kind: 'xyz';
  /** A {z}/{x}/{y} URL template. May reference env tokens as ${VAR}. */
  template: string;
}

/**
 * A vector overlay drawn from an ArcGIS REST feature layer rather than proxied
 * raster tiles (`LayerMeta.vector`). The backend pulls the whole coverage once
 * as GeoJSON, disk-caches it, and serves it at `/api/overlay/:id/features`; the
 * client renders and hit-tests it directly (the speed-camera pattern, but
 * generic and sourced from an upstream). The reusable §4.7a enabler — Statskog
 * jaktfelt is the first user, the NVE river network the next.
 */
export interface ArcGisVectorUpstream {
  kind: 'arcgis-vector';
  /** The layer query endpoint, e.g. `…/MapServer/4/query`. */
  url: string;
  /** Attributes to keep on each feature (comma-separated `outFields`). */
  outFields: string;
  /**
   * `maxAllowableOffset` for the query, **in degrees** (we ask for WGS84 out) —
   * mandatory server-side generalization. A national polygon set is enormous at
   * full precision: Statskog's 922 hunting fields are 60 MB raw but 4.4 MB at
   * ~11 m (0.0001°), which reads identically at overlay zoom. Same unit trap as
   * `ArcGisLabelSource.simplifyDeg`: the value is read in `outSR` units, so a
   * metres-intended number here silently collapses every ring to one vertex.
   */
  simplifyDeg: number;
  /** `where` clause; defaults to `1=1` (the whole layer). */
  where?: string;
}

export interface OverlayLayer {
  meta: LayerMeta;
  upstream: WmsUpstream | XyzUpstream | ArcGisVectorUpstream;
  /**
   * Env var that must be set for this layer to exist (tokened sources).
   * Unset ⇒ the layer silently drops out of the catalog — no broken entries,
   * no leaked endpoint. Reference the value in upstream URLs as ${VAR}.
   */
  requiresEnv?: string;
}

const KARTKATALOG = 'https://kartkatalog.geonorge.no/search?text=';

/**
 * Species sets behind the wildlife layer's chips. Names are Naturbase's own
 * `norskNavn` values, and the counts (probed 2026-07-25) are why the layer is
 * filtered at all: the full layer is 75 702 areas over 225 species,
 * overwhelmingly seabirds, bats and amphibians, so drawn whole in a hunting
 * profile it is mostly noise. An empty set means "no filter".
 */
const ARTFUNKSJON_SPECIES: Record<string, string[]> = {
  // Elg 5 921 · Hjort 2 907 · Rådyr 2 735.
  biggame: ['Elg', 'Hjort', 'Rådyr'],
  // Storfugl 4 829 · Orrfugl 4 356 · Jerpe 914.
  forestbirds: ['Storfugl', 'Orrfugl', 'Jerpe'],
  // Lirype 899 · Fjellrype 350.
  ptarmigan: ['Lirype', 'Fjellrype'],
  all: [],
};

/** XML text escape — the species names are our own constants, but the SLD is a document. */
const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A species-filtered style for the Naturbase `artfunksjon` WMS.
 *
 * ArcGIS honours `SLD_BODY` on GetMap, which is the only filtering this service
 * offers — the WMS exposes one unsplittable layer, and the ~10³-feature ceiling
 * on whole-coverage vector pulls (see the weakened-ice row) rules out doing it
 * client-side. Three things measured on the live service shape this string, and
 * each fails *silently* if ignored:
 *
 * - **A single-operand `<ogc:Or>` is ignored**, and the tile comes back with
 *   every species drawn rather than the one asked for. One name must therefore
 *   be emitted as a bare `PropertyIsEqualTo`.
 * - **The request URL must stay under ~2 kB** (2 095 chars answered, 2 145 gave
 *   a bare 404), so the document is written compact and without an XML
 *   declaration, and `wms.test.ts` guards the built URL length per choice.
 * - **A `PolygonSymbolizer` alone is right**, counter-intuitively: the layer's
 *   point and line features (leks, migration corridors) are stored as rings
 *   too, so adding point/line symbolizers only spends URL budget.
 */
export function artfunksjonSld(species: readonly string[]): string {
  const eq = (name: string) =>
    `<ogc:PropertyIsEqualTo><ogc:PropertyName>norskNavn</ogc:PropertyName>` +
    `<ogc:Literal>${xml(name)}</ogc:Literal></ogc:PropertyIsEqualTo>`;
  const terms = species.map(eq).join('');
  const filter =
    species.length === 0
      ? ''
      : `<ogc:Filter>${species.length === 1 ? terms : `<ogc:Or>${terms}</ogc:Or>`}</ogc:Filter>`;
  return (
    '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" ' +
    'xmlns:ogc="http://www.opengis.net/ogc"><NamedLayer><Name>art_funksjonsomrade</Name>' +
    `<UserStyle><FeatureTypeStyle><Rule>${filter}<PolygonSymbolizer><Fill>` +
    '<CssParameter name="fill">#b45309</CssParameter>' +
    // Functional areas overlap heavily (winter grazing under a migration
    // corridor under a lek), so the fill stays light and the edge carries the
    // shape; the panel's opacity slider scales both.
    '<CssParameter name="fill-opacity">0.3</CssParameter></Fill><Stroke>' +
    '<CssParameter name="stroke">#7c2d12</CssParameter>' +
    '<CssParameter name="stroke-width">1.2</CssParameter></Stroke></PolygonSymbolizer>' +
    '</Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>'
  );
}

const artfunksjonOptionParams = () => {
  const byChoice: Record<string, Record<string, string>> = {};
  for (const [choice, species] of Object.entries(ARTFUNKSJON_SPECIES)) {
    byChoice[choice] = { SLD_BODY: artfunksjonSld(species) };
  }
  return { species: byChoice };
};

/**
 * `ltema` is the clean classifier that `objekttype` is not (measured against the
 * live layer 2, 2026-07-25). The free-text `objekttype` carries 25 spellings for
 * ~6 classes — `ElvBekkMidtlije`, `FiltivElv`, `InnsjøMidtloinje`, a literal
 * `"20.08.2014"` — so DATA-SOURCES.md rules out matching it by equality, and an
 * SLD cannot do prefix normalisation. `ltema` partitions all 1 954 539 segments
 * into three integers, and disagrees with the objekttype prefix on **191 rows,
 * i.e. 0.01 %**:
 *
 * - `3211` real channel (1 268 181) — the only class worth drawing
 * - `3103` lake through-flow centreline (665 093) — the network is routed
 *   *through* lakes, so drawing these paints rivers straight across every lake
 * - `3299` fictitious connector (21 255) — imaginary water
 *
 * Filtering on one integer instead of 25 strings is also what keeps the request
 * inside the URL budget (see `elvenettSld`).
 */
const ELVENETT_REAL_CHANNEL = '3211';

/**
 * Line weight by Strahler order — the per-segment size proxy, and the one field
 * here that behaves (`arealregineenhet_km2` is *not* catchment area: it reads
 * 1.16 km² on the Strahler-8 Snåsavassdraget, so as a size proxy it ranks a
 * major river below a ditch). Segment counts on real channels, probed
 * 2026-07-25: order 1 = 689 360, 2 = 306 007, 3 = 150 517, 4 = 76 202,
 * 5 = 29 929, 6 = 10 395, 7 = 4 303, 8 = 1 468.
 *
 * Bands rather than a continuous ramp because SLD has no data-driven width —
 * every distinct weight costs a Rule, and a Rule costs URL budget.
 */
const ELVENETT_BANDS: readonly { min: number; max?: number; width: number; color: string }[] = [
  { min: 6, width: 3.4, color: '#1d4ed8' },
  { min: 4, max: 5, width: 2.4, color: '#2563eb' },
  { min: 2, max: 3, width: 1.5, color: '#3b82f6' },
  { min: 1, max: 1, width: 0.9, color: '#60a5fa' },
];

/**
 * A Strahler-graduated style for NVE's `elvenett`, filtered to real channels.
 *
 * NVE ships this layer as a flat 1 px `rgb(80,140,255)` line with no size
 * distinction and every lake centreline drawn, so the default rendering is both
 * uninformative and actively wrong over water — the whole value of the overlay
 * is in this document.
 *
 * Measured on the live service 2026-07-25, three things that differ from the
 * Naturbase SLD next door and would otherwise be guessed wrong:
 *
 * - **The URL ceiling is ~10 kB here, not ~2 kB** (10 083 chars answered,
 *   11 083 did not) — and it fails as a *dropped connection*, not a 404, so a
 *   too-long request surfaces as "upstream unreachable". The four-band document
 *   builds a ~4.1 kB request, comfortably inside; `wms.test.ts` guards it.
 * - **`PropertyName` is the database field (`ltema`, `elveordenstrahler`), not
 *   the alias.** GetMap filters on field names while GetFeatureInfo *answers*
 *   with aliases (`LTEMA`, `Strahler`) — which is why the identify-side filters
 *   in the catalog entry are spelled differently from the ones here.
 * - **Directional-flow arrows are not reachable through this service.** A
 *   `GraphicStroke`/`shape://oarrow` symbolizer returns HTTP 200 and renders the
 *   geometry as a plain *black* 1 px line: ArcGIS ignores the graphic and falls
 *   back to a default stroke, so the failure looks like a successful render with
 *   the styling silently dropped. Rule-level `MinScaleDenominator`/
 *   `MaxScaleDenominator` *are* honoured, if a future zoom-staged style needs it.
 */
export function elvenettSld(minStrahler: number): string {
  const eq = (field: string, value: string | number) =>
    `<ogc:PropertyIsEqualTo><ogc:PropertyName>${field}</ogc:PropertyName>` +
    `<ogc:Literal>${value}</ogc:Literal></ogc:PropertyIsEqualTo>`;
  const cmp = (op: string, value: number) =>
    `<ogc:PropertyIs${op}><ogc:PropertyName>elveordenstrahler</ogc:PropertyName>` +
    `<ogc:Literal>${value}</ogc:Literal></ogc:PropertyIs${op}>`;

  const rules = ELVENETT_BANDS.filter((band) => band.max === undefined || band.max >= minStrahler)
    .map((band) => {
      const low = Math.max(band.min, minStrahler);
      // Every filter has at least two operands (the class test plus one bound),
      // so the single-operand trap that silently voids an `<ogc:Or>` on the
      // Naturbase service cannot bite an `<ogc:And>` here.
      const terms =
        eq('ltema', ELVENETT_REAL_CHANNEL) +
        cmp('GreaterThanOrEqualTo', low) +
        (band.max === undefined ? '' : cmp('LessThanOrEqualTo', band.max));
      return (
        `<Rule><ogc:Filter><ogc:And>${terms}</ogc:And></ogc:Filter>` +
        `<LineSymbolizer><Stroke>` +
        `<CssParameter name="stroke">${band.color}</CssParameter>` +
        `<CssParameter name="stroke-width">${band.width}</CssParameter>` +
        `</Stroke></LineSymbolizer></Rule>`
      );
    })
    .join('');

  return (
    '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" ' +
    'xmlns:ogc="http://www.opengis.net/ogc"><NamedLayer><Name>elvenett</Name>' +
    `<UserStyle><FeatureTypeStyle>${rules}</FeatureTypeStyle></UserStyle>` +
    '</NamedLayer></StyledLayerDescriptor>'
  );
}

/**
 * The `streams` option: how far down the network to draw. Values are the lowest
 * Strahler order kept, and the identify side mirrors them (see `optionFilter`)
 * so a tap can never answer from a brook the map is not drawing.
 */
const ELVENETT_MIN_STRAHLER: Record<string, number> = { all: 1, main: 3 };

const elvenettOptionParams = () => {
  const byChoice: Record<string, Record<string, string>> = {};
  for (const [choice, min] of Object.entries(ELVENETT_MIN_STRAHLER)) {
    byChoice[choice] = { SLD_BODY: elvenettSld(min) };
  }
  return { streams: byChoice };
};

/** The identify-side twin of `ELVENETT_MIN_STRAHLER` — orders kept, as strings. */
const elvenettOptionFilter = () => {
  const byChoice: Record<string, string[]> = {};
  for (const [choice, min] of Object.entries(ELVENETT_MIN_STRAHLER)) {
    // An empty list means "keep everything", which is exactly right for the
    // unfiltered choice and saves listing all eight orders.
    byChoice[choice] = min <= 1 ? [] : Array.from({ length: 9 - min }, (_, i) => String(min + i));
  }
  return { field: 'Strahler', values: { streams: byChoice } };
};

/**
 * The ATK speed-camera layer: vector, not raster — the data is the NVDB
 * side-table the backend already ships for navigation warnings, so the layer
 * only exists when that dataset (with camera tables) is present. Served via
 * /api/overlay/speed-cameras/features beside the other NVDB routes; listed in
 * the catalog through `OverlayApiOptions.extraMeta`.
 */
export function speedCameraLayerMeta(): LayerMeta {
  return {
    id: 'speed-cameras',
    rev: 1,
    title: 'Speed cameras',
    description: 'ATK speed cameras: fixed point cameras and average-speed sections.',
    group: 'Driving',
    attribution: '© Statens vegvesen',
    metadataUrl: 'https://vegkart.atlas.vegvesen.no/',
    maxzoom: 18,
    defaultOpacity: 1,
    identify: false,
    coverageNote: 'Norwegian ATK only — other countries have no camera data yet.',
    profiles: ['driving'],
    vector: true,
  };
}

/** The curated Norwegian catalog (docs/DATA-SOURCES.md is the reference). */
export function norwegianLayers(): OverlayLayer[] {
  return [
    {
      meta: {
        id: 'hillshade',
        rev: 1,
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
        id: 'terrain-slope',
        rev: 1,
        title: 'Steepness',
        description: 'Colour-classified steep terrain for avalanche and landslide assessment.',
        group: 'Terrain',
        attribution: '© NVE',
        metadataUrl: 'https://kartkatalog.nve.no/',
        minzoom: 7,
        maxzoom: 16,
        defaultOpacity: 0.55,
        identify: false,
        coverageNote:
          'A planning aid, not a live hazard forecast. Blank areas are below the mapped thresholds.',
        profiles: ['hiking', 'ski'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.nve.no/enterprise/services/Bratthet/MapServer/WMSServer',
        version: '1.3.0',
        layers: 'Bratthet_snoskred,Bratthet_jordskred',
      },
    },
    {
      meta: {
        id: 'terrain-contours',
        rev: 2,
        title: 'Contour lines',
        description: 'Scale-aware elevation contours from Norway’s national topographic map.',
        group: 'Terrain',
        attribution: '© Kartverket',
        metadataUrl: `${KARTKATALOG}h%C3%B8ydekurver`,
        minzoom: 7,
        maxzoom: 18,
        defaultOpacity: 0.72,
        identify: false,
        // Contours read the land: slope and basins matter as much to hunting
        // terrain and lake fishing as to hiking, so this is offered (and
        // default-on) in Fish & Hunt too, not just hike/ski.
        profiles: ['hiking', 'ski', 'fishing', 'hunting'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.topo',
        version: '1.3.0',
        // Two groups, because neither covers the whole zoom range on its own and
        // their scale windows are disjoint: `kd_hoydekurver` runs N2000…N50 and
        // stops dead at 1:12000 (~z16), where `fkb_hoydekurver`'s 5 m and 1 m
        // curves take over. Asking for only the first left the layer switched on
        // and drawing nothing from z16 in — the "contours disappear when you zoom
        // in" bug. Requesting both lets the server pick per scale as intended.
        layers: 'kd_hoydekurver,fkb_hoydekurver',
      },
    },
    {
      meta: {
        id: 'satellite-2025',
        rev: 1,
        title: 'Satellite mosaic (2025)',
        description: 'Cloud-minimized Sentinel-2 summer mosaic of Norway from Copernicus imagery.',
        group: 'Imagery',
        attribution: '© Copernicus Sentinel data / Kartverket',
        metadataUrl: `${KARTKATALOG}sentinel-2`,
        maxzoom: 15,
        defaultOpacity: 1,
        identify: false,
        coverageNote:
          'About 10 m per source pixel. Best for landscape-scale use; isolated clouds, shadows and stitching artefacts can remain.',
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.sentinel2',
        version: '1.3.0',
        // Pin the acquisition year. Moving to a future mosaic is an explicit
        // catalog + rev change, so old CDN and disk tiles cannot bleed through.
        layers: '2025',
      },
    },
    {
      meta: {
        id: 'lake-depth',
        rev: 2,
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
        // No renderScale here, deliberately. v0.46.0 requested these tiles at
        // 2× with a DPI hint expecting crisper contours; measured against the
        // live service it does the opposite. ArcGIS only *partly* honours DPI:
        // doubling the image to 512 px widens a contour stroke from 2 px to
        // 3 px, not 4 px, so every line and label ends up ~25% smaller relative
        // to the tile and then gets downscaled for display. The contour numbers
        // came out fainter than the plain 256 px request they replaced. If a
        // hi-dpi variant is wanted later, verify the symbology actually scales
        // before shipping it — the request looks correct either way.
        // Draw each surveyed lake's maximum depth on the lake itself. Without
        // this a lake like Verkensvannet — measured 21.5 m in 1965, but with no
        // sounding or contour geometry — renders as a bare outline, which is
        // indistinguishable from "not surveyed".
        labels: {
          url: 'https://kart.nve.no/enterprise/rest/services/Innsjodatabase2/MapServer/4/query',
          valueField: 'maksdyp_m',
          nameField: 'innsjonavn',
          unit: 'm',
          minzoom: 10,
          // ~55 m — enough detail for a centroid, a fraction of the payload.
          simplifyDeg: 0.0005,
        },
      },
    },
    {
      // NVE Elvenett1 (ELVIS) — the national stream network, 1 954 539 segments.
      // The layer a fishing map is really built on: the basemap draws the water
      // it has, this draws every mapped channel *and* ranks it by size, which is
      // what tells a river from the ditch beside it.
      //
      // Raster with an SLD, not `arcgis-vector` as ROADMAP §4.1 pencilled in:
      // the whole coverage is three orders of magnitude past the ~10³-feature
      // ceiling that pattern has (the weakened-ice row measured where it
      // breaks), and NVE's own scale staging — `elvenett` refuses to draw above
      // 1:100 000 — is a property of the service that only a raster request
      // inherits.
      meta: {
        id: 'rivers',
        rev: 1,
        title: 'Rivers & streams',
        description:
          'The full mapped stream network, drawn thicker as the water grows. Tap for the ' +
          'watercourse name and its stream order.',
        group: 'Water & depth',
        attribution: '© NVE',
        metadataUrl: `${KARTKATALOG}elvenett`,
        // Measured 2026-07-25: z11 and z12 tiles come back empty — NVE caps the
        // full network at 1:100 000 and the z13 tile (1:68 247) is the first one
        // inside it. Without this floor the layer would read as switched on and
        // broken for two whole zoom levels.
        minzoom: 13,
        maxzoom: 16,
        // Linework, not a wash: it has to stay legible over the hillshade and
        // land cover this profile also runs, but it is never hiding them.
        defaultOpacity: 0.9,
        identify: true,
        coverageNote:
          'Lake through-flow lines are not drawn: the network is routed through lakes, and drawing ' +
          'those paints a river straight across open water. A lake’s inlets and outlet are still ' +
          'mapped right up to the shore.',
        profiles: ['fishing', 'hunting'],
        options: [
          {
            key: 'streams',
            label: 'Detail',
            defaultValue: 'all',
            choices: [
              {
                value: 'all',
                label: 'All streams',
                caption: 'Every mapped channel, down to the smallest brook',
              },
              {
                value: 'main',
                label: 'Rivers only',
                caption: 'Drops the headwater brooks — about four in five segments',
              },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.nve.no/enterprise/services/Elvenett1/MapServer/WMSServer',
        version: '1.3.0',
        // `elvenett` alone. The service also publishes `hovedelv` (6 279 main
        // rivers, z9+) and `oversikt`, but they carry neither `elveordenstrahler`
        // nor `ltema` — so they can be neither graded nor filtered — and they
        // keep drawing at z13+, where they would double-stroke every main stem
        // this layer already draws properly.
        layers: 'elvenett',
        identifyLayers: 'elvenett',
        optionParams: elvenettOptionParams(),
        // The tap must answer for what is actually drawn. Without this, tapping
        // the middle of Vansjø answers "Mossevassdraget, order 6" from the
        // invisible lake centreline underneath — an answer about a feature the
        // map deliberately does not draw, on water it draws nothing at all.
        // ArcGIS rejects SLD_BODY on GetFeatureInfo ("Can't parse XML request",
        // same as Naturbase), so this cannot ride along on the tile filter.
        identifyKeep: { field: 'LTEMA', values: [ELVENETT_REAL_CHANNEL] },
        optionFilter: elvenettOptionFilter(),
        // Keys are ArcGIS *aliases* — the text/xml identify answers `Strahler`
        // and `elvehierarki`, not `elveordenstrahler` and `elvenavnhierarki`.
        //
        // `arealRegine` is deliberately absent, and this is the layer where that
        // matters most: it looks exactly like a catchment area and is not one
        // (1.16 km² on a Strahler-8 river), so showing it beside a stream order
        // would invite precisely the wrong reading.
        identifyFields: ['elvenavn', 'elvehierarki', 'Strahler', 'lengde_m', 'vassdragNr'],
        identifyLabels: {
          elvenavn: 'River',
          elvehierarki: 'Watercourse',
          Strahler: 'Stream order (Strahler)',
          lengde_m: 'Segment length (m)',
          vassdragNr: 'Watercourse no.',
        },
        // No `identifyValues`: Strahler order has no upstream legend to quote,
        // and this field is for the source's own wording, not our gloss on it.
      },
    },
    {
      meta: {
        id: 'sea-depth',
        rev: 1,
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
      // Weakened ice on regulated watercourses (NVE SvekketIs1): 6 161 areas +
      // 2 770 river stretches, national. A *safety* layer — ice fishing is
      // mainstream here and regulated lakes drown people every winter — and the
      // one overlay in the catalog where a wrong reading is measured in lives,
      // so both the panel note and the identify wording say what blank means.
      //
      // Raster, not `arcgis-vector`, despite ROADMAP §4.1 pencilling in the
      // latter: measured 2026-07-25, the whole coverage as GeoJSON is 17.8 MB
      // even server-simplified to ~5 m (4.6 MB gzipped) — 4× the Statskog set
      // that pattern was built for, and a per-session download on a phone. The
      // WMS also honours NVE's own scale ranges, switching to the generalized
      // `*_N1000` pair below 1:320 000, which a flat vector pull cannot do.
      meta: {
        id: 'ice-weak',
        rev: 1,
        title: 'Weakened ice',
        description:
          'Ice weakened by hydropower regulation: known unsafe areas on lakes and river stretches.',
        group: 'Water & depth',
        attribution: '© NVE',
        metadataUrl: `${KARTKATALOG}svekket%20is`,
        // NVE draws nothing above 1:2.56 M — roughly a z8 tile. Below that the
        // layer would be silently empty rather than "no weakened ice here".
        minzoom: 8,
        maxzoom: 16,
        // NVE ships this as a flat opaque red fill covering the whole affected
        // basin, so at full strength it erases the water — and the lake-depth
        // overlay under it, which is default-on in the same profile. Half
        // opacity still reads unmistakably as a hazard while leaving the lake
        // legible; the panel slider goes back up for anyone who wants it loud.
        defaultOpacity: 0.5,
        identify: true,
        coverageNote:
          'Known weakened ice, mapped from local knowledge — never a live ice report. Blank water ' +
          'means unmapped or unassessed, not safe.',
        // Offered in Ski as well: a winter tour crossing a regulated lake is the
        // same hazard, and this is the only layer that answers for it.
        profiles: ['fishing', 'hunting', 'ski'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.nve.no/enterprise/services/SvekketIs1/MapServer/WMSServer',
        version: '1.3.0',
        // Drawn bottom-up: the not-assessed backdrop first, then the two
        // generalized N1000 layers (they own 1:2.56 M–1:320 k and are invisible
        // closer in), then the surveyed detail, with the river stretches last so
        // a thin line is never buried under a polygon.
        layers:
          'SvekketIsIkkeVurdert,OppsprukketIsLangsLand_N1000,SvekketIs_N1000,' +
          'OppsprukketIsLangsLand,SvekketIs,SvekketIsElv',
        // Most specific first: an assessed area outranks the not-assessed
        // envelope it sits inside, which otherwise answers for every tap.
        identifyLayers: 'SvekketIs,SvekketIsElv,OppsprukketIsLangsLand,SvekketIsIkkeVurdert',
        // `hoyde` and the digitizing bookkeeping are dropped: elevation is on the
        // map already, and `hrv`/`lrv` are the numbers that explain *why* the ice
        // here is bad — the reservoir's drawdown range in metres above sea level.
        identifyFields: ['navn', 'vurdert', 'hrv', 'lrv', 'areal_km2', 'vassdragnr'],
        identifyLabels: {
          navn: 'Lake',
          vurdert: 'Ice conditions',
          hrv: 'Regulated high water (m)',
          lrv: 'Regulated low water (m)',
          areal_km2: 'Area (km²)',
          vassdragnr: 'Watercourse no.',
        },
        // NVE's own legend, verbatim in translation (MapServer/legend?f=json):
        // the code is the only thing distinguishing the four hazard classes,
        // since `objektType` is "SvekketIsAktsomhetsområde" on nearly all of them.
        identifyValues: {
          vurdert: {
            '0': 'Not assessed — no conclusion either way',
            '1': 'Substantially weakened ice',
            '2': 'Often dangerous ice conditions',
            '3': 'Cracked ice along the shore',
          },
        },
      },
    },
    {
      // NIBIO AR5 land cover — the authoritative answer to "what am I standing
      // in": myr, forest (and its species), open ground, farmland, water. The
      // layer the outdoor profiles were missing, and an N5 model input.
      meta: {
        id: 'land-cover',
        rev: 1,
        title: 'Land cover (AR5)',
        description:
          'Bog, forest, open ground, farmland and water from NIBIO’s AR5 classification. ' +
          'Tap for tree species and site quality.',
        group: 'Terrain',
        attribution: '© NIBIO',
        metadataUrl: `${KARTKATALOG}ar5`,
        // Measured 2026-07-25: the sub-layers carry MaxScaleDenominator 50 000,
        // so a z13 tile comes back as a 334-byte empty PNG. Not a coverage hole
        // and not a broken request — the service refuses to draw. Without this
        // the layer would read as "switched on, no data anywhere".
        minzoom: 14,
        maxzoom: 17,
        // Fully opaque classification: at full strength it erases the basemap,
        // the hillshade and the contours that the outdoor profiles run with.
        defaultOpacity: 0.45,
        identify: true,
        coverageNote:
          'Drawn from zoom 14 only (NIBIO caps it at 1:50 000). AR5 stops at the tree line — ' +
          'bare mountain reads as “not mapped”, which is not the same as “nothing there”.',
        profiles: ['hiking', 'fishing', 'hunting'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.nibio.no/cgi-bin/ar5',
        version: '1.3.0',
        layers: 'Arealtype',
        identifyLayers: 'Arealtype',
        // The polygon carries the whole AR5 record, so a tap answers far more
        // than the colour does — tree species and site quality are exactly what
        // a hunter reads a forest for, and are why N5 takes them from AR5
        // rather than from SR16. Only the `*_beskrivelse` twins are listed: the
        // bare codes (`artype` 30, `arskogbon` 13) are the same information in
        // a spelling no reader can use, and unlike a code the text degrades
        // into readable Norwegian if NIBIO ever adds a class we don't know.
        identifyFields: [
          'artype_beskrivelse',
          'artreslag_beskrivelse',
          'arskogbon_beskrivelse',
          'argrunnf_beskrivelse',
          'verifiseringsdato',
        ],
        identifyLabels: {
          artype_beskrivelse: 'Land cover',
          artreslag_beskrivelse: 'Tree species',
          arskogbon_beskrivelse: 'Site quality',
          argrunnf_beskrivelse: 'Ground',
          verifiseringsdato: 'Verified',
        },
        // NIBIO's own class names, translated. The empty strings are load-
        // bearing: `98`/`99` ("not relevant", "not recorded") are on nearly
        // every non-forest polygon, and three rows of "Tree species: not
        // relevant" is what an identify card looks like when nobody read one.
        identifyValues: {
          artype_beskrivelse: {
            Bebygd: 'Built-up',
            Samferdsel: 'Roads & transport',
            'Fulldyrka jord': 'Cultivated land',
            'Overflatedyrka jord': 'Surface-cultivated land',
            Innmarksbeite: 'Pasture',
            Skog: 'Forest',
            'Åpen fastmark': 'Open firm ground',
            Myr: 'Bog / marsh',
            Snøisbre: 'Snow & glacier',
            Ferskvann: 'Fresh water',
            Hav: 'Sea',
            'Ikke kartlagt': 'Not mapped (AR5 stops at the tree line)',
          },
          artreslag_beskrivelse: {
            Barskog: 'Conifer',
            Lauvskog: 'Deciduous',
            Blandingsskog: 'Mixed',
            'Ikke tresatt': 'Treeless',
            'Ikke relevant': '',
            'Ikke registrert': '',
          },
          arskogbon_beskrivelse: {
            'Særs høy': 'Very high',
            Høy: 'High',
            Middels: 'Medium',
            Lav: 'Low',
            Impediment: 'Unproductive',
            'Ikke relevant': '',
            'Ikke registrert': '',
          },
          argrunnf_beskrivelse: {
            'Fjell i dagen': 'Bare rock',
            Blokkmark: 'Boulder field',
            Grunnlendt: 'Shallow soil',
            Jorddekt: 'Soil-covered',
            'Organiske jordlag': 'Organic soil (peat)',
            'Ikke relevant': '',
            'Ikke registrert': '',
          },
        },
      },
    },
    {
      // Naturbase artfunksjon — officially surveyed wildlife functional areas:
      // winter grazing, calving, migration corridors and capercaillie leks.
      //
      // PRESENCE-ONLY, and the coverage note has to carry that: a blank area
      // means nobody surveyed it, never "no animals here". It is the one thing
      // this layer could be read to say that would be wrong.
      meta: {
        id: 'wildlife-areas',
        rev: 1,
        title: 'Wildlife areas',
        description:
          'Surveyed functional areas — winter grazing, calving, migration routes and display ' +
          'grounds. Pick which species to draw.',
        group: 'Hunting',
        attribution: '© Miljødirektoratet',
        metadataUrl: `${KARTKATALOG}arter%20funksjonsomr%C3%A5de`,
        maxzoom: 16,
        defaultOpacity: 0.85,
        identify: true,
        coverageNote:
          'Presence only: blank ground means it has not been surveyed, not that there are no ' +
          'animals. Display and lek sites are mapped as ~10 m circles — zoom past 15 to see them.',
        profiles: ['hunting'],
        options: [
          {
            key: 'species',
            label: 'Species',
            defaultValue: 'biggame',
            choices: [
              { value: 'biggame', label: 'Big game', caption: 'Elg, hjort and rådyr' },
              {
                value: 'forestbirds',
                label: 'Forest birds',
                caption: 'Storfugl, orrfugl and jerpe — leks included',
              },
              { value: 'ptarmigan', label: 'Ptarmigan', caption: 'Lirype and fjellrype' },
              {
                value: 'all',
                label: 'All species',
                caption: 'Everything surveyed — mostly seabirds, bats and amphibians',
              },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.miljodirektoratet.no/arcgis/services/artfunksjon/MapServer/WMSServer',
        version: '1.3.0',
        layers: 'art_funksjonsomrade',
        identifyLayers: 'art_funksjonsomrade',
        optionParams: artfunksjonOptionParams(),
        // ArcGIS faults on SLD_BODY for GetFeatureInfo ("Can't parse XML
        // request"), so the species filter cannot ride along on the tap the way
        // it does on the tile. Without this, filtering to big game and tapping
        // a moose area would just as happily answer "Ærfugl" from the seabird
        // polygon underneath — the filter would read as a lie.
        optionFilter: { field: 'Norsknavn', values: { species: ARTFUNKSJON_SPECIES } },
        // ESRI's text/xml identify already resolves the coded domains
        // (`funksjon` 1 → "beiteområde …", `verdi` "A" → "Svært viktig"), so
        // unlike the weakened-ice layer there are no integers to decode — only
        // Norwegian to translate. Keys are the ArcGIS *aliases*, which is what
        // that dialect emits.
        identifyFields: [
          'Norsknavn',
          'Funksjon',
          'Årstid',
          'Verdi',
          'Områdenavn',
          'Kommune',
          'Datafangstdato',
        ],
        identifyLabels: {
          Norsknavn: 'Species',
          Funksjon: 'Function',
          Årstid: 'Season',
          Verdi: 'Importance',
          Områdenavn: 'Area',
          Kommune: 'Municipality',
          Datafangstdato: 'Surveyed',
        },
        identifyValues: {
          Funksjon: {
            'beiteområde (Behavior: feeding, Activity: Foraging)': 'Grazing / feeding area',
            'trekkvei (Behavior: moving, Activity: Flying overhead)': 'Migration route',
            'hiområde (Behavior: reproductive, Activity: Breeding)': 'Denning area',
            'myte/hårfellingsområde (Behavior: stationary, Activity: Stationary)': 'Moulting area',
            'overnattingsområde (Behavior: stationary, Activity: Stationary)': 'Roosting area',
            'rasteområde (Behavior: feeding, Activity: Staging)': 'Staging area',
            'spill/parringsområde (Behavior: reproductive, Activity: Display/song)':
              'Display / lek ground',
            'yngleområde (Behavior: reproductive, Activity: Breeding)': 'Breeding area',
            'leveområde (Behavior: stationary, Activity: Permanent territory)':
              'Year-round habitat',
          },
          Verdi: {
            'Svært viktig': 'Very important',
            Viktig: 'Important',
            Registrert: 'Recorded',
            'Ikke verdisatt': 'Not rated',
          },
          Årstid: {
            vår: 'Spring',
            sommer: 'Summer',
            høst: 'Autumn',
            vinter: 'Winter',
            'vår/sommer': 'Spring–summer',
            'vår/høst': 'Spring & autumn',
            'vår/vinter': 'Spring & winter',
            'sommer/høst': 'Summer–autumn',
            'sommer/vinter': 'Summer & winter',
            'høst/vinter': 'Autumn–winter',
            'hele året': 'All year',
            'vår/sommer/høst': 'Spring–autumn',
            'vår/sommer/vinter': 'All but autumn',
            'sommer/høst/vinter': 'Summer–winter',
            'vår/høst/vinter': 'All but summer',
          },
        },
      },
    },
    {
      meta: {
        id: 'property',
        rev: 1,
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
      // Statskog storviltjaktfelt — the state-forest big-game hunting fields:
      // field boundaries and the species each is opened for (elg/hjort/rein).
      // A PLANNING overlay for where you may hunt on state land, not a record
      // of sightings or fellings. The whole national set (922 polygons) is one
      // simplified GeoJSON fetch, disk-cached and hit-tested client-side — the
      // first user of the generic `arcgis-vector` kind (§4.7a). Identify is a
      // local hit-test against the rendered features, so `identify:false` keeps
      // it out of the WMS GetFeatureInfo path.
      meta: {
        id: 'statskog-jaktfelt',
        rev: 1,
        title: 'Hunting fields (Statskog)',
        description:
          'State-forest big-game hunting fields (storviltjaktfelt): boundaries and the species ' +
          'each field is opened for. Tap a field for its name, species and remarks.',
        group: 'Hunting',
        attribution: '© Statskog',
        metadataUrl:
          'https://kartkatalog.geonorge.no/metadata/uuid/c23c14c6-63c4-40f4-bae4-2d40198a2f40',
        maxzoom: 18,
        defaultOpacity: 0.85,
        identify: false,
        coverageNote: 'State-owned (Statskog) land only — private hunting grounds are not covered.',
        profiles: ['hunting'],
        vector: true,
      },
      upstream: {
        kind: 'arcgis-vector',
        // Year-versioned service name (`Storvilt_2024`) — expect an annual
        // rename (DATA-SOURCES.md); a new season is a one-line url + rev bump.
        url: 'https://kartportal.statskog.no/server/rest/services/Storvilt_2024/Storvilt_app_innsyn/MapServer/4/query',
        outFields: 'Feltnavn,Art,Merknad',
        // ~11 m — hunting fields are large; boundaries stay faithful, payload
        // drops from 60 MB to ~4.4 MB (measured 2026-07-24).
        simplifyDeg: 0.0001,
      },
    },
    {
      meta: {
        id: 'trails-hiking',
        rev: 1,
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
        rev: 2,
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
        // The WMS layer is named without the ø (GetCapabilities: "Skiloype").
        // "Skiløype" returns a LayerNotDefined fault, i.e. an always-empty
        // overlay — not a seasonal gap. Kartverket's route DB is year-round.
        layers: 'Skiloype',
      },
    },
    {
      meta: {
        id: 'trails-bike',
        rev: 1,
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
