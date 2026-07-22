import { describe, expect, it } from 'vitest';
import {
  cleanProps,
  parseEsriXmlInfo,
  parseGeojsonInfo,
  parseGmlInfo,
  parseTextInfo,
  selectFields,
} from './identify.js';

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

describe('parseGeojsonInfo', () => {
  it('cleans each feature and keeps empty ones for the caller to drop', () => {
    const body = JSON.stringify({
      features: [{ properties: { dybde_m: 24, OBJECTID: 7 } }, { properties: { OBJECTID: 8 } }, {}],
    });
    expect(parseGeojsonInfo(body)).toEqual([{ dybde_m: '24' }, {}, {}]);
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
    expect(parseGmlInfo(gml)).toEqual([{ dybde_m: '31' }, { dybde_m: '12' }]);
  });

  it('reads a featureMember dialect and drops features left empty', () => {
    const gml = `<wfs:FeatureCollection>
      <gml:featureMember><teig><matrikkelnummer>3203-1/2</matrikkelnummer></teig></gml:featureMember>
      <gml:featureMember><teig><OBJECTID>9</OBJECTID></teig></gml:featureMember>
    </wfs:FeatureCollection>`;
    expect(parseGmlInfo(gml)).toEqual([{ matrikkelnummer: '3203-1/2' }]);
  });
});

describe('parseEsriXmlInfo', () => {
  it('reads one FIELDS element per feature', () => {
    const esri = `<?xml version="1.0" encoding="UTF-8"?>
      <FeatureInfoResponse xmlns="http://www.esri.com/wms">
        <FIELDS OBJECTID="56112" navn="Tyrifjorden" dybde_m="180" Shape.STLength()="14771.8"/>
        <FIELDS navn="Steinsfjorden" dybde_m="22"/>
      </FeatureInfoResponse>`;
    expect(parseEsriXmlInfo(esri)).toEqual([
      { navn: 'Tyrifjorden', dybde_m: '180' },
      { navn: 'Steinsfjorden', dybde_m: '22' },
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
    expect(parseTextInfo(body)).toEqual([{ dybde_m: '12' }]);
  });

  it('answers empty when nothing survives cleaning', () => {
    expect(parseTextInfo("  OBJECTID = '4'\n")).toEqual([]);
    expect(parseTextInfo('no results')).toEqual([]);
  });
});
