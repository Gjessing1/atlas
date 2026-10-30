import { expect, test, type Page } from '@playwright/test';
import { closePlaceEditor, waitForMap } from './helpers';

async function collectionAction(page: Page, title: string, label: string) {
  await page.getByRole('button', { name: `More actions for ${title}`, exact: true }).click();
  await page.getByRole('button', { name: label, exact: true }).click();
}

test('main search reveals nested saved folders and tracks in Collections', async ({ page }) => {
  await page.route('**/api/search**', (route) => route.fulfill({ json: { results: [] } }));
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await collectionAction(page, 'Collections', 'New folder');
  await page.getByPlaceholder('New folder name').fill('Autumn trips');
  await page.getByPlaceholder('New folder name').press('Enter');
  await collectionAction(page, 'Autumn trips', 'New folder inside Autumn trips');
  await page.getByPlaceholder('New folder name').fill('Ridge plans');
  await page.getByPlaceholder('New folder name').press('Enter');
  await collectionAction(page, 'Collections', 'Import');
  await page.getByLabel('Import into').selectOption({ label: 'Ridge plans' });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Ridge route.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(
      '<?xml version="1.0"?><gpx version="1.1" creator="Atlas"><trk><name>Ridge route</name><trkseg><trkpt lat="59.9" lon="10.7"/><trkpt lat="59.91" lon="10.71"/></trkseg></trk></gpx>',
    ),
  });
  await expect(page.getByRole('button', { name: 'Close profile' })).toBeVisible();
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
  await expect(page.locator('.sidebar .item-row.revealed .item-name')).toContainText('Ridge route');
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

  await collectionAction(page, 'Collections', 'New folder');
  await page.getByPlaceholder('New folder name').fill('Parent');
  await page.getByPlaceholder('New folder name').press('Enter');
  await collectionAction(page, 'Parent', 'New folder inside Parent');
  await page.getByPlaceholder('New folder name').fill('Child');
  await page.getByPlaceholder('New folder name').press('Enter');

  const parent = page.locator('.folder-row').filter({
    has: page.locator(':scope > .item-line > .folder-name', { hasText: /^Parent$/ }),
  });
  await expect(parent.locator(':scope > .item-list .folder-name')).toHaveText('Child');

  await collectionAction(page, 'Child', 'Move Child up one level');
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

  await collectionAction(page, 'Collections', 'New folder');
  await page.getByPlaceholder('New folder name').fill('Trips');
  await page.getByPlaceholder('New folder name').press('Enter');

  // Folders start collapsed, so the chevron offers to expand, not to collapse.
  await expect(page.getByRole('button', { name: 'Expand Trips' })).toBeVisible();
  // Being collapsed must not make "+" a dead button: it re-expands and shows
  // the field rather than rendering it into a hidden subtree.
  await collectionAction(page, 'Trips', 'New folder inside Trips');
  await page.getByPlaceholder('New folder name').fill('Autumn');
  await page.getByPlaceholder('New folder name').press('Enter');

  const trips = page.locator('.folder-row').filter({
    has: page.locator(':scope > .item-line > .folder-name', { hasText: /^Trips$/ }),
  });
  await expect(trips.locator(':scope > .item-list .folder-name')).toHaveText('Autumn');

  // Delete asks first — cancelling keeps the folder.
  await collectionAction(page, 'Autumn', 'Delete Autumn');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(trips.locator(':scope > .item-list .folder-name')).toHaveText('Autumn');

  await collectionAction(page, 'Autumn', 'Delete Autumn');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete folder' }).click();
  await expect(trips.locator(':scope > .item-list .folder-name')).toHaveCount(0);
  await expect(page.locator('.undo-toast')).toBeVisible();
});

test('a folder can be dragged into another folder', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();

  for (const name of ['Alpha', 'Beta']) {
    await collectionAction(page, 'Collections', 'New folder');
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
  await collectionAction(page, 'Collections', 'New folder');
  await page.getByPlaceholder('New folder name').fill('Stands');
  await page.getByPlaceholder('New folder name').press('Enter');
  await collectionAction(page, 'Collections', 'New folder');
  await page.getByPlaceholder('New folder name').fill('Fishing');
  await page.getByPlaceholder('New folder name').press('Enter');

  // Tag the place, so the chip has something to say.
  await collectionAction(page, 'Elgpost nord', 'Edit Elgpost nord');
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
  await expect(page.locator('.item-name')).toHaveText([/Elgpost nord/]);
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
  await collectionAction(page, 'Collections', 'New folder');
  await page.getByPlaceholder('New folder name').fill('Family');
  await page.getByPlaceholder('New folder name').press('Enter');
  await collectionAction(page, 'Mormor', 'Edit Mormor');
  // Filed into the (collapsed) folder, the row and its editor leave the root.
  await page.getByRole('combobox', { name: /^Folder/ }).selectOption({ label: 'Family' });

  // The folder's switch names its pins, and only them.
  const folderSwitch = page.getByRole('button', { name: 'Names of Family on the map' });
  await page.getByRole('button', { name: 'More actions for Family', exact: true }).click();
  await expect(folderSwitch).toHaveAttribute('aria-pressed', 'false');
  await folderSwitch.click();
  await page.getByRole('button', { name: 'More actions for Family', exact: true }).click();
  await expect(folderSwitch).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
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
  await collectionAction(page, 'Family', 'Hide collection Family from map');
  await expect.poll(labelled).toEqual(['Elgpost nord']);
  await collectionAction(page, 'Family', 'Names of Family on the map');
  await filter.fill('#stand');
  await page.getByRole('button', { name: 'Names of #stand on the map' }).click();
  await expect.poll(labelled).toBeNull();
});

test('Places offers Quick access, human context, sorting, and clear inherited visibility', async ({
  page,
}) => {
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  const library = page.locator('.sidebar');
  await expect(library.getByRole('tab')).toHaveText(['Places', 'Routes', 'Activities']);
  await expect(library.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
  await collectionAction(page, 'Collections', 'Import');
  const common = { visible: true, createdAt: 1, updatedAt: 1 };
  const places = [
    {
      ...common,
      id: 'home',
      name: 'Home with a long and recognizable place name',
      lat: 59.9149,
      lng: 10.7153,
      collectionId: 'family',
      notes: '',
      address: 'Oslo',
      tags: [],
      icon: '⌂',
      color: '#ff0000',
      sortIndex: 0,
    },
    {
      ...common,
      id: 'work',
      name: 'Work',
      lat: 59.92,
      lng: 10.72,
      collectionId: null,
      notes: 'Office',
      address: '',
      tags: [],
      icon: '●',
      color: '#ff0000',
      sortIndex: 1,
      createdAt: 2,
    },
  ];
  await library.locator('input[accept=".gpx,.kml,.kmz,.json,.zip"]').setInputFiles({
    name: 'library.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        exportedAt: 10,
        collections: [
          {
            ...common,
            id: 'family',
            name: 'Family',
            parentId: null,
            visible: false,
            sortIndex: 0,
          },
        ],
        places,
        tracks: [],
        settings: {},
      }),
    ),
  });
  await expect(library).toContainText('Restored');
  await library.getByRole('button', { name: 'All places', exact: true }).click();
  const rows = library.locator('.sidebar-body > .item-list .item-name');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Home');
  await expect(rows.first()).toContainText('Family · Oslo');
  await expect(rows.first()).toContainText('Hidden by Family');
  await expect(rows.first()).toHaveAccessibleDescription(/Hidden by Family/);
  await expect(rows.first()).toHaveCSS('opacity', '1');
  await expect(library.locator('.sidebar-body')).not.toContainText('59.9149');
  await library.getByLabel('Sort places').selectOption('recent');
  await expect(rows.first()).toContainText('Work');
  await collectionAction(
    page,
    'Home with a long and recognizable place name',
    'Pin to Quick access',
  );
  await expect(library.locator('.quick-access')).toContainText(
    'Home with a long and recognizable place name',
  );
  await page.reload();
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(page.locator('.quick-access')).toContainText(
    'Home with a long and recognizable place name',
  );
  await page.getByLabel('Filter collections').fill('Family');
  await expect(page.locator('.folder-name')).toHaveText(['Family']);
  await expect(page.locator('.item-name')).toHaveCount(1);
  await page.getByRole('button', { name: 'Family', exact: true }).click();
  await expect(page.getByLabel('Filter collections')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Collapse Family' })).toBeVisible();
});

test('empty Routes hides search and offers useful actions', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('tab', { name: 'Routes', exact: true }).click();
  await expect(page.getByLabel('Filter collections')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import GPX / KML' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to map to plan a route' }).click();
  await expect(page.locator('.sidebar')).toHaveCount(0);
});

test('large libraries page their lists without changing map visibility', async ({ page }) => {
  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await collectionAction(page, 'Collections', 'Import');
  const common = {
    visible: false,
    createdAt: 1,
    updatedAt: 1,
    notes: '',
    tags: [],
    collectionId: 'guide',
  };
  const places = Array.from({ length: 780 }, (_, index) => ({
    ...common,
    id: `guide-${index}`,
    name: `Stop ${String(index).padStart(3, '0')}`,
    lat: 59.9,
    lng: 10.7,
    address: 'Norway',
    icon: '●',
    color: '#ff0000',
    sortIndex: index,
  }));
  const tracks = Array.from({ length: 225 }, (_, index) => ({
    ...common,
    id: `activity-${index}`,
    name: `Activity ${String(index).padStart(3, '0')}`,
    notes: `Recorded ${2022 + (index % 4)}-01-01`,
    tags: [`garmin:${index}`, 'cycling'],
    stats: { distanceM: 1000 + index },
    area: null,
    gpx: '<gpx><trk><trkseg><trkpt lat="59.9" lon="10.7"/><trkpt lat="59.91" lon="10.71"/></trkseg></trk></gpx>',
  }));
  await page.locator('input[accept=".gpx,.kml,.kmz,.json,.zip"]').setInputFiles({
    name: 'large-library.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        exportedAt: 10,
        collections: [
          { ...common, id: 'guide', name: 'Bobilguiden', parentId: null, sortIndex: 0 },
        ],
        places,
        tracks,
        settings: {},
      }),
    ),
  });
  const library = page.locator('.sidebar');
  await expect(library).toContainText('780 places');
  await library.getByRole('button', { name: 'All places', exact: true }).click();
  await expect(library.locator('.item-row')).toHaveCount(40);
  await library.getByRole('button', { name: 'Show more places (740 remaining)' }).click();
  await expect(library.locator('.item-row')).toHaveCount(80);
  await library.getByLabel('Filter collections').fill('Activity');
  await expect(library.locator('.item-row')).toHaveCount(0);
  await library.getByRole('button', { name: 'Clear filter' }).click();
  await library.getByRole('tab', { name: 'Activities', exact: true }).click();
  await expect(library.locator('.item-row')).toHaveCount(30);
  await library.getByRole('button', { name: 'Show more (195 remaining)' }).click();
  await expect(library.locator('.item-row')).toHaveCount(60);
  await library.getByLabel('Sort tracks').selectOption('oldest');
  await expect(library.locator('.item-name').first()).toContainText('Activity 000');
  await expect(page.locator('.place-marker')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/collections-mobile.png' });
});
