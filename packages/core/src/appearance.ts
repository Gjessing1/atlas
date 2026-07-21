/** A per-device UI preference; `system` follows the operating system live. */
export type ThemeMode = 'system' | 'light' | 'dark';

export type ColorScheme = Exclude<ThemeMode, 'system'>;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

export interface MapAppearance {
  colorScheme: ColorScheme;
  /** One of Atlas's curated activity profile ids. Unknown ids degrade to Explore. */
  profile: string;
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
  } else if (current !== undefined) {
    paint(layer, property, ['*', current, factor]);
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
  const profile = ['drive', 'bike', 'hike', 'ski'].includes(appearance.profile)
    ? appearance.profile
    : 'explore';

  const trackContrastLayers: StyleLayer[] = [];
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
      if (profile === 'hike') layer.minzoom = Math.min(layer.minzoom ?? 14, 12);
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
      trackContrastLayers.push(track);
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
    } else if (profile === 'ski') {
      if (layer.type === 'line' && /^road_/.test(layer.id)) {
        paint(layer, 'line-opacity', 0.62);
      }
      if (/^poi_/.test(layer.id)) {
        paint(layer, 'text-opacity', 0.55);
        paint(layer, 'icon-opacity', 0.5);
      }
    }
  }

  for (const track of trackContrastLayers) {
    const baseId = track.id.replace(/^atlas-/, '').replace(/-track-contrast$/, '');
    const baseIndex = style.layers.findIndex((layer) => layer.id === baseId);
    style.layers.splice(baseIndex + 1, 0, track);
  }

  style.name = `Atlas ${dark ? 'Dark' : 'Light'} · ${profile}`;
  return JSON.stringify(style);
}
