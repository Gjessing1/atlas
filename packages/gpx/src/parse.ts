import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import type { TrackData, TrackPoint, Waypoint } from './model.js';

// Tags that must always parse as arrays even when they occur once.
const ARRAY_TAGS = new Set([
  'trk',
  'trkseg',
  'trkpt',
  'rte',
  'rtept',
  'wpt',
  'Document',
  'Folder',
  'Placemark',
  'LineString',
  'Point',
  'Track', // gx:Track (namespace prefixes are stripped)
  'when',
  'coord',
]);

function makeParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    // Keep every value a string; we convert numbers/dates explicitly.
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
}

/* fast-xml-parser output is untyped; these helpers narrow it defensively. */
type Node = Record<string, unknown>;

function asNodes(value: unknown): Node[] {
  if (Array.isArray(value))
    return value.filter((v): v is Node => typeof v === 'object' && v !== null);
  if (typeof value === 'object' && value !== null) return [value as Node];
  return [];
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'object' && value !== null) return text((value as Node)['#text']);
  return undefined;
}

function num(value: unknown): number | undefined {
  const s = text(value);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function timestamp(value: unknown): number | undefined {
  const s = text(value);
  if (s === undefined) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** Parse a GPX 1.0/1.1 document. Throws on XML that is not a GPX file at all. */
export function parseGpx(xml: string): TrackData {
  const root = makeParser().parse(xml) as Node;
  const gpx = asNodes(root['gpx'])[0];
  if (!gpx) throw new Error('Not a GPX file (missing <gpx> root element)');

  const data: TrackData = { segments: [], waypoints: [] };

  const parsePoint = (pt: Node): TrackPoint | null => {
    const lat = num(pt['@_lat']);
    const lng = num(pt['@_lon']);
    if (lat === undefined || lng === undefined) return null;
    const point: TrackPoint = { lat, lng };
    const ele = num(pt['ele']);
    if (ele !== undefined) point.ele = ele;
    const time = timestamp(pt['time']);
    if (time !== undefined) point.time = time;
    return point;
  };

  for (const trk of asNodes(gpx['trk'])) {
    data.name ??= text(trk['name']);
    data.description ??= text(trk['desc']);
    for (const seg of asNodes(trk['trkseg'])) {
      const points = asNodes(seg['trkpt'])
        .map(parsePoint)
        .filter((p): p is TrackPoint => p !== null);
      if (points.length > 0) data.segments.push(points);
    }
  }

  // Routes are planned point sequences; normalize each into one segment.
  for (const rte of asNodes(gpx['rte'])) {
    data.name ??= text(rte['name']);
    const points = asNodes(rte['rtept'])
      .map(parsePoint)
      .filter((p): p is TrackPoint => p !== null);
    if (points.length > 0) data.segments.push(points);
  }

  for (const wpt of asNodes(gpx['wpt'])) {
    const point = parsePoint(wpt);
    if (!point) continue;
    const waypoint: Waypoint = { lat: point.lat, lng: point.lng };
    if (point.ele !== undefined) waypoint.ele = point.ele;
    const name = text(wpt['name']);
    if (name !== undefined) waypoint.name = name;
    const address = text(wpt['cmt']);
    if (address !== undefined) waypoint.address = address;
    const notes = text(wpt['desc']);
    if (notes !== undefined) waypoint.notes = notes;
    data.waypoints.push(waypoint);
  }

  const metadata = asNodes(gpx['metadata'])[0];
  if (metadata) {
    data.name ??= text(metadata['name']);
    data.description ??= text(metadata['desc']);
  }
  return data;
}

/** Parse a KML `<coordinates>` blob: whitespace-separated `lng,lat[,ele]` tuples. */
function parseKmlCoordinates(value: unknown): TrackPoint[] {
  const s = text(value);
  if (!s) return [];
  const points: TrackPoint[] = [];
  for (const tuple of s.split(/\s+/)) {
    const [lng, lat, ele] = tuple.split(',').map(Number);
    if (lng === undefined || lat === undefined || !Number.isFinite(lat) || !Number.isFinite(lng))
      continue;
    const point: TrackPoint = { lat, lng };
    if (ele !== undefined && Number.isFinite(ele)) point.ele = ele;
    points.push(point);
  }
  return points;
}

/** Recursively collect placemark geometries from a KML container node. */
function collectKml(node: Node, data: TrackData): void {
  for (const container of [...asNodes(node['Document']), ...asNodes(node['Folder'])]) {
    data.name ??= text(container['name']);
    collectKml(container, data);
  }

  for (const placemark of asNodes(node['Placemark'])) {
    const name = text(placemark['name']);
    const address = text(placemark['address']);
    collectGeometry(placemark, name, data, address, text(placemark['description']));
  }
}

/** Extract geometries from a placemark or MultiGeometry node. */
function collectGeometry(
  node: Node,
  name: string | undefined,
  data: TrackData,
  address?: string,
  notes?: string,
): void {
  for (const line of asNodes(node['LineString'])) {
    const points = parseKmlCoordinates(line['coordinates']);
    if (points.length > 0) {
      data.segments.push(points);
      data.name ??= name;
    }
  }

  // gx:Track pairs <when> timestamps with <gx:coord> "lng lat ele" tuples.
  for (const track of asNodes(node['Track'])) {
    const whens = Array.isArray(track['when']) ? (track['when'] as unknown[]) : [];
    const coords = Array.isArray(track['coord']) ? (track['coord'] as unknown[]) : [];
    const points: TrackPoint[] = [];
    for (let i = 0; i < coords.length; i++) {
      const parts = (text(coords[i]) ?? '').split(/\s+/).map(Number);
      const [lng, lat, ele] = parts;
      if (lng === undefined || lat === undefined || !Number.isFinite(lat) || !Number.isFinite(lng))
        continue;
      const point: TrackPoint = { lat, lng };
      if (ele !== undefined && Number.isFinite(ele)) point.ele = ele;
      const time = timestamp(whens[i]);
      if (time !== undefined) point.time = time;
      points.push(point);
    }
    if (points.length > 0) {
      data.segments.push(points);
      data.name ??= name;
    }
  }

  for (const point of asNodes(node['Point'])) {
    const coords = parseKmlCoordinates(point['coordinates']);
    const p = coords[0];
    if (!p) continue;
    const waypoint: Waypoint = { lat: p.lat, lng: p.lng };
    if (p.ele !== undefined) waypoint.ele = p.ele;
    if (name !== undefined) waypoint.name = name;
    if (address !== undefined) waypoint.address = address;
    if (notes !== undefined) waypoint.notes = notes;
    data.waypoints.push(waypoint);
  }

  const multi = node['MultiGeometry'];
  if (typeof multi === 'object' && multi !== null) {
    collectGeometry(multi as Node, name, data, address, notes);
  }
}

/** Parse a KML document. Throws on XML that is not KML at all. */
export function parseKml(xml: string): TrackData {
  const root = makeParser().parse(xml) as Node;
  const kml = root['kml'];
  if (typeof kml !== 'object' || kml === null) {
    throw new Error('Not a KML file (missing <kml> root element)');
  }
  const data: TrackData = { segments: [], waypoints: [] };
  collectKml(kml as Node, data);
  return data;
}

/** Parse a KMZ archive (zipped KML): extracts and parses the first .kml entry. */
export function parseKmz(bytes: Uint8Array): TrackData {
  const entries = unzipSync(bytes);
  const kmlName =
    Object.keys(entries).find((n) => n.toLowerCase() === 'doc.kml') ??
    Object.keys(entries).find((n) => n.toLowerCase().endsWith('.kml'));
  if (!kmlName) throw new Error('KMZ archive contains no .kml entry');
  return parseKml(new TextDecoder().decode(entries[kmlName]));
}

/**
 * Parse a track file by extension (.gpx / .kml / .kmz). The returned name falls
 * back to the file name (sans extension) when the file itself has none.
 */
export function parseTrackFile(fileName: string, bytes: Uint8Array): TrackData {
  const ext = fileName.replace(/^.*\./, '').toLowerCase();
  let data: TrackData;
  if (ext === 'gpx') data = parseGpx(new TextDecoder().decode(bytes));
  else if (ext === 'kml') data = parseKml(new TextDecoder().decode(bytes));
  else if (ext === 'kmz') data = parseKmz(bytes);
  else throw new Error(`Unsupported track file type: .${ext}`);
  data.name ??= fileName.replace(/\.[^.]+$/, '');
  return data;
}
