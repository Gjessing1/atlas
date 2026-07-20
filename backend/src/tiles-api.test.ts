import { readdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NodeFileSource,
  registerTilesApi,
  type LocalTileReader,
  type TilesApiOptions,
} from './tiles-api.js';

const LOCAL_TILE = Buffer.from('local-mvt-bytes');
const WORLD_TILE = Buffer.from('world-mvt-bytes');
const TILEJSON_URL = 'https://world.example/planet';
const TILE_TEMPLATE = 'https://world.example/planet/v1/{z}/{x}/{y}.pbf';

/** Local reader for one archive ("norway") covering only tiles with x >= 8. */
const localNorway: LocalTileReader = (area, _z, x) =>
  Promise.resolve(area === 'norway' && x >= 8 ? new Uint8Array(LOCAL_TILE) : null);

function fakeUpstream(overrides?: {
  tile?: (url: string) => Response;
  tilejson?: () => Response;
}): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url === TILEJSON_URL) {
      return Promise.resolve(overrides?.tilejson?.() ?? Response.json({ tiles: [TILE_TEMPLATE] }));
    }
    return Promise.resolve(
      overrides?.tile?.(url) ??
        new Response(WORLD_TILE, { headers: { 'content-type': 'application/x-protobuf' } }),
    );
  });
}

let app: FastifyInstance | null = null;

async function build(opts: Partial<TilesApiOptions>): Promise<FastifyInstance> {
  app = Fastify();
  registerTilesApi(app, {
    tilesDir: '/nonexistent',
    worldTilesUrl: TILEJSON_URL,
    localTiles: localNorway,
    ...opts,
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

const get = (url: string, gzip = true) =>
  (app as FastifyInstance).inject({
    url,
    headers: gzip ? { 'accept-encoding': 'gzip' } : {},
  });

describe('/api/tiles', () => {
  it('serves local tiles gzipped at high zoom', async () => {
    const fetchImpl = fakeUpstream();
    await build({ fetchImpl });
    const res = await get('/api/tiles/norway/12/2000/1000.pbf');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-protobuf');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(res.rawPayload)).toEqual(LOCAL_TILE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves plain bytes when the client does not accept gzip', async () => {
    await build({ fetchImpl: fakeUpstream() });
    const res = await get('/api/tiles/norway/12/2000/1000.pbf', false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.rawPayload).toEqual(LOCAL_TILE);
  });

  it('streams from upstream where the local archive has no tile', async () => {
    const fetchImpl = fakeUpstream();
    await build({ fetchImpl });
    const res = await get('/api/tiles/norway/12/1/1.pbf');
    expect(res.statusCode).toBe(200);
    expect(gunzipSync(res.rawPayload)).toEqual(WORLD_TILE);
    // TileJSON resolved once, then the templated tile URL fetched.
    expect(fetchImpl).toHaveBeenCalledWith(TILEJSON_URL, expect.anything());
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://world.example/planet/v1/12/1/1.pbf',
      expect.anything(),
    );
  });

  it('prefers upstream at low zoom even where local tiles exist', async () => {
    const fetchImpl = fakeUpstream();
    await build({ fetchImpl });
    const res = await get('/api/tiles/norway/4/8/4.pbf');
    expect(res.statusCode).toBe(200);
    expect(gunzipSync(res.rawPayload)).toEqual(WORLD_TILE);
  });

  it('falls back to local at low zoom when upstream fails', async () => {
    const fetchImpl = fakeUpstream({ tile: () => new Response(null, { status: 500 }) });
    await build({ fetchImpl });
    const res = await get('/api/tiles/norway/4/8/4.pbf');
    expect(res.statusCode).toBe(200);
    expect(gunzipSync(res.rawPayload)).toEqual(LOCAL_TILE);
  });

  it('caches upstream tiles (one fetch for repeated requests)', async () => {
    const fetchImpl = fakeUpstream();
    await build({ fetchImpl });
    await get('/api/tiles/norway/12/1/1.pbf');
    await get('/api/tiles/norway/12/1/1.pbf');
    const tileFetches = fetchImpl.mock.calls.filter(([u]) => String(u) !== TILEJSON_URL);
    expect(tileFetches).toHaveLength(1);
  });

  it('answers 204 where neither side has a tile', async () => {
    const fetchImpl = fakeUpstream({ tile: () => new Response(null, { status: 404 }) });
    await build({ fetchImpl });
    const res = await get('/api/tiles/elsewhere/12/1/1.pbf');
    expect(res.statusCode).toBe(204);
  });

  it('answers 502 when upstream fails and there is no local tile', async () => {
    const fetchImpl = fakeUpstream({ tile: () => new Response(null, { status: 500 }) });
    await build({ fetchImpl });
    const res = await get('/api/tiles/elsewhere/12/1/1.pbf');
    expect(res.statusCode).toBe(502);
  });

  it('resolves the TileJSON once and reuses the template', async () => {
    let tilejsonCalls = 0;
    const fetchImpl = fakeUpstream({
      tilejson: () => {
        tilejsonCalls += 1;
        return Response.json({ tiles: [TILE_TEMPLATE] });
      },
    });
    await build({ fetchImpl });
    expect((await get('/api/tiles/elsewhere/12/1/1.pbf')).statusCode).toBe(200);
    expect((await get('/api/tiles/elsewhere/12/1/2.pbf')).statusCode).toBe(200);
    expect(tilejsonCalls).toBe(1);
  });

  it('uses a {z}/{x}/{y} WORLD_TILES_URL directly without TileJSON resolution', async () => {
    const fetchImpl = fakeUpstream();
    await build({ fetchImpl, worldTilesUrl: TILE_TEMPLATE });
    const res = await get('/api/tiles/elsewhere/3/1/2.pbf');
    expect(res.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://world.example/planet/v1/3/1/2.pbf',
      expect.anything(),
    );
  });

  it('rejects invalid tile coordinates', async () => {
    await build({ fetchImpl: fakeUpstream() });
    expect((await get('/api/tiles/norway/12/-1/0.pbf')).statusCode).toBe(400);
    expect((await get('/api/tiles/norway/25/0/0.pbf')).statusCode).toBe(400);
    expect((await get('/api/tiles/norway/3/9/0.pbf')).statusCode).toBe(400); // x >= 2^z
    expect((await get('/api/tiles/no%2Fway/3/1/1.pbf')).statusCode).toBe(400);
  });
});

describe('NodeFileSource', () => {
  const openFdCount = (): number => readdirSync('/proc/self/fd').length;

  let file: string;
  const body = Buffer.from('0123456789abcdef');

  beforeEach(async () => {
    file = path.join(await mkdtemp(path.join(tmpdir(), 'atlas-tiles-')), 'archive.pmtiles');
    await writeFile(file, body);
  });

  it('returns the requested byte range, truncated at EOF', async () => {
    const source = new NodeFileSource(file, 'k');
    try {
      expect(Buffer.from(await source.getBytes(4, 6).then((r) => r.data)).toString()).toBe(
        '456789',
      );
      // A range running past the end yields only the bytes that exist.
      expect(Buffer.from(await source.getBytes(12, 99).then((r) => r.data)).toString()).toBe(
        'cdef',
      );
    } finally {
      await source.dispose();
    }
  });

  /**
   * The point of holding the handle: one tile request costs several range reads
   * (header, directory, tile), and each used to open and close the archive.
   */
  it('opens the archive once across many reads and closes it on dispose', async () => {
    const before = openFdCount();
    const source = new NodeFileSource(file, 'k');
    for (let i = 0; i < 20; i++) await source.getBytes(i % 8, 4);
    expect(openFdCount()).toBe(before + 1);

    await source.dispose();
    expect(openFdCount()).toBe(before);
  });

  it('lets an in-flight read finish when disposed mid-read, then closes', async () => {
    const before = openFdCount();
    const source = new NodeFileSource(file, 'k');
    await source.getBytes(0, 1); // force the open

    const pending = source.getBytes(4, 6);
    await source.dispose();
    expect(Buffer.from((await pending).data).toString()).toBe('456789');

    // The read, not dispose, released the handle — but it is released.
    expect(openFdCount()).toBe(before);
  });

  it('does not cache a failed open', async () => {
    const source = new NodeFileSource(path.join(path.dirname(file), 'missing.pmtiles'), 'k');
    await expect(source.getBytes(0, 4)).rejects.toThrow();
    // A second attempt must retry rather than reuse the rejected promise.
    await expect(source.getBytes(0, 4)).rejects.toThrow();
    await source.dispose();
  });
});
