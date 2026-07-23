import { describe, expect, it } from 'vitest';
import { bestMediaWikiPlacePage } from './place-content.js';

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
