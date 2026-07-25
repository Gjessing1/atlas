import { describe, expect, it } from 'vitest';
import {
  bestMediaWikiPlacePage,
  commonsPlacePhotos,
  mergeNearbyMediaWikiPlaces,
  nearbyMediaWikiPlaces,
} from './place-content.js';

const at = { lat: 59.911, lng: 10.752 };

describe('bestMediaWikiPlacePage', () => {
  it('prefers the matching title over a slightly nearer unrelated page', () => {
    const match = {
      title: 'Oslo Central Station',
      extract: 'The main railway station in Oslo.',
      fullurl: 'https://en.wikipedia.org/wiki/Oslo_Central_Station',
      coordinates: [{ lat: 59.9109, lon: 10.753 }],
    };
    expect(
      bestMediaWikiPlacePage('Oslo Central Station', at, [
        {
          title: 'Oslo',
          extract: 'Capital city.',
          fullurl: 'https://en.wikipedia.org/wiki/Oslo',
          coordinates: [{ lat: 59.911, lon: 10.752 }],
        },
        match,
      ]),
    ).toBe(match);
  });

  it('rejects an unrelated article even when it is at the selected point', () => {
    expect(
      bestMediaWikiPlacePage('My hotel', at, [
        {
          title: 'Oslo Cathedral',
          extract: 'A cathedral.',
          fullurl: 'https://en.wikipedia.org/wiki/Oslo_Cathedral',
          coordinates: [{ lat: at.lat, lon: at.lng }],
        },
      ]),
    ).toBeNull();
  });

  it('never attaches a nearby article to a bare coordinate pin', () => {
    expect(
      bestMediaWikiPlacePage('59.9110, 10.7520', at, [
        {
          title: 'Oslo Cathedral',
          extract: 'A cathedral.',
          fullurl: 'https://en.wikipedia.org/wiki/Oslo_Cathedral',
          coordinates: [{ lat: at.lat, lon: at.lng }],
        },
      ]),
    ).toBeNull();
  });
});

describe('nearbyMediaWikiPlaces', () => {
  const page = (title: string, lat: number, lng: number, extract = 'Something to read.') => ({
    title,
    extract,
    fullurl: `https://no.wikipedia.org/wiki/${title}`,
    coordinates: [{ lat, lon: lng }],
  });

  it('orders described places by distance and measures each one', () => {
    const places = nearbyMediaWikiPlaces(at, [
      page('Far', 59.925, 10.752),
      page('Near', 59.9115, 10.752),
    ]);
    expect(places.map((p) => p.title)).toEqual(['Near', 'Far']);
    expect(places[0]!.distanceM).toBeLessThan(places[1]!.distanceM);
    expect(places[0]!.position).toEqual({ lat: 59.9115, lng: 10.752 });
  });

  it('drops pages with nothing to read or nowhere to be', () => {
    const places = nearbyMediaWikiPlaces(at, [
      { title: 'No extract', fullurl: 'https://x', coordinates: [{ lat: 59.91, lon: 10.75 }] },
      { title: 'No coordinate', extract: 'Text.', fullurl: 'https://x' },
      page('Good', 59.912, 10.752),
    ]);
    expect(places.map((p) => p.title)).toEqual(['Good']);
  });

  it('keeps the row thumbnail when the page has one', () => {
    const [place] = nearbyMediaWikiPlaces(at, [
      {
        ...page('Illustrated', 59.912, 10.752),
        thumbnail: { source: 'https://upload.example/t.jpg', width: 160, height: 90 },
      },
    ]);
    expect(place!.image).toEqual({ url: 'https://upload.example/t.jpg', width: 160, height: 90 });
  });
});

describe('mergeNearbyMediaWikiPlaces', () => {
  const page = (title: string, lat: number, lng: number, langlinks?: { title: string }[]) => ({
    title,
    extract: 'Something to read.',
    fullurl: `https://x/${title}`,
    coordinates: [{ lat, lon: lng }],
    ...(langlinks ? { langlinks: langlinks.map((link) => ({ lang: 'en', ...link })) } : {}),
  });

  it('drops the local article that the leading edition already listed', () => {
    const places = mergeNearbyMediaWikiPlaces({ lat: 59.911, lng: 10.752 }, [
      { language: 'en', pages: [page('Oslo Cathedral', 59.9128, 10.7476)] },
      {
        language: 'no',
        pages: [
          page('Oslo domkirke', 59.9128, 10.7476, [{ title: 'Oslo Cathedral' }]),
          page('Kirkeristen', 59.9126, 10.7489),
        ],
      },
    ]);
    // Nearest first, as always — the cathedral is listed once, in English.
    expect(places.map((place) => place.title)).toEqual(['Kirkeristen', 'Oslo Cathedral']);
    expect(places.map((place) => place.language)).toEqual(['no', 'en']);
  });

  it('orders the merged list by distance, not by edition', () => {
    const places = mergeNearbyMediaWikiPlaces({ lat: 59.911, lng: 10.752 }, [
      { language: 'en', pages: [page('Far', 59.925, 10.752)] },
      { language: 'no', pages: [page('Nær', 59.9115, 10.752)] },
    ]);
    expect(places.map((place) => place.title)).toEqual(['Nær', 'Far']);
  });
});

describe('commonsPlacePhotos', () => {
  const file = (title: string, lat?: number, lng?: number) => ({
    title,
    ...(lat !== undefined && lng !== undefined ? { coordinates: [{ lat, lon: lng }] } : {}),
    imageinfo: [
      {
        thumburl: `https://upload.example/${title}.jpg`,
        thumbwidth: 480,
        thumbheight: 320,
        descriptionurl: `https://commons.example/${title}`,
        extmetadata: {
          Artist: { value: '<a href="/wiki/User:X">Kari</a>' },
          LicenseShortName: { value: 'CC BY 4.0' },
        },
      },
    ],
  });

  it('strips the File: prefix and extension, and credits the photographer', () => {
    const [photo] = commonsPlacePhotos(at, [file('File:Oslo domkirke.jpg', 59.9128, 10.7476)]);
    expect(photo!.title).toBe('Oslo domkirke');
    expect(photo!.credit).toBe('Kari · CC BY 4.0');
    expect(photo!.pageUrl).toBe('https://commons.example/File:Oslo domkirke.jpg');
    expect(photo!.distanceM).toBeGreaterThan(0);
  });

  it('drops files without a usable https thumbnail', () => {
    expect(
      commonsPlacePhotos(at, [
        { title: 'File:Broken.jpg', imageinfo: [{ descriptionurl: 'https://x' }] },
        { title: 'File:Nothing.jpg' },
      ]),
    ).toEqual([]);
  });

  it('puts photos with no coordinate last rather than dropping them', () => {
    const photos = commonsPlacePhotos(at, [
      file('File:Unplaced.jpg'),
      file('File:Right here.jpg', 59.9111, 10.7521),
    ]);
    expect(photos.map((p) => p.title)).toEqual(['Right here', 'Unplaced']);
    expect(photos[1]!.distanceM).toBeNull();
  });
});
