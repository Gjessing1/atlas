import { describe, expect, it } from 'vitest';

import {
  altChipLabel,
  modeTimeLabel,
  routeDeltaLabel,
  stopAlongLabel,
  stopRole,
  stopTitle,
  waypointLabel,
} from './routelabels.js';

describe('altChipLabel', () => {
  const paths = [{ timeMs: 600_000 }, { timeMs: 780_000 }, { timeMs: 600_020 }];

  it('shows the fastest route as its own duration, not a delta', () => {
    expect(altChipLabel(paths, 0, [null, null, null])).toBe('10 min');
  });

  it('shows the others as extra minutes', () => {
    expect(altChipLabel(paths, 1, [null, null, null])).toBe('+3 min');
  });

  it('never claims a sub-minute alternative is equally fast', () => {
    expect(altChipLabel(paths, 2, [null, null, null])).toBe('+<1 min');
  });

  it('appends the via label that distinguishes the alternative', () => {
    expect(altChipLabel(paths, 1, [null, 'E18', null])).toBe('+3 min via E18');
  });
});

describe('routeDeltaLabel', () => {
  it('shows slower and faster choices relative to the active route', () => {
    expect(routeDeltaLabel(5 * 60_000)).toBe('+5 min');
    expect(routeDeltaLabel(-2 * 60_000)).toBe('−2 min');
  });

  it('does not round a real sub-minute difference to zero', () => {
    expect(routeDeltaLabel(45_000)).toBe('+<1 min');
    expect(routeDeltaLabel(-45_000)).toBe('−<1 min');
    expect(routeDeltaLabel(20_000)).toBe('Same ETA');
  });
});

describe('modeTimeLabel', () => {
  it('distinguishes "still routing" from "cannot route this"', () => {
    expect(modeTimeLabel(undefined)).toBe('…');
    expect(modeTimeLabel('none')).toBe('—');
    expect(modeTimeLabel(3_600_000)).toBe('1 h 0 min');
  });
});

describe('waypointLabel', () => {
  it('letters the stops to match the map markers', () => {
    expect(waypointLabel(0, false, 3)).toBe('A');
    expect(waypointLabel(2, false, 3)).toBe('C');
  });

  it('falls back to numbers past Z', () => {
    expect(waypointLabel(26, false, 30)).toBe('27');
  });

  it('marks a lone stop — a loop with only its anchor', () => {
    expect(waypointLabel(0, true, 1)).toBe('⟳');
    expect(waypointLabel(0, false, 1)).toBe('⟳');
  });

  it('letters the stops of a loop that has some, so their order is readable', () => {
    expect(waypointLabel(0, true, 3)).toBe('A');
    expect(waypointLabel(2, true, 3)).toBe('C');
  });
});

describe('stopRole', () => {
  it('names the ends of a two-stop journey', () => {
    expect(stopRole(0, 2, false)).toBe('From');
    expect(stopRole(1, 2, false)).toBe('To');
  });

  it('leaves the lettering alone when there are via points or a loop', () => {
    expect(stopRole(0, 3, false)).toBeNull();
    expect(stopRole(0, 2, true)).toBeNull();
  });
});

describe('stopTitle', () => {
  it('prefers the looked-up name', () => {
    expect(stopTitle({ pos: { lat: 59.9139, lng: 10.7522 }, name: 'Oslo S' })).toBe('Oslo S');
  });

  it('falls back to coordinates for an unlabelled map tap', () => {
    expect(stopTitle({ pos: { lat: 59.91391, lng: 10.75224 } })).toBe('59.9139, 10.7522');
  });
});

describe('stopAlongLabel', () => {
  it('names the start instead of rounding a distance to zero', () => {
    expect(stopAlongLabel(0)).toBe('at the start');
    expect(stopAlongLabel(60)).toBe('at the start');
    expect(stopAlongLabel(42_400)).toBe('at 42.4 km');
  });
});
