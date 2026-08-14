import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTerrainSlope, useTerrainSlope } from './useTerrainSlope.js';

afterEach(() => vi.unstubAllGlobals());

function slopingReply(): Response {
  // Elevation increases toward north, so the fitted downhill aspect is south.
  return Response.json({
    samples: [
      { elevationM: 112 },
      { elevationM: 108 },
      { elevationM: 100 },
      { elevationM: 92 },
      { elevationM: 88 },
      { elevationM: 92 },
      { elevationM: 100 },
      { elevationM: 108 },
    ],
  });
}

describe('point terrain slope', () => {
  it('posts the eight-point ring and fits its ground fall', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(slopingReply());
    const fit = await fetchTerrainSlope('', { lat: 59.86, lng: 10.42 }, { fetchImpl });
    expect(fit?.slopeDeg).toBeGreaterThan(5);
    expect(fit?.aspectDeg).toBe(180);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('/api/elevation/profile');
    expect(JSON.parse(String(init?.body)).points).toHaveLength(8);
  });

  it('fetches only while hunting terrain is enabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(slopingReply());
    vi.stubGlobal('fetch', fetchImpl);
    const { result, rerender } = renderHook(
      ({ enabled }) => useTerrainSlope('', { lat: 59.86, lng: 10.42 }, enabled),
      { initialProps: { enabled: false } },
    );
    expect(result.current.status).toBe('idle');
    expect(fetchImpl).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.fit?.aspectDeg).toBe(180);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
