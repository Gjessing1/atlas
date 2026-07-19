import type { UpstreamHealth, UpstreamStatus } from '@atlas/core';

/**
 * In-process health registry. Every proxy records the outcome of the real
 * requests it already makes (`record(id, ok, message?)`); the status endpoint
 * reads a snapshot. This "piggyback on real traffic" model means a source stays
 * `unknown` until something actually exercises it — no active polling, no
 * synthetic load against rate-limited upstreams (met.no especially).
 *
 * State is per-process and resets on restart, which is exactly right: it
 * describes "has this instance been able to reach X since it booted".
 */

interface Probe {
  id: string;
  label: string;
  group: string;
  /** Stable display order within the snapshot. */
  order: number;
  lastSuccess: number | null;
  lastFailure: number | null;
  /** null until the first probe; the most recent outcome drives health. */
  lastOk: boolean | null;
  message: string | null;
  detail: string | null;
}

function health(p: Probe): UpstreamHealth {
  if (p.lastOk === null) return 'unknown';
  if (p.lastOk) return 'ok';
  // A failing source that has succeeded before is degraded (typically serving a
  // cached/stale copy); one that has never worked this run is down.
  return p.lastSuccess === null ? 'down' : 'degraded';
}

/** unknown sources don't drag the rollup down — only real failures do. */
function worst(healths: UpstreamHealth[]): UpstreamHealth {
  if (healths.includes('down')) return 'down';
  if (healths.includes('degraded')) return 'degraded';
  if (healths.includes('ok')) return 'ok';
  return 'unknown';
}

export class StatusRegistry {
  private probes = new Map<string, Probe>();
  private nextOrder = 0;

  /**
   * Declare a source so it shows as `unknown` before any traffic hits it.
   * Idempotent — re-registering keeps recorded outcomes but refreshes labels.
   */
  register(id: string, label: string, group: string): void {
    const existing = this.probes.get(id);
    if (existing) {
      existing.label = label;
      existing.group = group;
      return;
    }
    this.probes.set(id, {
      id,
      label,
      group,
      order: this.nextOrder++,
      lastSuccess: null,
      lastFailure: null,
      lastOk: null,
      message: null,
      detail: null,
    });
  }

  /** Record one real request's outcome. Auto-registers an unseen id. */
  record(id: string, ok: boolean, message?: string): void {
    let p = this.probes.get(id);
    if (!p) {
      this.register(id, id, 'Other');
      p = this.probes.get(id)!;
    }
    const now = Date.now();
    p.lastOk = ok;
    if (ok) {
      p.lastSuccess = now;
      p.message = null;
    } else {
      p.lastFailure = now;
      if (message) p.message = message.slice(0, 200);
    }
  }

  /** Attach non-probe context (freshness, cache age) to a source's detail line. */
  setDetail(id: string, detail: string | null): void {
    const p = this.probes.get(id);
    if (p) p.detail = detail;
  }

  toStatus(): UpstreamStatus[] {
    return [...this.probes.values()]
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        id: p.id,
        label: p.label,
        group: p.group,
        health: health(p),
        lastSuccess: p.lastSuccess,
        lastFailure: p.lastFailure,
        message: p.message,
        detail: p.detail,
      }));
  }

  overall(): UpstreamHealth {
    return worst([...this.probes.values()].map(health));
  }
}
