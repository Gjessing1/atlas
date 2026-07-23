import type { BBox, RegionPackJob } from '@atlas/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

const JOB_IDS_SETTING = 'local.regions.job-ids';
const POLL_MS = 2_000;

export interface RegionJobSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface RegionPackJobsController {
  jobs: RegionPackJob[];
  error: string | null;
  create: (name: string, bbox: BBox) => Promise<string | null>;
  refresh: () => void;
}

/** Persistent client for the server's restart-safe custom-region queue. */
export function useRegionPackJobs(
  settings: RegionJobSettings,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): RegionPackJobsController {
  const [ids, setIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Record<string, RegionPackJob>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const { status, getSetting, setSetting } = settings;

  const storeIds = useCallback(
    (next: string[]) => {
      setIds(next);
      setSetting(JOB_IDS_SETTING, JSON.stringify(next));
    },
    [setSetting],
  );

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(JOB_IDS_SETTING).then((raw) => {
      if (cancelled || !raw) return;
      try {
        const value = JSON.parse(raw) as unknown;
        if (Array.isArray(value)) {
          setIds(value.filter((id): id is string => typeof id === 'string'));
        }
      } catch {
        // Corrupt local job history: start empty.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const active = ids.some((id) => {
    const state = jobs[id]?.status;
    return (
      state === undefined || state === 'queued' || state === 'extracting' || state === 'assembling'
    );
  });

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    const update = async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const response = await fetchImpl(
              `${baseUrl}/api/region-jobs/${encodeURIComponent(id)}`,
            );
            if (response.status === 404) return { id, expired: true as const };
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return { id, job: (await response.json()) as RegionPackJob };
          } catch {
            return { id, failed: true as const };
          }
        }),
      );
      if (cancelled) return;
      const expired = new Set(
        results.filter((result) => 'expired' in result).map((result) => result.id),
      );
      if (expired.size > 0) storeIds(ids.filter((id) => !expired.has(id)));
      setJobs((current) => {
        const next = { ...current };
        for (const result of results) {
          if ('job' in result && result.job) next[result.id] = result.job;
          if ('expired' in result) delete next[result.id];
        }
        return next;
      });
      setError(
        results.some((result) => 'failed' in result) ? 'Could not refresh region jobs.' : null,
      );
    };
    void update();
    const timer = active ? setInterval(() => void update(), POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [ids, active, baseUrl, fetchImpl, refreshToken, storeIds]);

  const create = useCallback(
    async (name: string, bbox: BBox): Promise<string | null> => {
      setError(null);
      try {
        const response = await fetchImpl(`${baseUrl}/api/region-jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, bbox }),
        });
        const body = (await response.json().catch(() => ({}))) as Partial<RegionPackJob> & {
          error?: string;
        };
        if (!response.ok || typeof body.id !== 'string') {
          setError(body.error ?? `Could not create region (${response.status}).`);
          return body.error ?? `Could not create region (${response.status}).`;
        }
        const job = body as RegionPackJob;
        setJobs((current) => ({ ...current, [job.id]: job }));
        storeIds([...new Set([...ids, job.id])]);
        return null;
      } catch {
        const message = 'Server unreachable — the region was not queued.';
        setError(message);
        return message;
      }
    },
    [baseUrl, fetchImpl, ids, storeIds],
  );

  const ordered = useMemo(
    () => ids.map((id) => jobs[id]).filter((job): job is RegionPackJob => job !== undefined),
    [ids, jobs],
  );
  return {
    jobs: ordered,
    error,
    create,
    refresh: () => setRefreshToken((value) => value + 1),
  };
}
