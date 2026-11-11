import { describe, expect, it } from 'vitest';
import { decodeGeoLink, geoUri } from './index.js';

describe('decodeGeoLink', () => {
  it('ignores links that are not a map hand-off', () => {
    expect(decodeGeoLink('https://atlas.example/#map=12/59.9/10.7')).toBeNull();
    expect(decodeGeoLink('atlas://map=12/59.9/10.7')).toBeNull();
    expect(decodeGeoLink('')).toBeNull();
  });

  it('reads a bare coordinate, with altitude and parameters ignored', () => {
    expect(decodeGeoLink('geo:59.80563,10.36701')).toEqual({
      point: { lat: 59.805_63, lng: 10.367_01 },
    });
    expect(decodeGeoLink('geo:59.9,10.7,120;crs=wgs84;u=35')).toEqual({
      point: { lat: 59.9, lng: 10.7 },
    });
    expect(decodeGeoLink('GEO:-33.86,151.2')).toEqual({ point: { lat: -33.86, lng: 151.2 } });
  });

  it('reads the zoom, and drops one no map could show', () => {
    expect(decodeGeoLink('geo:59.9,10.7?z=14')).toEqual({
      point: { lat: 59.9, lng: 10.7 },
      zoom: 14,
    });
    expect(decodeGeoLink('geo:59.9,10.7?z=99')).toEqual({ point: { lat: 59.9, lng: 10.7 } });
    expect(decodeGeoLink('geo:59.9,10.7?z=abc')).toEqual({ point: { lat: 59.9, lng: 10.7 } });
  });

  it('takes the q= coordinate and its label over the path', () => {
    expect(decodeGeoLink('geo:0,0?q=59.9,10.7(Fars%20hytte%20%26%20b%C3%A5t)')).toEqual({
      point: { lat: 59.9, lng: 10.7 },
      label: 'Fars hytte & båt',
    });
    expect(decodeGeoLink('geo:1,1?q=59.9,10.7')).toEqual({ point: { lat: 59.9, lng: 10.7 } });
  });

  it('round-trips what Atlas itself shares', () => {
    const spot = { lat: 59.805_63, lng: 10.367_01 };
    expect(decodeGeoLink(geoUri(spot, 'Fiskeplass (nord)'))).toEqual({
      point: spot,
      label: 'Fiskeplass (nord)',
    });
  });

  it('hands an address back as text to search', () => {
    expect(decodeGeoLink('geo:0,0?q=Storgata+1%2C+Oslo')).toEqual({ query: 'Storgata 1, Oslo' });
    // An unencoded sender, stray percent sign and all.
    expect(decodeGeoLink('geo:0,0?q=100% kaffe, Oslo')).toEqual({ query: '100% kaffe, Oslo' });
  });

  it('treats text beside a real coordinate as its name', () => {
    expect(decodeGeoLink('geo:59.9,10.7?q=Operaen')).toEqual({
      point: { lat: 59.9, lng: 10.7 },
      label: 'Operaen',
    });
  });

  it('refuses a link that says nothing usable', () => {
    expect(decodeGeoLink('geo:0,0')).toBeNull();
    expect(decodeGeoLink('geo:')).toBeNull();
    expect(decodeGeoLink('geo:0,0?q=')).toBeNull();
    expect(decodeGeoLink('geo:95,10')).toBeNull();
    // An out-of-range "coordinate" in q= is not a place; it is at best a search.
    expect(decodeGeoLink('geo:0,0?q=95,200')).toEqual({ query: '95,200' });
  });

  it('reads navigation hand-offs', () => {
    expect(decodeGeoLink('google.navigation:q=59.9,10.7&mode=b')).toEqual({
      point: { lat: 59.9, lng: 10.7 },
    });
    expect(decodeGeoLink('google.navigation:q=Storgata+1,+Oslo')).toEqual({
      query: 'Storgata 1, Oslo',
    });
    expect(decodeGeoLink('google.navigation:///?q=59.9,10.7')).toEqual({
      point: { lat: 59.9, lng: 10.7 },
    });
    expect(decodeGeoLink('google.navigation:mode=d')).toBeNull();
  });
});
