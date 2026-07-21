import { expect, test } from '@playwright/test';
import { waitForMap } from './helpers';

test('a saved place can be hidden from and restored to the map', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);

  const canvas = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, {
    button: 'right',
  });
  const card = page.locator('.place-card');
  const name = (await card.locator('strong').textContent())!;
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByRole('button', { name: '★ Saved' })).toBeVisible();
  await card.getByRole('button', { name: 'Remove pin' }).click();
  await expect(page.locator('.place-marker')).toHaveCount(1);

  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: `Hide ${name} from map` }).click();
  await expect(page.locator('.place-marker')).toHaveCount(0);
  await page.getByRole('button', { name: `Show ${name} on map` }).click();
  await expect(page.locator('.place-marker')).toHaveCount(1);
});

test('a nested collection can move up to the root', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();

  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByPlaceholder('New folder name').fill('Parent');
  await page.getByPlaceholder('New folder name').press('Enter');
  await page.getByRole('button', { name: 'New folder inside Parent' }).click();
  await page.getByPlaceholder('New folder name').fill('Child');
  await page.getByPlaceholder('New folder name').press('Enter');

  const parent = page.locator('.folder-row').filter({
    has: page.locator(':scope > .item-line > .folder-name', { hasText: /^Parent$/ }),
  });
  await expect(parent.locator(':scope > .item-list .folder-name')).toHaveText('Child');

  await page.getByRole('button', { name: 'Move Child up one level' }).click();
  await expect(parent.locator(':scope > .item-list .folder-name')).toHaveCount(0);
  await expect(
    page.locator('.sidebar-body > .item-list > .folder-row > .item-line > .folder-name'),
  ).toHaveText(['Parent', 'Child']);
});
