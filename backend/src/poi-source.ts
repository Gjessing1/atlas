import {
  overpassPoiTileQuery,
  overpassPoiTileResults,
  poiPairKey,
  poiTileBbox,
  poiTileKey,
  poiTileParent,
  type OverpassPoiElement,
  type PoiTilePair,
  type PoiTileResults,
} from '@atlas/core';
import type { PoiPairEntry, PoiPairStore } from './poi-cache.js';
import type { StatusRegistry } from './status.js';
import {
  restAfterFailure,
  retryAfterSeconds,
  UpstreamBusyError,
  UpstreamHttpError,
} from './upstream.js';

/**
 * Overpass for the POI layer, as a well-behaved client of a shared public
 * service.
 *
 * The first version sent one upstream query per settled pan. Its cache was keyed
 * on the exact bbox and never hit; the query kept running after the client
 * aborted it, and 429s did not slow it down. overpass-api.de allows two
 * concurrent queries per IP. A few seconds of panning put 5–8 in flight, and
 * after enough 429s the server refused this host's IPv4 address outright
 * (2026-09-19). So:
 *
 * - **One query at a time**, paced by at least `minGapMs` and by the last
 *   query's own duration (Overpass frees a slot about that long after a query
 *   ends).
 * - **Everything waiting is batched into that one query**, each (tile,
 *   category) pair its own block (see `overpassPoiTileQuery`).
 * - **Single flight:** a pair already queued or in flight is joined, never
 *   asked twice. A queued pair whose every waiter has gone is dropped before
 *   it is sent.
 * - **Cache by pair for `cacheTtlMs`** (a month: OSM places change slowly),
 *   shared by every client, in memory and in `store` so a deploy keeps it. A
 *   child tile is answered from a complete parent, so zooming in on a sparse
 *   category costs nothing upstream.
 * - **Back off an endpoint after any failure** (see `backoffMs`), and move
 *   the batch to the next endpoint. With every endpoint backing off, callers
 *   fail fast with `PoiUpstreamBusyError` instead of queueing more.
 */
export interface PoiSourceOptions {
  /** Overpass interpreter URLs, in order of preference. */
  endpoints: readonly string[];
  fetchImpl?: typeof fetch;
  userAgent?: string;
  status?: StatusRegistry;
  now?: () => number;
  /** How long one pair's answer is served; OSM places change slowly. */
  cacheTtlMs?: number;
  /** Bound on places held in memory across all pairs (an empty pair counts as one). */
  maxCachedResults?: number;
  /** Answers beyond the in-memory working set, surviving restarts. */
  store?: PoiPairStore | null;
  minGapMs?: number;
  maxGapMs?: number;
  /** Most pairs in one upstream query. */
  maxBatch?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  onError?: (error: unknown, endpoint: string) => void;
}

/** Every endpoint is backing off; retry after `retryAfterS`. */
export class PoiUpstreamBusyError extends UpstreamBusyError {
  constructor(retryAfterS: number) {
    super(retryAfterS, 'points of interest are busy upstream');
  }
}

interface Job {
  pair: PoiTilePair;
  key: string;
  waiters: number;
  sent: boolean;
  /** Endpoints already tried. */
  attempts: number;
  promise: Promise<PoiTileResults>;
  resolve: (answer: PoiTileResults) => void;
  reject: (error: unknown) => void;
}

interface Endpoint {
  url: string;
  failures: number;
  blockedUntil: number;
}

/** Widest a batch may reach, in tiles each way; a desktop view is ~6×3. */
const BATCH_SPAN = 8;

function abortError(): Error {
  return new DOMException('The POI request was aborted', 'AbortError');
}

export class PoiSource {
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxCachedResults: number;
  private readonly minGapMs: number;
  private readonly maxGapMs: number;
  private readonly maxBatch: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly endpoints: Endpoint[];
  private readonly cache = new Map<string, PoiPairEntry>();
  private cachedResults = 0;
  private readonly jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = false;
  private nextAt = 0;

  constructor(private readonly options: PoiSourceOptions) {
    if (!options.endpoints.length) throw new Error('PoiSource needs at least one endpoint');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'Atlas/1.0 (self-hosted mapping app)';
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? 30 * 24 * 60 * 60_000;
    this.maxCachedResults = options.maxCachedResults ?? 100_000;
    this.minGapMs = options.minGapMs ?? 1_000;
    this.maxGapMs = options.maxGapMs ?? 30_000;
    this.maxBatch = options.maxBatch ?? 256;
    this.baseBackoffMs = options.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 35_000;
    this.endpoints = options.endpoints.map((url) => ({ url, failures: 0, blockedUntil: 0 }));
  }

  /** Every pair's places, from cache where possible; rejects when aborted or busy. */
  async get(pairs: readonly PoiTilePair[], signal?: AbortSignal): Promise<PoiTileResults[]> {
    if (signal?.aborted) throw abortError();
    const answers: PoiTileResults[] = [];
    const waiting: Job[] = [];
    for (const pair of pairs) {
      const cached = this.lookup(pair);
      if (cached) {
        answers.push(cached);
        continue;
      }
      const key = poiPairKey(poiTileKey(pair.tile), pair.category);
      const job = this.jobs.get(key) ?? this.enqueue(pair, key);
      job.waiters++;
      waiting.push(job);
    }
    if (!waiting.length) return answers;

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        for (const job of waiting) this.release(job);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    void this.pump();
    try {
      return [
        ...answers,
        ...(await Promise.race([Promise.all(waiting.map((j) => j.promise)), aborted])),
      ];
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  private lookup(pair: PoiTilePair): PoiTileResults | null {
    const tile = poiTileKey(pair.tile);
    const exact = this.fresh(poiPairKey(tile, pair.category));
    if (exact) {
      return { tile, category: pair.category, results: exact.results, complete: exact.complete };
    }
    for (let parent = poiTileParent(pair.tile); parent; parent = poiTileParent(parent)) {
      const entry = this.fresh(poiPairKey(poiTileKey(parent), pair.category));
      if (!entry?.complete) continue;
      const [west, south, east, north] = poiTileBbox(pair.tile);
      const results = entry.results.filter(
        ({ position: { lat, lng } }) => lng >= west && lng <= east && lat >= south && lat <= north,
      );
      return { tile, category: pair.category, results, complete: true };
    }
    return null;
  }

  private fresh(key: string): PoiPairEntry | undefined {
    const now = this.now();
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cachedResults -= Math.max(1, entry.results.length);
      if (entry.expires > now) this.remember(key, entry); // most recently used last
      return entry.expires > now ? entry : undefined;
    }
    const stored = this.options.store?.get(key, now);
    if (stored) this.remember(key, stored);
    return stored;
  }

  private store(answer: PoiTileResults): void {
    const key = poiPairKey(answer.tile, answer.category);
    const entry: PoiPairEntry = {
      results: answer.results,
      complete: answer.complete,
      expires: this.now() + this.cacheTtlMs,
    };
    const previous = this.cache.get(key);
    if (previous) {
      this.cache.delete(key);
      this.cachedResults -= Math.max(1, previous.results.length);
    }
    this.remember(key, entry);
    this.options.store?.set(key, entry);
  }

  /** Hold an entry in memory, evicting the least recently used past the bound. */
  private remember(key: string, entry: PoiPairEntry): void {
    this.cache.set(key, entry);
    this.cachedResults += Math.max(1, entry.results.length);
    for (const [oldest, held] of this.cache) {
      if (this.cachedResults <= this.maxCachedResults) break;
      this.cache.delete(oldest);
      this.cachedResults -= Math.max(1, held.results.length);
    }
  }

  private enqueue(pair: PoiTilePair, key: string): Job {
    let resolve!: Job['resolve'];
    let reject!: Job['reject'];
    const promise = new Promise<PoiTileResults>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    const job: Job = { pair, key, waiters: 0, sent: false, attempts: 0, promise, resolve, reject };
    this.jobs.set(key, job);
    this.queue.push(job);
    return job;
  }

  /** A waiter left. A queued pair nobody waits for any more is never sent. */
  private release(job: Job): void {
    if (this.jobs.get(job.key) !== job) return;
    job.waiters--;
    if (job.waiters > 0 || job.sent) return;
    this.queue = this.queue.filter((queued) => queued !== job);
    this.fail(job, abortError());
  }

  private finish(job: Job, answer: PoiTileResults): void {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.resolve(answer);
  }

  private fail(job: Job, error: unknown): void {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.reject(error);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const wait = this.nextAt - this.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (!this.queue.length) break;
        const endpoint = this.endpoints.find((item) => item.blockedUntil <= this.now());
        if (!endpoint) {
          const until = Math.min(...this.endpoints.map((item) => item.blockedUntil));
          const busy = new PoiUpstreamBusyError(
            Math.max(1, Math.ceil((until - this.now()) / 1000)),
          );
          for (const job of this.queue.splice(0)) this.fail(job, busy);
          break;
        }
        const batch = this.takeBatch();
        for (const job of batch) job.sent = true;
        const started = this.now();
        try {
          const answers = await this.query(
            endpoint.url,
            batch.map((job) => job.pair),
          );
          endpoint.failures = 0;
          this.options.status?.record('overpass', true);
          answers.forEach((answer, index) => {
            this.store(answer);
            this.finish(batch[index]!, answer);
          });
        } catch (error) {
          this.options.onError?.(error, endpoint.url);
          endpoint.failures++;
          endpoint.blockedUntil = this.now() + this.backoffMs(endpoint, error);
          this.options.status?.record(
            'overpass',
            false,
            `${new URL(endpoint.url).host}: ${error instanceof Error ? error.message : 'failed'}`,
          );
          // The next endpoint gets the batch, once each; a pair nobody waits
          // for any more is not worth another upstream query.
          const retry: Job[] = [];
          for (const job of batch) {
            job.attempts++;
            job.sent = false;
            if (job.waiters > 0 && job.attempts < this.endpoints.length) retry.push(job);
            else this.fail(job, error);
          }
          this.queue.unshift(...retry);
        } finally {
          const took = this.now() - started;
          this.nextAt = this.now() + Math.min(this.maxGapMs, Math.max(this.minGapMs, took));
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * How long an endpoint rests after a failure (see `restAfterFailure`). The
   * operator of overpass-api.de asks for at least 30 s after a 429. A refused
   * connection means a ban is already in place, so it gets the longest rest at
   * once rather than a probe every 30 s.
   */
  private backoffMs(endpoint: Endpoint, error: unknown): number {
    return restAfterFailure(endpoint.failures, error, {
      baseMs: this.baseBackoffMs,
      maxMs: this.maxBackoffMs,
    });
  }

  /**
   * The oldest queued pair plus every other queued pair near it: same zoom,
   * within BATCH_SPAN tiles each way. The query searches the batch's combined
   * bounds once per category, so a request from Oslo and one from Bergen
   * batched together would scan everything in between.
   */
  private takeBatch(): Job[] {
    const { z, x, y } = this.queue[0]!.pair.tile;
    let [x0, x1, y0, y1] = [x, x, y, y];
    const batch: Job[] = [];
    const rest: Job[] = [];
    for (const job of this.queue) {
      const tile = job.pair.tile;
      const nx0 = Math.min(x0, tile.x);
      const nx1 = Math.max(x1, tile.x);
      const ny0 = Math.min(y0, tile.y);
      const ny1 = Math.max(y1, tile.y);
      if (
        batch.length < this.maxBatch &&
        tile.z === z &&
        nx1 - nx0 < BATCH_SPAN &&
        ny1 - ny0 < BATCH_SPAN
      ) {
        [x0, x1, y0, y1] = [nx0, nx1, ny0, ny1];
        batch.push(job);
      } else {
        rest.push(job);
      }
    }
    this.queue = rest;
    return batch;
  }

  private async query(url: string, pairs: PoiTilePair[]): Promise<PoiTileResults[]> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': this.userAgent,
      },
      body: new URLSearchParams({ data: overpassPoiTileQuery(pairs) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // A 400 is our query's fault; its body says why, so keep a readable slice.
      const detail =
        response.status === 400
          ? `: ${(await response.text())
              .replace(/<[^>]*>/g, ' ')
              .replace(/\s+/g, ' ')
              .slice(0, 300)}`
          : '';
      throw new UpstreamHttpError(
        response.status,
        `HTTP ${response.status}${detail}`,
        retryAfterSeconds(response.headers.get('retry-after'), this.now()),
      );
    }
    const json = (await response.json()) as { elements?: OverpassPoiElement[]; remark?: string };
    // A timed-out or out-of-memory query still answers 200, with a remark and
    // whatever it had; overpassPoiTileResults would also catch the gap.
    if (json.remark && /error/i.test(json.remark)) throw new Error(json.remark);
    return overpassPoiTileResults(json.elements ?? [], pairs);
  }
}
