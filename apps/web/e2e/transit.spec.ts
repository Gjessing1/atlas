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
    /** Live correction, so the board has a delay to state as one (§3). */
    delayMs = 0,
    places: [string, string] = ['Engelsrud', 'Asker'],
  ): Record<string, unknown> => ({
    mode,
    distanceM: 8_000,
    durationMs: endMs - startMs,
    aimedStartMs: startMs,
    expectedStartMs: startMs + delayMs,
    aimedEndMs: endMs,
    expectedEndMs: endMs + delayMs,
    realtime: delayMs !== 0,
    from: { name: places[0], position: { lat: 59.82, lng: 10.42 } },
    to: { name: places[1], position: { lat: 59.8337, lng: 10.4348 } },
    line: { id: `X:Line:${publicCode}`, publicCode },
    intermediateStops: [],
    points: [],
    situations: [],
  });
  const journeyFrom = (startMs: number, busDelayMs = 0) => ({
    startMs: startMs + busDelayMs,
    endMs: startMs + 1_800_000,
    durationMs: 1_800_000,
    walkDistanceM: 300,
    legs: [
      leg('bus', '280', startMs, startMs + 900_000, busDelayMs),
      leg('rail', 'R14', startMs + 1_200_000, startMs + 1_800_000),
    ],
  });
  /** One hop of the corridor: the train from the interchange onwards (§13). */
  const fromAsker = (startMs: number) => ({
    startMs,
    endMs: startMs + 600_000,
    durationMs: 600_000,
    walkDistanceM: 0,
    legs: [leg('rail', 'R11', startMs, startMs + 600_000, 0, ['Asker', 'Nationaltheatret'])],
  });
  // The headline journey is three minutes down: its scheduled window is 30 min
  // and its live one is 27, which is the pair the board has to state as two
  // labelled lines rather than as one ambiguous number.
  const journey = journeyFrom(now + 300_000, 180_000);
  await page.route('**/api/transit/commute', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requested = body;
    route.fulfill({
      json: {
        outbound: { trips: [journey, journeyFrom(now + 1_500_000)], problems: [] },
        inbound: { trips: [journeyFrom(now + 3_600_000)], problems: [] },
        segments: [
          { id: 'outbound-1', result: { trips: [fromAsker(now + 1_200_000)], problems: [] } },
          { id: 'inbound-1', result: { trips: [], problems: [] } },
        ],
        // §7 — a board asked "from now" cannot contain the journey being
        // ridden, so the backend answers the commitment separately.
        ...(body.commit ? { committed: { trip: journey, replaced: null } } : {}),
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

  // Common schedules are one choice, while the seven individual days remain
  // available for a genuinely custom week.
  await panel.getByRole('button', { name: 'Weekdays' }).click();
  await expect(panel.getByRole('button', { name: 'Weekdays' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(panel.getByRole('button', { name: 'Sat' })).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.getByRole('button', { name: 'Sun' })).toHaveAttribute('aria-pressed', 'false');
  await panel.getByRole('button', { name: 'Every day' }).click();
  await expect(panel.getByRole('button', { name: 'Every day' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(panel.getByRole('button', { name: 'Sun' })).toHaveAttribute('aria-pressed', 'true');

  await panel.getByRole('button', { name: 'Done' }).click();
  const clock = (offsetMs: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Oslo',
      hour: '2-digit',
      minute: '2-digit',
    }).format(now + 300_000 + offsetMs);

  // The journey is one proportional bar, each vehicle as wide as it is long
  // (v0.184.0), with the correction on the leg carrying it rather than on the
  // row: "the bus is three late" and "the train is three late" are different
  // mornings.
  const lead = panel.locator('.commute-card.primary');
  const ribbon = lead.locator('.commute-seg');
  await expect(ribbon).toHaveCount(2);
  await expect(ribbon.first()).toContainText('280');
  await expect(ribbon.first()).toContainText('+3');
  await expect(ribbon.last()).toContainText('R14');
  await expect(lead).toContainText(`${clock(0)}`);
  await expect(lead).toContainText(`${clock(1_800_000)}`);
  // The change states the two numbers a traveller would otherwise subtract.
  await expect(panel.locator('.commute-change').first()).toContainText(
    `${clock(900_000)} → ${clock(1_200_000)}`,
  );

  // §3 applied to the travel time itself: the printed window is the
  // timetable's 30 minutes, and the live line beside it says the journey is
  // now 27 — the question "is the delay in that number or not" answered on the
  // row instead of inferred from the +3 above it.
  await expect(lead).toContainText('30 min');
  const live = lead.locator('.commute-live');
  await expect(live).toContainText(`${clock(180_000)} → ${clock(1_800_000)} est.`);
  await expect(live).toContainText('27 min');

  // §13 — the third mode: the change picked up as a stop, both directions at
  // once, off the hops the dashboard already asked for.
  const modes = panel.locator('.commute-modes');
  await expect(modes.getByRole('tab')).toHaveCount(3);
  await modes.getByRole('tab', { name: 'Interchange' }).click();
  await expect(panel.locator('.commute-header')).toContainText('From Asker');
  // Departures, both of them *leaving* Asker — never the hops into it, and
  // never a journey list: standing on the platform the question is what leaves.
  const boards = panel.locator('.commute-board h3');
  await expect(boards).toHaveCount(2);
  await expect(boards.first()).toContainText('Asker');
  await expect(boards.first()).toContainText('Nationaltheatret');
  await expect(boards.last()).toContainText('Engelsrud');
  await expect(panel.locator('.commute-list')).toHaveCount(0);
  await expect(panel.locator('.commute-board').first()).toContainText('R11');
  // The way home is answered and empty, which the board says as the timetable's
  // own nothing rather than as a failure.
  await expect(panel.locator('.commute-board').last()).toContainText('Nothing runs in this window');
  await modes.getByRole('tab', { name: 'Outbound' }).click();
  await expect(panel.locator('.commute-header')).toContainText('Engelsrud → Nationaltheatret');
  // …and a door mode is journeys and nothing else.
  await expect(panel.locator('.commute-board')).toHaveCount(0);

  // §7 — tracking, and the order the card states it in: the ribbon, then what
  // to do, then the connection that instruction leads to.
  await panel.getByRole('button', { name: 'Track this journey' }).first().click();
  const here = panel.locator('.commute-card.here');
  await expect(here).toContainText('280');
  await expect(here.locator('.commute-here-lead')).toContainText('Leaves Engelsrud');
  await expect(here.locator('.commute-here-lead em')).toContainText(`${clock(180_000)} est.`);
  const order = await here.evaluate((card) => [...card.children].map((child) => child.className));
  expect(order.findIndex((name) => name.includes('commute-ribbon'))).toBeLessThan(
    order.findIndex((name) => name.includes('commute-here-lead')),
  );

  await panel.getByRole('tab', { name: 'Return' }).click();
  // The route line is the panel's header now, not a field halfway down a form.
  await expect(panel.locator('.commute-header')).toContainText('Nationaltheatret → Engelsrud');
});

/**
 * §13 offered rather than waited for. A commute is saved door to door, so the
 * corridor that changes at Asker on every single journey had no `via` — and
 * without one there is no "start from" control, no per-leg board, and nothing
 * on screen to say that a Via stop was what both were waiting on.
 */
test('offers the interchange every journey changes at, and saves it as a stop', async ({
  page,
}) => {
  // No backup import here: the ends are picked through the stop search, which
  // is also the mock the suggestion's own lookup goes through.
  test.setTimeout(240_000);
  const now = Date.now();
  const bodies: Record<string, unknown>[] = [];

  const STOPS: Record<string, { name: string; lat: number; lng: number; id: string }> = {
    engelsrud: { name: 'Engelsrud', lat: 59.8198, lng: 10.3659, id: 'NSR:StopPlace:3369' },
    asker: { name: 'Asker stasjon', lat: 59.8331, lng: 10.4341, id: 'NSR:StopPlace:59616' },
    nationaltheatret: {
      name: 'Nationaltheatret',
      lat: 59.9149,
      lng: 10.7322,
      id: 'NSR:StopPlace:58404',
    },
  };
  await page.route('**/api/transit/stops**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q')?.toLowerCase() ?? '';
    const stop = Object.entries(STOPS).find(([key]) => key.startsWith(q.split(' ')[0] ?? ''))?.[1];
    route.fulfill({
      json: {
        results: stop
          ? [
              {
                name: stop.name,
                label: 'Bus · Train',
                position: { lat: stop.lat, lng: stop.lng },
                kind: 'public_transport/busStation',
                transitStopId: stop.id,
              },
            ]
          : [],
      },
    });
  });
  await page.route('**/api/search**', (route) => route.fulfill({ json: { results: [] } }));
  await page.route('**/api/transit/stop-lines**', (route) =>
    route.fulfill({ json: { stop: null, lines: [] } }),
  );

  const leg = (
    mode: string,
    publicCode: string,
    startMs: number,
    endMs: number,
    from: string,
    to: string,
  ): Record<string, unknown> => ({
    mode,
    distanceM: 8_000,
    durationMs: endMs - startMs,
    aimedStartMs: startMs,
    expectedStartMs: startMs,
    aimedEndMs: endMs,
    expectedEndMs: endMs,
    realtime: false,
    from: { name: from, position: { lat: 59.82, lng: 10.42 } },
    to: { name: to, position: { lat: 59.8331, lng: 10.4341 } },
    line: { id: `X:Line:${publicCode}`, publicCode },
    intermediateStops: [],
    points: [],
    situations: [],
  });
  /** Bus to the change, train onwards — the shape the suggestion reads. */
  const changing = (startMs: number) => ({
    startMs,
    endMs: startMs + 1_800_000,
    durationMs: 1_800_000,
    walkDistanceM: 200,
    legs: [
      leg('bus', '280', startMs, startMs + 900_000, 'Engelsrud', 'Asker stasjon'),
      leg('rail', 'R14', startMs + 1_200_000, startMs + 1_800_000, 'Asker stasjon', 'Oslo S'),
    ],
  });
  const fromAsker = (startMs: number) => ({
    startMs,
    endMs: startMs + 600_000,
    durationMs: 600_000,
    walkDistanceM: 0,
    legs: [leg('rail', 'R11', startMs, startMs + 600_000, 'Asker stasjon', 'Oslo S')],
  });
  await page.route('**/api/transit/commute', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    const hasVia = Array.isArray(body['via']) && body['via'].length > 0;
    route.fulfill({
      json: {
        outbound: { trips: [changing(now + 300_000), changing(now + 1_500_000)], problems: [] },
        inbound: { trips: [changing(now + 3_600_000)], problems: [] },
        ...(hasVia
          ? {
              segments: [
                { id: 'outbound-1', result: { trips: [fromAsker(now + 1_200_000)], problems: [] } },
                { id: 'inbound-1', result: { trips: [], problems: [] } },
              ],
            }
          : {}),
      },
    });
  });

  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Commute', exact: true }).click();

  const panel = page.locator('.commute-panel');
  const pick = async (field: string, query: string) => {
    await expect(panel.getByRole('button', { name: field })).toBeEnabled({ timeout: 90_000 });
    await panel.getByRole('button', { name: field }).click();
    await panel.getByRole('searchbox').fill(query);
    await panel.locator('.commute-hits button').first().click();
  };
  // Door to door, exactly as a commute is normally saved: no interchange.
  await pick('Choose a From stop…', 'engelsrud');
  await pick('Choose a To stop…', 'nationaltheatret');

  // Nothing to choose between yet — which is the state that used to be silent.
  await expect(panel.locator('.commute-modes').getByRole('tab')).toHaveCount(2);
  await expect(panel).toContainText('If I leave now', { timeout: 60_000 });
  const suggest = panel.locator('.commute-suggest');
  await expect(suggest).toContainText('Every journey changes at');
  await expect(suggest).toContainText('Asker stasjon');

  await suggest.getByRole('button', { name: 'Add as interchange' }).click();

  // Saved as a *stop*: a coordinate would answer the journey question and
  // silently break the line picker, which can only ask a stop for its lines.
  await expect
    .poll(() => bodies[bodies.length - 1])
    .toMatchObject({ via: [{ name: 'Asker stasjon', stopId: 'NSR:StopPlace:59616' }] });

  // …and the offer becomes the mode it was offering.
  await expect(suggest).toHaveCount(0);
  const modes = panel.locator('.commute-modes');
  await expect(modes.getByRole('tab')).toHaveCount(3);
  await modes.getByRole('tab', { name: 'Interchange' }).click();
  await expect(panel.locator('.commute-header')).toContainText('From Asker stasjon');
  await expect(panel.locator('.commute-board').first()).toContainText('R11');
});
