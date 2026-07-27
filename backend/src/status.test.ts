import { describe, expect, it } from 'vitest';
import { StatusRegistry } from './status.js';

const byId = (r: StatusRegistry) => new Map(r.toStatus().map((s) => [s.id, s]));

/** A registry on a hand-cranked clock — health depends on outcome timing. */
function clocked(): { r: StatusRegistry; tick: (ms: number) => void } {
  let now = 1_700_000_000_000;
  const r = new StatusRegistry(() => now);
  return { r, tick: (ms) => void (now += ms) };
}

const MINUTE = 60_000;

describe('StatusRegistry', () => {
  it('reports a registered but un-probed source as unknown', () => {
    const r = new StatusRegistry();
    r.register('photon', 'Photon', 'Search');
    const s = byId(r).get('photon')!;
    expect(s.health).toBe('unknown');
    expect(s.lastSuccess).toBeNull();
    expect(s.lastFailure).toBeNull();
    expect(r.overall()).toBe('unknown');
  });

  it('marks a source ok after a successful probe and clears the message', () => {
    const r = new StatusRegistry();
    r.register('photon', 'Photon', 'Search');
    r.record('photon', false, 'HTTP 502');
    expect(byId(r).get('photon')!.health).toBe('down'); // failed, never ok yet
    r.record('photon', true);
    const s = byId(r).get('photon')!;
    expect(s.health).toBe('ok');
    expect(s.message).toBeNull();
    expect(s.lastSuccess).not.toBeNull();
  });

  it('is down when it has only ever failed, degraded once it has also succeeded', () => {
    const { r, tick } = clocked();
    r.record('valhalla', false, 'unreachable');
    expect(byId(r).get('valhalla')!.health).toBe('down');
    r.record('valhalla', true);
    tick(MINUTE);
    r.record('valhalla', false, 'HTTP 500');
    const s = byId(r).get('valhalla')!;
    expect(s.health).toBe('degraded');
    expect(s.message).toBe('HTTP 500');
    expect(s.lastSuccess).not.toBeNull();
    expect(s.lastFailure).not.toBeNull();
  });

  it('does not let one straggler from a concurrent batch mark a source down', () => {
    // Twenty tiles go out at once; one times out and resolves last. The other
    // nineteen drew fine, so the source is not down.
    const { r, tick } = clocked();
    r.record('overlay:terrain-contours', true);
    tick(400);
    r.record('overlay:terrain-contours', false, 'unreachable');
    expect(byId(r).get('overlay:terrain-contours')!.health).toBe('ok');
    // Once the failures outlive the last success, it is a real outage again.
    tick(MINUTE);
    r.record('overlay:terrain-contours', false, 'unreachable');
    expect(byId(r).get('overlay:terrain-contours')!.health).toBe('degraded');
  });

  it('lets a stale, never-retried failure fade back to unknown', () => {
    // Probes ride on real traffic: nothing has touched this source in half an
    // hour, so claiming it is down is a guess, not an observation.
    const { r, tick } = clocked();
    r.record('overlay:lake-depth', false, 'HTTP 502');
    expect(byId(r).get('overlay:lake-depth')!.health).toBe('down');
    tick(31 * MINUTE);
    expect(byId(r).get('overlay:lake-depth')!.health).toBe('unknown');
    expect(r.overall()).toBe('unknown');
  });

  it('auto-registers an unknown id under "Other"', () => {
    const r = new StatusRegistry();
    r.record('overlay:lake-depth', true);
    const s = byId(r).get('overlay:lake-depth')!;
    expect(s.group).toBe('Other');
    expect(s.health).toBe('ok');
  });

  it('rolls overall up to the worst real health, ignoring unknowns', () => {
    const { r, tick } = clocked();
    r.register('a', 'A', 'G');
    r.record('b', true);
    expect(r.overall()).toBe('ok'); // a unknown, b ok
    r.record('c', true);
    tick(MINUTE);
    r.record('c', false, 'x'); // c degraded
    expect(r.overall()).toBe('degraded');
    r.record('d', false, 'x'); // d down
    expect(r.overall()).toBe('down');
  });

  it('keeps recorded state and refreshes labels on re-register', () => {
    const r = new StatusRegistry();
    r.record('metno', true);
    r.register('metno', 'MET Norway', 'Weather');
    const s = byId(r).get('metno')!;
    expect(s.label).toBe('MET Norway');
    expect(s.group).toBe('Weather');
    expect(s.health).toBe('ok'); // outcome survived the re-register
  });

  it('attaches a detail line without touching health', () => {
    const r = new StatusRegistry();
    r.register('basemap', 'Basemap', 'Map data');
    r.setDetail('basemap', 'map data from 2026-07-12 · 1 archive');
    const s = byId(r).get('basemap')!;
    expect(s.detail).toBe('map data from 2026-07-12 · 1 archive');
    expect(s.health).toBe('unknown');
  });

  /**
   * The silent failure. Every request succeeded, so nothing in the transport
   * layer is wrong — and the data is still not to be trusted (a year-named
   * service whose successor has appeared, a layer republished empty). Health has
   * to reflect that, or the page reports "Operational" about wrong data.
   */
  it('is degraded while a warning stands, even though every request succeeded', () => {
    const r = new StatusRegistry();
    r.register('overlay:statskog-jaktfelt:year', 'Statskog year', 'Overlays');
    r.record('overlay:statskog-jaktfelt:year', true);
    expect(byId(r).get('overlay:statskog-jaktfelt:year')!.health).toBe('ok');
    r.warn('overlay:statskog-jaktfelt:year', '2025 data has been published');
    const warned = byId(r).get('overlay:statskog-jaktfelt:year')!;
    expect(warned.health).toBe('degraded');
    expect(warned.warning).toBe('2025 data has been published');
    // Its message stays null: nothing failed, so there is nothing to blame.
    expect(warned.message).toBeNull();
    expect(r.overall()).toBe('degraded');
  });

  it('clears a warning when the upstream recovers', () => {
    const r = new StatusRegistry();
    r.record('overlay:statskog-jaktfelt', true);
    r.warn('overlay:statskog-jaktfelt', 'only 0 features');
    expect(byId(r).get('overlay:statskog-jaktfelt')!.health).toBe('degraded');
    r.warn('overlay:statskog-jaktfelt', null);
    expect(byId(r).get('overlay:statskog-jaktfelt')!.health).toBe('ok');
    expect(byId(r).get('overlay:statskog-jaktfelt')!.warning).toBeNull();
  });

  it('records probe latency and rounds it', () => {
    const r = new StatusRegistry();
    r.record('input:dtm', true, undefined, 133.7);
    expect(byId(r).get('input:dtm')!.latencyMs).toBe(134);
    // Proxy traffic passes no timing, and must not blank an earlier probe's.
    r.record('input:dtm', true);
    expect(byId(r).get('input:dtm')!.latencyMs).toBe(134);
  });

  it('knows whether an id is already registered', () => {
    const r = new StatusRegistry();
    r.register('photon', 'Photon', 'Search');
    expect(r.has('photon')).toBe(true);
    expect(r.has('nope')).toBe(false);
  });

  it('preserves registration order in the snapshot', () => {
    const r = new StatusRegistry();
    r.register('photon', 'Photon', 'Search');
    r.register('valhalla', 'Valhalla', 'Routing');
    r.record('metno', true);
    expect(r.toStatus().map((s) => s.id)).toEqual(['photon', 'valhalla', 'metno']);
  });
});
