import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { StatusRegistry } from './status.js';
import { registerTerrainApi } from './terrain-api.js';

function setup(fetchImpl: typeof fetch) {
  const app = Fastify();
  const status = new StatusRegistry();
  registerTerrainApi(app, status, {
    fetchImpl,
    upstreamTemplate: 'https://terrain.example/{z}/{x}/{y}.webp',
  });
  return { app, status };
}

describe('terrain tile proxy', () => {
  it('streams image bytes, cache policy and records a healthy source', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=604800' },
      }),
    );
    const { app, status } = setup(fetchImpl);
    const response = await app.inject({ url: '/api/terrain/6/33/18.webp' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['cache-control']).toBe('public, max-age=604800');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://terrain.example/6/33/18.webp',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(status.healthOf('terrain')).toBe('ok');
    await app.close();
  });

  it('rejects invalid coordinates without touching the upstream', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl);
    for (const url of [
      '/api/terrain/-1/0/0.webp',
      '/api/terrain/18/0/0.webp',
      '/api/terrain/4/16/0.webp',
      '/api/terrain/4/0/nope.webp',
    ]) {
      expect((await app.inject({ url })).statusCode, url).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects non-image and failed upstream responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response('html', { headers: { 'content-type': 'text/html' } }));
    const { app, status } = setup(fetchImpl);

    expect((await app.inject({ url: '/api/terrain/0/0/0.webp' })).statusCode).toBe(502);
    expect((await app.inject({ url: '/api/terrain/1/0/0.webp' })).statusCode).toBe(502);
    expect(status.healthOf('terrain')).toBe('down');
    await app.close();
  });
});
