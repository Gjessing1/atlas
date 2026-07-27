import { describe, expect, it, vi } from 'vitest';
import { norwegianLayers, type OverlayLayer } from './overlay/catalog.js';
import {
  allProbes,
  inputProbes,
  OVERLAY_PROBES,
  overlayProbe,
  ProbeRunner,
  yearSuccessorProbe,
  type ProbeSpec,
} from './probes.js';
import { StatusRegistry } from './status.js';

const log = {
  warn: () => {},
  error: () => {},
  info: () => {},
} as unknown as Parameters<typeof ProbeRunner>[2];

/** A PNG-ish body of a given size with the right content-type. */
const image = (bytes: number) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' } });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const layer = (id: string): OverlayLayer => norwegianLayers().find((l) => l.meta.id === id)!;

describe('probe coverage', () => {
  /**
   * The whole point of N7: a new Norwegian layer must not be able to ship
   * unwatched. The catalog and the probe table are checked against each other
   * both ways, so neither adding a layer nor deleting one can leave the two
   * disagreeing silently.
   */
  it('has exactly one probe per catalog layer', () => {
    const catalogIds = norwegianLayers()
      .map((l) => l.meta.id)
      .sort();
    expect(Object.keys(OVERLAY_PROBES).sort()).toEqual(catalogIds);
  });

  it('probes every catalog layer plus the engine inputs in one sweep', () => {
    const specs = allProbes(norwegianLayers(), {});
    const ids = specs.map((s) => s.id);
    // Every layer, the year-successor check, and the non-catalog N5 inputs.
    expect(ids).toContain('overlay:lake-depth');
    expect(ids).toContain('overlay:statskog-jaktfelt:year');
    expect(ids).toContain('input:dtm');
    expect(ids).toContain('input:streams');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the N5 inputs the engine reads', () => {
    const ids = inputProbes({}).map((s) => s.id);
    // The list ROADMAP § N7 names explicitly.
    for (const id of [
      'input:dtm',
      'input:lake-register',
      'input:streams',
      'input:catchments',
      'input:sr16',
      'input:anadromous',
      'input:artfunksjon',
      'input:vern',
      'input:hydapi',
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe('tile probes', () => {
  it('asks at the calibrated point and passes a tile with ink in it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(image(20_000));
    const probe = overlayProbe(layer('hillshade'), OVERLAY_PROBES['hillshade']!, {});
    const outcome = await probe.run(fetchImpl);
    expect(outcome).toMatchObject({ ok: true, warning: null });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.get('REQUEST')).toBe('GetMap');
    expect(url.searchParams.get('CRS')).toBe('EPSG:3857');
  });

  /**
   * The silent failure this exists for: a 200, a valid PNG, and nothing drawn.
   * AR5 answers exactly like this below its 1:50 000 scale floor, so a shifted
   * scale range is indistinguishable from a healthy request without this check.
   */
  it('warns — without failing — when the upstream answers but draws nothing', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(image(334));
    const probe = overlayProbe(layer('land-cover'), OVERLAY_PROBES['land-cover']!, {});
    const outcome = await probe.run(fetchImpl);
    expect(outcome.ok).toBe(true);
    expect(outcome.warning).toMatch(/draws nothing/);
  });

  it('fails on a ServiceException wearing a 200', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<ServiceExceptionReport/>', {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      }),
    );
    const probe = overlayProbe(layer('hillshade'), OVERLAY_PROBES['hillshade']!, {});
    expect(await probe.run(fetchImpl)).toMatchObject({ ok: false });
  });

  it('fails on an HTTP error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    const probe = overlayProbe(layer('hillshade'), OVERLAY_PROBES['hillshade']!, {});
    expect(await probe.run(fetchImpl)).toMatchObject({ ok: false, message: 'HTTP 503' });
  });

  /**
   * The wildlife layer's species filter is an SLD on GetMap, and it fails
   * silently: without it the tile comes back with every seabird in Norway
   * drawn. So the probe has to carry the layer's default option, or it would
   * check a request no user ever makes.
   */
  it('exercises a layer default option (the wildlife species SLD)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(image(4000));
    const probe = overlayProbe(layer('wildlife-areas'), OVERLAY_PROBES['wildlife-areas']!, {});
    await probe.run(fetchImpl);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    const sld = url.searchParams.get('SLD_BODY') ?? '';
    expect(sld).toContain('Elg');
    // Big game is the default choice; ptarmigan must not leak in.
    expect(sld).not.toContain('Lirype');
  });
});

describe('count probes', () => {
  it('reports the count and stays quiet when it is plausible', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ count: 922 }));
    const probe = overlayProbe(
      layer('statskog-jaktfelt'),
      OVERLAY_PROBES['statskog-jaktfelt']!,
      {},
    );
    const outcome = await probe.run(fetchImpl);
    expect(outcome).toMatchObject({ ok: true, warning: null });
    expect(outcome.detail).toContain('922');
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('returnCountOnly=true');
  });

  it('warns when a layer is republished empty', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ count: 0 }));
    const probe = overlayProbe(
      layer('statskog-jaktfelt'),
      OVERLAY_PROBES['statskog-jaktfelt']!,
      {},
    );
    const outcome = await probe.run(fetchImpl);
    expect(outcome.ok).toBe(true);
    expect(outcome.warning).toMatch(/only 0/);
  });

  /** ArcGIS reports a missing service as HTTP 200 with an error object. */
  it('fails on an ArcGIS error body served with a 200', async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(json({ error: { code: 404, message: 'Service not found' } })),
      );
    const probe = overlayProbe(
      layer('statskog-jaktfelt'),
      OVERLAY_PROBES['statskog-jaktfelt']!,
      {},
    );
    const outcome = await probe.run(fetchImpl);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('404');
  });
});

describe('year-successor probe', () => {
  const probe = () => yearSuccessorProbe(layer('statskog-jaktfelt'))!;

  it('is clean while no newer year exists', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: { code: 404, message: 'not found' } }));
    const outcome = await probe().run(fetchImpl);
    expect(outcome).toMatchObject({ ok: true, warning: null });
    // Two years ahead, so a skipped year does not blind the check forever.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  /**
   * The concrete driver for N7: the old service keeps answering, so nothing
   * fails — Atlas would just serve last season's hunting fields indefinitely.
   */
  it('warns when the next season has been published', async () => {
    const url = (call: unknown) => String(call);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          url(input).includes('Storvilt_2025')
            ? json({ count: 950 })
            : json({ error: { code: 404 } }),
        ),
      );
    const outcome = await probe().run(fetchImpl);
    expect(outcome.ok).toBe(true);
    expect(outcome.warning).toContain('2025');
    expect(outcome.warning).toContain('2024');
  });

  it('treats an unreachable successor as the healthy answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    expect(await probe().run(fetchImpl)).toMatchObject({ ok: true, warning: null });
  });

  it('is absent for layers with no year in their URL', () => {
    expect(yearSuccessorProbe(layer('hillshade'))).toBeNull();
  });
});

describe('ProbeRunner', () => {
  const spec = (id: string, outcome: Awaited<ReturnType<ProbeSpec['run']>>): ProbeSpec => ({
    id,
    label: id,
    group: 'Test',
    run: () => Promise.resolve(outcome),
  });

  function runner(specs: ProbeSpec[], opts: { intervalMs?: number } = {}) {
    let now = 1_700_000_000_000;
    const status = new StatusRegistry(() => now);
    const r = new ProbeRunner(specs, status, log, {
      now: () => now,
      intervalMs: opts.intervalMs ?? 1000,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    return { r, status, tick: (ms: number) => void (now += ms) };
  }

  it('registers every probed source before any sweep, so none is missing from the page', () => {
    const { status } = runner([spec('a', { ok: true }), spec('b', { ok: true })]);
    expect(status.toStatus().map((s) => s.id)).toEqual(['a', 'b']);
    expect(status.toStatus()[0]!.health).toBe('unknown');
  });

  it('records outcome, detail, warning and latency', async () => {
    const { r, status } = runner([
      spec('a', { ok: true, detail: '922 features', warning: null }),
      spec('b', { ok: false, message: 'HTTP 500' }),
      spec('c', { ok: true, warning: 'successor published' }),
    ]);
    await r.run(true);
    const byId = new Map(status.toStatus().map((s) => [s.id, s]));
    expect(byId.get('a')).toMatchObject({ health: 'ok', detail: '922 features', warning: null });
    expect(byId.get('b')).toMatchObject({ health: 'down', message: 'HTTP 500' });
    // Answered, but not to be trusted — that is degraded, not ok.
    expect(byId.get('c')).toMatchObject({ health: 'degraded', warning: 'successor published' });
    expect(byId.get('a')!.latencyMs).not.toBeNull();
  });

  it('skips probes that are not due yet, and re-runs them when forced', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    const specs = [{ id: 'a', label: 'a', group: 'Test', run }];
    const { r, tick } = runner(specs, { intervalMs: 10_000 });
    await r.run(false);
    await r.run(false);
    expect(run).toHaveBeenCalledTimes(1);
    await r.run(true);
    expect(run).toHaveBeenCalledTimes(2);
    tick(10_000);
    await r.run(false);
    expect(run).toHaveBeenCalledTimes(3);
  });

  /** "Check now" pressed twice must not double the load on someone else's server. */
  it('shares one sweep between concurrent callers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const run = vi.fn().mockImplementation(() => gate.then(() => ({ ok: true })));
    const { r } = runner([{ id: 'a', label: 'a', group: 'Test', run }]);
    const first = r.run(true);
    const second = r.run(true);
    expect(r.snapshot.probing).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.snapshot.probing).toBe(false);
    expect(r.snapshot.lastSweep).not.toBeNull();
  });

  /**
   * A broken TLS chain surfaces as a bare "fetch failed"; the cause code is the
   * only part that says what actually happened, and that distinction is what
   * told us kart.miljodirektoratet.no had stopped presenting its intermediate.
   */
  it('reports a transport failure by its cause code', async () => {
    const err = new Error('fetch failed');
    (err as Error & { cause: unknown }).cause = { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' };
    const { r, status } = runner([
      { id: 'a', label: 'a', group: 'Test', run: () => Promise.reject(err) },
    ]);
    await r.run(true);
    expect(status.toStatus()[0]).toMatchObject({
      health: 'down',
      message: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
  });

  it('keeps sweeping after one probe throws', async () => {
    const good = vi.fn().mockResolvedValue({ ok: true });
    const { r, status } = runner([
      { id: 'bad', label: 'bad', group: 'Test', run: () => Promise.reject(new Error('boom')) },
      { id: 'good', label: 'good', group: 'Test', run: good },
    ]);
    await r.run(true);
    expect(good).toHaveBeenCalled();
    expect(new Map(status.toStatus().map((s) => [s.id, s.health])).get('good')).toBe('ok');
  });
});
