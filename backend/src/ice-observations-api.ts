import {
  ICE_OBSERVATIONS_ID,
  snapLabelBbox,
  type IceObservationAge,
  type IceObservationFeature,
  type IceObservationKind,
  type IceObservationsResponse,
  type LayerMeta,
} from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';

/**
 * Live ice observations from NVE's public Regobs v6 search API.
 *
 * This is deliberately separate from the `ice-weak` WMS. That raster is a
 * static hydropower hazard map; Regobs is the same rolling observation source
 * Iskart uses. Combining them under one row would make an old mapped polygon
 * look like a current field report.
 */

const SEARCH_URL = 'https://api.regobs.no/v6/Search';
const PROBE = 'regobs';
const LOOKBACK_MS = 90 * 24 * 60 * 60_000;
const CACHE_TTL_MS = 10 * 60_000;
const PAGE_SIZE = 500;
const MAX_PAGES = 4;
const OPEN_WATER_CODES = new Set([1, 11, 20, 40, 41]);

export interface IceObservationsApiOptions {
  fetchImpl?: typeof fetch;
  status?: StatusRegistry;
  /** Test seam for rolling windows and age colours. */
  now?: () => number;
}

interface RegobsLocation {
  ObsLocationID?: number | null;
  LocationName?: string | null;
  Latitude?: number;
  Longitude?: number;
}

interface RegobsRegistration {
  RegId?: number;
  DtObsTime?: string;
  ObsLocation?: RegobsLocation | null;
  Observer?: { NickName?: string | null } | null;
  IceCoverObs?: {
    IceCoverTID?: number | null;
    IceCoverName?: string | null;
    Comment?: string | null;
  } | null;
  IceThickness?: { IceThicknessSum?: number | null; Comment?: string | null } | null;
  DangerObs?: { DangerSignName?: string | null; Comment?: string | null }[] | null;
  GeneralObservation?: {
    ObsHeader?: string | null;
    ObsComment?: string | null;
    Comment?: string | null;
  } | null;
  Incident?: {
    IncidentHeader?: string | null;
    IncidentIngress?: string | null;
    IncidentText?: string | null;
  } | null;
  Summaries?:
    | {
        RegistrationName?: string | null;
        Summaries?: { Header?: string | null; Value?: unknown }[] | null;
      }[]
    | null;
}

interface Cached {
  at: number;
  data: IceObservationsResponse;
}

/** Public catalog row; route registration below owns the corresponding data. */
export function iceObservationLayerMeta(): LayerMeta {
  return {
    id: ICE_OBSERVATIONS_ID,
    rev: 1,
    title: 'Ice observations',
    description:
      'Latest 90 days from Regobs: open water, hazards, ice conditions and general observations.',
    group: 'Water & depth',
    attribution: '© NVE Regobs contributors',
    metadataUrl: 'https://varsom.no/is/iskart/',
    minzoom: 7,
    maxzoom: 18,
    defaultOpacity: 1,
    identify: false,
    coverageNote:
      'Marker shape is report type; colour is age (green 0–2 days, teal 3–7, blue 8–28, ' +
      'red 29–90). No marker means no recent report, never safe ice.',
    profiles: ['fishing', 'hunting', 'ski'],
    vector: true,
  };
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const ageFor = (
  observedAt: string,
  now: number,
): { age: IceObservationAge; markerColor: string } => {
  const days = Math.max(0, (now - Date.parse(observedAt)) / (24 * 60 * 60_000));
  if (days <= 2) return { age: 'fresh', markerColor: '#16a34a' };
  if (days <= 7) return { age: 'recent', markerColor: '#0f9f9a' };
  if (days <= 28) return { age: 'older', markerColor: '#2563eb' };
  return { age: 'stale', markerColor: '#dc2626' };
};

const kindFor = (
  registration: RegobsRegistration,
): { kind: IceObservationKind; label: string; symbol: string } => {
  if ((registration.DangerObs?.length ?? 0) > 0 || registration.Incident) {
    return { kind: 'danger', label: 'Ice hazard', symbol: '!' };
  }
  const cover = registration.IceCoverObs?.IceCoverTID;
  if (typeof cover === 'number' && OPEN_WATER_CODES.has(cover)) {
    return { kind: 'open-water', label: 'Open water', symbol: '≈' };
  }
  if (registration.IceCoverObs || registration.IceThickness) {
    return { kind: 'ice', label: 'Ice conditions', symbol: '◆' };
  }
  return { kind: 'observation', label: 'Ice observation', symbol: 'i' };
};

const summaryFor = (registration: RegobsRegistration): string | undefined => {
  const parts: string[] = [];
  const add = (value: unknown) => {
    const item = text(value);
    if (item && !parts.includes(item)) parts.push(item);
  };
  add(registration.IceCoverObs?.IceCoverName);
  const thickness = registration.IceThickness?.IceThicknessSum;
  if (typeof thickness === 'number' && Number.isFinite(thickness)) {
    add(`${Math.round(thickness * 100)} cm total ice`);
  }
  for (const danger of registration.DangerObs ?? []) {
    add(danger.DangerSignName);
    add(danger.Comment);
  }
  add(registration.Incident?.IncidentHeader);
  add(registration.Incident?.IncidentIngress);
  add(registration.GeneralObservation?.ObsHeader);
  add(registration.GeneralObservation?.ObsComment);
  add(registration.IceCoverObs?.Comment);
  add(registration.IceThickness?.Comment);
  if (parts.length === 0) {
    for (const group of registration.Summaries ?? []) {
      add(group.RegistrationName);
      for (const item of group.Summaries ?? []) {
        add(item.Header);
        if (typeof item.Value === 'string' || typeof item.Value === 'number')
          add(String(item.Value));
      }
    }
  }
  const joined = parts.slice(0, 3).join(' · ');
  return joined ? joined.slice(0, 240) : undefined;
};

/** Convert one full Regobs search record into the small public marker shape. */
export function iceObservationFeature(
  registration: RegobsRegistration,
  now: number,
): IceObservationFeature | null {
  const regId = registration.RegId;
  const observedAt = registration.DtObsTime;
  const location = registration.ObsLocation;
  const lat = location?.Latitude;
  const lng = location?.Longitude;
  if (
    !Number.isInteger(regId) ||
    !text(observedAt) ||
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    !Number.isFinite(Date.parse(observedAt!))
  ) {
    return null;
  }
  const type = kindFor(registration);
  const age = ageFor(observedAt!, now);
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      regId: regId!,
      ...type,
      observedAt: observedAt!,
      observer: text(registration.Observer?.NickName) ?? undefined,
      summary: summaryFor(registration),
      ...age,
      sourceUrl: `https://www.regobs.no/registration/${regId}`,
    },
  };
}

function parseBbox(raw: string | undefined): [number, number, number, number] | null {
  const values = raw?.split(',').map(Number);
  if (!values || values.length !== 4 || values.some((v) => !Number.isFinite(v))) return null;
  const [w, s, e, n] = values as [number, number, number, number];
  if (w < -180 || e > 180 || s < -85 || n > 85 || w >= e || s >= n) return null;
  // The layer appears from z7. This cap rejects accidental whole-country pulls
  // from custom clients without clipping ordinary phone/desktop viewports.
  if (e - w > 45 || n - s > 25) return null;
  return [w, s, e, n];
}

export function registerIceObservationsApi(
  app: FastifyInstance,
  opts: IceObservationsApiOptions = {},
): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const status = opts.status;
  const cache = new Map<string, Cached>();
  status?.register(PROBE, 'NVE Regobs (ice observations)', 'Hunting & fishing');

  const search = async (bbox: [number, number, number, number]): Promise<RegobsRegistration[]> => {
    const [w, s, e, n] = bbox;
    const records: RegobsRegistration[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = {
        LangKey: 2,
        SelectedGeoHazards: [70],
        FromDtObsTime: new Date(now() - LOOKBACK_MS).toISOString(),
        ToDtObsTime: new Date(now()).toISOString(),
        NumberOfRecords: PAGE_SIZE,
        Offset: page * PAGE_SIZE,
        OrderBy: 'DtObsTime',
        AscendingOrder: false,
        Extent: {
          TopLeft: { Latitude: n, Longitude: w },
          BottomRight: { Latitude: s, Longitude: e },
        },
      };
      const res = await fetchImpl(SEARCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Regobs upstream ${res.status}`);
      const pageRecords = (await res.json()) as unknown;
      if (!Array.isArray(pageRecords)) throw new Error('Regobs returned an invalid search body');
      records.push(...(pageRecords as RegobsRegistration[]));
      if (pageRecords.length < PAGE_SIZE) break;
    }
    return records;
  };

  app.get<{ Querystring: { bbox?: string } }>(
    `/api/overlay/${ICE_OBSERVATIONS_ID}/features`,
    async (request, reply) => {
      const bbox = parseBbox(request.query.bbox);
      if (!bbox) return reply.code(400).send({ error: 'valid viewport bbox required' });
      // Snap outwards to a shared quarter-degree cell: nearby pans and clients
      // share one response, and an edge observation can never be omitted by a
      // rounded cache key because the upstream query covers the whole cell.
      const queryBbox = snapLabelBbox(bbox);
      const key = queryBbox.join(',');
      const cached = cache.get(key);
      if (cached && now() - cached.at < CACHE_TTL_MS) {
        return reply.header('cache-control', 'public, max-age=300').send(cached.data);
      }
      try {
        const registrations = await search(queryBbox);
        const seen = new Set<number>();
        const features = registrations
          .map((registration) => iceObservationFeature(registration, now()))
          .filter((feature): feature is IceObservationFeature => feature !== null)
          .filter((feature) => {
            if (seen.has(feature.properties.regId)) return false;
            seen.add(feature.properties.regId);
            return true;
          })
          .sort(
            (a, b) => Date.parse(b.properties.observedAt) - Date.parse(a.properties.observedAt),
          );
        const data: IceObservationsResponse = { type: 'FeatureCollection', features };
        // Avoid an unbounded map when a server process survives a long season
        // of pans. Oldest insertion is the least valuable cache cell.
        if (cache.size >= 100) cache.delete(cache.keys().next().value as string);
        cache.set(key, { at: now(), data });
        status?.record(PROBE, true);
        return reply
          .header('cache-control', 'public, max-age=300, stale-if-error=86400')
          .send(data);
      } catch (err) {
        request.log.warn({ err, bbox }, 'Regobs ice-observation search failed');
        status?.record(PROBE, false, 'unreachable');
        if (cached) {
          return reply
            .header('warning', '110 - "stale Regobs response"')
            .header('cache-control', 'public, max-age=60')
            .send(cached.data);
        }
        return reply.code(502).send({ error: 'ice observations are unavailable right now' });
      }
    },
  );
}
