/**
 * Region build specs (ROADMAP §7.5 DR7) — what an offline pack is cut from,
 * declared rather than inferred.
 *
 * The producer used to derive its inputs from the region id and one
 * `ATLAS_PACK_SOURCE` variable: `tiles/<source>.pmtiles`,
 * `valhalla/<source>-latest.osm.pbf` with a fallback to `<source>.osm.pbf`,
 * `tiles/outdoor.pmtiles` for Norway but `tiles/outdoor-<source>.pmtiles`
 * elsewhere. Every one of those rules is invisible in the artifact it produces,
 * and a wrong-but-readable combination (a Scottish bbox cut from the Norwegian
 * overlay) yields a perfectly checksummed pack that says "no cabins here".
 *
 * A spec names all of it in one committed file per source: the master datasets,
 * which of them a pack may ship without, the bounds those masters actually
 * cover, and per region the bbox plus the search and routing points that prove
 * the result works. Parsing is strict and total — the producer validates before
 * it spends hours, so a typo fails in milliseconds rather than after the tile
 * cut.
 */

import { bboxCovers, type BBox, type LatLng } from './geo.js';

/**
 * The master datasets a pack is cut from. Fixed set rather than open-ended:
 * each one is consumed by a specific build step, so a spec inventing an eighth
 * name would silently be ignored, which is the failure this file exists to
 * remove.
 */
export const REGION_INPUT_IDS = [
  'basemap',
  'osm',
  'outdoor',
  'nvdb',
  'admins',
  'timezones',
  'assets',
] as const;

export type RegionInputId = (typeof REGION_INPUT_IDS)[number];

/**
 * The inputs no pack can be built without, whatever the source. Outdoor
 * overlays and NVDB road data are the only two with a defined absent-behaviour
 * (the app falls back to the basemap-only outdoor layers, and to plain OSM
 * speeds); a spec that made any of these optional would describe a pack that
 * cannot be produced.
 */
const ALWAYS_REQUIRED: readonly RegionInputId[] = [
  'basemap',
  'osm',
  'admins',
  'timezones',
  'assets',
];

/** One master dataset, as a path relative to the data dir. */
export interface RegionInputSpec {
  /**
   * Path relative to the data dir, or null for "this source has none". Null is
   * a statement, not an omission: Great Britain has no NVDB dataset and no
   * outdoor overlay, and saying so in the spec is what stops the producer from
   * quietly cutting a British bbox out of the Norwegian archive.
   */
  path: string | null;
  /**
   * Whether a pack may be published without it. Optional inputs are the ones
   * with a defined absent-behaviour (no outdoor overlay renders the
   * basemap-only outdoor layers; no NVDB dataset degrades to plain OSM speeds);
   * everything else is required and its absence stops the build.
   */
  required: boolean;
}

/**
 * What "this pack works" is checked against after the artifacts are built and
 * before the manifest is published. Per region because the answer is: a place
 * name the offline index must find, and two points a route must connect.
 */
export interface RegionSmokeSpec {
  /** Place names the offline search index must return at least one row for. */
  search: string[];
  /** Two points inside the region that offline routing must connect. */
  route?: { from: LatLng; to: LatLng };
}

export interface RegionSpec {
  id: string;
  name: string;
  bbox: BBox;
  smoke: RegionSmokeSpec;
}

export interface RegionBuildSpec {
  /** Source id, e.g. `norway` — also the spec's file name. */
  id: string;
  name: string;
  /**
   * What the masters cover. A region outside it would build: pmtiles and osmium
   * both happily cut an empty box, and the pack would install and show nothing.
   */
  bounds: BBox;
  /**
   * ISO 3166-1 alpha-2 codes of the countries this source's regions lie in.
   *
   * Checked against the admin database before a build starts, because a
   * country with no polygon there does not fail — its roads inherit Valhalla's
   * default admin, which drives on the left. That has gone wrong in both
   * directions on this project (384d847 made every Norwegian road
   * left-driving), and a pack is what the phone routes from abroad, where a
   * roundabout numbered off the wrong side is a surprise rather than a
   * nuisance.
   */
  countries: string[];
  inputs: Record<RegionInputId, RegionInputSpec>;
  regions: RegionSpec[];
}

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(where, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(where, 'expected a non-empty string');
  return value;
}

function num(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, 'expected a number');
  return value;
}

function latLng(value: unknown, where: string): LatLng {
  const raw = object(value, where);
  const lat = num(raw.lat, `${where}.lat`);
  const lng = num(raw.lng, `${where}.lng`);
  if (lat < -90 || lat > 90) fail(`${where}.lat`, `out of range: ${lat}`);
  if (lng < -180 || lng > 180) fail(`${where}.lng`, `out of range: ${lng}`);
  return { lat, lng };
}

function bbox(value: unknown, where: string): BBox {
  const raw = object(value, where);
  const sw = latLng(raw.sw, `${where}.sw`);
  const ne = latLng(raw.ne, `${where}.ne`);
  // An inverted box is the mistake a rectangle written by hand actually makes,
  // and it cuts empty archives rather than failing.
  if (ne.lat <= sw.lat) fail(where, `ne.lat (${ne.lat}) must be north of sw.lat (${sw.lat})`);
  if (ne.lng <= sw.lng) fail(where, `ne.lng (${ne.lng}) must be east of sw.lng (${sw.lng})`);
  return { sw, ne };
}

/** Pack ids become directory names on the server and the device. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse and validate a build spec. Throws with the path of the offending field
 * — the producer prints the message and stops, so it has to say what to fix.
 */
export function parseRegionBuildSpec(value: unknown, where = 'spec'): RegionBuildSpec {
  const raw = object(value, where);
  const id = str(raw.id, `${where}.id`);
  if (!SAFE_ID.test(id)) fail(`${where}.id`, `not a safe id: ${JSON.stringify(id)}`);
  const bounds = bbox(raw.bounds, `${where}.bounds`);

  const rawCountries = raw.countries;
  if (!Array.isArray(rawCountries) || rawCountries.length === 0) {
    fail(`${where}.countries`, 'expected at least one ISO 3166-1 alpha-2 country code');
  }
  const countries = rawCountries.map((code, index) => {
    const iso = str(code, `${where}.countries[${index}]`);
    if (!/^[A-Z]{2}$/.test(iso)) {
      fail(
        `${where}.countries[${index}]`,
        `not an ISO 3166-1 alpha-2 code: ${JSON.stringify(iso)}`,
      );
    }
    return iso;
  });

  const rawInputs = object(raw.inputs, `${where}.inputs`);
  const inputs = {} as Record<RegionInputId, RegionInputSpec>;
  for (const key of REGION_INPUT_IDS) {
    const at = `${where}.inputs.${key}`;
    const entry = object(rawInputs[key], at);
    if (typeof entry.required !== 'boolean') fail(`${at}.required`, 'expected true or false');
    const path = entry.path === null ? null : str(entry.path, `${at}.path`);
    if (path === null && entry.required) {
      fail(`${at}.path`, 'a required input cannot be null');
    }
    if (path !== null && (path.startsWith('/') || path.includes('..'))) {
      fail(`${at}.path`, `must be relative to the data dir: ${JSON.stringify(path)}`);
    }
    if (ALWAYS_REQUIRED.includes(key) && !entry.required) {
      fail(`${at}.required`, 'this input is required for every source');
    }
    inputs[key] = { path, required: entry.required };
  }
  for (const key of Object.keys(rawInputs)) {
    // A misspelt input would otherwise be a silently unused line, and the build
    // would fall back to nothing at all.
    if (!(REGION_INPUT_IDS as readonly string[]).includes(key)) {
      fail(
        `${where}.inputs.${key}`,
        `unknown input; expected one of ${REGION_INPUT_IDS.join(', ')}`,
      );
    }
  }

  const rawRegions = raw.regions;
  if (!Array.isArray(rawRegions) || rawRegions.length === 0) {
    fail(`${where}.regions`, 'expected a non-empty array');
  }
  const regions: RegionSpec[] = [];
  const seen = new Set<string>();
  for (const [index, item] of rawRegions.entries()) {
    const at = `${where}.regions[${index}]`;
    const region = object(item, at);
    const regionId = str(region.id, `${at}.id`);
    if (!SAFE_ID.test(regionId)) fail(`${at}.id`, `not a safe id: ${JSON.stringify(regionId)}`);
    if (seen.has(regionId)) fail(`${at}.id`, `duplicate region id: ${regionId}`);
    seen.add(regionId);
    const box = bbox(region.bbox, `${at}.bbox`);
    // The check that made this file worth writing: a region the masters do not
    // cover builds cleanly and ships empty.
    if (!bboxCovers(bounds, box)) {
      fail(`${at}.bbox`, `is not inside ${id}'s bounds — the masters do not cover it`);
    }
    const smokeAt = `${at}.smoke`;
    const smoke = object(region.smoke, smokeAt);
    const search = smoke.search;
    if (!Array.isArray(search) || search.length === 0) {
      fail(`${smokeAt}.search`, 'expected at least one place name to look for');
    }
    const names = search.map((name, i) => str(name, `${smokeAt}.search[${i}]`));
    let route: RegionSmokeSpec['route'];
    if (smoke.route !== undefined) {
      const rawRoute = object(smoke.route, `${smokeAt}.route`);
      const from = latLng(rawRoute.from, `${smokeAt}.route.from`);
      const to = latLng(rawRoute.to, `${smokeAt}.route.to`);
      // Routing points outside the region are not in the pack's tiles, so the
      // smoke check would fail on a pack that is in fact fine.
      for (const [label, point] of [
        ['from', from],
        ['to', to],
      ] as const) {
        if (!bboxCovers(box, { sw: point, ne: point })) {
          fail(`${smokeAt}.route.${label}`, `is outside ${regionId}'s bbox`);
        }
      }
      route = { from, to };
    }
    regions.push({
      id: regionId,
      name: str(region.name, `${at}.name`),
      bbox: box,
      smoke: { search: names, ...(route ? { route } : {}) },
    });
  }

  return { id, name: str(raw.name, `${where}.name`), bounds, countries, inputs, regions };
}

/** One region of a spec, by id. Throws listing what the spec does define. */
export function regionFromSpec(spec: RegionBuildSpec, regionId: string): RegionSpec {
  const region = spec.regions.find((candidate) => candidate.id === regionId);
  if (!region) {
    const known = spec.regions.map((candidate) => candidate.id).join(', ');
    throw new Error(`${spec.id} has no region "${regionId}" — it defines: ${known}`);
  }
  return region;
}
