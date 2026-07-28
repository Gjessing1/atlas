// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePlaceFacts } from './usePlaceFacts.js';

const OSLO = { lat: 59.9139, lng: 10.7522 };
/** Same point nudged by ~1 cm — inside the proxy's own cache grid. */
const OSLO_NUDGED = { lat: 59.913_900_4, lng: 10.752_200_2 };
const ATLANTIC = { lat: 45, lng: -30 };

let fetchMock: ReturnType<typeof vi.fn>;

const answer = (elevationM: number | null) =>
  vi.fn(async () => new Response(JSON.stringify({ elevationM })));

beforeEach(() => {
  fetchMock = answer(94);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usePlaceFacts', () => {
  it('asks the configured server, so Android and web share one lookup', async () => {
    const { result } = renderHook(() => usePlaceFacts('https://atlas.example', OSLO));
    await waitFor(() => expect(result.current.elevation.status).toBe('ready'));
    expect(result.current.elevation.elevationM).toBe(94);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://atlas.example/api/elevation?lat=59.9139&lon=10.7522',
    );
  });

  it('keeps "no data here" apart from "the lookup broke"', async () => {
    // Outside the Norwegian model: the upstream answers with a null height.
    vi.stubGlobal('fetch', answer(null));
    const { result } = renderHook(() => usePlaceFacts('', ATLANTIC));
    await waitFor(() => expect(result.current.elevation.status).toBe('ready'));
    expect(result.current.elevation.elevationM).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const failed = renderHook(() => usePlaceFacts('', OSLO));
    await waitFor(() => expect(failed.result.current.elevation.status).toBe('error'));
    expect(failed.result.current.elevation.elevationM).toBeNull();
  });

  it('does not re-fetch for a marker dragged by centimetres', async () => {
    const { result, rerender } = renderHook(({ at }) => usePlaceFacts('', at), {
      initialProps: { at: OSLO },
    });
    await waitFor(() => expect(result.current.elevation.status).toBe('ready'));
    rerender({ at: OSLO_NUDGED });
    await waitFor(() => expect(result.current.elevation.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('has both facts idle and empty with no card open', () => {
    const { result } = renderHook(() => usePlaceFacts('', null));
    expect(result.current.elevation).toEqual({ status: 'idle', elevationM: null });
    expect(result.current.light).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('describes the light without waiting for, or needing, the network', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const { result } = renderHook(() => usePlaceFacts('', OSLO));
    expect(result.current.elevation.status).toBe('loading');
    expect(result.current.light).not.toBe('');
  });
});
