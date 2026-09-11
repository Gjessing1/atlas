export {
  PARITY_SURFACES,
  PARITY_SURFACE_HOMES,
  PARITY_SURFACE_LABELS,
  isSurfaceComponent,
  paritySides,
  surfaceHome,
  type ParityCapability,
  type ParityEvidence,
  type ParitySurface,
} from './types.js';
export { PARITY_CHECKLIST } from './checklist.js';

import { PARITY_CHECKLIST } from './checklist.js';
import {
  PARITY_SURFACES,
  paritySides,
  type ParityCapability,
  type ParitySurface,
} from './types.js';

/** The checklist for one surface, in listed order. */
export function capabilitiesFor(surface: ParitySurface): readonly ParityCapability[] {
  return PARITY_CHECKLIST.filter((cap) => cap.surface === surface);
}

/**
 * The one-sided capabilities we have *not* justified as platform idiom or
 * platform capability — i.e. the drift rule 1 (types.ts) asks us to either close or
 * defend. An empty list is the goal; a growing one is the signal the checklist
 * exists to give.
 */
export function parityGaps(): readonly ParityCapability[] {
  return PARITY_CHECKLIST.filter((cap) => cap.open === true);
}

/** Counts per surface, for the release-time report. */
export function paritySummary(): Record<
  ParitySurface,
  { both: number; webOnly: number; androidOnly: number; open: number }
> {
  const empty = () => ({ both: 0, webOnly: 0, androidOnly: 0, open: 0 });
  const out = Object.fromEntries(PARITY_SURFACES.map((s) => [s, empty()])) as ReturnType<
    typeof paritySummary
  >;
  for (const cap of PARITY_CHECKLIST) {
    const row = out[cap.surface];
    const side = paritySides(cap);
    if (side === 'both') row.both += 1;
    else if (side === 'web-only') row.webOnly += 1;
    else if (side === 'android-only') row.androidOnly += 1;
    if (cap.open) row.open += 1;
  }
  return out;
}
