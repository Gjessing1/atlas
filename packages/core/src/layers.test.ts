import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASEMAP_STATE_ID,
  basemapVisible,
  IDENTIFY_CARD_ROWS,
  formatIceObservationTime,
  iceObservationIdentify,
  iceObservationsUrl,
  identifyCardGroups,
  identifyCardLines,
  identifyLinkLabel,
  identifyOverlays,
  identifyValueUrl,
  huntingFieldIdentify,
  speedCameraIdentify,
  trafficFlowIdentify,
  trafficIdentify,
  viewportFeaturesUrl,
  roadWeatherIdentify,
  layerOptionSignature,
  MAP_PROFILES,
  normalizeLayerOptions,
  POI_STATE_ID,
  poiVisible,
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

  it('scopes rolling ice observations to the viewport and catalog revision', () => {
    expect(
      iceObservationsUrl(
        'https://atlas.example',
        { id: 'ice-observations', rev: 3 },
        [9.5, 59, 11.25, 60.5],
      ),
    ).toBe(
      'https://atlas.example/api/overlay/ice-observations/features?bbox=9.5,59,11.25,60.5&v=3',
    );
  });

  it('builds a revisioned viewport URL for other rolling point feeds', () => {
    expect(
      viewportFeaturesUrl(
        'https://atlas.example',
        { id: 'weather-lightning', rev: 2 },
        [8, 58, 12, 62],
      ),
    ).toBe('https://atlas.example/api/overlay/weather-lightning/features?bbox=8,58,12,62&v=2');
  });

  describe('derived surfaces', () => {
    const targetOption: LayerOption = {
      key: 'target',
      label: 'Tuned for',
      defaultValue: 'orret',
      choices: [
        { value: 'orret', label: 'Ørret' },
        { value: 'gjedde', label: 'Gjedde' },
      ],
    };
    const derivedLayer = {
      id: 'lake-fishing',
      rev: 1,
      options: [targetOption],
      derived: { legend: [] },
    };

    it('go to the derive service with the target in the path', () => {
      expect(overlayTileUrl('https://atlas.example', derivedLayer, { target: 'gjedde' })).toBe(
        'https://atlas.example/api/potential/lake-fishing/gjedde/{z}/{x}/{y}.png',
      );
    });

    it('never send a target the catalog did not declare', () => {
      expect(overlayTileUrl('', derivedLayer, { target: '../../etc' })).toBe(
        '/api/potential/lake-fishing/orret/{z}/{x}/{y}.png',
      );
    });

    // A re-derive rewrites the same URL, and the route revalidates with a
    // content ETag — a `v=` parameter would only defeat that 304.
    it('carry no cache-busting parameter', () => {
      expect(overlayTileUrl('', derivedLayer)).not.toContain('?');
    });
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

describe('basemapVisible', () => {
  it('is on until the device says otherwise, and only for the profile it was said in', () => {
    expect(basemapVisible({}, 'curiosities')).toBe(true);
    const off = { [`curiosities:${BASEMAP_STATE_ID}`]: { on: false } };
    expect(basemapVisible(off, 'curiosities')).toBe(false);
    // Reading a historic map with no land under it is a Curiosities decision;
    // it must not blank the map in Drive.
    expect(basemapVisible(off, 'drive')).toBe(true);
  });

  it('ignores an entry stored under the bare id, the way visibility does', () => {
    // Only `<profile>:<id>` carries an on/off choice for the basemap. A bare
    // entry (the pre-profile shape, or a hand-edited setting) is not one.
    expect(basemapVisible({ [BASEMAP_STATE_ID]: { on: false } }, 'curiosities')).toBe(true);
  });
});

describe('poiVisible', () => {
  it('is opt-in and only applies to the active profile', () => {
    for (const profile of MAP_PROFILES) expect(poiVisible({}, profile.id)).toBe(false);
    const on = { [`explore:${POI_STATE_ID}`]: { on: true } };
    expect(poiVisible(on, 'explore')).toBe(true);
    expect(poiVisible(on, 'hike')).toBe(false);
  });

  it('ignores the legacy bare id', () => {
    expect(poiVisible({ [POI_STATE_ID]: { on: true } }, 'explore')).toBe(false);
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

describe('identifyCardGroups', () => {
  const group = (title: string, rows: number) => ({
    title,
    properties: Object.fromEntries(
      Array.from({ length: rows }, (_, i) => [`key${i}`, `value${i}`]),
    ),
  });

  it('caps overlays and their rows to what one card can show', () => {
    const capped = identifyCardGroups([
      group('Depth', 9),
      group('Parcels', 2),
      group('Wildlife', 1),
      group('Slope', 3),
    ]);
    expect(capped.map((g) => g.title)).toEqual(['Depth', 'Parcels', 'Wildlife']);
    expect(capped[0]!.rows).toHaveLength(IDENTIFY_CARD_ROWS);
    expect(capped[0]!.rows[0]).toEqual(['key0', 'value0']);
    expect(capped[1]!.rows).toHaveLength(2);
  });

  it('keeps a heading that is itself the answer', () => {
    // An unnamed ATK site has no attributes worth a row, but "there is a speed
    // camera here" is exactly what the user tapped to find out.
    expect(identifyCardGroups([group('Speed camera', 0), group('Parcels', 1)])).toEqual([
      { title: 'Speed camera', rows: [] },
      { title: 'Parcels', rows: [['key0', 'value0']] },
    ]);
  });

  it('is empty for a tap nothing answered', () => {
    expect(identifyCardGroups([])).toEqual([]);
  });

  it('gives every overlay a slot before any overlay gets a second', () => {
    // A tap in a suburb catches three groundwater wells. Taken in order they
    // fill the card and the heritage site under the same finger never appears.
    const shown = identifyCardGroups([
      group('Wells & springs', 1),
      group('Wells & springs', 1),
      group('Wells & springs', 1),
      group('Heritage sites', 1),
    ]);
    expect(shown.map((g) => g.title)).toEqual([
      'Wells & springs',
      'Wells & springs',
      'Heritage sites',
    ]);
    // And the card says what it is not showing rather than dropping it silently.
    expect(shown[1]!.note).toBe('1 more nearby');
  });

  it('says how far away the answers behind the first one are', () => {
    const shown = identifyCardGroups([
      { ...group('Old buildings', 1), distanceM: 3 },
      { ...group('Old buildings', 1), distanceM: 42 },
    ]);
    // Nothing on the one under the finger: "3 m away" is doubt, not information.
    expect(shown[0]!.distance).toBeUndefined();
    expect(shown[1]!.distance).toBe('42 m away');
  });

  it('estimates whether there is anything to expand', () => {
    // A two-row answer is whole; a surveyor's paragraph is not, and a card that
    // offers "Show more" over an answer already fully visible is worse than
    // none. Six lines is the 132 px block both cards use.
    expect(identifyCardLines(identifyCardGroups([group('Depth', 2)]))).toBeLessThanOrEqual(6);
    const long = {
      title: 'Cultural heritage',
      properties: { Description: 'A surveyor’s field description. '.repeat(8) },
    };
    expect(identifyCardLines(identifyCardGroups([long]))).toBeGreaterThan(6);
  });

  it('recognises the answers that are a link, and only those', () => {
    // NGU's geosite fact sheet and Askeladden's Kulturminnesøk record are whole
    // rows that are nothing but a URL — printed as text they are the one answer
    // a reader cannot use.
    expect(identifyValueUrl(' https://kulturminnesok.no/ra/lokalitet/22228 ')).toBe(
      'https://kulturminnesok.no/ra/lokalitet/22228',
    );
    expect(identifyLinkLabel('https://www.kulturminnesok.no/ra/lokalitet/22228')).toBe(
      'kulturminnesok.no',
    );
    // A description that mentions a URL is still a description, and a
    // javascript: value is not a fact sheet.
    expect(identifyValueUrl('See https://x.example for the survey')).toBeUndefined();
    expect(identifyValueUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('counts the neighbours the backend left out into the last shown group', () => {
    const shown = identifyCardGroups([
      { ...group('Wells & springs', 1), more: { count: 2, withinM: 60 } },
    ]);
    expect(shown[0]!.note).toBe('2 more within about 60 m');
  });
});

describe('local overlay identify groups', () => {
  it('reads a Statskog jaktfelt the same way on both clients', () => {
    expect(huntingFieldIdentify({ Feltnavn: ' Vestre felt ', Art: 'Elg', Merknad: '  ' })).toEqual({
      title: 'Vestre felt',
      properties: { Species: 'Elg' },
    });
    // No name from the upstream: the heading still says what was tapped.
    expect(huntingFieldIdentify({ Art: 'Rådyr' })).toEqual({
      title: 'Hunting field',
      properties: { Species: 'Rådyr' },
    });
    expect(huntingFieldIdentify(null)).toBeNull();
  });

  it('names the kind of speed enforcement, because they are driven differently', () => {
    expect(speedCameraIdentify({ kind: 'point', name: 'Rv4 Gran' })).toEqual({
      title: 'Speed camera',
      properties: { Name: 'Rv4 Gran' },
    });
    expect(speedCameraIdentify({ kind: 'section' })).toEqual({
      title: 'Average speed control',
      properties: {},
    });
    expect(speedCameraIdentify(undefined)).toBeNull();
  });

  it('identifies DATEX traffic without changing the Norwegian message', () => {
    expect(
      trafficIdentify({
        kind: 'closure',
        location: 'E18 ved Oslo',
        message: 'Vegen er stengt.|Omkjøring er skiltet.',
        endTime: '2026-07-31T18:00:00+02:00',
      }),
    ).toEqual({
      title: 'Road closure',
      properties: {
        Location: 'E18 ved Oslo',
        'Details (Norwegian)': 'Vegen er stengt.|Omkjøring er skiltet.',
        'Valid until': '2026-07-31T18:00:00+02:00',
      },
    });
  });

  it('says how a corridor is running, against its own reference and with its age', () => {
    // The reading's age is shown on the *reader's* clock — they are standing in
    // the traffic — so the fixture is built in local time, as fmtClock's own
    // tests are, and the assertion holds in whatever timezone the suite runs in.
    const measuredAt = new Date(2026, 7, 3, 7, 30).toISOString();
    expect(
      trafficFlowIdentify({
        name: 'Helsfyr - Ryen',
        level: 'slow',
        durationS: 506,
        freeFlowS: 300,
        measuredAt,
      }),
    ).toEqual({
      title: 'Traffic flow',
      properties: {
        Stretch: 'Helsfyr - Ryen',
        Traffic: 'Slow',
        'Travel time': '8 min (normally 5 min)',
        Measured: '07:30',
      },
    });
    // The row that must never be missing: a grey corridor has to say it has no
    // reading rather than quietly show nothing.
    expect(trafficFlowIdentify({ name: 'Ryen - Helsfyr', level: 'unmeasured' })).toEqual({
      title: 'Traffic flow',
      properties: { Stretch: 'Ryen - Helsfyr', Traffic: 'Not measured right now' },
    });
    // Android's native bridge can hand a number back as text.
    expect(
      trafficFlowIdentify({ level: 'busy', durationS: '345', freeFlowS: '300' })?.properties[
        'Travel time'
      ],
    ).toBe('6 min (normally 5 min)');
    expect(trafficFlowIdentify(null)).toBeNull();
  });

  it('identifies a road-temperature reading with risk and freshness', () => {
    const validAt = new Date(2026, 0, 2, 8, 5).toISOString();
    expect(
      roadWeatherIdentify({
        name: 'E18 Ice hill',
        roadNumber: 'E18',
        source: 'measured',
        validAt,
        surfaceTemperatureC: -0.4,
        airTemperatureC: 1.2,
        condition: 'wet',
        risk: 'high',
      }),
    ).toEqual({
      title: 'E18 Ice hill',
      properties: {
        Road: 'E18',
        'Road surface': '-0.4 °C',
        Air: '1.2 °C',
        Condition: 'wet',
        Ice: 'Ice risk',
        Measured: '08:05',
      },
    });
  });

  it('says a road sensor is unreliable instead of printing a contradicted reading', () => {
    expect(
      roadWeatherIdentify({
        name: 'E136 Tresfjordbrua',
        roadNumber: 'E136',
        source: 'measured',
        validAt: new Date(2026, 8, 14, 19, 50).toISOString(),
        airTemperatureC: 10.9,
        condition: 'unknown',
        risk: 'none',
        surfaceSuspect: true,
      })?.properties,
    ).toEqual({
      Road: 'E136',
      'Road surface': 'sensor unreliable (near freezing in warm air)',
      Air: '10.9 °C',
      Measured: '19:50',
    });
  });

  it('shows the exact Regobs observation clock and useful report context', () => {
    expect(formatIceObservationTime('2026-01-09T14:07:00+01:00')).toBe('2026-01-09 14:07 +01:00');
    expect(
      iceObservationIdentify({
        label: 'Open water',
        observedAt: '2026-01-09T14:07:00+01:00',
        observer: 'Kari',
        summary: 'Open water by the outlet.',
        sourceUrl: 'https://www.regobs.no/registration/42',
      }),
    ).toEqual({
      title: 'Open water',
      properties: {
        Observed: '2026-01-09 14:07 +01:00',
        Type: 'Open water',
        Observer: 'Kari',
        Details: 'Open water by the outlet.',
        Regobs: 'https://www.regobs.no/registration/42',
      },
    });
    expect(iceObservationIdentify({ label: 'Ice', observedAt: '' })).toBeNull();
  });
});
