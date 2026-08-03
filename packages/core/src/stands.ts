/**
 * A saved hunting stand — the structure that survives the save (ROADMAP § E12).
 *
 * The shortlist plans a stand as a *direction*: which way you face, how far you
 * can see each way, how far off the paired holding cover is, and whether the
 * walk in burns it. Until this type existed, saving one wrote that reasoning
 * into `PlaceRecord.notes` as a paragraph and nothing rendered `notes` except
 * the edit form — so the one thing a hunter came back for was two taps inside a
 * textarea, and the map drew a bare dot where a rose belonged.
 *
 * This is deliberately a *record of a decision*, not a live reading:
 *
 * - **It is a snapshot, and says so.** `savedAt` is here because the surface is
 *   re-derived, the router re-run and the forecast replaced; a rose drawn in
 *   August is still the terrain's answer, but the approach verdict was true of
 *   one route on one day. A card that could not date itself would quietly
 *   present old arithmetic as current.
 * - **It carries what cannot be recomputed offline.** The lanes come from a
 *   terrain/canopy trace over rasters no phone holds; months later, with no
 *   network, this payload *is* the plan. Everything derivable from the position
 *   alone (elevation, light, weather) is deliberately absent — the card already
 *   fetches those, and a stale copy would be worse than none.
 * - **It does not replace the prose.** `notes` keeps the same reasoning in
 *   sentences, because that is what a GPX `<desc>` and a paper printout carry
 *   (the "everything exportable" rule), and this payload is neither.
 *
 * It lives in core rather than in `@atlas/potential` because storage persists it
 * and both clients render it, and neither may depend on the raster engine.
 */

import { destinationPoint, type LatLng } from './geo.js';

/** One spoke of a stand's terrain/canopy visibility rose, as saved. */
export interface PlaceStandLane {
  /** Compass key — `n`, `ne`, … (the engine's `STAND_DIRECTIONS`). */
  readonly key: string;
  /** What the card reads: `N`, `NE`, … */
  readonly label: string;
  readonly bearing: number;
  /** Modelled visible open ground on this bearing, capped at `maxRangeM`. */
  readonly rangeM: number;
}

/** The walk-in verdict as it stood when the stand was saved. */
export interface PlaceStandApproach {
  readonly risk: 'clear' | 'caution' | 'high';
  /** Valhalla geometry, or the stated straight-line fallback. */
  readonly basis: 'mapped-route' | 'direct-line';
  /** Metres of the walk in crossing likely holding cover. */
  readonly holdingCoverM: number;
  /** Walk-in minutes; `approximate` when the router never reached the stand. */
  readonly walkMinutes: number | null;
  readonly approximate: boolean;
}

/**
 * The hunter-side payload on a saved place. Optional everywhere: an ordinary
 * pin has no stand, and a place saved before this shipped has none either.
 */
export interface PlaceStand {
  readonly kind: 'stand';
  /** Which surface planned it, so a later source can be told apart. */
  readonly source: 'atlas-potential';
  /** The quarry/tactic it was planned for, e.g. `Rådyrbukk · lokkejakt`. */
  readonly target: string;
  /** Direction and distance to the habitat this stand watches. */
  readonly aim: {
    readonly label: string;
    readonly bearing: number;
    readonly distanceM: number;
    readonly position: LatLng;
  };
  /** Height above (+) or below (−) the mean ground within `maxRangeM`. */
  readonly vantageM: number;
  /** The planning distance the lanes were traced to. */
  readonly maxRangeM: number;
  readonly lanes: readonly PlaceStandLane[];
  /** Null when the shortlist had no routed walk-in to judge. */
  readonly approach: PlaceStandApproach | null;
  /** The surface's own band words for this point, e.g. `prime ground`. */
  readonly bandLabel: string;
  /** The safety boundary the shortlist stated; never dropped on the way in. */
  readonly warning: string;
  /** When this plan was saved — see the note above on staleness. */
  readonly savedAt: number;
}

/** The lanes worth drawing and reading: below this a spoke is not a sight line. */
export const STAND_LANE_MIN_M = 20;

/**
 * Validate an untrusted stand payload — a synced row, an imported dump, a
 * database written by a newer build.
 *
 * Rejects rather than repairs. A half-parsed rose would draw a plan the surface
 * never produced, and on this feature a wrong direction is worse than no
 * direction at all: the card exists to be trusted about which way to face.
 */
export function parsePlaceStand(value: unknown): PlaceStand | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const str = (v: unknown): v is string => typeof v === 'string';
  const point = (v: unknown): v is LatLng => {
    if (typeof v !== 'object' || v === null) return false;
    const p = v as Record<string, unknown>;
    return num(p['lat']) && num(p['lng']);
  };
  if (s['kind'] !== 'stand' || s['source'] !== 'atlas-potential') return null;
  if (!str(s['target']) || !str(s['bandLabel']) || !str(s['warning'])) return null;
  if (!num(s['vantageM']) || !num(s['maxRangeM']) || !num(s['savedAt'])) return null;

  const aim = s['aim'];
  if (typeof aim !== 'object' || aim === null) return null;
  const a = aim as Record<string, unknown>;
  if (!str(a['label']) || !num(a['bearing']) || !num(a['distanceM']) || !point(a['position'])) {
    return null;
  }

  const rawLanes = s['lanes'];
  if (!Array.isArray(rawLanes)) return null;
  const lanes: PlaceStandLane[] = [];
  for (const lane of rawLanes) {
    if (typeof lane !== 'object' || lane === null) return null;
    const l = lane as Record<string, unknown>;
    if (!str(l['key']) || !str(l['label']) || !num(l['bearing']) || !num(l['rangeM'])) return null;
    lanes.push({ key: l['key'], label: l['label'], bearing: l['bearing'], rangeM: l['rangeM'] });
  }

  let approach: PlaceStandApproach | null = null;
  const rawApproach = s['approach'];
  if (rawApproach != null) {
    if (typeof rawApproach !== 'object') return null;
    const ap = rawApproach as Record<string, unknown>;
    const risk = ap['risk'];
    const basis = ap['basis'];
    if (risk !== 'clear' && risk !== 'caution' && risk !== 'high') return null;
    if (basis !== 'mapped-route' && basis !== 'direct-line') return null;
    if (!num(ap['holdingCoverM'])) return null;
    const walk = ap['walkMinutes'];
    if (walk !== null && !num(walk)) return null;
    approach = {
      risk,
      basis,
      holdingCoverM: ap['holdingCoverM'],
      walkMinutes: walk === null ? null : (walk as number),
      approximate: ap['approximate'] === true,
    };
  }

  return {
    kind: 'stand',
    source: 'atlas-potential',
    target: s['target'],
    aim: {
      label: a['label'],
      bearing: a['bearing'],
      distanceM: a['distanceM'],
      position: { lat: a['position'].lat, lng: a['position'].lng },
    },
    vantageM: s['vantageM'],
    maxRangeM: s['maxRangeM'],
    lanes,
    approach,
    bandLabel: s['bandLabel'],
    warning: s['warning'],
    savedAt: s['savedAt'],
  };
}

/** One line of the stand block: a label and its value, in the card's order. */
export interface StandCardRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * What the stand block shows, as data — so web and Android render one answer in
 * two idioms rather than two answers.
 *
 * The rose is separate from the rows because it is the only part that is not a
 * sentence: both clients draw it as spokes, and a client that flattened it to
 * text would lose the thing the hunter reads at a glance.
 */
export interface StandCardModel {
  readonly title: string;
  readonly rows: readonly StandCardRow[];
  /** Open lanes, longest first; empty when terrain closes the stand entirely. */
  readonly rose: readonly PlaceStandLane[];
  /** Longest lane, so a renderer can scale spokes without rescanning. */
  readonly longestLaneM: number;
  /** Present when the walk-in is worth a warning of its own. */
  readonly approachNote: string | null;
  readonly approachRisk: PlaceStandApproach['risk'] | null;
  readonly warning: string;
  /** How long ago it was planned, e.g. `saved 12 Sep 2026`; null if unknown. */
  readonly savedNote: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Rounded the way the shortlist rounds: the source pixels are ~38 m wide. */
function coverMetres(holdingCoverM: number): number {
  return Math.max(10, Math.round(holdingCoverM / 10) * 10);
}

/**
 * The walk-in verdict in field language — one wording for the live shortlist,
 * the saved card and the pin's exported notes. Narrowed to the three fields the
 * sentence actually uses so the shortlist (which has no walk yet) can call it.
 */
export function standApproachNote(
  approach: Pick<PlaceStandApproach, 'risk' | 'basis' | 'holdingCoverM'>,
): string {
  const subject = approach.basis === 'direct-line' ? 'Direct off-path approach' : 'Mapped approach';
  if (approach.risk === 'clear') return `${subject} stays outside likely holding cover.`;
  const metres = coverMetres(approach.holdingCoverM);
  if (approach.risk === 'caution') {
    return `${subject} clips about ${metres} m of likely holding cover — move quietly.`;
  }
  return `${subject} crosses about ${metres} m of likely holding cover — consider another way in.`;
}

/**
 * The stand block for a place card, from the payload alone.
 *
 * Everything here was true when the stand was saved and is stated that way. The
 * card's live facts (elevation, light, weather) come from elsewhere and are not
 * mixed in: the point of this block is that it works months later with no
 * network, and a block that silently blended fresh and stale numbers could not
 * be trusted about either.
 */
export function standCardModel(stand: PlaceStand): StandCardModel {
  const rows: StandCardRow[] = [
    {
      key: 'aim',
      label: 'Face',
      value: `${stand.aim.label} · habitat ${stand.aim.distanceM} m out`,
    },
    {
      key: 'vantage',
      label: 'Vantage',
      value:
        stand.vantageM === 0
          ? 'level with the surrounding ground'
          : `${stand.vantageM > 0 ? '+' : ''}${stand.vantageM} m ${
              stand.vantageM > 0 ? 'above' : 'below'
            } the ground within ${stand.maxRangeM} m`,
    },
  ];
  const open = [...stand.lanes]
    .filter((lane) => lane.rangeM >= STAND_LANE_MIN_M)
    .sort((a, b) => b.rangeM - a.rangeM);
  rows.push({
    key: 'sight',
    label: 'Sight lines',
    value:
      open.length === 0
        ? `terrain and canopy close this stand inside ${STAND_LANE_MIN_M} m`
        : open.map((lane) => `${lane.label} ${lane.rangeM} m`).join(' · '),
  });
  if (stand.approach?.walkMinutes != null) {
    rows.push({
      key: 'walk',
      label: 'Walk in',
      value: `${stand.approach.approximate ? '≈' : ''}${stand.approach.walkMinutes} min from the nearest road`,
    });
  }

  const savedDate = new Date(stand.savedAt);
  const savedNote = Number.isFinite(stand.savedAt)
    ? `Planned ${savedDate.getDate()} ${MONTHS[savedDate.getMonth()]} ${savedDate.getFullYear()}` +
      ` · ${stand.bandLabel}`
    : null;

  return {
    title: `Stand · ${stand.target}`,
    rows,
    rose: open,
    longestLaneM: open.length === 0 ? 0 : open[0]!.rangeM,
    approachNote: stand.approach ? standApproachNote(stand.approach) : null,
    approachRisk: stand.approach?.risk ?? null,
    warning: stand.warning,
    savedNote,
  };
}

/** One drawn spoke of the rose, in a unit square with the stand at its centre. */
export interface StandRoseSpoke {
  readonly key: string;
  readonly label: string;
  readonly bearing: number;
  readonly rangeM: number;
  /** Endpoint, 0..1 across and down, north up — SVG's axes, not the compass's. */
  readonly x: number;
  readonly y: number;
  /** Length as a share of the planning distance, for stroke weight. */
  readonly share: number;
}

export interface StandRose {
  readonly spokes: readonly StandRoseSpoke[];
  /** The direction the stand watches; drawn differently from a sight line. */
  readonly aim: StandRoseSpoke;
  readonly maxRangeM: number;
}

/** How far a full-length spoke reaches; the rest of the box is label room. */
const ROSE_RADIUS = 0.44;

/**
 * The rose as drawable geometry, so web and Android draw one figure.
 *
 * Spokes are scaled against the **planning distance**, not against the longest
 * lane. Normalising to the longest would make every stand look equally open —
 * a hollow whose best lane is 40 m would draw the same figure as a ridge seeing
 * 150 m in six directions, which is exactly the comparison the rose exists to
 * let a hunter make at a glance.
 */
export function standRose(stand: PlaceStand): StandRose {
  const maxRangeM = stand.maxRangeM > 0 ? stand.maxRangeM : 1;
  const spoke = (key: string, label: string, bearing: number, rangeM: number): StandRoseSpoke => {
    const share = Math.max(0, Math.min(1, rangeM / maxRangeM));
    const radians = (bearing * Math.PI) / 180;
    return {
      key,
      label,
      bearing,
      rangeM,
      x: 0.5 + Math.sin(radians) * ROSE_RADIUS * share,
      y: 0.5 - Math.cos(radians) * ROSE_RADIUS * share,
      share,
    };
  };
  return {
    spokes: stand.lanes
      .filter((lane) => lane.rangeM >= STAND_LANE_MIN_M)
      .map((lane) => spoke(lane.key, lane.label, lane.bearing, lane.rangeM)),
    // The aim can lie beyond the traced lanes; it is clamped to the box rather
    // than allowed to run off it, and the card states the true distance anyway.
    aim: spoke('aim', stand.aim.label, stand.aim.bearing, Math.min(stand.aim.distanceM, maxRangeM)),
    maxRangeM,
  };
}

/**
 * A saved stand's rose and aim as GeoJSON, in the live shortlist's shape.
 *
 * Shared with the map for the same reason the shortlist's collection is: the
 * geometry *is* the plan, and a client that recomputed spoke endpoints from the
 * same bearings in its own file would eventually draw a different rose from the
 * one the card describes. Colours are the caller's business — a saved stand is
 * drawn dimmer than the live shortlist, which is a styling decision, not a
 * geometric one.
 */
export function savedStandFeatures(
  places: readonly { id: string; lat: number; lng: number; stand?: PlaceStand | null }[],
) {
  return {
    type: 'FeatureCollection' as const,
    features: places.flatMap((place) => {
      const stand = place.stand;
      if (!stand) return [];
      const at: LatLng = { lat: place.lat, lng: place.lng };
      const line = (kind: 'lane' | 'aim', id: string, to: LatLng) => ({
        type: 'Feature' as const,
        properties: { id, kind, placeId: place.id },
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [at.lng, at.lat],
            [to.lng, to.lat],
          ],
        },
      });
      return [
        ...stand.lanes
          .filter((lane) => lane.rangeM >= STAND_LANE_MIN_M)
          .map((lane) =>
            line(
              'lane',
              `${place.id}/lane/${lane.key}`,
              destinationPoint(at, lane.bearing, lane.rangeM),
            ),
          ),
        line('aim', `${place.id}/aim`, stand.aim.position),
      ];
    }),
  };
}
