import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from './status.js';

const DEFAULT_TERRAIN_TILES = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
const TERRAIN_MAX_ZOOM = 17;

export interface TerrainApiOptions {
  fetchImpl?: typeof fetch;
  /** Test/deployment seam; must retain the z/x/y placeholders. */
  upstreamTemplate?: string;
}

/**
 * Same-origin proxy for Mapterhorn's Terrarium DEM.
 *
 * The upstream already publishes week-long immutable-looking cache headers,
 * so Atlas forwards those instead of writing a second multi-gigabyte tile
 * cache. Keeping the URL behind `/api` still gives clients one trust boundary,
 * one health record and one place to replace the distribution later.
 */
export function registerTerrainApi(
  app: FastifyInstance,
  status: StatusRegistry,
  opts: TerrainApiOptions = {},
): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const template = opts.upstreamTemplate ?? DEFAULT_TERRAIN_TILES;
  status.register('terrain', 'Mapterhorn terrain', 'Terrain');

  app.get<{ Params: { z: string; x: string; y: string } }>(
    '/api/terrain/:z/:x/:y.webp',
    async (request, reply) => {
      const z = Number(request.params.z);
      const x = Number(request.params.x);
      const y = Number(request.params.y);
      const valid =
        Number.isInteger(z) &&
        Number.isInteger(x) &&
        Number.isInteger(y) &&
        z >= 0 &&
        z <= TERRAIN_MAX_ZOOM &&
        x >= 0 &&
        y >= 0 &&
        x < 2 ** z &&
        y < 2 ** z;
      if (!valid) return reply.code(400).send({ error: 'invalid tile coordinates' });

      const upstream = template
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      try {
        const response = await fetchImpl(upstream, { signal: AbortSignal.timeout(15_000) });
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.ok || !contentType.startsWith('image/')) {
          status.record('terrain', false, `HTTP ${response.status}`);
          request.log.error(
            { status: response.status, contentType },
            'terrain upstream returned no image',
          );
          return reply.code(502).send({ error: 'terrain unavailable' });
        }
        status.record('terrain', true);
        return reply
          .header('content-type', contentType)
          .header('cache-control', response.headers.get('cache-control') ?? 'public, max-age=86400')
          .send(Buffer.from(await response.arrayBuffer()));
      } catch (err) {
        status.record('terrain', false, 'unreachable');
        request.log.error({ err }, 'terrain upstream unavailable');
        return reply.code(502).send({ error: 'terrain unavailable' });
      }
    },
  );
}
