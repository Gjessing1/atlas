/**
 * The commute corridor the Android regression reads off a home screen.
 *
 * Twice running, the only real bugs in a release were on the one surface with no
 * automated coverage, and both were found by a human looking at a home screen:
 * v0.176.0's `JSONObject.optString` printing the string `"null"` in two of five
 * columns, and v0.181.0's four rendering faults (a unit-less delay, a row-level
 * platform on a bus→train commute, no rule between journeys, no mode icons).
 * The gate tested the row *model* and stopped there, because the fixture server
 * answered no transit route at all.
 *
 * So this file serves the two the widget and the board live on —
 * `POST /api/transit/commute` and `POST /api/transit/widget` — and serves them
 * the way the backend does: **the boards are rendered by `@atlas/transit`**,
 * from a fixture upstream answer. Nothing here formats a time or names a
 * platform. A hand-written board JSON would be a second implementation of
 * `commuteWidgetBoard`, and one that could go on passing while the real one
 * changed shape underneath it; rendering the real thing means the assertion in
 * `regression.mjs` is "the home screen paints what the backend rendered",
 * which is exactly the read that caught the `optString` bug by hand.
 *
 * **The timetable is absolute**, laid on a fixed grid computed once when this
 * process starts. That is what makes a *commitment* testable: the widget commits
 * to a journey by its scheduled departure (`commuteCommitId`), and a fixture
 * that regenerated its departures relative to each request would hand back a
 * different journey a second later and quietly never resolve the commitment.
 *
 * Three departures repeat, so any three consecutive rows contain one of each —
 * the two shapes the regression is for, plus the ordinary one they have to be told from:
 *
 *  - **on time** — nothing to correct, the row that must not grow a `+0 min`.
 *  - **delayed** — `+3 min` against a scheduled time the row still prints, beside
 *    a change that survives it. This is v0.181.0's bug shape.
 *  - **broken** — delayed past its own connection, so
 *    `commuteConnectionBreak` fires on a committed journey and the widget's
 *    focus has to say so (TRANSIT.md §W4).
 */

import {
  commuteConnectionBreak,
  commuteJourney,
  commuteSegmentWidgetBoard,
  commuteSegments,
  commuteSpliceTrip,
  commuteSubstituteQuery,
  commuteSubstituteTrip,
  commuteWidgetBoard,
  commuteWidgetV2Board,
  defaultCommuteDirection,
  departureWidgetRow,
  findCommittedTrip,
  resolveCommuteV2Directions,
} from '@atlas/transit';

const MINUTE = 60_000;
/** Every twelve minutes, in both directions — a suburban corridor's headway. */
const HEADWAY_MS = 12 * MINUTE;
/**
 * The grid the timetable sits on, fixed for the life of this process.
 *
 * Not `now` rounded per request: a commitment names a scheduled departure, and a
 * timetable that shifted under it would make every committed refresh answer
 * "that journey no longer exists".
 */
const GRID_MS = Math.floor(Date.now() / HEADWAY_MS) * HEADWAY_MS;
/** Don't offer a departure that is already boarding — the app's own rows drop those. */
const LEAD_MS = 2 * MINUTE;

/** How the departure at index `i` runs. Repeats, so three rows hold all three. */
function pattern(index) {
  return ['ontime', 'delayed', 'broken'][((index % 3) + 3) % 3];
}

/** Minutes of delay on the first vehicle of departure `index`. */
function delayMinutes(index) {
  return { ontime: 0, delayed: 3, broken: 9 }[pattern(index)];
}

/** The indices of the next `count` departures at or after `fromMs`. */
function departureIndices(fromMs, count) {
  const first = Math.ceil((fromMs + LEAD_MS - GRID_MS) / HEADWAY_MS);
  return Array.from({ length: count }, (_, step) => first + step);
}

const place = (end, quay) => ({
  name: end.name,
  position: { lat: end.lat, lng: end.lng },
  ...(quay ? { quay: { id: `NSR:Quay:${quay}`, publicCode: quay } } : {}),
});

/**
 * One vehicle. `delay` moves the live times off the timetabled ones — both ends,
 * as a running-late vehicle does — and is what puts a correction beside a
 * scheduled time instead of on top of it.
 */
function ride({ mode, line, from, to, startMs, endMs, delayMs, situations = [] }) {
  return {
    mode,
    distanceM: mode === 'rail' ? 21_500 : 6_400,
    durationMs: endMs - startMs,
    aimedStartMs: startMs,
    expectedStartMs: startMs + delayMs,
    aimedEndMs: endMs,
    expectedEndMs: endMs + delayMs,
    realtime: true,
    from,
    to,
    line,
    intermediateStops: [
      { name: 'E2E halt', position: { lat: from.position.lat, lng: from.position.lng } },
    ],
    points: [],
    situations,
  };
}

const BUS = {
  id: 'RUT:Line:280',
  publicCode: '280',
  name: 'Asker – Engelsrud',
  operator: 'Ruter',
  headsign: 'Asker',
  colour: '#e60000',
  textColour: '#ffffff',
};
const TRAIN = {
  id: 'VYG:Line:R14',
  publicCode: 'R14',
  name: 'Asker – Oslo',
  operator: 'Vy',
  headsign: 'Oslo S',
  colour: '#00685e',
  textColour: '#ffffff',
};

const DISRUPTION = [
  {
    id: 'E2E:Situation:1',
    severity: 'warning',
    summary: 'Delays of approximately 5–10 min',
    description: 'Signal problems between Asker and Sandvika.',
  },
];

/**
 * One journey of the corridor: two vehicles and the change between them, or a
 * single vehicle when the commute has no interchange to change at.
 *
 * The change is six scheduled minutes. That is what makes the three departures
 * tell each other apart: the delayed one arrives three minutes late and still
 * connects, the broken one arrives nine late and cannot.
 */
function corridorTrip(stops, index, rail = false) {
  const departMs = GRID_MS + index * HEADWAY_MS;
  const delayMs = delayMinutes(index) * MINUTE;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const middle = stops.length > 2 ? stops[1] : null;
  const legs = [];
  if (middle) {
    const arriveMs = departMs + 18 * MINUTE;
    const changeMs = arriveMs + 6 * MINUTE;
    legs.push(
      ride({
        mode: 'bus',
        line: BUS,
        from: place(first, 'B4'),
        to: place(middle, '1'),
        startMs: departMs,
        endMs: arriveMs,
        delayMs,
        situations: delayMs > 0 ? DISRUPTION : [],
      }),
      ride({
        mode: 'rail',
        line: TRAIN,
        from: place(middle, '3'),
        to: place(last, '9'),
        startMs: changeMs,
        endMs: changeMs + 17 * MINUTE,
        delayMs: 0,
      }),
    );
  } else {
    legs.push(
      ride({
        mode: rail ? 'rail' : 'bus',
        line: rail ? TRAIN : BUS,
        from: place(first, rail ? '3' : 'B4'),
        to: place(last, rail ? '9' : '1'),
        startMs: departMs,
        endMs: departMs + (rail ? 17 : 18) * MINUTE,
        delayMs,
        situations: delayMs > 0 ? DISRUPTION : [],
      }),
    );
  }
  const startMs = legs[0].aimedStartMs;
  const endMs = legs[legs.length - 1].aimedEndMs;
  return { startMs, endMs, durationMs: endMs - startMs, walkDistanceM: 240, legs };
}

/** The corridor's stops in travel order for one direction. */
function directionStops(query, direction) {
  const stops = [query.from, ...(query.via ?? []), query.to];
  return direction === 'outbound' ? stops : [...stops].reverse();
}

/** `count` journeys of one direction, from `fromMs` onwards. */
function corridorResult(query, direction, fromMs, count) {
  const stops = directionStops(query, direction);
  return {
    trips: departureIndices(fromMs, count).map((index) => corridorTrip(stops, index)),
    problems: [],
  };
}

/** One hop of the corridor as its own small board — TRANSIT.md §5's per-leg boards. */
function segmentResult(segment, fromMs, count, rail = segment.index > 0) {
  return {
    trips: departureIndices(fromMs, count).map((index) =>
      corridorTrip([segment.from, segment.to], index, rail),
    ),
    problems: [],
  };
}

/**
 * The backend's TRANSIT.md §W4 branch, mirrored: when the committed journey's change
 * has broken, ask one more question and splice the answer in.
 *
 * Mirrored rather than shared because this file *is* the backend as far as the
 * device is concerned — and the regression's whole point is that the widget
 * paints a real substitute, announced the way the real one announces it.
 */
function substitute(query, direction, trip, nowMs) {
  const journey = commuteJourney(trip, nowMs);
  const broken = commuteConnectionBreak(journey, nowMs);
  if (!broken) return null;
  const question = commuteSubstituteQuery(query, direction, journey, broken, nowMs);
  if (!question) return null;
  const notBeforeMs = question.dateTimeMs ?? nowMs;
  const answer = segmentResult(
    { from: question.from, to: question.to, index: 1 },
    notBeforeMs - LEAD_MS,
    3,
    true,
  );
  const replacement = commuteSubstituteTrip(answer, notBeforeMs, nowMs);
  if (!replacement) return null;
  const spliced = commuteSpliceTrip(trip, replacement, broken.index);
  return spliced ? { trip: spliced, replaced: { at: broken.at, index: broken.index } } : null;
}

/** `POST /api/transit/commute` — both directions, the hops, and the commitment. */
export function commuteFixtureResponse(body, nowMs) {
  const query = body;
  const wantSegments = body?.segments === true;
  const rows = 5;
  // TRANSIT.md §7, mirroring the backend's own two steps: the tracked journey is read
  // around *its own* departure, because a board asked "from now" cannot contain
  // one that has already left — which is exactly when the block is worth
  // having. Then the same TRANSIT.md §W4 re-plan the widget gets.
  const commit =
    body?.commit && typeof body.commit.departureMs === 'number'
      ? {
          direction: body.commit.direction === 'inbound' ? 'inbound' : 'outbound',
          departureMs: body.commit.departureMs,
          line: String(body.commit.line ?? ''),
        }
      : null;
  const committedTrip = commit
    ? findCommittedTrip(
        corridorResult(query, commit.direction, commit.departureMs - 5 * MINUTE, 4),
        commit,
        nowMs,
      )
    : null;
  const replanned =
    commit && committedTrip ? substitute(query, commit.direction, committedTrip, nowMs) : null;
  const committed = replanned?.trip ?? committedTrip;
  return {
    outbound: corridorResult(query, 'outbound', nowMs, rows),
    inbound: corridorResult(query, 'inbound', nowMs, rows),
    emptyReason: { outbound: 'none', inbound: 'none' },
    ...(committed ? { committed: { trip: committed, replaced: replanned?.replaced ?? null } } : {}),
    ...(wantSegments
      ? {
          segments: commuteSegments(query).map((segment) => ({
            id: segment.id,
            result: segmentResult(segment, nowMs, rows),
          })),
        }
      : {}),
  };
}

/**
 * The last board served per variant, so the regression can assert the home
 * screen against *what the backend rendered* rather than against a copy of it
 * kept in the test. A second copy is a second thing to keep true.
 *
 * `broken` names the rows whose connection this timetable has broken. The
 * regression needs it to know which row to tap: a break is only computed for a
 * *committed* journey, so nothing in the board itself says which departure will
 * announce one — and re-deriving the fixture's own schedule inside the test
 * would be the second copy this endpoint exists to avoid.
 */
const served = new Map();

export function lastWidgetBoard(variant) {
  return served.get(variant) ?? { board: null, broken: [] };
}

/**
 * The rows this timetable has broken, by their commitment id.
 *
 * Read off the *id* rather than off `whenMs`: the id carries the journey's
 * **scheduled** departure — that is what a commitment is keyed on — while
 * `whenMs` is the live one, which on a delayed departure sits between two grid
 * slots and would name the wrong one.
 */
function brokenRowIds(board) {
  return (board.blocks ?? []).flatMap((block) =>
    block.rows
      .filter((row) => {
        const departureMs = Number(String(row.id).split(':')[1]);
        return (
          Number.isFinite(departureMs) &&
          pattern(Math.round((departureMs - GRID_MS) / HEADWAY_MS)) === 'broken'
        );
      })
      .map((row) => row.id),
  );
}

/**
 * `POST /api/transit/widget` — the same three board kinds the backend answers,
 * rendered by the same package functions.
 */
export function widgetFixtureResponse(body, nowMs) {
  if (body?.kind === 'stop') {
    const name = body.stop?.name ?? 'Engelsrud terrasse';
    const requestedLines = Array.isArray(body.lines) ? body.lines : [];
    const codes = requestedLines.length > 0 ? ['280'] : ['280', 'R14'];
    // On the timetable's grid, not `now + 12 min`: the widget re-asks more than
    // once after it is configured, and the regression compares the launcher
    // against the *last* board served. Times that moved with every request made
    // those two differ by a minute and failed v0.243.0's stop-widget step.
    const firstMs = GRID_MS + Math.ceil((nowMs + LEAD_MS - GRID_MS) / HEADWAY_MS) * HEADWAY_MS;
    const rows = codes.map((code, index) =>
      departureWidgetRow({
        id: `stop-${code}-${index}`,
        mode: code === '280' ? 'bus' : 'rail',
        aimedDepartureMs: firstMs + index * HEADWAY_MS,
        expectedDepartureMs: firstMs + index * HEADWAY_MS,
        realtime: true,
        cancelled: false,
        destination: code === '280' ? 'Asker' : 'Oslo S',
        line: { id: code === '280' ? 'RUT:Line:280' : 'VYG:Line:R14', publicCode: code },
        quay: { id: 'NSR:Quay:1', publicCode: '1' },
        situations: [],
      }),
    );
    const board = {
      route: name,
      directions: [{ key: 'outbound', label: name, rows, note: null }],
      checkedMs: nowMs,
      source: 'Entur live',
      checked: 'just now',
      status: 'Entur live · checked just now',
      nextRefreshMs: nowMs + 5 * MINUTE,
    };
    served.set('stop', { board, broken: [] });
    return board;
  }
  const query = body?.commute;
  if (!query) return { error: 'commute is required' };
  const maxRows = Number.isFinite(body?.maxRows) ? Math.min(Math.max(body.maxRows, 1), 6) : 3;

  if (body.variant === 'v2') {
    const selector = ['outbound', 'inbound', 'auto'].includes(body.selector)
      ? body.selector
      : 'auto';
    const commit =
      body.commit && typeof body.commit.departureMs === 'number'
        ? {
            direction: body.commit.direction === 'inbound' ? 'inbound' : 'outbound',
            departureMs: body.commit.departureMs,
            line: String(body.commit.line ?? ''),
          }
        : null;
    const resolution = resolveCommuteV2Directions({
      query,
      selector,
      pinnedAtMs: typeof body.pinnedAtMs === 'number' ? body.pinnedAtMs : 0,
      commit,
      place: body.place ?? null,
      nowMs,
    });
    // The committed journey is re-read around its own departure, exactly as the
    // backend does: a board asked "from now" cannot contain a journey that has
    // already left.
    const committedTrip = commit
      ? findCommittedTrip(
          corridorResult(query, commit.direction, commit.departureMs - 5 * MINUTE, 4),
          commit,
          nowMs,
        )
      : null;
    const replanned =
      commit && committedTrip ? substitute(query, commit.direction, committedTrip, nowMs) : null;
    const board = commuteWidgetV2Board({
      query,
      results: resolution.directions.map((key) => ({
        key,
        result: corridorResult(query, key, nowMs, maxRows),
        emptyReason: 'none',
      })),
      resolution,
      selector,
      commit,
      committedTrip: replanned?.trip ?? committedTrip,
      replaced: replanned?.replaced ?? null,
      nowMs,
      maxRows,
    });
    served.set('v2', { board, broken: brokenRowIds(board) });
    return board;
  }

  const requested = body.direction;
  const hop = commuteSegments(query).find((segment) => segment.id === requested);
  if (hop) {
    const board = commuteSegmentWidgetBoard({
      query,
      segment: hop,
      result: segmentResult(hop, nowMs, maxRows),
      emptyReason: 'none',
      nowMs,
      maxRows,
    });
    served.set('v1', { board, broken: [] });
    return board;
  }

  const directions =
    requested === 'outbound' || requested === 'inbound'
      ? [requested]
      : requested === 'both'
        ? ['outbound', 'inbound']
        : [defaultCommuteDirection(query, nowMs)];
  const board = commuteWidgetBoard({
    query,
    results: directions.map((key) => ({
      key,
      result: corridorResult(query, key, nowMs, maxRows),
      emptyReason: 'none',
    })),
    nowMs,
    maxRows,
  });
  served.set('v1', { board, broken: [] });
  return board;
}
