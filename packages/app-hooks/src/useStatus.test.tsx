// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import type { SystemStatus, UpstreamStatus } from '@atlas/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { groupUpstreams, statusAge, upstreamDetail, useStatus } from './useStatus.js';

const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);

const source = (over: Partial<UpstreamStatus> = {}): UpstreamStatus => ({
  id: 'valhalla',
  label: 'Valhalla',
  group: 'Routing',
  health: 'ok',
  lastSuccess: null,
  lastFailure: null,
  message: null,
  detail: null,
  ...over,
});

const status: SystemStatus = {
  app: 'atlas-backend',
  gitSha: 'dev',
  generatedAt: NOW,
  overall: 'degraded',
  sources: [
    source({ id: 'valhalla', group: 'Routing' }),
    source({
      id: 'photon',
      label: 'Photon',
      group: 'Search',
      health: 'down',
      message: 'ECONNREFUSED',
    }),
  ],
};

describe('statusAge', () => {
  it('coarsens with distance, from seconds to days', () => {
    expect(statusAge(NOW - 5_000, NOW)).toBe('5s ago');
    expect(statusAge(NOW - 3 * 60_000, NOW)).toBe('3m ago');
    expect(statusAge(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
    expect(statusAge(NOW - 4 * 86_400_000, NOW)).toBe('4d ago');
  });
});

describe('upstreamDetail', () => {
  it('says when a healthy source was last known good', () => {
    expect(upstreamDetail(source({ lastSuccess: NOW - 120_000 }), NOW)).toBe('checked 2m ago');
  });

  it('admits a source has never been exercised', () => {
    expect(upstreamDetail(source({ health: 'unknown' }), NOW)).toBe('awaiting first use');
  });

  it('leads with what went wrong, and when', () => {
    expect(
      upstreamDetail(
        source({ health: 'down', message: 'ECONNREFUSED', lastFailure: NOW - 60_000 }),
        NOW,
      ),
    ).toBe('ECONNREFUSED · 1m ago');
  });
});

describe('groupUpstreams', () => {
  it('buckets sources by group, in first-seen order', () => {
    expect(groupUpstreams(status.sources).map(([name, list]) => [name, list.length])).toEqual([
      ['Routing', 1],
      ['Search', 1],
    ]);
  });
});

describe('useStatus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches from the given origin once enabled', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(status) });
    });
    const { result, rerender } = renderHook(({ on }) => useStatus('https://atlas.example', on), {
      initialProps: { on: false },
    });
    expect(asked).toEqual([]);
    rerender({ on: true });
    await waitFor(() => expect(result.current.data).toEqual(status));
    expect(asked).toEqual(['https://atlas.example/api/status']);
    expect(result.current.error).toBeNull();
  });

  it('reports an unreachable server instead of throwing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('Network request failed')));
    const { result } = renderHook(() => useStatus('', true));
    await waitFor(() => expect(result.current.error).toBe('Network request failed'));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('turns a non-2xx answer into an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 503 }));
    const { result } = renderHook(() => useStatus('', true));
    await waitFor(() => expect(result.current.error).toBe('HTTP 503'));
  });
});
