// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { LngLatBbox } from '@atlas/core';
import type { PotentialCellState, PotentialPrepareResponse } from '@atlas/potential';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePotential, type PotentialView } from './usePotential.js';

/** Semsvannet and its neighbours — inside the Norwegian envelope, one z11 cell. */
const SEMSVANNET: LngLatBbox = [10.4, 59.84, 10.44, 59.87];
const ATLANTIC: LngLatBbox = [-30, 40, -29.9, 40.1];

const view = (bbox: LngLatBbox, zoom = 12.4): PotentialView => ({ bbox, zoom });

const cell = (over: Partial<PotentialCellState> = {}): PotentialCellState => ({
  cell: '11/1083/596',
  status: 'ready',
  ...over,
});

const prepared = (over: Partial<PotentialPrepareResponse> = {}): PotentialPrepareResponse => ({
  layer: 'lake-fishing',
  target: 'orret',
  cellZoom: 11,
  cells: [cell()],
  ready: 1,
  working: 0,
  outsideCoverage: false,
  ...over,
});

/** A manifest carrying only the fields the pill actually reads. */
const manifest = (over: Record<string, unknown> = {}) =>
  ({ etag: 'abc', coverage: 0.12, notes: [], ...over }) as PotentialCellState['manifest'];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock = vi.fn(async () => new Response(JSON.stringify(prepared())));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const selection = { layer: 'lake-fishing', target: 'orret' };

describe('usePotential', () => {
  it('says nothing at all when no derived layer is on', () => {
    const { result } = renderHook(() => usePotential('', null, view(SEMSVANNET)));
    expect(result.current.status).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the user to zoom in rather than queueing work the map cannot draw', async () => {
    const { result } = renderHook(() => usePotential('', selection, view(SEMSVANNET, 9)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.status).toBe('zoom-in');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('states the Norway-only limit without a round trip', async () => {
    const { result } = renderHook(() => usePotential('', selection, view(ATLANTIC)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.status).toBe('outside');
    expect(result.current.message).toMatch(/Norway/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts the areas it is building, in the surface’s own vocabulary', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          prepared({
            cells: [cell(), cell({ cell: '11/1084/596', status: 'running' })],
            ready: 1,
            working: 1,
          }),
        ),
      ),
    );
    const { result } = renderHook(() => usePotential('', selection, view(SEMSVANNET), 'hunt'));
    // Before the first answer it can only say it is working; the count arrives
    // with the server's reply.
    expect(result.current.message).toBe('Reading the ground…');
    await waitFor(() => expect(result.current.message).toBe('Reading the ground · 1 of 2 areas'));
    expect(result.current.status).toBe('preparing');
  });

  it('stops asking once the viewport is fully derived', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(prepared({ cells: [cell({ manifest: manifest() })] }))),
    );
    const { result } = renderHook(() => usePotential('', selection, view(SEMSVANNET)));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    // A ready surface needs no announcement.
    expect(result.current.message).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls while a cell is still building, then settles', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(prepared({ cells: [cell({ status: 'running' })], ready: 0, working: 1 })),
        ),
      )
      .mockResolvedValue(
        new Response(JSON.stringify(prepared({ cells: [cell({ manifest: manifest() })] }))),
      );
    const { result } = renderHook(() => usePotential('', selection, view(SEMSVANNET)));
    await waitFor(() => expect(result.current.status).toBe('preparing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * A repair is a cell already on screen being derived again because an upstream
   * it missed came back (ROADMAP N7). The surface stays up and the pill stays
   * quiet — but the hook has to keep asking, because the tiles keep their URLs
   * and the new ETags in `readyKey` are the only thing that moves the better
   * surface onto the map.
   */
  it('keeps polling through a silent repair, saying nothing about it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            prepared({ cells: [cell({ manifest: manifest(), repairing: true })], repairing: 1 }),
          ),
        ),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify(prepared({ cells: [cell({ manifest: manifest({ etag: 'def' }) })] })),
        ),
      );
    const { result } = renderHook(() => usePotential('', selection, view(SEMSVANNET)));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.message).toBeNull();
    const before = result.current.readyKey;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.readyKey).not.toBe(before));
    // …and once the repair has landed, it goes quiet again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a derived-but-blank area in the model’s own words', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          prepared({
            cells: [
              cell({ manifest: manifest({ coverage: 0, notes: ['No mapped lakes here.'] }) }),
            ],
          }),
        ),
      ),
    );
    const { result } = renderHook(() => usePotential('', selection, view(SEMSVANNET)));
    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(result.current.message).toBe('No mapped lakes here.');
  });

  it('changes its readyKey only when a derived cell actually changes', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(prepared({ cells: [cell({ manifest: manifest() })] }))),
    );
    const { result, rerender } = renderHook(
      ({ v }: { v: PotentialView }) => usePotential('', selection, v),
      { initialProps: { v: view(SEMSVANNET) } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const first = result.current.readyKey;
    // Id-safe by construction: it goes straight into a MapLibre source id.
    expect(first).toMatch(/^[a-z0-9]+$/);

    // A pan of a few metres stays inside the same cell: no request, same key.
    rerender({ v: view([10.401, 59.841, 10.441, 59.871]) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.readyKey).toBe(first);

    // A re-derive rewrites the same cell under a new etag — the raster has to
    // be told, or the map keeps showing tiles it already considers final.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(prepared({ cells: [cell({ manifest: manifest({ etag: 'zzz' }) })] })),
      ),
    );
    rerender({ v: view([10.6, 59.84, 10.64, 59.87]) });
    await waitFor(() => expect(result.current.readyKey).not.toBe(first));
  });

  it('can be paused without switching the layer off, and resumed', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(prepared({ cells: [cell({ status: 'running' })], ready: 0, working: 1 })),
      ),
    );
    const { result } = renderHook(() => usePotential('', selection, view(SEMSVANNET)));
    await waitFor(() => expect(result.current.status).toBe('preparing'));
    act(() => result.current.pause());
    expect(result.current.status).toBe('paused');

    const calls = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(calls);

    act(() => result.current.resume());
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
  });

  /**
   * Caught by driving the real map: a cell whose derive gave up left the pill
   * counting "1 of 2 areas" and re-asking every 2.5 s for as long as the map
   * stayed open.
   */
  it('stops polling a cell that failed, and says so', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          prepared({
            cells: [
              cell({ manifest: manifest() }),
              cell({ cell: '11/1084/596', status: 'failed' }),
            ],
            ready: 1,
            working: 0,
            failed: 1,
          }),
        ),
      ),
    );
    const { result } = renderHook(() => usePotential('', selection, view(SEMSVANNET)));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.message).toBe('1 of 2 areas could not be prepared');
    // The cell that did land is still drawn — a partial surface beats none.
    expect(result.current.readyKey).not.toBe('');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed prepare off the map instead of shouting about it', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
    const { result } = renderHook(() => usePotential('', selection, view(SEMSVANNET)));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.message).toBe('Could not prepare this area');
  });

  it('sends the layer, target and bbox the map is actually showing', async () => {
    renderHook(() => usePotential('https://atlas.example', selection, view(SEMSVANNET)));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://atlas.example/api/potential/prepare');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      layer: 'lake-fishing',
      target: 'orret',
      bbox: SEMSVANNET,
    });
  });
});
