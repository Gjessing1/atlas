import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PoiPairDb } from './poi-cache.js';
import { PoiSource } from './poi-source.js';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-poi-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;
const pharmacy = {
  id: 'node/1',
  name: 'Apotek 1',
  position: { lat: 59.905, lng: 10.745 },
  categoryId: 'health' as const,
  category: 'Pharmacies',
  marker: '+',
};

describe('PoiPairDb', () => {
  it('keeps answers across a restart, until they expire', () => {
    const first = PoiPairDb.open(dataDir, 'r1', 0)!;
    first.set('14/1/1|health', { results: [pharmacy], complete: true, expires: 30 * DAY });
    first.close();
    const second = PoiPairDb.open(dataDir, 'r1', DAY)!;
    expect(second.get('14/1/1|health', DAY)).toEqual({
      results: [pharmacy],
      complete: true,
      expires: 30 * DAY,
    });
    expect(second.get('14/1/1|health', 31 * DAY)).toBeUndefined();
    second.close();
  });

  it('forgets every answer once the categories they were queried with change', () => {
    const first = PoiPairDb.open(dataDir, 'r1', 0)!;
    first.set('14/1/1|health', { results: [pharmacy], complete: true, expires: 30 * DAY });
    first.close();
    const second = PoiPairDb.open(dataDir, 'r2', 0)!;
    expect(second.get('14/1/1|health', 0)).toBeUndefined();
    second.close();
  });

  it('lets a restarted source answer from disk without asking upstream', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const query = new URLSearchParams(String(init?.body)).get('data') ?? '';
      const blocks = query.match(/block="\d+"/g)?.length ?? 0;
      const elements = Array.from({ length: blocks }, (_, block) => ({
        type: 'atlasblock',
        id: block + 1,
        tags: { block: String(block) },
      }));
      return new Response(JSON.stringify({ elements }), { status: 200 });
    });
    const pair = { tile: { z: 14, x: 8681, y: 4766 }, category: 'health' as const };
    const before = PoiPairDb.open(dataDir)!;
    await new PoiSource({
      endpoints: ['https://a.test'],
      fetchImpl,
      store: before,
      minGapMs: 0,
    }).get([pair]);
    before.close();
    const after = PoiPairDb.open(dataDir)!;
    await new PoiSource({
      endpoints: ['https://a.test'],
      fetchImpl,
      store: after,
      minGapMs: 0,
    }).get([pair]);
    after.close();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
