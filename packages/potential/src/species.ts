/**
 * Species and quarry data — the knowledge payload of the Fish & Hunt engine.
 *
 * **The engine never branches on a species.** A species is weights plus bands;
 * a new species is a data row, never a code path. That rule is inherited from
 * nodemap and from `@atlas/conditions`, and it is what makes the models
 * reviewable by someone who fishes rather than someone who reads TypeScript.
 *
 * Two things are deliberately *absent* here:
 *
 * - **Hunting season dates.** The jakttidsforskrift varies by region and can be
 *   adjusted per kommune (lirype/fjellrype/hare run to 15 March in Finnmark,
 *   Troms, Narvik and Evenes; elg starts earlier in the north; bever needs a
 *   local forskrift to exist at all), and the whole forskrift expires 31 March
 *   2028. A national date pair shipped in this file would be wrong for a large
 *   part of the country on the day it landed. So: a link and an as-of stamp,
 *   nothing restated. `species.test.ts` enforces it.
 * - **Whether a salmon river is open.** Amended mid-season by emergency
 *   forskrift, not machine-readable, and it would rot silently. The river model
 *   links `lakseregURL` per stretch instead and stays honest about reading
 *   channel character rather than today's legality.
 */
import type { HuntConditionsProfile } from '@atlas/conditions';
import type { Band } from './signals.js';
import { shiftBand } from './signals.js';

/** One signal a model can weight, with the label the explain card shows. */
export interface SignalMeta {
  readonly key: string;
  readonly label: string;
  /** What the signal measures — the sentence behind the label. */
  readonly about: string;
}

/** Lake signals. `regulated` is a *low value* where drawdown hurts, never a negative weight. */
export const LAKE_SIGNALS = [
  { key: 'structure', label: 'Bottom structure', about: 'Drop-off or shelf from the depth survey' },
  {
    key: 'nearshore-slope',
    label: 'Nearshore drop-off',
    about: 'Inferred from shoreline terrain steepness where no survey exists',
  },
  { key: 'depth-band', label: 'Holding depth', about: "Inside the target's depth band" },
  {
    key: 'inlet',
    label: 'Inflow mouth',
    about: 'Cold, oxygenated, food-bearing water entering the lake',
  },
  { key: 'outlet', label: 'Outflow mouth', about: 'Current and gathered food at the outlet' },
  { key: 'cove', label: 'Cove', about: 'Bays, narrows and other concave shoreline' },
  { key: 'headland', label: 'Point', about: 'Headlands, island shores and convex shoreline' },
  {
    key: 'shore-cover',
    label: 'Shore cover',
    about: 'Myr edge, forest edge and farmland runoff along the bank',
  },
  {
    key: 'productivity',
    label: 'Productivity',
    about: 'Altitude, area, catchment and residence time from the lake register',
  },
  {
    key: 'regulated',
    label: 'Regulation',
    about: 'Drawdown zone of a regulated lake — dead water, scored low',
  },
  {
    key: 'wind-fetch',
    label: 'Windward shore',
    about: "Today's wind piling food onto this bank",
  },
] as const satisfies readonly SignalMeta[];

export type LakeSignalKey = (typeof LAKE_SIGNALS)[number]['key'];

/** River signals — built once and shared by the innlandsfisk and anadromous targets. */
export const RIVER_SIGNALS = [
  { key: 'pool', label: 'Pool', about: 'Slow, deep holding water' },
  { key: 'riffle', label: 'Riffle', about: 'Broken, oxygenated water over a moderate grade' },
  { key: 'seam', label: 'Seam', about: 'Boundary between fast and slow current' },
  { key: 'confluence', label: 'Confluence', about: 'Where a tributary joins' },
  { key: 'bend', label: 'Outer bend', about: 'Scoured deeper water on the outside of a bend' },
  {
    key: 'magnitude',
    label: 'River size',
    about: 'Mean discharge and Strahler order of the reach',
  },
  {
    key: 'barrier-pool',
    label: 'Below a barrier',
    about: 'Fish stack under the first impassable falls',
  },
  { key: 'cover', label: 'Bank cover', about: 'Overhanging bank vegetation and shade' },
] as const satisfies readonly SignalMeta[];

export type RiverSignalKey = (typeof RIVER_SIGNALS)[number]['key'];

/** Hunt signals. `artfunksjon` is presence-only: a bonus behind a coverage gate, never a penalty. */
export const HUNT_SIGNALS = [
  { key: 'edge-farmland', label: 'Field edge', about: 'Forest meeting farmland' },
  { key: 'edge-myr', label: 'Bog fringe', about: 'Forest meeting myr, on the dry side' },
  { key: 'cover-young', label: 'Young cover', about: 'Dense regrowth and thickets' },
  {
    key: 'cover-mature',
    label: 'Mature cover',
    about: 'Closed mature stand for bedding and shelter',
  },
  { key: 'pine-mature', label: 'Mature pine', about: 'Old pine on medium bonitet' },
  { key: 'browse', label: 'Browse', about: 'Regrowth with a deciduous share' },
  { key: 'water', label: 'Water', about: 'Proximity to open water' },
  { key: 'slope', label: 'Terrain', about: "Ground within the quarry's slope tolerance" },
  { key: 'warmth', label: 'Sun-facing', about: 'South-facing, warmer ground' },
  { key: 'treeline', label: 'Tree line', about: 'Height band relative to the local tree line' },
  { key: 'rocky-ridge', label: 'Rocky ridge', about: 'Exposed stony ground above the forest' },
  { key: 'quiet', label: 'Undisturbed', about: 'Distance from roads and buildings' },
  {
    key: 'artfunksjon',
    label: 'Surveyed area',
    about: 'Officially mapped functional area — grazing, calving or lek',
  },
] as const satisfies readonly SignalMeta[];

export type HuntSignalKey = (typeof HUNT_SIGNALS)[number]['key'];

/** Look up a signal's metadata across all three registries. */
export function signalMeta(key: string): SignalMeta | undefined {
  return [...LAKE_SIGNALS, ...RIVER_SIGNALS, ...HUNT_SIGNALS].find((s) => s.key === key);
}

/**
 * The line under a target chip, built from that target's own weights rather
 * than written by hand.
 *
 * The picker is the only place a surface can teach what it is tuned for, and a
 * caption that restates the species name teaches nothing. Naming the two signals
 * that weigh heaviest says what will actually move when you tap it — and because
 * it is read off the weights, it cannot drift from the arithmetic the way a
 * hand-written sentence would.
 *
 * Deliberately season-free: a depth band moves through the year and the catalog
 * is cached on the device, so a chip promising "summer band 4–9 m" in October
 * would be a lie the panel had no way to notice.
 */
export function weightsCaption(
  name: string,
  weights: Readonly<Record<string, number | undefined>>,
  fallback: string,
): string {
  const top = Object.entries(weights)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, 2)
    .map(([key]) => signalMeta(key)?.label.toLowerCase())
    .filter((label): label is string => Boolean(label));
  const phrase = top.length === 2 ? `${top[0]} and ${top[1]}` : (top[0] ?? fallback);
  return `${name} — ${phrase} weigh heaviest.`;
}

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** Meteorological season for a date — the granularity the depth shift deserves. */
export function seasonAt(date: Date): Season {
  const month = date.getMonth();
  if (month <= 1 || month === 11) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'autumn';
}

export interface FishSpecies {
  readonly id: string;
  readonly nameNo: string;
  readonly nameEn: string;
  /** Holding depth in metres, or null for a river-only target. */
  readonly depthBandM: Band | null;
  /**
   * Metres the band moves per season. Summer stratification pushes trout and
   * char deeper and toward inflows; spring and autumn bring them to the
   * shallows. Applied visibly ("summer band 4–9 m"), never silently.
   */
  readonly seasonalDepthShiftM: Record<Season, number>;
  /**
   * Highest lake altitude the species is plausible at, in metres — the
   * *fallback* only. An Artskart occurrence inside the lake polygon is far stronger
   * evidence and takes precedence; null means altitude says nothing useful.
   */
  readonly plausibleMaxAltitudeM: number | null;
  /**
   * Artskart taxon id for positive presence evidence. Null when this target is
   * not a lake species (the anadromous river rows use their mapped reaches
   * instead). Kept on the row so adding a species cannot require an adapter
   * switch statement.
   */
  readonly presenceTaxonId: number | null;
  /** Sea-run, so the anadromous gate and barrier-pool boost apply. */
  readonly anadromous: boolean;
  /**
   * Which temperature band `@atlas/conditions` should use when this target's
   * spots are asked *when* to go — the structure/conditions split (D3) needs
   * the two halves to agree on the species, and only one of them speaks
   * Norwegian.
   *
   * A data row rather than a `switch` in the hook, for the reason this whole
   * file exists: a new species must never be a code path. The conditions engine
   * knows four bands, so several species share one — sea trout feeds in the
   * same water a brown trout does.
   */
  readonly conditionsSpecies: 'trout' | 'char' | 'perch' | 'pike';
  readonly lakeWeights: Partial<Record<LakeSignalKey, number>>;
  readonly riverWeights: Partial<Record<RiverSignalKey, number>>;
}

export const FISH_SPECIES = [
  {
    id: 'orret',
    nameNo: 'Ørret',
    nameEn: 'Brown trout',
    depthBandM: { min: 0.3, peakMin: 1, peakMax: 6, max: 12 },
    seasonalDepthShiftM: { spring: 0, summer: 3, autumn: 0, winter: 2 },
    plausibleMaxAltitudeM: null,
    presenceTaxonId: 26165,
    anadromous: false,
    conditionsSpecies: 'trout',
    lakeWeights: {
      inlet: 1,
      structure: 0.8,
      'nearshore-slope': 0.8,
      'depth-band': 0.7,
      cove: 0.5,
      headland: 0.5,
      outlet: 0.5,
      'shore-cover': 0.5,
      productivity: 0.4,
      regulated: 0.4,
      'wind-fetch': 0.3,
    },
    riverWeights: {
      riffle: 0.9,
      seam: 0.8,
      pool: 0.7,
      cover: 0.6,
      confluence: 0.6,
      bend: 0.5,
      magnitude: 0.4,
    },
  },
  {
    id: 'roye',
    nameNo: 'Røye',
    nameEn: 'Arctic char',
    depthBandM: { min: 5, peakMin: 12, peakMax: 30, max: 45 },
    seasonalDepthShiftM: { spring: 0, summer: 6, autumn: 0, winter: 4 },
    plausibleMaxAltitudeM: null,
    presenceTaxonId: 189732,
    anadromous: false,
    conditionsSpecies: 'char',
    lakeWeights: {
      'depth-band': 0.9,
      structure: 0.8,
      'nearshore-slope': 0.8,
      inlet: 0.7,
      outlet: 0.4,
      headland: 0.4,
      productivity: 0.4,
      cove: 0.3,
      regulated: 0.3,
      'wind-fetch': 0.2,
    },
    riverWeights: { pool: 0.8, seam: 0.6, riffle: 0.5, confluence: 0.5, magnitude: 0.3 },
  },
  {
    id: 'abbor',
    nameNo: 'Abbor',
    nameEn: 'Perch',
    depthBandM: { min: 0.5, peakMin: 2, peakMax: 8, max: 16 },
    seasonalDepthShiftM: { spring: 0, summer: 1, autumn: 0, winter: 3 },
    plausibleMaxAltitudeM: 800,
    presenceTaxonId: 26439,
    anadromous: false,
    conditionsSpecies: 'perch',
    lakeWeights: {
      cove: 0.9,
      'shore-cover': 0.8,
      structure: 0.7,
      'depth-band': 0.7,
      productivity: 0.6,
      headland: 0.5,
      inlet: 0.4,
      'nearshore-slope': 0.4,
      regulated: 0.3,
      'wind-fetch': 0.3,
    },
    riverWeights: { pool: 0.9, cover: 0.6, seam: 0.4, magnitude: 0.3 },
  },
  {
    id: 'gjedde',
    nameNo: 'Gjedde',
    nameEn: 'Pike',
    depthBandM: { min: 0.2, peakMin: 0.5, peakMax: 4, max: 9 },
    seasonalDepthShiftM: { spring: 0, summer: 1, autumn: 0, winter: 1 },
    plausibleMaxAltitudeM: 500,
    presenceTaxonId: 26181,
    anadromous: false,
    conditionsSpecies: 'pike',
    lakeWeights: {
      cove: 1,
      'shore-cover': 0.9,
      'depth-band': 0.7,
      productivity: 0.6,
      structure: 0.5,
      headland: 0.4,
      inlet: 0.3,
      'nearshore-slope': 0.3,
      regulated: 0.3,
    },
    riverWeights: { pool: 1, cover: 0.7, seam: 0.3 },
  },
  {
    id: 'laks',
    nameNo: 'Laks',
    nameEn: 'Atlantic salmon',
    depthBandM: null,
    seasonalDepthShiftM: { spring: 0, summer: 0, autumn: 0, winter: 0 },
    plausibleMaxAltitudeM: null,
    presenceTaxonId: null,
    anadromous: true,
    conditionsSpecies: 'trout',
    lakeWeights: {},
    riverWeights: {
      pool: 1,
      'barrier-pool': 1,
      seam: 0.8,
      magnitude: 0.7,
      riffle: 0.5,
      confluence: 0.5,
      bend: 0.5,
      cover: 0.3,
    },
  },
  {
    id: 'sjoorret',
    nameNo: 'Sjøørret',
    nameEn: 'Sea trout',
    depthBandM: null,
    seasonalDepthShiftM: { spring: 0, summer: 0, autumn: 0, winter: 0 },
    plausibleMaxAltitudeM: null,
    presenceTaxonId: null,
    anadromous: true,
    conditionsSpecies: 'trout',
    lakeWeights: {},
    riverWeights: {
      pool: 0.8,
      'barrier-pool': 0.8,
      seam: 0.8,
      riffle: 0.7,
      cover: 0.6,
      confluence: 0.5,
      bend: 0.5,
      magnitude: 0.4,
    },
  },
] as const satisfies readonly FishSpecies[];

export type FishSpeciesId = (typeof FISH_SPECIES)[number]['id'];

export function fishSpecies(id: string): FishSpecies | undefined {
  return FISH_SPECIES.find((s) => s.id === id);
}

/** The depth band actually in use this season — shifted, never silently. */
export function depthBandFor(species: FishSpecies, season: Season): Band | null {
  if (!species.depthBandM) return null;
  return shiftBand(species.depthBandM, species.seasonalDepthShiftM[season]);
}

const SEASON_LABEL: Record<Season, string> = {
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
  winter: 'Winter',
};

/** "Summer band 4–9 m" — what the UI shows so the shift is never invisible. */
export function describeDepthBand(species: FishSpecies, season: Season): string | null {
  const band = depthBandFor(species, season);
  if (!band) return null;
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return `${SEASON_LABEL[season]} band ${fmt(Math.max(0, band.peakMin))}–${fmt(band.peakMax)} m`;
}

/**
 * Is this target plausible in a lake at this altitude? Presence data beats the
 * rule outright — pass `observed` from Artskart and the altitude never gets a say,
 * because presence-only data means absence proves nothing in the other
 * direction either.
 */
export function altitudePlausible(
  species: FishSpecies,
  altitudeM: number,
  observed?: boolean,
): boolean {
  if (observed !== undefined) return observed;
  if (species.plausibleMaxAltitudeM === null) return true;
  return altitudeM <= species.plausibleMaxAltitudeM;
}

export interface Quarry {
  readonly id: string;
  readonly nameNo: string;
  readonly nameEn: string;
  /** Optional picker wording when the model is intentionally tactic/season-specific. */
  readonly targetLabel?: string;
  /** Conditions model used when the shortlist decides when this tactic is on. */
  readonly conditionsProfile?: HuntConditionsProfile;
  /** SSB harvest key when two tactic rows describe the same quarry. */
  readonly harvestKey?: string;
  /**
   * SR16 `SRRHOYDEO` dominant tree height band, in metres — the stand maturity
   * this quarry uses. Null for species that live above the forest.
   */
  readonly treeHeightBandM: Band | null;
  /**
   * Height band relative to the **local** tree line, in metres, or null. Local
   * because a fixed elevation travels wrongly from Sørlandet to Finnmark: the
   * tree line is derived per area from where forest cover collapses.
   */
  readonly treeLineBandM: Band | null;
  /** Distance from roads and dwellings the quarry keeps, in metres. */
  readonly disturbanceBufferM: number;
  /**
   * The season's kommune harvest that reads as **strong ground** for this
   * quarry, or null where SSB publishes no per-kommune table.
   *
   * Measured against the live tables for 2025-2026 rather than guessed, and
   * per quarry because the two distributions are not remotely alike — among the
   * kommuner that shoot any at all, elg runs median 73 / p90 228 / max 629
   * (Trysil) while hjort runs median 64 / p90 634 / max 2 373 (Sunnfjord). SSB
   * 14380 supplies the existing small-game rows for 2024–2025; its counts are
   * rounded to tens and suppressed cells stay unknown, never zero. One
   * shared ceiling would have called an ordinary moose kommune excellent and a
   * serious deer one merely good; the first version of this did exactly that,
   * rating Oslo's 73 elg — the national *median* — "Excellent".
   */
  readonly strongHarvest: number | null;
  /** Ground the quarry uses, as a slope band in percent. */
  readonly slopeBandPercent: Band;
  /** Stand-to-habitat distance that suits this quarry and tactic, in metres. */
  readonly standDistanceBandM: Band;
  readonly weights: Partial<Record<HuntSignalKey, number>>;
}

/** The original big-game stand rule: long visible pairings earn full value. */
const GENERAL_STAND_DISTANCE_M: Band = { min: 0, peakMin: 100, peakMax: 150, max: 151 };

/** A called roe buck is expected to appear close to the watched edge. */
const ROE_RUT_STAND_DISTANCE_M: Band = { min: 10, peakMin: 20, peakMax: 60, max: 150 };

export const QUARRIES = [
  {
    id: 'radyr',
    nameNo: 'Rådyr',
    nameEn: 'Roe deer rut calling',
    targetLabel: 'Rådyr ▸ brunst',
    conditionsProfile: 'roe-rut',
    treeHeightBandM: { min: 0, peakMin: 1, peakMax: 8, max: 16 },
    treeLineBandM: null,
    disturbanceBufferM: 100,
    strongHarvest: null,
    slopeBandPercent: { min: -1, peakMin: 0, peakMax: 20, max: 45 },
    standDistanceBandM: ROE_RUT_STAND_DISTANCE_M,
    weights: {
      'edge-farmland': 1,
      'cover-young': 0.9,
      'edge-myr': 0.5,
      slope: 0.5,
      artfunksjon: 0.5,
      browse: 0.4,
      // August bucks feed and patrol the edges, but bed in closed timber
      // through the heat of the day. Less than thicket cover because it is
      // shelter rather than forage, but never absent from the model.
      'cover-mature': 0.4,
      quiet: 0.3,
    },
  },
  {
    id: 'radyr-generell',
    nameNo: 'Rådyr',
    nameEn: 'Roe deer general',
    targetLabel: 'Rådyr ▸ generell',
    conditionsProfile: 'general',
    harvestKey: 'radyr',
    treeHeightBandM: { min: 0, peakMin: 2, peakMax: 12, max: 24 },
    treeLineBandM: null,
    disturbanceBufferM: 100,
    strongHarvest: null,
    slopeBandPercent: { min: -1, peakMin: 0, peakMax: 25, max: 50 },
    standDistanceBandM: GENERAL_STAND_DISTANCE_M,
    weights: {
      'edge-farmland': 1,
      browse: 0.8,
      'cover-mature': 0.7,
      'cover-young': 0.6,
      warmth: 0.5,
      slope: 0.4,
      artfunksjon: 0.4,
      quiet: 0.3,
    },
  },
  {
    id: 'elg',
    nameNo: 'Elg',
    nameEn: 'Moose',
    treeHeightBandM: { min: 0, peakMin: 1, peakMax: 6, max: 12 },
    treeLineBandM: null,
    disturbanceBufferM: 300,
    strongHarvest: 230,
    slopeBandPercent: { min: -1, peakMin: 0, peakMax: 15, max: 35 },
    standDistanceBandM: GENERAL_STAND_DISTANCE_M,
    weights: {
      browse: 1,
      'edge-myr': 0.7,
      artfunksjon: 0.7,
      'cover-mature': 0.6,
      water: 0.6,
      slope: 0.5,
      quiet: 0.5,
      'cover-young': 0.5,
    },
  },
  {
    id: 'hjort',
    nameNo: 'Hjort',
    nameEn: 'Red deer',
    treeHeightBandM: { min: 8, peakMin: 14, peakMax: 30, max: 40 },
    treeLineBandM: null,
    disturbanceBufferM: 400,
    strongHarvest: 630,
    slopeBandPercent: { min: -1, peakMin: 0, peakMax: 40, max: 70 },
    standDistanceBandM: GENERAL_STAND_DISTANCE_M,
    weights: {
      'cover-mature': 1,
      'edge-farmland': 0.9,
      quiet: 0.7,
      artfunksjon: 0.6,
      slope: 0.4,
      warmth: 0.4,
      water: 0.3,
    },
  },
  {
    id: 'storfugl',
    nameNo: 'Storfugl',
    nameEn: 'Capercaillie',
    treeHeightBandM: { min: 10, peakMin: 16, peakMax: 30, max: 40 },
    treeLineBandM: null,
    disturbanceBufferM: 300,
    strongHarvest: 150,
    slopeBandPercent: { min: -1, peakMin: 0, peakMax: 30, max: 60 },
    standDistanceBandM: GENERAL_STAND_DISTANCE_M,
    weights: {
      'pine-mature': 1,
      artfunksjon: 0.9,
      'edge-myr': 0.7,
      'cover-mature': 0.6,
      quiet: 0.5,
      slope: 0.3,
    },
  },
  {
    id: 'orrfugl',
    nameNo: 'Orrfugl',
    nameEn: 'Black grouse',
    treeHeightBandM: { min: 0, peakMin: 2, peakMax: 10, max: 20 },
    treeLineBandM: null,
    disturbanceBufferM: 250,
    strongHarvest: 200,
    slopeBandPercent: { min: -1, peakMin: 0, peakMax: 25, max: 55 },
    standDistanceBandM: GENERAL_STAND_DISTANCE_M,
    weights: {
      'edge-myr': 1,
      'cover-young': 0.8,
      artfunksjon: 0.7,
      quiet: 0.5,
      'pine-mature': 0.3,
    },
  },
  {
    id: 'lirype',
    nameNo: 'Lirype',
    nameEn: 'Willow ptarmigan',
    treeHeightBandM: { min: 0, peakMin: 0, peakMax: 3, max: 8 },
    treeLineBandM: { min: -250, peakMin: -100, peakMax: 100, max: 300 },
    disturbanceBufferM: 200,
    strongHarvest: 1110,
    slopeBandPercent: { min: -1, peakMin: 0, peakMax: 30, max: 60 },
    standDistanceBandM: GENERAL_STAND_DISTANCE_M,
    weights: {
      treeline: 1,
      'cover-young': 0.7,
      'edge-myr': 0.6,
      artfunksjon: 0.5,
      water: 0.4,
      quiet: 0.4,
      slope: 0.4,
    },
  },
  {
    id: 'fjellrype',
    nameNo: 'Fjellrype',
    nameEn: 'Rock ptarmigan',
    treeHeightBandM: null,
    treeLineBandM: { min: 0, peakMin: 200, peakMax: 900, max: 1400 },
    disturbanceBufferM: 200,
    strongHarvest: 650,
    slopeBandPercent: { min: -1, peakMin: 0, peakMax: 45, max: 80 },
    standDistanceBandM: GENERAL_STAND_DISTANCE_M,
    weights: { treeline: 1, 'rocky-ridge': 0.9, slope: 0.4, artfunksjon: 0.4, quiet: 0.3 },
  },
  {
    id: 'hare',
    nameNo: 'Hare',
    nameEn: 'Mountain hare',
    treeHeightBandM: { min: 0, peakMin: 1, peakMax: 8, max: 18 },
    treeLineBandM: null,
    disturbanceBufferM: 100,
    strongHarvest: 120,
    slopeBandPercent: { min: -1, peakMin: 0, peakMax: 30, max: 60 },
    standDistanceBandM: GENERAL_STAND_DISTANCE_M,
    weights: {
      'cover-young': 1,
      'edge-farmland': 0.5,
      'edge-myr': 0.5,
      artfunksjon: 0.3,
      warmth: 0.3,
      quiet: 0.3,
    },
  },
] as const satisfies readonly Quarry[];

export type QuarryId = (typeof QUARRIES)[number]['id'];

export function quarry(id: string): Quarry | undefined {
  return QUARRIES.find((q) => q.id === id);
}

/** The name a catalog choice — and therefore a saved stand — carries for a quarry. */
export function quarryLabel(q: Quarry): string {
  return 'targetLabel' in q && q.targetLabel ? q.targetLabel : q.nameNo;
}

/**
 * The quarry a saved stand was planned for, from the label the payload kept.
 *
 * A `PlaceStand` records the *display* name rather than the catalog id, because
 * that is what a hunter reads on the card and what an export has to carry. That
 * makes this lookup the seam where a later surface can rank a stand under the
 * tactic it was actually planned for — and it returns undefined rather than a
 * default for a stand from before the roe split (whose label was just
 * "hunting"), so a caller falls back to the general model knowingly.
 */
export function quarryByLabel(label: string): Quarry | undefined {
  return QUARRIES.find((q) => quarryLabel(q) === label);
}

/**
 * Everything the app says about hunting seasons: a link and the date we last
 * checked it. No dates are restated — see the file header for why a national
 * date pair would be wrong-by-default, and `species.test.ts` for the guard.
 */
export const HUNT_SEASON_REFERENCE = {
  /** Forskrift om jakt- og fangsttider, 1 Apr 2022 – 31 Mar 2028. */
  forskriftId: 'FOR-2022-01-21-128',
  url: 'https://lovdata.no/dokument/SF/forskrift/2022-01-21-128',
  /** Seasons vary by region and kommune; the link is per-kommune truth, this file is not. */
  guidance: 'Se jakttider for kommunen',
  /** Last verified against Lovdata. Shown next to the link. */
  asOf: '2026-07-27',
  expires: '2028-03-31',
} as const;

/** The governing act. Ship links and dates, never restated rules. */
export const WILDLIFE_ACT_REFERENCE = {
  name: 'Viltressursloven',
  lawId: 'LOV-2025-06-20-102',
  url: 'https://lovdata.no/dokument/NL/lov/2025-06-20-102',
  /** In force since 1 July 2026, replacing viltloven 1981. */
  asOf: '2026-07-27',
} as const;
