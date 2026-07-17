import { test } from '@playwright/test';

// Use the host iGPU (container run with --device /dev/dri) instead of SwiftShader.
test.use({
  launchOptions: {
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
  },
});

/**
 * One-off measurements for the ARCHITECTURE.md performance targets:
 * map startup < 2 s, cold startup < 3 s, rendering 60 FPS.
 */
test('measure startup and rendering FPS', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as never as { __atlasMap?: unknown }).__atlasMap),
  );
  const startup = await page.evaluate(
    () =>
      new Promise<{ mapIdleMs: number; loadEventMs: number }>((resolve) => {
        const w = window as never as { __atlasMap: import('maplibre-gl').Map };
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const done = (): void =>
          resolve({
            mapIdleMs: Math.round(performance.now()),
            loadEventMs: Math.round(nav.loadEventEnd),
          });
        if (w.__atlasMap.loaded()) done();
        else w.__atlasMap.once('idle', done);
      }),
  );
  console.log(`STARTUP map-idle=${startup.mapIdleMs}ms load-event=${startup.loadEventMs}ms`);

  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const w = window as never as { __atlasMap: import('maplibre-gl').Map };
        let frames = 0;
        const durationMs = 2500;
        const start = performance.now();
        const tick = (): void => {
          frames += 1;
          if (performance.now() - start < durationMs) requestAnimationFrame(tick);
          else resolve(Math.round((frames / (performance.now() - start)) * 1000));
        };
        // Animate a pan+zoom so the measurement covers active tile rendering.
        w.__atlasMap.easeTo({
          center: { lat: 60.39, lng: 5.32 },
          zoom: 11,
          duration: durationMs,
        });
        requestAnimationFrame(tick);
      }),
  );
  console.log(`FPS during animated pan+zoom: ${fps}`);
});
