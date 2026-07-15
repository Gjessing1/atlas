import type { TrackData } from './model.js';

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const coord = (n: number): string => String(Math.round(n * 1e7) / 1e7);

/**
 * Serialize track data as a GPX 1.1 document — Atlas's canonical storage and
 * export format for tracks (rule: everything exportable).
 */
export function buildGpx(data: TrackData): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Atlas" xmlns="http://www.topografix.com/GPX/1/1">',
  ];

  if (data.name || data.description) {
    lines.push('  <metadata>');
    if (data.name) lines.push(`    <name>${escapeXml(data.name)}</name>`);
    if (data.description) lines.push(`    <desc>${escapeXml(data.description)}</desc>`);
    lines.push('  </metadata>');
  }

  for (const w of data.waypoints) {
    lines.push(`  <wpt lat="${coord(w.lat)}" lon="${coord(w.lng)}">`);
    if (w.ele !== undefined) lines.push(`    <ele>${w.ele}</ele>`);
    if (w.name) lines.push(`    <name>${escapeXml(w.name)}</name>`);
    lines.push('  </wpt>');
  }

  if (data.segments.length > 0) {
    lines.push('  <trk>');
    if (data.name) lines.push(`    <name>${escapeXml(data.name)}</name>`);
    for (const segment of data.segments) {
      lines.push('    <trkseg>');
      for (const p of segment) {
        const children: string[] = [];
        if (p.ele !== undefined) children.push(`<ele>${p.ele}</ele>`);
        if (p.time !== undefined) children.push(`<time>${new Date(p.time).toISOString()}</time>`);
        if (children.length === 0) {
          lines.push(`      <trkpt lat="${coord(p.lat)}" lon="${coord(p.lng)}"/>`);
        } else {
          lines.push(
            `      <trkpt lat="${coord(p.lat)}" lon="${coord(p.lng)}">${children.join('')}</trkpt>`,
          );
        }
      }
      lines.push('    </trkseg>');
    }
    lines.push('  </trk>');
  }

  lines.push('</gpx>');
  return lines.join('\n') + '\n';
}

/**
 * Serialize track data as a KML document, for interop with Google Earth/Maps.
 * Segments become LineString placemarks; waypoints become Point placemarks.
 */
export function buildKml(data: TrackData): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
  ];
  if (data.name) lines.push(`    <name>${escapeXml(data.name)}</name>`);
  if (data.description) lines.push(`    <description>${escapeXml(data.description)}</description>`);

  for (const w of data.waypoints) {
    lines.push('    <Placemark>');
    if (w.name) lines.push(`      <name>${escapeXml(w.name)}</name>`);
    const ele = w.ele !== undefined ? `,${w.ele}` : '';
    lines.push(
      `      <Point><coordinates>${coord(w.lng)},${coord(w.lat)}${ele}</coordinates></Point>`,
    );
    lines.push('    </Placemark>');
  }

  for (const segment of data.segments) {
    lines.push('    <Placemark>');
    if (data.name) lines.push(`      <name>${escapeXml(data.name)}</name>`);
    const coords = segment
      .map((p) => `${coord(p.lng)},${coord(p.lat)}${p.ele !== undefined ? `,${p.ele}` : ''}`)
      .join(' ');
    lines.push(
      `      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>`,
    );
    lines.push('    </Placemark>');
  }

  lines.push('  </Document>', '</kml>');
  return lines.join('\n') + '\n';
}
