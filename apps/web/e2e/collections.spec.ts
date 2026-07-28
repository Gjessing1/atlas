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
  // Saving a coordinate-named pin opens its editor to be named; this journey is
  // about visibility, so close it and keep the coordinates as the name.
  await expect(page.locator('.place-edit-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.getByRole('button', { name: '★ Edit' })).toBeVisible();
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

test('a subfolder can be created inside a collapsed folder, and deletes are confirmed', async ({
  page,
}) => {
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();

  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByPlaceholder('New folder name').fill('Trips');
  await page.getByPlaceholder('New folder name').press('Enter');

  // Folders start collapsed, so the chevron offers to expand, not to collapse.
  await expect(page.getByRole('button', { name: 'Expand Trips' })).toBeVisible();
  // Being collapsed must not make "+" a dead button: it re-expands and shows
  // the field rather than rendering it into a hidden subtree.
  await page.getByRole('button', { name: 'New folder inside Trips' }).click();
  await page.getByPlaceholder('New folder name').fill('Autumn');
  await page.getByPlaceholder('New folder name').press('Enter');

  const trips = page.locator('.folder-row').filter({
    has: page.locator(':scope > .item-line > .folder-name', { hasText: /^Trips$/ }),
  });
  await expect(trips.locator(':scope > .item-list .folder-name')).toHaveText('Autumn');

  // Delete asks first — cancelling keeps the folder.
  await page.getByRole('button', { name: 'Delete Autumn' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(trips.locator(':scope > .item-list .folder-name')).toHaveText('Autumn');

  await page.getByRole('button', { name: 'Delete Autumn' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete folder' }).click();
  await expect(trips.locator(':scope > .item-list .folder-name')).toHaveCount(0);
  await expect(page.locator('.undo-toast')).toBeVisible();
});

test('a folder can be dragged into another folder', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();

  for (const name of ['Alpha', 'Beta']) {
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByPlaceholder('New folder name').fill(name);
    await page.getByPlaceholder('New folder name').press('Enter');
  }

  const row = (name: string) =>
    page.locator('.folder-row').filter({
      has: page.locator(':scope > .item-line > .folder-name', { hasText: new RegExp(`^${name}$`) }),
    });

  // The middle of a folder row means "drop inside"; the edges reorder.
  const target = row('Alpha').locator(':scope > .item-line');
  const box = (await target.boundingBox())!;
  await row('Beta')
    .locator(':scope > .item-line')
    .dragTo(target, { targetPosition: { x: box.width / 2, y: box.height / 2 } });

  // Alpha is collapsed like every folder, so open it to see what landed inside.
  // Clicking the name is the whole target, not just the chevron.
  await row('Alpha').locator(':scope > .item-line > .folder-name').click();
  await expect(row('Alpha').locator(':scope > .item-list .folder-name')).toHaveText('Beta');
});

test('a saved place goes straight from its row to the planner, and Export all has two homes', async ({
  page,
}) => {
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);

  // Save the pin so there is a collection row to act on. The editor opens on a
  // coordinate-named pin to be named; fields auto-save on blur, so Tab commits.
  await page.locator('.place-marker').click();
  const card = page.locator('.place-card');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.place-edit-dialog')).toBeVisible();
  await page.locator('.place-edit-dialog').getByLabel('Name').fill('Cabin');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.locator('.place-edit-dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  // Go is the whole trip: no place card in between, and the panel steps aside
  // for the planner it just opened.
  await page.getByRole('button', { name: 'Directions to Cabin' }).click();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.locator('.route-panel')).toBeVisible();

  // "Export all" lives on the Collections header (web) *and* under Settings →
  // Account (where Android keeps it) — same action, both homes.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all data' }).click();
  expect((await download).suggestedFilename()).toMatch(/^atlas-export-\d{4}-\d{2}-\d{2}\./);
});
