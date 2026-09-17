import assert from 'node:assert/strict';
import test from 'node:test';

import { countPage, decideRefresh, readChanges } from './refresh-check.mjs';

const thresholds = { content: 500, segmentation: 25_000, maxAgeDays: 14 };
const unchanged = [
  { type: 162, content: 0, segmentation: 3 },
  { type: 823, content: 0, segmentation: 0 },
  { type: 105, content: 40, segmentation: 200 },
];

test('counts material and segmentation changes separately', () => {
  assert.deepEqual(
    countPage({
      vegobjektVersjonerOpprettet: [{}, {}],
      vegobjektVersjonerEndret: [{}],
      vegobjektVersjonerFjernet: [{}],
      vegobjektVersjonerSegmentert: [{}, {}, {}],
    }),
    { content: 4, segmentation: 3 },
  );
});

test('keeps a young dataset when thresholds are not reached', () => {
  const result = decideRefresh({
    since: '2026-09-10T00:00:00Z',
    now: '2026-09-17T00:00:00Z',
    byType: unchanged,
    thresholds,
  });
  assert.equal(result.rebuild, false);
  assert.equal(result.contentChanges, 40);
});

test('rebuilds immediately for a material camera change', () => {
  const result = decideRefresh({
    since: '2026-09-16T00:00:00Z',
    now: '2026-09-17T00:00:00Z',
    byType: [{ type: 162, content: 1, segmentation: 0 }],
    thresholds,
  });
  assert.equal(result.reason, 'camera data changed');
});

test('rebuilds at content, segmentation, and age limits', () => {
  for (const [byType, now, phrase] of [
    [[{ type: 105, content: 500, segmentation: 0 }], '2026-09-17T00:00:00Z', 'content-change'],
    [[{ type: 105, content: 0, segmentation: 25_000 }], '2026-09-17T00:00:00Z', 'resegmentation'],
    [unchanged, '2026-09-25T00:00:00Z', 'maximum age'],
  ]) {
    const result = decideRefresh({
      since: '2026-09-10T00:00:00Z',
      now,
      byType,
      thresholds,
    });
    assert.equal(result.rebuild, true);
    assert.match(result.reason, new RegExp(phrase));
  }
});

test('stops pagination on the API empty-page cursor', async () => {
  const pages = [
    {
      vegobjektVersjonerOpprettet: [{}],
      vegobjektVersjonerSegmentert: [{}, {}],
      metadata: { neste: { start: 'cursor-2' } },
    },
    {
      vegobjektVersjonerOpprettet: [],
      vegobjektVersjonerSegmentert: [],
      metadata: { neste: { start: 'cursor-2,null,null' } },
    },
  ];
  let calls = 0;
  const result = await readChanges(105, '2026-09-16T00:00:00Z', {
    fetchImpl: async () => ({ ok: true, json: async () => pages[calls++] }),
  });
  assert.deepEqual(result, {
    type: 105,
    content: 1,
    segmentation: 2,
    pages: 2,
    truncated: false,
  });
  assert.equal(calls, 2);
});
