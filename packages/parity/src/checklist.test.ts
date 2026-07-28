import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PARITY_CHECKLIST } from './checklist.js';
import { capabilitiesFor, parityGaps, paritySummary } from './index.js';
import { PARITY_SURFACES, paritySides } from './types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * `apps/android` is excluded from the docker build context (.dockerignore), so
 * inside the image-build gate only the web half can be checked. Skipping the
 * missing half is right — the alternative is a checklist that cannot run where
 * the release is actually built — but skipping *both* would turn every
 * assertion below into a no-op, which is why that case fails loudly instead.
 */
const trees = {
  web: existsSync(join(repoRoot, 'apps/web/src')),
  android: existsSync(join(repoRoot, 'apps/android/src')),
};

const fileCache = new Map<string, string | null>();
const read = (file: string): string | null => {
  const cached = fileCache.get(file);
  if (cached !== undefined) return cached;
  const path = join(repoRoot, file);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  fileCache.set(file, text);
  return text;
};

/**
 * Every broken marker in one run, not just the first: the checklist is long
 * enough that a one-at-a-time gate would take a dozen builds to get through
 * after a rename.
 */
const missingEvidence = (client: 'web' | 'android'): string[] => {
  const problems: string[] = [];
  for (const cap of PARITY_CHECKLIST) {
    const evidence = cap[client];
    if (!evidence) continue;
    const source = read(evidence.file);
    if (source === null) {
      problems.push(`${cap.id}: ${client} evidence file ${evidence.file} does not exist`);
    } else if (!source.includes(evidence.contains)) {
      problems.push(
        `${cap.id}: ${evidence.file} no longer contains ${JSON.stringify(evidence.contains)} — ` +
          `either the capability moved (update the marker) or the ${client} client lost it, ` +
          `in which case this row becomes one-sided and needs a \`why\``,
      );
    }
  }
  return problems;
};

describe('parity checklist', () => {
  it('has at least one app tree to check against', () => {
    expect(trees.web || trees.android).toBe(true);
  });

  it('gives every capability a unique, surface-prefixed id', () => {
    const seen = new Set<string>();
    for (const cap of PARITY_CHECKLIST) {
      expect(seen.has(cap.id), `duplicate id ${cap.id}`).toBe(false);
      seen.add(cap.id);
      expect(cap.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(cap.capability.trim().length, `${cap.id}: empty capability line`).toBeGreaterThan(0);
    }
  });

  it('covers every surface §7.6 names', () => {
    for (const surface of PARITY_SURFACES) {
      expect(
        capabilitiesFor(surface).length,
        `no capabilities listed for ${surface}`,
      ).toBeGreaterThan(0);
    }
  });

  it('never lists a capability neither client has', () => {
    for (const cap of PARITY_CHECKLIST) {
      expect(paritySides(cap), `${cap.id} has no client at all — delete the row`).not.toBe(
        'neither',
      );
    }
  });

  it('makes every one-sided capability say why, and every two-sided one shut up about it', () => {
    for (const cap of PARITY_CHECKLIST) {
      const side = paritySides(cap);
      if (side === 'both') {
        expect(
          cap.why,
          `${cap.id}: both clients have it, so \`why\` reads as a stale gap`,
        ).toBeUndefined();
        expect(
          cap.open,
          `${cap.id}: both clients have it, so it is not open drift`,
        ).toBeUndefined();
      } else {
        expect(
          (cap.why ?? '').trim().length,
          `${cap.id} is ${side} and says nothing about why — that is the drift §7 forbids`,
        ).toBeGreaterThan(20);
      }
    }
  });

  it('points each side of a row at that side’s own app', () => {
    for (const cap of PARITY_CHECKLIST) {
      if (cap.web)
        expect(cap.web.file.startsWith('apps/web/'), `${cap.id}: ${cap.web.file}`).toBe(true);
      if (cap.android) {
        expect(cap.android.file.startsWith('apps/android/'), `${cap.id}: ${cap.android.file}`).toBe(
          true,
        );
      }
    }
  });

  it.runIf(trees.web)('finds every web capability in the web app', () => {
    expect(missingEvidence('web')).toEqual([]);
  });

  it.runIf(trees.android)('finds every Android capability in the Android app', () => {
    expect(missingEvidence('android')).toEqual([]);
  });

  /**
   * §7.6's second rule, made observable: a capability that claims a shared
   * state seam must name one that exists. The surfaces that never drifted are
   * the ones whose state already lives in @atlas/app-hooks, so a `hook` that
   * has quietly been renamed or inlined into an app is worth a red build.
   */
  it('names only real @atlas/app-hooks exports as shared seams', () => {
    const index = read('packages/app-hooks/src/index.ts');
    expect(index, 'packages/app-hooks/src/index.ts is missing').not.toBeNull();
    for (const cap of PARITY_CHECKLIST) {
      if (!cap.hook) continue;
      expect(
        new RegExp(`\\b${cap.hook}\\b`).test(index!),
        `${cap.id}: ${cap.hook} is not exported from @atlas/app-hooks`,
      ).toBe(true);
    }
  });

  it('summarises without losing a capability', () => {
    const summary = paritySummary();
    const counted = Object.values(summary).reduce(
      (n, row) => n + row.both + row.webOnly + row.androidOnly,
      0,
    );
    expect(counted).toBe(PARITY_CHECKLIST.length);
    // Every open row is one-sided by construction; a two-sided one would mean
    // the report shows drift that the checklist itself says is closed.
    for (const cap of parityGaps()) expect(paritySides(cap)).not.toBe('both');
  });
});
