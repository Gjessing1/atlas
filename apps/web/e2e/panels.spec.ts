import { expect, test, type Page } from '@playwright/test';
import { cameraState, project, waitForMap } from './helpers';

/** Drop a pin with a right-click at a screen point; returns where it landed. */
async function dropPinAt(page: Page, x: number, y: number): Promise<{ lat: number; lng: number }> {
  const at = await page.evaluate(([px, py]) => window.__atlasMap!.unproject([px!, py!]), [x, y]);
  await page.locator('.maplibregl-canvas').click({ button: 'right', position: { x, y } });
  await expect(page.locator('.place-card')).toBeVisible();
  return { lat: at.lat, lng: at.lng };
}

test('Escape closes a quick switcher first, then the drawer behind it', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);

  // Collections opens on the left, clear of the control column on the right.
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toBeVisible();

  await page.getByRole('button', { name: /^Map profile/ }).click();
  const menu = page.getByRole('radiogroup', { name: 'Map profile' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(sidebar).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(sidebar).toHaveCount(0);

  // Settings closes the same way, and at desktop width its categories are a
  // vertical list beside the page.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('.settings-panel');
  await expect(settings.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  await expect(settings.getByRole('tabpanel')).toContainText('Theme');
  await settings.getByRole('tab', { name: 'Navigation' }).click();
  await expect(settings.getByRole('tabpanel')).toContainText('Public transport');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
});

test('the profile switcher opens on the current profile and picks by keyboard', async ({
  page,
}) => {
  await page.goto('/');
  await waitForMap(page);

  const trigger = page.getByRole('button', { name: /^Map profile/ });
  await expect(trigger).toHaveAttribute('aria-label', 'Map profile: Explore');
  await trigger.click();
  await expect(page.getByRole('radio', { name: 'Explore' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: 'Drive' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('radiogroup', { name: 'Map profile' })).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-label', 'Map profile: Drive');
  await expect(trigger).toBeFocused();
});

test('opening a drawer moves the map only when it would cover the selected place', async ({
  page,
}) => {
  await page.goto('/');
  await waitForMap(page);
  const viewport = page.viewportSize()!;

  // A pin well clear of the right-hand drawer: Settings leaves the map alone.
  const clear = await dropPinAt(page, 200, viewport.height / 2 - 80);
  const before = await cameraState(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('.settings-panel');
  await expect(settings).toBeVisible();
  await page.waitForTimeout(400);
  expect(await cameraState(page)).toEqual(before);
  expect((await project(page, clear.lat, clear.lng))[0]).toBeCloseTo(200, 0);
  await settings.getByRole('button', { name: 'Close panel' }).click();

  // A pin where the drawer opens: it is panned into the map still in view.
  const covered = await dropPinAt(page, viewport.width - 200, viewport.height / 2 - 80);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings).toBeVisible();
  const drawerLeft = (await settings.boundingBox())!.x;
  await expect
    .poll(async () => (await project(page, covered.lat, covered.lng))[0])
    .toBeLessThan(drawerLeft - 40);
});
