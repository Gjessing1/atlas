import { describe, expect, it, vi } from 'vitest';
import {
  INATUR_BAD_INPUT,
  INATUR_NO_BOUNDARY,
  INATUR_UNAVAILABLE,
  inaturSegments,
  inaturTrackName,
  parseOfferId,
  resolveInaturOffer,
  type InaturArea,
} from './inatur.js';

const ID = '62416ebfa26bac3de2004556';

const AREA: InaturArea = {
  offerId: ID,
  name: 'Delområde Sleikebekk',
  bbox: [9.5, 59.5, 9.6, 59.6],
  polygons: [
    [
      [
        [9.5, 59.5],
        [9.6, 59.5],
        [9.6, 59.6],
        [9.5, 59.5],
      ],
      [
        [9.55, 59.55],
        [9.56, 59.55],
        [9.56, 59.56],
        [9.55, 59.55],
      ],
    ],
  ],
  rings: [
    [
      [9.5, 59.5],
      [9.6, 59.5],
      [9.6, 59.6],
      [9.5, 59.5],
    ],
    [
      [9.55, 59.55],
      [9.56, 59.55],
      [9.56, 59.56],
      [9.55, 59.55],
    ],
  ],
  subAreas: 1,
};

const jsonOnce = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

describe('parseOfferId', () => {
  it('takes the id out of a pasted offer link, lower-cased', () => {
    expect(parseOfferId(`https://www.inatur.no/tilbud/${ID.toUpperCase()}`)).toBe(ID);
    expect(parseOfferId(ID)).toBe(ID);
    expect(parseOfferId('https://www.inatur.no/jakt')).toBeUndefined();
  });
});

describe('resolveInaturOffer', () => {
  it('never lets a cached body answer a resolve', async () => {
    // A user re-pastes a link precisely when the drawn area looks wrong, so the
    // request must go past both the browser cache and Android's OkHttp cache —
    // a stale boundary outliving its fix is the bug this guards.
    const fetchImpl = jsonOnce(AREA);
    await resolveInaturOffer('https://atlas.test', `https://www.inatur.no/tilbud/${ID}`, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://atlas.test/api/inatur/resolve?offer=https%3A%2F%2Fwww.inatur.no%2Ftilbud%2F${ID}`,
    );
    expect(init?.cache).toBe('no-store');
    expect(init?.headers).toMatchObject({ 'cache-control': 'no-cache' });
  });

  it('phrases the three failures for the person who pasted the link', async () => {
    await expect(resolveInaturOffer('', 'not-an-offer', jsonOnce(AREA))).rejects.toThrow(
      INATUR_BAD_INPUT,
    );
    await expect(resolveInaturOffer('', ID, jsonOnce({}, 404))).rejects.toThrow(INATUR_NO_BOUNDARY);
    await expect(resolveInaturOffer('', ID, jsonOnce({}, 502))).rejects.toThrow(INATUR_UNAVAILABLE);
    await expect(
      resolveInaturOffer('', ID, async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow(INATUR_UNAVAILABLE);
  });
});

describe('saving a resolved offer', () => {
  it('names the track after the sub-area and keeps every ring as a segment', () => {
    expect(inaturTrackName(AREA)).toBe('iNatur – Delområde Sleikebekk');
    expect(inaturTrackName({ ...AREA, name: undefined })).toBe('iNatur permit 004556');
    const segments = inaturSegments(AREA);
    expect(segments).toHaveLength(2);
    expect(segments[0]![0]).toEqual({ lat: 59.5, lng: 9.5 });
  });
});
