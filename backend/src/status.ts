import type { UpstreamHealth, UpstreamStatus } from '@atlas/core';

/**
 * In-process health registry. Two things write to it:
 *
 * - **Real traffic** — every proxy records the outcome of the requests it
 *   already makes (`record(id, ok, message?)`). Free, and it reports exactly
 *   what users experienced.
 * - **Active probes** (`probes.ts`, ROADMAP N7) — one cheap request per
 *   upstream every few hours, because piggybacking alone cannot see a source
 *   nobody has opened, and the tile proxy serves later views from its disk
 *   cache without ever re-asking upstream. That blind spot is not theoretical:
 *   it hid a dead `wildlife-areas` layer (see probes.ts).
 *
 * The load stays deliberately tiny and met.no is left out of the sweep entirely
 * — its ToS asks for no synthetic polling, and the weather proxy's own traffic
 * reports it anyway.
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
  latencyMs: number | null;
  warning: string | null;
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
  if (p.lastFailure === null) return p.warning === null ? 'ok' : 'degraded';
  if (p.lastSuccess !== null && p.lastSuccess >= p.lastFailure - BATCH_GRACE_MS) {
    // Reachable — but a warning means the answer itself is not to be trusted
    // (stale year-named service, coverage gone to zero), which is degraded even
    // though every request succeeded.
    return p.warning === null ? 'ok' : 'degraded';
  }
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
      latencyMs: null,
      warning: null,
    });
  }

  /** Is this id known to the registry? */
  has(id: string): boolean {
    return this.probes.has(id);
  }

  /**
   * This source's health right now — the same verdict the status page renders,
   * asked one id at a time.
   *
   * The derive service reads it to decide whether an upstream it missed is worth
   * asking again (ROADMAP N7). An id nobody has registered or recorded answers
   * `unknown`, which is the honest answer and, for that caller, a "no".
   */
  healthOf(id: string): UpstreamHealth {
    const p = this.probes.get(id);
    return p ? health(p, this.clock()) : 'unknown';
  }

  /**
   * Record one request's outcome. Auto-registers an unseen id. `latencyMs` is
   * only passed by the active prober — proxy traffic doesn't time itself, and a
   * user-facing request's duration would mix queueing and cache reads into a
   * number read as "how far away is this upstream".
   */
  record(id: string, ok: boolean, message?: string, latencyMs?: number): void {
    let p = this.probes.get(id);
    if (!p) {
      this.register(id, id, 'Other');
      p = this.probes.get(id)!;
    }
    const now = this.clock();
    if (latencyMs !== undefined) p.latencyMs = Math.round(latencyMs);
    if (ok) {
      p.lastSuccess = now;
      p.message = null;
    } else {
      p.lastFailure = now;
      if (message) p.message = message.slice(0, 200);
    }
  }

  /**
   * Flag (or clear) the silent kind of failure: the upstream answers, but its
   * answer is wrong — zero features where there were thousands, a successor
   * year-service that has appeared, a routing container still serving off an
   * image the repo has moved past. Callers always pass the current verdict
   * rather than only the bad one, so a warning clears itself once the upstream
   * recovers; the corollary is that a row's warning has exactly one owner (the
   * active prober, or a local check like routing-revision.ts), because two
   * would spend their time clearing each other's findings.
   */
  warn(id: string, warning: string | null): void {
    const p = this.probes.get(id);
    if (p) p.warning = warning === null ? null : warning.slice(0, 200);
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
        latencyMs: p.latencyMs,
        warning: p.warning,
      }));
  }

  overall(): UpstreamHealth {
    const now = this.clock();
    return worst([...this.probes.values()].map((p) => health(p, now)));
  }
}
