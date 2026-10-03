import { expect, test } from '@playwright/test';
import { closePlaceEditor, waitForMap } from './helpers';

test('main search reveals nested saved folders and tracks in Collections', async ({ page }) => {
  await page.route('**/api/search**', (route) => route.fulfill({ json: { results: [] } }));
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByPlaceholder('New folder name').fill('Autumn trips');
  await page.getByPlaceholder('New folder name').press('Enter');
  await page.getByRole('button', { name: 'New folder inside Autumn trips' }).click();
  await page.getByPlaceholder('New folder name').fill('Ridge plans');
  await page.getByPlaceholder('New folder name').press('Enter');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByLabel('Import into').selectOption({ label: 'Ridge plans' });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Ridge route.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(
      '<?xml version="1.0"?><gpx version="1.1" creator="Atlas"><trk><name>Ridge route</name><trkseg><trkpt lat="59.9" lon="10.7"/><trkpt lat="59.91" lon="10.71"/></trkseg></trk></gpx>',
    ),
  });
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close panel' }).click();

  const search = page.getByPlaceholder('Search places');
  await search.fill('Ridge plans');
  await expect(page.getByRole('option', { name: /Ridge plans Saved folder/ })).toBeVisible();
  await page.getByRole('option', { name: /Ridge plans Saved folder/ }).click();
  await expect(page.locator('.sidebar .folder-row.revealed .folder-name')).toHaveText(
    'Ridge plans',
  );
  await page.getByRole('button', { name: 'Close panel' }).click();

  await search.fill('Ridge route');
  await expect(page.getByRole('option', { name: /Ridge route Saved track/ })).toBeVisible();
  await page.getByRole('option', { name: /Ridge route Saved track/ }).click();
  await expect(page.locator('.sidebar .item-row.revealed .item-name')).toHaveText('Ridge route');
  await expect(page.getByRole('button', { name: 'Collapse Autumn trips' })).toBeVisible();
});

test('a saved place can be hidden from and restored to the map', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);

  const canvas = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, {
    button: 'right',
  });
  const card = page.locator('.place-card');
  const name = (await card.locator('.place-card-titles > strong').textContent())!;
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  // Saving a coordinate-named pin opens its editor to be named; this journey is
  // about visibility, so close it and keep the coordinates as the name.
  await closePlaceEditor(page);
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
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
  await page.getByRole('tab', { name: 'Account & data', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all data' }).click();
  expect((await download).suggestedFilename()).toMatch(/^atlas-export-\d{4}-\d{2}-\d{2}\./);
});

test('the tree can be filtered by name and by a tapped tag', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);

  // A saved pin to tag, and two folders to filter between.
  const canvas = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, {
    button: 'right',
  });
  await page.locator('.place-card').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.place-edit-dialog')).toBeVisible();
  await page.locator('.place-edit-dialog').getByLabel('Name').fill('Elgpost nord');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByPlaceholder('New folder name').fill('Stands');
  await page.getByPlaceholder('New folder name').press('Enter');
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByPlaceholder('New folder name').fill('Fishing');
  await page.getByPlaceholder('New folder name').press('Enter');

  // Tag the place, so the chip has something to say.
  await page.getByRole('button', { name: 'Edit Elgpost nord' }).click();
  await page.getByLabel('Tags').fill('hunt, stand');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Filter by stand' })).toBeVisible();

  const filter = page.getByLabel('Filter collections');
  await filter.fill('stan');
  // The folder matched by name stays; the other one goes.
  await expect(page.locator('.folder-name')).toHaveText(['Stands']);

  await filter.fill('fjell');
  await expect(page.locator('.sidebar-body')).toContainText('Nothing here matches');

  // A tag chip is the same filter, written as #tag so it can be edited or cleared.
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await page.getByRole('button', { name: 'Filter by stand' }).click();
  await expect(filter).toHaveValue('#stand');
  await expect(page.locator('.item-name')).toHaveText(['Elgpost nord']);
  await expect(page.locator('.folder-name')).toHaveCount(0);
});

test('a tag already in use is offered as a pill in another place’s editor', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);

  const canvas = (await page.locator('canvas').first().boundingBox())!;
  const dialog = page.locator('.place-edit-dialog');
  const savePin = async (dx: number, name: string) => {
    await page.mouse.click(canvas.x + canvas.width / 2 + dx, canvas.y + canvas.height / 2, {
      button: 'right',
    });
    await page.locator('.place-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill(name);
    await page.keyboard.press('Tab');
  };

  // The first place writes the vocabulary by hand…
  await savePin(0, 'Elgpost nord');
  await dialog.getByLabel('Tags').fill('Stand, family');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // …and the second files into it with a tap, in the spelling already stored.
  await savePin(160, 'Elgpost sør');
  const pill = dialog.getByRole('button', { name: 'Stand', exact: true });
  await expect(pill).toHaveAttribute('aria-pressed', 'false');
  await pill.click();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByLabel('Tags')).toHaveValue('Stand');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByLabel('Filter collections').fill('#stand');
  await expect(page.locator('.item-name')).toHaveCount(2);
  await expect(page.locator('.item-name', { hasText: 'Elgpost sør' })).toBeVisible();
});

test('only one panel is open at a time', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);

  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeVisible();

  // Settings used to leave Collections up (and Collections used to leave
  // Settings up): both panels are anchored to the same corners, so at phone
  // width the two overlapped.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.settings-panel')).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);

  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.settings-panel')).toHaveCount(0);

  // And the same button closes what it opened.
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCount(0);
});

test('a folder or a tag can label its pins on the map', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);

  const canvas = (await page.locator('canvas').first().boundingBox())!;
  const dialog = page.locator('.place-edit-dialog');
  const savePin = async (dx: number, name: string, tags = '') => {
    await page.mouse.click(canvas.x + canvas.width / 2 + dx, canvas.y + canvas.height / 2, {
      button: 'right',
    });
    await page.locator('.place-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill(name);
    if (tags) await dialog.getByLabel('Tags').fill(tags);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  };
  // The names the label source currently carries, or null while it is absent.
  const labelled = () =>
    page.evaluate(() => {
      const map = window.__atlasMap!;
      const source = map.getSource('atlas-pin-labels') as
        { serialize: () => { data: GeoJSON.FeatureCollection } } | undefined;
      if (!source || !map.getLayer('atlas-pin-labels')) return null;
      return source
        .serialize()
        .data.features.map((f) => String(f.properties?.['name']))
        .sort();
    });

  await savePin(-120, 'Mormor');
  await savePin(120, 'Elgpost nord', 'stand');
  expect(await labelled()).toBeNull();

  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByPlaceholder('New folder name').fill('Family');
  await page.getByPlaceholder('New folder name').press('Enter');
  await page.getByRole('button', { name: 'Edit Mormor' }).click();
  // Filed into the (collapsed) folder, the row and its editor leave the root.
  await page.getByRole('combobox', { name: /^Folder/ }).selectOption({ label: 'Family' });

  // The folder's switch names its pins, and only them.
  const folderSwitch = page.getByRole('button', { name: 'Names of Family on the map' });
  await expect(folderSwitch).toHaveAttribute('aria-pressed', 'false');
  await folderSwitch.click();
  await expect(folderSwitch).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(labelled).toEqual(['Mormor']);

  // A whole #tag in the filter offers the same switch for that tag.
  const filter = page.getByLabel('Filter collections');
  await filter.fill('#sta');
  await expect(page.getByRole('button', { name: /^Names of #/ })).toHaveCount(0);
  await filter.fill('#Stand');
  await page.getByRole('button', { name: 'Names of #stand on the map' }).click();
  await expect.poll(labelled).toEqual(['Elgpost nord', 'Mormor']);

  // A hidden folder takes its names with it; switching both off removes the layer.
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await page.getByRole('button', { name: 'Hide collection Family from map' }).click();
  await expect.poll(labelled).toEqual(['Elgpost nord']);
  await folderSwitch.click();
  await filter.fill('#stand');
  await page.getByRole('button', { name: 'Names of #stand on the map' }).click();
  await expect.poll(labelled).toBeNull();
});
