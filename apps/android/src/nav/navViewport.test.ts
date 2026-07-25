import { describe, expect, it } from 'vitest';

import { navViewport } from './navViewport';

describe('navViewport', () => {
  it('keeps portrait guidance full-width and the puck centred', () => {
    const view = navViewport(400, 800, { left: 0, right: 0 }, 28, 48);

    expect(view.landscape).toBe(false);
    expect(view.guidanceLeft).toBe(12);
    expect(view.guidanceWidth).toBe(376);
    expect(view.mapLeft).toBe(0);
    expect(view.mapRight).toBe(400);
    expect(view.courseAnchor).toEqual({ x: 200, y: 576 });
    expect(view.flatAnchor.x).toBe(200);
  });

  it('centres landscape navigation in the right map pane', () => {
    const view = navViewport(800, 400, { left: 0, right: 0 }, 28, 0);

    expect(view.landscape).toBe(true);
    expect(view.guidanceWidth).toBe(336);
    expect(view.mapLeft).toBe(360);
    expect(view.mapRight).toBe(800);
    expect(view.courseAnchor).toEqual({ x: 580, y: 272 });
    expect(view.overviewPadding.left).toBe(388);
  });

  it('treats a picture-in-picture window as one small map, not a landscape screen', () => {
    // 16:9 mini window: wider than tall, but no rail and no system bars.
    const view = navViewport(320, 180, { left: 0, right: 0 }, 0, 46, true);

    expect(view.landscape).toBe(false);
    expect(view.mapLeft).toBe(0);
    expect(view.mapRight).toBe(320);
    expect(view.courseAnchor.x).toBe(160);
    // The compact card owns the bottom strip, so the puck stays above it.
    expect(view.courseAnchor.y).toBeLessThan(180 - 46 / 2);
  });

  it('clears a landscape system bar on either side', () => {
    const barOnLeft = navViewport(800, 400, { left: 48, right: 0 }, 28, 0);
    const barOnRight = navViewport(800, 400, { left: 0, right: 48 }, 28, 0);

    expect(barOnLeft.guidanceLeft).toBe(60);
    expect(barOnLeft.courseAnchor.x).toBe(604);
    expect(barOnRight.guidanceLeft).toBe(12);
    expect(barOnRight.mapRight).toBe(752);
    expect(barOnRight.courseAnchor.x).toBe(556);
  });
});
