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
  await page.getByRole('button', { name: 'Import recent activities' }).click();
  await expect(page.getByRole('status')).toContainText('Imported 1; skipped 0; 0 failed.');

  await page.getByRole('button', { name: 'Close panel' }).click();
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
});
