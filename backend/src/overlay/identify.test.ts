import { describe, expect, it } from 'vitest';
import {
  boundsDistanceM,
  cleanProps,
  decodeXmlText,
  dedupeResults,
  formatEsriDateTime,
  formatNumber,
  formatNveDate,
  gmlBounds,
  identifyRadiusM,
  identifyZoom,
  keepSet,
  keepsIdentify,
  parseEsriXmlInfo,
  parseGeojsonInfo,
  parseGmlInfo,
  parseTextInfo,
  presentFields,
  narrowZooms,
  selectFields,
  sortByDistance,
  translateTokens,
} from './identify.js';

/**
 * The parsers answer with `{ props, bounds? }` per feature — the attributes are
 * what most assertions here are about, so they are read through this rather
 * than restated in every expectation. The position has tests of its own.
 */
const propsOf = (features: { props: Record<string, string> }[] | null) =>
  features?.map((f) => f.props);

/**
 * The identify parsers are where the real edge cases live (noise keys, the -1
 * "not measured" sentinel, four upstream dialects), so they are exercised
 * directly here — no Fastify, no fetch stub. `api.test.ts` covers the format
 * negotiation around them.
 */

describe('cleanProps', () => {
  it('drops bookkeeping keys, blanks and the -1 sentinel', () => {
    expect(
      cleanProps({
        dybde_m: 24,
        navn: ' Testvatnet ',
        OBJECTID: 7,
        'SHAPE.STLength()': 14771.8,
        geometri_kilde: 'x',
        oppdateringsdato: '2024-01-01',
        middeldyp: -1,
        volum: '-1.00',
        tom: '',
        ingenting: 'NULL',
        mangler: null,
      }),
    ).toEqual({ dybde_m: '24', navn: 'Testvatnet' });
  });

  it('keeps a genuine negative that is not the sentinel', () => {
    expect(cleanProps({ hoyde_m: -12, ekv_m: -1.5 })).toEqual({ hoyde_m: '-12', ekv_m: '-1.5' });
  });

  it('caps a runaway value rather than shipping it to the client', () => {
    expect(cleanProps({ merknad: 'x'.repeat(500) }).merknad).toHaveLength(200);
  });
});

describe('keepsIdentify', () => {
  const keep = { field: 'LTEMA', values: ['3211'] };

  it('drops a feature the map does not draw', () => {
    // Verbatim shape of a real tap in the middle of Vansjø: NVE answers with
    // the lake through-flow centreline, which the river SLD filters out of the
    // tile — so the card would name a river over water showing no river at all.
    expect(keepsIdentify(keep, { elvenavn: 'Mossevassdraget', Strahler: '6', LTEMA: '3103' })).toBe(
      false,
    );
    expect(keepsIdentify(keep, { elvenavn: 'Glomma', LTEMA: '3211' })).toBe(true);
  });

  it('survives cleanProps, which is the only reason it can filter at all', () => {
    // `ltema` used to be in NOISE_KEYS. It is scrubbed *before* any filter runs,
    // so listing it there deleted the evidence and every lake centreline came
    // straight back through as a confident answer.
    const cleaned = cleanProps({ LTEMA: '3103', elvenavn: 'Mossevassdraget', OBJECTID: 1 });
    expect(cleaned.LTEMA).toBe('3103');
    expect(keepsIdentify(keep, cleaned)).toBe(false);
  });

  it('matches the field name case-insensitively', () => {
    // `ltema` over the REST service, `LTEMA` in ESRI's identify dialect.
    expect(keepsIdentify(keep, { ltema: '3211' })).toBe(true);
    expect(keepsIdentify(keep, { ltema: '3299' })).toBe(false);
  });

  it('keeps everything when unset, empty, or the field is absent', () => {
    expect(keepsIdentify(undefined, { LTEMA: '3103' })).toBe(true);
    expect(keepsIdentify({ field: 'LTEMA', values: [] }, { LTEMA: '3103' })).toBe(true);
    // Missing field ⇒ keep: the filter exists to match the map, not to hide
    // answers it cannot classify (same rule as optionKeeps).
    expect(keepsIdentify(keep, { elvenavn: 'Glomma' })).toBe(true);
  });
});

describe('selectFields', () => {
  it('passes everything through when no allow-list is configured', () => {
    const props = { b: '2', a: '1' };
    expect(selectFields(props, undefined)).toEqual(props);
    expect(selectFields(props, [])).toEqual(props);
  });

  it('matches case-insensitively and answers in the configured order', () => {
    // The same field is `maksdyp` over WMS and `maksdyp_m` over REST, and the
    // upstream's own key order is not the reading order we want.
    const out = selectFields({ kommune: 'Asker', MAKSDYP: '21.5', navn: 'Verkensvannet' }, [
      'navn',
      'maksdyp',
    ]);
    expect(out).toEqual({ navn: 'Verkensvannet', MAKSDYP: '21.5' });
    expect(Object.keys(out)).toEqual(['navn', 'MAKSDYP']);
  });

  it('yields nothing when no listed field is present', () => {
    expect(selectFields({ pdf1: 'x.pdf' }, ['navn', 'maksdyp'])).toEqual({});
  });
});

describe('presentFields', () => {
  const labels = { navn: 'Lake', vurdert: 'Ice conditions', hrv: 'Regulated high water (m)' };
  const values = { vurdert: { '0': 'Not assessed', '2': 'Often dangerous ice conditions' } };

  it('renames keys and decodes coded values, keeping the reading order', () => {
    const out = presentFields(
      { navn: 'Evangervatnet', VURDERT: '2', hrv: '251.5' },
      labels,
      values,
    );
    expect(out).toEqual({
      Lake: 'Evangervatnet',
      'Ice conditions': 'Often dangerous ice conditions',
      'Regulated high water (m)': '251.5',
    });
    expect(Object.keys(out)[0]).toBe('Lake');
  });

  it('decodes a code that arrived as a float, not just as an integer', () => {
    // The identify dialects disagree: ESRI text/xml answers "2", geo+json "2.0".
    // Missing by a trailing zero would show the raw code, the exact failure the
    // mapping exists to prevent.
    expect(presentFields({ vurdert: '2.0' }, labels, values)).toEqual({
      'Ice conditions': 'Often dangerous ice conditions',
    });
  });

  it('drops a row a mapping decodes to nothing', () => {
    // AR5 answers `Ikke relevant` for tree species and site quality on every
    // lake, bog and field — three rows of "not relevant" is what an identify
    // card looks like when nobody read one. Mapping to '' removes the row.
    expect(
      presentFields(
        { artype_beskrivelse: 'Myr', artreslag_beskrivelse: 'Ikke relevant' },
        { artype_beskrivelse: 'Land cover', artreslag_beskrivelse: 'Tree species' },
        {
          artype_beskrivelse: { Myr: 'Bog / marsh' },
          artreslag_beskrivelse: { 'Ikke relevant': '' },
        },
      ),
    ).toEqual({ 'Land cover': 'Bog / marsh' });
  });

  it('passes through anything the catalog does not claim to translate', () => {
    expect(presentFields({ vurdert: '9', kommune: 'Voss' }, labels, values)).toEqual({
      'Ice conditions': '9',
      kommune: 'Voss',
    });
    // An unannotated layer must behave exactly as before.
    const raw = { navn: 'Verkensvannet', maksdyp: '21.5' };
    expect(presentFields(raw, undefined, undefined)).toBe(raw);
  });

  it('cuts a computed measurement to two decimals, and drops what says nothing', () => {
    // NVE publishes a glacier's area as `543.192344` km² — six decimals of a
    // figure whose first one is an argument about where the ice ends.
    expect(
      presentFields({ AREAL_KM2: '543.192344' }, { AREAL_KM2: 'Area (km²)' }, undefined, {
        AREAL_KM2: 'number',
      }),
    ).toEqual({ 'Area (km²)': '543.19' });
    // A row a mapping empties is gone, formatter or not: "Area: " is worse
    // than no area row at all.
    expect(
      presentFields(
        { AREAL_KM2: '0' },
        { AREAL_KM2: 'Area (km²)' },
        { AREAL_KM2: { '0': '' } },
        { AREAL_KM2: 'number' },
      ),
    ).toEqual({});
    // Not a number: the same field can hold a range or a word.
    expect(formatNumber('Null')).toBe('Null');
    expect(formatNumber('11.46')).toBe('11.46');
  });

  it('formats both date orderings present in NVE weakened-ice records', () => {
    expect(formatNveDate('20060217')).toBe('2006-02-17');
    expect(formatNveDate('20211811')).toBe('2021-11-18');
    expect(
      presentFields({ dato_dig: '20211811' }, { dato_dig: 'Mapped' }, undefined, {
        dato_dig: 'nve-date',
      }),
    ).toEqual({ Mapped: '2021-11-18' });
    expect(formatNveDate('20213131')).toBe('20213131');
  });
});

describe('parseGeojsonInfo', () => {
  it('cleans each feature and keeps empty ones for the caller to drop', () => {
    const body = JSON.stringify({
      features: [{ properties: { dybde_m: 24, OBJECTID: 7 } }, { properties: { OBJECTID: 8 } }, {}],
    });
    expect(propsOf(parseGeojsonInfo(body))).toEqual([{ dybde_m: '24' }, {}, {}]);
  });

  it('returns null (try the next format) for non-JSON or a non-collection', () => {
    expect(parseGeojsonInfo('<ServiceExceptionReport/>')).toBeNull();
    expect(parseGeojsonInfo('{"error":"nope"}')).toBeNull();
  });
});

describe('parseGmlInfo', () => {
  it('groups leaf elements per feature and skips gml: structure', () => {
    const gml = `<msGMLOutput><DybdePunkt_layer>
      <DybdePunkt_feature>
        <gml:boundedBy><gml:Box>1 2 3 4</gml:Box></gml:boundedBy>
        <gml:name>structural</gml:name>
        <dybde_m>31</dybde_m><OBJECTID>4</OBJECTID>
      </DybdePunkt_feature>
      <DybdePunkt_feature><dybde_m>12</dybde_m></DybdePunkt_feature>
    </DybdePunkt_layer></msGMLOutput>`;
    expect(propsOf(parseGmlInfo(gml))).toEqual([{ dybde_m: '31' }, { dybde_m: '12' }]);
  });

  it('reads a featureMember dialect and drops features left empty', () => {
    const gml = `<wfs:FeatureCollection>
      <gml:featureMember><teig><matrikkelnummer>3203-1/2</matrikkelnummer></teig></gml:featureMember>
      <gml:featureMember><teig><OBJECTID>9</OBJECTID></teig></gml:featureMember>
    </wfs:FeatureCollection>`;
    expect(propsOf(parseGmlInfo(gml))).toEqual([{ matrikkelnummer: '3203-1/2' }]);
  });

  it('reads where the feature is, so a tap can rank the neighbours', () => {
    // Verbatim shape of Riksantikvaren's SEFRAK reply (2026-08-04): a per-
    // feature Box in the CRS the request asked for. This is the only thing in
    // the whole format chain that says where anything is.
    const gml = `<msGMLOutput><SEFRAKBygninger_layer>
      <SEFRAKBygninger_feature>
        <gml:boundedBy>
          <gml:Box srsName="EPSG:3857">
            <gml:coordinates>1166940.781841,8271055.413643 1166940.781841,8271055.413643</gml:coordinates>
          </gml:Box>
        </gml:boundedBy>
        <objektnavn>TORVET 3, HORTEN</objektnavn>
      </SEFRAKBygninger_feature>
    </SEFRAKBygninger_layer></msGMLOutput>`;
    const bounds = parseGmlInfo(gml)[0]?.bounds;
    expect(bounds?.west).toBeCloseTo(10.482807, 5);
    expect(bounds?.south).toBeCloseTo(59.416944, 5);
    // A building is a point in this register: one corner, twice.
    expect(bounds?.east).toBeCloseTo(bounds!.west, 6);
    expect(bounds?.north).toBeCloseTo(bounds!.south, 6);
  });
});

describe('gmlBounds', () => {
  it('reads GML 3 positions and an envelope’s two corners', () => {
    expect(
      gmlBounds('<gml:Point srsName="EPSG:3857"><gml:pos>1166940 8271055</gml:pos></gml:Point>'),
    ).toBeDefined();
    const envelope = gmlBounds(
      `<gml:Envelope srsName="urn:ogc:def:crs:EPSG::3857">
         <gml:lowerCorner>1166000 8271000</gml:lowerCorner>
         <gml:upperCorner>1167000 8272000</gml:upperCorner>
       </gml:Envelope>`,
    );
    expect(envelope!.east).toBeGreaterThan(envelope!.west);
    expect(envelope!.north).toBeGreaterThan(envelope!.south);
  });

  it('refuses a frame it did not ask for rather than guessing the axis order', () => {
    // WMS 1.3.0 flipped the axis order of geographic CRSs. Read as x,y, a
    // building in Horten lands in the Indian Ocean — an answer that is wrong
    // is worse than the "no distance" every other dialect already returns.
    expect(
      gmlBounds('<gml:Point srsName="EPSG:4326"><gml:pos>59.41 10.48</gml:pos></gml:Point>'),
    ).toBeUndefined();
    expect(
      gmlBounds('<gml:Box><gml:coordinates>1,2 3,4</gml:coordinates></gml:Box>'),
    ).toBeUndefined();
  });

  it('takes the CRS from the feature when the geometry does not carry it', () => {
    const chunk = `<x_feature><gml:boundedBy srsName="EPSG:3857">
      <gml:Box><gml:coordinates>1166940.781841,8271055.413643</gml:coordinates></gml:Box>
    </gml:boundedBy></x_feature>`;
    expect(gmlBounds(chunk)?.south).toBeCloseTo(59.416944, 5);
  });
});

describe('boundsDistanceM', () => {
  const point = { west: 10.482807, south: 59.416944, east: 10.482807, north: 59.416944 };

  it('measures to the feature, and reads zero on top of it', () => {
    expect(boundsDistanceM(point, { lat: 59.416944, lng: 10.482807 })).toBeCloseTo(0, 5);
    expect(boundsDistanceM(point, { lat: 59.416944, lng: 10.484541 })).toBeGreaterThan(90);
    expect(boundsDistanceM(point, { lat: 59.416944, lng: 10.484541 })).toBeLessThan(110);
  });

  it('measures to an area’s edge, not its centre', () => {
    // A tap inside Askeladden's largest locality is *on* it; measured to the
    // centroid it would sort behind a point 40 m away and the card would name
    // the wrong thing.
    const area = { west: 10.4, south: 59.4, east: 10.6, north: 59.5 };
    expect(boundsDistanceM(area, { lat: 59.45, lng: 10.5 })).toBe(0);
    expect(boundsDistanceM(area, { lat: 59.45, lng: 10.61 })).toBeLessThan(700);
  });
});

describe('sortByDistance', () => {
  const at = { lat: 59.416944, lng: 10.482807 };
  const box = (lng: number) => ({ west: lng, south: 59.416944, east: lng, north: 59.416944 });

  it('puts the one under the finger first', () => {
    const far = { props: { objektnavn: 'far' }, bounds: box(10.4845) };
    const near = { props: { objektnavn: 'near' }, bounds: box(10.48284) };
    expect(sortByDistance([far, near], at).map((f) => f.props.objektnavn)).toEqual(['near', 'far']);
  });

  it('keeps positionless answers in upstream order, behind the placed ones', () => {
    // GRANADA is this case: same GML dialect as SEFRAK, no geometry in the
    // mapfile, so nothing can be ranked and inventing an order would be a lie.
    const a = { props: { nummer: '1' } };
    const b = { props: { nummer: '2' } };
    const placed = { props: { nummer: '3' }, bounds: box(10.4845) };
    expect(sortByDistance([a, b, placed], at).map((f) => f.props.nummer)).toEqual(['3', '1', '2']);
  });
});

describe('narrowZooms', () => {
  it('climbs from just inside the wide tap to a factor of sixteen', () => {
    expect(narrowZooms(13)).toEqual([14, 15, 16, 17]);
  });

  it('stops where a query would be a pinprick rather than a tap', () => {
    expect(narrowZooms(16)).toEqual([17, 18]);
    expect(narrowZooms(18)).toEqual([]);
  });
});

describe('identifyRadiusM', () => {
  it('is roughly the ground radius the measured caps were chosen for', () => {
    // The catalog's identifyZoom values are written as metres in their
    // comments — z13 is tens of metres at Norwegian latitudes, z16 a few.
    expect(identifyRadiusM(13, 60)).toBeGreaterThan(25);
    expect(identifyRadiusM(13, 60)).toBeLessThan(45);
    expect(identifyRadiusM(16, 60)).toBeLessThan(6);
    // Halving the radius per level is the whole basis of the narrowing.
    expect(identifyRadiusM(14, 60) / identifyRadiusM(15, 60)).toBeCloseTo(2, 6);
  });
});

describe('parseEsriXmlInfo', () => {
  it('reads one FIELDS element per feature', () => {
    const esri = `<?xml version="1.0" encoding="UTF-8"?>
      <FeatureInfoResponse xmlns="http://www.esri.com/wms">
        <FIELDS OBJECTID="56112" navn="Tyrifjorden" dybde_m="180" Shape.STLength()="14771.8"/>
        <FIELDS navn="Steinsfjorden" dybde_m="22"/>
      </FeatureInfoResponse>`;
    expect(propsOf(parseEsriXmlInfo(esri))).toEqual([
      { navn: 'Tyrifjorden', dybde_m: '180' },
      { navn: 'Steinsfjorden', dybde_m: '22' },
    ]);
  });

  it('reads a FIELDS element that is closed with a tag instead of self-closed', () => {
    // Verbatim from Naturbase artfunksjon (probed 2026-07-25). Same WMS
    // version as NVE, different closing style and Norwegian attribute names —
    // and this parser owns the format, so getting either wrong means the tap
    // silently answers "nothing here" instead of falling through.
    const esri = `<?xml version="1.0" encoding="UTF-8"?>
      <FeatureInfoResponse xmlns="http://www.esri.com/wms">
        <FIELDS Områdenavn="" Kommune="Overhalla (5047)" Verdi="Svært viktig" Årstid="vinter"
          Norsknavn="Elg" Funksjon="beiteområde" Rødlistestatus="Null" Punkt="0"
          Shape="Polygon" SHAPE.STArea="62315,17658"></FIELDS>
      </FeatureInfoResponse>`;
    expect(propsOf(parseEsriXmlInfo(esri))).toEqual([
      {
        Kommune: 'Overhalla (5047)',
        Verdi: 'Svært viktig',
        Årstid: 'vinter',
        Norsknavn: 'Elg',
        Funksjon: 'beiteområde',
        Punkt: '0',
      },
    ]);
  });

  it('returns null for a body that is not an ESRI response', () => {
    expect(parseEsriXmlInfo('<msGMLOutput/>')).toBeNull();
  });

  it('answers empty for an ESRI response with no hits at the pixel', () => {
    expect(parseEsriXmlInfo('<FeatureInfoResponse></FeatureInfoResponse>')).toEqual([]);
  });
});

describe('parseTextInfo', () => {
  it('reads indented key = value lines', () => {
    const body = "GetFeatureInfo results:\nLayer 'DybdePunkt'\n  Feature 9:\n    dybde_m = '12'\n";
    expect(propsOf(parseTextInfo(body))).toEqual([{ dybde_m: '12' }]);
  });

  it('answers empty when nothing survives cleaning', () => {
    expect(parseTextInfo("  OBJECTID = '4'\n")).toEqual([]);
    expect(parseTextInfo('no results')).toEqual([]);
  });

  it('keeps each feature apart, so a card never mixes two finds', () => {
    // Verbatim shape of Artsdatabanken's reply, the one upstream that answers
    // in this dialect alone. Read as one flat key/value list — which is what
    // this parser used to do — a tap in a town returns a single record whose
    // species, year and place come from three different observations.
    const body = `GetFeatureInfo results:

Layer 'SE_punkt'
  Feature 28270:
    VitNavn = 'Bunias orientalis'
    YearCollected = '2009'
    NorskNavn = 'russekål'
  Feature 371245:
    VitNavn = 'Rosa rugosa'
    YearCollected = '2021'
    NorskNavn = 'rynkerose'
`;
    expect(propsOf(parseTextInfo(body))).toEqual([
      { VitNavn: 'Bunias orientalis', YearCollected: '2009', NorskNavn: 'russekål' },
      { VitNavn: 'Rosa rugosa', YearCollected: '2021', NorskNavn: 'rynkerose' },
    ]);
  });

  it('reads a Norwegian field name, not the tail of one', () => {
    // Same trap the ESRI parser documents: an ASCII \w pattern starts matching
    // after the first non-ASCII letter, inventing a key nothing can match.
    expect(propsOf(parseTextInfo("  Feature 1:\n    Årstid = 'vinter'\n"))).toEqual([
      { Årstid: 'vinter' },
    ]);
  });
});

describe('keepSet + cleanProps', () => {
  it('lets a layer rescue a field from the generic noise list', () => {
    // Kartverket's wrecks carry the whole classification in `objtype`, which is
    // on NOISE_KEYS because every SOSI dataset has one. Before the allow-list
    // could override it, a tap on a nameless wreck answered "Depth: 47" and had
    // no word for what was down there.
    const wreck = { objtype: 'Vrak', dybde: '47', OBJECTID: '3' };
    expect(cleanProps(wreck)).toEqual({ dybde: '47' });
    expect(cleanProps(wreck, keepSet(['objektnavnnorsk', 'objtype', 'dybde']))).toEqual({
      objtype: 'Vrak',
      dybde: '47',
    });
  });

  it('does not rescue what no layer asked for', () => {
    expect(cleanProps({ objtype: 'Vrak' }, keepSet(['dybde']))).toEqual({});
  });
});

describe('decodeXmlText', () => {
  it('decodes the entities that make a link unusable', () => {
    // Verbatim from NGU's geosite fact sheet: with the `&amp;` left in, the
    // link opens the wrong page.
    expect(decodeXmlText('https://geo.ngu.no/x.php?lang=nor&amp;p_objid=14129')).toBe(
      'https://geo.ngu.no/x.php?lang=nor&p_objid=14129',
    );
    expect(decodeXmlText('&lt;b&gt; &quot;a&quot; &apos;b&apos; &#39;c&#39; &#x41;')).toBe(
      "<b> \"a\" 'b' 'c' A",
    );
  });

  it('leaves an unknown or malformed entity alone', () => {
    expect(decodeXmlText('100 &euro; &amp')).toBe('100 &euro; &amp');
  });

  it('is applied by the XML parsers', () => {
    expect(propsOf(parseGmlInfo('<x_feature><url>a&amp;b</url></x_feature>'))).toEqual([
      { url: 'a&b' },
    ]);
    expect(
      propsOf(
        parseEsriXmlInfo('<FeatureInfoResponse><FIELDS navn="Bl&amp;tt"/></FeatureInfoResponse>'),
      ),
    ).toEqual([{ navn: 'Bl&tt' }]);
  });
});

describe('translateTokens', () => {
  const species = { TORSK: 'cod', HYSE: 'haddock', SEI: 'saithe', OG: '', '0': '' };

  it('translates a list held in one attribute and sentence-cases it', () => {
    // Fiskeridirektoratet writes the species of a spawning area as one
    // space-separated string of shouted Norwegian names.
    expect(translateTokens('HYSE SEI TORSK', species)).toBe('Haddock, saithe, cod');
  });

  it('drops the junk in a hand-maintained list', () => {
    expect(translateTokens('SEI OG TORSK 0', species)).toBe('Saithe, cod');
    expect(translateTokens('OG 0', species)).toBe('');
  });

  it('keeps an unknown species instead of hiding it', () => {
    expect(translateTokens('TORSK GAPEFLYNDRE', species)).toBe('Cod, Gapeflyndre');
  });

  it('collapses a name repeated by the upstream', () => {
    expect(translateTokens('TORSK torsk TORSK', species)).toBe('Cod');
  });

  it('reaches the card through presentFields', () => {
    expect(
      presentFields({ arter: 'HYSE TORSK' }, { arter: 'Species' }, undefined, undefined, {
        arter: species,
      }),
    ).toEqual({ Species: 'Haddock, cod' });
  });
});

describe('formatEsriDateTime', () => {
  it('reorders ESRI’s US 12-hour datetime', () => {
    // Verbatim from NVE's slide register: read as written, a Norwegian reader
    // dates this event to 3 October.
    expect(formatEsriDateTime('3/10/2015 7:57:00 AM')).toBe('2015-03-10 07:57');
    expect(formatEsriDateTime('12/24/1999 11:05:00 PM')).toBe('1999-12-24 23:05');
    expect(formatEsriDateTime('12/24/1999 12:30:00 AM')).toBe('1999-12-24 00:30');
    expect(formatEsriDateTime('4/15/2015')).toBe('2015-04-15');
  });

  it('keeps anything it does not recognise verbatim', () => {
    expect(formatEsriDateTime('Null')).toBe('Null');
    expect(formatEsriDateTime('2015-03-10')).toBe('2015-03-10');
  });
});

describe('identifyZoom', () => {
  const meta = { minzoom: 11, maxzoom: 17 };

  it('caps the query zoom so a tap has ground radius, not pixels', () => {
    // A tap at z17 on a point layer has to land within a couple of metres of
    // the feature; measured against Askeladden and GRANADA, nothing answered.
    expect(identifyZoom(meta, 13, 17)).toBe(13);
    expect(identifyZoom(meta, 13, 16)).toBe(13);
  });

  it('never raises the zoom a coarser view asked for', () => {
    expect(identifyZoom(meta, 13, 12)).toBe(12);
  });

  it('never goes below the layer’s own floor', () => {
    // These upstreams refuse to draw — and to answer — outside their scale
    // band, so a coarser query would turn "nothing here" into "never answers".
    expect(identifyZoom(meta, 8, 17)).toBe(11);
    expect(identifyZoom(meta, undefined, 3)).toBe(11);
  });

  it('behaves exactly as before for a layer with no cap', () => {
    expect(identifyZoom({ maxzoom: 15 }, undefined, 17)).toBe(15);
    expect(identifyZoom({ maxzoom: 15 }, undefined, 12)).toBe(12);
    expect(identifyZoom({ maxzoom: 15 }, undefined, Number.NaN)).toBe(15);
  });
});

describe('dedupeResults', () => {
  it('collapses a feature the upstream answered for twice', () => {
    // DMF's `Sikringer` is a group whose only child is `Aktsomhetssone`, so
    // naming both spent half the card saying one thing.
    const zone = { Working: 'Hostvedt skjerp', Municipality: 'Flesberg' };
    expect(
      propsOf(
        dedupeResults([
          { props: zone },
          { props: { ...zone } },
          { props: { Working: 'Annet skjerp' } },
        ]),
      ),
    ).toEqual([zone, { Working: 'Annet skjerp' }]);
  });

  it('keeps records that differ in any field', () => {
    const a = { Species: 'russekål', 'Position accuracy (m)': '5' };
    const b = { Species: 'russekål', 'Position accuracy (m)': '6' };
    expect(propsOf(dedupeResults([{ props: a }, { props: b }]))).toEqual([a, b]);
  });
});
