import { expect, test } from '@playwright/test';
import { mockRouting, openRoutePlannerAt, project, waitForMap } from './helpers';

test('connects Garmin, imports a GPS activity and sends a planned course', async ({ page }) => {
  const gpx =
    '<gpx><trk><name>Morning run</name><trkseg><trkpt lat="59.9" lon="10.7"/><trkpt lat="59.91" lon="10.71"/></trkseg></trk></gpx>';
  let connected = false;
  let sent: { name?: string; profile?: string; gpx?: string; deviceId?: string } | null = null;
  await page.route('**/api/garmin/status', (route) => route.fulfill({ json: { connected } }));
  await page.route('**/api/garmin/connect', async (route) => {
    expect(route.request().headers()['authorization']).toMatch(/^Bearer /);
    connected = true;
    await route.fulfill({ json: { connected: true, mfaRequired: false } });
  });
  await page.route('**/api/garmin/devices', (route) =>
    route.fulfill({ json: { devices: [{ id: '456', name: 'Forerunner' }] } }),
  );
  await page.route('**/api/garmin/activities?*', (route) =>
    route.fulfill({
      json: {
        activities: [
          { id: '123', name: 'Morning run', date: '2026-10-01', type: 'running', hasRoute: true },
        ],
      },
    }),
  );
  await page.route('**/api/garmin/activities/123/gpx', (route) => route.fulfill({ json: { gpx } }));
  await page.route('**/api/garmin/courses', (route) => route.fulfill({ json: { courses: [] } }));
  await page.route('**/api/garmin/course', async (route) => {
    sent = route.request().postDataJSON() as typeof sent;
    await route.fulfill({
      json: { id: 42, url: 'https://connect.garmin.com/modern/course/42', queued: true },
    });
  });
  await mockRouting(page);
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Account & data' }).click();
  const create = page.getByRole('button', { name: 'Create account' });
  await expect(create).toBeEnabled();
  await page.getByPlaceholder('email', { exact: true }).fill(`garmin-${Date.now()}@example.com`);
  await page.getByPlaceholder('password', { exact: true }).fill('secret-password');
  await create.click();
  await page.getByLabel('Garmin email').fill('runner@example.com');
  await page.getByLabel('Garmin password').fill('garmin-secret');
  await page.getByRole('button', { name: 'Connect Garmin' }).click();
  await expect(page.getByText('Connected to Garmin Connect.')).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Collections' }).click();
  const library = page.getByRole('complementary', { name: 'Collections' });
  await library.getByRole('tab', { name: 'Garmin' }).click();
  await library.getByRole('button', { name: 'Import recent' }).click();
  await expect(library.getByRole('button', { name: 'Morning run', exact: true })).toBeVisible();
  await library.getByRole('tab', { name: 'Activities' }).click();
  await library.getByRole('combobox', { name: 'Library sport' }).selectOption('Running');
  await library.getByRole('combobox', { name: 'Activity year' }).selectOption('2026');
  await expect(library.getByRole('button', { name: 'Morning run', exact: true })).toBeVisible();
  await library.getByRole('button', { name: 'Show matching tracks only on map' }).click();
  await library.getByRole('button', { name: 'Close panel' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window
            .__atlasMap!.getStyle()
            .layers?.find(
              (layer) => layer.id.startsWith('atlas-track-') && layer.id.endsWith('-line'),
            )?.id,
      ),
    )
    .toBeTruthy();
  const lineId = await page.evaluate(
    () =>
      window
        .__atlasMap!.getStyle()
        .layers!.find((layer) => layer.id.startsWith('atlas-track-') && layer.id.endsWith('-line'))!
        .id,
  );
  const mapColor = () =>
    page.evaluate((id) => window.__atlasMap!.getPaintProperty(id, 'line-color'), lineId);
  expect(await mapColor()).toBe('#2a78d6');
  const [trackX, trackY] = await project(page, 59.905, 10.705);
  await expect
    .poll(() =>
      page.evaluate(
        ([x, y, id]) =>
          window.__atlasMap!.queryRenderedFeatures([x!, y!], { layers: [id!] }).length,
        [trackX, trackY, lineId] as const,
      ),
    )
    .toBeGreaterThan(0);
  await page.mouse.click(trackX, trackY);
  const profile = page.locator('.elevation-panel');
  await expect(profile).toContainText('Morning run');
  await expect(profile).toContainText('Activity: Running');
  await expect(profile).toContainText(/Total distance: 1\.\d km/);
  await expect.poll(mapColor).toBe('#a855f7');
  await profile.getByRole('button', { name: 'Close profile' }).click();
  await expect.poll(mapColor).toBe('#2a78d6');

  await openRoutePlannerAt(page, 59.905, 10.74);
  const [x, y] = await project(page, 59.915, 10.76);
  await page.mouse.click(x, y);
  await expect(page.locator('.route-stats')).toBeVisible();
  await page.getByRole('button', { name: 'Run' }).click();
  const planner = page.locator('.route-panel');
  await planner.getByRole('button', { name: 'More route actions' }).click();
  await planner.getByRole('button', { name: 'Send to Garmin' }).click();
  await planner.getByLabel('Garmin course name').fill('Forest run');
  await planner.getByRole('combobox', { name: 'Device' }).selectOption('456');
  await planner.getByRole('button', { name: 'Send course' }).click();
  await expect(planner.getByText(/queued for/i)).toBeVisible();
  await expect(
    planner.getByRole('link', { name: 'Open course in Garmin Connect' }),
  ).toHaveAttribute('href', 'https://connect.garmin.com/modern/course/42');
  expect(sent).toMatchObject({ name: 'Forest run', profile: 'run', deviceId: '456' });
  expect(sent?.gpx).toContain('<trk>');

  await page.getByRole('button', { name: 'Collections' }).click();
  await library.getByRole('tab', { name: 'Garmin' }).click();
  await library.locator('input[accept=".gpx,.kml,.kmz"]').setInputFiles({
    name: 'explore.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from('<gpx><wpt lat="59.92" lon="10.76"><name>Watch camp</name></wpt></gpx>'),
  });
  await expect(library.getByRole('button', { name: 'Watch camp', exact: true })).toBeVisible();
});

test('manages Garmin courses: filter, save to Atlas, rename, sport, send and delete', async ({
  page,
}) => {
  const gpx =
    '<gpx><trk><name>18k</name><trkseg><trkpt lat="59.9" lon="10.7"/><trkpt lat="59.91" lon="10.71"/></trkseg></trk></gpx>';
  const edits: unknown[] = [];
  const deleted: string[] = [];
  let sentTo: unknown = null;
  await page.route('**/api/garmin/status', (route) => route.fulfill({ json: { connected: true } }));
  await page.route('**/api/garmin/devices', (route) =>
    route.fulfill({ json: { devices: [{ id: '456', name: 'Forerunner' }] } }),
  );
  await page.route('**/api/garmin/courses', (route) =>
    route.fulfill({
      json: {
        courses: [
          {
            id: '7',
            name: '18k Jørgen',
            type: 'trail_running',
            distanceM: 18028,
            ascentM: 536,
            updated: Date.UTC(2026, 6, 5),
          },
          {
            id: '8',
            name: 'Lake loop',
            type: 'skating_ws',
            distanceM: 4200,
            ascentM: 0,
            updated: Date.UTC(2026, 1, 2),
          },
        ],
      },
    }),
  );
  await page.route('**/api/garmin/courses/7/gpx', (route) => route.fulfill({ json: { gpx } }));
  await page.route('**/api/garmin/courses/7/send', async (route) => {
    sentTo = route.request().postDataJSON();
    await route.fulfill({ json: { queued: true } });
  });
  await page.route(/\/api\/garmin\/courses\/\d+$/, async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      edits.push(request.postDataJSON());
      return route.fulfill({ json: { updated: true } });
    }
    expect(request.method()).toBe('DELETE');
    deleted.push(request.url().split('/').pop()!);
    return route.fulfill({ json: { deleted: true } });
  });
  await page.goto('/#map=12/59.91/10.75');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Account & data' }).click();
  const create = page.getByRole('button', { name: 'Create account' });
  await expect(create).toBeEnabled();
  await page.getByPlaceholder('email', { exact: true }).fill(`courses-${Date.now()}@example.com`);
  await page.getByPlaceholder('password', { exact: true }).fill('secret-password');
  await create.click();

  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Collections' }).click();
  const library = page.getByRole('complementary', { name: 'Collections' });
  await library.getByRole('tab', { name: 'Garmin' }).click();
  const courses = page.locator('.garmin-courses');
  await expect(courses.getByRole('heading', { name: 'Courses · 2' })).toBeVisible();
  await expect(courses).toContainText('Trail running · 18.0 km · ↗ 536 m');
  await courses.getByRole('radio', { name: /Skating/ }).click();
  await expect(courses.getByRole('button', { name: /18k Jørgen/ })).toHaveCount(0);
  await expect(courses.getByRole('button', { name: /Lake loop/ })).toBeVisible();
  await courses.getByRole('radio', { name: /All/ }).click();

  // Save & show files the copy under Garmin courses › Running, shows it there and draws it.
  await courses.getByRole('button', { name: /18k Jørgen/ }).click();
  await courses.getByRole('button', { name: 'Save & show on map' }).click();
  await expect(library).toContainText('Garmin courses');
  await expect(library).toContainText('Running');
  await expect(library.getByText('18k Jørgen')).toBeVisible();

  await library.getByRole('tab', { name: 'Garmin' }).click();
  const row = courses.getByRole('button', { name: /18k Jørgen/ });
  await expect(row).toContainText('In Atlas');
  await row.click();
  await expect(courses.getByRole('button', { name: 'Show on map' })).toBeVisible();

  await courses.getByRole('textbox', { name: 'Name' }).fill('Ridge 18k');
  await courses.getByRole('button', { name: 'Rename' }).click();
  await expect(courses.getByRole('status')).toHaveText('Renamed to “Ridge 18k” in Garmin Connect.');
  await courses.getByRole('combobox', { name: 'Course sport' }).selectOption('hiking');
  await expect(courses.getByRole('status')).toHaveText('Sport changed in Garmin Connect.');
  await expect(courses.getByRole('button', { name: /Ridge 18k/ })).toContainText('Hiking');
  expect(edits).toEqual([{ name: 'Ridge 18k' }, { sport: 'hiking' }]);

  await courses.getByRole('button', { name: 'Send to Forerunner' }).click();
  await expect(courses.getByRole('status')).toHaveText(
    'Queued for Forerunner. It arrives on the next sync with Garmin Connect.',
  );
  expect(sentTo).toEqual({ deviceId: '456' });

  await courses.getByRole('button', { name: 'Delete…' }).click();
  const confirm = courses.getByRole('alertdialog', { name: 'Delete course' });
  await expect(confirm).toContainText('Your copy in Atlas stays.');
  await confirm.getByRole('button', { name: 'Keep' }).click();
  expect(deleted).toEqual([]);
  await courses.getByRole('button', { name: 'Delete…' }).click();
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(courses.getByRole('status')).toHaveText('Deleted “Ridge 18k” from Garmin Connect.');
  await expect(courses.getByRole('button', { name: /Ridge 18k/ })).toHaveCount(0);
  expect(deleted).toEqual(['7']);
});
