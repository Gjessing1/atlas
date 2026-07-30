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
  expect(requested?.searchParams.get('lat')).toBe('59.8337');
  expect(requested?.searchParams.get('lon')).toBe('10.4348');
});

test('saved commute uses favorite endpoints, Asker via, and exact filters', async ({ page }) => {
  // Longest journey in the suite: a backup import, a reload to re-read the
  // synced setting, then a board that only settles once OPFS is warm. 120 s was
  // enough on an idle host and ran out mid-test on a loaded one — each run
  // reached a later line, which is a clock problem, not a broken control.
  test.setTimeout(300_000);
  const now = Date.now();
  let requested: Record<string, unknown> | null = null;
  const journey = {
    startMs: now + 300_000,
    endMs: now + 2_100_000,
    durationMs: 1_800_000,
    walkDistanceM: 300,
    legs: [
      {
        mode: 'bus',
        line: { publicCode: '280' },
        situations: [],
      },
      {
        mode: 'rail',
        line: { publicCode: 'R14' },
        situations: [],
      },
    ],
  };
  await page.route('**/api/transit/commute', (route) => {
    requested = route.request().postDataJSON() as Record<string, unknown>;
    route.fulfill({
      json: {
        outbound: { trips: [journey], problems: [] },
        inbound: { trips: [{ ...journey, startMs: now + 3_600_000 }], problems: [] },
      },
    });
  });

  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  const importButton = page.getByRole('button', { name: 'Import', exact: true });
  // OPFS worker startup can lag the already-rendered map under SwiftShader.
  await expect(importButton).toBeEnabled({ timeout: 90_000 });
  await importButton.click();
  const created = now - 10_000;
  const record = (id: string, name: string, lat: number, lng: number) => ({
    id,
    name,
    lat,
    lng,
    address: '',
    collectionId: null,
    notes: '',
    tags: [],
    icon: 'star',
    color: '#4f91ef',
    visible: true,
    sortIndex: 0,
    createdAt: created,
    updatedAt: created,
  });
  const backup = {
    exportedAt: now,
    collections: [],
    places: [
      record('engelsrud', 'Engelsrud', 59.82, 10.42),
      record('asker', 'Asker', 59.8337, 10.4348),
      record('national', 'Nationaltheatret', 59.9147, 10.7333),
    ],
    tracks: [],
    settings: {},
  };
  await page.locator('.sidebar input[type=file]').setInputFiles({
    name: 'commute.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator('.sidebar-notice')).toContainText('Restored');

  // Reload reads the imported synced setting exactly as another signed-in
  // device would after sync, while retaining this context's OPFS database.
  await page.reload();
  await waitForMap(page);
  await page.getByRole('button', { name: 'Commute', exact: true }).click();

  const panel = page.locator('.commute-panel');
  const from = panel.getByLabel('From');
  await expect(from).toBeEnabled({ timeout: 90_000 });
  await from.selectOption('engelsrud');
  await panel.getByLabel('Via').selectOption('asker');
  await panel.getByLabel('To').selectOption('national');
  await expect(panel.getByLabel('From')).toHaveValue('engelsrud');
  await expect(panel.getByLabel('Via')).toHaveValue('asker');
  await expect(panel.getByLabel('To')).toHaveValue('national');
  await expect(panel).toContainText('280');
  await expect(panel).toContainText('R14');
  await expect
    .poll(() => requested)
    .toMatchObject({
      from: { name: 'Engelsrud' },
      via: [{ name: 'Asker' }],
      to: { name: 'Nationaltheatret' },
      allowedBusLines: ['280', '71'],
      excludedRailStops: ['Hvalstad'],
    });

  await panel.getByRole('tab', { name: 'Return' }).click();
  await expect(panel).toContainText('Nationaltheatret → Engelsrud');
});
