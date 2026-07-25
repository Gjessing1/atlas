import { describe, expect, it } from 'vitest';
import { normalizeLayerOptions } from '@atlas/core';
import { artfunksjonSld, norwegianLayers, type WmsUpstream } from './catalog.js';
import { optionGetMapParams } from './options.js';
import { substituteEnv, tileBbox3857, tileCoords, wmsBaseParams } from './wms.js';

const EXTENT = 20037508.342789244;

const upstream: WmsUpstream = {
  kind: 'wms',
  url: 'https://upstream.example/wms',
  version: '1.3.0',
  layers: 'Depth',
};

describe('tile bbox math', () => {
  it('maps z0 to the full mercator extent', () => {
    const [minx, miny, maxx, maxy] = tileBbox3857(0, 0, 0);
    expect(minx).toBeCloseTo(-EXTENT, 3);
    expect(miny).toBeCloseTo(-EXTENT, 3);
    expect(maxx).toBeCloseTo(EXTENT, 3);
    expect(maxy).toBeCloseTo(EXTENT, 3);
  });

  it('maps z1 x1 y0 to the north-east quadrant', () => {
    const [minx, miny, maxx, maxy] = tileBbox3857(1, 1, 0);
    expect(minx).toBeCloseTo(0, 3);
    expect(miny).toBeCloseTo(0, 3);
    expect(maxx).toBeCloseTo(EXTENT, 3);
    expect(maxy).toBeCloseTo(EXTENT, 3);
  });
});

describe('tileCoords', () => {
  it('puts 0/0 at the centre of the z0 tile', () => {
    const { x, y } = tileCoords(0, 0, 0);
    expect(x).toBeCloseTo(0.5, 6);
    expect(y).toBeCloseTo(0.5, 6);
  });

  it('keeps a Norwegian coordinate inside its own tile at z13', () => {
    const { x, y } = tileCoords(59.9, 10.75, 13);
    // Fractional part is the pixel offset the identify route derives I/J from,
    // so it must stay strictly inside the tile.
    expect(x - Math.floor(x)).toBeGreaterThanOrEqual(0);
    expect(x - Math.floor(x)).toBeLessThan(1);
    expect(y - Math.floor(y)).toBeLessThan(1);
    // Northern hemisphere ⇒ above the equator row.
    expect(y).toBeLessThan(2 ** 13 / 2);
  });
});

describe('wmsBaseParams', () => {
  it('asks 1.3.0 for CRS and 1.1.1 for SRS', () => {
    expect(wmsBaseParams(upstream, 1, 1, 0).searchParams.get('CRS')).toBe('EPSG:3857');
    expect(wmsBaseParams(upstream, 1, 1, 0).searchParams.get('SRS')).toBeNull();
    const legacy = wmsBaseParams({ ...upstream, version: '1.1.1' }, 1, 1, 0).searchParams;
    expect(legacy.get('SRS')).toBe('EPSG:3857');
    expect(legacy.get('CRS')).toBeNull();
  });

  it('omits the DPI hint at 256 px and sets it for a larger image', () => {
    const plain = wmsBaseParams(upstream, 1, 1, 0).searchParams;
    expect(plain.get('WIDTH')).toBe('256');
    expect(plain.get('DPI')).toBeNull();
    expect(plain.get('MAP_RESOLUTION')).toBeNull();

    const hidpi = wmsBaseParams(upstream, 1, 1, 0, 512).searchParams;
    expect(hidpi.get('WIDTH')).toBe('512');
    expect(hidpi.get('HEIGHT')).toBe('512');
    expect(hidpi.get('DPI')).toBe('192');
    expect(hidpi.get('MAP_RESOLUTION')).toBe('192');
    // A bigger image must cover the *same* ground, not a bigger box.
    expect(hidpi.get('BBOX')).toBe(plain.get('BBOX'));
  });

  it('keeps query parameters already present in the upstream URL', () => {
    const params = wmsBaseParams(
      { ...upstream, url: 'https://upstream.example/wms?map=/etc/depth.map' },
      1,
      1,
      0,
    ).searchParams;
    expect(params.get('map')).toBe('/etc/depth.map');
    expect(params.get('SERVICE')).toBe('WMS');
  });
});

describe('artfunksjonSld', () => {
  it('emits a bare comparison for one species, never a single-operand Or', () => {
    // Measured against the live service: ArcGIS silently *ignores* an
    // `<ogc:Or>` with one child and draws every species, so a one-name choice
    // built the obvious way looks like it works and filters nothing.
    const sld = artfunksjonSld(['Elg']);
    expect(sld).not.toContain('<ogc:Or>');
    expect(sld).toContain('<ogc:Literal>Elg</ogc:Literal>');
  });

  it('combines several species with Or', () => {
    const sld = artfunksjonSld(['Elg', 'Hjort']);
    expect(sld).toContain('<ogc:Or>');
    expect(sld).toContain('<ogc:Literal>Hjort</ogc:Literal>');
  });

  it('omits the filter entirely for the unfiltered choice', () => {
    expect(artfunksjonSld([])).not.toContain('ogc:Filter');
  });

  it('keeps every wildlife GetMap request inside the upstream’s ~2 kB URL cap', () => {
    // The cap is a hard 404, not a fault body: 2 095 chars answered and 2 145
    // did not. A fifth species on a chip would cross it, so this fails loudly
    // in CI instead of blanking the layer for whoever picked that chip.
    const layer = norwegianLayers().find((l) => l.meta.id === 'wildlife-areas')!;
    const upstream = layer.upstream as WmsUpstream;
    for (const choice of layer.meta.options![0]!.choices) {
      const chosen = normalizeLayerOptions(layer.meta.options, { species: choice.value });
      const url = wmsBaseParams(upstream, 14, 8694, 4724);
      url.searchParams.set('REQUEST', 'GetMap');
      for (const [key, value] of Object.entries(optionGetMapParams(layer, chosen))) {
        url.searchParams.set(key, value);
      }
      expect(url.toString().length, `${choice.value} request URL`).toBeLessThan(2000);
    }
  });
});

describe('substituteEnv', () => {
  it('fills in tokens and blanks unknown ones', () => {
    expect(substituteEnv('https://x/${TOKEN}/{z}.png', { TOKEN: 'secret' })).toBe(
      'https://x/secret/{z}.png',
    );
    // A missing token must not leave `${VAR}` in the URL — an empty segment
    // fails the upstream request loudly instead of leaking the template.
    expect(substituteEnv('https://x/${TOKEN}/a', {})).toBe('https://x//a');
  });
});
