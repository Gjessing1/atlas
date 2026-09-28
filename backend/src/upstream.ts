import type { FastifyReply } from 'fastify';

/**
 * The parts of a well-behaved upstream client that every proxy needs. They come
 * from the POI source (poi-source.ts), which learned them by getting this host
 * refused by overpass-api.de on 2026-09-19. Each proxy takes the parts that fit
 * its provider:
 *
 * - `LruMap`: a cache bounded by entry count. When it is full it evicts the
 *   least recently used entry instead of dropping everything.
 * - `SingleFlight`: identical requests in flight share one upstream call.
 * - `UpstreamGate`: at most N calls at once, a minimum gap between starts, and
 *   a rest after any failure. During the rest, callers fail fast with
 *   `UpstreamBusyError` instead of queueing more.
 * - `restAfterFailure`: how long that rest lasts. It doubles with each failure
 *   and is never shorter than the provider's `Retry-After`, or 30 s after a
 *   429. A refused connection gets the maximum at once, because that is how
 *   some operators enforce a ban.
 */

/** The upstream is resting after a failure; ask again in `retryAfterS`. */
export class UpstreamBusyError extends Error {
  constructor(
    readonly retryAfterS: number,
    message = 'upstream is backing off',
  ) {
    super(message);
  }
}

/** An upstream answer that was not a usable one; `retryAfterS` when it said when to come back. */
export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

/** `Retry-After` in seconds, given as delta-seconds or an HTTP-date; undefined when absent or past. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** A refused connection is how overpass-api.de enforces a ban. */
export function refused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } })?.cause;
  return (
    cause?.code === 'ECONNREFUSED' || !!cause?.errors?.some((item) => item.code === 'ECONNREFUSED')
  );
}

export interface RestPolicy {
  /** Rest after the first failure; each further failure in a row doubles it. */
  baseMs: number;
  maxMs: number;
}

/**
 * How long an upstream rests after its `failures`-th failure in a row. Every
 * failure counts: operators ban clients that keep collecting 429s, and a
 * malformed query repeated on every request is the same load.
 */
export function restAfterFailure(failures: number, error: unknown, policy: RestPolicy): number {
  if (refused(error)) return policy.maxMs;
  const doubling = policy.baseMs * 2 ** Math.max(0, failures - 1);
  const http = error instanceof UpstreamHttpError ? error : null;
  const asked = (http?.retryAfterS ?? 0) * 1000;
  const floor = http?.status === 429 ? 30_000 : 0;
  return Math.min(policy.maxMs, Math.max(doubling, asked, floor));
}

/** 503 with `Retry-After`: tells our own client when to come back instead of letting it retry. */
export function sendBusy(reply: FastifyReply, error: UpstreamBusyError, message: string) {
  reply.header('Retry-After', String(error.retryAfterS));
  return reply.code(503).send({ error: message });
}

/** A Map capped at `maxEntries` that evicts the least recently used entry. */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value); // most recently used last
    return value;
  }

  set(key: K, value: V): this {
    this.map.delete(key);
    this.map.set(key, value);
    for (const oldest of this.map.keys()) {
      if (this.map.size <= this.maxEntries) break;
      this.map.delete(oldest);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }
}

/** Identical calls in flight share one promise. */
export class SingleFlight<K, V> {
  private readonly inflight = new Map<K, Promise<V>>();

  run(key: K, task: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = task().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}

export interface UpstreamGateOptions {
  /** Upstream calls in flight at once. */
  maxConcurrent?: number;
  /** Least time between the starts of two calls. */
  minGapMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

/**
 * Admission control for one upstream. `run` waits for a free slot and for the
 * gap since the last start. When a call fails, the gate rests: every caller
 * still waiting, and every new one until the rest ends, gets
 * `UpstreamBusyError` instead of a call. A success resets the doubling.
 */
export class UpstreamGate {
  private readonly maxConcurrent: number;
  private readonly minGapMs: number;
  private readonly policy: RestPolicy;
  private readonly now: () => number;
  private active = 0;
  private nextStartAt = 0;
  private failures = 0;
  private restingUntil = 0;
  private readonly waiting: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: UpstreamGateOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 1;
    this.minGapMs = options.minGapMs ?? 0;
    this.policy = {
      baseMs: options.baseBackoffMs ?? 30_000,
      maxMs: options.maxBackoffMs ?? 30 * 60_000,
    };
    this.now = options.now ?? Date.now;
  }

  /** Seconds until the gate takes calls again; 0 while it is open. */
  retryAfterS(): number {
    const ms = this.restingUntil - this.now();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const value = await task();
      this.failures = 0;
      return value;
    } catch (error) {
      // Calls that were already in flight when the rest began failed for the
      // same reason. They can lengthen the rest, but they do not count as
      // further failures.
      if (this.retryAfterS() === 0) this.failures++;
      this.restingUntil = Math.max(
        this.restingUntil,
        this.now() + restAfterFailure(this.failures, error, this.policy),
      );
      throw error;
    } finally {
      this.active--;
      this.drain();
    }
  }

  private acquire(): Promise<void> {
    const resting = this.retryAfterS();
    if (resting) return Promise.reject(new UpstreamBusyError(resting));
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    if (this.timer) return;
    while (this.waiting.length && this.active < this.maxConcurrent) {
      const resting = this.retryAfterS();
      if (resting) {
        for (const waiter of this.waiting.splice(0)) waiter.reject(new UpstreamBusyError(resting));
        return;
      }
      const wait = this.nextStartAt - this.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.drain();
        }, wait);
        return;
      }
      this.active++;
      this.nextStartAt = this.now() + this.minGapMs;
      this.waiting.shift()!.resolve();
    }
    // A rest that began while callers queued behind a full gate reaches them
    // here, not after the rest has run out.
    const resting = this.retryAfterS();
    if (resting && this.waiting.length) {
      for (const waiter of this.waiting.splice(0)) waiter.reject(new UpstreamBusyError(resting));
    }
  }
}
