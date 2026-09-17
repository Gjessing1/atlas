import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLineString, parseMultiLineString } from './build-nvdb.mjs';

test('parses NVDB latitude-longitude LINESTRING Z geometry', () => {
  assert.deepEqual(parseLineString('LINESTRING Z (59.12345678 10.87654321 4, 59.2 10.9 5)'), [
    [59.123457, 10.876543],
    [59.2, 10.9],
  ]);
});

test('stitches contiguous MULTILINESTRING Z speed-limit geometry', () => {
  assert.deepEqual(
    parseMultiLineString(
      'MULTILINESTRING Z ((59.1 10.1 0, 59.2 10.2 0), (59.2 10.2 0, 59.3 10.3 0))',
    ),
    [
      [59.1, 10.1],
      [59.2, 10.2],
      [59.2, 10.2],
      [59.3, 10.3],
    ],
  );
});

test('rejects disconnected MULTILINESTRING parts', () => {
  assert.equal(
    parseMultiLineString('MULTILINESTRING ((59.1 10.1, 59.2 10.2), (60.2 11.2, 60.3 11.3))'),
    null,
  );
});
