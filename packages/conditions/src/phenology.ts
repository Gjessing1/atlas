/**
 * Biological roe-deer phases for the calling workflow.
 *
 * These are deliberately not hunting-season dates. Legal access varies by
 * place and regulation; this model only says how the animals' annual cycle is
 * likely to change the usefulness of calling and midday movement.
 */

export type RoePhenologyPhase =
  | 'spring-recovery'
  | 'pre-rut'
  | 'rut-peak'
  | 'late-rut'
  | 'post-rut'
  | 'autumn-feeding'
  | 'winter-concentration';

export interface RoePhenology {
  readonly phase: RoePhenologyPhase;
  readonly label: string;
  /** How likely calling is to draw a response, 0..1. */
  readonly calling: number;
  /** High-sun activity score for the rut conditions model, 0..1. */
  readonly middayActivity: number;
  readonly detail: string;
  readonly guidance: string;
  /** Whole-day phenology shift used for this point. */
  readonly shiftDays: number;
}

interface PhaseRow {
  readonly from: readonly [month: number, day: number];
  readonly phase: RoePhenologyPhase;
  readonly label: string;
  readonly calling: number;
  readonly middayActivity: number;
  readonly detail: string;
}

/**
 * Lowland southern-Norway baseline. Latitude and elevation move the biological
 * clock later; the broad bands are intentional because weather and individual
 * animals matter more than a calendar boundary.
 */
const ROE_PHASES: readonly PhaseRow[] = [
  {
    from: [0, 1],
    phase: 'winter-concentration',
    label: 'Winter concentration',
    calling: 0,
    middayActivity: 0.5,
    detail: 'Calling is out of phase; feeding areas and thermal cover matter more.',
  },
  {
    from: [2, 16],
    phase: 'spring-recovery',
    label: 'Spring recovery',
    calling: 0,
    middayActivity: 0.45,
    detail: 'Calling is out of phase; fresh browse and quiet cover matter more.',
  },
  {
    from: [6, 10],
    phase: 'pre-rut',
    label: 'Pre-rut',
    calling: 0.45,
    middayActivity: 0.6,
    detail: 'Bucks are ranging more, but calling response is still building.',
  },
  {
    from: [6, 24],
    phase: 'rut-peak',
    label: 'Rut peak',
    calling: 1,
    middayActivity: 0.9,
    detail: 'Calling response and daytime searching are at their strongest.',
  },
  {
    from: [7, 6],
    phase: 'late-rut',
    label: 'Late rut',
    calling: 0.85,
    middayActivity: 0.8,
    detail: 'Calling can still work well, including outside first and last light.',
  },
  {
    from: [7, 17],
    phase: 'post-rut',
    label: 'Post-rut',
    calling: 0.2,
    middayActivity: 0.45,
    detail: 'Calling response falls away; return to feeding-edge movement.',
  },
  {
    from: [8, 16],
    phase: 'autumn-feeding',
    label: 'Autumn feeding',
    calling: 0,
    middayActivity: 0.4,
    detail: 'Calling is out of phase; feeding fields, crossings and cover lead.',
  },
  {
    from: [10, 16],
    phase: 'winter-concentration',
    label: 'Winter concentration',
    calling: 0,
    middayActivity: 0.5,
    detail: 'Calling is out of phase; feeding areas and thermal cover matter more.',
  },
];

const DAY_MS = 86_400_000;

function referenceDay(month: number, day: number): number {
  return Math.floor((Date.UTC(2001, month, day) - Date.UTC(2001, 0, 1)) / DAY_MS);
}

/**
 * Estimate the roe phase at a point. Northern latitude and higher ground delay
 * the baseline by whole days, capped so the adjustment never pretends to be a
 * site-specific observation.
 */
export function roePhenologyAt(
  date: Date,
  latitude: number,
  elevationM: number | null = null,
): RoePhenology {
  const latitudeDelay = Math.max(-2, Math.min(7, (latitude - 60) * 0.65));
  const elevationDelay = elevationM == null ? 0 : Math.max(0, Math.min(4, elevationM / 300));
  const shiftDays = Math.round(latitudeDelay + elevationDelay);
  const observedDay = referenceDay(date.getUTCMonth(), date.getUTCDate()) - shiftDays;
  const wrappedDay = (observedDay + 365) % 365;
  let row = ROE_PHASES[0]!;
  for (const candidate of ROE_PHASES) {
    if (referenceDay(...candidate.from) <= wrappedDay) row = candidate;
    else break;
  }
  return {
    phase: row.phase,
    label: row.label,
    calling: row.calling,
    middayActivity: row.middayActivity,
    detail: row.detail,
    guidance: 'Biological timing estimate only — check the legal season for the municipality.',
    shiftDays,
  };
}
