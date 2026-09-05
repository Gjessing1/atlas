/** Orbital element sets as CelesTrak publishes them, and their freshness. */

/** A CelesTrak GP group Atlas serves. */
export type SatelliteGroup = 'stations' | 'visual' | 'starlink';

/**
 * The OMM mean elements SGP4 needs, spelled exactly as CelesTrak's GP API
 * returns them (`gp.php?FORMAT=json`).
 *
 * Carried through the backend and over the wire **verbatim**, in upstream
 * spelling, rather than remapped to Atlas casing. Two reasons: the propagator
 * consumes an OMM object directly, so a remap would only have to be undone;
 * and OMM is a CCSDS standard, so the odd-looking SCREAMING_SNAKE keys are the
 * interoperable names — a second source (Space-Track, a supplemental set)
 * drops into the same shape without a translation table.
 *
 * Note there is no TLE anywhere in Atlas, deliberately. CelesTrak stopped
 * publishing TLEs for newly catalogued objects in mid-July 2026 once catalog
 * numbers passed the format's five-digit ceiling, so a TLE-based tracker
 * silently goes blind to everything launched after that date.
 */
export interface SatelliteOmm {
  OBJECT_NAME: string;
  /** International designator, e.g. `1998-067A`. */
  OBJECT_ID: string;
  /**
   * Element epoch, UTC — but written *without* a zone suffix
   * (`2026-09-05T11:57:50.773248`). See `elementEpochMs`.
   */
  EPOCH: string;
  /** Revolutions per day. The orbital period is `1440 / MEAN_MOTION` minutes. */
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  /**
   * Always 0 — GP data is SGP4 mean elements by definition, and the propagator
   * types it as the literal. Carried anyway because it is part of the OMM wire
   * shape a second source would also send.
   */
  EPHEMERIS_TYPE: 0;
  /** `U`nclassified — the only kind that reaches a public feed. */
  CLASSIFICATION_TYPE: 'U' | 'C';
  /** NORAD catalog number. Six digits (100000+) for objects catalogued from mid-2026. */
  NORAD_CAT_ID: number;
  ELEMENT_SET_NO: number;
  REV_AT_EPOCH: number;
  /** Drag term. Large values mean a low, fast-decaying orbit. */
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
  /**
   * Which CelesTrak group this record came from — an Atlas field, set by the
   * backend as it merges groups into one set.
   *
   * It rides inside the OMM object rather than in a parallel array because OMM
   * reserves room for exactly this: the format carries object metadata
   * (`OBJECT_TYPE`, `COUNTRY_CODE`) alongside the mean elements, and the
   * propagator ignores any key it does not know. What the clients do with it is
   * cartography — a space station earns a label and a drawn ground track,
   * whereas 157 rocket bodies with the same treatment would be an unreadable
   * map, and 11 000 Starlink objects would be a solid smear.
   */
  ATLAS_GROUP?: SatelliteGroup;
}

/** One layer's worth of elements, as the backend serves them. */
export interface SatelliteElementSet {
  /** When this instance last fetched the set from upstream, ISO 8601. */
  fetchedAt: string;
  /** The groups merged into `satellites`, in order. */
  groups: SatelliteGroup[];
  satellites: SatelliteOmm[];
}

/**
 * Beyond this, propagated positions have drifted far enough to be worth
 * captioning rather than drawing silently.
 *
 * SGP4 error on a low orbit grows at roughly 1–3 km/day away from the epoch,
 * dominated by unmodelled drag. At a week that is tens of kilometres — still
 * fine for "where is it now" on a map at country zoom, and clearly not fine for
 * "point a telescope here", which is why the clients show the age rather than
 * hiding it.
 */
export const ELEMENT_STALE_DAYS = 7;

/**
 * Milliseconds of an element set's epoch.
 *
 * The `Z` matters: CelesTrak writes epochs as bare date-times, and ECMAScript
 * reads a date-time with no offset as **local** time. Parsing one directly in
 * Oslo would put every satellite two hours off along its track — about
 * 55 000 km of arc for the ISS, i.e. an object drawn on the wrong continent by
 * a bug with no visible symptom other than "the tracker seems inaccurate".
 */
export function elementEpochMs(omm: Pick<SatelliteOmm, 'EPOCH'>): number {
  const raw = omm.EPOCH;
  return Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`);
}

/** Age of an element set in days at `nowMs`; negative epochs clamp to 0. */
export function elementAgeDays(omm: Pick<SatelliteOmm, 'EPOCH'>, nowMs: number): number {
  const epoch = elementEpochMs(omm);
  if (!Number.isFinite(epoch)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - epoch) / 86_400_000);
}

const NUMERIC_FIELDS = [
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'NORAD_CAT_ID',
  'BSTAR',
  'MEAN_MOTION_DOT',
] as const;

/**
 * Validate an upstream GP response into element records, dropping anything
 * malformed rather than failing the whole set.
 *
 * Per-record tolerance is the point: one object with a null element would
 * otherwise take the entire constellation off the map, and CelesTrak is a live
 * feed of a catalog that gets edited. A record that survives here is safe to
 * hand to SGP4 — which throws on missing numerics rather than returning null.
 */
export function parseOmmRecords(body: unknown, group?: SatelliteGroup): SatelliteOmm[] {
  if (!Array.isArray(body)) return [];
  const out: SatelliteOmm[] = [];
  const seen = new Set<number>();
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.OBJECT_NAME !== 'string' || !record.OBJECT_NAME.trim()) continue;
    if (
      typeof record.EPOCH !== 'string' ||
      !Number.isFinite(elementEpochMs({ EPOCH: record.EPOCH }))
    )
      continue;
    if (NUMERIC_FIELDS.some((field) => !Number.isFinite(Number(record[field])))) continue;
    // Mean motion is the divisor for the orbital period everywhere downstream.
    if (Number(record.MEAN_MOTION) <= 0) continue;
    const noradId = Number(record.NORAD_CAT_ID);
    // Groups overlap — the ISS is in `stations` and `visual` both — and a
    // duplicate would draw two dots and predict every pass twice.
    if (seen.has(noradId)) continue;
    seen.add(noradId);
    out.push({
      OBJECT_NAME: record.OBJECT_NAME.trim(),
      OBJECT_ID: typeof record.OBJECT_ID === 'string' ? record.OBJECT_ID : '',
      EPOCH: record.EPOCH,
      MEAN_MOTION: Number(record.MEAN_MOTION),
      ECCENTRICITY: Number(record.ECCENTRICITY),
      INCLINATION: Number(record.INCLINATION),
      RA_OF_ASC_NODE: Number(record.RA_OF_ASC_NODE),
      ARG_OF_PERICENTER: Number(record.ARG_OF_PERICENTER),
      MEAN_ANOMALY: Number(record.MEAN_ANOMALY),
      EPHEMERIS_TYPE: 0,
      CLASSIFICATION_TYPE: record.CLASSIFICATION_TYPE === 'C' ? 'C' : 'U',
      NORAD_CAT_ID: noradId,
      ELEMENT_SET_NO: Number(record.ELEMENT_SET_NO) || 0,
      REV_AT_EPOCH: Number(record.REV_AT_EPOCH) || 0,
      BSTAR: Number(record.BSTAR),
      MEAN_MOTION_DOT: Number(record.MEAN_MOTION_DOT),
      MEAN_MOTION_DDOT: Number(record.MEAN_MOTION_DDOT) || 0,
      // An explicit group wins; otherwise keep one an earlier pass set, so
      // re-parsing a merged set (which the backend does, to de-duplicate) does
      // not strip the tags it just applied.
      ...((group ?? record.ATLAS_GROUP)
        ? { ATLAS_GROUP: (group ?? record.ATLAS_GROUP) as SatelliteGroup }
        : {}),
    });
  }
  return out;
}

/** Orbital period in minutes. */
export function orbitalPeriodMinutes(omm: Pick<SatelliteOmm, 'MEAN_MOTION'>): number {
  return 1440 / omm.MEAN_MOTION;
}
