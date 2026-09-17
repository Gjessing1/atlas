import type { LayerMeta } from '@atlas/core';
import type { IdentifyFormat } from './identify.js';

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
   * Per-field presentation formats for upstream encodings that are not already
   * readable text. NVE's historic `dato_dig` values use both YYYYMMDD and
   * YYYYDDMM, so formatting it generically can swap day and month;
   * `esri-datetime` is ArcGIS's US-order 12-hour clock (`3/10/2015 7:57:00 AM`).
   */
  identifyFormats?: Record<string, IdentifyFormat>;
  /**
   * `identifyValues`' list-valued sibling: the field holds *several* codes in
   * one string, so it is split on whitespace/commas and each token translated
   * (see `translateTokens`).
   *
   * Fiskeridirektoratet's `arter` is the case — "HYSE RØDSPETTE SEI SILD TORSK"
   * is not free text but a controlled vocabulary of 35 tokens across 1 644
   * areas (measured 2026-08-04), which is exactly what a dictionary may be
   * written for. A token mapped to the empty string is dropped, which is how
   * the junk in a hand-maintained list ("OG", a literal "0") stays out.
   */
  identifyTokens?: Record<string, Record<string, string>>;
  /**
   * Restrict (and order) the INFO_FORMATs tried for this layer. Unset = the
   * standard chain. Only for upstreams that answer *wrongly* in a format the
   * chain would reach first — see the note in the identify route.
   */
  identifyInfoFormats?: string[];
  /**
   * Cap the zoom a tap is asked at, widening the query's ground radius (see
   * `identifyZoom`). For layers whose features are point symbols: without it a
   * tap has to land within a couple of metres of the point at high zoom.
   */
  identifyZoom?: number;
  /**
   * QUERY_LAYERS per option choice, for options that swap the *dataset* rather
   * than filter one (see `optionQueryLayers`).
   */
  optionIdentifyLayers?: Record<string, Record<string, string>>;
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
   * Fixed GetMap-only parameters for a layer whose useful view is a styled
   * subset of its upstream. Unlike `optionParams`, these do not create a UI
   * choice: Kartverket's N50 footpaths are always `typeveg=sti` and should
   * never fall back to drawing the entire road layer.
   */
  getMapParams?: Record<string, string>;
  /**
   * Extra GetMap parameters contributed by a selected layer option
   * (`LayerMeta.options` → option key → choice value → params). Data, not code,
   * so the whole variant surface of a layer is readable in one place and
   * testable without a server.
   */
  optionParams?: Record<string, Record<string, Record<string, string>>>;
  /**
   * GetMap parameters computed from *all* the selected options at once, merged
   * over `optionParams`.
   *
   * The escape hatch for a parameter two chips have to agree on, which the
   * per-option table cannot express. Alien species is the case: MapServer's
   * vendor `FILTER` takes exactly one filter per layer in LAYERS and faults if
   * the counts differ, so the organism filter has to know how many risk
   * categories the *other* chip selected.
   */
  optionParamsFor?: (chosen: Record<string, string>) => Record<string, string>;
  /**
   * The identify-side twin of `optionParams`, for upstreams that cannot apply
   * the same filter to GetFeatureInfo — ArcGIS accepts `SLD_BODY` on GetMap and
   * faults on it for identify, so the tap is filtered here instead. Keep only
   * features whose `field` is in the choice's list; an empty list keeps all.
   */
  optionFilter?: { field: string; values: Record<string, Record<string, string[]>> };
  /**
   * Send `optionParams` on GetFeatureInfo too, for the upstreams that apply
   * their own filter to a tap.
   *
   * Opt-in per layer because the two MapServers in this catalog disagree about
   * it: Riksantikvaren's SEFRAK narrows a tap by the vendor `FILTER` exactly as
   * it narrows the tile (measured 2026-08-04 — 36 buildings under one tap, 9
   * with the ruins filter, and every one of the nine a ruin), while
   * Artsdatabanken's answers with a plant under a filter for animals. Where it
   * works it is the better half of the pair: the upstream filters *before*
   * counting, so the narrowing sees the same features the map is drawing.
   */
  optionParamsOnIdentify?: boolean;
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
  /**
   * `upstream` disables Atlas's permanent disk cache and forwards the source's
   * browser-cache lifetime instead. Commercial imagery is the motivating case:
   * it may be displayed and cached as HTTP permits, but not copied into Atlas's
   * own long-lived tile store or exported into an offline pack.
   */
  cache?: 'disk' | 'upstream';
  /** Detect ArcGIS's opaque missing-tile JPEG and turn it transparent. */
  missingTile?: 'arcgis-etag';
  /** Parent level used to synthesize correctly aligned missing detail tiles. */
  fallbackMaxzoom?: number;
  /** Server-side colour treatment for a source whose native imagery is not a usable map. */
  transform?: 'light-pollution-palette';
}

/**
 * A vector overlay drawn from an ArcGIS REST feature layer rather than proxied
 * raster tiles (`LayerMeta.vector`). The backend pulls the whole coverage once
 * as GeoJSON, disk-caches it, and serves it at `/api/overlay/:id/features`; the
 * client renders and hit-tests it directly (the speed-camera pattern, but
 * generic and sourced from an upstream). The reusable enabler — Statskog
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

/**
 * N50's path subset, restyled as quiet local access rather than a marked route.
 *
 * The live `N50Veger` service exposes paths as `typeveg=sti`; its default
 * style also draws every public/private road, which would double the basemap.
 * Keep the filter in the SLD and let the separate Fotrute overlay carry the
 * strong marked-route treatment above it.
 */
export function topoFootpathsSld(): string {
  return (
    '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" ' +
    'xmlns:ogc="http://www.opengis.net/ogc"><NamedLayer><Name>N50Veger</Name>' +
    '<UserStyle><FeatureTypeStyle><Rule><ogc:Filter><ogc:PropertyIsEqualTo>' +
    '<ogc:PropertyName>typeveg</ogc:PropertyName><ogc:Literal>sti</ogc:Literal>' +
    '</ogc:PropertyIsEqualTo></ogc:Filter><LineSymbolizer><Stroke>' +
    '<CssParameter name="stroke">#8b5a44</CssParameter>' +
    '<CssParameter name="stroke-width">1.1</CssParameter>' +
    '<CssParameter name="stroke-opacity">0.82</CssParameter>' +
    '<CssParameter name="stroke-dasharray">2 2</CssParameter>' +
    '</Stroke></LineSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer>' +
    '</StyledLayerDescriptor>'
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
 * Alien species: which WMS layers each risk chip draws, and what an organism
 * chip filters them to. One table, read by the tile params, the identify
 * params and the filter arity below, so the three cannot drift apart.
 */
const ALIEN_RISK_LAYERS: Record<string, string> = {
  severe: 'SE',
  high: 'HI,SE',
  all: 'NK,LO,PH,HI,SE',
};

const ALIEN_KINGDOMS: Record<string, string> = { plants: 'Plantae', animals: 'Animalia' };

/**
 * The organism filter, as MapServer's vendor `FILTER` parameter.
 *
 * Measured on the live service 2026-08-04, and both halves fail loudly rather
 * than silently, which is why this is safe to build by string:
 *
 * - **One filter per layer in LAYERS, or a ServiceException.** `(f)` against
 *   `HI,SE` is a fault, `(f)(f)` draws — so the repeat count is read from the
 *   *risk* chip's layer list, not assumed.
 * - **An unknown field name is a ServiceException too**, so a rename upstream
 *   surfaces as a dead layer in the probe rather than as an unfiltered map.
 */
/**
 * The Askeladden layers a category chip can draw: the two locality layers and
 * the monument icons, in the order their `STYLES` names are listed.
 *
 * `Sikringssoner` and `Enkeltminner` are deliberately absent — neither
 * publishes a category style, and STYLES is positional, so keeping them would
 * mean naming a style they do not have (a ServiceException, i.e. a blank
 * overlay). The cost is the monument outlines above z15 while a chip is on,
 * which the icons still stand in for.
 */
const HERITAGE_CATEGORY_LAYERS = 'Lokaliteter,Lokalitetsikoner,Enkeltminneikoner';

/**
 * SEFRAK's register status for a building old enough to be reportable — the
 * literal the service answers with, shared by the filter and the card's own
 * translation of it so the two can never drift into disagreeing.
 */
const SEFRAK_PRE_1850 = 'Meldepliktig iht. Kulturminneloven §25';

/**
 * One MapServer vendor `FILTER` over the SEFRAK layer: keep the buildings whose
 * `field` holds one of these values.
 *
 * A single value is emitted as a bare comparison and several inside an `<Or>`
 * — verified against the live service on 2026-08-04, both the one-value and the
 * two-value form, at a point where the unfiltered tap answered with three
 * abandoned records and the filter returned exactly those three. SEFRAK is one
 * layer, so exactly one filter is emitted (the arity rule that bites the alien
 * species layer above).
 */
function sefrakFilter(field: string, values: string[]): string {
  const eq = (value: string) =>
    `<PropertyIsEqualTo><PropertyName>${field}</PropertyName>` +
    `<Literal>${xml(value)}</Literal></PropertyIsEqualTo>`;
  const inner = values.length === 1 ? eq(values[0]!) : `<Or>${values.map(eq).join('')}</Or>`;
  return `(<Filter>${inner}</Filter>)`;
}

export function alienGroupParams(chosen: Record<string, string>): Record<string, string> {
  const kingdom = ALIEN_KINGDOMS[chosen['group'] ?? ''];
  if (!kingdom) return {};
  const layers = ALIEN_RISK_LAYERS[chosen['risk'] ?? ''] ?? ALIEN_RISK_LAYERS['severe']!;
  const filter =
    `(<Filter><PropertyIsEqualTo><PropertyName>Kingdom</PropertyName>` +
    `<Literal>${xml(kingdom)}</Literal></PropertyIsEqualTo></Filter>)`;
  return { FILTER: filter.repeat(layers.split(',').length) };
}

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
        id: 'light-pollution',
        rev: 2,
        title: 'Light pollution',
        description: 'VIIRS artificial-light radiance in a dark-sky planning palette.',
        group: 'Weather',
        attribution: '© NASA Earth Observatory / Suomi NPP VIIRS',
        metadataUrl: 'https://gibs.earthdata.nasa.gov/layer-metadata/v1.0/VIIRS_Night_Lights.json',
        maxzoom: 8,
        defaultOpacity: 0.72,
        identify: false,
        coverageNote:
          '2016 annual radiance, recoloured from dark blue through green, yellow and red. A useful dark-sky proxy, not a direct Bortle measurement.',
      },
      upstream: {
        kind: 'xyz',
        // GIBS publishes this annual cloud-minimized composite as Web Mercator
        // tiles through level 8. WMTS REST uses z/row/column (z/y/x).
        template:
          'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Night_Lights/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
        transform: 'light-pollution-palette',
      },
    },
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
        id: 'topographic-map',
        rev: 1,
        title: 'Kartverket topographic map',
        description:
          'Norway’s official topographic map, including terrain names, paths and map-sheet detail.',
        group: 'Imagery',
        attribution: '© Kartverket',
        metadataUrl: 'https://www.kartverket.no/api-og-data/kartbilder',
        maxzoom: 18,
        defaultOpacity: 1,
        identify: false,
        coverageNote: 'Norway only. Select this as a full map reference; it covers the basemap.',
        profiles: ['hiking', 'fishing', 'hunting'],
      },
      upstream: {
        kind: 'xyz',
        // Kartverket WMTS uses z/row/column, i.e. z/y/x, in its REST template.
        template:
          'https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png',
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
        id: 'world-imagery',
        rev: 2,
        title: 'Satellite & aerial (high-res)',
        description: 'Detailed global satellite and aerial imagery, streamed from Esri.',
        group: 'Imagery',
        attribution: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
        metadataUrl: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9',
        maxzoom: 19,
        defaultOpacity: 1,
        identify: false,
        coverageNote:
          'Streaming only — not included in offline regions. Resolution, capture date and cloud cover vary by location.',
      },
      upstream: {
        kind: 'xyz',
        // ArcGIS REST orders cached tiles as level/row/column, i.e. z/y/x.
        template:
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        missingTile: 'arcgis-etag',
        // Norway is consistently covered through z18, while local z19 detail
        // exists in places such as central Oslo. Missing z19 tiles are cropped
        // from their z18 parent; real z19 tiles pass through untouched.
        fallbackMaxzoom: 18,
        // The item explicitly excludes offline tile export. Do not let the
        // overlay proxy turn streamed views into Atlas's permanent disk cache.
        cache: 'upstream',
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
      // Raster with an SLD, not the `arcgis-vector` first planned for it:
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
      // Raster, not `arcgis-vector`, despite the plan pencilling in the
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
        // `dato_dig` is when NVE's static hazard polygon was mapped. It is not a
        // field observation, but it is the only freshness evidence this source
        // carries and must be visible beside the separate live Regobs markers.
        // Elevation is already on the map; hrv/lrv explain the drawdown hazard.
        identifyFields: ['navn', 'vurdert', 'dato_dig', 'hrv', 'lrv', 'areal_km2', 'vassdragnr'],
        identifyLabels: {
          navn: 'Lake',
          vurdert: 'Ice conditions',
          dato_dig: 'Mapped',
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
        identifyFormats: { dato_dig: 'nve-date' },
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
        id: 'protected-areas',
        rev: 1,
        title: 'Protected areas',
        description:
          'Established nature reserves, national parks and other protected areas. Tap an area ' +
          'for its governing regulation.',
        group: 'Nature',
        attribution: '© Miljødirektoratet',
        metadataUrl: 'https://kart.miljodirektoratet.no/arcgis/rest/services/vern/MapServer',
        maxzoom: 18,
        defaultOpacity: 0.68,
        identify: true,
        coverageNote:
          'Advisory only: the boundary says where established protection applies, not what is ' +
          'allowed. Tap the area and read its regulation before hunting, fishing or camping.',
        profiles: ['fishing', 'hunting'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.miljodirektoratet.no/arcgis/services/vern/MapServer/WMSServer',
        version: '1.3.0',
        // Layer 0 is established protection. Layer 4 is proposed protection and
        // must never be drawn as though the same legal boundary already applies.
        layers: 'naturvern_omrade',
        identifyLayers: 'naturvern_omrade',
        identifyFields: ['navn', 'verneform', 'kommune', 'verneforskrift', 'faktaark'],
        identifyLabels: {
          navn: 'Area',
          verneform: 'Protection',
          kommune: 'Municipality',
          verneforskrift: 'Regulation',
          faktaark: 'Fact sheet',
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
      // first user of the generic `arcgis-vector` kind. Identify is a
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
        // Fish & Hunt needs the same access network to reach water, a stand or
        // a permit polygon. It remains optional there: its ground-reading
        // overlays already start on, and another strong raster would obscure them.
        profiles: ['hiking', 'fishing', 'hunting'],
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
        id: 'topo-footpaths',
        rev: 1,
        title: 'Minor footpaths (N50)',
        description:
          'Smaller mapped paths from Kartverket N50, drawn quietly beneath marked hiking routes.',
        group: 'Trails',
        attribution: '© Kartverket',
        metadataUrl: 'https://www.kartverket.no/api-og-data/kartdata',
        // N50Veger publishes at 1:50k–1:12k. z14/z15 are the two web-mercator
        // levels inside that band; MapLibre overzooms z15 for closer reading.
        minzoom: 14,
        maxzoom: 15,
        defaultOpacity: 0.72,
        identify: false,
        profiles: ['hiking', 'fishing', 'hunting'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.topo',
        version: '1.3.0',
        layers: 'N50Veger',
        getMapParams: { SLD_BODY: topoFootpathsSld() },
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

    // -------------------------------------------------------------------
    // Curiosities — the layers that answer "what is out here
    // that I would never have known to look for": burial mounds, wrecks,
    // caves, old mine shafts. Every row is Norway-only and profile-tagged, so
    // outside Norway the profile degrades to the basemap and the overlays are
    // simply absent (the Norway-only rule), never a "no data" message.
    //
    // **Every `minzoom` below is derived from the service's own scale limits,
    // with the equator formula `scale ≈ 559 082 264 / 2^z`.** These servers
    // compute the denominator from the EPSG:3857 bbox at face value and never
    // divide by cos(lat) — measured on Askeladden at Borre (59.4°N), whose
    // 1:25 000 cut-off leaves z14 (34 124) blank and z15 (17 062) drawn. Using
    // the ground-distance scale instead predicts z14 and ships a layer that is
    // switched on and empty, which is indistinguishable from "nothing here".
    // Where a service splits one dataset across scale bands, all the bands are
    // listed in `layers` (the contours pattern) so the layer draws all the way
    // down instead of vanishing at a zoom nobody would think to test.
    // -------------------------------------------------------------------
    {
      // Askeladden — Riksantikvaren's national heritage register, and the
      // reason this profile exists: gravhaug, bygdeborg, medieval ruins, rock
      // art, WWII coastal forts, execution sites. ~700 k entries nationally.
      //
      // The tap is the whole feature here, not a courtesy: `datering` dates the
      // thing ("Etterreformatorisk tid"), `synlig` says whether anything is
      // left to see, and `informasjon` is the surveyor's own field description.
      meta: {
        id: 'heritage-sites',
        rev: 2,
        title: 'Cultural heritage',
        description:
          'Burial mounds, hill forts, ruins, rock art and war remains from the Askeladden ' +
          'register. Tap for what it is, whether anything is still visible, and the surveyor’s ' +
          'own description.',
        group: 'History',
        attribution: '© Riksantikvaren',
        metadataUrl: `${KARTKATALOG}kulturminner%20lokaliteter`,
        // The icon layers stop at 1:450 000 (z11); the outlines at 1:25 000.
        minzoom: 11,
        maxzoom: 17,
        defaultOpacity: 1,
        identify: true,
        coverageNote:
          'A register, not an invitation: most sites are on private land, and everything from ' +
          'before 1537 is automatically protected — look, never dig. Outlines draw from z15; ' +
          'below that each site is one icon.',
        profiles: ['curiosities'],
        // Askeladden's own three-way split of the register, as chips.
        //
        // Measured over 156 localities sampled from Agder to Trøndelag
        // (2026-08-04): archaeology 80 %, buildings and infrastructure 18 %,
        // church sites 2 %. Those shares are exactly why the chips are worth
        // having and why the default is everything — a church site is one
        // symbol in a county, findable only by taking the other 98 % away,
        // while archaeology *is* the register and hiding it by default would
        // repeat the groundwater mistake of v0.145.0.
        options: [
          {
            key: 'kind',
            label: 'Show',
            defaultValue: 'all',
            choices: [
              {
                value: 'all',
                label: 'Everything',
                caption: 'Every recorded site — archaeology, buildings and church grounds.',
              },
              {
                value: 'archaeology',
                label: 'Archaeology',
                caption:
                  'Burial mounds, settlement traces, charcoal pits, hunting systems — what is ' +
                  'in the ground rather than on it.',
              },
              {
                value: 'buildings',
                label: 'Buildings & works',
                caption:
                  'Standing heritage: farm buildings, roads, industry and the rest of the built ' +
                  'record.',
              },
              {
                value: 'churches',
                label: 'Church sites',
                caption:
                  'Church grounds, including the ones where the church itself is long gone — ' +
                  'rare enough that only a filter finds them.',
              },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.ra.no/wms/kulturminner2',
        version: '1.3.0',
        // Bottom-up: protection zones, then locality and monument outlines
        // (1:25 000 and closer), then the icons that carry the layer at
        // planning zoom. The icons are queryable in their own right, which is
        // what keeps the tap working above z15.
        layers: 'Sikringssoner,Lokaliteter,Enkeltminner,Lokalitetsikoner,Enkeltminneikoner',
        identifyLayers: 'Enkeltminner,Lokaliteter,Lokalitetsikoner',
        // The chips are `STYLES`, which on this service *selects* rather than
        // restyles: measured at Borre on 2026-08-04, `Lokalitetsikoner` draws
        // 8 116 px unstyled, 7 360 as archaeology, 1 187 as buildings and 132
        // as church sites.
        //
        // Two things force the LAYERS rewrite that comes with it. STYLES is
        // positional — one name per layer in LAYERS — and the five layers do
        // not share a vocabulary: `Sikringssoner` has no category styles at
        // all, `Enkeltminner` has none either, and the monument icons call the
        // built record `bygninger`/`kirker` where the locality layers call it
        // `bebyggelse_infrastruktur`/`kirkesteder`. Naming a style a layer does
        // not publish is a ServiceException, i.e. a blank overlay.
        optionParams: {
          kind: {
            all: {},
            archaeology: {
              LAYERS: HERITAGE_CATEGORY_LAYERS,
              STYLES: 'arkeologiske_minner,arkeologiske_minner,arkeologiske_minner',
            },
            buildings: {
              LAYERS: HERITAGE_CATEGORY_LAYERS,
              STYLES: 'bebyggelse_infrastruktur,bebyggelse_infrastruktur,bygninger',
            },
            churches: {
              LAYERS: HERITAGE_CATEGORY_LAYERS,
              STYLES: 'kirkesteder,kirkesteder,kirker',
            },
          },
        },
        // A tap under a chip asks only the two layers that carry the category
        // field, so the answer can be filtered at all — `Enkeltminner` has no
        // `lokaliteteskategori`, and `optionKeeps` keeps what it cannot
        // classify, which under a chip would read as the filter leaking.
        optionIdentifyLayers: {
          kind: {
            archaeology: 'Lokaliteter,Lokalitetsikoner',
            buildings: 'Lokaliteter,Lokalitetsikoner',
            churches: 'Lokaliteter,Lokalitetsikoner',
          },
        },
        // STYLES filters the picture, not the question: GetFeatureInfo ignores
        // it entirely, so without this a tap under "Church sites" answers with
        // the burial mound underneath.
        optionFilter: {
          field: 'lokaliteteskategori',
          values: {
            kind: {
              all: [],
              archaeology: ['Arkeologisk minne'],
              buildings: ['Bebyggelse-Infrastruktur'],
              churches: ['Kirkested'],
            },
          },
        },
        // The union of the two feature types' fields — `lokalitetsart` on a
        // locality, `enkeltminneart` on a single monument — most specific
        // first.
        //
        // The order is the card, not a preference: a place card shows the first
        // six rows (`IDENTIFY_CARD_ROWS`), and the six this list used to lead
        // with were name, type, protection, statute, visibility, municipality —
        // so the two rows a visitor is actually standing there for, the
        // surveyor's own description and the link to the public record, were
        // cut off the bottom of every card. `vernelov` reads "Kulturminneloven
        // av 1978" on essentially every automatically protected site and
        // `kommune` repeats what the map already says, so both give up their
        // place.
        //
        // `datering` is gone, and with it this row's original promise of a
        // dating: probed field by field on 2026-08-04, **the WMS has no such
        // attribute** — not on `Lokaliteter`, not on `Enkeltminner`. Askeladden
        // holds the dating, the export behind this service does not, and an
        // allow-list entry for a field that cannot arrive is indistinguishable
        // from one that is simply never populated.
        identifyFields: [
          'navn',
          'enkeltminneart',
          'lokalitetsart',
          'synlig',
          'vernetype',
          'informasjon',
          'linkkulturminnesok',
          'opprinneligfunksjon',
          'kommune',
        ],
        identifyLabels: {
          navn: 'Name',
          enkeltminneart: 'Monument',
          lokalitetsart: 'Site type',
          opprinneligfunksjon: 'Original function',
          vernetype: 'Protection',
          synlig: 'Visible on site',
          kommune: 'Municipality',
          informasjon: 'Description',
          linkkulturminnesok: 'More',
        },
        identifyValues: {
          // The one field a visitor actually plans around: whether there is
          // anything above ground. Askeladden answers it as a bare boolean.
          synlig: { true: 'Yes — something to see', false: 'No visible trace' },
          // Riksantikvaren's site types, sampled from the live register across
          // 40 places (2026-08-04) so the list covers what a tap actually
          // returns rather than what the code list contains — the register runs
          // from Stone Age settlement to listed bank buildings, and "Site type:
          // Kullfremstillingsanlegg" is the most common answer in the forest.
          // Anything unlisted reaches the reader in Norwegian, which is the
          // right failure for a vocabulary this long.
          lokalitetsart: {
            'Bosetning-aktivitetsområde': 'Settlement / activity area',
            Kullfremstillingsanlegg: 'Charcoal production site',
            Dyrkingsspor: 'Traces of cultivation',
            Gravminne: 'Burial monument',
            Gravfelt: 'Burial ground',
            Rydningsrøyslokalitet: 'Clearance cairns',
            Kokegroplokalitet: 'Cooking pits',
            Funnsted: 'Find spot',
            Veganlegg: 'Road works',
            Vandrerute: 'Historic route',
            Kirkested: 'Church site',
            Kirkegårdslokalitet: 'Graveyard',
            Forsvarsanlegg: 'Defence works',
            Krigsminnelokalitet: 'War remains',
            Minnesmerke: 'Memorial',
            Tradisjonslokalitet: 'Place of tradition',
            Skipsfunn: 'Ship find',
            Bygdeborg: 'Hill fort',
            Bergkunst: 'Rock art',
            Jernvinneanlegg: 'Iron-smelting site',
            Fangstlokalitet: 'Hunting or trapping site',
            Steinbrudd: 'Quarry',
            Industrianlegg: 'Industrial works',
            Kraftverk: 'Power station',
            Tekstilproduksjon: 'Textile works',
            Jernbaneanlegg: 'Railway structure',
            Havneområde: 'Harbour area',
            Handelsanlegg: 'Trading premises',
            Boligeiendom: 'Listed dwelling',
            Bygårdsanlegg: 'Listed town building',
            'Annen bygningslokalitet': 'Other listed building',
            Undervisningsanlegg: 'School building',
            Finansinstitusjon: 'Bank building',
            'Offentlig institusjon': 'Public institution',
            'Kulturinstitusjoner - forsamlingshus': 'Assembly hall',
            'Embetsgård-embetsbolig': 'Official residence',
            'Idretts-rekreasjonsanlegg': 'Sports or recreation grounds',
            Grøntområder: 'Historic green space',
          },
          // Riksantikvaren's own protection classes, translated. "Uavklart" is
          // load-bearing: it means the case has never been decided, not that
          // the site is unprotected.
          vernetype: {
            'Automatisk fredet': 'Automatically protected (pre-1537)',
            Vedtaksfredet: 'Protected by decision',
            Forskriftsfredet: 'Protected by regulation',
            'Midlertidig fredet': 'Temporarily protected',
            'Ikke fredet': 'Not protected',
            Uavklart: 'Protection undecided',
          },
        },
        // Askeladden's sites are icons, and a tap has to land on the *point*
        // under one. Measured at Horten 2026-08-04: a query at z15's resolution
        // (~2 m/px) answered nothing from the middle of a drawn icon, z14
        // (~4.5 m/px, so ~14 m of tolerance) answered. The trade is deliberate
        // and one-directional — at z14 the outline layers are outside their
        // 1:25 000 band, so a tap answers from `Lokalitetsikoner`, which carries
        // the *locality* record (name, type, the surveyor's description, the
        // Kulturminnesøk link) rather than the single monument. The parent
        // record is a far better answer than the empty card it replaces.
        identifyZoom: 14,
      },
    },
    {
      // SEFRAK — the national survey of buildings standing before 1900 (1945 in
      // Finnmark and Nord-Troms), carried out by hand between the 1970s and the
      // 1990s. Askeladden's opposite number: not the archaeology under the
      // ground but the *building* that is still on it, which is why Curiosities
      // gets both. It is also the register that finally has the dating
      // Askeladden's WMS turned out not to publish — `tidsangivelsetekst` is a
      // quarter-century band ("1825-1849") on essentially every record.
      //
      // What makes it a curiosity rather than a building layer is the field
      // survey behind it: `opprinneligsosialtmiljotekst` says who the house was
      // built for ("Husmann, strandsitter" — a cottar), `fysiskmiljotekst` says
      // what it stood in ("Gardsanlegg, nedlagt, ute av bruk" — an abandoned
      // farm), and `sefrakstatustekst` will tell you the thing is a ruin or gone.
      meta: {
        id: 'old-buildings',
        rev: 2,
        title: 'Old buildings (pre-1900)',
        description:
          'Every building the SEFRAK survey recorded as standing before 1900. Tap for the quarter ' +
          'century it went up, who it was built for, and what it is built of.',
        group: 'History',
        attribution: '© Riksantikvaren',
        metadataUrl: `${KARTKATALOG}sefrak`,
        // The single `SEFRAKBygninger` layer is cut off at 1:100 000, i.e. z13
        // by the equator formula these servers actually use — measured at
        // Horten, where z12 is the 334 B empty tile and z13 draws 32.5 kB.
        minzoom: 13,
        maxzoom: 17,
        defaultOpacity: 0.9,
        identify: true,
        coverageNote:
          'A field survey from the 1970s–90s: some of these buildings have burned or been torn ' +
          'down since (the register says so when it knows), and being listed here is not ' +
          'protection — for a pre-1850 building it means the county must be told before it is ' +
          'altered.',
        profiles: ['curiosities'],
        // The register is 700 000 buildings and a town centre draws as a solid
        // block of them, so the chips are the difference between "old houses
        // exist here" and finding the one thing worth walking to.
        //
        // Every choice is a share of the register measured over 436 buildings
        // sampled from Agder to Trøndelag (2026-08-04), because a chip for a
        // class that is 1 % of the data is a chip that always looks broken:
        // registered without duty 50 %, ruins and vanished 35 %, pre-1850
        // 15 %; abandoned farms 16 % and abandoned summer pastures 19 % of
        // `fysiskmiljotekst`.
        options: [
          {
            key: 'kind',
            label: 'Show',
            defaultValue: 'all',
            choices: [
              {
                value: 'all',
                label: 'Everything',
                caption: 'Every building the survey recorded — dense in any old town centre.',
              },
              {
                value: 'pre1850',
                label: 'Pre-1850',
                caption:
                  'The §25 buildings: old enough that the county must be told before one is ' +
                  'altered or torn down.',
              },
              {
                value: 'ruins',
                label: 'Ruins & gone',
                caption:
                  'What the survey found standing and later recorded as a ruin or removed — a ' +
                  'map of what is no longer there.',
              },
              {
                value: 'abandoned',
                label: 'Abandoned farms & seters',
                caption:
                  'Farmsteads and mountain summer pastures the survey recorded as out of use — ' +
                  'the buildings at the end of the track.',
              },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.ra.no/wms/sefrak',
        version: '1.3.0',
        layers: 'SEFRAKBygninger',
        identifyLayers: 'SEFRAKBygninger',
        // MapServer's vendor FILTER, one per layer in LAYERS — and this service
        // applies it to GetFeatureInfo as well as GetMap, which is why the tap
        // needs no mirror filter of its own (see `optionParamsOnIdentify`).
        //
        // The literals are the register's own strings, verbatim; a typo here
        // filters to nothing rather than failing, so they are copied from a
        // live reply rather than from the code list.
        optionParams: {
          kind: {
            all: {},
            pre1850: { FILTER: sefrakFilter('sefrakstatustekst', [SEFRAK_PRE_1850]) },
            ruins: { FILTER: sefrakFilter('sefrakstatustekst', ['Ruin og fjernet objekt']) },
            abandoned: {
              FILTER: sefrakFilter('fysiskmiljotekst', [
                'Gardsanlegg, nedlagt, ute av bruk',
                'Seteranlegg, nedlagt, ute av bruk',
              ]),
            },
          },
        },
        optionParamsOnIdentify: true,
        // Ordered as the card, and the order is the whole design of this row:
        // what it is called, when it went up, whether it is even still there,
        // what it stood in, who it was for, what it is built of. `IDENTIFY_CARD_ROWS`
        // is six, so everything below `ytterveggtekst` only surfaces when one of
        // those is blank.
        //
        // The fields *not* here are as measured as the ones that are: probed
        // over 35 buildings from Horten to Tromsø on 2026-08-04, `fredning`,
        // `vernevedtak`, `kulturminneverneverdi`, `kulturminnehovedgruppe`,
        // `sefrakfunksjontekst`, `taktekkingtekst`, `endingsgrad`,
        // `bygningsendring` and `askeladdenid` are empty on **every** record
        // this WMS returns — an allow-list entry for a column the export never
        // populates is indistinguishable from a field that is merely rare.
        identifyFields: [
          'objektnavn',
          'tidsangivelsetekst',
          'sefrakstatustekst',
          'fysiskmiljotekst',
          'opprinneligsosialtmiljotekst',
          'ytterveggtekst',
          'bygningstypetekst',
          'takformtekst',
          'underbyggingskonstrtekst',
        ],
        identifyLabels: {
          objektnavn: 'Building',
          tidsangivelsetekst: 'Built',
          sefrakstatustekst: 'Register status',
          fysiskmiljotekst: 'Setting',
          opprinneligsosialtmiljotekst: 'Built for',
          ytterveggtekst: 'Walls',
          bygningstypetekst: 'Type',
          takformtekst: 'Roof',
          underbyggingskonstrtekst: 'Foundation',
        },
        // SEFRAK's own coded texts, sampled from the live service across 35
        // buildings in towns and farm country (2026-08-04) so the lists cover
        // what a tap actually returns. The vocabularies are long — Matrikkel's
        // building types alone run to a couple of hundred — so anything
        // unlisted reaches the reader in Norwegian, which is the right failure
        // for a register written by surveyors rather than a code list.
        identifyValues: {
          // The one row that answers "is there anything there?" — SEFRAK's
          // §25 class is also a legal fact about what may be done to it.
          sefrakstatustekst: {
            [SEFRAK_PRE_1850]: 'Pre-1850 — the county must be told before it is altered',
            'Annet SEFRAK-objekt': 'Recorded, no reporting duty',
            'Ruin og fjernet objekt': 'A ruin, or gone',
          },
          fysiskmiljotekst: {
            'Gardsanlegg med vanlig landbruksfunksjon': 'A working farm',
            'Gardsanlegg, nedlagt, ute av bruk': 'A farm, abandoned',
            'Naust, rorbu, utmarksløe, koie, bu o.l.':
              'Boathouse, fishing cabin, outlying barn or hut',
            'Sentralt bystrøk': 'Central town district',
            'Tettbebyggelse, boligstrøk': 'Built-up residential area',
          },
          // Who the house was for. The class list is the 1970s survey's own
          // reading of the social landscape, which is exactly why it is worth
          // showing rather than paraphrasing.
          opprinneligsosialtmiljotekst: {
            Bonde: 'A farmer',
            'Husmann, strandsitter': 'A cottar or shore-dweller',
            Arbeider: 'A labourer',
            'Håndverker, småindustridrivende': 'A craftsman or small industrialist',
            Næringsdrivende: 'A trader',
            'Næringsdrivende i handel og tjenesteyrker': 'A shop or service trade',
          },
          ytterveggtekst: {
            Lafteverk: 'Notched logs (laft)',
            Bindingsverk: 'Timber frame',
            Reisverk: 'Vertical post-and-plank (reisverk)',
            Sleppekonstruksjon: 'Planks slotted into posts (sleppverk)',
            'Mur av teglstein': 'Brick',
            'Annen ytterveggskonstruksjon i tre, se merknad': 'Other timber construction',
            'Annen type massiv steinmur, se merknad': 'Other solid stone wall',
          },
          takformtekst: {
            'Vanlig saltak': 'Plain gable',
            Halvvalmtak: 'Half-hipped',
            'Valmtak m.v.': 'Hipped',
            Pulttak: 'Mono-pitch',
            Mansardtak: 'Mansard',
            'Flatt tak': 'Flat',
          },
          bygningstypetekst: {
            Enebolig: 'Detached house',
            'Tomannsbolig, horisontaldelt': 'Two-flat house',
            'Garasje, uthus, anneks til bolig': 'Garage, outhouse or annex',
            'Garasje, uthus, anneks til fritidbolig': 'Outhouse or annex to a holiday cabin',
            'Annen landbruksbygning': 'Other farm building',
            Butikkbygning: 'Shop',
            'Restaurantbygning, kafébygning': 'Restaurant or café',
            'Kontor- og administrasjonsbygning, rådhus': 'Office building or town hall',
            'Andre småhus med 3 boliger eller flere': 'Small block, three dwellings or more',
            'Store sammenbygde boligbygg på 3 og 4 etg': 'Terraced housing, three to four storeys',
          },
          underbyggingskonstrtekst: {
            'Grunnmur. Naturstein uten bindemiddel (tørrmur)': 'Dry-stone footing',
            'Grunnmur. Naturstein med bindemiddel, fuget': 'Mortared stone footing',
            'Grunnmur. Naturstein med bindemiddel, pusset, kalket e.l.':
              'Rendered or limewashed stone footing',
            'Grunnmur. Teglstein, fuget': 'Brick footing',
            'Grunnmur. Betong': 'Concrete footing',
            'Punktvis bæring. Stående trepeler (stabber e.l.)':
              'Standing on timber piers (stabbur)',
          },
        },
        // Buildings sit metres apart in a town, so this is the one register in
        // the profile whose tap must stay *narrow*: measured over 35 buildings,
        // a query at z16 answers 8/8 with 1.4 buildings in the reply, while z14
        // answers with five — three cards spent on the neighbours. z16 is a ~7 m
        // radius, and the footprints are drawn from z13 anyway.
        identifyZoom: 16,
      },
    },
    {
      // Old mines. The dataset behind Direktoratet for mineralforvaltning's
      // *Aktsomhetskart for gamle gruver*: secured shafts and the caution zones
      // around them.
      //
      // Geonorge still advertises the old ArcGIS endpoint
      // (kart.dirmin.no/dirmin/services/GruvesikringsregisterBeta), which now
      // answers 404 with "Use https://dirmin.no/data" — the live service is the
      // QGIS server below, found through that page rather than the catalogue.
      meta: {
        id: 'old-mines',
        rev: 2,
        title: 'Old mines',
        description:
          'Caution zones around old mine workings and trial pits, from the national mine-safety ' +
          'register. Tap for the working’s name.',
        group: 'History',
        attribution: '© Direktoratet for mineralforvaltning',
        metadataUrl: `${KARTKATALOG}gamle%20gruver`,
        minzoom: 10,
        maxzoom: 17,
        defaultOpacity: 0.85,
        identify: true,
        coverageNote:
          'Registered workings only — Norway has thousands of unrecorded shafts and adits, so ' +
          'blank ground is not proof of safe ground. An open shaft is a fall hazard whatever ' +
          'the map says.',
        profiles: ['curiosities'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://dirmin.no/kart/server/',
        version: '1.3.0',
        // `Sikringer` is a *group* whose only child is `Aktsomhetssone`
        // (GetCapabilities, 2026-08-04), so naming both drew the same polygons
        // twice and answered a tap with two identical rows — half a card spent
        // saying one thing.
        layers: 'Sikringer',
        identifyLayers: 'Sikringer',
        // `Sikringstype` is deliberately gone: it reads "Aktsomhetssone" on
        // every feature in the register, which is the layer's own name repeated
        // back at the reader. The name is the answer here — "Hostvedt skjerp"
        // is a searchable, findable thing.
        identifyFields: ['Sikringsnavn', 'Kommunenavn'],
        identifyLabels: {
          Sikringsnavn: 'Working',
          Kommunenavn: 'Municipality',
        },
        // Small polygons around points: a tap needs ground radius, not pixels.
        identifyZoom: 14,
      },
    },
    {
      // Wrecks and seabed obstructions from the nautical charts. The layer that
      // makes a fjord read as a graveyard: `dybde` is how deep it lies, which
      // is the difference between a diveable wreck and a chart symbol.
      meta: {
        id: 'wrecks',
        rev: 2,
        title: 'Wrecks & obstructions',
        description: 'Charted wrecks and seabed obstructions, with the depth each one lies at.',
        group: 'History',
        attribution: '© Kartverket',
        metadataUrl: `${KARTKATALOG}vrak%20og%20hefter`,
        // `hefte`/`vrak_p` stop at 1:1 M (z10); the wreck areas at 1:100 000.
        minzoom: 10,
        maxzoom: 17,
        defaultOpacity: 1,
        identify: true,
        coverageNote:
          'Charted hazards to navigation, not an archaeological inventory — wrecks that endanger ' +
          'nothing may never have been charted. Wrecks over 100 years old are protected by law.',
        profiles: ['curiosities'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.vrak_hefter',
        version: '1.3.0',
        layers: 'hefte,vrak_a,vrak_p',
        identifyLayers: 'vrak_p,vrak_a,hefte',
        // `objtype` is on the generic noise list (every SOSI dataset carries
        // one), and being *named here* is what rescues it — see NOISE_KEYS.
        // Until v0.145.0 it was silently dropped before the card was built, so
        // a tap on the average unnamed wreck answered with a bare "Depth: 47"
        // and no word for what was down there.
        identifyFields: ['objektnavnnorsk', 'objtype', 'vraktype', 'dybde'],
        identifyLabels: {
          objektnavnnorsk: 'Name',
          objtype: 'Type',
          vraktype: 'Hazard',
          dybde: 'Depth (m)',
        },
        identifyValues: {
          // Kartverket's SOSI spelling, which reaches the reader as raw
          // camelCase without this. Most wrecks carry no name at all, so these
          // two lines are often the entire answer.
          objtype: { Vrak: 'Wreck', HefteUrenBunn: 'Foul ground', Hefte: 'Obstruction' },
          vraktype: {
            farligVrak: 'Dangerous to navigation',
            ikkeFarligVrak: 'Not dangerous to navigation',
          },
        },
        // Chart symbols on open water: a metre-accurate tap is not a thing
        // anyone does from a boat, and there is nothing else out there to
        // confuse the answer with.
        identifyZoom: 13,
      },
    },
    {
      // NGU's geological heritage register (*geosteder*) — Norway's karst and
      // cave landscapes, glacial features, classic outcrops. The nearest thing
      // to a national cave layer: there is **no** standalone karst or cave WMS
      // in Geonorge (probed 2026-08-03, every NGU Karst*/Grotte* endpoint 404s),
      // so caves come from here plus OSM `natural=cave_entrance` in the outdoor
      // overlay, which is also the only half that works outside Norway.
      meta: {
        id: 'geoheritage',
        rev: 1,
        title: 'Geological heritage',
        description:
          'Karst and caves, glacial landforms and classic outcrops from NGU’s geosite register. ' +
          'Tap for the site’s fact sheet.',
        group: 'Geology',
        attribution: '© NGU',
        metadataUrl: `${KARTKATALOG}geologisk%20arv`,
        maxzoom: 16,
        defaultOpacity: 0.85,
        identify: true,
        coverageNote:
          'A curated register of sites judged worth protecting — not a survey of every cave or ' +
          'landform. A cave entrance is a hazard, not a marked route.',
        profiles: ['curiosities'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://geo.ngu.no/mapserver/GeologiskarvWMS2',
        version: '1.3.0',
        // Three scale bands of one dataset: the overview above 1:262 500 (z11
        // and out), the areas and points below it. Listing all three is what
        // keeps the layer from disappearing mid-zoom.
        layers: 'Geosted_oversikt,Geosted_areal,Geosted_punkt',
        identifyLayers: 'Geosted_punkt,Geosted_areal,Geosted_oversikt',
        identifyFields: ['geosted_navn', 'omradenavn', 'geostedtype_tekst', 'faktaark_url'],
        identifyLabels: {
          geosted_navn: 'Site',
          omradenavn: 'Area',
          geostedtype_tekst: 'Register status',
          faktaark_url: 'Fact sheet',
        },
        // NGU's three register tracks, in their own words. Each `Geosted_*`
        // layer has a `_historiske_verneforslag` and an `_uten_verdivurdering`
        // sibling and the group answers for all of them, so a tap really does
        // return these three strings — untranslated, "Historiske verneforslag"
        // is the whole answer for a site on Hovedøya.
        identifyValues: {
          geostedtype_tekst: {
            Geosteder: 'Assessed geosite',
            'Historiske verneforslag': 'Historic conservation proposal',
            'Uten verdivurdering': 'Registered, not yet assessed',
          },
        },
        // Point and small-area sites in a curated national register: nothing
        // near enough to confuse, and the fact sheet is worth reaching.
        identifyZoom: 13,
      },
    },
    {
      // NGU's national ore register: every place metal has been found in
      // Norwegian bedrock, from a noted showing in a road cut to Kongsberg's
      // silver and Løkken's copper. The question it answers is the oldest one
      // there is about a hill — *what is in it, and did anyone dig for it* — and
      // no other row in the catalog says a word about it: `old-mines` maps the
      // safety zones DMF has secured, which is the aftermath, not the ore.
      //
      // The register writes its own English, which is why this row carries no
      // metal dictionary: `websub_etext` is already "Silver", "Zinc", "Gold".
      meta: {
        id: 'metal-deposits',
        rev: 1,
        title: 'Metals in the ground',
        description:
          'Where gold, silver, copper and iron have been found in the bedrock, from NGU’s national ' +
          'ore register. Tap for the metal, the deposit’s name and whether anyone ever worked it.',
        group: 'Geology',
        attribution: '© NGU',
        metadataUrl: `${KARTKATALOG}metaller`,
        // No floor: the chip's own layers draw at every scale, and the default
        // pair covers the whole range between them (see `layers`).
        maxzoom: 15,
        defaultOpacity: 0.9,
        identify: true,
        coverageNote:
          'Overwhelmingly *showings*, not mines: 24 of the 26 points sampled are a registered ' +
          'occurrence somebody noted, and the register grades importance as “not assessed” on most ' +
          'of them. Finding metal here is not permission to dig for it — the metals are the ' +
          'state’s to license and the ground is the landowner’s.',
        profiles: ['curiosities'],
        // The chip is the point of the row: "all metals" over southern Norway is
        // 26 476 lit pixels of copper against gold's 2 156, so the question
        // "where is the gold" is unanswerable on the combined layer. Each choice
        // is a separate NGU layer rather than a filter, so a chip is a different
        // map and not a thinner one.
        options: [
          {
            key: 'metal',
            label: 'Metal',
            defaultValue: 'all',
            choices: [
              {
                value: 'all',
                label: 'All metals',
                caption: 'Every registered occurrence, whatever the metal.',
              },
              {
                value: 'gold',
                label: 'Gold',
                caption: 'Gold showings and deposits — Bidjovagge, Bømlo, the Eidsvoll field.',
              },
              {
                value: 'silver',
                label: 'Silver',
                caption: 'Silver, the metal Kongsberg was built on.',
              },
              {
                value: 'base',
                label: 'Copper & zinc',
                caption:
                  'The base metals — copper, zinc, lead, tin — which is most of what Norway ' +
                  'actually mined.',
              },
              {
                value: 'iron',
                label: 'Iron',
                caption: 'Iron and iron-titanium ore, from bog iron country to Sydvaranger.',
              },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://geo.ngu.no/mapserver/MetallerWMS2',
        version: '1.3.0',
        // Two scale bands of one dataset, the contours pattern: `Punkt_Metaller`
        // is cut off *above* 1:1.5 M and `Forekomster_zoom` only draws above it,
        // so naming one alone leaves the layer empty at half the zooms —
        // measured at Trondheim, the points are the 334 B empty tile at z8 and
        // the overview is empty from z9 in.
        layers: 'Forekomster_zoom,Punkt_Metaller',
        identifyLayers: 'Punkt_Metaller,Forekomster_zoom',
        // The per-metal layers have no scale band at all, so one name covers
        // every zoom. `Basemetaller_samlet` and its siblings are the *leaf*
        // that holds the whole group: MapServer publishes a group named
        // `Basemetaller` containing a child of the same name, and asking for
        // the group draws each metal's symbols on top of the combined set
        // (13 489 lit pixels against 10 426) and answers one tap three times.
        optionParams: {
          metal: {
            all: { LAYERS: 'Forekomster_zoom,Punkt_Metaller' },
            gold: { LAYERS: 'Gull' },
            silver: { LAYERS: 'Solv' },
            base: { LAYERS: 'Basemetaller_samlet' },
            iron: { LAYERS: 'Jernmetaller_samlet' },
          },
        },
        optionIdentifyLayers: {
          metal: {
            all: 'Punkt_Metaller,Forekomster_zoom',
            gold: 'Gull',
            silver: 'Solv',
            base: 'Basemetaller_samlet',
            iron: 'Jernmetaller_samlet',
          },
        },
        // The union of two schemas, because the sub-layers do not agree on how
        // they say the same thing: the point layers carry
        // `mineralregistreringtype` (registrering / forekomst / prospekt) while
        // the per-metal ones carry `objtype` (MalmRegistrering / MalmForekomst),
        // and a card that listed only one would go blank on half the chips.
        //
        // `objtype` is on the generic noise list and is rescued by being named
        // here (see NOISE_KEYS) — the same trap the wrecks row hit.
        identifyFields: [
          'name',
          'websub_etext',
          'mineralregistreringtype',
          'objtype',
          'raastoffbetydning',
          'webcom_etext',
        ],
        identifyLabels: {
          name: 'Deposit',
          websub_etext: 'Metal',
          mineralregistreringtype: 'Register class',
          objtype: 'Register class',
          raastoffbetydning: 'Importance',
          webcom_etext: 'Metal group',
        },
        identifyValues: {
          // NGU's three-step register class, in both its spellings. The
          // distinction is the difference between "somebody noticed ore here"
          // and "this was a mine", which is the first thing a reader wants.
          mineralregistreringtype: {
            registrering: 'A noted showing',
            prospekt: 'A prospect — investigated, not worked',
            forekomst: 'A deposit — mapped, drilled or mined',
          },
          objtype: {
            MalmRegistrering: 'A noted showing',
            MalmProspekt: 'A prospect — investigated, not worked',
            MalmForekomst: 'A deposit — mapped, drilled or mined',
          },
          // NGU's own grading of what the occurrence is worth. "Not assessed"
          // is the answer on three quarters of the register and is kept rather
          // than blanked: it means nobody has judged it, not that it is worth
          // nothing.
          raastoffbetydning: {
            ikkeVurdert: 'Not assessed',
            litenLokalBetydning: 'Minor, local',
            regionalBetydning: 'Regional',
            nasjonalBetydning: 'National',
            internasjonalBetydning: 'International',
          },
        },
        // Single point symbols in a national register, and they cluster: from
        // sample points up to ~35 m off the true position, z12 answered 12/12
        // and z13 10/12, both with exactly one deposit in the reply. z12 is
        // ~115 m of tolerance, which is what a symbol on open fjell needs.
        identifyZoom: 12,
      },
    },
    {
      // Norway's glaciers, and the three things they leave behind: the outline
      // they used to have, the archaeology melting out of them, and the floods
      // that come out from under them.
      //
      // NVE's glacier database is the rare register that carries its own
      // history — 6 743 glacier units surveyed from Sentinel-2 in 2018–19, and
      // 17 306 historical outlines going back to an 1895–1907 survey (counts
      // read off the REST layers 2026-08-04). Drawing the old outline under the
      // new one is a picture of retreat that needs no chart, which is why the
      // chips are epochs rather than styles.
      meta: {
        id: 'glaciers',
        rev: 1,
        title: 'Glaciers & ice',
        description:
          'Every mapped glacier with its name, area and height range — plus the outlines they ' +
          'had a century ago, the ice patches archaeology is melting out of, and the outburst ' +
          'floods on record.',
        group: 'Terrain',
        attribution: '© NVE',
        metadataUrl: `${KARTKATALOG}breer`,
        // `Breflate` is drawn from 1:5 120 000 in (≈z7); the archaeology points
        // from 1:20 480 000, so the floor is the surface layer's.
        minzoom: 7,
        maxzoom: 16,
        defaultOpacity: 0.75,
        identify: true,
        coverageNote:
          'Glacier outlines are a snapshot of the summer they were photographed (2018–19 for the ' +
          'current set) — ice has moved since. Outburst floods are the ones somebody recorded, ' +
          'and an ice patch with finds is a protected site: report what you see, take nothing.',
        profiles: ['curiosities'],
        options: [
          {
            key: 'era',
            label: 'Show',
            defaultValue: 'now',
            choices: [
              {
                value: 'now',
                label: 'Today',
                caption: 'The current outlines, surveyed from satellite imagery in 2018–19.',
              },
              {
                value: 'then',
                label: 'Then & now',
                caption:
                  'A century of older surveys under today’s ice — where the old outline sticks ' +
                  'out, that ground is bare now.',
              },
              {
                value: 'finds',
                label: 'Melting archaeology',
                caption:
                  'The 51 ice patches with active archaeological finds — arrows, hunting gear ' +
                  'and clothing have come out of these as the ice went.',
              },
              {
                value: 'floods',
                label: 'Outburst floods',
                caption:
                  '185 recorded jøkulhlaups: the date, the volume and what happened downstream.',
              },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.nve.no/enterprise/services/Bre2/MapServer/WMSServer',
        version: '1.3.0',
        layers: 'Breflate',
        identifyLayers: 'Breflate',
        // Today's ice stays drawn under every chip — an outburst-flood dot in
        // the middle of nothing tells a reader neither where the glacier is nor
        // which way the water went.
        optionParams: {
          era: {
            now: { LAYERS: 'Breflate' },
            then: { LAYERS: 'Breflate_Historisk,Breflate' },
            finds: { LAYERS: 'Breflate,Arkeologiske_funn' },
            floods: { LAYERS: 'Breflate,Jokullaup' },
          },
        },
        // Points before polygons, so a tap that hits both answers with the
        // event rather than with the ice it happened on.
        optionIdentifyLayers: {
          era: {
            now: 'Breflate',
            then: 'Breflate,Breflate_Historisk',
            finds: 'Arkeologiske_funn,Breflate',
            floods: 'Jokullaup,Breflate',
          },
        },
        // The union of four feature types, most specific first — the flood's
        // own story, then the ice-patch flag, then the glacier itself. Keys are
        // ArcGIS *aliases* (`hendelseDato`, `aktivFunn`, `maksHoyde`), which is
        // what the text/xml dialect emits.
        //
        // `objektType` leads because it is the row that says *which* of the four
        // things the tap found; without it a historic outline and today's ice
        // are two cards with the same fields and no way to tell them apart.
        identifyFields: [
          'objektType',
          'navn',
          'aar',
          'volum',
          'beskrivelse',
          'konsekvenser',
          'aktivFunn',
          'BRENAVN',
          'HOVEDBRENAVN',
          'breType',
          'AREAL_KM2',
          'lengde_m',
          'maksHoyde',
          'minHoyde',
          'produktID',
        ],
        identifyLabels: {
          objektType: 'What',
          navn: 'Name',
          aar: 'Year',
          volum: 'Volume (mill. m³)',
          beskrivelse: 'What happened',
          konsekvenser: 'Consequences',
          aktivFunn: 'Archaeology',
          BRENAVN: 'Glacier',
          HOVEDBRENAVN: 'Part of',
          breType: 'Type',
          AREAL_KM2: 'Area (km²)',
          lengde_m: 'Length (m)',
          maksHoyde: 'Top (m)',
          minHoyde: 'Bottom (m)',
          produktID: 'Surveyed',
        },
        // The outline areas are computed, and published to six decimals — the
        // first of which is already an argument about where the ice ends.
        identifyFormats: { AREAL_KM2: 'number', volum: 'number' },
        identifyValues: {
          // NVE's own object types, and the ice-patch layer's is the surprise:
          // it answers `Brepunkt`, the generic "glacier point", because the
          // archaeology flag lives in `aktivFunn` rather than in the type.
          objektType: {
            Breflate: 'Glacier, as mapped today',
            SnøIsbre: 'Glacier, an older survey',
            Jokulhlaup: 'Glacier outburst flood',
            Brepunkt: 'Ice patch with archaeological finds',
          },
          // The register's coded glacier types, decoded by the WMS itself —
          // these are the strings it emits, not the integers behind them.
          breType: {
            Innlandsis: 'Ice cap',
            Platåbre: 'Plateau glacier',
            Dalbre: 'Valley glacier',
            Botnbre: 'Cirque glacier',
            Piedmontbre: 'Piedmont glacier',
            Steinbre: 'Rock glacier',
            'Usikker eller vanskelig klassifiserbar type': '',
          },
          aktivFunn: { '1': 'Finds have come out of this ice' },
          // A snowfield the register carries at 0 km² is one it could not
          // measure, not one with no area; the row is noise either way.
          AREAL_KM2: { '0': '' },
          // The survey epochs, which is the whole point of the "then & now"
          // chip. Every value the two layers hold (2026-08-04); anything NVE
          // adds later passes through as its raw code rather than vanishing.
          produktID: {
            '2018_2019': '2018–2019, from satellite',
            '1999_2006': '1999–2006',
            '1988_1997': '1988–1997',
            '1952_1985': '1952–1985',
            '1947_1985': '1947–1985, the old glacier atlas',
            '1895_1907': '1895–1907, the first survey',
          },
        },
        // Polygons for the ice, but the two event layers are single points in
        // high mountains — the same reason every point register here has a cap.
        identifyZoom: 13,
      },
    },
    {
      // The seabed where gas escapes it: pockmark fields, seeps, blowout
      // craters, mud volcanoes and mud diapirs, from MAREANO's shallow-gas
      // mapping. Gloriously obscure, which is the point of the profile.
      //
      // Drawn as the two *group* layers rather than `Leirvulkan` alone, which
      // is what shipped in v0.143.0: measured 2026-08-04, mud volcanoes are 23
      // lit pixels in a national sweep — one site on the Vøring plateau — so
      // the layer was a switched-on overlay with nothing in it anywhere a user
      // would look. `GrunnGass` is Leirvulkan's own parent (GetCapabilities) and
      // brings the pockmarks with it: 7 140 px in the same sweep, all sharing
      // one attribute schema, so the tap is unchanged.
      meta: {
        id: 'seabed-gas',
        rev: 1,
        title: 'Seabed gas & pockmarks',
        description:
          'Where gas escapes the seabed: pockmark fields, seeps, blowout craters, mud volcanoes ' +
          'and mud diapirs.',
        group: 'Geology',
        attribution: '© NGU / MAREANO',
        metadataUrl: `${KARTKATALOG}marine%20geofarer`,
        maxzoom: 13,
        defaultOpacity: 0.9,
        identify: true,
        coverageNote:
          'Offshore only, and only where MAREANO has surveyed — most of the shelf is unmapped, ' +
          'and nothing on land will ever appear here.',
        profiles: ['curiosities'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://geo.ngu.no/mapserver/MarinGeofarerWMS',
        version: '1.3.0',
        layers: 'GrunnGass,Diapirer',
        identifyLayers: 'GrunnGass,Diapirer',
        identifyFields: ['GrunnGassNavn', 'MediumNavn', 'Dato'],
        identifyLabels: {
          GrunnGassNavn: 'Feature',
          MediumNavn: 'Setting',
          Dato: 'Mapped',
        },
        // NGU's own class names for what the tap found. The list is the classes
        // measured on the live service; anything they add later falls through
        // in Norwegian rather than disappearing.
        identifyValues: {
          GrunnGassNavn: {
            Leirvulkan: 'Mud volcano',
            'Gass/væske utslipp': 'Gas or fluid seep',
            'Område med pockmarks': 'Pockmark field',
            'Utblåsningskrater (under sjøbunnen)': 'Buried blowout crater',
            'Grunn gass i berggrunn': 'Shallow gas in bedrock',
            'Grunn gass i sedimenter': 'Shallow gas in sediments',
          },
          MediumNavn: {
            'På sjøbunnen': 'On the seabed',
            'Under sjøbunnen': 'Below the seabed',
          },
        },
        // Small polygons in deep water, and the map is never zoomed in far out
        // here anyway (maxzoom 13).
        identifyZoom: 12,
      },
    },
    {
      // GRANADA, NGU's national groundwater database: drilled wells and natural
      // springs. A spring is drinking water on a ridge with no stream; a well
      // is evidence of a farm that may no longer be there.
      meta: {
        id: 'groundwater-wells',
        rev: 2,
        title: 'Wells & springs',
        description:
          'Natural springs and drilled wells from the national groundwater database. Tap for ' +
          'what a well is used for and what it is drilled into.',
        group: 'Water & depth',
        attribution: '© NGU',
        metadataUrl: `${KARTKATALOG}granada`,
        // Point layers cut off at 1:525 000. The coarser national/regional
        // density bands above that are deliberately left out — at that scale
        // they cover half the country in symbols and answer nothing.
        minzoom: 11,
        maxzoom: 17,
        defaultOpacity: 0.9,
        identify: true,
        coverageNote:
          'Reported wells and springs — reporting is patchy and a mapped spring is not tested ' +
          'drinking water.',
        profiles: ['curiosities'],
        // Everything by default, and each kind reachable on its own.
        //
        // v0.145.0 defaulted this to springs alone, for a real reason: GRANADA's
        // boreholes are dominated by suburban ground-source heat wells, and a
        // national sweep over Romerike drew 270 235 borehole pixels against
        // 1 507 spring ones, so springs are genuinely buried in the full layer.
        // But that default *removed* the register's other half from the map
        // altogether — a dug well is evidence of a farm that may no longer be
        // there, which is precisely what this profile is for — and the way to
        // find something in a crowded layer is a filter, not a smaller layer.
        // So the whole register draws, and the chips take it apart: the four
        // choices are separate GRANADA layers rather than nested supersets, so
        // "Energy wells" is a different map and not just a thinner one.
        options: [
          {
            key: 'kind',
            label: 'Show',
            defaultValue: 'all',
            choices: [
              {
                value: 'all',
                label: 'Everything',
                caption:
                  'Every reported spring and borehole, energy wells included — dense in any ' +
                  'built-up area.',
              },
              {
                value: 'water',
                label: 'Water sources',
                caption:
                  'Springs and the wells drilled for water supply — what you could drink from, ' +
                  'without the heat-pump wells.',
              },
              {
                value: 'springs',
                label: 'Springs only',
                caption:
                  'Natural springs — water coming out of the ground on its own, often on a ridge ' +
                  'with no stream.',
              },
              {
                value: 'energy',
                label: 'Energy wells',
                caption:
                  'Ground-source heat boreholes only — the suburban half of the register, and a ' +
                  'map of where the register is dense at all.',
              },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://geo.ngu.no/mapserver/GranadaWMS5',
        version: '1.3.0',
        layers: 'Grunnvannsoppkomme',
        identifyLayers: 'Grunnvannsoppkomme',
        // GRANADA publishes the well types as separate layers, so the chip is a
        // LAYERS rewrite — and QUERY_LAYERS has to move with it, or a tap in a
        // suburb answers "energy well" over a map showing only springs.
        //
        // `Grunnvannsborehull` is the whole borehole set, not a group layer with
        // children (GetCapabilities is flat here): measured over Romerike it
        // draws 22 465 px against Energibrønn's 16 207 and Brønn-vannforsyning's
        // 8 358, so it is their union and naming it alongside them would answer
        // one tap three times.
        optionParams: {
          kind: {
            all: { LAYERS: 'Grunnvannsborehull,Grunnvannsoppkomme' },
            water: { LAYERS: 'Bronn_vannforsyning,Grunnvannsoppkomme' },
            springs: { LAYERS: 'Grunnvannsoppkomme' },
            energy: { LAYERS: 'Energibronn' },
          },
        },
        optionIdentifyLayers: {
          kind: {
            all: 'Grunnvannsborehull,Grunnvannsoppkomme',
            water: 'Bronn_vannforsyning,Grunnvannsoppkomme',
            springs: 'Grunnvannsoppkomme',
            energy: 'Energibronn',
          },
        },
        // The union of the two schemas, and the whole reason this row was
        // rewritten: a spring answers `nummer`/`bruk`/`geolmedium` while a
        // borehole answers `broenn_nr`/`brukstype`/`bronn_type`, so the
        // borehole-only allow-list this shipped with dropped every field a
        // spring has — the tap on a star returned a card with nothing on it.
        // Substance before bookkeeping: what the water comes out of, then what
        // it is used for, then the register number — which is also the row that
        // says *which* of the two things you tapped, since a spring is numbered
        // `nummer` and a borehole `broenn_nr`.
        identifyFields: ['geolmedium', 'bronn_type', 'brukstype', 'bruk', 'nummer', 'broenn_nr'],
        identifyLabels: {
          bruk: 'Use',
          geolmedium: 'Water from',
          brukstype: 'Use',
          bronn_type: 'Type',
          nummer: 'Spring no.',
          broenn_nr: 'Well no.',
        },
        // NGU's own vocabulary. "Ukjent" is kept rather than blanked: on a
        // spring it is usually the *only* thing the record says, and an empty
        // card is what this layer is being fixed for.
        identifyValues: {
          bruk: {
            Ukjent: 'Not recorded',
            Vannforsyning: 'Water supply',
            Drikkevann: 'Drinking water',
            Overvåking: 'Monitoring',
          },
          geolmedium: { Løsmasse: 'Sediment', Fjell: 'Bedrock' },
          // `Undersøkelse` was measured only once the default chip started
          // drawing the whole register (v0.146.0): 18 of 40 sampled boreholes
          // answer with it, second only to `Energi`, and it had been reaching
          // the reader as a bare Norwegian word all along — the springs-only
          // default meant no tap ever returned it.
          brukstype: {
            Energi: 'Ground-source heat',
            Vannforsyning: 'Water supply',
            Undersøkelse: 'Investigation bore',
            Grunnundersøkelse: 'Ground survey',
            Ukjent: 'Not recorded',
            Overvåking: 'Monitoring',
          },
          bronn_type: {
            Fjellbrønn: 'Drilled into bedrock',
            Løsmassebrønn: 'Drilled into sediment',
            Sonderboring: 'Test bore',
          },
        },
        // Point symbols, and the measurement that started this: from the middle
        // of a drawn spring star, GRANADA answered nothing until the query was
        // ~50 m wide. z13 is ~30 m at these latitudes and still names one
        // spring rather than the hillside.
        identifyZoom: 13,
      },
    },
    {
      // NVE's registry of *observed* landslides and avalanches — where one has
      // actually come down, with the date. Offered in Ski as well as
      // Curiosities: "has this slope run before?" is a tour-planning question,
      // and this is the only layer in the catalog that answers it.
      meta: {
        id: 'landslide-events',
        rev: 1,
        title: 'Landslide & avalanche history',
        description:
          'Recorded slide events — snow, rock, debris and quick clay — with release and runout ' +
          'areas and the date each one happened.',
        group: 'Hazards',
        attribution: '© NVE',
        metadataUrl: `${KARTKATALOG}skredhendelser`,
        maxzoom: 16,
        defaultOpacity: 0.8,
        identify: true,
        coverageNote:
          'Events somebody reported, not every slide that has happened. Blank ground means ' +
          'nothing was recorded — never that a slope is safe. Release and runout outlines draw ' +
          'from z13; the typed points draw at every zoom.',
        profiles: ['curiosities', 'ski'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.nve.no/enterprise/services/Skredhendelser1/MapServer/WMSServer',
        version: '1.3.0',
        // Outlines under, typed points over. `Skredtype` is the same event set
        // symbolized by slide type with no scale floor, so it carries the layer
        // above z13 where the two area layers stop drawing.
        layers: 'Skredhendelse_UtlopsOmrade,Skredhendelse_UtlosningsOmrade,Skredtype',
        identifyLayers: 'Skredtype,Skredhendelse_UtlosningsOmrade,Skredhendelse_UtlopsOmrade',
        // Measured against a real event (Våga, Samnanger, 2015): `beskrivelse`
        // is the observer's account of what came down and how far, which is the
        // whole reason to tap a historic slide, and `stedsnavn` names the
        // slope. Both were missing. `utlosningArsak` is gone the other way —
        // the layer has no such field, so it was an allow-list entry that could
        // never match anything.
        identifyFields: [
          'skredType',
          'skredTidspunkt',
          'skredNavn',
          'stedsnavn',
          'totAntPersOmkommet',
          'beskrivelse',
          'objektType',
        ],
        identifyLabels: {
          skredType: 'Slide type',
          skredTidspunkt: 'Happened',
          skredNavn: 'Name',
          stedsnavn: 'Place',
          totAntPersOmkommet: 'Lives lost',
          beskrivelse: 'Account',
          objektType: 'Record',
        },
        identifyValues: {
          // NVE's Norwegian type names. The distinctions are real and the
          // English words are not interchangeable — a sørpeskred behaves
          // nothing like a snøskred — so each is translated, not grouped.
          //
          // The register also uses ", uspesifisert" subtypes ("Steinskred,
          // uspesifisert"), which is what a real tap returns, so those spellings
          // are listed too — an exact-match table that only knew the bare word
          // silently showed the Norwegian.
          skredType: {
            Snøskred: 'Snow avalanche',
            'Snøskred, uspesifisert': 'Snow avalanche',
            Sørpeskred: 'Slushflow',
            Steinsprang: 'Rockfall',
            Steinskred: 'Rockslide',
            'Steinskred, uspesifisert': 'Rockslide',
            Fjellskred: 'Rock avalanche',
            Jordskred: 'Soil slide',
            'Jord- og flomskred, uspesifisert': 'Soil or debris slide',
            Flomskred: 'Debris flow',
            Kvikkleireskred: 'Quick-clay slide',
            Isnedfall: 'Ice fall',
            'Skred, uspesifisert': 'Slide, type not recorded',
          },
          // Two layers answer through this one field: the polygons say which
          // half of the slide you tapped, the typed points say what kind of
          // record it is. Untranslated, the point half reads
          // "SkredObsHistorisk" at the reader.
          objektType: {
            Utlop: 'Runout area',
            Utlosning: 'Release area',
            SkredObsHistorisk: 'Historic record',
            SkredObs: 'Field observation',
            SkredHendelse: 'Reported event',
          },
        },
        // ArcGIS answers `3/10/2015 7:57:00 AM`, which a Norwegian reader will
        // read as 3 October at best.
        identifyFormats: { skredTidspunkt: 'esri-datetime' },
        // The typed points are single symbols; the outlines stop drawing (and
        // answering) below 1:75 596, i.e. above z13, so this is also where both
        // halves of the layer can answer at once.
        identifyZoom: 13,
      },
    },
    {
      // The modelled twin of the layer above: where rockfall *could* reach,
      // from NVE's national terrain-model run. Distinct from the event registry
      // in the way that matters — this one has no gaps because nobody happened
      // to report a fall.
      meta: {
        id: 'rockfall-hazard',
        rev: 1,
        title: 'Rockfall zones',
        description:
          'Modelled rockfall release and runout zones from NVE’s national terrain analysis.',
        group: 'Hazards',
        attribution: '© NVE',
        metadataUrl: `${KARTKATALOG}steinsprang%20aktsomhet`,
        maxzoom: 17,
        // Wall-to-wall polygons under every cliff in the country: at full
        // strength they erase the terrain the zones are drawn *for*.
        defaultOpacity: 0.45,
        identify: true,
        coverageNote:
          'A model over the terrain model, at national resolution — advisory for planning, never ' +
          'a substitute for looking up at the slope you are under.',
        profiles: ['curiosities', 'ski'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.nve.no/enterprise/services/SkredSteinAktR/MapServer/WMSServer',
        version: '1.3.0',
        // Two scale bands, and they do not overlap: the generalized group layer
        // owns 1:37 799 and out (z13 and coarser), the detailed pair owns
        // everything closer. Either one alone is an overlay that empties itself
        // at some zoom the user will reach.
        layers: 'Steinsprang-AktsomhetOmrader,Utlopsomrade,Utlosningsomrade',
        identifyLayers: 'Utlosningsomrade,Utlopsomrade',
        identifyFields: ['skredtype', 'objType', 'temaKval'],
        identifyLabels: {
          skredtype: 'Hazard',
          objType: 'Zone',
          temaKval: 'Data quality',
        },
        identifyValues: {
          objType: { UtlopOmr: 'Runout zone', UtlosningOmr: 'Release zone' },
        },
      },
    },
    {
      // Artskart's alien-species observations, split by the Norwegian risk
      // assessment (SE severe → NK no known risk). An ecological invasion map.
      //
      // The tap works, and finding out why it did not is the story of this row.
      // v0.143.0 shipped it `identify: false` after every QUERY_LAYERS value
      // faulted; re-probed 2026-08-04, the service answers *only* in
      // text/plain. Its GML reply is a well-formed empty document, which the
      // format chain reads as "this format works, nothing here" and stops on —
      // so the dialect that had the answer was three formats further down and
      // never reached. `identifyInfoFormats` pins it.
      meta: {
        id: 'alien-species',
        rev: 2,
        title: 'Alien species',
        description:
          'Recorded sightings of invasive and non-native species, coloured by their assessed ' +
          'ecological risk. Tap a dot for the species, when it was found and how precisely.',
        group: 'Nature',
        attribution: '© Artsdatabanken',
        metadataUrl: `${KARTKATALOG}fremmede%20arter`,
        // Artsdatabanken caps the point layers at 1:150 000, so z11 comes back
        // as an empty tile (measured: 334 B at z11, 51.8 kB at z12 over Oslo) —
        // without this the layer reads as switched on and broken.
        minzoom: 12,
        maxzoom: 15,
        defaultOpacity: 0.75,
        identify: true,
        coverageNote:
          'Volunteer and survey observations: dense near towns and roads because that is where ' +
          'people look, not because that is where the species are.',
        profiles: ['curiosities'],
        // Drawn whole, the layer is a wall of dots — a single z12 tile over
        // Oslo comes back 109 kB and 78 % covered. The risk chips are the
        // difference between "everything anyone ever recorded" and "the species
        // that actually displace native ones".
        options: [
          {
            key: 'risk',
            label: 'Risk',
            defaultValue: 'severe',
            choices: [
              {
                value: 'severe',
                label: 'Severe',
                caption: 'SE — species assessed as a severe ecological threat.',
              },
              {
                value: 'high',
                label: 'Severe + high',
                caption: 'SE and HI, the two categories that drive control work.',
              },
              {
                value: 'all',
                label: 'All records',
                caption: 'Every risk category, down to species with no known impact.',
              },
            ],
          },
          {
            // The second dimension of the same wall of dots, and the one a
            // reader actually asks for: a lupin field and an escaped mink are
            // different questions. Measured over Oslo, the same tile is 38 kB
            // unfiltered, 16 kB for plants and 4.8 kB for animals — the
            // register is overwhelmingly garden escapes, so "animals" is a
            // different map rather than a thinner one.
            key: 'group',
            label: 'Organism',
            defaultValue: 'all',
            choices: [
              { value: 'all', label: 'All', caption: 'Every organism group in the register.' },
              {
                value: 'plants',
                label: 'Plants',
                caption: 'Garden escapes and invasive plants — most of what is recorded.',
              },
              {
                value: 'animals',
                label: 'Animals',
                caption: 'Introduced animals: mink, Iberian slug, king crab, pink salmon.',
              },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://kart.artsdatabanken.no/WMS/artskartfa.aspx',
        version: '1.3.0',
        layers: 'SE',
        // The risk categories are separate WMS layers, so the chip simply
        // rewrites LAYERS — `optionGetMapParams` is applied after the base
        // request is built, which makes overriding it a data-only change.
        //
        // The organism chip is MapServer's vendor `FILTER` instead of an SLD,
        // and deliberately so: an SLD *replaces* the style, which would flatten
        // the risk colours the other chip exists to show, and the URL-encoded
        // document blew past this server's ~2 kB query limit at five named
        // layers (measured: 3 548 chars → a bare 404). One filter per layer in
        // LAYERS, in the same order, at ~170 chars.
        optionParams: {
          risk: Object.fromEntries(
            Object.entries(ALIEN_RISK_LAYERS).map(([choice, layers]) => [
              choice,
              { LAYERS: layers },
            ]),
          ),
        },
        optionParamsFor: alienGroupParams,
        // FILTER applies to GetMap only — the same request on GetFeatureInfo
        // answered with a plant while filtered to animals — so the tap is
        // filtered here, exactly like the wildlife layer's species chip.
        optionFilter: {
          field: 'Kingdom',
          values: { group: { all: [], plants: ['Plantae'], animals: ['Animalia'] } },
        },
        identifyLayers: 'SE',
        optionIdentifyLayers: { risk: ALIEN_RISK_LAYERS },
        identifyInfoFormats: ['text/plain'],
        // Darwin Core, of which the reader wants six fields: what it is, in
        // both languages, when it was found, where the finder said they were,
        // and how much to trust the dot's position.
        identifyFields: [
          'NorskNavn',
          'VitNavn',
          'YearCollected',
          'Locality',
          'CoordinatePrecision',
          'Kingdom',
        ],
        identifyLabels: {
          NorskNavn: 'Species',
          VitNavn: 'Scientific name',
          YearCollected: 'Found',
          Locality: 'Reported location',
          CoordinatePrecision: 'Position accuracy (m)',
          Kingdom: 'Group',
        },
        identifyValues: {
          // A zero year is "not recorded" in this database, and an empty
          // decoding drops the row rather than claiming the year 0.
          YearCollected: { '0': '' },
          Kingdom: { Plantae: 'Plant', Animalia: 'Animal', Fungi: 'Fungus', Chromista: 'Algae' },
        },
        // Single observation dots, and the dots are what a user aims at.
        identifyZoom: 14,
      },
    },
    {
      // Coastal spawning and nursery grounds from Fiskeridirektoratet's
      // *kystnære fiskeridata*, mapped with local fishermen. Tagged `fishing`
      // as well: the species list on a tap is exactly what a shore angler
      // wants, and it is the only layer in the catalog that carries one.
      meta: {
        id: 'spawning-areas',
        rev: 2,
        title: 'Spawning & nursery grounds',
        description:
          'Where fish spawn and grow up along the coast, and which species were recorded for each ' +
          'area. Pick spawning, nursery or the surveyed cod fields.',
        group: 'Nature',
        attribution: '© Fiskeridirektoratet / Havforskningsinstituttet',
        metadataUrl: `${KARTKATALOG}gyteomr%C3%A5der`,
        maxzoom: 15,
        defaultOpacity: 0.6,
        identify: true,
        coverageNote:
          'Local knowledge collected area by area — coverage follows where fishermen were asked, ' +
          'and says nothing about closures or quotas.',
        profiles: ['curiosities', 'fishing'],
        // "Spawning grounds" alone never said *whose* spawning, and the answer
        // was buried in a tap: the one layer mixes 1 644 areas across 35
        // species. Fiskeridirektoratet publishes the distinction as three
        // datasets, so the chip is the honest place to make it — and it brings
        // the surveyed cod fields, which carry a graded importance the
        // fishermen's areas do not.
        options: [
          {
            key: 'kind',
            label: 'Areas',
            defaultValue: 'spawning',
            choices: [
              {
                value: 'spawning',
                label: 'Spawning',
                caption: 'Where fish spawn — 1 644 areas, cod in seven of ten.',
              },
              {
                value: 'nursery',
                label: 'Nursery & feeding',
                caption: 'Where the young grow up and the shoals feed (446 areas).',
              },
              {
                value: 'cod',
                label: 'Cod fields (surveyed)',
                caption:
                  'Coastal cod spawning fields mapped by egg survey and sonar, graded local to ' +
                  'national. Spawning runs January–May.',
              },
            ],
          },
        ],
      },
      upstream: {
        kind: 'wms',
        url: 'https://gis.fiskeridir.no/server/services/fiskeridirWMS_fiskeri/MapServer/WMSServer',
        version: '1.3.0',
        layers: 'gyteomraader',
        identifyLayers: 'gyteomraader',
        optionParams: {
          kind: {
            spawning: { LAYERS: 'gyteomraader' },
            nursery: { LAYERS: 'oppvekst_beiteomraade' },
            cod: { LAYERS: 'gytefelt_torsk_mb' },
          },
        },
        // The chip swaps the *dataset*, so the tap has to swap with it.
        optionIdentifyLayers: {
          kind: {
            spawning: 'gyteomraader',
            nursery: 'oppvekst_beiteomraade',
            cod: 'gytefelt_torsk_mb',
          },
        },
        // The union of two schemas: the fishermen's areas answer
        // `stedsnavn`/`arter`/`merknad`, the surveyed cod fields answer
        // `species_no`/`info`/`områdebeskrivelse`. `selectFields` keeps
        // whichever exist, so one list serves all three choices — the order is
        // what a card shows first.
        identifyFields: [
          'stedsnavn',
          'arter',
          'species_no',
          'info',
          'områdebeskrivelse',
          'merknad',
          'stock_no',
          'kommunenavn',
        ],
        identifyLabels: {
          stedsnavn: 'Place',
          arter: 'Species',
          species_no: 'Species',
          info: 'Importance',
          områdebeskrivelse: 'Survey',
          merknad: 'Local note (Norwegian)',
          stock_no: 'Stock',
          kommunenavn: 'Municipality',
        },
        identifyValues: {
          species_no: { Kysttorsk: 'Coastal cod', Skrei: 'Northeast Arctic cod (skrei)' },
          info: {
            'Lokalt viktig Gytefelt': 'Locally important spawning field',
            'Regionalt viktig Gytefelt': 'Regionally important spawning field',
            'Nasjonalt viktig Gytefelt': 'Nationally important spawning field',
          },
        },
        // `arter` is a *list* in one attribute — "HYSE RØDSPETTE SEI SILD
        // TORSK" — and it is not free text: 35 tokens cover all 1 644 areas
        // (measured 2026-08-04), so this is the upstream's own vocabulary,
        // translated the same way every other coded field in this file is.
        // "OG" (Norwegian "and") and a stray "0" are mapped to nothing, which
        // drops them.
        identifyTokens: {
          arter: {
            TORSK: 'cod',
            HYSE: 'haddock',
            SEI: 'saithe',
            SILD: 'herring',
            RØDSPETTE: 'plaice',
            MAKRELL: 'mackerel',
            ROGNKJEKS: 'lumpfish',
            LYR: 'pollack',
            UER: 'redfish',
            KVEITE: 'halibut',
            LYSING: 'hake',
            LANGE: 'ling',
            BLÅLANGE: 'blue ling',
            BROSME: 'tusk',
            LODDE: 'capelin',
            BRISLING: 'sprat',
            TOBIS: 'sandeel',
            SIL: 'sandeel',
            REKE: 'prawn',
            KRABBE: 'crab',
            '(TASKE)': 'edible crab',
            HUMMER: 'lobster',
            SJØKREPS: 'Norway lobster',
            PIGGHÅ: 'spurdog',
            HVITTING: 'whiting',
            PIGGVAR: 'turbot',
            KOLMULE: 'blue whiting',
            BREIFLABB: 'monkfish',
            GAPEFLYNDRE: 'long rough dab',
            HESTMAKRELL: 'horse mackerel',
            GRÅSTEINBIT: 'wolffish',
            ANNEN: 'other species',
            '(ANNEN)': 'other species',
            OG: '',
            '0': '',
          },
        },
      },
    },
    {
      // Kartverket's amtskart: the county map series surveyed between 1826 and
      // 1917, georeferenced and served seamlessly. The layer that turns the
      // profile's question around — not "what is out here" but "what *was*".
      // Farms that are now forest, the old road before the road, sæter names
      // nobody writes down any more, and Christiania where Oslo is.
      //
      // Opaque by nature (it is a scanned map, not an overlay of symbols), so
      // it ships at 0.8 and the panel slider fades the present back in.
      meta: {
        id: 'historic-maps',
        rev: 1,
        title: 'Historic maps (1826–1917)',
        description:
          'Kartverket’s hand-drawn county maps (amtskart), georeferenced over today’s terrain.',
        group: 'History',
        attribution: '© Kartverket',
        metadataUrl: `${KARTKATALOG}historiske%20kart`,
        // The sheets are ~1:100 000–1:200 000 surveys: past z14 the request
        // only buys a bigger blur, so the client overzooms from there.
        maxzoom: 14,
        defaultOpacity: 0.8,
        identify: false,
        coverageNote:
          'Sheet by sheet, surveyed across ninety years — neighbouring valleys can be decades ' +
          'apart, and a few sheets are missing entirely. Surveyed at about 1:100 000, so it goes ' +
          'soft past village zoom: there is no more detail in the paper. Nothing here is a survey ' +
          'of today.',
        profiles: ['curiosities'],
      },
      upstream: {
        kind: 'wms',
        url: 'https://wms.geonorge.no/skwms1/wms.historiskekart',
        version: '1.3.0',
        // `georefererte`, the service's other layer, is not an overlay: it
        // returns *one* named sheet by id, so it has nothing to draw without
        // one. `amt1` is the whole series, mosaicked.
        layers: 'amt1',
      },
    },
  ];
}
