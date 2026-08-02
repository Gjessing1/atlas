import { utm33ToWgs84, type LatLng } from '@atlas/core';
import { SaxesParser } from 'saxes';

/**
 * One directed stretch of road NPRA measures end-to-end, with the geometry it
 * is measured over. `Åsanevegen - Eikås` and `Eikås - Åsanevegen` are two
 * corridors, not one: each carries its own measurement, which is the whole
 * point on a road where only one direction queues.
 */
export interface TravelTimeCorridor {
  id: string;
  /** NPRA's own Norwegian name, `"<from> - <to>"`. Never translated. */
  name: string;
  points: LatLng[];
}

/** How the road is running, as NPRA classifies it. */
export type TravelTimeStatus = 'freeFlow' | 'heavy' | 'slow' | 'queuing' | 'stationary' | 'unknown';

/** The measurement for one corridor over the last five-minute window. */
export interface TravelTimeMeasurement {
  corridorId: string;
  /** Measured seconds end to end. Absent when the corridor reports nothing. */
  durationS?: number;
  /** NPRA's uncongested reference time for the same stretch, in seconds. */
  freeFlowS?: number;
  status: TravelTimeStatus;
  /** End of the aggregation window the measurement covers. */
  measuredAt: string;
}

export interface TravelTimeSnapshot {
  publishedAt: string;
  measurements: TravelTimeMeasurement[];
}

const local = (name: string): string => name.replace(/^.*:/, '');

const STATUSES: readonly TravelTimeStatus[] = [
  'freeFlow',
  'heavy',
  'slow',
  'queuing',
  'stationary',
  'unknown',
];

const statusOf = (raw: string): TravelTimeStatus =>
  STATUSES.find((status) => status === raw) ?? 'unknown';

/**
 * Parse `GetPredefinedTravelTimeLocations` — the corridor table.
 *
 * The geometry arrives as a GML `posList` of UTM33 easting/northing pairs
 * (`srsName` epsg 32633), so every vertex is reprojected here rather than at
 * match time: the table changes a few times a year, a route is matched against
 * it on every request.
 */
export function parseTravelTimeCorridors(xml: string): {
  publishedAt: string;
  corridors: TravelTimeCorridor[];
} {
  let publishedAt = '';
  const corridors: TravelTimeCorridor[] = [];
  const path: string[] = [];
  let current: { id: string; name: string; points: LatLng[] } | null = null;
  let captureTag = '';
  let captureText = '';

  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    const name = local(tag.name);
    path.push(name);
    if (name === 'predefinedLocationReference') {
      const id = typeof tag.attributes['id'] === 'string' ? tag.attributes['id'] : '';
      current = id ? { id, name: '', points: [] } : null;
    }
    const wanted =
      name === 'publicationTime' ||
      name === 'posList' ||
      (name === 'value' && path.includes('predefinedLocationName'));
    if (wanted) {
      captureTag = name;
      captureText = '';
    }
  });
  parser.on('text', (chunk) => {
    if (captureTag) captureText += chunk;
  });
  parser.on('closetag', (tag) => {
    const name = local(tag.name);
    if (captureTag === name) {
      const value = captureText.trim();
      if (name === 'publicationTime' && !current) publishedAt = value;
      else if (current && name === 'value' && !current.name) current.name = value;
      else if (current && name === 'posList') {
        const numbers = value.split(/\s+/).map(Number);
        for (let i = 0; i + 1 < numbers.length; i += 2) {
          const x = numbers[i]!;
          const y = numbers[i + 1]!;
          if (Number.isFinite(x) && Number.isFinite(y)) current.points.push(utm33ToWgs84(x, y));
        }
      }
      captureTag = '';
      captureText = '';
    }
    if (name === 'predefinedLocationReference' && current) {
      if (current.points.length >= 2) corridors.push(current);
      current = null;
    }
    path.pop();
  });
  parser.write(xml).close();
  if (!publishedAt) throw new Error('DATEX corridor table has no publicationTime');
  return { publishedAt, corridors };
}

/**
 * Parse `GetTravelTimeData` — the five-minute measurements.
 *
 * Each corridor appears twice, as a `TravelTimeData` quantity and a
 * `TrafficStatus` one, both pointing at the same predefined location. A
 * corridor with nothing to report is *present* with status `unknown` and no
 * duration at all (62 of 202 on the first live probe), so a missing duration
 * must never be read as "the road is clear".
 */
export function parseTravelTimeSnapshot(xml: string): TravelTimeSnapshot {
  let publishedAt = '';
  const byCorridor = new Map<string, TravelTimeMeasurement>();
  const path: string[] = [];
  let corridorId = '';
  let inTravelTime = false;
  let captureTag = '';
  let captureText = '';
  let pendingDuration: number | null = null;
  let pendingFreeFlow: number | null = null;
  let pendingMeasuredAt = '';

  const record = (id: string): TravelTimeMeasurement => {
    const existing = byCorridor.get(id);
    if (existing) return existing;
    const fresh: TravelTimeMeasurement = { corridorId: id, status: 'unknown', measuredAt: '' };
    byCorridor.set(id, fresh);
    return fresh;
  };

  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    const name = local(tag.name);
    path.push(name);
    if (name === 'physicalQuantity') {
      corridorId = '';
      inTravelTime = false;
      pendingDuration = null;
      pendingFreeFlow = null;
      pendingMeasuredAt = '';
    } else if (name === 'predefinedLocationReference') {
      const id = tag.attributes['id'];
      if (typeof id === 'string') corridorId = id;
    } else if (name === 'basicData') {
      const type = tag.attributes['xsi:type'];
      inTravelTime = typeof type === 'string' && type.endsWith('TravelTimeData');
    }
    const wanted =
      name === 'publicationTime' ||
      name === 'duration' ||
      name === 'endOfPeriod' ||
      name === 'trafficStatusValue';
    if (wanted) {
      captureTag = name;
      captureText = '';
    }
  });
  parser.on('text', (chunk) => {
    if (captureTag) captureText += chunk;
  });
  parser.on('closetag', (tag) => {
    const name = local(tag.name);
    if (captureTag === name) {
      const value = captureText.trim();
      if (name === 'publicationTime' && !corridorId) publishedAt = value;
      else if (name === 'endOfPeriod') pendingMeasuredAt = value;
      else if (name === 'trafficStatusValue' && corridorId) {
        record(corridorId).status = statusOf(value);
      } else if (name === 'duration') {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds > 0) {
          // `travelTime` comes before `freeFlowTravelTime`; both are bare
          // `duration` elements, told apart only by their parent.
          if (path.includes('freeFlowTravelTime')) pendingFreeFlow = seconds;
          else if (path.includes('travelTime')) pendingDuration = seconds;
        }
      }
      captureTag = '';
      captureText = '';
    }
    if (name === 'physicalQuantity' && corridorId && inTravelTime) {
      const entry = record(corridorId);
      if (pendingDuration !== null) entry.durationS = pendingDuration;
      if (pendingFreeFlow !== null) entry.freeFlowS = pendingFreeFlow;
      if (pendingMeasuredAt) entry.measuredAt = pendingMeasuredAt;
    }
    path.pop();
  });
  parser.write(xml).close();
  if (!publishedAt) throw new Error('DATEX travel-time publication has no publicationTime');
  return { publishedAt, measurements: [...byCorridor.values()] };
}
