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

  it('preserves registration order in the snapshot', () => {
    const r = new StatusRegistry();
    r.register('photon', 'Photon', 'Search');
    r.register('valhalla', 'Valhalla', 'Routing');
    r.record('metno', true);
    expect(r.toStatus().map((s) => s.id)).toEqual(['photon', 'valhalla', 'metno']);
  });
});
