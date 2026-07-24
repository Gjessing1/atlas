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
        rev: 1,
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
