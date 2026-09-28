import { describe, expect, it } from 'vitest';
import {
  LruMap,
  restAfterFailure,
  retryAfterSeconds,
  SingleFlight,
  UpstreamBusyError,
  UpstreamGate,
  UpstreamHttpError,
} from './upstream.js';

describe('retryAfterSeconds', () => {
  it('reads delta-seconds and HTTP-dates, and ignores anything else', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(retryAfterSeconds('120', now)).toBe(120);
    expect(retryAfterSeconds('Mon, 28 Sep 2026 12:01:30 GMT', now)).toBe(90);
    expect(retryAfterSeconds('Mon, 28 Sep 2026 11:00:00 GMT', now)).toBeUndefined();
    expect(retryAfterSeconds('0', now)).toBeUndefined();
    expect(retryAfterSeconds('soon', now)).toBeUndefined();
    expect(retryAfterSeconds(null, now)).toBeUndefined();
  });
});

describe('restAfterFailure', () => {
  const policy = { baseMs: 10_000, maxMs: 600_000 };

  it('doubles per failure in a row, up to the maximum', () => {
    expect(restAfterFailure(1, new Error('x'), policy)).toBe(10_000);
    expect(restAfterFailure(3, new Error('x'), policy)).toBe(40_000);
    expect(restAfterFailure(20, new Error('x'), policy)).toBe(600_000);
  });

  it('waits at least 30 s after a 429, and at least what Retry-After asks', () => {
    expect(restAfterFailure(1, new UpstreamHttpError(429, 'HTTP 429'), policy)).toBe(30_000);
    expect(restAfterFailure(1, new UpstreamHttpError(503, 'HTTP 503', 90), policy)).toBe(90_000);
  });

  it('rests a refused connection for the maximum at once', () => {
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    expect(restAfterFailure(1, refused, policy)).toBe(600_000);
  });
});

describe('LruMap', () => {
  it('evicts the least recently used entry, not everything', () => {
    const map = new LruMap<string, number>(2);
    map.set('a', 1).set('b', 2);
    expect(map.get('a')).toBe(1); // a is now the most recent
    map.set('c', 3);
    expect(map.get('b')).toBeUndefined();
    expect(map.get('a')).toBe(1);
    expect(map.get('c')).toBe(3);
    expect(map.size).toBe(2);
  });
});

describe('SingleFlight', () => {
  it('shares one call between identical requests, and forgets it once settled', async () => {
    const flights = new SingleFlight<string, number>();
    let calls = 0;
    const task = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return calls;
    };
    const [a, b] = await Promise.all([flights.run('k', task), flights.run('k', task)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    await flights.run('k', task);
    expect(calls).toBe(2);
  });
});

describe('UpstreamGate', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('caps calls in flight', async () => {
    const gate = new UpstreamGate({ maxConcurrent: 2 });
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(10);
          inFlight--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it('spaces the starts of calls by the minimum gap', async () => {
    const gate = new UpstreamGate({ maxConcurrent: 4, minGapMs: 30 });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 3 }, () => gate.run(async () => starts.push(Date.now()))),
    );
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(25);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(25);
  });

  it('rests after a failure: queued and new callers fail fast until it ends', async () => {
    let now = 1_000_000;
    const gate = new UpstreamGate({ maxConcurrent: 1, baseBackoffMs: 10_000, now: () => now });
    let release!: () => void;
    const failing = gate.run(
      () => new Promise((_, reject) => (release = () => reject(new Error('boom')))),
    );
    const queued = gate.run(async () => 'never');
    await sleep(0);
    release();
    await expect(failing).rejects.toThrow('boom');
    await expect(queued).rejects.toBeInstanceOf(UpstreamBusyError);
    expect(gate.retryAfterS()).toBe(10);
    await expect(gate.run(async () => 'no')).rejects.toMatchObject({ retryAfterS: 10 });

    now += 10_001;
    expect(gate.retryAfterS()).toBe(0);
    await expect(gate.run(async () => 'yes')).resolves.toBe('yes');
  });

  it('doubles the rest for failures in a row and resets it after a success', async () => {
    let now = 0;
    const gate = new UpstreamGate({ baseBackoffMs: 10_000, now: () => now });
    const fail = () => gate.run(async () => Promise.reject(new Error('x'))).catch(() => {});
    await fail();
    now += 10_001;
    await fail();
    expect(gate.retryAfterS()).toBe(20);
    now += 20_001;
    await gate.run(async () => 'ok');
    await fail();
    expect(gate.retryAfterS()).toBe(10);
  });
});
