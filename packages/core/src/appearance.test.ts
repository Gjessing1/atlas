import { describe, expect, it } from 'vitest';
import { applyMapAppearance, isThemeMode } from './appearance.js';

const style = JSON.stringify({
  version: 8,
  sources: {},
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
    { id: 'water', type: 'fill', paint: { 'fill-color': '#00f' } },
    { id: 'landcover_wood', type: 'fill', paint: { 'fill-color': '#0f0' } },
    { id: 'landcover_grass', type: 'fill', paint: { 'fill-color': '#0f0' } },
    { id: 'park', type: 'fill', paint: { 'fill-color': '#0f0', 'fill-opacity': 0.7 } },
    {
      id: 'park_outline',
      type: 'line',
      paint: { 'line-color': '#eee', 'line-dasharray': [1, 1.5] },
    },
    { id: 'landuse_pitch', type: 'fill', paint: { 'fill-color': '#0f0' } },
    { id: 'landuse_residential', type: 'fill', paint: { 'fill-color': '#eee' } },
    { id: 'building', type: 'fill', paint: { 'fill-color': '#ddd' } },
    {
      id: 'building-3d',
      type: 'fill-extrusion',
      paint: { 'fill-extrusion-color': '#ddd', 'fill-extrusion-opacity': 0.8 },
    },
    {
      id: 'road_path_pedestrian',
      type: 'line',
      minzoom: 14,
      paint: {
        'line-color': '#fff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1, 20, 8],
      },
    },
    {
      id: 'road_service_track',
      type: 'line',
      paint: { 'line-color': '#fff', 'line-width': 2 },
    },
    {
      id: 'road_secondary_tertiary',
      type: 'line',
      paint: {
        'line-color': '#fea',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 20, 13],
      },
    },
    {
      id: 'road_minor',
      type: 'line',
      filter: ['==', ['get', 'class'], 'minor'],
      paint: { 'line-color': '#fff', 'line-width': 4 },
    },
    {
      id: 'bridge_secondary_tertiary',
      type: 'line',
      paint: { 'line-color': '#fea', 'line-width': 6 },
    },
    { id: 'bridge_secondary_tertiary_casing', type: 'line', paint: { 'line-color': '#cfcdca' } },
    {
      id: 'bridge_path_pedestrian',
      type: 'line',
      paint: { 'line-color': '#fff', 'line-width': 5 },
    },
    {
      id: 'bridge_path_pedestrian_casing',
      type: 'line',
      paint: { 'line-color': '#ccc', 'line-width': 10 },
    },
    {
      id: 'tunnel_secondary_tertiary',
      type: 'line',
      paint: { 'line-color': '#fea', 'line-width': 6 },
    },
    { id: 'tunnel_secondary_tertiary_casing', type: 'line', paint: { 'line-color': '#e9ac77' } },
    {
      id: 'road_major_rail',
      type: 'line',
      paint: {
        'line-color': '#bbb',
        'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 14, 0.4, 20, 2],
      },
    },
    {
      id: 'road_transit_rail',
      type: 'line',
      paint: {
        'line-color': '#bbb',
        'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 14, 0.4, 20, 2],
      },
    },
    {
      id: 'road_transit_rail_hatching',
      type: 'line',
      paint: { 'line-color': '#bbb', 'line-dasharray': [0.2, 8], 'line-width': 3 },
    },
    { id: 'label_city', type: 'symbol', paint: { 'text-color': '#000' } },
    {
      id: 'poi_r1',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'poi',
      minzoom: 15,
      filter: ['>=', ['get', 'rank'], 1],
      layout: { 'text-size': 12, 'icon-size': 1, 'icon-image': ['get', 'class'] },
      paint: { 'text-color': '#000' },
    },
    {
      id: 'poi_transit',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'poi',
      layout: { 'text-size': 12 },
      paint: { 'text-color': '#000' },
    },
    {
      id: 'route_names',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'transportation_name',
      layout: { 'text-size': 12 },
      paint: { 'text-color': '#000' },
    },
  ],
});

interface TestLayer {
  id: string;
  type?: string;
  minzoom?: number;
  filter?: unknown;
  source?: string;
  'source-layer'?: string;
  layout?: Record<string, unknown>;
  paint: Record<string, unknown>;
}

function layers(result: string): TestLayer[] {
  return (JSON.parse(result) as { layers: TestLayer[] }).layers;
}

describe('map appearance', () => {
  it('adds restrained high-contrast path and track rendering', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'explore' }));
    expect(result.find((layer) => layer.id === 'background')?.paint['background-color']).toBe(
      '#f5f3ee',
    );
    expect(
      result.find((layer) => layer.id === 'road_path_pedestrian')?.paint['line-color'],
    ).toEqual(['match', ['get', 'class'], 'path', '#a94f4b', '#b67870']);
    // The base layer renders the dash *gaps* — a solid brown underneath the
    // clone would fill them in and the track would read as an unbroken line.
    // Wrapped in the access case, so a barred forest road is muted while an
    // unrestricted one keeps the class colours.
    expect(result.find((layer) => layer.id === 'road_service_track')?.paint['line-color']).toEqual([
      'case',
      ['==', ['get', 'access'], 'no'],
      '#e4e0d8',
      ['match', ['get', 'class'], 'track', '#dcc9ac', '#f9f7f2'],
    ]);
    const track = result.find((layer) => layer.id === 'atlas-road_service_track-track-contrast');
    expect(track?.paint['line-dasharray']).toEqual([2.4, 1.4]);
    expect(track?.paint['line-color']).toEqual([
      'case',
      ['==', ['get', 'access'], 'no'],
      '#b6ada0',
      '#815f37',
    ]);
  });

  it('uses a dark basemap and lets Hike reveal and emphasize paths earlier', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'dark', profile: 'hike' }));
    expect(result.find((layer) => layer.id === 'background')?.paint['background-color']).toBe(
      '#1d2427',
    );
    expect(result.find((layer) => layer.id === 'water')?.paint['fill-color']).toBe('#1d4358');
    expect(result.find((layer) => layer.id === 'road_path_pedestrian')?.minzoom).toBe(12);
    expect(
      result.find((layer) => layer.id === 'road_path_pedestrian')?.paint['line-width'],
    ).toEqual(['interpolate', ['linear'], ['zoom'], 14, 1.22, 20, 9.76]);
    expect(result.find((layer) => layer.id === 'road_service_track')?.paint['line-width']).toBe(
      2.24,
    );
    expect(result.find((layer) => layer.id === 'label_city')?.paint['text-color']).toBe('#eef2f5');
  });

  it('draws ranked summits, named hills and relation-derived red-T hiking networks', () => {
    const parsed = JSON.parse(
      applyMapAppearance(style, {
        colorScheme: 'light',
        profile: 'hike',
        outdoorTiles: 'https://atlas.test/api/tiles/outdoor/{z}/{x}/{y}.pbf',
      }),
    ) as { layers: TestLayer[] };

    const peak = parsed.layers.find((layer) => layer.id === 'atlas-summit-labels');
    expect(peak?.source).toBe('openmaptiles');
    expect(peak?.['source-layer']).toBe('mountain_peak');
    expect(peak?.layout?.['symbol-sort-key']).toEqual(['coalesce', ['get', 'rank'], 99]);
    expect(JSON.stringify(peak?.layout?.['text-field'])).toContain('\\n');

    const hill = parsed.layers.find((layer) => layer.id === 'atlas-outdoor-summit-labels');
    expect(hill?.source).toBe('atlas-outdoor');
    expect(hill?.minzoom).toBe(12);
    expect(hill?.filter).toContainEqual(['match', ['get', 'class'], ['hill'], true, false]);

    const network = parsed.layers.find((layer) => layer.id === 'atlas-hiking-network');
    const markers = parsed.layers.find((layer) => layer.id === 'atlas-hiking-network-markers');
    expect(network?.['source-layer']).toBe('transportation_name');
    expect(network?.filter).toContainEqual([
      'any',
      ['match', ['get', 'route_1_network'], ['iwn', 'nwn', 'rwn'], true, false],
      ['match', ['get', 'route_2_network'], ['iwn', 'nwn', 'rwn'], true, false],
      ['match', ['get', 'route_3_network'], ['iwn', 'nwn', 'rwn'], true, false],
    ]);
    expect(markers?.layout?.['text-field']).toBe('T');
    expect(markers?.filter).toContainEqual([
      'any',
      ['has', 'route_1_ref'],
      ['has', 'route_2_ref'],
      ['has', 'route_3_ref'],
    ]);
    expect(parsed.layers.indexOf(network!)).toBeLessThan(parsed.layers.indexOf(markers!));
  });

  it('keeps hike-only summits and network markers off unrelated profiles', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'drive' }));
    expect(result.some((layer) => layer.id.includes('summit'))).toBe(false);
    expect(result.some((layer) => layer.id.startsWith('atlas-hiking-network'))).toBe(false);
  });

  it('widens driving roads without wrapping native-incompatible width expressions', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'drive' }));
    expect(
      result.find((layer) => layer.id === 'road_secondary_tertiary')?.paint['line-width'],
    ).toEqual(['interpolate', ['linear'], ['zoom'], 8, 0.56, 20, 14.560000000000002]);
  });

  it('emphasizes the foot network and splits stairs off for Run', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'run' }));
    expect(
      result.find((layer) => layer.id === 'road_path_pedestrian')?.paint['line-width'],
    ).toEqual(['interpolate', ['linear'], ['zoom'], 14, 1.4, 20, 11.2]);
    expect(result.find((layer) => layer.id === 'road_path_pedestrian')?.minzoom).toBe(12);
    // Car roads recede so the run reads as the primary line.
    expect(
      result.find((layer) => layer.id === 'road_secondary_tertiary')?.paint['line-opacity'],
    ).toBe(0.72);
    const stairs = result.find((layer) => layer.id === 'atlas-road_path_pedestrian-stairs');
    expect(stairs?.paint['line-dasharray']).toEqual([0.5, 0.8]);
    expect(stairs?.filter).toEqual(['==', ['get', 'subclass'], 'steps']);
  });

  it('keeps bridges and tunnels reading as one road with the surface layer', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'run' }));
    // Liberty splits every class into road_/bridge_/tunnel_ layers, so an
    // emphasis that only matched road_ snapped back at every crossing.
    expect(
      result.find((layer) => layer.id === 'bridge_secondary_tertiary')?.paint['line-opacity'],
    ).toBe(0.72);
    // Tunnelled lines are drawn weaker still — the profile's 0.72, dimmed.
    expect(
      result.find((layer) => layer.id === 'tunnel_secondary_tertiary')?.paint['line-opacity'],
    ).toBeCloseTo(0.72 * 0.72);
    // The two cues that make a crossing read: a dashed, lighter tunnel casing
    // and a darkened bridge deck edge.
    const tunnelCasing = result.find(
      (layer) => layer.id === 'tunnel_secondary_tertiary_casing',
    )?.paint;
    expect(tunnelCasing?.['line-dasharray']).toEqual([0.5, 0.25]);
    expect(tunnelCasing?.['line-color']).toBe('#c2beb6');
    expect(
      result.find((layer) => layer.id === 'bridge_secondary_tertiary_casing')?.paint['line-color'],
    ).toBe('#8e887e');
    // A widened path must not overflow the bridge deck that carries it.
    expect(
      result.find((layer) => layer.id === 'bridge_path_pedestrian_casing')?.paint['line-width'],
    ).toBeCloseTo(14);
  });

  it('marks unpaved ways for on-the-ground profiles and asserts nothing otherwise', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'hike' }));
    // Paths are already dashed, so the split is a colour wrapped around
    // whatever the profile settled on. An absent `surface` falls through.
    expect(
      result.find((layer) => layer.id === 'road_path_pedestrian')?.paint['line-color'],
    ).toEqual([
      'match',
      ['get', 'surface'],
      'unpaved',
      '#8d6435',
      ['match', ['get', 'class'], 'path', '#a94f4b', '#b67870'],
    ]);
    // Road lines are solid, and line-dasharray is not data-driven, so gravel
    // roads get an exact-surface dashed clone over the asphalt line.
    const gravel = result.find((layer) => layer.id === 'atlas-road_minor-unpaved');
    expect(gravel?.filter).toEqual([
      'all',
      ['==', ['get', 'class'], 'minor'],
      ['==', ['get', 'surface'], 'unpaved'],
    ]);
    expect(gravel?.paint['line-dasharray']).toEqual([2.2, 1.3]);
    expect(gravel?.paint['line-width']).toBeCloseTo(3.2);
  });

  it('leaves the surface split out of Drive, where it would only add noise', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'drive' }));
    expect(result.some((layer) => layer.id === 'atlas-road_minor-unpaved')).toBe(false);
    expect(
      result.find((layer) => layer.id === 'road_path_pedestrian')?.paint['line-color'],
    ).toEqual(['match', ['get', 'class'], 'path', '#917b77', '#a08d89']);
  });

  it('paints frozen-lake winter cartography for Ski', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'ski' }));
    const water = result.find((layer) => layer.id === 'water')?.paint;
    // Inland water freezes and reads as traversable snow; the sea keeps a
    // bluer open-water colour because salt water rarely freezes solid.
    expect(water?.['fill-color']).toEqual([
      'match',
      ['get', 'class'],
      'ocean',
      '#b9d4e6',
      '#eaf1f6',
    ]);
    expect(water?.['fill-outline-color']).toEqual([
      'match',
      ['get', 'class'],
      'ocean',
      '#8fb8d0',
      '#b7d0e0',
    ]);
    expect(result.find((layer) => layer.id === 'background')?.paint['background-color']).toBe(
      '#eef2f2',
    );
    // Forest and neighbourhoods must stay legible against the snow, not wash out.
    const wood = result.find((layer) => layer.id === 'landcover_wood')?.paint;
    expect(wood?.['fill-color']).toBe('#c7ddc4');
    expect(wood?.['fill-opacity']).toBe(0.85);
    expect(result.find((layer) => layer.id === 'landuse_residential')?.paint['fill-color']).toBe(
      '#e5e2e6',
    );
  });

  it('recedes minor traffic and lifts POIs for Explore', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'explore' }));
    expect(
      result.find((layer) => layer.id === 'road_secondary_tertiary')?.paint['line-opacity'],
    ).toBe(0.7);
    expect(result.find((layer) => layer.id === 'poi_r1')?.paint['text-opacity']).toBe(0.92);
    // Transit signature: mainline rail steel-blue and revealed earlier, tram/
    // subway amber and fading in only when zoomed in (minor lines drop out).
    const rail = result.find((layer) => layer.id === 'road_major_rail')?.paint;
    expect(rail?.['line-color']).toBe('#5f7186');
    expect(rail?.['line-opacity']).toEqual(['interpolate', ['linear'], ['zoom'], 9.5, 0, 11, 0.9]);
    const transit = result.find((layer) => layer.id === 'road_transit_rail')?.paint;
    expect(transit?.['line-color']).toBe('#c67a1e');
    expect(transit?.['line-opacity']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      11.5,
      0,
      13,
      0.85,
    ]);
    // The hatching (rail-tie) clone is recoloured to match but keeps its dash.
    const hatch = result.find((layer) => layer.id === 'road_transit_rail_hatching')?.paint;
    expect(hatch?.['line-color']).toBe('#c67a1e');
    expect(hatch?.['line-dasharray']).toEqual([0.2, 8]);
  });

  it('darkens the 3D building extrusions with the flat footprints', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'dark', profile: 'explore' }));
    // Both layers draw the same footprints; the extrusion takes over at z15, so
    // leaving it behind lit the whole city white over a dark basemap.
    expect(result.find((layer) => layer.id === 'building')?.paint['fill-color']).toBe('#363b3e');
    expect(result.find((layer) => layer.id === 'building-3d')?.paint['fill-extrusion-color']).toBe(
      '#363b3e',
    );
    const light = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'explore' }));
    expect(light.find((layer) => layer.id === 'building-3d')?.paint['fill-extrusion-color']).toBe(
      '#ddd',
    );
  });

  it('paints the city greens as findable green on Explore', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'explore' }));
    const park = result.find((layer) => layer.id === 'park')?.paint;
    expect(park?.['fill-color']).toBe('#c2e3b0');
    // Well above the 0.55 wash the shared light tune leaves parks at.
    expect(park?.['fill-opacity']).toBe(0.8);
    expect(park?.['fill-outline-color']).toBe('#7fb073');
    const grass = result.find((layer) => layer.id === 'landcover_grass')?.paint;
    expect(grass?.['fill-color']).toBe('#cbe7b6');
    expect(grass?.['fill-opacity']).toBe(0.62);
    expect(result.find((layer) => layer.id === 'landuse_pitch')?.paint['fill-color']).toBe(
      '#b7dea4',
    );
    // The boundary dash survives; only its (invisible) colour changes.
    const outline = result.find((layer) => layer.id === 'park_outline')?.paint;
    expect(outline?.['line-color']).toBe('#7cae70');
    expect(outline?.['line-dasharray']).toEqual([1, 1.5]);

    const dark = layers(applyMapAppearance(style, { colorScheme: 'dark', profile: 'explore' }));
    expect(dark.find((layer) => layer.id === 'park')?.paint['fill-color']).toBe('#2f4a37');
  });

  it('leaves the city greens as a quiet wash outside Explore', () => {
    for (const profile of ['drive', 'hike', 'neutral']) {
      const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile }));
      expect(result.find((layer) => layer.id === 'park')?.paint['fill-color']).toBe('#dce8d4');
      expect(result.find((layer) => layer.id === 'landcover_grass')?.paint['fill-opacity']).toBe(
        0.28,
      );
    }
  });

  it('leaves rail flat grey outside the Explore profile', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'hike' }));
    expect(result.find((layer) => layer.id === 'road_major_rail')?.paint['line-color']).toBe(
      '#bbb',
    );
  });

  it('draws gates and lift gates as a sprite-free point layer for access profiles', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'fishhunt' }));
    const barriers = result.find((layer) => layer.id === 'atlas-barriers');
    // A circle, not a symbol: the sprite sheet has no gate image, which is why
    // the base style rendered these features as nothing at all.
    expect(barriers?.type).toBe('circle');
    expect(barriers?.['source-layer']).toBe('poi');
    expect(barriers?.source).toBe('openmaptiles');
    // The data's floor, not a styling choice: the basemap emits the low-rank
    // POIs only from z14, so asking for an earlier reveal would be a no-op.
    expect(barriers?.minzoom).toBe(14);
    expect(barriers?.filter).toEqual([
      'match',
      ['get', 'class'],
      ['gate', 'lift_gate'],
      true,
      false,
    ]);
    // The locked bom reads differently from an openable field gate.
    expect(barriers?.paint['circle-color']).toEqual([
      'match',
      ['get', 'class'],
      ['lift_gate', 'swing_gate'],
      '#c0392b',
      '#c8801c',
    ]);
    // Above the base POI layers, and below the outdoor icons.
    const ids = result.map((layer) => layer.id);
    expect(ids.indexOf('atlas-barriers')).toBeGreaterThan(ids.indexOf('poi_transit'));
    expect(ids.indexOf('atlas-barriers')).toBeLessThan(ids.indexOf('atlas-outdoor-poi'));
  });

  it('leaves barriers and outdoor POIs out of the profiles they would clutter', () => {
    for (const profile of ['drive', 'explore', 'run', 'ski']) {
      const ids = layers(applyMapAppearance(style, { colorScheme: 'light', profile })).map(
        (layer) => layer.id,
      );
      expect(ids).not.toContain('atlas-barriers');
      expect(ids).not.toContain('atlas-outdoor-poi');
    }
    // Cycling wants the gates (they stop a bike too) but not the cabin icons.
    const bike = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'bike' })).map(
      (layer) => layer.id,
    );
    expect(bike).toContain('atlas-barriers');
    expect(bike).not.toContain('atlas-outdoor-poi');
  });

  it('lifts cabins and shelters into their own layer, and off the base POI layers', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'hike' }));
    const outdoor = result.find((layer) => layer.id === 'atlas-outdoor-poi');
    expect(outdoor?.type).toBe('symbol');
    // Cloned from the base layer, so it keeps the icon/text plumbing and the
    // sprites that already exist — but revealed two zooms earlier.
    expect(outdoor?.layout?.['icon-image']).toEqual(['get', 'class']);
    expect(outdoor?.minzoom).toBe(14);
    expect(outdoor?.minzoom).toBeLessThan(15); // earlier than the base poi_r1
    // Not the base layer's rank window: these must show whichever bucket they
    // landed in.
    expect(JSON.stringify(outdoor?.filter)).not.toContain('rank');
    expect(JSON.stringify(outdoor?.filter)).toContain('alpine_hut');
    // Full strength even where the profile recedes the urban POI soup.
    expect(outdoor?.paint['text-opacity']).toBe(1);
    expect(outdoor?.paint['icon-opacity']).toBe(1);
    // The template is snapshotted before the theme pass, so the clone has to be
    // label-tuned itself — otherwise it keeps the source style's dark-on-white
    // label, which is invisible on the dark basemap.
    const dark = layers(applyMapAppearance(style, { colorScheme: 'dark', profile: 'hike' })).find(
      (layer) => layer.id === 'atlas-outdoor-poi',
    );
    expect(dark?.paint['text-color']).toBe('#aeb6bc');
    expect(dark?.paint['text-halo-color']).toBe('#182024');
    // The base layers hand those subclasses over, so nothing draws twice.
    const base = result.find((layer) => layer.id === 'poi_r1');
    expect(JSON.stringify(base?.filter)).toContain('alpine_hut');
    expect(base?.filter).toEqual([
      'all',
      ['>=', ['get', 'rank'], 1],
      ['!', ['match', ['get', 'subclass'], expect.arrayContaining(['shelter']), true, false]],
    ]);
  });

  it('binds the outdoor layers to the overlay archive when one is supplied', () => {
    const parsed = JSON.parse(
      applyMapAppearance(style, {
        colorScheme: 'light',
        profile: 'hike',
        outdoorTiles: 'https://atlas.example/api/tiles/outdoor/{z}/{x}/{y}.pbf',
      }),
    ) as { layers: TestLayer[]; sources: Record<string, Record<string, unknown>> };

    expect(parsed.sources['atlas-outdoor']).toEqual({
      type: 'vector',
      tiles: ['https://atlas.example/api/tiles/outdoor/{z}/{x}/{y}.pbf'],
      minzoom: 0,
      maxzoom: 14,
      attribution: expect.stringContaining('OpenStreetMap'),
    });

    const outdoor = parsed.layers.find((layer) => layer.id === 'atlas-outdoor-poi');
    expect(outdoor?.source).toBe('atlas-outdoor');
    expect(outdoor?.['source-layer']).toBe('outdoor');
    // The whole point of the archive: three zooms earlier than the basemap can
    // emit these at all.
    expect(outdoor?.minzoom).toBe(11);
    // The overlay's own flat vocabulary, including the classes OpenMapTiles
    // does not carry.
    const filter = JSON.stringify(outdoor?.filter);
    expect(filter).toContain('wilderness_hut');
    expect(filter).toContain('slipway');
    expect(filter).toContain('boatyard');
    expect(filter).toContain('parking');
    expect(filter).not.toContain('subclass');
    // Icons are remapped because `class` no longer means what the base style
    // assumed — but every target is a sprite that already ships.
    expect(JSON.stringify(outdoor?.layout?.['icon-image'])).toContain('lodging');
    expect(outdoor?.layout?.['symbol-sort-key']).toEqual([
      'match',
      ['get', 'class'],
      'parking',
      10,
      0,
    ]);
    // Text plumbing still comes from the base style (the clone only replaces
    // the icon), so the two paths cannot drift apart visually.
    expect(outdoor?.layout?.['text-size']).toBe(12);

    const barriers = parsed.layers.find((layer) => layer.id === 'atlas-barriers');
    expect(barriers?.source).toBe('atlas-outdoor');
    expect(barriers?.minzoom).toBe(11);
    expect(JSON.stringify(barriers?.filter)).toContain('swing_gate');
  });

  it('splits staffed from self-service cabins only where the overlay can tell them apart', () => {
    const withOverlay = layers(
      applyMapAppearance(style, {
        colorScheme: 'light',
        profile: 'hike',
        outdoorTiles: 'pmtiles://file:///data/packs/oslo/outdoor.pmtiles',
      }),
    );
    const ring = withOverlay.find((layer) => layer.id === 'atlas-outdoor-hut');
    expect(ring?.type).toBe('circle');
    // A ring, not a disc: the cabin icon has to stay readable inside it.
    expect(ring?.paint['circle-opacity']).toBe(0);
    expect(ring?.paint['circle-stroke-width']).toBe(2);
    expect(JSON.stringify(ring?.paint['circle-stroke-color'])).toContain('wilderness_hut');
    // Drawn under the icons it encircles.
    const ids = withOverlay.map((layer) => layer.id);
    expect(ids.indexOf('atlas-outdoor-hut')).toBeLessThan(ids.indexOf('atlas-outdoor-poi'));

    // Without the archive there is no `wilderness_hut` in the data at all, so
    // the split would be a lie rather than a missing feature.
    const withoutOverlay = layers(
      applyMapAppearance(style, { colorScheme: 'light', profile: 'hike' }),
    ).map((layer) => layer.id);
    expect(withoutOverlay).not.toContain('atlas-outdoor-hut');
  });

  it('reads an offline pack archive as a pmtiles url, not a tile template', () => {
    const parsed = JSON.parse(
      applyMapAppearance(style, {
        colorScheme: 'light',
        profile: 'fishhunt',
        outdoorTiles: 'pmtiles://file:///data/packs/oslo/outdoor.pmtiles',
      }),
    ) as { sources: Record<string, Record<string, unknown>> };
    expect(parsed.sources['atlas-outdoor']?.['url']).toBe(
      'pmtiles://file:///data/packs/oslo/outdoor.pmtiles',
    );
    expect(parsed.sources['atlas-outdoor']?.['tiles']).toBeUndefined();
  });

  it('never opens the overlay source for a profile that draws none of its layers', () => {
    for (const profile of ['drive', 'explore', 'run', 'ski']) {
      const parsed = JSON.parse(
        applyMapAppearance(style, {
          colorScheme: 'light',
          profile,
          outdoorTiles: 'https://atlas.example/api/tiles/outdoor/{z}/{x}/{y}.pbf',
        }),
      ) as { sources?: Record<string, unknown> };
      expect(parsed.sources?.['atlas-outdoor']).toBeUndefined();
    }
  });

  it('keeps the basemap-cloned layers when no overlay archive is supplied', () => {
    const parsed = JSON.parse(
      applyMapAppearance(style, { colorScheme: 'light', profile: 'hike' }),
    ) as { layers: TestLayer[]; sources?: Record<string, unknown> };
    expect(parsed.sources?.['atlas-outdoor']).toBeUndefined();
    const outdoor = parsed.layers.find((layer) => layer.id === 'atlas-outdoor-poi');
    expect(outdoor?.source).toBe('openmaptiles');
    expect(outdoor?.minzoom).toBe(14);
  });

  it('recedes urban POIs but not the outdoor ones on Fish & Hunt', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'fishhunt' }));
    expect(result.find((layer) => layer.id === 'poi_r1')?.paint['icon-opacity']).toBe(0.5);
    expect(result.find((layer) => layer.id === 'atlas-outdoor-poi')?.paint['icon-opacity']).toBe(1);
    // Forest roads are the network: widened, and revealed with the paths.
    const track = result.find((layer) => layer.id === 'road_service_track');
    expect(track?.paint['line-width']).toBe(2 * 1.25);
    expect(track?.minzoom).toBe(12);
    expect(
      result.find((layer) => layer.id === 'road_secondary_tertiary')?.paint['line-opacity'],
    ).toBe(0.8);
  });

  it('keeps pedestrian paths visible but subordinate on Drive', () => {
    const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'drive' }));
    const paths = result.find((layer) => layer.id === 'road_path_pedestrian');
    expect(paths?.paint['line-color']).toEqual([
      'match',
      ['get', 'class'],
      'path',
      '#917b77',
      '#a08d89',
    ]);
    expect(paths?.paint['line-opacity']).toBe(0.46);
  });

  it('mutes access-restricted tracks on every profile without asserting the unsurveyed ones', () => {
    for (const profile of ['drive', 'fishhunt']) {
      const result = layers(applyMapAppearance(style, { colorScheme: 'light', profile }));
      const dashed = result.find((layer) => layer.id === 'atlas-road_service_track-track-contrast');
      // A `case`, so a way with no `access` attribute keeps the normal colour —
      // absent is not "forbidden", the same rule the surface split follows.
      expect(dashed?.paint['line-color']).toEqual([
        'case',
        ['==', ['get', 'access'], 'no'],
        '#b6ada0',
        '#815f37',
      ]);
      const base = result.find((layer) => layer.id === 'road_service_track');
      expect((base?.paint['line-color'] as unknown[])[0]).toBe('case');
    }
  });

  it('applies sanitized user edits after the curated theme/profile', () => {
    const result = layers(
      applyMapAppearance(style, {
        colorScheme: 'light',
        profile: 'hike',
        custom: {
          landColor: '#112233',
          waterColor: '#224466',
          roadColor: '#aa5500',
          pathColor: '#00aa77',
          labelScale: 1.25,
          poiScale: 1.5,
        },
      }),
    );
    expect(result.find((layer) => layer.id === 'background')?.paint['background-color']).toBe(
      '#112233',
    );
    expect(result.find((layer) => layer.id === 'water')?.paint['fill-color']).toBe('#224466');
    expect(
      result.find((layer) => layer.id === 'road_secondary_tertiary')?.paint['line-color'],
    ).toBe('#aa5500');
    expect(result.find((layer) => layer.id === 'road_path_pedestrian')?.paint['line-color']).toBe(
      '#00aa77',
    );
    expect(result.find((layer) => layer.id === 'poi_r1')?.paint['text-opacity']).toBe(1);
    // The appended outdoor layer is a POI layer as far as the slider goes.
    expect(
      result.find((layer) => layer.id === 'atlas-outdoor-poi')?.layout?.['text-size'],
    ).toBeCloseTo(12 * 1.25 * 1.5);
  });
});

describe('basemap off', () => {
  const blank = (colorScheme: 'light' | 'dark') =>
    JSON.parse(
      applyMapAppearance(
        JSON.stringify({
          ...(JSON.parse(style) as Record<string, unknown>),
          glyphs: 'https://atlas.example/fonts/{fontstack}/{range}.pbf',
          sprite: 'https://atlas.example/sprites/ofm',
          sources: {
            openmaptiles: { type: 'vector', tiles: ['https://atlas.example/{z}/{x}/{y}'] },
          },
        }),
        { colorScheme, profile: 'curiosities', basemap: false },
      ),
    ) as {
      layers: TestLayer[];
      sources: Record<string, unknown>;
      glyphs?: string;
      sprite?: string;
    };

  it('leaves one flat background and no basemap layer at all', () => {
    const style = blank('light');
    expect(style.layers).toHaveLength(1);
    expect(style.layers[0]!.id).toBe('background');
    expect(style.layers[0]!.paint['background-color']).toBe('#f5f4f2');
    expect(blank('dark').layers[0]!.paint['background-color']).toBe('#15171a');
  });

  it('drops the tile sources but keeps the fonts and sprites the overlays draw with', () => {
    // A source left declared with no layer using it is a request MapLibre may
    // still make, and switching the basemap off is partly about not paying for
    // those. Glyphs are the opposite case: bathymetry depth labels and route
    // labels are Atlas's own symbol layers on the same font stack.
    const style = blank('dark');
    expect(style.sources).toEqual({});
    expect(style.glyphs).toBe('https://atlas.example/fonts/{fontstack}/{range}.pbf');
    expect(style.sprite).toBe('https://atlas.example/sprites/ofm');
  });

  it('is unaffected by the profile and the style editor, and stays opt-in', () => {
    // The blank map is the *absence* of the basemap, so nothing that tunes the
    // basemap may reach it — a custom land colour here would be a land colour
    // for land that is not drawn.
    const custom = JSON.parse(
      applyMapAppearance(style, {
        colorScheme: 'light',
        profile: 'fishhunt',
        basemap: false,
        custom: { landColor: '#112233', labelScale: 1.25, poiScale: 1.5 },
      }),
    ) as { layers: TestLayer[] };
    expect(custom.layers).toHaveLength(1);
    expect(custom.layers[0]!.paint['background-color']).toBe('#f5f4f2');
    // Absent means on: every existing caller passes no `basemap` at all.
    expect(
      layers(applyMapAppearance(style, { colorScheme: 'light', profile: 'curiosities' })).length,
    ).toBeGreaterThan(1);
  });
});

describe('theme mode', () => {
  it('accepts only the three persisted values', () => {
    expect(isThemeMode('system')).toBe(true);
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('night')).toBe(false);
  });
});
