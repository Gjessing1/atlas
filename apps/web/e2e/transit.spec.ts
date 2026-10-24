import { expect, test } from '@playwright/test';
import { waitForMap } from './helpers';

test('a place card opens a live next-hour departure board', async ({ page }) => {
  let requested: URL | null = null;
  const now = Date.now();
  await page.route('**/api/transit/departures**', (route) => {
    requested = new URL(route.request().url());
    route.fulfill({
      json: {
        stop: {
          id: 'NSR:StopPlace:59872',
          name: 'Asker stasjon',
          position: { lat: 59.8337, lng: 10.4348 },
          distanceM: 120,
        },
        departures: [
          {
            id: 'r14',
            mode: 'rail',
            aimedDepartureMs: now,
            expectedDepartureMs: now + 180_000,
            realtime: true,
            cancelled: false,
            destination: 'Kongsvinger',
            line: { publicCode: 'R14', operator: 'Vy' },
            quay: { publicCode: '2' },
            situations: [],
          },
        ],
      },
    });
  });

  await page.goto('/#map=14/59.8337/10.4348&pin=59.8337/10.4348');
  await waitForMap(page);
  await page.locator('.place-marker').click();
  await page.getByRole('button', { name: 'Departures' }).click();

  const board = page.locator('.stop-departures');
  await expect(board).toContainText('Asker stasjon');
  await expect(board).toContainText('R14');
  await expect(board).toContainText('Kongsvinger');
  await expect(board).toContainText(/Live timetable, checked \d\d:\d\d\./);
  await expect(board).not.toContainText('needs a connection');
  await expect(page.getByRole('button', { name: 'Departures' }).locator('svg')).toBeVisible();
  expect(requested?.searchParams.get('lat')).toBe('59.8337');
  expect(requested?.searchParams.get('lon')).toBe('10.4348');
});
