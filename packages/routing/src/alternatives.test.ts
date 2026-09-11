import { describe, expect, it } from 'vitest';

import { routeAlternativeLabelPoint } from './alternatives.js';

describe('routeAlternativeLabelPoint', () => {
  it('places the badge on the visibly distinct branch', () => {
    const active = Array.from({ length: 11 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.01 }));
    const alternative = active.map((point, i) => ({
      ...point,
      lat: i >= 3 && i <= 7 ? 60 + (1 - Math.abs(i - 5) / 3) * 0.02 : 60,
    }));

    expect(routeAlternativeLabelPoint(active, alternative)).toEqual(alternative[5]);
  });

  it('falls back to the midpoint when there is no active geometry', () => {
    const path = [
      { lat: 60, lng: 10 },
      { lat: 60, lng: 10.01 },
    ];
    expect(routeAlternativeLabelPoint([], path)).toEqual(path[1]);
  });

  it('rejects the active line re-cut from the current position', () => {
    const path = Array.from({ length: 11 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.01 }));
    expect(routeAlternativeLabelPoint(path, path.slice(4))).toBeNull();
  });
});
