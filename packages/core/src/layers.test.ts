import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  identifyOverlays,
  layerOptionSignature,
  normalizeLayerOptions,
  overlayIdentifyUrl,
  overlayTileUrl,
  resolveStyleTemplate,
  type LayerMeta,
  type LayerOption,
} from './index.js';

describe('resolveStyleTemplate', () => {
  it('substitutes every {origin} placeholder', () => {
    const template =
      '{"glyphs":"{origin}/assets/fonts","tiles":"pmtiles://{origin}/tiles/no.pmtiles"}';
    expect(resolveStyleTemplate(template, 'https://atlas.example')).toBe(
      '{"glyphs":"https://atlas.example/assets/fonts","tiles":"pmtiles://https://atlas.example/tiles/no.pmtiles"}',
    );
  });

  it('leaves templates without placeholders untouched', () => {
    expect(resolveStyleTemplate('{"version":8}', 'https://x')).toBe('{"version":8}');
  });
});

const layer = (id: string, identify: boolean): LayerMeta => ({
  id,
  rev: 1,
  title: id.toUpperCase(),
  description: '',
  group: 'Water & depth',
  attribution: '',
  maxzoom: 16,
  defaultOpacity: 0.8,
  identify,
});

describe('overlay tile URLs', () => {
  it('carry the catalog revision and encode the layer id', () => {
    expect(overlayTileUrl('https://atlas.example', { id: 'slope / steep', rev: 7 })).toBe(
      'https://atlas.example/api/overlay/slope%20%2F%20steep/{z}/{x}/{y}.png?v=7',
    );
  });

  it('carries the resolved layer options', () => {
    expect(
      overlayTileUrl(
        '',
        { id: 'wildlife', rev: 2, options: [speciesOption] },
        {
          species: 'ptarmigan',
        },
      ),
    ).toBe('/api/overlay/wildlife/{z}/{x}/{y}.png?v=2&species=ptarmigan');
  });

  it('falls back to the default choice rather than passing an unknown one on', () => {
    expect(
      overlayTileUrl('', { id: 'wildlife', rev: 2, options: [speciesOption] }, { species: '../x' }),
    ).toBe('/api/overlay/wildlife/{z}/{x}/{y}.png?v=2&species=biggame');
  });
});

const speciesOption: LayerOption = {
  key: 'species',
  label: 'Species',
  defaultValue: 'biggame',
  choices: [
    { value: 'biggame', label: 'Big game' },
    { value: 'ptarmigan', label: 'Ptarmigan' },
  ],
};

describe('normalizeLayerOptions', () => {
  it('fills every declared option and ignores keys the layer never declared', () => {
    expect(normalizeLayerOptions([speciesOption], { colour: 'red' })).toEqual({
      species: 'biggame',
    });
  });

  it('replaces a value outside the declared choices with the default', () => {
    expect(normalizeLayerOptions([speciesOption], { species: 'seabirds' })).toEqual({
      species: 'biggame',
    });
  });

  it('is empty for a layer without options, so nothing is appended anywhere', () => {
    expect(normalizeLayerOptions(undefined, { species: 'ptarmigan' })).toEqual({});
  });
});

describe('layerOptionSignature', () => {
  it('is stable regardless of key order', () => {
    expect(layerOptionSignature({ b: '2', a: '1' })).toBe(layerOptionSignature({ a: '1', b: '2' }));
  });

  it('is empty when a layer has no options, keeping existing paths and ids unchanged', () => {
    expect(layerOptionSignature({})).toBe('');
  });
});

describe('overlayIdentifyUrl', () => {
  it('builds the endpoint with a rounded zoom, relative on the web', () => {
    expect(overlayIdentifyUrl('', { id: 'nve-depth' }, { lat: 59.9, lng: 10.7 }, 13.4)).toBe(
      '/api/overlay/nve-depth/identify?lat=59.9&lng=10.7&zoom=13',
    );
  });

  it('prefixes the server origin for clients that are not served from it', () => {
    expect(overlayIdentifyUrl('https://atlas.example', { id: 'a b' }, { lat: 1, lng: 2 }, 9)).toBe(
      'https://atlas.example/api/overlay/a%20b/identify?lat=1&lng=2&zoom=9',
    );
  });

  it('asks with the same options the tiles were drawn with', () => {
    expect(
      overlayIdentifyUrl('', { id: 'wildlife', options: [speciesOption] }, { lat: 1, lng: 2 }, 14, {
        species: 'ptarmigan',
      }),
    ).toBe('/api/overlay/wildlife/identify?lat=1&lng=2&zoom=14&species=ptarmigan');
  });
});

describe('identifyOverlays', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks only identify-capable layers and tags each answer with its title', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [{ maksdyp_m: '21.5' }] }),
      });
    });
    const groups = await identifyOverlays(
      '',
      [layer('depth', true), layer('slope', false)],
      { lat: 60, lng: 11 },
      12,
    );
    expect(asked).toEqual(['/api/overlay/depth/identify?lat=60&lng=11&zoom=12']);
    expect(groups).toEqual([{ title: 'DEPTH', properties: { maksdyp_m: '21.5' } }]);
  });

  it('asks each layer with the options that layer is drawn with', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
    });
    const wildlife: LayerMeta = { ...layer('wildlife', true), options: [speciesOption] };
    await identifyOverlays('', [wildlife], { lat: 60, lng: 11 }, 14, () => ({
      species: 'ptarmigan',
    }));
    expect(asked).toEqual([
      '/api/overlay/wildlife/identify?lat=60&lng=11&zoom=14&species=ptarmigan',
    ]);
  });

  it('keeps the answers it did get when another overlay fails', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      url.includes('broken')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [{ a: '1' }] }) }),
    );
    const groups = await identifyOverlays(
      '',
      [layer('broken', true), layer('good', true)],
      { lat: 60, lng: 11 },
      12,
    );
    expect(groups).toEqual([{ title: 'GOOD', properties: { a: '1' } }]);
  });

  it('is silent (not an error) when nothing is under the tap', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 404 }));
    await expect(
      identifyOverlays('', [layer('depth', true)], { lat: 60, lng: 11 }, 12),
    ).resolves.toEqual([]);
  });

  it('does not touch the network when no visible overlay can identify', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      identifyOverlays('', [layer('slope', false)], { lat: 60, lng: 11 }, 12),
    ).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
