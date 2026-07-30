import {
  buildEnturDeparturesRequest,
  buildEnturRequest,
  commuteTransitQueries,
  filterCommuteResult,
  isTransitStopId,
  parseEnturDeparturesResponse,
  parseEnturResponse,
  parseEnturGeocoderResponse,
  transitCoverage,
  transitCoversPoint,
  RIDE_MODES,
  SEARCH_WINDOW_RETRY_MINUTES,
  WIDE_SEARCH_WINDOW_MINUTES,
} from '@atlas/transit';
import type {
  TransitCommutePlace,
  TransitCommuteQuery,
  TransitLocation,
  TransitMode,
  TransitQuery,
  TransitResult,
} from '@atlas/transit';
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
const TRANSIT_PROBE = 'entur';
/** Entur asks consumers to identify themselves; this is that identity. */
const CLIENT_NAME = 'atlas-journeyplanner';
const UPSTREAM_TIMEOUT_MS = 10_000;

export interface TransitApiOptions {
  /** Entur Journey Planner GraphQL endpoint (ENTUR_URL to override). */
  enturUrl?: string;
  /** Entur autocomplete endpoint (ENTUR_GEOCODER_URL to override). */
  geocoderUrl?: string;
  /** Value for the mandatory ET-Client-Name header (ENTUR_CLIENT_NAME to override). */
  clientName?: string;
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Health registry: Entur is one probed source. */
  status?: StatusRegistry;
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

function parseStringList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const values = value.map((item) => (typeof item === 'string' ? item.trim() : ''));
  return values.every((item) => item.length > 0 && item.length <= maxLength) ? values : null;
}

function parseCommuteQuery(body: unknown): { query: TransitCommuteQuery } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'expected a JSON object' };
  const raw = body as Record<string, unknown>;
  const from = parseCommutePlace(raw.from);
  const to = parseCommutePlace(raw.to);
  const via = Array.isArray(raw.via) ? raw.via.map(parseCommutePlace) : [];
  const allowedBusLines = parseStringList(raw.allowedBusLines, 10, 12);
  const excludedRailStops = parseStringList(raw.excludedRailStops, 20, 100);
  if (!from || !to || via.some((place) => place === null) || via.length > 8) {
    return { error: 'commute places must be named, valid coordinates' };
  }
  if (!allowedBusLines || allowedBusLines.length === 0 || !excludedRailStops) {
    return { error: 'commute filters must contain valid bus lines and train stop names' };
  }
  const allPlaces = [from, ...(via as TransitCommutePlace[]), to];
  if (allPlaces.some((place) => !transitCoversPoint(place))) {
    return { error: 'public transport is available for journeys within Norway only' };
  }
  return {
    query: {
      from,
      via: via as TransitCommutePlace[],
      to,
      allowedBusLines,
      excludedRailStops,
      ...(typeof raw.limit === 'number' && Number.isFinite(raw.limit)
        ? { limit: Math.min(Math.max(Math.trunc(raw.limit), 1), 10) }
        : {}),
    },
  };
}

export function registerTransitApi(app: FastifyInstance, opts: TransitApiOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const status = opts.status;
  status?.register(TRANSIT_PROBE, 'Entur (public transport)', 'Public transport');
  const enturUrl = opts.enturUrl ?? process.env.ENTUR_URL ?? ENTUR_URL;
  const geocoderUrl = opts.geocoderUrl ?? process.env.ENTUR_GEOCODER_URL ?? ENTUR_GEOCODER_URL;
  const clientName = opts.clientName ?? process.env.ENTUR_CLIENT_NAME ?? CLIENT_NAME;

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

  app.post('/api/transit/commute', async (request, reply) => {
    const parsed = parseCommuteQuery(request.body);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const queries = commuteTransitQueries(parsed.query);
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

    /**
     * One direction, filtered to the commute's own services.
     *
     * The wide-window retry is keyed on the *filtered* list, not the planner's
     * raw one — which is where this differs from `/api/transit`. A commute is a
     * question about two or three named lines, so Entur's default look-ahead
     * routinely comes back full of journeys the filter then throws away: asked
     * in the evening, Engelsrud → Nationaltheatret answers
     * `noTransitConnectionInSearchWindow` outright, and asked between the 280s
     * it answers with the services this commute excludes. Retrying only on an
     * empty *upstream* answer would leave both cases showing "no journey
     * matches your rules" while the next 280 is on tomorrow's timetable — the
     * one thing a board checked the night before must not say.
     */
    const direction = async (
      query: TransitQuery,
    ): Promise<{ ok: true; result: TransitResult } | { ok: false; status: number }> => {
      const first = await ask(query);
      if (!first.ok) return { ok: false, status: first.status };
      let filtered = filterCommuteResult(parseEnturResponse(await first.json()), parsed.query);
      for (const searchWindowMinutes of SEARCH_WINDOW_RETRY_MINUTES) {
        if (filtered.trips.length > 0) break;
        const wider = await ask({ ...query, searchWindowMinutes });
        if (!wider.ok) return { ok: false, status: wider.status };
        filtered = filterCommuteResult(parseEnturResponse(await wider.json()), parsed.query);
      }
      return { ok: true, result: filtered };
    };

    try {
      const [outbound, inbound] = await Promise.all([
        direction(queries.outbound),
        direction(queries.inbound),
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
      return { outbound: outbound.result, inbound: inbound.result };
    } catch (err) {
      request.log.error({ err }, 'entur commute unreachable');
      status?.record(TRANSIT_PROBE, false, 'unreachable');
      return reply.code(502).send({ error: 'commute board unavailable' });
    }
  });
}
