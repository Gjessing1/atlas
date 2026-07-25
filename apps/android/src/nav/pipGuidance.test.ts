import type { NavController } from '@atlas/app-hooks';
import type { NavState } from '@atlas/navigation';
import type { RouteInstruction } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import { pipCardMetrics, pipGuidance } from './pipGuidance';

type Nav = Pick<NavController, 'phase' | 'state' | 'tripSummary' | 'error'>;

/** Only the fields the compact card reads; the rest of NavState is irrelevant here. */
function state(over: Partial<NavState>): NavState {
  return {
    etaEpochMs: new Date(2026, 6, 25, 14, 32).getTime(),
    distanceRemainingM: 12_400,
    currentRoad: 'E6',
    upcoming: null,
    then: null,
    sustain: null,
    ...over,
  } as NavState;
}

function nav(over: Partial<Nav>): Nav {
  return { phase: 'navigating', state: null, tripSummary: null, error: null, ...over };
}

/** A route instruction with the geometry fields the card never looks at. */
function instruction(sign: number, text: string): RouteInstruction {
  return { sign, text, distanceM: 0, timeMs: 0, interval: [0, 1] };
}

describe('pipGuidance', () => {
  it('leads with the distance to the next maneuver and what it is', () => {
    const guidance = pipGuidance(
      nav({
        state: state({
          upcoming: {
            instruction: instruction(2, 'Turn right onto Storgata'),
            distanceToM: 240,
          },
        }),
      }),
    );

    expect(guidance.headline).toBe('240 m');
    expect(guidance.detail).toBe('Turn right onto Storgata');
    expect(guidance.footer).toBe('14:32 · 12 km');
    expect(guidance.instruction).toEqual(instruction(2, 'Turn right onto Storgata'));
    expect(guidance.ended).toBe(false);
  });

  it('names the road on a long leg instead of a distant turn', () => {
    const guidance = pipGuidance(
      nav({
        state: state({
          sustain: { road: 'E18', distanceRemainingM: 8200 },
          upcoming: { instruction: instruction(2, 'Turn right'), distanceToM: 8200 },
        }),
      }),
    );

    expect(guidance.headline).toBe('8.2 km');
    expect(guidance.detail).toBe('E18');
    // Straight-ahead arrow, as the full banner shows for a sustain cue.
    expect(guidance.instruction).toEqual({ sign: 0 });
  });

  it('says a trip is over rather than freezing the last maneuver', () => {
    const arrived = pipGuidance(
      nav({ phase: 'arrived', tripSummary: { distanceM: 24_000, durationMs: 1_800_000 } }),
    );
    expect(arrived).toMatchObject({ headline: 'Arrived', detail: '24 km', ended: true });

    const failed = pipGuidance(nav({ phase: 'error', error: 'No route found' }));
    expect(failed).toMatchObject({ headline: 'Navigation stopped', ended: true });

    const idle = pipGuidance(nav({ phase: 'idle' }));
    expect(idle).toMatchObject({ headline: 'Atlas', detail: 'Tap to open', ended: true });
  });

  it('shows the reroute in progress while keeping the arrival estimate', () => {
    const guidance = pipGuidance(nav({ phase: 'rerouting', state: state({ upcoming: null }) }));

    expect(guidance.headline).toBe('Rerouting…');
    expect(guidance.detail).toBe('E6');
    expect(guidance.footer).toBe('14:32 · 12 km');
  });
});

describe('pipCardMetrics', () => {
  it('grows the strip with the window the user resized it to', () => {
    const small = pipCardMetrics(240, 135);
    const large = pipCardMetrics(400, 225);

    expect(large.icon).toBeGreaterThan(small.icon);
    expect(large.headline).toBeGreaterThan(small.headline);
    expect(large.height).toBeGreaterThan(small.height);
    expect(large.padding).toBeGreaterThanOrEqual(small.padding);
  });

  it('stays readable at the extremes instead of scaling without limit', () => {
    const tiny = pipCardMetrics(120, 68);
    const huge = pipCardMetrics(1200, 675);

    expect(tiny.icon).toBe(22);
    expect(tiny.headline).toBe(15);
    expect(huge.icon).toBe(34);
    expect(huge.headline).toBe(24);
  });

  it('always leaves most of the window to the map', () => {
    for (const [w, h] of [
      [160, 90],
      [240, 135],
      [400, 225],
      [1200, 675],
    ]) {
      expect(pipCardMetrics(w!, h!).height).toBeLessThan(h! / 2);
    }
  });

  it('drops the arrival clock in a window too narrow to hold it', () => {
    expect(pipCardMetrics(160, 90).showFooter).toBe(false);
    expect(pipCardMetrics(240, 135).showFooter).toBe(true);
  });
});
