import type { OverpassPoiElement, PoiTilePair } from '@atlas/core';
import { describe, expect, it, vi } from 'vitest';
import { PoiSource, PoiUpstreamBusyError } from './poi-source.js';

const tile = (x: number, z = 14) => ({ z, x, y: 4766 });
const pair = (x: number, category: PoiTilePair['category'] = 'food'): PoiTilePair => ({
  tile: tile(x),
  category,
});

function blocksIn(init?: RequestInit): number {
  const query = new URLSearchParams(String(init?.body)).get('data') ?? '';
  return query.match(/block="\d+"/g)?.length ?? 0;
}

/** An Overpass that answers every block, `elements(block)` first, then its marker. */
function answer(init: RequestInit | undefined, elements: (block: number) => OverpassPoiElement[]) {
  const out: OverpassPoiElement[] = [];
  for (let block = 0; block < blocksIn(init); block++) {
    out.push(...elements(block), {
      type: 'atlasblock',
      id: block + 1,
      tags: { block: String(block) },
    });
  }
  return new Response(JSON.stringify({ elements: out }), { status: 200 });
}

const empty = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
  answer(init, () => []),
);

function source(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof PoiSource>[0]> = {},
) {
  return new PoiSource({
    endpoints: ['https://a.test/api/interpreter'],
    fetchImpl,
    minGapMs: 0,
    ...extra,
  });
}

describe('PoiSource', () => {
  it('answers a repeated view from its cache until the entry expires', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(empty);
    const pois = source(fetchImpl, { now: () => now, cacheTtlMs: 60_000 });
    await pois.get([pair(1), pair(2)]);
    await pois.get([pair(2), pair(1)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 61_000;
    await pois.get([pair(1)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never runs two upstream queries at once, and joins a pair already on its way', async () => {
    let inFlight = 0;
    let most = 0;
    const blocks: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      inFlight++;
      most = Math.max(most, inFlight);
      blocks.push(blocksIn(init));
      await gate;
      inFlight--;
      return answer(init, () => []);
    });
    const pois = source(fetchImpl);
    const first = pois.get([pair(1), pair(2)]);
    const second = pois.get([pair(2), pair(3)]);
    release();
    await Promise.all([first, second]);
    expect(most).toBe(1);
    // Pair 2 was already in the first query; the second asks only for pair 3.
    expect(blocks).toEqual([2, 1]);
  });

  it('never sends a queued pair whose caller has gone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await gate;
      return answer(init, () => []);
    });
    const pois = source(fetchImpl);
    const first = pois.get([pair(1)]);
    const controller = new AbortController();
    const abandoned = pois.get([pair(9)], controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rests an endpoint that answers 429 and moves the batch to the next one', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('a.test')
        ? new Response('busy', { status: 429 })
        : answer(init, () => []),
    );
    const onError = vi.fn();
    const pois = source(fetchImpl, {
      endpoints: ['https://a.test/api/interpreter', 'https://b.test/api/interpreter'],
      onError,
    });
    await pois.get([pair(1)]);
    await pois.get([pair(2)]);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual([
      'a.test',
      'b.test',
      'b.test',
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('fails fast, without asking again, while every endpoint is resting', async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => new Response('busy', { status: 429 }));
    const pois = source(fetchImpl, { now: () => now, baseBackoffMs: 5_000 });
    await expect(pois.get([pair(1)])).rejects.toThrow(/429/);
    // A 429 rests at least the 30 s its operator asks for, whatever the base.
    now += 20_000;
    const busy = await pois.get([pair(1)]).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(PoiUpstreamBusyError);
    expect((busy as PoiUpstreamBusyError).retryAfterS).toBe(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a refused connection as a ban and rests that endpoint the longest', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    });
    const pois = source(fetchImpl, { maxBackoffMs: 30 * 60_000 });
    await expect(pois.get([pair(1)])).rejects.toThrow(/fetch failed/);
    const busy = await pois.get([pair(1)]).catch((error: unknown) => error);
    expect((busy as PoiUpstreamBusyError).retryAfterS).toBeGreaterThan(29 * 60);
  });

  it('answers a child tile from a complete parent without asking upstream', async () => {
    const parent = { z: 13, x: 4340, y: 2383 };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      answer(init, () => [
        { type: 'node', id: 1, lat: 59.905, lon: 10.745, tags: { amenity: 'pharmacy' } },
      ]),
    );
    const pois = source(fetchImpl);
    await pois.get([{ tile: parent, category: 'health' }]);
    const children = await pois.get([
      { tile: { z: 14, x: 8681, y: 4766 }, category: 'health' },
      { tile: { z: 14, x: 8680, y: 4766 }, category: 'health' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(children.map((child) => child.results.length)).toEqual([1, 0]);
  });
});
