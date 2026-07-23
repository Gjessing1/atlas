/**
 * Server & upstream status, shared by both apps' Settings screens.
 *
 * `/api/status` reports what the backend has actually experienced using its
 * upstreams (routing, search, tiles, weather…), which is what answers the
 * question a user really has: "why is this overlay blank — is it me, the
 * server, or Kartverket?". Both apps ask the same question and must give the
 * same answer, so the fetching *and the wording* live here; only the markup
 * differs (a list on the web, sheet rows on Android).
 */

import type { SystemStatus, UpstreamHealth, UpstreamStatus } from '@atlas/core';
import { useCallback, useEffect, useState } from 'react';

export interface StatusState {
  data: SystemStatus | null;
  loading: boolean;
  /** Why the last check failed, or null. `data` may still hold an older answer. */
  error: string | null;
  refresh: () => void;
}

/** Plain-language name for each health level (the dot's meaning). */
export const UPSTREAM_HEALTH_LABEL: Record<UpstreamHealth, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Not checked yet',
};

/** "45s ago", "3m ago", "2h ago", "4d ago" — coarse on purpose. */
export function statusAge(ts: number, now: number = Date.now()): string {
  const secs = Math.round((now - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * The one line a source shows beside its name: healthy sources say when they
 * were last known good, failing ones lead with what went wrong and when —
 * "down" alone sends the user hunting through logs.
 */
export function upstreamDetail(s: UpstreamStatus, now: number = Date.now()): string {
  if (s.health === 'ok' || s.health === 'unknown') {
    if (s.detail) return s.detail;
    if (s.lastSuccess) return `checked ${statusAge(s.lastSuccess, now)}`;
    // Unknown with a failure behind it is a stale outcome the server stopped
    // standing behind — say so rather than "awaiting first use", which would
    // read as "never tried".
    if (s.lastFailure) {
      return `not checked since ${statusAge(s.lastFailure, now)}${s.message ? ` · ${s.message}` : ''}`;
    }
    return 'awaiting first use';
  }
  return `${s.message ?? 'failing'} · ${s.lastFailure ? statusAge(s.lastFailure, now) : ''}`.trim();
}

/** Sources bucketed by their `group` field, in first-seen order. */
export function groupUpstreams(sources: UpstreamStatus[]): [string, UpstreamStatus[]][] {
  const groups = new Map<string, UpstreamStatus[]>();
  for (const s of sources) {
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
  }
  return [...groups.entries()];
}

/**
 * Fetches GET /api/status on mount (once enabled) and on demand. Kept dead
 * simple — a Settings screen is the only caller and it is a manual, low-frequency
 * view. `origin` is '' where the app is served by the backend itself (web).
 */
export function useStatus(origin: string, enabled: boolean): StatusState {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${origin}/api/status`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as SystemStatus;
      })
      .then((json) => setData(json))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'unreachable'))
      .finally(() => setLoading(false));
  }, [origin]);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  return { data, loading, error, refresh };
}
