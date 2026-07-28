import { describe, expect, it } from 'vitest';
import { atlasShareUrl, geoUri, shareFormats, shareMessage } from './index.js';

const spot = { lat: 59.805_63, lng: 10.367_01 };

describe('atlasShareUrl', () => {
  it('centres and pins the shared point, whatever the camera was doing', () => {
    expect(atlasShareUrl('https://atlas.example/', spot, 15)).toBe(
      'https://atlas.example/#map=15/59.80563/10.36701&pin=59.80563/10.36701',
    );
  });
});

describe('geoUri', () => {
  it('is a bare coordinate without a label', () => {
    expect(geoUri(spot)).toBe('geo:59.80563,10.36701');
  });

  it('carries a label the apps that honour q= can show', () => {
    expect(geoUri(spot, 'Fiskeplass')).toBe(
      'geo:59.80563,10.36701?q=59.80563,10.36701(Fiskeplass)',
    );
    // A label is user text; spaces and separators must not break the URI.
    expect(geoUri(spot, 'Fars hytte & båt')).toBe(
      'geo:59.80563,10.36701?q=59.80563,10.36701(Fars%20hytte%20%26%20b%C3%A5t)',
    );
  });
});

describe('shareMessage', () => {
  it('puts the plain coordinates ahead of the Atlas link', () => {
    expect(shareMessage(spot, 'Fiskeplass', 'https://atlas.example/#map=15/1/2')).toBe(
      'Fiskeplass\n59.80563, 10.36701\nhttps://atlas.example/#map=15/1/2',
    );
  });

  it('drops the parts that are missing', () => {
    expect(shareMessage(spot, undefined)).toBe('59.80563, 10.36701');
    expect(shareMessage(spot, '   ')).toBe('59.80563, 10.36701');
  });
});

describe('shareFormats', () => {
  const url = 'https://atlas.example/#map=15/59.80563/10.36701&pin=59.80563/10.36701';

  it('offers the same two formats, in the same order, on a client with no map app', () => {
    const formats = shareFormats(spot, 'Fiskeplass', url);
    expect(formats.map((f) => [f.key, f.title, f.action])).toEqual([
      ['link', 'Atlas link', 'send'],
      ['coords', 'Copy coordinates', 'copy'],
    ]);
    expect(formats[0]!.payload).toBe(shareMessage(spot, 'Fiskeplass', url));
    expect(formats[1]!.payload).toBe('59.80563, 10.36701');
  });

  it('adds the geo: hand-off only where the OS can act on it', () => {
    const handoff = shareFormats(spot, 'Fiskeplass', url, { handoff: true });
    expect(handoff.map((f) => f.key)).toEqual(['link', 'coords', 'geo']);
    // The label rides along, so the receiving map app drops a named pin.
    expect(handoff[2]!.payload).toBe(geoUri(spot, 'Fiskeplass'));
    expect(handoff[2]!.action).toBe('open');
  });

  it('shows the coordinates it would copy as the option subtitle', () => {
    const [, coords] = shareFormats(spot, undefined, url);
    expect(coords!.subtitle).toBe(coords!.payload);
  });
});
