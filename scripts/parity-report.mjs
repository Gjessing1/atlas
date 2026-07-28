#!/usr/bin/env node
// The web ↔ Android parity checklist, printed for a release (ROADMAP §7.6).
//
// The test beside the checklist is what *enforces* it — every "both clients
// have this" row names a file and a marker in each app, and the gate reads
// them. This script is the other half: the thing a human actually looks at
// before shipping, so a one-sided row has to be re-read (and re-agreed with)
// rather than quietly inherited.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'packages/parity/dist/index.js');
if (!existsSync(dist)) {
  console.error('packages/parity is not built — run `npm run build:packages` first.');
  process.exit(1);
}
const { PARITY_CHECKLIST, PARITY_SURFACES, PARITY_SURFACE_LABELS, paritySides, parityGaps } =
  await import(dist);

const MARK = { both: '  ✓  ', 'web-only': ' web ', 'android-only': ' and ' };
const verbose = process.argv.includes('--all');

for (const surface of PARITY_SURFACES) {
  const caps = PARITY_CHECKLIST.filter((cap) => cap.surface === surface);
  const both = caps.filter((cap) => paritySides(cap) === 'both').length;
  console.log(`\n${PARITY_SURFACE_LABELS[surface]}  —  ${both}/${caps.length} on both clients`);
  for (const cap of caps) {
    const side = paritySides(cap);
    if (side === 'both' && !verbose) continue;
    console.log(`  [${MARK[side]}] ${cap.capability}`);
    if (cap.why) console.log(`          ${cap.open ? 'OPEN: ' : 'why: '}${cap.why}`);
    if (cap.note) console.log(`          note: ${cap.note}`);
  }
}

const gaps = parityGaps();
console.log(
  `\n${PARITY_CHECKLIST.length} capabilities · ` +
    `${PARITY_CHECKLIST.filter((c) => paritySides(c) === 'both').length} on both · ` +
    `${gaps.length} open gap${gaps.length === 1 ? '' : 's'}`,
);
if (!verbose) console.log('(--all lists the capabilities both clients already have)');
