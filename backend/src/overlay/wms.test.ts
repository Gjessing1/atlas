import { describe, expect, it } from 'vitest';
import { normalizeLayerOptions } from '@atlas/core';
import {
  alienGroupParams,
  artfunksjonSld,
  elvenettSld,
  norwegianLayers,
  type WmsUpstream,
} from './catalog.js';
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

describe('elvenettSld', () => {
  it('filters every rule to real channels, never lakes or fictitious lines', () => {
    // The whole point of the style: the network is routed *through* lakes
    // (665 093 centreline segments) and carries 21 255 imaginary connectors, so
    // a rule that forgets the class test draws rivers across open water.
    const sld = elvenettSld(1);
    const rules = sld.split('<Rule>').slice(1);
    expect(rules).toHaveLength(4);
    for (const rule of rules) {
      expect(rule).toContain('<ogc:PropertyName>ltema</ogc:PropertyName>');
      expect(rule).toContain('<ogc:Literal>3211</ogc:Literal>');
    }
  });

  it('filters on the database field name, not the identify alias', () => {
    // GetMap filters on `elveordenstrahler`; GetFeatureInfo *answers* with the
    // alias `Strahler`. Swapping them fails silently — the filter matches
    // nothing and the layer simply draws blank.
    const sld = elvenettSld(1);
    expect(sld).toContain('<ogc:PropertyName>elveordenstrahler</ogc:PropertyName>');
    expect(sld).not.toContain('>Strahler<');
  });

  it('drops the bands below the requested order and widens the survivors’ floor', () => {
    const main = elvenettSld(3);
    expect(main.split('<Rule>').slice(1)).toHaveLength(3);
    // The 2–3 band survives as 3–3 rather than being dropped or left at 2.
    expect(main).toContain(
      '<ogc:PropertyIsGreaterThanOrEqualTo><ogc:PropertyName>elveordenstrahler</ogc:PropertyName>' +
        '<ogc:Literal>3</ogc:Literal></ogc:PropertyIsGreaterThanOrEqualTo>',
    );
    expect(main).not.toContain('<ogc:Literal>1</ogc:Literal>');
  });

  it('never emits a single-operand And', () => {
    // The Naturbase service silently ignores a one-child `<ogc:Or>` and draws
    // everything; nothing says ArcGIS treats `<ogc:And>` better, so every
    // filter here must carry the class test plus at least one bound.
    for (const min of [1, 3]) {
      for (const rule of elvenettSld(min).split('<Rule>').slice(1)) {
        const operands = [...rule.matchAll(/<ogc:PropertyIs/g)].length;
        expect(operands).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('keeps every river GetMap request inside NVE’s ~10 kB URL cap', () => {
    // Measured 2026-07-25: 10 083 chars answered, 11 083 did not — and it fails
    // by *dropping the connection*, not with a fault body, so an over-long
    // request surfaces as "upstream unreachable" rather than anything that
    // points at the URL. Five times Naturbase's ~2 kB, hence its own guard.
    const layer = norwegianLayers().find((l) => l.meta.id === 'rivers')!;
    const upstream = layer.upstream as WmsUpstream;
    for (const choice of layer.meta.options![0]!.choices) {
      const chosen = normalizeLayerOptions(layer.meta.options, { streams: choice.value });
      const url = wmsBaseParams(upstream, 13, 4340, 2378);
      url.searchParams.set('REQUEST', 'GetMap');
      for (const [key, value] of Object.entries(optionGetMapParams(layer, chosen))) {
        url.searchParams.set(key, value);
      }
      expect(url.toString().length, `${choice.value} request URL`).toBeLessThan(10_000);
    }
  });

  it('mirrors the draw filter on the identify side, in the alias spelling', () => {
    // The two halves are spelled differently on purpose (field name vs alias),
    // which is exactly how they drift apart unnoticed.
    const layer = norwegianLayers().find((l) => l.meta.id === 'rivers')!;
    const upstream = layer.upstream as WmsUpstream;
    expect(upstream.identifyKeep).toEqual({ field: 'LTEMA', values: ['3211'] });
    expect(upstream.optionFilter!.field).toBe('Strahler');
    // "All streams" keeps everything; "Rivers only" keeps exactly the orders the
    // SLD still draws — anything else and a tap answers for an invisible brook.
    expect(upstream.optionFilter!.values.streams!.all).toEqual([]);
    expect(upstream.optionFilter!.values.streams!.main).toEqual(['3', '4', '5', '6', '7', '8']);
  });
});

describe('alienGroupParams', () => {
  const layer = norwegianLayers().find((l) => l.meta.id === 'alien-species')!;
  const riskChoices = layer.meta
    .options!.find((o) => o.key === 'risk')!
    .choices.map((c) => c.value);
  const groupChoices = layer.meta
    .options!.find((o) => o.key === 'group')!
    .choices.map((c) => c.value);

  it('emits one filter per drawn layer, for every chip combination', () => {
    // Measured on the live service: `(f)` against LAYERS=HI,SE is a
    // ServiceException, which the tile proxy turns into a *transparent tile* —
    // so a count mismatch reads as "no alien species here" rather than as an
    // error. This is the invariant that keeps that from shipping.
    for (const risk of riskChoices) {
      const drawn = (
        layer.upstream as { optionParams: Record<string, Record<string, Record<string, string>>> }
      ).optionParams['risk']![risk]!['LAYERS']!.split(',').length;
      for (const group of groupChoices) {
        const params = alienGroupParams({ risk, group });
        const filters = (params['FILTER']?.match(/<Filter>/g) ?? []).length;
        if (group === 'all') {
          expect(params['FILTER'], `${risk}/${group} should not filter`).toBeUndefined();
        } else {
          expect(filters, `${risk}/${group}`).toBe(drawn);
        }
      }
    }
  });

  it('keeps every request inside the upstream’s ~2 kB query cap', () => {
    // The same server 404s a 3 548-char query string while answering a 1 050
    // one — an SLD document was what blew it, and this filter is the compact
    // replacement, so the budget is worth guarding.
    for (const risk of riskChoices) {
      for (const group of groupChoices) {
        const params = new URLSearchParams(alienGroupParams({ risk, group }));
        expect(params.toString().length, `${risk}/${group}`).toBeLessThan(1500);
      }
    }
  });

  it('reaches a real GetMap request through optionGetMapParams', () => {
    // The whole-selection escape hatch has to *win* over the per-option table,
    // and the alien row is the only user: both chips write GetMap parameters,
    // and only one of them can know the other's layer count.
    const chosen = normalizeLayerOptions(layer.meta.options, { risk: 'high', group: 'animals' });
    const params = optionGetMapParams(layer, chosen);
    expect(params['LAYERS']).toBe('HI,SE');
    expect((params['FILTER']!.match(/<Filter>/g) ?? []).length).toBe(2);
    const url = wmsBaseParams(layer.upstream as WmsUpstream, 12, 2185, 1121);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    expect(url.toString().length).toBeLessThan(2000);
  });

  it('filters on the field the tap-side filter reads', () => {
    // The upstream applies FILTER to GetMap only, so `optionFilter` repeats the
    // decision on identify results. Two spellings of the same field name is how
    // the map and the card start disagreeing.
    const field = (layer.upstream as { optionFilter: { field: string } }).optionFilter.field;
    expect(alienGroupParams({ risk: 'severe', group: 'plants' })['FILTER']).toContain(
      `<PropertyName>${field}</PropertyName>`,
    );
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
