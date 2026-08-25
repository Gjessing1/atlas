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
  // A complete leg, not a stub: the dashboard reads its clock times off the
  // *ride* legs (the bus leaves when the bus leaves, not when you set off
  // walking), so a fixture with only trip-level times exercises none of it.
  const leg = (
    mode: string,
    publicCode: string,
    startMs: number,
    endMs: number,
  ): Record<string, unknown> => ({
    mode,
    distanceM: 8_000,
    durationMs: endMs - startMs,
    aimedStartMs: startMs,
    expectedStartMs: startMs,
    aimedEndMs: endMs,
    expectedEndMs: endMs,
    realtime: false,
    from: { name: 'Engelsrud', position: { lat: 59.82, lng: 10.42 } },
    to: { name: 'Asker', position: { lat: 59.8337, lng: 10.4348 } },
    line: { id: `X:Line:${publicCode}`, publicCode },
    intermediateStops: [],
    points: [],
    situations: [],
  });
  const journeyFrom = (startMs: number) => ({
    startMs,
    endMs: startMs + 1_800_000,
    durationMs: 1_800_000,
    walkDistanceM: 300,
    legs: [
      leg('bus', '280', startMs, startMs + 900_000),
      leg('rail', 'R14', startMs + 1_200_000, startMs + 1_800_000),
    ],
  });
  const journey = journeyFrom(now + 300_000);
  await page.route('**/api/transit/commute', (route) => {
    requested = route.request().postDataJSON() as Record<string, unknown>;
    route.fulfill({
      json: {
        outbound: { trips: [journey], problems: [] },
        inbound: { trips: [journeyFrom(now + 3_600_000)], problems: [] },
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
  // Ends are chosen through the stop picker now, with saved places offered as the
  // shortcut rather than as the only path. Nothing is pre-filled: the previous
  // build shipped one developer's favorites and bus lines as defaults.
  const pick = async (field: string, name: string) => {
    await panel.getByRole('button', { name: field }).click();
    await panel.locator('.commute-hits').getByRole('button', { name }).click();
  };
  await expect(panel.getByRole('button', { name: 'Choose a From stop…' })).toBeEnabled({
    timeout: 90_000,
  });
  await pick('Choose a From stop…', 'Engelsrud');
  await pick('No interchange', 'Asker');
  await pick('Choose a To stop…', 'Nationaltheatret');

  await expect(panel).toContainText('280');
  await expect(panel).toContainText('R14');
  await expect
    .poll(() => requested)
    .toMatchObject({
      from: { name: 'Engelsrud' },
      via: [{ name: 'Asker' }],
      to: { name: 'Nationaltheatret' },
      // No line rules until the user ticks some, and no mode ban at all.
      filter: { select: [], exclude: [], modes: [] },
    });

  // The dashboard leads with the answer: what leaving now gets you, and the
  // journey list beneath it. Both are on screen without expanding anything.
  await expect(panel).toContainText('If I leave now');
  await expect(panel).toContainText('Next journeys');

  await panel.getByRole('tab', { name: 'Return' }).click();
  // The route line is the panel's header now, not a field halfway down a form.
  await expect(panel.locator('.commute-header')).toContainText('Nationaltheatret → Engelsrud');
});
