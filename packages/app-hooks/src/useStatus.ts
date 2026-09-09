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
  /**
   * Re-probe every upstream now, rather than reading what the server already
   * knows. Costs real requests to other people's services, so it is an explicit
   * button and never something a screen does on open.
   */
  check: () => void;
  checking: boolean;
}

/** Plain-language name for each health level (the dot's meaning). */
export const UPSTREAM_HEALTH_LABEL: Record<UpstreamHealth, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Not checked yet',
};

/**
 * The headline above the source list — and the one line on this screen that
 * has to be read correctly by someone who is worried.
 *
 * It used to be `UPSTREAM_HEALTH_LABEL[overall]` on its own, so a single dead
 * national WMS put the word **“Down”** under a heading that said
 * *Server status*, and the honest reading of that is “Atlas is down”. It
 * never was: the page you are reading came *from* the backend, which is the
 * proof it is up. What `overall` actually rolls up is the health of the data
 * sources behind it — Kartverket, NVE, met.no, Entur and the self-hosted
 * routing/search containers — any one of which can die without Atlas noticing
 * anything except a blank overlay.
 *
 * So the sentence leads with the fact the reader came for (the backend
 * answered) and then counts what is wrong, rather than collapsing both into one
 * adjective that belongs to neither.
 */
export function overallSummary(data: SystemStatus): string {
  const total = data.sources.length;
  const count = (h: UpstreamHealth) => data.sources.filter((s) => s.health === h).length;
  const down = count('down');
  const degraded = count('degraded');
  const plural = (n: number) => (n === 1 ? 'source' : 'sources');
  if (down > 0 && degraded > 0) {
    return `Atlas is up · ${down} data ${plural(down)} down, ${degraded} degraded`;
  }
  if (down > 0) return `Atlas is up · ${down} data ${plural(down)} down`;
  if (degraded > 0) return `Atlas is up · ${degraded} data ${plural(degraded)} degraded`;
  // No failures, so the only distinction left is whether anything has been
  // asked yet — "all sources operational" would be a claim about services
  // nobody has spoken to since this backend started.
  if (count('ok') === 0) return 'Atlas is up · data sources not checked yet';
  return `Atlas is up · all ${total} data sources operational`;
}

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
 * The one line a source shows beside its name: healthy sources say what came
 * back and how long it took, failing ones lead with what went wrong and when —
 * "down" alone sends the user hunting through logs.
 */
export function upstreamDetail(s: UpstreamStatus, now: number = Date.now()): string {
  // A warning outranks everything: the source answered, so no timestamp or
  // message explains why it is amber — the sentence does. This is the row that
  // says "Statskog has published 2025 and you are serving 2024".
  if (s.warning) return s.warning;
  const latency = s.latencyMs == null ? null : `${s.latencyMs} ms`;
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  if (s.health === 'ok' || s.health === 'unknown') {
    if (s.detail) return join(s.detail, latency);
    if (s.lastSuccess) return join(`checked ${statusAge(s.lastSuccess, now)}`, latency);
    // Unknown with a failure behind it is a stale outcome the server stopped
    // standing behind — say so rather than "awaiting first use", which would
    // read as "never tried".
    if (s.lastFailure) {
      return join(`not checked since ${statusAge(s.lastFailure, now)}`, s.message);
    }
    return 'awaiting first use';
  }
  return join(s.message ?? 'failing', s.lastFailure ? statusAge(s.lastFailure, now) : null);
}

/**
 * The footer line under the source list: when the server last swept its
 * upstreams, and how many need attention. Both clients show the same sentence
 * because both users are asking the same thing — *is this page telling me
 * something current?*
 */
export function sweepSummary(data: SystemStatus, now: number = Date.now()): string {
  const attention = data.sources.filter(
    (s) => s.health === 'down' || s.health === 'degraded',
  ).length;
  const swept = data.probing
    ? 'Checking upstreams…'
    : // `== null` on purpose: during a release the app bundle and the backend can
      // be one version apart, so these fields may be absent rather than null.
      data.lastSweep == null
      ? `${data.sources.length} sources · upstreams not checked yet this run`
      : `${data.sources.length} sources · upstreams checked ${statusAge(data.lastSweep, now)}`;
  return attention === 0 ? swept : `${swept} · ${attention} need attention`;
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
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * `deep` decides which route is used: GET reads what the server already
   * knows (free), POST makes it go and ask every upstream. Both answer with the
   * same snapshot, so the caller's rendering is identical either way.
   */
  const load = useCallback(
    (deep: boolean) => {
      const busy = deep ? setChecking : setLoading;
      busy(true);
      setError(null);
      fetch(`${origin}/api/status${deep ? '/check' : ''}`, { method: deep ? 'POST' : 'GET' })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as SystemStatus;
        })
        .then((json) => setData(json))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'unreachable'))
        .finally(() => busy(false));
    },
    [origin],
  );

  const refresh = useCallback(() => load(false), [load]);
  const check = useCallback(() => load(true), [load]);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  return { data, loading, error, refresh, check, checking };
}
