import { utm33ToWgs84, type LatLng } from '@atlas/core';
import { SaxesParser } from 'saxes';

import type { TrafficClosure } from './model.js';

export type TrafficKind = 'closure' | 'roadworks' | 'incident' | 'restriction';
export type TrafficSeverity = 'low' | 'medium' | 'high' | 'highest' | 'unknown';

export interface TrafficSituation {
  id: string;
  kind: TrafficKind;
  severity: TrafficSeverity;
  position: LatLng;
  /** NPRA's own Norwegian text. NLOD forbids translating it. */
  message: string;
  /** NPRA's own Norwegian location description. */
  location: string;
  startTime: string;
  endTime: string;
}

export interface DatexSnapshot {
  publishedAt: string;
  situations: TrafficSituation[];
  closures: TrafficClosure[];
}

interface Period {
  start?: string;
  end?: string;
  days: string[];
  timeStart?: string;
  timeEnd?: string;
}

interface RecordData {
  type: string;
  severity: string;
  management: string;
  overallStart: string;
  overallEnd: string;
  periods: Period[];
  comments: string[];
  location: string;
  roadNumber: string;
  lineSrs: string;
  lineText: string;
  lat?: number;
  lng?: number;
}

interface SituationData {
  id: string;
  severity: string;
  records: RecordData[];
}

const local = (name: string): string => name.replace(/^.*:/, '');
const attr = (attributes: Record<string, unknown>, name: string): string => {
  const value = attributes[name];
  return typeof value === 'string' ? value : '';
};

const osloClock = (at: Date): { day: string; seconds: number } => {
  const pieces = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const part = (kind: Intl.DateTimeFormatPartTypes) =>
    pieces.find((piece) => piece.type === kind)?.value ?? '';
  return {
    day: part('weekday').toLowerCase(),
    seconds: Number(part('hour')) * 3600 + Number(part('minute')) * 60 + Number(part('second')),
  };
};

const secondsOfDay = (value: string | undefined): number | null => {
  const match = /^(\d{2}):(\d{2}):(\d{2})/.exec(value ?? '');
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
};

/** DATEX overall validity plus its optional recurring weekday/time windows. */
function activeAt(record: RecordData, now: Date, clock: ReturnType<typeof osloClock>): boolean {
  const start = new Date(record.overallStart);
  const end = new Date(record.overallEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return false;
  if (now < start || now > end) return false;
  if (record.periods.length === 0) return true;
  return record.periods.some((period) => {
    const periodStart = new Date(period.start ?? '');
    const periodEnd = new Date(period.end ?? '');
    if (
      !Number.isFinite(periodStart.getTime()) ||
      !Number.isFinite(periodEnd.getTime()) ||
      now < periodStart ||
      now > periodEnd
    ) {
      return false;
    }
    if (period.days.length > 0 && !period.days.includes(clock.day)) return false;
    if (!period.timeStart && !period.timeEnd) return true;
    const from = secondsOfDay(period.timeStart);
    const to = secondsOfDay(period.timeEnd);
    if (from === null || to === null) return false;
    return from <= to
      ? clock.seconds >= from && clock.seconds <= to
      : clock.seconds >= from || clock.seconds <= to;
  });
}

function kindOf(records: RecordData[]): TrafficKind {
  if (records.some((record) => record.management === 'roadClosed')) return 'closure';
  if (records.some((record) => /Accident|Obstruction|RoadsideAssistance/.test(record.type))) {
    return 'incident';
  }
  if (records.some((record) => /MaintenanceWorks|ConstructionWorks/.test(record.type))) {
    return 'roadworks';
  }
  return 'restriction';
}

function severity(value: string): TrafficSeverity {
  const raw = value.toLowerCase();
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'highest' ? raw : 'unknown';
}

/** Reproject one DATEX GML line, rejecting unknown grids and absurd payloads. */
function roadGeometry(text: string, srs: string): LatLng[] | undefined {
  if (!/(?:25833|32633)$/.test(srs) || !text) return undefined;
  const rawValues = text.trim().split(/\s+/);
  if (rawValues.length > 40_000) return undefined;
  const values = rawValues.map(Number);
  if (
    values.length < 4 ||
    values.length % 2 !== 0 ||
    values.some((value) => !Number.isFinite(value))
  ) {
    return undefined;
  }
  const points: LatLng[] = [];
  for (let index = 0; index < values.length; index += 2) {
    points.push(utm33ToWgs84(values[index]!, values[index + 1]!));
  }
  return points;
}

/**
 * Parse the authenticated NPRA DATEX II v3 situation publication.
 *
 * This is deliberately a streaming reader, not XML-to-JS-object conversion:
 * the national snapshot is tens of megabytes and most of it is GML line
 * geometry. Only a closure record's affected line is reprojected and retained;
 * every other record's geometry dies with the streaming record. That keeps a
 * refresh sub-second instead of building a generic XML object for the feed.
 */
export function parseDatexSnapshot(xml: string, now = new Date()): DatexSnapshot {
  let publishedAt = '';
  const situations: TrafficSituation[] = [];
  const closures: DatexSnapshot['closures'] = [];
  const path: string[] = [];
  let currentSituation: SituationData | null = null;
  let currentRecord: RecordData | null = null;
  let currentPeriod: Period | null = null;
  let captureTag = '';
  let captureText = '';
  const clock = osloClock(now);

  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    const name = local(tag.name);
    path.push(name);
    if (name === 'situation') {
      currentSituation = { id: attr(tag.attributes, 'id'), severity: '', records: [] };
    } else if (name === 'situationRecord' && currentSituation) {
      currentRecord = {
        type: attr(tag.attributes, 'xsi:type').replace(/^.*:/, ''),
        severity: '',
        management: '',
        overallStart: '',
        overallEnd: '',
        periods: [],
        comments: [],
        location: '',
        roadNumber: '',
        lineSrs: '',
        lineText: '',
      };
    } else if (name === 'gmlLineString' && currentRecord && !currentRecord.lineSrs) {
      currentRecord.lineSrs = attr(tag.attributes, 'srsName');
    } else if (name === 'validPeriod' && currentRecord) {
      currentPeriod = { days: [] };
    }

    const parent = path.at(-2) ?? '';
    const wanted =
      name === 'publicationTime' ||
      name === 'overallSeverity' ||
      name === 'severity' ||
      name === 'overallStartTime' ||
      name === 'overallEndTime' ||
      name === 'startOfPeriod' ||
      name === 'endOfPeriod' ||
      name === 'applicableDay' ||
      name === 'startTimeOfPeriod' ||
      name === 'endTimeOfPeriod' ||
      name === 'roadOrCarriagewayOrLaneManagementType' ||
      name === 'roadNumber' ||
      (name === 'posList' && path.includes('gmlLineString')) ||
      name === 'latitude' ||
      name === 'longitude' ||
      (name === 'value' &&
        (path.includes('generalPublicComment') ||
          (parent === 'values' && path.includes('locationDescription'))));
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
      if (name === 'publicationTime' && !currentSituation) publishedAt = value;
      else if (name === 'overallSeverity' && currentSituation && !currentRecord) {
        currentSituation.severity = value;
      } else if (currentRecord) {
        if (name === 'severity') currentRecord.severity = value;
        else if (name === 'overallStartTime') currentRecord.overallStart = value;
        else if (name === 'overallEndTime') currentRecord.overallEnd = value;
        else if (name === 'roadOrCarriagewayOrLaneManagementType') {
          currentRecord.management = value;
        } else if (name === 'roadNumber' && !currentRecord.roadNumber) {
          currentRecord.roadNumber = value;
        } else if (name === 'posList' && !currentRecord.lineText) {
          currentRecord.lineText = value;
        } else if (name === 'startOfPeriod' && currentPeriod) currentPeriod.start = value;
        else if (name === 'endOfPeriod' && currentPeriod) currentPeriod.end = value;
        else if (name === 'applicableDay' && currentPeriod) currentPeriod.days.push(value);
        else if (name === 'startTimeOfPeriod' && currentPeriod) currentPeriod.timeStart = value;
        else if (name === 'endTimeOfPeriod' && currentPeriod) currentPeriod.timeEnd = value;
        else if (name === 'latitude' && currentRecord.lat === undefined) {
          const number = Number(value);
          if (Number.isFinite(number) && Math.abs(number) <= 90) currentRecord.lat = number;
        } else if (name === 'longitude' && currentRecord.lng === undefined) {
          const number = Number(value);
          if (Number.isFinite(number) && Math.abs(number) <= 180) currentRecord.lng = number;
        } else if (name === 'value' && value) {
          if (path.includes('generalPublicComment')) currentRecord.comments.push(value);
          else if (path.includes('locationDescription') && !currentRecord.location) {
            currentRecord.location = value;
          }
        }
      }
      captureTag = '';
      captureText = '';
    }

    if (name === 'validPeriod' && currentPeriod && currentRecord) {
      currentRecord.periods.push(currentPeriod);
      currentPeriod = null;
    } else if (name === 'situationRecord' && currentRecord && currentSituation) {
      currentSituation.records.push(currentRecord);
      currentRecord = null;
    } else if (name === 'situation' && currentSituation) {
      const active = currentSituation.records.filter((record) => activeAt(record, now, clock));
      const located = active.find((record) => record.lat !== undefined && record.lng !== undefined);
      if (active.length > 0 && located?.lat !== undefined && located.lng !== undefined) {
        const closed = active.find((record) => record.management === 'roadClosed');
        const messages = [...new Set(active.flatMap((record) => record.comments))];
        const message = messages.join('\n') || 'Trafikkmelding';
        const starts = active
          .map((record) => record.overallStart)
          .filter(Boolean)
          .sort();
        const ends = active
          .map((record) => record.overallEnd)
          .filter(Boolean)
          .sort();
        const position = { lat: located.lat, lng: located.lng };
        situations.push({
          id: currentSituation.id,
          kind: kindOf(active),
          severity: severity(currentSituation.severity || active[0]?.severity || ''),
          position,
          message,
          location: active.find((record) => record.location)?.location ?? '',
          startTime: starts[0] ?? '',
          endTime: ends.at(-1) ?? '',
        });
        if (closed) {
          const geometry = roadGeometry(closed.lineText, closed.lineSrs);
          closures.push({
            id: currentSituation.id,
            position:
              closed.lat !== undefined && closed.lng !== undefined
                ? { lat: closed.lat, lng: closed.lng }
                : position,
            message,
            ...(closed.roadNumber ? { roadNumber: closed.roadNumber } : {}),
            ...(geometry ? { roadGeometry: geometry } : {}),
          });
        }
      }
      currentSituation = null;
    }
    path.pop();
  });
  parser.write(xml).close();
  if (!publishedAt) throw new Error('DATEX publication has no publicationTime');
  return { publishedAt, situations, closures };
}
