import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildElevationProfile,
  buildGpx,
  buildKml,
  buildKmlTree,
  computeTrackStats,
  parseGpx,
  parseKml,
  parseKmz,
  parseTrackFile,
  trackBounds,
  type TrackData,
} from './index.js';

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Meta name</name></metadata>
  <wpt lat="59.9" lon="10.7"><ele>10</ele><name>Cabin &amp; camp</name></wpt>
  <trk>
    <name>Morning hike</name>
    <trkseg>
      <trkpt lat="59.90000" lon="10.70000"><ele>100</ele><time>2026-06-01T10:00:00Z</time></trkpt>
      <trkpt lat="59.90100" lon="10.70000"><ele>110</ele><time>2026-06-01T10:05:00Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="59.91000" lon="10.71000"/>
    </trkseg>
  </trk>
</gpx>`;

describe('parseGpx', () => {
  it('parses tracks, segments, waypoints, elevation and time', () => {
    const data = parseGpx(SAMPLE_GPX);
    expect(data.name).toBe('Morning hike');
    expect(data.segments).toHaveLength(2);
    expect(data.segments[0]).toHaveLength(2);
    expect(data.segments[0]![0]).toMatchObject({ lat: 59.9, lng: 10.7, ele: 100 });
    expect(data.segments[0]![0]!.time).toBe(Date.parse('2026-06-01T10:00:00Z'));
    expect(data.segments[1]![0]!.ele).toBeUndefined();
    expect(data.waypoints).toEqual([{ lat: 59.9, lng: 10.7, ele: 10, name: 'Cabin & camp' }]);
  });

  it('normalizes routes into segments', () => {
    const data = parseGpx(`<gpx><rte><name>R</name>
      <rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte></gpx>`);
    expect(data.name).toBe('R');
    expect(data.segments).toEqual([
      [
        { lat: 1, lng: 2 },
        { lat: 3, lng: 4 },
      ],
    ]);
  });

  it('rejects non-GPX XML', () => {
    expect(() => parseGpx('<foo/>')).toThrow(/gpx/i);
  });
});

describe('buildGpx', () => {
  it('round-trips through parseGpx', () => {
    const original = parseGpx(SAMPLE_GPX);
    const rebuilt = parseGpx(buildGpx(original));
    expect(rebuilt.name).toBe(original.name);
    expect(rebuilt.segments).toEqual(original.segments);
    expect(rebuilt.waypoints).toEqual(original.waypoints);
  });

  it('escapes XML special characters', () => {
    const gpx = buildGpx({
      name: 'a <b> & "c"',
      segments: [],
      waypoints: [{ lat: 1, lng: 2, name: '<wp>' }],
    });
    expect(gpx).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(gpx).toContain('&lt;wp&gt;');
    expect(parseGpx(gpx).waypoints[0]!.name).toBe('<wp>');
  });
});

describe('buildKml', () => {
  it('round-trips through parseKml', () => {
    const original = parseGpx(SAMPLE_GPX);
    const rebuilt = parseKml(buildKml(original));
    expect(rebuilt.name).toBe(original.name);
    // KML has no per-point timestamps in plain LineStrings; compare geometry.
    expect(rebuilt.segments.map((s) => s.map(({ lat, lng, ele }) => ({ lat, lng, ele })))).toEqual(
      original.segments.map((s) => s.map(({ lat, lng, ele }) => ({ lat, lng, ele }))),
    );
    expect(rebuilt.waypoints).toEqual(original.waypoints);
  });
});

describe('waypoint addresses and notes', () => {
  it('round-trips through GPX and KML', () => {
    const original = {
      segments: [],
      waypoints: [{ lat: 59.91, lng: 10.75, name: 'Office', address: 'Karl Johans gate 1' }],
    };
    expect(parseGpx(buildGpx(original)).waypoints).toEqual(original.waypoints);
    expect(parseKml(buildKml(original)).waypoints).toEqual(original.waypoints);
  });

  // A saved hunting stand's plan lives in its notes and its address is empty:
  // a file carrying only the pin's name would strip the reason it exists.
  it('carries the notes out and back, beside the address rather than instead of it', () => {
    const original = {
      segments: [],
      waypoints: [
        {
          lat: 59.85,
          lng: 10.42,
          name: 'Rådyrbukk stand 1',
          address: 'Skogsvegen 4',
          notes: 'Calling stand: 48 m SE toward habitat.\nVerify your backstop.',
        },
      ],
    };
    expect(parseGpx(buildGpx(original)).waypoints).toEqual(original.waypoints);
    expect(parseKml(buildKml(original)).waypoints).toEqual(original.waypoints);
  });

  it('puts the notes in <desc>, the element other apps show', () => {
    const gpx = buildGpx({
      segments: [],
      waypoints: [{ lat: 59.85, lng: 10.42, address: 'Skogsvegen 4', notes: 'Face SE.' }],
    });
    expect(gpx).toContain('<desc>Face SE.</desc>');
    expect(gpx).toContain('<cmt>Skogsvegen 4</cmt>');
  });
});

describe('buildKmlTree', () => {
  it('nests folders and keeps every placemark readable by parseKml', () => {
    const kml = buildKmlTree({
      name: 'Atlas',
      items: [{ segments: [], waypoints: [{ lat: 59.9, lng: 10.7, name: 'Loose pin' }] }],
      children: [
        {
          name: 'Trips & tours',
          items: [{ ...parseGpx(SAMPLE_GPX), name: 'Morning ride' }],
          children: [
            {
              name: 'Nested',
              items: [{ segments: [], waypoints: [{ lat: 60.1, lng: 11.2, name: 'Deep pin' }] }],
              children: [],
            },
          ],
        },
      ],
    });

    expect(kml).toContain('<name>Trips &amp; tours</name>');
    expect(kml.indexOf('<name>Nested</name>')).toBeLessThan(kml.indexOf('<name>Deep pin'));
    // Folder nesting: the child folder closes before its parent does.
    expect(kml.match(/<Folder>/g)).toHaveLength(2);

    // Flat read-back (parseKml ignores folders) still sees everything.
    const parsed = parseKml(kml);
    expect(parsed.waypoints.map((w) => w.name)).toEqual(
      expect.arrayContaining(['Loose pin', 'Deep pin', 'Cabin & camp']),
    );
    expect(parsed.segments.length).toBe(parseGpx(SAMPLE_GPX).segments.length);
  });
});

const SAMPLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>KML doc</name>
    <Folder>
      <Placemark>
        <name>A line</name>
        <LineString><coordinates>
          10.70,59.90,100 10.71,59.91,110
        </coordinates></LineString>
      </Placemark>
      <Placemark>
        <name>A point</name>
        <Point><coordinates>10.75,59.95</coordinates></Point>
      </Placemark>
    </Folder>
    <Placemark>
      <gx:Track>
        <when>2026-06-01T10:00:00Z</when>
        <when>2026-06-01T10:01:00Z</when>
        <gx:coord>10.80 59.80 50</gx:coord>
        <gx:coord>10.81 59.81 60</gx:coord>
      </gx:Track>
    </Placemark>
    <Placemark>
      <MultiGeometry>
        <LineString><coordinates>1,2 3,4</coordinates></LineString>
      </MultiGeometry>
    </Placemark>
  </Document>
</kml>`;

describe('parseKml', () => {
  it('parses linestrings, points, gx:Track and MultiGeometry across folders', () => {
    const data = parseKml(SAMPLE_KML);
    expect(data.name).toBe('KML doc');
    expect(data.segments).toHaveLength(3);
    expect(data.segments[0]).toEqual([
      { lat: 59.9, lng: 10.7, ele: 100 },
      { lat: 59.91, lng: 10.71, ele: 110 },
    ]);
    const gxSegment = data.segments.find((s) => s[0]!.time !== undefined)!;
    expect(gxSegment[0]).toEqual({
      lat: 59.8,
      lng: 10.8,
      ele: 50,
      time: Date.parse('2026-06-01T10:00:00Z'),
    });
    expect(data.waypoints).toEqual([{ lat: 59.95, lng: 10.75, name: 'A point' }]);
  });

  it('rejects non-KML XML', () => {
    expect(() => parseKml('<foo/>')).toThrow(/kml/i);
  });
});

describe('parseKmz / parseTrackFile', () => {
  it('extracts and parses the KML inside a KMZ archive', () => {
    const kmz = zipSync({ 'doc.kml': new TextEncoder().encode(SAMPLE_KML) });
    const data = parseKmz(kmz);
    expect(data.name).toBe('KML doc');
    expect(data.segments).toHaveLength(3);
  });

  it('dispatches by extension and falls back to the file name', () => {
    const gpx = new TextEncoder().encode('<gpx><wpt lat="1" lon="2"/></gpx>');
    const data = parseTrackFile('Jotunheimen Tur.GPX', gpx);
    expect(data.name).toBe('Jotunheimen Tur');
    expect(data.waypoints).toHaveLength(1);
    expect(() => parseTrackFile('foo.txt', gpx)).toThrow(/unsupported/i);
  });
});

describe('computeTrackStats', () => {
  it('computes distance, elevation gain with hysteresis, and duration', () => {
    const data: TrackData = {
      segments: [
        [
          { lat: 59.9, lng: 10.7, ele: 100, time: 0 },
          { lat: 59.901, lng: 10.7, ele: 101, time: 60_000 }, // +1 m: below hysteresis, ignored
          { lat: 59.902, lng: 10.7, ele: 110, time: 120_000 }, // +10 m from anchor
          { lat: 59.903, lng: 10.7, ele: 105, time: 180_000 }, // -5 m
        ],
      ],
      waypoints: [],
    };
    const stats = computeTrackStats(data);
    expect(stats.points).toBe(4);
    // Three ~111 m legs (0.001° latitude each).
    expect(stats.distanceM).toBeGreaterThan(320);
    expect(stats.distanceM).toBeLessThan(345);
    expect(stats.ascentM).toBe(10);
    expect(stats.descentM).toBe(5);
    expect(stats.minEleM).toBe(100);
    expect(stats.maxEleM).toBe(110);
    expect(stats.durationMs).toBe(180_000);
  });

  it('handles tracks without elevation or time', () => {
    const stats = computeTrackStats({ segments: [[{ lat: 1, lng: 2 }]], waypoints: [] });
    expect(stats).toEqual({ points: 1, distanceM: 0, ascentM: 0, descentM: 0 });
  });
});

describe('buildElevationProfile', () => {
  it('accumulates distance across segments and skips points without elevation', () => {
    const data: TrackData = {
      segments: [
        [
          { lat: 59.9, lng: 10.7, ele: 100 },
          { lat: 59.901, lng: 10.7 }, // no ele — adds distance but no sample
          { lat: 59.902, lng: 10.7, ele: 120 },
        ],
      ],
      waypoints: [],
    };
    const profile = buildElevationProfile(data);
    expect(profile).toHaveLength(2);
    expect(profile[0]).toMatchObject({ distM: 0, ele: 100 });
    expect(profile[1]!.ele).toBe(120);
    expect(profile[1]!.distM).toBeGreaterThan(200);
  });

  it('downsamples long series but keeps the final point', () => {
    const segment = Array.from({ length: 1000 }, (_, i) => ({
      lat: 59.9 + i * 0.0001,
      lng: 10.7,
      ele: i,
    }));
    const profile = buildElevationProfile({ segments: [segment], waypoints: [] }, 100);
    expect(profile).toHaveLength(101);
    expect(profile[profile.length - 1]!.ele).toBe(999);
  });
});

describe('trackBounds', () => {
  it('spans segments and waypoints, and is null when empty', () => {
    const bounds = trackBounds({
      segments: [[{ lat: 1, lng: 2 }]],
      waypoints: [{ lat: -1, lng: 5 }],
    });
    expect(bounds).toEqual({ sw: { lat: -1, lng: 2 }, ne: { lat: 1, lng: 5 } });
    expect(trackBounds({ segments: [], waypoints: [] })).toBeNull();
  });
});
