import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  identifyOverlays,
  overlayIdentifyUrl,
  resolveStyleTemplate,
  type LayerMeta,
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
  title: id.toUpperCase(),
  description: '',
  group: 'Water & depth',
  attribution: '',
  maxzoom: 16,
  defaultOpacity: 0.8,
  identify,
});

describe('overlayIdentifyUrl', () => {
  it('builds the endpoint with a rounded zoom, relative on the web', () => {
    expect(overlayIdentifyUrl('', 'nve-depth', { lat: 59.9, lng: 10.7 }, 13.4)).toBe(
      '/api/overlay/nve-depth/identify?lat=59.9&lng=10.7&zoom=13',
    );
  });

  it('prefixes the server origin for clients that are not served from it', () => {
    expect(overlayIdentifyUrl('https://atlas.example', 'a b', { lat: 1, lng: 2 }, 9)).toBe(
      'https://atlas.example/api/overlay/a%20b/identify?lat=1&lng=2&zoom=9',
    );
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
