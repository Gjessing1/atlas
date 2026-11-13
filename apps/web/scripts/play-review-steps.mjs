import { setTimeout as delay } from 'node:timers/promises';

export const SIZES = {
  'phone-small': { width: 360, height: 640 },
  phone: { width: 390, height: 844 },
  tablet: { width: 800, height: 1280 },
  desktop: { width: 1440, height: 1000 },
};
export async function runStep(page, step) {
  if (step.role) return page.getByRole(step.role, { name: step.name, exact: true }).click();
  if (step.focus) return page.getByLabel(step.focus, { exact: true }).focus();
  if (step.mapPoint) {
    const { width, height } = page.viewportSize();
    return page.locator('.maplibregl-canvas').click({
      button: 'right',
      position: { x: Math.round(width * 0.5), y: Math.round(height * 0.3) },
    });
  }
  throw new Error(`Unknown review step: ${JSON.stringify(step)}`);
}
export async function waitForMap(page) {
  await page.waitForFunction(() => Boolean(window.__atlasMap), undefined, { timeout: 30_000 });
  try {
    await page.waitForFunction(
      () => {
        const map = window.__atlasMap;
        return map.loaded() && !map.isMoving();
      },
      undefined,
      { timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  } // Report incomplete maps instead of silently claiming they settled.
}
export async function stableScreenshot(page, check) {
  const capture = () => page.screenshot({ animations: 'disabled', caret: 'hide', timeout: 15_000 });
  let png = await capture();
  let matches = 0;
  for (let i = 0; i < 12; i++) {
    check();
    await delay(700);
    const next = await capture();
    matches = next.equals(png) ? matches + 1 : 0;
    png = next;
    if (matches === 2) return { png, settled: true };
  }
  return { png, settled: false };
}
