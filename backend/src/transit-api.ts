import {
  buildEnturDeparturesRequest,
  buildEnturRequest,
  buildEnturVehiclesRequest,
  commuteEmptyReason,
  commuteRefreshAtMs,
  commuteSegmentQueries,
  commuteTransitQueries,
  defaultCommuteDirection,
  departureWidgetRow,
  emptyDirectionNote,
  filterCommuteResult,
  isTransitLineId,
  isTransitStopId,
  commuteWidgetBoard,
  parseEnturDeparturesResponse,
  parseEnturResponse,
  parseEnturGeocoderResponse,
  parseEnturStopLinesResponse,
  parseEnturVehiclesResponse,
  transitCoverage,
  transitCoversPoint,
  widgetCheckedLabel,
  widgetSourceLabel,
  widgetStatusLine,
  ENTUR_STOP_LINES_QUERY,
  MINUTES_PER_DAY,
  RIDE_MODES,
  SEARCH_WINDOW_RETRY_MINUTES,
  WIDE_SEARCH_WINDOW_MINUTES,
} from '@atlas/transit';
import type {
  CommuteEmptyReason,
  TransitCommuteDirection,
  TransitCommutePlace,
  TransitCommuteQuery,
  TransitCommuteTime,
  TransitDeparturesResult,
  TransitLineRef,
  TransitLocation,
  TransitMode,
  TransitQuery,
  TransitResult,
  TransitWeekday,
  TransitWidgetBoard,
} from '@atlas/transit';
import type { LayerMeta } from '@atlas/core';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';

/**
 * POST /api/transit — public transport journey planning for Norway, proxied
 * from Entur's Journey Planner v3 (the national planner behind every Norwegian
 * operator's app, free under NLOD, **no API key**).
 *
 * Why proxy rather than call from the browser:
 *  - Entur's one requirement is an identifying `ET-Client-Name` header; callers
 *    who omit it are throttled hard. Setting it in exactly one place means a
 *    client can't forget it — the same argument as met.no's User-Agent.
 *  - The endpoint stays behind our own rate limiter and single origin.
 *
 * The route answers in the *Atlas* trip model, not Entur's GraphQL shape, so
 * the wire mapping lives in `@atlas/transit` (tested against recorded
 * fixtures) rather than here. This module is a thin adapter, per the rule that
 * business logic never lives in the backend.
 *
 * An empty `trips` array is a 200, not an error: "nothing runs at 01:00" is a
 * real answer and the UI distinguishes it from a failure.
 */

const ENTUR_URL = 'https://api.entur.io/journey-planner/v3/graphql';
const ENTUR_GEOCODER_URL = 'https://api.entur.io/geocoder/v1/autocomplete';
const ENTUR_VEHICLES_URL = 'https://api.entur.io/realtime/v2/vehicles/graphql';
const TRANSIT_PROBE = 'entur';
const VEHICLES_PROBE = 'entur-vehicles';
/** Entur asks consumers to identify themselves; this is that identity. */
const CLIENT_NAME = 'atlas-journeyplanner';
const UPSTREAM_TIMEOUT_MS = 10_000;
/**
 * Rows per per-leg board. Five is what the spec draws and what fits a phone
 * without scrolling past the journeys above it; each costs one cheap `trip`
 * call, so the whole dashboard is two via-journeys (~3 s, the expensive half)
 * plus four hops (~0.4 s) in parallel.
 */
const COMMUTE_SEGMENT_ROWS = 5;

export interface TransitApiOptions {
  /** Entur Journey Planner GraphQL endpoint (ENTUR_URL to override). */
  enturUrl?: string;
  /** Entur autocomplete endpoint (ENTUR_GEOCODER_URL to override). */
  geocoderUrl?: string;
  /** Entur realtime vehicle GraphQL endpoint. */
  vehicleUrl?: string;
  /** Value for the mandatory ET-Client-Name header (ENTUR_CLIENT_NAME to override). */
  clientName?: string;
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Health registry: Entur is one probed source. */
  status?: StatusRegistry;
}

/** Standing, optional map layer; every request is bounded to the visible map. */
export function transitVehicleLayerMeta(): LayerMeta {
  return {
    id: 'transit-vehicles',
    rev: 1,
    title: 'Live public transport',
    description: 'Current positions, delays and occupancy from participating Norwegian feeds.',
    group: 'Public transport',
    attribution: 'Data made available by Entur (NLOD)',
    metadataUrl: 'https://developer.entur.org/pages-real-time-vehicle/',
    minzoom: 8,
    maxzoom: 18,
    defaultOpacity: 1,
    identify: false,
    coverageNote:
      'Norway only; an internet connection is required. Operators without live positions are absent.',
    vector: true,
  };
}

function vehicleBounds(
  value: unknown,
): { west: number; south: number; east: number; north: number } | null {
  if (typeof value !== 'string') return null;
  const values = value.split(',').map(Number);
  if (values.length !== 4 || values.some((part) => !Number.isFinite(part))) return null;
  const [west, south, east, north] = values as [number, number, number, number];
  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north ||
    (east - west) * (north - south) > 100
  ) {
    return null;
  }
  return { west, south, east, north };
}

function parsePoint(value: unknown): TransitLocation | null {
  if (!value || typeof value !== 'object') return null;
  const { lat, lng, stopId } = value as { lat?: unknown; lng?: unknown; stopId?: unknown };
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    lat,
    lng,
    ...(isTransitStopId(stopId) ? { stopId } : {}),
  };
}

/** Narrow an untrusted body to a TransitQuery, or explain what's wrong with it. */
function parseQuery(body: unknown): { query: TransitQuery } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'expected a JSON object' };
  const raw = body as Record<string, unknown>;
  const from = parsePoint(raw.from);
  const to = parsePoint(raw.to);
  if (!from || !to) return { error: 'from and to must be {lat, lng} coordinates' };
  const via = Array.isArray(raw.via) ? raw.via.map(parsePoint) : [];
  if (via.some((point) => point === null) || via.length > 8) {
    return { error: 'via must contain at most 8 valid coordinates' };
  }
  const validVia = via as TransitLocation[];
  if (!transitCoverage(from, to) || validVia.some((point) => !transitCoversPoint(point))) {
    // The defined non-Norway behaviour: say so plainly instead of forwarding a
    // query the national planner cannot answer.
    return { error: 'public transport is available for journeys within Norway only' };
  }
  const query: TransitQuery = { from, to };
  if (validVia.length > 0) query.via = validVia;
  if (typeof raw.dateTimeMs === 'number' && Number.isFinite(raw.dateTimeMs)) {
    query.dateTimeMs = raw.dateTimeMs;
  }
  if (raw.arriveBy === true) query.arriveBy = true;
  if (typeof raw.limit === 'number' && Number.isFinite(raw.limit)) query.limit = raw.limit;
  if (typeof raw.walkSpeedMps === 'number' && raw.walkSpeedMps > 0 && raw.walkSpeedMps <= 5) {
    query.walkSpeedMps = raw.walkSpeedMps;
  }
  // An explicit window means the caller is doing its own paging and does not
  // want the empty-answer retry below second-guessing it. Capped at a day —
  // beyond that the planner is being asked to do unbounded work.
  if (
    typeof raw.searchWindowMinutes === 'number' &&
    raw.searchWindowMinutes > 0 &&
    raw.searchWindowMinutes <= WIDE_SEARCH_WINDOW_MINUTES
  ) {
    query.searchWindowMinutes = Math.trunc(raw.searchWindowMinutes);
  }
  // Unknown mode names are dropped rather than rejected: a newer client asking
  // for a mode this build hasn't heard of should get a journey, not a 400.
  // `coach` is accepted although it is not a chip — it is a real wire mode, and
  // an older client that still sends it explicitly must keep working.
  if (Array.isArray(raw.modes)) {
    const allowed = [...RIDE_MODES, 'coach' as TransitMode];
    const modes = raw.modes.filter((mode): mode is TransitMode =>
      allowed.includes(mode as TransitMode),
    );
    if (modes.length > 0) query.modes = modes;
  }
  // An opaque cursor from a previous answer. Length-capped rather than parsed:
  // it is Entur's own token, and the only thing this proxy must guarantee is
  // that an absurd string never reaches them on our client name.
  if (typeof raw.pageCursor === 'string' && raw.pageCursor.length > 0) {
    if (raw.pageCursor.length > 512) return { error: 'pageCursor is not a cursor we issued' };
    query.pageCursor = raw.pageCursor;
  }
  return { query };
}

function parseCommutePlace(value: unknown): TransitCommutePlace | null {
  const point = parsePoint(value);
  if (!point || !value || typeof value !== 'object') return null;
  const name = (value as { name?: unknown }).name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) return null;
  return { ...point, name: name.trim() };
}

const text = (value: unknown, maxLength: number): string | undefined =>
  typeof value === 'string' && value.trim() && value.trim().length <= maxLength
    ? value.trim()
    : undefined;

/**
 * A picked line. The id is the only field that reaches Entur; the rest is what
 * the client will render, kept so a board can label a chip without re-asking
 * the stop. Anything without a valid id is dropped rather than rejected — a
 * newer client sending a shape this build does not know should still get a
 * board, and a line that cannot be filtered on is not a filter.
 */
function parseLineRef(value: unknown): TransitLineRef | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isTransitLineId(raw.id)) return null;
  const mode = RIDE_MODES.includes(raw.mode as TransitMode) ? (raw.mode as TransitMode) : 'unknown';
  return {
    id: raw.id,
    publicCode: text(raw.publicCode, 24) ?? raw.id,
    mode,
    ...(text(raw.name, 120) ? { name: text(raw.name, 120)! } : {}),
    ...(text(raw.operator, 60) ? { operator: text(raw.operator, 60)! } : {}),
    ...(text(raw.towards, 60) ? { towards: text(raw.towards, 60)! } : {}),
  };
}

function parseLineRefs(value: unknown, maxItems: number): TransitLineRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      const line = parseLineRef(item);
      return line ? [line] : [];
    })
    .slice(0, maxItems);
}

function parseCommuteTime(value: unknown): TransitCommuteTime {
  const raw = (value ?? {}) as Record<string, unknown>;
  const minutes = raw.minutesOfDay;
  const valid =
    typeof minutes === 'number' &&
    Number.isFinite(minutes) &&
    minutes >= 0 &&
    minutes < MINUTES_PER_DAY;
  return {
    minutesOfDay: valid ? Math.trunc(minutes) : null,
    arriveBy: raw.arriveBy === true,
  };
}

function parseWeekdays(value: unknown): TransitWeekday[] {
  if (!Array.isArray(value)) return [];
  const days = value.filter(
    (day): day is TransitWeekday =>
      typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7,
  );
  return [...new Set(days)].sort((a, b) => a - b);
}

function parseCommuteQuery(body: unknown): { query: TransitCommuteQuery } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'expected a JSON object' };
  const raw = body as Record<string, unknown>;
  const from = parseCommutePlace(raw.from);
  const to = parseCommutePlace(raw.to);
  const via = Array.isArray(raw.via) ? raw.via.map(parseCommutePlace) : [];
  if (!from || !to || via.some((place) => place === null) || via.length > 8) {
    return { error: 'commute places must be named, valid coordinates' };
  }
  const allPlaces = [from, ...(via as TransitCommutePlace[]), to];
  if (allPlaces.some((place) => !transitCoversPoint(place))) {
    return { error: 'public transport is available for journeys within Norway only' };
  }
  const rawFilter = (raw.filter ?? {}) as Record<string, unknown>;
  // No mode ban by default: the previous board hard-coded bus+rail, which
  // silently deleted every journey finishing on the T-bane.
  const modes = Array.isArray(rawFilter.modes)
    ? rawFilter.modes.filter((mode): mode is TransitMode =>
        RIDE_MODES.includes(mode as TransitMode),
      )
    : [];
  return {
    query: {
      from,
      via: via as TransitCommutePlace[],
      to,
      filter: {
        select: parseLineRefs(rawFilter.select, 20),
        exclude: parseLineRefs(rawFilter.exclude, 20),
        modes,
      },
      outboundTime: parseCommuteTime(raw.outboundTime),
      inboundTime: parseCommuteTime(raw.inboundTime),
      days: parseWeekdays(raw.days),
      ...(typeof raw.limit === 'number' && Number.isFinite(raw.limit)
        ? { limit: Math.min(Math.max(Math.trunc(raw.limit), 1), 10) }
        : {}),
    },
  };
}

/**
 * A one-stop widget board, in the same shape as the commute one so the widget
 * renders both with one code path. The refresh follows the next departure just
 * as the commute board does — the point of this kind is that it costs one
 * upstream call, not that it is checked less carefully.
 */
function stopWidgetBoard({
  departures,
  label,
  nowMs,
  maxRows,
}: {
  departures: TransitDeparturesResult;
  label: string;
  nowMs: number;
  maxRows: number;
}): TransitWidgetBoard {
  const rows = departures.departures.slice(0, maxRows).map((d) => departureWidgetRow(d));
  const name = departures.stop?.name || label || 'Stop';
  const note = rows.length === 0 ? emptyDirectionNote('upstream') : null;
  const source = widgetSourceLabel(rows.length > 0, note);
  return {
    route: name,
    directions: [{ key: 'outbound', label: name, rows, note }],
    checkedMs: nowMs,
    source,
    checked: widgetCheckedLabel(nowMs),
    status: widgetStatusLine(source, nowMs),
    // No saved commute window here, so an empty board is simply asked again
    // later; the shared helper's floor and ceiling still apply.
    nextRefreshMs: commuteRefreshAtMs(
      {
        from: { name, lat: 0, lng: 0 },
        via: [],
        to: { name, lat: 0, lng: 0 },
        filter: { select: [], exclude: [], modes: [] },
        outboundTime: { minutesOfDay: null, arriveBy: false },
        inboundTime: { minutesOfDay: null, arriveBy: false },
        days: [],
      },
      rows,
      nowMs,
    ),
  };
}

export function registerTransitApi(app: FastifyInstance, opts: TransitApiOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const status = opts.status;
  status?.register(TRANSIT_PROBE, 'Entur (public transport)', 'Public transport');
  status?.register(VEHICLES_PROBE, 'Entur live vehicles', 'Public transport');
  const enturUrl = opts.enturUrl ?? process.env.ENTUR_URL ?? ENTUR_URL;
  const geocoderUrl = opts.geocoderUrl ?? process.env.ENTUR_GEOCODER_URL ?? ENTUR_GEOCODER_URL;
  const vehicleUrl = opts.vehicleUrl ?? process.env.ENTUR_VEHICLES_URL ?? ENTUR_VEHICLES_URL;
  const clientName = opts.clientName ?? process.env.ENTUR_CLIENT_NAME ?? CLIENT_NAME;

  app.get('/api/overlay/transit-vehicles/features', async (request, reply) => {
    const raw = request.query as { bbox?: unknown };
    const bounds = vehicleBounds(raw.bbox);
    if (!bounds) {
      return reply.code(400).send({ error: 'bbox must be west,south,east,north within 100 deg²' });
    }
    try {
      const response = await fetchImpl(vehicleUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'ET-Client-Name': clientName,
        },
        body: JSON.stringify(buildEnturVehiclesRequest(bounds)),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) {
        status?.record(VEHICLES_PROBE, false, `HTTP ${response.status}`);
        return reply.code(502).send({ error: 'live vehicle positions unavailable' });
      }
      const body: unknown = await response.json();
      if (
        body !== null &&
        typeof body === 'object' &&
        Array.isArray((body as { errors?: unknown }).errors) &&
        (body as { errors: unknown[] }).errors.length > 0
      ) {
        status?.record(VEHICLES_PROBE, false, 'GraphQL error');
        return reply.code(502).send({ error: 'live vehicle positions unavailable' });
      }
      const features = parseEnturVehiclesResponse(body);
      status?.record(VEHICLES_PROBE, true);
      status?.setDetail(VEHICLES_PROBE, `${features.features.length} vehicles in last viewport`);
      return reply
        .header('cache-control', 'public, max-age=10, stale-while-revalidate=20')
        .send(features);
    } catch (error) {
      request.log.error({ err: error }, 'Entur live vehicles unreachable');
      status?.record(VEHICLES_PROBE, false, 'unreachable');
      status?.setDetail(VEHICLES_PROBE, null);
      return reply.code(502).send({ error: 'live vehicle positions unavailable' });
    }
  });

  app.get('/api/transit/stops', async (request, reply) => {
    const raw = request.query as {
      q?: unknown;
      limit?: unknown;
      lat?: unknown;
      lon?: unknown;
    };
    if (typeof raw.q !== 'string' || raw.q.trim().length < 2 || raw.q.trim().length > 100) {
      return reply.code(400).send({ error: 'q must be between 2 and 100 characters' });
    }
    const requestedLimit =
      typeof raw.limit === 'string' && /^\d+$/.test(raw.limit) ? Number(raw.limit) : 6;
    const limit = Math.min(Math.max(requestedLimit, 1), 10);
    const lat = typeof raw.lat === 'string' ? Number(raw.lat) : NaN;
    const lon = typeof raw.lon === 'string' ? Number(raw.lon) : NaN;
    const hasBias =
      Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

    const url = new URL(geocoderUrl);
    url.searchParams.set('text', raw.q.trim());
    url.searchParams.set('lang', 'en');
    url.searchParams.set('size', String(limit));
    url.searchParams.set('layers', 'venue');
    url.searchParams.set('boundary.country', 'NOR');
    url.searchParams.set('multiModal', 'parent');
    if (hasBias) {
      url.searchParams.set('focus.point.lat', String(lat));
      url.searchParams.set('focus.point.lon', String(lon));
    }

    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'ET-Client-Name': clientName,
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) {
        request.log.error({ status: response.status }, 'entur geocoder error');
        status?.record(TRANSIT_PROBE, false, `HTTP ${response.status}`);
        return reply.code(502).send({ error: 'public transport stop search unavailable' });
      }
      const results = parseEnturGeocoderResponse(await response.json());
      status?.record(TRANSIT_PROBE, true);
      // NSR stop identities are stable; a short browser cache keeps
      // autocomplete responsive without making a changed name linger all day.
      reply.header('cache-control', 'private, max-age=300');
      return { results };
    } catch (err) {
      request.log.error({ err }, 'entur geocoder unreachable');
      status?.record(TRANSIT_PROBE, false, 'unreachable');
      return reply.code(502).send({ error: 'public transport stop search unavailable' });
    }
  });

  app.get('/api/transit/departures', async (request, reply) => {
    const raw = request.query as {
      lat?: unknown;
      lon?: unknown;
      stopId?: unknown;
      startTimeMs?: unknown;
      limit?: unknown;
    };
    const lat = typeof raw.lat === 'string' ? Number(raw.lat) : NaN;
    const lng = typeof raw.lon === 'string' ? Number(raw.lon) : NaN;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return reply.code(400).send({ error: 'lat and lon must be valid coordinates' });
    }
    if (!transitCoversPoint({ lat, lng })) {
      return reply.code(400).send({ error: 'departure boards are available within Norway only' });
    }
    if (raw.stopId !== undefined && !isTransitStopId(raw.stopId)) {
      return reply.code(400).send({ error: 'stopId must be an NSR StopPlace id' });
    }
    const startTimeMs =
      typeof raw.startTimeMs === 'string' && raw.startTimeMs.trim()
        ? Number(raw.startTimeMs)
        : undefined;
    if (startTimeMs !== undefined && !Number.isFinite(startTimeMs)) {
      return reply.code(400).send({ error: 'startTimeMs must be an epoch timestamp' });
    }
    const requestedLimit =
      typeof raw.limit === 'string' && /^\d+$/.test(raw.limit) ? Number(raw.limit) : undefined;
    const query = {
      lat,
      lng,
      ...(typeof raw.stopId === 'string' ? { stopId: raw.stopId } : {}),
      ...(startTimeMs === undefined ? {} : { startTimeMs }),
      ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
    };

    try {
      const response = await fetchImpl(enturUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'ET-Client-Name': clientName,
        },
        body: JSON.stringify(buildEnturDeparturesRequest(query)),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) {
        request.log.error({ status: response.status }, 'entur departure board error');
        status?.record(TRANSIT_PROBE, false, `HTTP ${response.status}`);
        return reply.code(502).send({ error: 'departure board unavailable' });
      }
      const result = parseEnturDeparturesResponse(await response.json());
      status?.record(TRANSIT_PROBE, true);
      // These are live estimates. Absorb rapid reopen/refresh taps, but never
      // let a shared cache turn a missed bus into a believable departure.
      reply.header('cache-control', 'private, max-age=15');
      return result;
    } catch (err) {
      request.log.error({ err }, 'entur departure board unreachable');
      status?.record(TRANSIT_PROBE, false, 'unreachable');
      return reply.code(502).send({ error: 'departure board unavailable' });
    }
  });

  app.post('/api/transit', async (request, reply) => {
    const parsed = parseQuery(request.body);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

    const ask = (query: TransitQuery) =>
      fetchImpl(enturUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'ET-Client-Name': clientName,
        },
        body: JSON.stringify(buildEnturRequest(query)),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

    try {
      const res = await ask(parsed.query);
      if (!res.ok) {
        request.log.error({ status: res.status }, 'entur error');
        status?.record(TRANSIT_PROBE, false, `HTTP ${res.status}`);
        return reply.code(502).send({ error: 'journey planner unavailable' });
      }
      let result = parseEnturResponse(await res.json());
      // Entur's default look-ahead is a dynamic few hours. On a sparse route
      // that reports "no service" when the next departure is simply tomorrow
      // morning — measured: Å i Lofoten → Svolvær at 23:30 returns nothing,
      // though a 04:24 bus exists. So an empty answer is widened before it is
      // believed. The retry is deliberately not the first attempt: a wide window
      // costs the planner real work, and on a busy corridor the default already
      // answers — which is also why it steps (see SEARCH_WINDOW_RETRY_MINUTES)
      // rather than opening a full day straight away, a query slow enough to
      // reach UPSTREAM_TIMEOUT_MS and turn "tomorrow morning" into a 502.
      // Not when paging: a cursor already carries the planner's own window, and
      // widening it would re-answer a different question than the one the
      // Later button asked.
      if (
        result.trips.length === 0 &&
        parsed.query.searchWindowMinutes === undefined &&
        parsed.query.pageCursor === undefined
      ) {
        for (const searchWindowMinutes of SEARCH_WINDOW_RETRY_MINUTES) {
          const retry = await ask({ ...parsed.query, searchWindowMinutes });
          if (!retry.ok) break;
          result = parseEnturResponse(await retry.json());
          if (result.trips.length > 0) break;
        }
      }
      status?.record(TRANSIT_PROBE, true);
      // Timetables move: a short cache absorbs a double-click without ever
      // showing a departure time that has quietly gone stale.
      reply.header('cache-control', 'private, max-age=30');
      return result;
    } catch (err) {
      request.log.error({ err }, 'entur unreachable');
      status?.record(TRANSIT_PROBE, false, 'unreachable');
      return reply.code(502).send({ error: 'journey planner unavailable' });
    }
  });

  /**
   * One direction of a saved commute, asked *as* the commute.
   *
   * The lines are in the question (`trip(filters:)`), so there is normally one
   * upstream call per direction where the previous board made up to three:
   * unfiltered, then 6 h, then a 24 h window measured at 7.5 s, discarding most
   * of each answer locally. The widening retry survives only for a commute with
   * no time of day — "leave now" on a sparse route genuinely can mean tomorrow
   * morning — and never when a time was asked about, because "nothing runs at
   * 07:10" is then the true answer rather than a window too narrow.
   */
  const askDirection = async (
    query: TransitQuery,
    filter: TransitCommuteQuery['filter'],
  ): Promise<
    | { ok: true; result: TransitResult; emptyReason: CommuteEmptyReason }
    | { ok: false; status: number }
  > => {
    const ask = (attempt: TransitQuery) =>
      fetchImpl(enturUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'ET-Client-Name': clientName,
        },
        body: JSON.stringify(buildEnturRequest(attempt)),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

    const first = await ask(query);
    if (!first.ok) return { ok: false, status: first.status };
    let upstream = parseEnturResponse(await first.json());
    if (upstream.trips.length === 0 && query.dateTimeMs === undefined) {
      for (const searchWindowMinutes of SEARCH_WINDOW_RETRY_MINUTES) {
        const wider = await ask({ ...query, searchWindowMinutes });
        if (!wider.ok) return { ok: false, status: wider.status };
        upstream = parseEnturResponse(await wider.json());
        if (upstream.trips.length > 0) break;
      }
    }
    const result = filterCommuteResult(upstream, filter);
    const reason = commuteEmptyReason(result, filter, upstream.trips.length);
    return { ok: true, result, emptyReason: reason };
  };

  /**
   * Drop leg geometry from a commute answer.
   *
   * Measured on the live Engelsrud ↔ Nationaltheatret board (2026-08-25): the
   * full dashboard response is 704 KB, of which **614 KB — 87% — is
   * `leg.points`**, the decoded polyline of every leg of every option. The
   * commute board has no map on either client (only the *planner's* trip is
   * drawn, by `useTransitLayers`), so every one of those bytes crosses a phone's
   * link on each refresh to be parsed and thrown away. Stripping them takes the
   * same board to 90 KB.
   *
   * Deliberately not done on `/api/transit`, where the geometry is the answer:
   * that endpoint's journeys *are* drawn.
   */
  const withoutGeometry = (result: TransitResult): TransitResult => ({
    ...result,
    trips: result.trips.map((trip) => ({
      ...trip,
      legs: trip.legs.map((leg) => ({ ...leg, points: [] })),
    })),
  });

  app.post('/api/transit/commute', async (request, reply) => {
    const parsed = parseCommuteQuery(request.body);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const queries = commuteTransitQueries(parsed.query, Date.now());
    // The dashboard's per-leg boards (§6.4 §5), fanned out here rather than by
    // the client: one request over a phone's link instead of five, one failure
    // to handle, and one place that knows the corridor's hops. Opt-in, because
    // the widget and any older client want only the two directions.
    const wantSegments = (request.body as { segments?: unknown } | null)?.segments === true;
    const segmentQueries = wantSegments
      ? commuteSegmentQueries(parsed.query, COMMUTE_SEGMENT_ROWS)
      : [];

    try {
      const [outbound, inbound, ...segmentAnswers] = await Promise.all([
        askDirection(queries.outbound, parsed.query.filter),
        askDirection(queries.inbound, parsed.query.filter),
        ...segmentQueries.map((segment) => askDirection(segment.query, parsed.query.filter)),
      ]);
      // Checked one at a time so each stays narrowed: `!a.ok || !b.ok` tells
      // TypeScript nothing about `b` inside the branch.
      const unavailable = (statusCode: number) => {
        request.log.error({ status: statusCode }, 'entur commute error');
        status?.record(TRANSIT_PROBE, false, `HTTP ${statusCode}`);
        return reply.code(502).send({ error: 'commute board unavailable' });
      };
      if (!outbound.ok) return unavailable(outbound.status);
      if (!inbound.ok) return unavailable(inbound.status);
      status?.record(TRANSIT_PROBE, true);
      reply.header('cache-control', 'private, max-age=30');
      return {
        outbound: withoutGeometry(outbound.result),
        inbound: withoutGeometry(inbound.result),
        // Which nothing it was, per direction, so a board can offer the way out
        // of its own filter instead of blaming the timetable.
        emptyReason: { outbound: outbound.emptyReason, inbound: inbound.emptyReason },
        // A hop that failed is dropped rather than failing the whole dashboard:
        // the journeys above it are the answer people came for, and one dead
        // per-leg board is worth strictly less than the board it sits under.
        ...(wantSegments
          ? {
              segments: segmentQueries.flatMap((segment, index) => {
                const answer = segmentAnswers[index];
                return answer?.ok
                  ? [{ id: segment.id, result: withoutGeometry(answer.result) }]
                  : [];
              }),
            }
          : {}),
      };
    } catch (err) {
      request.log.error({ err }, 'entur commute unreachable');
      status?.record(TRANSIT_PROBE, false, 'unreachable');
      return reply.code(502).send({ error: 'commute board unavailable' });
    }
  });

  /**
   * GET /api/transit/stop-lines?stopId=NSR:StopPlace:3369 — every line calling
   * at one stop, so a commute's services are *ticked* rather than typed. A
   * `publicCode` is not a line: `lines(publicCode:"280")` matches three of them
   * nationally, and Engelsrud's "71" is Brakar's `BRA:Line:4_6071`.
   *
   * The one transit answer worth a real cache: a stop's line set changes with
   * the timetable, not the minute.
   */
  app.get('/api/transit/stop-lines', async (request, reply) => {
    const raw = request.query as { stopId?: unknown };
    if (!isTransitStopId(raw.stopId)) {
      return reply.code(400).send({ error: 'stopId must be an NSR StopPlace id' });
    }
    try {
      const response = await fetchImpl(enturUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'ET-Client-Name': clientName,
        },
        body: JSON.stringify({ query: ENTUR_STOP_LINES_QUERY, variables: { id: raw.stopId } }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) {
        request.log.error({ status: response.status }, 'entur stop lines error');
        status?.record(TRANSIT_PROBE, false, `HTTP ${response.status}`);
        return reply.code(502).send({ error: 'stop lines unavailable' });
      }
      const result = parseEnturStopLinesResponse(await response.json());
      status?.record(TRANSIT_PROBE, true);
      reply.header('cache-control', 'private, max-age=21600');
      return result;
    } catch (err) {
      request.log.error({ err }, 'entur stop lines unreachable');
      status?.record(TRANSIT_PROBE, false, 'unreachable');
      return reply.code(502).send({ error: 'stop lines unavailable' });
    }
  });

  /**
   * POST /api/transit/widget — the home-screen widget's rows, rendered here.
   *
   * The widget used to format its own with `SimpleDateFormat`, a second
   * implementation of `tripSummary` in Kotlin that dropped the delay, the
   * cancellation, the platform and every situation notice the trip model
   * already carried. Now the rows arrive ready to paint — which also means the
   * times are Norwegian wall-clock times computed by `@atlas/transit` rather
   * than by a container whose own clock is UTC.
   *
   * Two board kinds, one response shape, because the widget renders them
   * identically:
   *  - `commute` — the saved two-way board, one `trip` call per direction asked.
   *  - `stop` — "when is my next 280", which is one line-filtered
   *    `estimatedCalls` call instead of two to six `trip` calls.
   */
  app.post('/api/transit/widget', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const nowMs = Date.now();
    const maxRows =
      typeof body.maxRows === 'number' && Number.isFinite(body.maxRows)
        ? Math.min(Math.max(Math.trunc(body.maxRows), 1), 6)
        : 3;

    if (body.kind === 'stop') {
      const point = parsePoint(body.stop);
      if (!point) return reply.code(400).send({ error: 'stop must be {lat, lng, stopId?}' });
      if (!transitCoversPoint(point)) {
        return reply.code(400).send({ error: 'departure boards are available within Norway only' });
      }
      const lines = Array.isArray(body.lines)
        ? body.lines.filter((line): line is string => isTransitLineId(line)).slice(0, 20)
        : [];
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 100) : '';
      try {
        const response = await fetchImpl(enturUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'ET-Client-Name': clientName,
          },
          body: JSON.stringify(
            buildEnturDeparturesRequest({
              ...point,
              limit: maxRows,
              // A board filtered to one line has to look past the next hour:
              // four 280s from Engelsrud span nearly three.
              ...(lines.length > 0 ? { lines, timeRangeSeconds: 6 * 3600 } : {}),
            }),
          ),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!response.ok) {
          request.log.error({ status: response.status }, 'entur widget stop error');
          status?.record(TRANSIT_PROBE, false, `HTTP ${response.status}`);
          return reply.code(502).send({ error: 'departure board unavailable' });
        }
        const departures = parseEnturDeparturesResponse(await response.json());
        status?.record(TRANSIT_PROBE, true);
        reply.header('cache-control', 'private, max-age=15');
        return stopWidgetBoard({ departures, label, nowMs, maxRows });
      } catch (err) {
        request.log.error({ err }, 'entur widget stop unreachable');
        status?.record(TRANSIT_PROBE, false, 'unreachable');
        return reply.code(502).send({ error: 'departure board unavailable' });
      }
    }

    const parsed = parseCommuteQuery(body.commute);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    // "auto" is the honest default for a widget: before the outbound time it
    // shows the way out, after it the way home — which is what a glance at 16:30
    // is for. A widget configured for one direction costs one upstream call.
    const requested = body.direction;
    const directions: TransitCommuteDirection[] =
      requested === 'outbound' || requested === 'inbound'
        ? [requested]
        : requested === 'both'
          ? ['outbound', 'inbound']
          : [defaultCommuteDirection(parsed.query, nowMs)];
    const queries = commuteTransitQueries({ ...parsed.query, limit: maxRows }, nowMs);

    try {
      const answers = await Promise.all(
        directions.map(async (key) => ({
          key,
          answer: await askDirection(queries[key], parsed.query.filter),
        })),
      );
      const failed = answers.find((entry) => !entry.answer.ok);
      if (failed && !failed.answer.ok) {
        request.log.error({ status: failed.answer.status }, 'entur widget commute error');
        status?.record(TRANSIT_PROBE, false, `HTTP ${failed.answer.status}`);
        return reply.code(502).send({ error: 'commute board unavailable' });
      }
      status?.record(TRANSIT_PROBE, true);
      reply.header('cache-control', 'private, max-age=15');
      return commuteWidgetBoard({
        query: parsed.query,
        results: answers.flatMap(({ key, answer }) =>
          answer.ok ? [{ key, result: answer.result, emptyReason: answer.emptyReason }] : [],
        ),
        nowMs,
        maxRows,
      });
    } catch (err) {
      request.log.error({ err }, 'entur widget commute unreachable');
      status?.record(TRANSIT_PROBE, false, 'unreachable');
      return reply.code(502).send({ error: 'commute board unavailable' });
    }
  });
}
