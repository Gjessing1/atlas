import { renderHook, waitFor } from '@testing-library/react';
import type { SystemStatus, UpstreamStatus } from '@atlas/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  groupUpstreams,
  overallSummary,
  statusAge,
  sweepSummary,
  upstreamDetail,
  useStatus,
} from './useStatus.js';

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
  latencyMs: null,
  warning: null,
  ...over,
});

const status: SystemStatus = {
  app: 'atlas-backend',
  gitSha: 'dev',
  generatedAt: NOW,
  overall: 'degraded',
  lastSweep: null,
  probing: false,
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

  it('reports what came back and how long it took', () => {
    expect(upstreamDetail(source({ detail: '922 features', latencyMs: 151 }), NOW)).toBe(
      '922 features · 151 ms',
    );
  });

  /**
   * The silent failure has no timestamp and no error to explain it, so the
   * sentence has to win the row outright — otherwise the page says "Operational"
   * about data it knows is stale.
   */
  it('lets a warning outrank every other line', () => {
    const warned = source({
      health: 'degraded',
      detail: 'serving 2024',
      latencyMs: 38,
      warning: '2025 data has been published — this layer still serves 2024',
    });
    expect(upstreamDetail(warned, NOW)).toBe(
      '2025 data has been published — this layer still serves 2024',
    );
  });

  /**
   * A release publishes the backend and the app bundle separately, so a client
   * can briefly meet a server that predates these fields.
   */
  it('tolerates a server that sends no latency or warning at all', () => {
    const legacy = { ...source({ lastSuccess: NOW - 120_000 }) } as Record<string, unknown>;
    delete legacy['latencyMs'];
    delete legacy['warning'];
    expect(upstreamDetail(legacy as unknown as UpstreamStatus, NOW)).toBe('checked 2m ago');
  });
});

describe('sweepSummary', () => {
  it('distinguishes "all fine" from "nothing has been checked"', () => {
    const clean: SystemStatus = { ...status, overall: 'ok', sources: [source()] };
    expect(sweepSummary(clean, NOW)).toBe('1 sources · upstreams not checked yet this run');
    expect(sweepSummary({ ...clean, lastSweep: NOW - 720_000 }, NOW)).toBe(
      '1 sources · upstreams checked 12m ago',
    );
  });

  it('counts the sources that need attention', () => {
    expect(sweepSummary({ ...status, lastSweep: NOW - 60_000 }, NOW)).toBe(
      '2 sources · upstreams checked 1m ago · 1 need attention',
    );
  });

  it('says a sweep is running', () => {
    expect(sweepSummary({ ...status, probing: true }, NOW)).toContain('Checking upstreams…');
  });
});

describe('overallSummary', () => {
  /**
   * The regression this exists for: one dead national WMS rolled `overall` up
   * to 'down', the headline printed that single word under a heading that said
   * "Server status", and it was read as "Atlas is down" — by someone who was
   * looking at a page the backend had just served them.
   */
  it('never lets a failing data source read as a failing Atlas', () => {
    expect(overallSummary({ ...status, overall: 'down' })).toBe('Atlas is up · 1 data source down');
    expect(overallSummary({ ...status, overall: 'down' })).toContain('Atlas is up');
  });

  it('counts down and degraded sources separately, and pluralises both', () => {
    const sources = [
      source({ id: 'a', health: 'down' }),
      source({ id: 'b', health: 'down' }),
      source({ id: 'c', health: 'degraded' }),
      source({ id: 'd', health: 'ok' }),
    ];
    expect(overallSummary({ ...status, sources })).toBe(
      'Atlas is up · 2 data sources down, 1 degraded',
    );
    expect(overallSummary({ ...status, sources: sources.slice(2) })).toBe(
      'Atlas is up · 1 data source degraded',
    );
  });

  it('distinguishes "all healthy" from "nobody has asked yet"', () => {
    expect(overallSummary({ ...status, sources: [source(), source({ id: 'b' })] })).toBe(
      'Atlas is up · all 2 data sources operational',
    );
    expect(overallSummary({ ...status, sources: [source({ health: 'unknown' })] })).toBe(
      'Atlas is up · data sources not checked yet',
    );
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

  /**
   * Opening the page must stay free — reading costs nothing, and only the
   * explicit button is allowed to spend requests on someone else's servers.
   */
  it('reads on open and only POSTs the deep check when asked', async () => {
    const asked: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: { method?: string }) => {
      asked.push({ url, method: init?.method });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(status) });
    });
    const { result } = renderHook(() => useStatus('', true));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(asked).toEqual([{ url: '/api/status', method: 'GET' }]);

    result.current.check();
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toEqual({ url: '/api/status/check', method: 'POST' });
    await waitFor(() => expect(result.current.checking).toBe(false));
  });
});
