import type { RegionPackManifest } from '@atlas/core';
import { describe, expect, it, vi } from 'vitest';

import { requestPotentialPack, viewBbox } from './potentialPack';

/**
 * The refusals are the interesting half here. "Let the map finish preparing
 * this area" is *advice* — the user can act on it by waiting a few seconds —
 * and replacing it with a generic failure would turn a solvable state into a
 * dead end.
 */

const manifest = {
  id: 'potential-abc',
  name: 'Elgvaldet',
  bbox: { sw: { lat: 60, lng: 10.6 }, ne: { lat: 60.03, lng: 10.65 } },
  version: 1,
  builtAt: 0,
  files: { layers: [] },
} satisfies RegionPackManifest;

const request = {
  name: 'Elgvaldet',
  bbox: manifest.bbox,
  surfaces: [{ layer: 'hunt', target: 'elg' }],
};

const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('viewBbox', () => {
  it('turns the map viewport into the corners the endpoint wants', () => {
    expect(viewBbox([10.6, 60, 10.65, 60.03])).toEqual({
      sw: { lat: 60, lng: 10.6 },
      ne: { lat: 60.03, lng: 10.65 },
    });
  });
});

describe('requestPotentialPack', () => {
  it('posts the framed area and returns the manifest', async () => {
    const fetchImpl = respond(manifest);
    const result = await requestPotentialPack('http://atlas.test', request, fetchImpl);
    expect(result.id).toBe('potential-abc');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://atlas.test/api/potential/packs');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(request);
  });

  it('passes the server’s own sentence through', async () => {
    await expect(
      requestPotentialPack(
        'http://atlas.test',
        request,
        respond({ error: 'this area has not been read yet', missing: 2 }, 409),
      ),
    ).rejects.toThrow('this area has not been read yet');
  });

  it('still says something useful when the server does not', async () => {
    await expect(
      requestPotentialPack('http://atlas.test', request, respond({}, 500)),
    ).rejects.toThrow(/\(500\)/);
  });

  it('reports an unreachable server rather than hanging on it', async () => {
    const dead = vi.fn(async () => {
      throw new Error('socket');
    }) as unknown as typeof fetch;
    await expect(requestPotentialPack('http://atlas.test', request, dead)).rejects.toThrow(
      /unreachable/,
    );
  });
});
