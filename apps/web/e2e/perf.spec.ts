import { test } from '@playwright/test';
import './helpers.js'; // window.__atlasMap global declaration

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
  await page.waitForFunction(() => Boolean(window.__atlasMap));
  const startup = await page.evaluate(
    () =>
      new Promise<{ mapIdleMs: number; loadEventMs: number }>((resolve) => {
        const map = window.__atlasMap!;
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const done = (): void =>
          resolve({
            mapIdleMs: Math.round(performance.now()),
            loadEventMs: Math.round(nav.loadEventEnd),
          });
        if (map.loaded()) done();
        else map.once('idle', done);
      }),
  );
  console.log(`STARTUP map-idle=${startup.mapIdleMs}ms load-event=${startup.loadEventMs}ms`);

  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const map = window.__atlasMap!;
        let frames = 0;
        const durationMs = 2500;
        const start = performance.now();
        const tick = (): void => {
          frames += 1;
          if (performance.now() - start < durationMs) requestAnimationFrame(tick);
          else resolve(Math.round((frames / (performance.now() - start)) * 1000));
        };
        // Animate a pan+zoom so the measurement covers active tile rendering.
        map.easeTo({ center: { lat: 60.39, lng: 5.32 }, zoom: 11, duration: durationMs });
        requestAnimationFrame(tick);
      }),
  );
  console.log(`FPS during animated pan+zoom: ${fps}`);
});
