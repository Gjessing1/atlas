// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRegionPackJobs, type RegionJobSettings } from './useRegionPackJobs.js';

describe('useRegionPackJobs', () => {
  it('queues a region, persists its id and polls it to completion', async () => {
    const settings: RegionJobSettings = {
      status: 'ready',
      getSetting: vi.fn(() => Promise.resolve(null)),
      setSetting: vi.fn(),
    };
    let status = 'queued';
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          Response.json({
            id: 'custom-1',
            name: 'Cabin',
            bbox: { sw: { lat: 60, lng: 10 }, ne: { lat: 60.2, lng: 10.2 } },
            status: 'queued',
            progress: 0,
            detail: 'Waiting',
            createdAt: 1,
            updatedAt: 1,
          }),
        );
      }
      status = 'done';
      return Promise.resolve(
        Response.json({
          id: 'custom-1',
          name: 'Cabin',
          bbox: { sw: { lat: 60, lng: 10 }, ne: { lat: 60.2, lng: 10.2 } },
          status,
          progress: 1,
          detail: 'Ready',
          createdAt: 1,
          updatedAt: 2,
        }),
      );
    }) as typeof fetch;
    const { result } = renderHook(() => useRegionPackJobs(settings, 'https://atlas', fetchImpl));
    await act(() =>
      result.current.create('Cabin', {
        sw: { lat: 60, lng: 10 },
        ne: { lat: 60.2, lng: 10.2 },
      }),
    );
    expect(settings.setSetting).toHaveBeenCalledWith('local.regions.job-ids', '["custom-1"]');
    await waitFor(() => expect(result.current.jobs[0]?.status).toBe('done'));
  });
});
