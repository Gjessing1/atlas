import { buildEnturRequest, parseEnturResponse, transitCoverage } from '@atlas/transit';
import type { TransitQuery } from '@atlas/transit';
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
const TRANSIT_PROBE = 'entur';
/** Entur asks consumers to identify themselves; this is that identity. */
const CLIENT_NAME = 'atlas-journeyplanner';
const UPSTREAM_TIMEOUT_MS = 10_000;

export interface TransitApiOptions {
  /** Entur Journey Planner GraphQL endpoint (ENTUR_URL to override). */
  enturUrl?: string;
  /** Value for the mandatory ET-Client-Name header (ENTUR_CLIENT_NAME to override). */
  clientName?: string;
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Health registry: Entur is one probed source. */
  status?: StatusRegistry;
}

/** Narrow an untrusted body to a TransitQuery, or explain what's wrong with it. */
function parseQuery(body: unknown): { query: TransitQuery } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'expected a JSON object' };
  const raw = body as Record<string, unknown>;
  const point = (value: unknown): { lat: number; lng: number } | null => {
    if (!value || typeof value !== 'object') return null;
    const { lat, lng } = value as { lat?: unknown; lng?: unknown };
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  };
  const from = point(raw.from);
  const to = point(raw.to);
  if (!from || !to) return { error: 'from and to must be {lat, lng} coordinates' };
  if (!transitCoverage(from, to)) {
    // The defined non-Norway behaviour: say so plainly instead of forwarding a
    // query the national planner cannot answer.
    return { error: 'public transport is available for journeys within Norway only' };
  }
  const query: TransitQuery = { from, to };
  if (typeof raw.dateTimeMs === 'number' && Number.isFinite(raw.dateTimeMs)) {
    query.dateTimeMs = raw.dateTimeMs;
  }
  if (raw.arriveBy === true) query.arriveBy = true;
  if (typeof raw.limit === 'number' && Number.isFinite(raw.limit)) query.limit = raw.limit;
  if (typeof raw.walkSpeedMps === 'number' && raw.walkSpeedMps > 0 && raw.walkSpeedMps <= 5) {
    query.walkSpeedMps = raw.walkSpeedMps;
  }
  return { query };
}

export function registerTransitApi(app: FastifyInstance, opts: TransitApiOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const status = opts.status;
  status?.register(TRANSIT_PROBE, 'Entur (public transport)', 'Public transport');
  const enturUrl = opts.enturUrl ?? process.env.ENTUR_URL ?? ENTUR_URL;
  const clientName = opts.clientName ?? process.env.ENTUR_CLIENT_NAME ?? CLIENT_NAME;

  app.post('/api/transit', async (request, reply) => {
    const parsed = parseQuery(request.body);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

    try {
      const res = await fetchImpl(enturUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'ET-Client-Name': clientName,
        },
        body: JSON.stringify(buildEnturRequest(parsed.query)),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        request.log.error({ status: res.status }, 'entur error');
        status?.record(TRANSIT_PROBE, false, `HTTP ${res.status}`);
        return reply.code(502).send({ error: 'journey planner unavailable' });
      }
      const result = parseEnturResponse(await res.json());
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
}
