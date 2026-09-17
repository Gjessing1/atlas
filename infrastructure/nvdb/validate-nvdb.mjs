#!/usr/bin/env node
// Refuse to publish an incomplete NVDB build. Opens the candidate exactly as
// the backend will, verifies every spatial index, and compares it with the last
// good file so an upstream/filter regression cannot silently erase a region.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [candidatePath, baselinePath] = process.argv.slice(2);
if (!candidatePath) {
  console.error('usage: validate-nvdb.mjs <candidate.sqlite> [baseline.sqlite]');
  process.exit(1);
}

const tables = [
  ['speed_segment', 'speed_rtree', 500_000],
  ['lane_segment', 'lane_rtree', 1_000],
  ['camera_point', 'camera_point_rtree', 100],
  ['camera_section', 'camera_section_rtree', 10],
];

const inspect = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const quick = db.prepare('PRAGMA quick_check').get().quick_check;
    if (quick !== 'ok') throw new Error(`${file}: quick_check returned ${quick}`);
    const counts = {};
    for (const [table, rtree, minimum] of tables) {
      const rows = Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
      const indexRows = Number(db.prepare(`SELECT count(*) AS count FROM ${rtree}`).get().count);
      if (rows !== indexRows) throw new Error(`${file}: ${table}=${rows}, ${rtree}=${indexRows}`);
      if (rows < minimum)
        throw new Error(`${file}: ${table}=${rows}, expected at least ${minimum}`);
      const mismatched = Number(
        db
          .prepare(
            `SELECT count(*) AS count FROM (
               SELECT id FROM ${table} EXCEPT SELECT id FROM ${rtree}
               UNION ALL
               SELECT id FROM ${rtree} EXCEPT SELECT id FROM ${table}
             )`,
          )
          .get().count,
      );
      if (mismatched !== 0) throw new Error(`${file}: ${table}/${rtree} IDs differ`);
      counts[table] = rows;
    }
    return counts;
  } finally {
    db.close();
  }
};

const candidate = inspect(candidatePath);
let baseline = null;
if (baselinePath && existsSync(baselinePath)) {
  baseline = inspect(baselinePath);
  for (const [table] of tables) {
    if (candidate[table] < baseline[table] * 0.9) {
      throw new Error(
        `${candidatePath}: ${table} fell from ${baseline[table]} to ${candidate[table]} (>10%)`,
      );
    }
  }
}

console.log(JSON.stringify({ candidate, baseline }, null, 2));
