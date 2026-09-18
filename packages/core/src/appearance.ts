/** A per-device UI preference; `system` follows the operating system live. */
export type ThemeMode = 'system' | 'light' | 'dark';

export type ColorScheme = Exclude<ThemeMode, 'system'>;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

export interface MapAppearance {
  colorScheme: ColorScheme;
  /** One of Atlas's curated activity profile ids. Unknown ids degrade to the neutral base. */
  profile: string;
  /** Optional per-device edits applied after Atlas's theme/profile tuning. */
  custom?: MapStyleOverrides;
  /**
   * Resolved location of the Atlas outdoor overlay archive — either a
   * `{z}/{x}/{y}` tile URL (the backend's endpoint) or a `pmtiles://` URL (an
   * offline pack's local file). Supplying it upgrades the outdoor POI and
   * barrier layers onto that source; leaving it out keeps them on the basemap,
   * which is a strictly poorer but perfectly valid map. See
   * infrastructure/tiles/outdoor-schema.yml.
   */
  outdoorTiles?: string;
  /**
   * Draw the vector basemap at all. Absent or `true` is the map as it has always
   * been; `false` replaces the whole thing with one flat, inert background and
   * leaves the overlays to carry the map (see `blankBasemapStyle`).
   *
   * Not a cartographic preference but a *reading* one, and the case that asked
   * for it is the historic-maps overlay: an amtskart sheet from 1826 has hard
   * edges and holes, and with today's coloured land under it the eye reads the
   * modern green as part of the old survey. The same is true of any raster with
   * gaps — satellite cloud, a bathymetry survey's edge. Nothing else in the
   * style pass can express it, because "no basemap" is not a tuning of the
   * basemap's layers: it is their absence.
   */
  basemap?: boolean;
  /** Draw the OSM POI symbols and labels carried by the map sources. */
  poi?: boolean;
  /** Web-only for now: draw a DEM mesh and hillshade beneath roads and labels. */
  terrain?: boolean;
  /** Same-origin Terrarium tile template used when `terrain` is on. */
  terrainTiles?: string;
}

/** The deliberately small, portable style-editor surface shared by both maps. */
export interface MapStyleOverrides {
  landColor?: string;
  waterColor?: string;
  roadColor?: string;
  pathColor?: string;
  /** Multiplier for every symbol's text size (0.75–1.5). */
  labelScale: number;
  /** Multiplier for POI text/icon size and opacity (0.5–1.5). */
  poiScale: number;
}

export const DEFAULT_MAP_STYLE_OVERRIDES: MapStyleOverrides = {
  labelScale: 1,
  poiScale: 1,
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function optionalColor(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : undefined;
}

function boundedScale(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : 1;
}

/** Parse persisted/imported editor state without letting malformed paint values into MapLibre. */
export function sanitizeMapStyleOverrides(value: unknown): MapStyleOverrides {
  if (!value || typeof value !== 'object') return { ...DEFAULT_MAP_STYLE_OVERRIDES };
  const raw = value as Record<string, unknown>;
  return {
    ...(optionalColor(raw['landColor']) ? { landColor: optionalColor(raw['landColor']) } : {}),
    ...(optionalColor(raw['waterColor']) ? { waterColor: optionalColor(raw['waterColor']) } : {}),
    ...(optionalColor(raw['roadColor']) ? { roadColor: optionalColor(raw['roadColor']) } : {}),
    ...(optionalColor(raw['pathColor']) ? { pathColor: optionalColor(raw['pathColor']) } : {}),
    labelScale: boundedScale(raw['labelScale'], 0.75, 1.5),
    poiScale: boundedScale(raw['poiScale'], 0.5, 1.5),
  };
}

interface StyleLayer {
  id: string;
  type: string;
  minzoom?: number;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  filter?: unknown;
  [key: string]: unknown;
}

interface MapStyleDocument {
  name?: string;
  layers: StyleLayer[];
  [key: string]: unknown;
}

const TERRAIN_SOURCE_ID = 'atlas-terrain-dem';
const TERRAIN_HILLSHADE_SOURCE_ID = 'atlas-terrain-hillshade';

/**
 * Add the same Terrarium DEM twice: terrain and hillshade maintain independent
 * tile caches in MapLibre, avoiding contention while a pitched camera streams
 * both consumers. Lines and labels stay above the shade so paths remain crisp.
 */
function addTerrain(style: MapStyleDocument, tiles: string, dark: boolean): void {
  const sources =
    style['sources'] && typeof style['sources'] === 'object'
      ? (style['sources'] as Record<string, unknown>)
      : ((style['sources'] = {}) as Record<string, unknown>);
  const source = {
    type: 'raster-dem',
    tiles: [tiles],
    encoding: 'terrarium',
    tileSize: 512,
    minzoom: 0,
    maxzoom: 17,
  };
  sources[TERRAIN_SOURCE_ID] = {
    ...source,
    attribution:
      '<a href="https://mapterhorn.com/attribution">Terrain: © Mapterhorn / Kartverket / Copernicus</a>',
  };
  sources[TERRAIN_HILLSHADE_SOURCE_ID] = source;
  style['terrain'] = { source: TERRAIN_SOURCE_ID, exaggeration: 1 };

  const hillshade: StyleLayer = {
    id: 'atlas-terrain-hillshade',
    type: 'hillshade',
    source: TERRAIN_HILLSHADE_SOURCE_ID,
    paint: {
      'hillshade-exaggeration': dark ? 0.32 : 0.26,
      'hillshade-shadow-color': dark ? '#111b22' : '#514738',
      'hillshade-highlight-color': dark ? '#b4c2c8' : '#fff7e7',
      'hillshade-accent-color': dark ? '#27343b' : '#6d6252',
    },
  };
  const firstLineOrLabel = style.layers.findIndex(
    (layer) => layer.type === 'line' || layer.type === 'symbol',
  );
  style.layers.splice(firstLineOrLabel < 0 ? style.layers.length : firstLineOrLabel, 0, hillshade);
}

function paint(layer: StyleLayer, property: string, value: unknown): void {
  layer.paint ??= {};
  layer.paint[property] = value;
}

function multiplyPaint(layer: StyleLayer, property: string, factor: number): void {
  const current = layer.paint?.[property];
  if (typeof current === 'number') {
    paint(layer, property, current * factor);
  } else if (Array.isArray(current) && current[0] === 'interpolate') {
    // MapLibre Native accepts the source style's camera interpolation here,
    // but some Android builds reject arithmetic wrapped around it for a
    // line-width. Scale its output stops directly so emphasis can never make
    // the affected roads disappear.
    paint(
      layer,
      property,
      current.map((part, index) =>
        index >= 4 && index % 2 === 0 && typeof part === 'number' ? part * factor : part,
      ),
    );
  } else if (Array.isArray(current) && current[0] === 'step') {
    paint(
      layer,
      property,
      current.map((part, index) =>
        (index === 2 || (index >= 4 && index % 2 === 0)) && typeof part === 'number'
          ? part * factor
          : part,
      ),
    );
  }
}

/**
 * A drivable-road line layer — excludes the shared path/track and helper
 * strokes. Bridges and tunnels are the *same* road: Liberty splits every class
 * into `road_` / `bridge_` / `tunnel_` layers, so matching only `road_` made a
 * receded or widened road snap back to base styling wherever it crossed a
 * bridge or entered a tunnel.
 */
function isCarRoad(layer: StyleLayer): boolean {
  return (
    layer.type === 'line' &&
    /^(road|bridge|tunnel)_/.test(layer.id) &&
    !/(path_pedestrian|service_track|_casing|_hatching)$/.test(layer.id)
  );
}

function multiplyStyleValue(value: unknown, factor: number): unknown {
  if (typeof value === 'number') return value * factor;
  if (Array.isArray(value) && value[0] === 'interpolate') {
    return value.map((part, index) =>
      index >= 4 && index % 2 === 0 && typeof part === 'number' ? part * factor : part,
    );
  }
  if (Array.isArray(value) && value[0] === 'step') {
    return value.map((part, index) =>
      (index === 2 || (index >= 4 && index % 2 === 0)) && typeof part === 'number'
        ? part * factor
        : part,
    );
  }
  return value;
}

function applyCustomStyle(layer: StyleLayer, custom: MapStyleOverrides): void {
  if (custom.landColor && layer.type === 'background') {
    paint(layer, 'background-color', custom.landColor);
  }
  if (custom.waterColor) {
    if (layer.id === 'water') paint(layer, 'fill-color', custom.waterColor);
    if (/^waterway_/.test(layer.id)) paint(layer, 'line-color', custom.waterColor);
  }
  if (custom.roadColor && isCarRoad(layer)) {
    paint(layer, 'line-color', custom.roadColor);
  }
  if (custom.pathColor && /(path_pedestrian|service_track|-track-contrast)$/.test(layer.id)) {
    paint(layer, 'line-color', custom.pathColor);
  }
  if (layer.type !== 'symbol') return;
  if (custom.labelScale !== 1 && layer.layout?.['text-size'] !== undefined) {
    layer.layout['text-size'] = multiplyStyleValue(layer.layout['text-size'], custom.labelScale);
  }
  // The appended outdoor-POI layer is a POI layer as far as the user's slider
  // is concerned — leaving it out would let cabin icons ignore "smaller POIs".
  if ((/^poi_/.test(layer.id) || layer.id === OUTDOOR_POI_LAYER_ID) && custom.poiScale !== 1) {
    if (layer.layout?.['text-size'] !== undefined) {
      layer.layout['text-size'] = multiplyStyleValue(layer.layout['text-size'], custom.poiScale);
    }
    if (layer.layout?.['icon-size'] !== undefined) {
      layer.layout['icon-size'] = multiplyStyleValue(layer.layout['icon-size'], custom.poiScale);
    }
    const opacity = Math.min(1, 0.78 * custom.poiScale);
    paint(layer, 'text-opacity', opacity);
    paint(layer, 'icon-opacity', opacity);
  }
}

function tuneLabels(layer: StyleLayer, dark: boolean): void {
  const important = /country|state|city|town|village|highway-name-major|highway-shield/.test(
    layer.id,
  );
  const secondary = /highway-name-minor|highway-name-path|water_name|waterway_line/.test(layer.id);
  paint(
    layer,
    'text-color',
    dark
      ? important
        ? '#eef2f5'
        : secondary
          ? '#bdc5cb'
          : '#aeb6bc'
      : important
        ? '#31383d'
        : secondary
          ? '#596168'
          : '#676d69',
  );
  paint(layer, 'text-halo-color', dark ? '#182024' : '#faf8f3');
  paint(layer, 'text-halo-width', important ? 1.4 : 1.1);
  if (/^poi_/.test(layer.id)) {
    paint(layer, 'text-opacity', 0.82);
    paint(layer, 'icon-opacity', 0.78);
  }
}

function tuneLightLayer(layer: StyleLayer): void {
  if (layer.type === 'background') paint(layer, 'background-color', '#f5f3ee');
  if (layer.id === 'water') paint(layer, 'fill-color', '#abc9dc');
  if (layer.type === 'line' && /^waterway_/.test(layer.id)) {
    paint(layer, 'line-color', '#83afca');
  }
  if (layer.id === 'park') {
    paint(layer, 'fill-color', '#dce8d4');
    paint(layer, 'fill-opacity', 0.55);
    paint(layer, 'fill-outline-color', '#b8ccb2');
  }
  if (layer.id === 'landcover_wood') {
    paint(layer, 'fill-color', '#cfe0c7');
    paint(layer, 'fill-opacity', 0.34);
  }
  if (layer.id === 'landcover_grass') {
    paint(layer, 'fill-color', '#dce7d2');
    paint(layer, 'fill-opacity', 0.28);
  }
  if (layer.id === 'landuse_residential') paint(layer, 'fill-color', '#ebe8e3');
  if (layer.id === 'building') {
    paint(layer, 'fill-color', '#ddd9d3');
    paint(layer, 'fill-outline-color', '#c9c4bd');
  }
  if (layer.type === 'symbol') tuneLabels(layer, false);
}

function tuneDarkLayer(layer: StyleLayer): void {
  if (layer.type === 'background') paint(layer, 'background-color', '#1d2427');

  const fillColors: Record<string, string> = {
    park: '#26382f',
    landuse_residential: '#292e31',
    landcover_wood: '#29382f',
    landcover_grass: '#2d352b',
    landcover_ice: '#50606a',
    landcover_wetland: '#293b3d',
    landuse_pitch: '#303a31',
    landuse_track: '#393529',
    landuse_cemetery: '#30382f',
    landuse_hospital: '#3b2e32',
    landuse_school: '#38372d',
    water: '#1d4358',
    landcover_sand: '#413b2b',
    aeroway_fill: '#343a3d',
    road_area_pattern: '#34383a',
    building: '#363b3e',
  };
  const fill = fillColors[layer.id];
  if (fill) {
    delete layer.paint?.['fill-pattern'];
    paint(layer, 'fill-color', fill);
    if (layer.id === 'park' || layer.id.startsWith('landcover_'))
      paint(layer, 'fill-opacity', 0.72);
    if (layer.id === 'building') paint(layer, 'fill-outline-color', '#454b4f');
  }
  // Liberty draws every footprint twice: the flat `building` fill above, and
  // from z15 a `building-3d` extrusion on top of it. Recolouring only the fill
  // left dark mode with near-white blocks the moment the extrusions appeared —
  // the whole city lit up while the basemap under it stayed dark.
  if (layer.id === 'building-3d') paint(layer, 'fill-extrusion-color', fillColors['building']!);

  if (layer.type === 'line') {
    if (/^waterway_/.test(layer.id)) paint(layer, 'line-color', '#477b98');
    if (/boundary/.test(layer.id)) paint(layer, 'line-color', '#68747d');
    if (/rail/.test(layer.id)) paint(layer, 'line-color', '#66717a');
    if (/(_casing|_hatching)$/.test(layer.id)) paint(layer, 'line-color', '#313a40');
    if (/(motorway|trunk_primary)/.test(layer.id) && !/_casing$/.test(layer.id)) {
      paint(layer, 'line-color', '#756d55');
    }
    if (/secondary_tertiary/.test(layer.id) && !/_casing$/.test(layer.id)) {
      paint(layer, 'line-color', '#656158');
    }
    if (/(minor|street)/.test(layer.id) && !/_casing$/.test(layer.id)) {
      paint(layer, 'line-color', '#555d62');
    }
  }
  if (layer.type === 'symbol') tuneLabels(layer, true);
}

/**
 * Ski's winter palette: open ground whites out to snow, and lakes read as
 * *traversable* frozen terrain (near-white fill + pale-blue outline) rather
 * than the blue barriers the base style paints. The sea is the exception:
 * salt water rarely freezes solid, so `class == ocean` keeps a real, bluer
 * water colour — a barrier, not a surface to ski onto — while inland lakes
 * and rivers get the frozen wash. But forest and built-up blocks must stay
 * legible — the treeline and neighbourhoods are exactly what a ski map
 * navigates by — so wood keeps a clear cool green and residential/buildings
 * keep contrast against the snow rather than washing to white. Applied on top
 * of the light/dark tune, so it wins for the handful of layers it touches.
 */
function tuneWinterLayer(layer: StyleLayer, dark: boolean): void {
  if (layer.type === 'background') {
    paint(layer, 'background-color', dark ? '#20282b' : '#eef2f2');
  }
  if (layer.id === 'water') {
    // Data-driven on the OpenMapTiles `water` class: sea stays open water,
    // everything inland reads as frozen-traversable. `match` on a colour is
    // already used elsewhere in this file, so it renders on Android too.
    const frozenFill = dark ? '#3f515c' : '#eaf1f6';
    const seaFill = dark ? '#264352' : '#b9d4e6';
    const frozenOutline = dark ? '#5d7686' : '#b7d0e0';
    const seaOutline = dark ? '#3d6076' : '#8fb8d0';
    paint(layer, 'fill-color', ['match', ['get', 'class'], 'ocean', seaFill, frozenFill]);
    paint(layer, 'fill-outline-color', [
      'match',
      ['get', 'class'],
      'ocean',
      seaOutline,
      frozenOutline,
    ]);
  }
  if (layer.type === 'line' && /^waterway_/.test(layer.id)) {
    paint(layer, 'line-color', dark ? '#5d7686' : '#a9c4d6');
  }
  const fills: Record<string, { color: string; opacity: number }> = dark
    ? {
        landcover_wood: { color: '#2b3d31', opacity: 0.82 },
        landcover_grass: { color: '#2f3d33', opacity: 0.6 },
        park: { color: '#2a3a30', opacity: 0.7 },
        landuse_residential: { color: '#2b3236', opacity: 1 },
      }
    : {
        landcover_wood: { color: '#c7ddc4', opacity: 0.85 },
        landcover_grass: { color: '#d8e6d3', opacity: 0.55 },
        park: { color: '#d0e3cd', opacity: 0.7 },
        landuse_residential: { color: '#e5e2e6', opacity: 1 },
      };
  const fill = fills[layer.id];
  if (fill) {
    delete layer.paint?.['fill-pattern'];
    paint(layer, 'fill-color', fill.color);
    paint(layer, 'fill-opacity', fill.opacity);
  }
  if (layer.id === 'building') {
    paint(layer, 'fill-color', dark ? '#3a4145' : '#d5d0ca');
    paint(layer, 'fill-outline-color', dark ? '#4b5257' : '#b0aaa2');
  }
}

/**
 * Explore's city green: the greenery is a *destination* on a walk-around map.
 *
 * The shared light/dark tune paints parks and grass as a faint wash, which is
 * right for a driving or hiking map (there, green is the background the route
 * crosses). Someone browsing a city is looking for the park to sit in, so on
 * this profile the same polygons get a saturated fill at a much higher opacity,
 * and the park edge becomes a real green outline instead of the base style's
 * near-white dashes. Pitches count too — the football field is a landmark.
 *
 * Applied after the theme pass, so these colours win for the handful of layers
 * they name and everything else keeps Atlas's restrained palette.
 */
function tuneCityGreens(layer: StyleLayer, dark: boolean): void {
  const fills: Record<string, { color: string; opacity: number }> = dark
    ? {
        park: { color: '#2f4a37', opacity: 0.92 },
        landcover_grass: { color: '#31462f', opacity: 0.8 },
        landcover_wood: { color: '#2c4433', opacity: 0.85 },
        landuse_pitch: { color: '#345239', opacity: 0.9 },
      }
    : {
        park: { color: '#c2e3b0', opacity: 0.8 },
        landcover_grass: { color: '#cbe7b6', opacity: 0.62 },
        landcover_wood: { color: '#bfdcb0', opacity: 0.6 },
        landuse_pitch: { color: '#b7dea4', opacity: 0.85 },
      };
  const fill = fills[layer.id];
  if (fill) {
    delete layer.paint?.['fill-pattern'];
    paint(layer, 'fill-color', fill.color);
    paint(layer, 'fill-opacity', fill.opacity);
    if (layer.id === 'park') paint(layer, 'fill-outline-color', dark ? '#4d7357' : '#7fb073');
  }
  // Liberty draws the park boundary as a near-white dashed line, which vanishes
  // once the fill is this green. Keep the dash, give it a colour.
  if (layer.id === 'park_outline') paint(layer, 'line-color', dark ? '#527a5c' : '#7cae70');
}

/**
 * Re-assert the bridge/underpass reading after the theme and profile passes.
 *
 * The *z-order* was never the problem: Liberty already stacks the whole tunnel
 * group below the surface roads and the whole bridge group above them, so a
 * path genuinely draws under the E-road that flies over it. What Atlas lost was
 * the **appearance** signal at the crossing — the shared `path_pedestrian$` /
 * `service_track$` overrides paint the road, bridge and tunnel variants of a
 * layer identically, and the dark tune flattened every `_casing` to one colour,
 * so the base style's two cues (a tunnel's dashed, lighter casing; a bridge's
 * solid one) were painted away. Two lines crossing then read as a junction.
 *
 * So: a tunnelled line is drawn weaker and keeps a dashed casing, and a bridge
 * casing is darkened into a real deck edge that separates it from whatever
 * passes underneath. Opacity is multiplied, not set, so a profile that already
 * receded the road keeps its emphasis.
 */
function tuneBrunnel(layer: StyleLayer, dark: boolean): void {
  if (layer.type !== 'line') return;
  const isCasing = /_casing$/.test(layer.id);
  if (/^tunnel_/.test(layer.id)) {
    if (isCasing) {
      paint(layer, 'line-color', dark ? '#3b464d' : '#c2beb6');
      if (layer.paint?.['line-dasharray'] === undefined) {
        paint(layer, 'line-dasharray', [0.5, 0.25]);
      }
      return;
    }
    const current = layer.paint?.['line-opacity'];
    paint(layer, 'line-opacity', typeof current === 'number' ? current * 0.72 : 0.72);
  } else if (/^bridge_/.test(layer.id) && isCasing) {
    paint(layer, 'line-color', dark ? '#12191d' : '#8e887e');
  }
}

/**
 * Profiles whose users are actually on the ground, where asphalt versus gravel
 * changes the plan. Drive/Explore/Ski deliberately stay out of it — surface is
 * noise on a car map, and Ski's own winter palette owns those colours.
 */
const SURFACE_AWARE_PROFILES = ['run', 'hike', 'fishhunt', 'bike'];

/**
 * Profiles that ask "can I actually get through here?" — a gate across a forest
 * road is the difference between driving to the lake and walking the last ten
 * kilometres. Kept off Drive and Explore, where the same tags are mostly urban
 * street furniture.
 */
const BARRIER_PROFILES = ['fishhunt', 'hike', 'bike'];

/**
 * Profiles where the outdoor POIs are the point of the map, not background.
 *
 * Curiosities is here for one class in particular: `cave_entrance`, which the
 * basemap does not carry and no Norwegian WMS answers for either (there is no
 * national karst or cave service — see the `geoheritage` catalog row). The
 * outdoor archive is the only layer that can put a cave on the map, and the one
 * half of "find caves" that also works outside Norway.
 */
const OUTDOOR_POI_PROFILES = ['fishhunt', 'hike', 'curiosities'];

/** Profiles that read named summits and regional/national hiking networks. */
const HIKE_CARTOGRAPHY_PROFILES = ['fishhunt', 'hike'];

/** Named, because the user's POI-size setting has to reach this layer too. */
const OUTDOOR_POI_LAYER_ID = 'atlas-outdoor-poi';

/**
 * The barrier classes that stop a vehicle, as the basemap spells them.
 *
 * Norway's *bom* is usually `barrier=lift_gate`, occasionally `barrier=gate`;
 * both survive into the tiles' `poi` layer as a `class`. Bollards and cycle
 * barriers are deliberately excluded — they are urban clutter at this scale and
 * never the thing that ruins a trip.
 */
const BARRIER_CLASSES = ['gate', 'lift_gate'];

/**
 * Outdoor POI subclasses worth lifting out of the generic POI soup.
 *
 * Matched on `subclass`, not `class`, because the classes are too broad: the
 * `lodging` class is mostly hotels, and `attraction` is mostly not a viewpoint.
 * `wilderness_hut` is listed for the day the tile build carries it — see the
 * note on `outdoorPoiLayer`.
 */
const OUTDOOR_POI_SUBCLASSES = [
  'alpine_hut',
  'wilderness_hut',
  'chalet',
  'shelter',
  'viewpoint',
  'camp_site',
  'picnic_site',
  'drinking_water',
];

/**
 * The Atlas outdoor overlay: a second, small vector archive built beside the
 * basemap (infrastructure/tiles/outdoor-schema.yml, 6.7 MB for all of Norway).
 *
 * It exists because the basemap cannot answer two questions its schema simply
 * does not carry: *where are the self-service cabins, ramps and boatyards*
 * (`wilderness_hut`, `slipway` and `waterway=boatyard` are absent from
 * OpenMapTiles entirely), and *what is out there while I am still planning*
 * (POIs are only emitted from z14). Both were verified by decoding
 * norway.pmtiles, not assumed.
 *
 * Binding to it is optional throughout: a client whose server has no archive,
 * or an offline pack built before this existed, keeps the basemap-cloned layers
 * below. That is the same rule the Norwegian overlays follow — absent, never
 * "no data".
 */
const OUTDOOR_SOURCE_ID = 'atlas-outdoor';
const OUTDOOR_SOURCE_LAYER = 'outdoor';
/** The archive's own max zoom; MapLibre overzooms past it, as with the basemap. */
const OUTDOOR_MAXZOOM = 14;
/**
 * Three zooms earlier than the basemap can manage — the whole point of the
 * archive. This is the zoom at which you are choosing which side of the gate to
 * park on, or which cabin to aim for.
 */
const OUTDOOR_MINZOOM = 11;

/** Barrier classes in the overlay. `swing_gate` is a third *bom* form OpenMapTiles drops. */
const OUTDOOR_BARRIER_CLASSES = ['gate', 'lift_gate', 'swing_gate'];

/** Everything the overlay draws as an icon — its own flat vocabulary, not the basemap's. */
const OUTDOOR_POI_CLASSES = [
  'wilderness_hut',
  'alpine_hut',
  'chalet',
  'shelter',
  'viewpoint',
  'camp_site',
  'picnic_site',
  'drinking_water',
  'slipway',
  'boatyard',
  'cave_entrance',
  'parking',
];

/**
 * A cabin you must bring your own food to, versus one with a warden.
 *
 * This is the distinction the cabin styling could not draw at all while `wilderness_hut` was
 * missing from the tiles. The palette is **Atlas's own** — deliberately not a
 * claim to reproduce DNT's official cabin colour coding, which covers
 * categories (betjent/selvbetjent/ubetjent) that OSM's three tags do not map
 * onto cleanly.
 */
const SELF_SERVICE_HUT = 'wilderness_hut';
const HUT_CLASSES = [SELF_SERVICE_HUT, 'alpine_hut', 'chalet'];

/**
 * Overlay class → sprite, since the overlay's `class` values are ours and the
 * cloned template's `icon-image` expression reads the basemap's schema.
 *
 * Every target already exists in the OFM sheet, so no new image assets ship and
 * Android renders it identically. `harbor` is the closest thing the sheet has
 * to a launching ramp; `lodging` (a bed) covers all three cabin classes, which
 * is why the hut ring below carries the staffed/self-service split instead of
 * two icons that do not exist.
 */
const OUTDOOR_ICON_IMAGE = [
  'match',
  ['get', 'class'],
  ['wilderness_hut', 'alpine_hut', 'chalet'],
  'lodging',
  'shelter',
  'shelter',
  'viewpoint',
  'attraction',
  'camp_site',
  'campsite',
  'picnic_site',
  'picnic_site',
  'drinking_water',
  'drinking_water',
  ['slipway', 'boatyard'],
  'harbor',
  // `entrance` (a doorway) is the sheet's closest thing to a cave mouth, and
  // deliberately not `attraction` — that is the viewpoint icon, and a cave you
  // cannot tell apart from a viewpoint is not on the map in any useful sense.
  'cave_entrance',
  'entrance',
  // Trailhead parking is a trip primitive rather than urban parking clutter:
  // the outdoor archive reveals it while the route is still being planned.
  'parking',
  'parking',
  // Unreachable — the layer filter admits only the classes above — but MapLibre
  // requires a default, and a real sprite name keeps it from ever warning.
  'attraction',
];

function matchesAny(property: string, values: string[]): unknown {
  return ['match', ['get', property], values, true, false];
}

/**
 * "Exists, but you may not take it" — swap a colour for a muted one wherever
 * the way is access-restricted.
 *
 * The basemap only emits `access` when OSM actually restricts the way (`no` for
 * `access=no` / `access=private`, and it carries the same signal for
 * `motor_vehicle=no` tracks), so an absent attribute keeps the normal colour.
 * That is the same "absent, not 'no data'" rule the surface split follows: a
 * track nobody has surveyed is drawn as an ordinary track, never as forbidden.
 * The line is dimmed rather than dropped — a barred forest road is still a
 * landmark, and usually still walkable.
 */
function restricted(normal: unknown, muted: string): unknown {
  return ['case', ['==', ['get', 'access'], 'no'], muted, normal];
}

/**
 * The zoom the basemap starts emitting these POIs at, and therefore the floor
 * for both layers below — a *data* limit, not a styling choice. Below z14 only
 * a handful of high-rank POIs are in the tiles at all (28 features in the z12
 * tile over Østmarka, none of them a gate); the full set appears at z14. So an
 * earlier reveal — a gate visible while you are still choosing which side of it
 * to park on — needs the POI zoom raised in the tile build, and asking for it
 * here would only look like it worked.
 */
const BARRIER_MINZOOM = 14;

/**
 * A point layer for gates and barriers, which the base style draws as *nothing*.
 *
 * The tiles carry them (≈1200 gate/lift_gate points across a 3900-tile sample of
 * Norwegian mountain terrain), and Liberty's POI layers do try to render them —
 * but their `icon-image` resolves to the feature's class, and the sprite sheet
 * has no `gate` or `lift_gate` image, so every one of them silently drew no icon
 * and no label (they have no name either). Hence a `circle` layer rather than a
 * symbol one: it needs no sprite, so web and Android render it identically
 * without shipping new image assets.
 */
function barrierLayer(template: StyleLayer, dark: boolean, outdoor: boolean): StyleLayer {
  return {
    id: 'atlas-barriers',
    type: 'circle',
    source: outdoor ? OUTDOOR_SOURCE_ID : template.source,
    'source-layer': outdoor ? OUTDOOR_SOURCE_LAYER : template['source-layer'],
    minzoom: outdoor ? OUTDOOR_MINZOOM : BARRIER_MINZOOM,
    filter: matchesAny('class', outdoor ? OUTDOOR_BARRIER_CLASSES : BARRIER_CLASSES),
    paint: {
      // The z11 stop only bites on the overlay; the basemap layer starts at 14
      // and MapLibre clamps to the first stop anyway.
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.2, 14, 3.2, 18, 6.5],
      // A lift or swing gate is the classic locked *bom*; a plain gate is more
      // often openable, so it reads as a warning rather than a stop.
      'circle-color': [
        'match',
        ['get', 'class'],
        ['lift_gate', 'swing_gate'],
        dark ? '#f2705f' : '#c0392b',
        dark ? '#f0b357' : '#c8801c',
      ],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 18, 1.6],
      'circle-stroke-color': dark ? '#12191d' : '#ffffff',
      'circle-opacity': 0.95,
    },
  };
}

const HIKING_NETWORKS = ['iwn', 'nwn', 'rwn'];

/**
 * The relation-derived regional/national hiking network already carried by
 * OpenMapTiles's `transportation_name` layer, but never drawn by Liberty.
 *
 * `route_N_network` comes from OSM hiking relations (including the DNT routes
 * that carry Norwegian regional-network refs), so this is a real vector
 * distinction rather than a second treatment of Kartverket's undifferentiated
 * Fotrute raster. A quiet red line establishes the route and repeated T marks
 * make the distinction survive where the raster uses the same red hue.
 */
function hikingNetworkLayers(template: StyleLayer, dark: boolean): StyleLayer[] {
  const networkFilter = [
    'any',
    matchesAny('route_1_network', HIKING_NETWORKS),
    matchesAny('route_2_network', HIKING_NETWORKS),
    matchesAny('route_3_network', HIKING_NETWORKS),
  ];
  const shared = {
    source: template.source,
    'source-layer': 'transportation_name',
    filter: [
      'all',
      ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
      networkFilter,
    ],
  };
  // `rwn`/`nwn` says this is a regional/national walking network, not that it
  // uses Norway's red T. OpenMapTiles drops `osmc:symbol`, but retains the
  // relation ref used by the Norwegian waymarked/DNT route records. Require a
  // ref for the T glyph so named pilgrim/local networks are distinguished by
  // the red line without being falsely labelled as T-marked.
  const markerFilter = [
    'all',
    shared.filter,
    ['any', ['has', 'route_1_ref'], ['has', 'route_2_ref'], ['has', 'route_3_ref']],
  ];
  return [
    {
      id: 'atlas-hiking-network',
      type: 'line',
      ...shared,
      minzoom: 10,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': dark ? '#f06f64' : '#b52d2a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 14, 1.25, 18, 2.2],
        'line-opacity': 0.82,
      },
    },
    {
      id: 'atlas-hiking-network-markers',
      type: 'symbol',
      ...shared,
      filter: markerFilter,
      minzoom: 12,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 110,
        'text-field': 'T',
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9, 16, 11],
        'text-keep-upright': true,
        'text-rotation-alignment': 'map',
      },
      paint: {
        'text-color': dark ? '#ff8b80' : '#a92320',
        'text-halo-color': dark ? '#172025' : '#fffdf8',
        'text-halo-width': 1.4,
        'text-halo-blur': 0.3,
      },
    },
  ];
}

/**
 * Summit point + name/elevation label for either OpenMapTiles peaks or the
 * outdoor archive's named-hill supplement.
 *
 * The basemap carries a useful `rank` derived from peak prominence; placing
 * lower ranks first gives major summits collision priority. Hills have no
 * national prominence metric, so their later layer and z12 floor naturally
 * make them local detail. This reproduces Norgeskart's hierarchy without
 * inventing elevations: absent `ele` means a name only.
 */
function summitLayers(source: unknown, dark: boolean, outdoor: boolean): StyleLayer[] {
  const sourceLayer = outdoor ? OUTDOOR_SOURCE_LAYER : 'mountain_peak';
  const filter = [
    'all',
    ['match', ['geometry-type'], ['MultiPoint', 'Point'], true, false],
    matchesAny('class', outdoor ? ['hill'] : ['peak']),
    ['has', 'name'],
  ];
  const minzoom = outdoor ? 12 : 9;
  const shared = {
    source: outdoor ? OUTDOOR_SOURCE_ID : source,
    'source-layer': sourceLayer,
    minzoom,
    filter,
  };
  return [
    {
      id: outdoor ? 'atlas-outdoor-summits' : 'atlas-summits',
      type: 'circle',
      ...shared,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], minzoom, 2.2, 16, 3.6],
        'circle-color': dark ? '#e6d4c2' : '#5f4635',
        'circle-stroke-color': dark ? '#1b2327' : '#fffdf8',
        'circle-stroke-width': 1,
      },
    },
    {
      id: outdoor ? 'atlas-outdoor-summit-labels' : 'atlas-summit-labels',
      type: 'symbol',
      ...shared,
      layout: {
        'text-field': [
          'case',
          ['has', 'ele'],
          ['concat', ['get', 'name'], '\n', ['to-string', ['get', 'ele']], ' m'],
          ['get', 'name'],
        ],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], minzoom, 10.5, 14, 12.5, 17, 14],
        'text-anchor': 'bottom',
        'text-offset': [0, -0.55],
        'text-max-width': 9,
        'text-padding': 3,
        // OpenMapTiles rank 1 is the most prominent. Hills have no rank and
        // deliberately sort after every ranked peak in the shared label field.
        'symbol-sort-key': outdoor ? 100 : ['coalesce', ['get', 'rank'], 99],
      },
      paint: {
        'text-color': dark ? '#f1e6dc' : '#463327',
        'text-halo-color': dark ? '#182125' : '#fffdf8',
        'text-halo-width': 1.5,
        'text-halo-blur': 0.4,
      },
    },
  ];
}

/**
 * The staffed / self-service cabin split, drawn as a ring around the icon.
 *
 * A ring rather than a second icon because the sprite sheet has exactly one
 * cabin glyph (`lodging`) and shipping new image assets would break the rule
 * that web and Android render from the same style with no extra payload. A ring
 * rather than a filled disc because the icon has to stay readable inside it:
 * the fill is left fully transparent and only the stroke is drawn.
 *
 * Overlay-only, and unavoidably so — `wilderness_hut` does not exist in the
 * basemap, so on a client without the archive there is nothing to split.
 */
function outdoorHutLayer(dark: boolean): StyleLayer {
  return {
    id: 'atlas-outdoor-hut',
    type: 'circle',
    source: OUTDOOR_SOURCE_ID,
    'source-layer': OUTDOOR_SOURCE_LAYER,
    minzoom: OUTDOOR_MINZOOM,
    filter: matchesAny('class', HUT_CLASSES),
    paint: {
      // Must clear the sprite, which is 21 px square at *every* zoom (icon-size
      // is 1 throughout): a radius under ~11 draws the ring inside the icon,
      // where it is invisible until you are zoomed right in. Verified on the
      // real map rather than reasoned about — the first attempt used 7.
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 11.5, 16, 13.5],
      'circle-color': 'rgba(0, 0, 0, 0)',
      'circle-opacity': 0,
      'circle-stroke-width': 2,
      'circle-stroke-color': [
        'match',
        ['get', 'class'],
        SELF_SERVICE_HUT,
        dark ? '#7fb4dd' : '#2f6f9f',
        dark ? '#f0907f' : '#b0463a',
      ],
      'circle-stroke-opacity': 0.9,
    },
  };
}

/**
 * Cabins, shelters, viewpoints and water, revealed early and at full strength.
 *
 * Cloned from the base style's own low-rank POI layer so it inherits the
 * icon/text plumbing (`icon-image` off the class, the name expression, the
 * font) and therefore keeps using sprites that already exist — `shelter`,
 * `lodging`, `attraction`, `campsite`, `picnic_site`, `drinking_water` are all
 * in the sheet. The matching subclasses are filtered *out* of the base POI
 * layers by the caller, so nothing draws twice.
 *
 * With the outdoor overlay bound (`outdoor`), the same clone is re-pointed at
 * that archive: `wilderness_hut`, `slipway` and `boatyard` appear at all, the
 * reveal drops to z11, and `icon-image` is replaced because the overlay's
 * `class` vocabulary is ours rather than OpenMapTiles'. Everything else — the
 * name expression, font, offsets, halo — still comes from the base style, so
 * the two paths cannot drift apart visually.
 *
 * Without it, the known gap stands, verified against norway.pmtiles rather than
 * assumed: the basemap has no `wilderness_hut` at all — OpenMapTiles maps only
 * `alpine_hut`, `chalet` and the commercial lodging tags into `class=lodging`.
 */
function outdoorPoiLayer(template: StyleLayer, dark: boolean, outdoor: boolean): StyleLayer {
  const layer = JSON.parse(JSON.stringify(template)) as StyleLayer;
  layer.id = OUTDOOR_POI_LAYER_ID;
  // One zoom earlier than the base layer's z15 — and z14 is as early as the
  // basemap can go, because that is where it starts emitting these POIs at all
  // (see BARRIER_MINZOOM). The overlay was built precisely to beat that.
  layer.minzoom = outdoor ? OUTDOOR_MINZOOM : BARRIER_MINZOOM;
  if (outdoor) {
    layer.source = OUTDOOR_SOURCE_ID;
    layer['source-layer'] = OUTDOOR_SOURCE_LAYER;
    layer.layout ??= {};
    layer.layout['icon-image'] = OUTDOOR_ICON_IMAGE;
    // Parking is intentionally broad (`amenity=parking` is the only national
    // trailhead signal), and therefore far more numerous around towns. Place
    // every real outdoor destination first so car parks can fill spare label
    // space without hiding a cabin, cave, ramp or water point.
    layer.layout['symbol-sort-key'] = ['match', ['get', 'class'], 'parking', 10, 0];
  }
  // The template is snapshotted before the theme pass touches it, so the clone
  // still carries Liberty's own `#666` label on a white halo — invisible on the
  // dark basemap. Run the same label tuning the real layers got.
  tuneLabels(layer, dark);
  // Replaces the template's filter outright rather than extending it: the base
  // layer's rank window is exactly what we are overriding, and these features
  // must appear whichever rank bucket they fell into.
  layer.filter = [
    'all',
    ['match', ['geometry-type'], ['MultiPoint', 'Point'], true, false],
    // The overlay is a flat `class` vocabulary of its own; the basemap needs
    // `subclass`, because its classes are far too broad (`lodging` is mostly
    // hotels, `attraction` mostly not a viewpoint).
    outdoor
      ? matchesAny('class', OUTDOOR_POI_CLASSES)
      : matchesAny('subclass', OUTDOOR_POI_SUBCLASSES),
  ];
  // Set rather than multiplied: a profile that recedes the urban POI layers
  // (Fish & Hunt does) must not drag these down with them — the contrast
  // between the two is the whole point.
  paint(layer, 'text-opacity', 1);
  paint(layer, 'icon-opacity', 1);
  return layer;
}

/**
 * Split paved from unpaved on the classes where it matters.
 *
 * The basemap normalises OSM's long tail of surface tags down to `paved` |
 * `unpaved` (verified against norway.pmtiles), and simply **omits** the
 * attribute where OSM says nothing — roughly a quarter of the urban foot
 * network. Only `unpaved` is ever asserted here: an unsurveyed way renders
 * exactly as it did before rather than being claimed as either, which is the
 * same "absent, not 'no data'" rule the Norwegian layers follow.
 *
 * Paths are already dashed, so there is no dash left to vary — they take a
 * colour split. Road lines are solid, so gravel roads take a dash instead;
 * since `line-dasharray` is not data-driven in every MapLibre renderer, that
 * means an exact-surface clone drawn over the asphalt line, the same mechanism
 * as the dashed-track and stairs clones.
 */
function tuneSurface(
  layer: StyleLayer,
  dark: boolean,
  clones: { layer: StyleLayer; baseId: string }[],
): void {
  const gravel = dark ? '#c9a06a' : '#8d6435';
  if (/path_pedestrian$/.test(layer.id)) {
    const current = layer.paint?.['line-color'];
    if (current === undefined) return;
    paint(layer, 'line-color', ['match', ['get', 'surface'], 'unpaved', gravel, current]);
    return;
  }
  if (!isCarRoad(layer) || !/(secondary_tertiary|minor|street)/.test(layer.id)) return;
  const unpaved = JSON.parse(JSON.stringify(layer)) as StyleLayer;
  unpaved.id = `atlas-${layer.id}-unpaved`;
  unpaved.filter = layer.filter
    ? ['all', layer.filter, ['==', ['get', 'surface'], 'unpaved']]
    : ['==', ['get', 'surface'], 'unpaved'];
  paint(unpaved, 'line-color', gravel);
  paint(unpaved, 'line-dasharray', [2.2, 1.3]);
  // Narrower than the road it covers, so the asphalt line still shows as an
  // edge and the gravel reads as a treatment rather than a different road.
  multiplyPaint(unpaved, 'line-width', 0.8);
  clones.push({ layer: unpaved, baseId: layer.id });
}

/**
 * The colour a map with no basemap is drawn on: near-paper in light, near-ink in
 * dark. Deliberately *not* the style's own background (a pale land green) and
 * not a mid grey either — a raster overlay drawn at 80 % opacity takes its cast
 * from whatever is underneath, and the point of switching the basemap off is to
 * see the overlay's own colours and its own edges.
 */
const BLANK_BACKGROUND = { light: '#f5f4f2', dark: '#15171a' };

/**
 * The style for "overlays only": everything the renderer needs and not one
 * drawn layer of the basemap.
 *
 * Sources go with the layers rather than being left declared-but-unused, so no
 * basemap tile is fetched at all — this is also the setting somebody switches on
 * to stop paying for them. `glyphs` and `sprite` stay: the *overlays* draw text
 * (bathymetry depths, route labels) through the same font stack, and dropping
 * them would break those instead.
 */
function blankBasemapStyle(style: MapStyleDocument, dark: boolean): string {
  return JSON.stringify({
    version: style['version'] ?? 8,
    ...(style.name === undefined ? {} : { name: style.name }),
    ...(style['glyphs'] === undefined ? {} : { glyphs: style['glyphs'] }),
    ...(style['sprite'] === undefined ? {} : { sprite: style['sprite'] }),
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': dark ? BLANK_BACKGROUND.dark : BLANK_BACKGROUND.light },
      },
    ],
  });
}

/**
 * Apply Atlas's restrained cartography, dark palette and activity emphasis to
 * the same source style on web and Android. The source URLs and asset paths are
 * untouched, so online templates and downloaded packs remain interchangeable.
 */
export function applyMapAppearance(template: string, appearance: MapAppearance): string {
  const parsed: unknown = JSON.parse(template);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as MapStyleDocument).layers)
  ) {
    throw new Error('Map style has no layers array');
  }
  const style = parsed as MapStyleDocument;
  const dark = appearance.colorScheme === 'dark';
  // Basemap off: there is nothing left for the passes below to tune. Answered
  // here rather than by filtering at the end, so no profile emphasis, outdoor
  // POI layer or barrier clone is computed for a map that will not draw one.
  if (appearance.basemap === false) return blankBasemapStyle(style, dark);
  // Profiles with bespoke cartography. An unknown stored id falls back to
  // `neutral` — the untouched restrained base, which is what a general preset
  // wants (roads and terrain fully visible).
  const profile = [
    'drive',
    'bike',
    'hike',
    'ski',
    'run',
    'explore',
    'fishhunt',
    'curiosities',
  ].includes(appearance.profile)
    ? appearance.profile
    : 'neutral';
  const wantsBarriers = BARRIER_PROFILES.includes(profile);
  const wantsPoi = appearance.poi !== false;
  const wantsOutdoorPoi = wantsPoi && OUTDOOR_POI_PROFILES.includes(profile);
  const wantsHikeCartography = HIKE_CARTOGRAPHY_PROFILES.includes(profile);
  // Bind the overlay archive only where a layer will actually read it, so Drive
  // and Explore never open a source they have no use for.
  const outdoorTiles =
    typeof appearance.outdoorTiles === 'string' && appearance.outdoorTiles.length > 0
      ? appearance.outdoorTiles
      : undefined;
  const useOutdoor =
    outdoorTiles !== undefined && (wantsBarriers || wantsOutdoorPoi || wantsHikeCartography);

  // Exact-class clone layers (dashed tracks, hatched stairs, gravel roads) to
  // splice in right after the shared base layer they refine.
  const insertAfterBase: { layer: StyleLayer; baseId: string }[] = [];
  // How hard this profile leans on the foot network. Kept in one place because
  // a bridge's path casing has to be widened by the same factor as the path it
  // carries, or the deck stops containing the line.
  const pathWidthFactor =
    profile === 'run'
      ? 1.4
      : profile === 'hike' || profile === 'bike'
        ? 1.22
        : profile === 'fishhunt'
          ? 1.15
          : profile === 'explore'
            ? 1.12
            : 1;
  // The base style's own POI layer, used as the template for the outdoor-POI
  // clone and for the barrier layer's source binding — so the source name and
  // the whole icon/text layout come from the style rather than being restated
  // here. A style with no POI layer simply gets neither of the new layers.
  // Snapshotted *before* the loop, which rewrites the real layer's filter to
  // hand the outdoor subclasses over — cloning it afterwards would inherit that
  // exclusion and the new layer would draw nothing.
  const found = style.layers.find((l) => l.type === 'symbol' && l['source-layer'] === 'poi');
  const poiTemplate = found ? (JSON.parse(JSON.stringify(found)) as StyleLayer) : undefined;
  const basePoiLayerIds = new Set(
    style.layers.filter((layer) => layer['source-layer'] === 'poi').map((layer) => layer.id),
  );
  const lastPoiId = [...style.layers].reverse().find((l) => l['source-layer'] === 'poi')?.id;
  const transportationNameTemplate = style.layers.find(
    (l) => l['source-layer'] === 'transportation_name',
  );
  const lastTransportationNameId = [...style.layers]
    .reverse()
    .find((l) => l['source-layer'] === 'transportation_name')?.id;
  for (const layer of style.layers) {
    tuneLightLayer(layer);
    if (dark) tuneDarkLayer(layer);

    // Liberty combines path+pedestrian and service+track. Colour expressions
    // keep the useful classes distinct without requiring a different tile schema.
    if (/path_pedestrian$/.test(layer.id)) {
      paint(layer, 'line-color', [
        'match',
        ['get', 'class'],
        'path',
        profile === 'drive' ? (dark ? '#9b8581' : '#917b77') : dark ? '#e58b84' : '#a94f4b',
        profile === 'drive' ? (dark ? '#8c7d7a' : '#a08d89') : dark ? '#d0a19b' : '#b67870',
      ]);
      paint(layer, 'line-dasharray', [2, 1.35]);
      paint(layer, 'line-opacity', profile === 'drive' ? 0.46 : 0.95);
      // Run leans harder on the foot network than Hike, and reveals it as early.
      if (pathWidthFactor !== 1) multiplyPaint(layer, 'line-width', pathWidthFactor);
      if (profile === 'hike' || profile === 'run')
        layer.minzoom = Math.min(layer.minzoom ?? 14, 12);

      // Stairs are a genuine hazard/landmark on a run — split them off the shared
      // path layer with a tight crosshatch dash once the width is decided.
      if (profile === 'run') {
        const stairs = JSON.parse(JSON.stringify(layer)) as StyleLayer;
        stairs.id = `atlas-${layer.id}-stairs`;
        stairs.filter = layer.filter
          ? ['all', layer.filter, ['==', ['get', 'subclass'], 'steps']]
          : ['==', ['get', 'subclass'], 'steps'];
        paint(stairs, 'line-color', dark ? '#e8a17f' : '#9a5a2f');
        paint(stairs, 'line-dasharray', [0.5, 0.8]);
        paint(stairs, 'line-opacity', 1);
        insertAfterBase.push({ layer: stairs, baseId: layer.id });
      }
    }
    if (/path_pedestrian_casing$/.test(layer.id) && pathWidthFactor !== 1) {
      // Only bridges carry a path casing (the deck edge). Widen it with the
      // line it contains, or an emphasized path overflows its own bridge.
      multiplyPaint(layer, 'line-width', pathWidthFactor);
    }
    if (/service_track$/.test(layer.id)) {
      // The dashed clone spliced in below carries the track's strong brown, so
      // this base layer has to render the *gaps* — painting the same solid
      // brown underneath filled them in and the dash never actually read.
      paint(
        layer,
        'line-color',
        restricted(
          [
            'match',
            ['get', 'class'],
            'track',
            dark ? '#5b4b39' : '#dcc9ac',
            dark ? '#596268' : '#f9f7f2',
          ],
          dark ? '#3f4348' : '#e4e0d8',
        ),
      );
      if (profile === 'hike' || profile === 'bike') multiplyPaint(layer, 'line-width', 1.12);
      if (profile === 'run') multiplyPaint(layer, 'line-width', 1.2);
      if (profile === 'fishhunt') {
        // The forest road *is* the network here — it is how you get to the
        // water, so it is revealed as early as the paths and drawn heaviest.
        multiplyPaint(layer, 'line-width', 1.25);
        layer.minzoom = Math.min(layer.minzoom ?? 14, 12);
      }

      // line-dasharray is not data-driven in every MapLibre renderer. Overlay
      // an exact-class clone so tracks are genuinely dashed while service
      // roads retain the shared layer's solid neutral stroke.
      const track = JSON.parse(JSON.stringify(layer)) as StyleLayer;
      track.id = `atlas-${layer.id}-track-contrast`;
      track.filter = layer.filter
        ? ['all', layer.filter, ['==', ['get', 'class'], 'track']]
        : ['==', ['get', 'class'], 'track'];
      paint(
        track,
        'line-color',
        restricted(dark ? '#c69b68' : '#815f37', dark ? '#6b6257' : '#b6ada0'),
      );
      paint(track, 'line-dasharray', [2.4, 1.4]);
      paint(track, 'line-opacity', 1);
      insertAfterBase.push({ layer: track, baseId: layer.id });
    }

    if (profile === 'drive') {
      if (/(motorway|trunk_primary|secondary_tertiary)/.test(layer.id)) {
        multiplyPaint(layer, 'line-width', 1.12);
      }
      if (/^poi_/.test(layer.id)) {
        paint(layer, 'text-opacity', 0.62);
        paint(layer, 'icon-opacity', 0.58);
      }
    } else if (profile === 'bike' && /path_pedestrian$/.test(layer.id)) {
      paint(layer, 'line-color', dark ? '#65c5bd' : '#227b75');
    } else if (profile === 'run') {
      // Foot network already emphasized above; here we mildly recede the car
      // roads it crosses so the run reads as the primary line.
      if (isCarRoad(layer)) paint(layer, 'line-opacity', 0.72);
    } else if (profile === 'fishhunt') {
      // Wilderness access map: the forest-road network (widened above) and the
      // water carry it, so the through-roads recede a little and the urban POI
      // soup drops well back — the outdoor POI layer appended below is what
      // should catch the eye instead.
      if (isCarRoad(layer)) paint(layer, 'line-opacity', 0.8);
      if (/^poi_/.test(layer.id)) {
        paint(layer, 'text-opacity', 0.55);
        paint(layer, 'icon-opacity', 0.5);
      }
    } else if (profile === 'curiosities') {
      // The overlays *are* the map here: a wall of heritage icons, wreck
      // symbols and mine zones on top of the basemap. So the basemap gets out
      // of their way — through-roads recede and the ordinary POI soup (shops,
      // restaurants, fuel) drops further back than in any other profile, since
      // an amenity icon and a burial-mound icon are the same size on screen and
      // only one of them is what this profile was opened for. Nothing is
      // hidden: everything stays legible at full zoom.
      if (isCarRoad(layer)) paint(layer, 'line-opacity', 0.72);
      if (/^poi_/.test(layer.id)) {
        paint(layer, 'text-opacity', 0.45);
        paint(layer, 'icon-opacity', 0.4);
      }
    } else if (profile === 'ski') {
      tuneWinterLayer(layer, dark);
      if (layer.type === 'line' && /^(road|bridge|tunnel)_/.test(layer.id)) {
        paint(layer, 'line-opacity', 0.62);
      }
      if (/^poi_/.test(layer.id)) {
        paint(layer, 'text-opacity', 0.55);
        paint(layer, 'icon-opacity', 0.5);
      }
    } else if (profile === 'explore') {
      // Urban signature: minor traffic recedes (majors stay legible), POIs and
      // pedestrian streets carry the map, and the city's parks and lawns read
      // as green things worth walking to.
      if (isCarRoad(layer) && /(secondary_tertiary|minor|street|service)/.test(layer.id)) {
        paint(layer, 'line-opacity', 0.7);
      }
      tuneCityGreens(layer, dark);
      if (/^poi_/.test(layer.id)) {
        paint(layer, 'text-opacity', 0.92);
        paint(layer, 'icon-opacity', 0.9);
      }
      // Transit lines the basemap already carries: the `transportation` layer
      // splits `class == rail` (mainline) from `class == transit` (tram/subway/
      // light rail), drawn flat grey and only from ~z14. Explore is the urban
      // profile, so lift them into coloured lines — mainline rail a steel blue
      // revealed earlier, transit an amber accent that fades in only when
      // zoomed in, so the minor lines drop out when zoomed out. The bridge/
      // tunnel and hatching (rail-tie) clones are recoloured to match, so the
      // whole line reads as one colour rather than grey ties over a tint. This
      // is a `match`-free set of plain paints, so it renders on Android too.
      if (layer.type === 'line' && /(major_rail|transit_rail)(_hatching)?$/.test(layer.id)) {
        const isTransit = /transit_rail(_hatching)?$/.test(layer.id);
        const color = isTransit ? (dark ? '#e6a760' : '#c67a1e') : dark ? '#7f93ab' : '#5f7186';
        paint(layer, 'line-color', color);
        // The hatching clone keeps its own dash/width (the ties); only its
        // colour changes. The solid base line gets the zoom fade + width.
        if (!/_hatching$/.test(layer.id)) {
          paint(
            layer,
            'line-opacity',
            isTransit
              ? ['interpolate', ['linear'], ['zoom'], 11.5, 0, 13, 0.85]
              : ['interpolate', ['linear'], ['zoom'], 9.5, 0, 11, 0.9],
          );
          paint(
            layer,
            'line-width',
            isTransit
              ? ['interpolate', ['exponential', 1.4], ['zoom'], 13, 0.6, 15, 1.1, 20, 2.4]
              : ['interpolate', ['exponential', 1.4], ['zoom'], 11, 0.5, 15, 1.2, 20, 2.6],
          );
        }
      }
    }

    // Hand the outdoor subclasses over to the dedicated layer appended below,
    // so they are not drawn twice (and fighting each other for label space)
    // once the base POI layers switch on at their own zooms.
    if (wantsOutdoorPoi && /^poi_/.test(layer.id)) {
      const notOutdoor = ['!', matchesAny('subclass', OUTDOOR_POI_SUBCLASSES)];
      layer.filter = layer.filter ? ['all', layer.filter, notOutdoor] : notOutdoor;
    }

    // Both run after the profile branch: the brunnel pass multiplies the
    // opacity a profile may already have receded a road to, and the surface
    // split then wraps whatever colour the layer settled on — in that order, so
    // a gravel clone taken off a tunnelled road inherits the tunnel's dimming.
    tuneBrunnel(layer, dark);
    if (SURFACE_AWARE_PROFILES.includes(profile)) tuneSurface(layer, dark, insertAfterBase);
  }

  // Appended above the base POI layers (pushed in reverse, since each splice
  // lands directly after the same anchor): barriers below the outdoor icons, so
  // a cabin label is never obscured by the gate beside it.
  if (poiTemplate && lastPoiId) {
    if (wantsHikeCartography && typeof poiTemplate.source === 'string') {
      // Push labels before points because every splice targets the same base:
      // the later point push lands below its label in the final style order.
      const [peakPoint, peakLabel] = summitLayers(poiTemplate.source, dark, false);
      insertAfterBase.push({ layer: peakLabel!, baseId: lastPoiId });
      insertAfterBase.push({ layer: peakPoint!, baseId: lastPoiId });
      if (useOutdoor) {
        const [hillPoint, hillLabel] = summitLayers(OUTDOOR_SOURCE_ID, dark, true);
        insertAfterBase.push({ layer: hillLabel!, baseId: lastPoiId });
        insertAfterBase.push({ layer: hillPoint!, baseId: lastPoiId });
      }
    }
    if (wantsOutdoorPoi) {
      insertAfterBase.push({
        layer: outdoorPoiLayer(poiTemplate, dark, useOutdoor),
        baseId: lastPoiId,
      });
      // Between the icons and the barriers: the ring belongs to the cabin it
      // encircles, and must not sit on top of that cabin's own label.
      if (useOutdoor) {
        insertAfterBase.push({ layer: outdoorHutLayer(dark), baseId: lastPoiId });
      }
    }
    if (wantsBarriers) {
      insertAfterBase.push({
        layer: barrierLayer(poiTemplate, dark, useOutdoor),
        baseId: lastPoiId,
      });
    }
  }

  if (wantsHikeCartography && transportationNameTemplate && lastTransportationNameId) {
    const [networkLine, networkMarkers] = hikingNetworkLayers(transportationNameTemplate, dark);
    // Same reverse-splice rule: line first in the final style, T markers above.
    insertAfterBase.push({ layer: networkMarkers!, baseId: lastTransportationNameId });
    insertAfterBase.push({ layer: networkLine!, baseId: lastTransportationNameId });
  }

  // Declared last, and only once a layer above actually referenced it — an
  // unused source would still cost MapLibre a round of tile requests.
  if (useOutdoor && outdoorTiles !== undefined) {
    const sources =
      style['sources'] && typeof style['sources'] === 'object'
        ? (style['sources'] as Record<string, unknown>)
        : ((style['sources'] = {}) as Record<string, unknown>);
    sources[OUTDOOR_SOURCE_ID] = {
      type: 'vector',
      // A `pmtiles://` archive is opened directly by the renderer (an offline
      // pack's local file, which MapLibre Native reads without a local server);
      // anything else is the backend's z/x/y endpoint.
      ...(outdoorTiles.startsWith('pmtiles://')
        ? { url: outdoorTiles }
        : { tiles: [outdoorTiles] }),
      minzoom: 0,
      maxzoom: OUTDOOR_MAXZOOM,
      attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>',
    };
  }

  for (const { layer, baseId } of insertAfterBase) {
    const baseIndex = style.layers.findIndex((l) => l.id === baseId);
    style.layers.splice(baseIndex + 1, 0, layer);
  }

  // POIs are map content, not a fetched overlay. Remove the Liberty POI
  // layers only after the supplemental layers have used them as insertion
  // anchors. The id snapshot deliberately leaves gate/barrier clones intact
  // even when an older basemap is their only source.
  if (!wantsPoi) {
    style.layers = style.layers.filter((layer) => !basePoiLayerIds.has(layer.id));
  }

  const terrainTiles =
    appearance.terrain === true &&
    typeof appearance.terrainTiles === 'string' &&
    appearance.terrainTiles.length > 0
      ? appearance.terrainTiles
      : null;
  if (terrainTiles) {
    addTerrain(style, terrainTiles, dark);
  }

  if (appearance.custom) {
    const custom = sanitizeMapStyleOverrides(appearance.custom);
    for (const layer of style.layers) applyCustomStyle(layer, custom);
  }

  style.name = `Atlas ${dark ? 'Dark' : 'Light'} · ${profile}${terrainTiles ? ' · 3D' : ''}`;
  return JSON.stringify(style);
}
