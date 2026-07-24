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

/** A drivable-road line layer — excludes the shared path/track and helper strokes. */
function isCarRoad(layer: StyleLayer): boolean {
  return (
    layer.type === 'line' &&
    /^road_/.test(layer.id) &&
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
  if (
    custom.roadColor &&
    layer.type === 'line' &&
    /^road_/.test(layer.id) &&
    !/(path_pedestrian|service_track|_casing|_hatching)$/.test(layer.id)
  ) {
    paint(layer, 'line-color', custom.roadColor);
  }
  if (custom.pathColor && /(path_pedestrian|service_track|-track-contrast)$/.test(layer.id)) {
    paint(layer, 'line-color', custom.pathColor);
  }
  if (layer.type !== 'symbol') return;
  if (custom.labelScale !== 1 && layer.layout?.['text-size'] !== undefined) {
    layer.layout['text-size'] = multiplyStyleValue(layer.layout['text-size'], custom.labelScale);
  }
  if (/^poi_/.test(layer.id) && custom.poiScale !== 1) {
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
  // Profiles with bespoke cartography. Anything else (Fish & Hunt, an unknown
  // stored id) falls back to `neutral` — the untouched restrained base, which is
  // what those wilderness/general presets want (roads and terrain fully visible).
  const profile = ['drive', 'bike', 'hike', 'ski', 'run', 'explore'].includes(appearance.profile)
    ? appearance.profile
    : 'neutral';

  // Exact-class clone layers (dashed tracks, hatched stairs) to splice in right
  // after the shared base layer they refine.
  const insertAfterBase: { layer: StyleLayer; baseId: string }[] = [];
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
        dark ? '#e58b84' : '#a94f4b',
        dark ? '#d0a19b' : '#b67870',
      ]);
      paint(layer, 'line-dasharray', [2, 1.35]);
      paint(layer, 'line-opacity', profile === 'drive' ? 0.62 : 0.95);
      if (profile === 'hike' || profile === 'bike') multiplyPaint(layer, 'line-width', 1.22);
      if (profile === 'explore') multiplyPaint(layer, 'line-width', 1.12);
      // Run leans harder on the foot network than Hike, and reveals it as early.
      if (profile === 'run') multiplyPaint(layer, 'line-width', 1.4);
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
    if (/service_track$/.test(layer.id)) {
      paint(layer, 'line-color', [
        'match',
        ['get', 'class'],
        'track',
        dark ? '#c69b68' : '#815f37',
        dark ? '#596268' : '#f9f7f2',
      ]);
      if (profile === 'hike' || profile === 'bike') multiplyPaint(layer, 'line-width', 1.12);
      if (profile === 'run') multiplyPaint(layer, 'line-width', 1.2);

      // line-dasharray is not data-driven in every MapLibre renderer. Overlay
      // an exact-class clone so tracks are genuinely dashed while service
      // roads retain the shared layer's solid neutral stroke.
      const track = JSON.parse(JSON.stringify(layer)) as StyleLayer;
      track.id = `atlas-${layer.id}-track-contrast`;
      track.filter = layer.filter
        ? ['all', layer.filter, ['==', ['get', 'class'], 'track']]
        : ['==', ['get', 'class'], 'track'];
      paint(track, 'line-color', dark ? '#c69b68' : '#815f37');
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
    } else if (profile === 'ski') {
      tuneWinterLayer(layer, dark);
      if (layer.type === 'line' && /^road_/.test(layer.id)) {
        paint(layer, 'line-opacity', 0.62);
      }
      if (/^poi_/.test(layer.id)) {
        paint(layer, 'text-opacity', 0.55);
        paint(layer, 'icon-opacity', 0.5);
      }
    } else if (profile === 'explore') {
      // Urban signature: minor traffic recedes (majors stay legible), POIs and
      // pedestrian streets carry the map.
      if (isCarRoad(layer) && /(secondary_tertiary|minor|street|service)/.test(layer.id)) {
        paint(layer, 'line-opacity', 0.7);
      }
      if (/^poi_/.test(layer.id)) {
        paint(layer, 'text-opacity', 0.92);
        paint(layer, 'icon-opacity', 0.9);
      }
    }
  }

  for (const { layer, baseId } of insertAfterBase) {
    const baseIndex = style.layers.findIndex((l) => l.id === baseId);
    style.layers.splice(baseIndex + 1, 0, layer);
  }

  if (appearance.custom) {
    const custom = sanitizeMapStyleOverrides(appearance.custom);
    for (const layer of style.layers) applyCustomStyle(layer, custom);
  }

  style.name = `Atlas ${dark ? 'Dark' : 'Light'} · ${profile}`;
  return JSON.stringify(style);
}
