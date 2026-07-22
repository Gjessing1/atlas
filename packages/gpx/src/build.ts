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

/** Placemarks for one track's waypoints and segments, at a given indent. */
function placemarks(data: TrackData, pad: string): string[] {
  const lines: string[] = [];

  for (const w of data.waypoints) {
    lines.push(`${pad}<Placemark>`);
    if (w.name) lines.push(`${pad}  <name>${escapeXml(w.name)}</name>`);
    const ele = w.ele !== undefined ? `,${w.ele}` : '';
    lines.push(
      `${pad}  <Point><coordinates>${coord(w.lng)},${coord(w.lat)}${ele}</coordinates></Point>`,
    );
    lines.push(`${pad}</Placemark>`);
  }

  for (const segment of data.segments) {
    lines.push(`${pad}<Placemark>`);
    if (data.name) lines.push(`${pad}  <name>${escapeXml(data.name)}</name>`);
    if (data.description) {
      lines.push(`${pad}  <description>${escapeXml(data.description)}</description>`);
    }
    const coords = segment
      .map((p) => `${coord(p.lng)},${coord(p.lat)}${p.ele !== undefined ? `,${p.ele}` : ''}`)
      .join(' ');
    lines.push(
      `${pad}  <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>`,
    );
    lines.push(`${pad}</Placemark>`);
  }

  return lines;
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
  lines.push(...placemarks(data, '    '));
  lines.push('  </Document>', '</kml>');
  return lines.join('\n') + '\n';
}

/**
 * A folder of the user's library for KML export: its own tracks/waypoints plus
 * nested folders. Deliberately structural, not an Atlas record type — the gpx
 * package may not depend on storage.
 */
export interface KmlFolder {
  name?: string;
  description?: string;
  /** Each entry becomes Point/LineString placemarks (see buildKml). */
  items: TrackData[];
  children: KmlFolder[];
}

/**
 * Serialize a whole folder tree as one KML document, so other mapping platforms
 * (Google Earth/My Maps, Gaia, CalTopo…) receive the user's structure and not a
 * flat pile of placemarks. KMZ is this document zipped as `doc.kml`.
 */
export function buildKmlTree(root: KmlFolder): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
  ];
  if (root.name) lines.push(`    <name>${escapeXml(root.name)}</name>`);
  if (root.description) lines.push(`    <description>${escapeXml(root.description)}</description>`);

  const folder = (node: KmlFolder, depth: number): void => {
    const pad = '  '.repeat(depth);
    lines.push(`${pad}<Folder>`);
    if (node.name) lines.push(`${pad}  <name>${escapeXml(node.name)}</name>`);
    if (node.description) {
      lines.push(`${pad}  <description>${escapeXml(node.description)}</description>`);
    }
    for (const item of node.items) lines.push(...placemarks(item, `${pad}  `));
    for (const child of node.children) folder(child, depth + 1);
    lines.push(`${pad}</Folder>`);
  };

  for (const item of root.items) lines.push(...placemarks(item, '    '));
  for (const child of root.children) folder(child, 2);

  lines.push('  </Document>', '</kml>');
  return lines.join('\n') + '\n';
}
