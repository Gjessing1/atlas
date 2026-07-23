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
  message: string | null;
  detail: string | null;
}

/**
 * A failure this close behind a success is one request out of a concurrent
 * batch, not a state change. A map pans and fires twenty tile requests at once;
 * if one of them times out and happens to resolve last, "most recent outcome
 * wins" declares the whole upstream broken while nineteen tiles are drawing on
 * screen. Judging by timestamps with this grace keeps a lone straggler from
 * outranking the successes it raced.
 */
const BATCH_GRACE_MS = 20_000;

/**
 * How long a failure keeps describing "now". Probes piggyback on real traffic,
 * so a source nothing has touched since it blipped would otherwise stay red
 * forever — the tile proxy in particular serves later views from its disk cache
 * and never re-probes upstream. After this, an unretried failure reverts to
 * `unknown` ("not checked recently"), which is what we actually know.
 */
const FAILURE_TTL_MS = 30 * 60_000;

function health(p: Probe, now: number): UpstreamHealth {
  if (p.lastSuccess === null && p.lastFailure === null) return 'unknown';
  if (p.lastFailure === null) return 'ok';
  if (p.lastSuccess !== null && p.lastSuccess >= p.lastFailure - BATCH_GRACE_MS) return 'ok';
  if (now - p.lastFailure > FAILURE_TTL_MS) return 'unknown';
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
   * `clock` is a seam: health now depends on *when* outcomes happened relative
   * to each other, and tests have to be able to move time rather than sleep
   * through a 30-minute TTL.
   */
  constructor(private readonly clock: () => number = Date.now) {}

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
    const now = this.clock();
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
    const now = this.clock();
    return [...this.probes.values()]
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        id: p.id,
        label: p.label,
        group: p.group,
        health: health(p, now),
        lastSuccess: p.lastSuccess,
        lastFailure: p.lastFailure,
        message: p.message,
        detail: p.detail,
      }));
  }

  overall(): UpstreamHealth {
    const now = this.clock();
    return worst([...this.probes.values()].map((p) => health(p, now)));
  }
}
