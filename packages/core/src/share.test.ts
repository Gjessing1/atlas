import { describe, expect, it } from 'vitest';
import { atlasShareUrl, geoUri, shareMessage } from './index.js';

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
