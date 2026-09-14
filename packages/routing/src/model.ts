import type { BBox, LatLng } from '@atlas/core';
import type { TrackData, TrackPoint } from '@atlas/gpx';

/** Routing profiles, mapped to Valhalla costing models in the adapter. */
export type RoutingProfile = 'car' | 'bike' | 'foot' | 'hike' | 'run';

export interface RoutingProfileInfo {
  id: RoutingProfile;
  label: string;
}

/** All profiles, in display order. */
export const ROUTING_PROFILES: readonly RoutingProfileInfo[] = [
  { id: 'car', label: 'Drive' },
  { id: 'bike', label: 'Cycle' },
  { id: 'foot', label: 'Walk' },
  { id: 'hike', label: 'Hike' },
  { id: 'run', label: 'Run' },
];

/**
 * Curated Valhalla costing controls. These are route-planning preferences, not
 * raw engine JSON: every app can safely expose the same small set, and the
 * adapter remains responsible for legal values and profile applicability.
 */
export interface RoutePreferences {
  avoidFerries: boolean;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidHills: boolean;
  preferTrails: boolean;
  /** Prefer a paved route where the graph offers a reasonable alternative. */
  avoidUnpaved: boolean;
  /**
   * The vehicle being driven, when it is not an ordinary car. Driving profiles
   * only; absent means "a car", which is what the engine assumes anyway.
   */
  vehicle?: VehicleProfile | undefined;
}

/**
 * The preferences that are plain on/off switches — everything a "Customize"
 * checkbox list may offer. Derived rather than hand-listed so that adding a
 * value-carrying preference (the vehicle was the first) cannot silently land a
 * non-boolean in a checkbox.
 */
export type RoutePreferenceToggle = {
  [K in keyof RoutePreferences]-?: RoutePreferences[K] extends boolean ? K : never;
}[keyof RoutePreferences];

/**
 * A described vehicle — a motorhome, a van, anything tall or slow enough that
 * the default car assumptions produce the wrong route.
 *
 * Sent as **`auto` costing options, never `truck`**. Truck costing honours
 * `hgv=*` access tags, and those do not bind a vehicle registered as a car: on
 * a 42-route Norwegian sample truck costing diverged from `auto` on 21 % of
 * routes, worst case Voss→Lom +22.8 km via a ferry it had no reason to take,
 * and truck-with-real-dimensions was byte-identical to truck-with-tiny-
 * dimensions in every divergent case — so the cause was access, not size.
 * `auto` enforces `height` at exactly the same threshold (both pass 4.00 m and
 * detour at 4.11 m on Rv55), so staying on `auto` costs nothing. The
 * `weight`/`length`/`axle_load` fields only `truck` accepts are ones such a
 * vehicle does not need: at ~3 t and under 6 m it clears every Norwegian
 * weight (7.5/12/50 t) and length (12.4/19.5 m) limit.
 */
export interface VehicleProfile {
  /**
   * Overall height in metres, roof fittings included. The one dimension the
   * engine actually enforces — it is what keeps a route out of a tunnel or
   * under-bridge the vehicle does not clear.
   *
   * **Avoidance help, not a guarantee.** Measured 2026-08-21: NVDB publishes
   * 4841 signed height restrictions for Norway, while the OSM extract the tiles
   * are built from carries 3640 `maxheight` tags of which 2772 are usable
   * numbers. So a route being offered is not proof that every bridge on it was
   * checked, and no caller may present it as one.
   */
  heightM: number;
  /** Overall width in metres, mirrors excluded. */
  widthM: number;
  /**
   * Realistic cruising speed in km/h. Not a comfort setting: capping it changes
   * which route the engine picks, because a motorway stops earning its detour
   * once the vehicle cannot use its speed (Oslo–Trondheim is +66 min and a
   * different line at 80 km/h). It also tends to surface more alternatives, by
   * flattening the fast road's advantage.
   */
  topSpeedKph: number;
}

/**
 * Bounds for a described vehicle. These are Atlas's own sanity limits, not the
 * engine's: `auto` costing accepts 0 and 300 alike without complaint, and a
 * Valhalla 400 usually means "no route found" rather than a rejected value —
 * `height: 5` fails on Lom→Sogndal and succeeds on Oslo→Drammen.
 */
export const VEHICLE_LIMITS = {
  heightM: { min: 1, max: 5 },
  widthM: { min: 1, max: 4 },
  topSpeedKph: { min: 30, max: 130 },
} as const;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Narrow an untrusted vehicle (a restored setting, a synced record) to one the
 * engine can be asked about. Returns null when nothing usable is there, so a
 * corrupt setting falls back to "an ordinary car" rather than to a silently
 * wrong height.
 */
export function normalizeVehicle(value: unknown): VehicleProfile | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const num = (key: string): number | null => {
    const v = raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const heightM = num('heightM');
  const widthM = num('widthM');
  const topSpeedKph = num('topSpeedKph');
  // Height is the field with consequences; without it there is no profile.
  if (heightM === null) return null;
  return {
    heightM: clamp(heightM, VEHICLE_LIMITS.heightM.min, VEHICLE_LIMITS.heightM.max),
    widthM: clamp(widthM ?? 2, VEHICLE_LIMITS.widthM.min, VEHICLE_LIMITS.widthM.max),
    topSpeedKph: clamp(
      topSpeedKph ?? 80,
      VEHICLE_LIMITS.topSpeedKph.min,
      VEHICLE_LIMITS.topSpeedKph.max,
    ),
  };
}

/** Atlas defaults, including the long-standing ferry avoidance off the road network. */
export function defaultRoutePreferences(profile: RoutingProfile): RoutePreferences {
  return {
    avoidFerries: profile !== 'car',
    avoidHighways: false,
    avoidTolls: false,
    avoidHills: false,
    preferTrails: false,
    avoidUnpaved: false,
  };
}

/** Which way a synthesized loop should travel around its start. */
export type RoundTripDirection = 'either' | 'clockwise' | 'counterclockwise';

/**
 * Narrow an untrusted string (a share link's hash, a restored setting) to a
 * profile this build knows — anything else must not reach the routing API.
 */
export function isRoutingProfile(value: unknown): value is RoutingProfile {
  return typeof value === 'string' && ROUTING_PROFILES.some((p) => p.id === value);
}

/** A route request in app terms, decoupled from the Valhalla wire format. */
export interface RouteQuery {
  profile: RoutingProfile;
  /** Waypoints in visiting order. Two or more — except round trips, which take exactly one. */
  points: LatLng[];
  /** Ask for alternative paths (Valhalla supports this for 2-point queries only). */
  alternatives?: boolean;
  /** Ask for turn-by-turn instructions (needed for navigation; off by default). */
  instructions?: boolean;
  /**
   * Ask the platform adapter for sampled elevation and surface attribution.
   * This is an Atlas-only flag and is never sent in the Valhalla request.
   */
  details?: boolean;
  /**
   * Travel direction (deg, 0 = north) at the first waypoint. Navigation
   * reroutes pass the current course so the new route continues the way the
   * vehicle is already pointing instead of proposing a U-turn.
   */
  headingDeg?: number;
  /** User-facing costing controls, normalised by {@link defaultRoutePreferences}. */
  preferences?: Partial<RoutePreferences>;
  /**
   * Points the route must not pass through: Valhalla drops the graph edge
   * nearest each one before searching, so a route is forced around it. This is
   * the mechanism road closures use — one point on each closed segment (fed from
   * the DATEX closure feed), independent of any user preference. Ordinary
   * planning leaves this empty. Valhalla caps the list at its
   * `max_exclude_locations` (default 50); callers that could exceed that must
   * trim to the closures near the corridor.
   */
  excludeLocations?: LatLng[];
  /** Loop from-and-back-to the single starting point, aiming for the given length. */
  roundTrip?: {
    distanceM: number;
    /** Vary the seed to get a different loop for the same distance. */
    seed?: number;
    /** Hold the loop's travel direction while varying its shape. */
    direction?: RoundTripDirection;
  };
}

/**
 * One turn-by-turn maneuver along a path. `sign` is Atlas's turn code
 * (numbering inherited from GraphHopper: …-2 left, -1 slight left, 0 continue,
 * 1 slight right, 2 right…; 4 = finish, 5 = via reached, 6 = roundabout,
 * ±7 keep right/left, ±8 u-turn). `interval` is the inclusive
 * `[start, end]` index range into `RoutePath.points` that this maneuver spans —
 * the turn itself happens at `points[start]`.
 */
export interface RouteInstruction {
  text: string;
  distanceM: number;
  timeMs: number;
  sign: number;
  streetName?: string;
  interval: [number, number];
  /**
   * How much of this maneuver's `timeMs` is measured congestion rather than
   * the engine's schedule — this leg's share of `RoutePath.trafficDelayMs`,
   * and like it **already included** in `timeMs`.
   *
   * Recorded per maneuver, not just per route, because a delay only stays
   * honest while it can be *removed*: re-pricing a route mid-drive means
   * dropping the measurement it was built with and applying the current one,
   * and navigation can only say how much of the *remaining* time is traffic if
   * it knows which legs the jam sits on.
   */
  trafficDelayMs?: number;
  /** Which exit to take, for roundabout maneuvers (`sign === 6`). */
  exitNumber?: number;
  /**
   * How far the roundabout turns the traveller, in degrees relative to the
   * approach road (−180…180, negative = left/anticlockwise of straight on).
   * Measured from the route geometry, because the exit *number* says nothing
   * about the direction: the 2nd exit can be straight on, hard right or back
   * the way you came. Icons draw the exit arrow at this angle. Roundabout
   * maneuvers only, and absent when the geometry is too short to measure.
   */
  exitAngleDeg?: number;
  /**
   * Which side of the road the traveller drives on here, measured from the
   * roundabout itself rather than looked up per country: traffic circulates
   * anticlockwise where you drive on the right and clockwise where you drive
   * on the left, so the way the ring bends *is* the answer.
   *
   * Icons need it because the exit *number* counts arms in circulation order,
   * which mirrors with the driving side: the exits passed before yours lie to
   * the right in Norway and to the left in the UK. Being measured per
   * roundabout, it stays right across a border and needs no admin data.
   * Roundabout maneuvers only, and absent when the traversed arc is too short
   * or too straight to give a confident sign.
   */
  drivingSide?: 'left' | 'right';
  /**
   * Refines the coarse `sign` for maneuvers it flattens: a highway on-ramp,
   * a highway exit, a keep-at-fork, a merge (all otherwise just ±7/0), or
   * boarding a `ferry` (sign 0 — a leg to ride, not a turn). UIs may render
   * these with distinct icons; absent for plain turns.
   */
  kind?: 'ramp' | 'exit' | 'keep' | 'merge' | 'ferry';
  /**
   * Motorway junction signage for a ramp/exit/keep, straight off the road
   * signs: exit number(s), the route branches the ramp carries, and the places
   * it is signed toward. Present only when the router supplies it; render with
   * `formatExitSign`.
   */
  exitSign?: ExitSign;
  /**
   * Router-authored text for spoken guidance. These phrases are deliberately
   * separate from `text`: Valhalla shortens the immediate cue, includes road
   * references and exit numbers in the pre-turn cue, and may append a close
   * following maneuver itself. Navigation should prefer these over rebuilding
   * speech from the display instruction.
   */
  verbal?: VerbalInstruction;
  /**
   * Left-to-right lane guidance for the approach to this maneuver. Valhalla
   * only includes it when the route request opts in and the source road has
   * `turn:lanes`; absent is the normal international/coverage fallback.
   */
  lanes?: RouteLane[];
}

/** One direction painted in a turn lane, normalised from Valhalla's bit mask. */
export type LaneDirection =
  | 'none'
  | 'straight'
  | 'sharp-left'
  | 'left'
  | 'slight-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'u-turn'
  | 'merge-left'
  | 'merge-right';

/** One physical lane, ordered left-to-right across the carriageway. */
export interface RouteLane {
  /** Every direction the lane permits (a lane can allow both straight and right). */
  directions: LaneDirection[];
  /**
   * `active` is Valhalla's preferred carrying lane, `valid` is another lane
   * that safely carries the maneuver, and `invalid` must be visually dimmed.
   */
  state: 'active' | 'valid' | 'invalid';
  /** The direction within a multi-direction lane that carries this maneuver. */
  recommendedDirection?: LaneDirection;
}

/** Purpose-built spoken variants attached to one Valhalla maneuver. */
export interface VerbalInstruction {
  /** Short cue for the instant of the maneuver (for example, "Turn right"). */
  succinct?: string;
  /** Early warning that prepares the traveller for the maneuver. */
  alert?: string;
  /** Full cue intended immediately before the maneuver. */
  pre?: string;
  /** Confirmation intended immediately after completing the maneuver. */
  post?: string;
  /** Valhalla already appended the next maneuver to `pre` (and often `succinct`). */
  multiCue?: boolean;
}

/** The parts of a motorway exit sign — any subset may be present. */
export interface ExitSign {
  /** Exit number(s), e.g. `["43"]` or `["23A", "23B"]`. */
  numbers?: string[];
  /** Route branches the exit carries, e.g. `["E6", "Rv4"]`. */
  branches?: string[];
  /** Destinations the exit is signed toward, e.g. `["Oslo", "Gardermoen"]`. */
  toward?: string[];
}

/**
 * A one-line exit label from an `ExitSign`, road-sign order:
 * `"Exit 43 · E6 · Oslo"`. Each segment is dropped when absent; returns `""`
 * for an empty sign so callers can treat it as "nothing to show".
 */
export function formatExitSign(sign: ExitSign): string {
  const parts: string[] = [];
  if (sign.numbers?.length) parts.push(`Exit ${sign.numbers.join('/')}`);
  if (sign.branches?.length) parts.push(sign.branches.join(' / '));
  if (sign.toward?.length) parts.push(sign.toward.join(', '));
  return parts.join(' · ');
}

/** One routable path (the primary route or an alternative). */
export interface RoutePath {
  /** Geometry with elevation when the server has DEM data. */
  points: TrackPoint[];
  distanceM: number;
  /** Travel time — the ETA is `departure + timeMs`. */
  timeMs: number;
  ascentM: number;
  descentM: number;
  bbox?: BBox;
  /** Turn-by-turn maneuvers, present only when the query asked for instructions. */
  instructions?: RouteInstruction[];
  /**
   * The path boards a ferry. Only knowable when instructions were requested —
   * absent does not prove a route is ferry-free. Worth a flag of its own
   * because a ferry leg is timetabled: it is the one part of a road route the
   * traveller cannot start whenever they like.
   */
  hasFerry?: boolean;
  /**
   * OSM/Valhalla road attributes aligned to distance along this path. Planner
   * routes fill these for the surface breakdown; navigation consumes the same
   * shape through RouteEnrichment.
   */
  enrichment?: RouteEnrichment;
  /**
   * How much of `timeMs` is measured congestion rather than the engine's own
   * schedule. Set from NPRA's corridor travel times where the route runs
   * on a measured stretch, and **already included in `timeMs`** — it is the
   * part a UI may name, not a number to add on. Absent means no measurement
   * covered this route, which is the normal case outside the Norwegian
   * corridors and everywhere without a live traffic feed.
   */
  trafficDelayMs?: number;
  /** Route-matched NPRA road observations/forecasts that indicate ice risk. */
  roadWeather?: RoadWeatherRoute;
}

/** One risky road-weather point at the time this route is expected to reach it. */
export interface RoadWeatherWarning {
  /** The station's id — stable while its reading refreshes, so one hazard is announced once. */
  id: string;
  stationName: string;
  roadNumber: string;
  position: LatLng;
  /** Distance from the route start to the nearest point, in metres. */
  atM: number;
  /** Distance from the weather point to the routed line. */
  offsetM: number;
  validAt: string;
  source: 'measured' | 'forecast';
  risk: 'possible' | 'high';
  surfaceTemperatureC?: number;
  condition?: string;
}

/** Coverage and warnings from one route-weather check. Empty warnings means checked, not safe. */
export interface RoadWeatherRoute {
  checkedAt: string;
  matchedSites: number;
  warnings: RoadWeatherWarning[];
}

/** Road attributes that hold over one stretch of a routed path. */
export interface RouteEnrichmentSegment {
  startM: number;
  endM: number;
  speedLimitKph?: number;
  tunnel?: boolean;
  roadClass?: string;
  name?: string;
  /** Valhalla surface value (`paved_smooth`, `gravel`, `dirt`, …). */
  surface?: string;
}

/** Road attributes for a whole route, ordered by start distance. */
export interface RouteEnrichment {
  segments: RouteEnrichmentSegment[];
}

/** A successful routing response: the primary path first, then alternatives. */
export interface RouteResult {
  paths: RoutePath[];
}

/** Convert a routed path to track data, e.g. for GPX export or an elevation profile. */
export function routePathToTrackData(path: RoutePath, name: string): TrackData {
  return { name, segments: [path.points], waypoints: [] };
}

/**
 * One curated costing control, as both clients offer it.
 *
 * Lived as a hand-copied `CUSTOM_OPTIONS` array in each client's RoutePanel
 * until v0.173.0 — the same drift `SETTINGS_SECTIONS` was moved here to end.
 * Two copies of a list this small is not a maintenance cost, it is a
 * correctness one: a preference offered on one client and not the other routes
 * two devices differently from the same plan.
 */
export interface RouteOptionInfo {
  readonly key: RoutePreferenceToggle;
  /**
   * The full sentence, for an accessible name and any list with room for it.
   * Says what turning it on *does*, which the chip has no space to.
   */
  readonly label: string;
  /**
   * The chip's own text, where the row's width is the constraint.
   *
   * Phrased as the constraint the route is under rather than the thing being
   * avoided: a lit chip reading "Ferries" is genuinely ambiguous about whether
   * ferries are wanted or refused, and that ambiguity is expensive on a route
   * that is about to put a vehicle on a boat.
   */
  readonly chipLabel: string;
  /** The profiles this control is offered for; it is meaningless elsewhere. */
  readonly profiles: readonly RoutingProfile[];
}

/**
 * Every costing control, in the order both clients show them.
 *
 * A key may appear more than once when the same Valhalla option means
 * genuinely different things to different travellers — never more than once
 * per profile, which is all {@link routeOptionsFor} ever returns. `use_highways`
 * is the case: for a driver it drops motorways and the fast main roads that
 * behave like them, for a cyclist it is `use_roads: 0.05`, which is not a
 * refusal of anything but a preference for quiet ones. Calling both of those
 * "No main roads" (as v0.173.0 did) described neither.
 */
export const ROUTE_OPTIONS: readonly RouteOptionInfo[] = [
  {
    key: 'avoidFerries',
    label: 'Avoid ferries',
    chipLabel: 'No ferries',
    profiles: ['car'],
  },
  {
    key: 'avoidHighways',
    label: 'Avoid motorways and other fast main roads',
    chipLabel: 'No motorways',
    profiles: ['car'],
  },
  {
    key: 'avoidHighways',
    label: 'Prefer quiet roads over main ones',
    chipLabel: 'Quiet roads',
    profiles: ['bike'],
  },
  {
    key: 'avoidTolls',
    // A preference, not a promise: Valhalla weights tolls heavily but will
    // still use one where the alternative is unreasonable (Oslo → Trondheim
    // avoiding tolls is +34 km and still passes a toll point), and Norway's
    // urban toll rings are unavoidable by construction. Saying "avoid" rather
    // than "no tolls" in the sentence keeps that honest; the chip has no room.
    label: 'Avoid toll roads where there is a reasonable alternative',
    chipLabel: 'No tolls',
    profiles: ['car'],
  },
  {
    key: 'avoidHills',
    label: 'Prefer flatter ways',
    chipLabel: 'Flatter',
    profiles: ['bike', 'foot', 'hike', 'run'],
  },
  {
    key: 'preferTrails',
    label: 'Prefer trails',
    chipLabel: 'Trails',
    profiles: ['bike', 'hike', 'run'],
  },
  {
    key: 'avoidUnpaved',
    label: 'Avoid unpaved surfaces',
    chipLabel: 'Paved',
    profiles: ['bike'],
  },
];

/** The costing controls that mean something for a profile, in display order. */
export function routeOptionsFor(profile: RoutingProfile): readonly RouteOptionInfo[] {
  return ROUTE_OPTIONS.filter((option) => option.profiles.includes(profile));
}

/** What the collapsed options button says, and what it is worth opening for. */
export interface RouteOptionsSummary {
  /** Constraints in force: this profile's costing toggles, plus the loop. */
  readonly count: number;
  /** The button's own words — narrow enough to share a row on a phone. */
  readonly label: string;
  /** The accessible name: what the button opens, and what is set behind it. */
  readonly ariaLabel: string;
  /** Every constraint in force, in display order — for the accessible name. */
  readonly active: readonly string[];
}

/**
 * Fold the route's terms into one button's worth of text.
 *
 * The chips they summarise are unchanged behind it: v0.173.0's finding — that a
 * lit chip reading "Ferries" is genuinely ambiguous about whether ferries are
 * wanted or refused — is exactly why the collapsed button *names the constraint*
 * when there is only one rather than showing a count of anonymous settings.
 * Past one it falls back to the count, because the row it sits in also carries
 * "My location" and, when driving, the vehicle: two joined constraints
 * ("No ferries · No motorways") wrap that row on a phone, and re-introducing a
 * band of chrome above the stops is the thing this fold exists to undo.
 *
 * Shared rather than written twice so the two clients cannot describe the same
 * plan differently — the same reason the chip list itself moved here.
 */
export function routeOptionsSummary(
  profile: RoutingProfile,
  preferences: RoutePreferences,
  roundTrip: boolean,
): RouteOptionsSummary {
  const active = routeOptionsFor(profile)
    .filter((option) => preferences[option.key])
    .map((option) => option.chipLabel);
  if (roundTrip) active.push('Round trip');
  const label = active.length === 0 ? 'Options' : (active[0] ?? 'Options');
  return {
    count: active.length,
    label: active.length > 1 ? `Options · ${active.length}` : label,
    ariaLabel:
      active.length === 0 ? 'Route options' : `Route options: ${active.join(', ').toLowerCase()}`,
    active,
  };
}

/**
 * One secondary action of the planner's toolbar.
 *
 * The row used to be the same six buttons for every profile, at one weight:
 * Reverse, Optimize, Clear, Save track, Export GPX, Share — a strip that asked
 * a driver to read past GPX export to reach Clear, and a hiker to read past
 * Optimize to reach the export that is the whole point of planning a walk.
 * Each routing type now gets an intentional toolbar: nothing is removed; what
 * changes is which actions a mode shows without being asked.
 */
export type RouteActionKey =
  'alongRoute' | 'saveTrack' | 'exportGpx' | 'reverse' | 'optimize' | 'clear' | 'share';

export interface RouteActionInfo {
  readonly key: RouteActionKey;
  /** The button's own words, on both clients. */
  readonly label: string;
  /**
   * The profiles that keep this action in the visible row. Everywhere else it
   * folds under "More" — still one tap away, never gone, because a planner
   * that *hides* a capability per mode is worse than one that lists them all.
   */
  readonly primary: readonly RoutingProfile[];
}

/** Every profile — for the actions that are constant whatever is being planned. */
const EVERY_PROFILE: readonly RoutingProfile[] = ROUTING_PROFILES.map((p) => p.id);

/** Walking in all its shapes, which want the same toolbar. */
const ON_FOOT: readonly RoutingProfile[] = ['foot', 'hike', 'run'];

/**
 * Every secondary action, in the order both clients show them — mode-specific
 * first, then the two that mean the same thing in every mode.
 *
 * Availability is *not* here: whether an action can act (Reverse needs two
 * ends, Optimize a tour to shorten, the exports a computed path) is state the
 * clients already hold, and an action that cannot act is absent from both rows
 * rather than folded into "More". This list decides placement only.
 */
export const ROUTE_ACTIONS: readonly RouteActionInfo[] = [
  // Fuel, charging and rest areas are what a driving plan is edited for after
  // the ends are set; on foot the same browser offers cafés and viewpoints,
  // which is a detour worth taking but not the reason the panel is open.
  { key: 'alongRoute', label: 'Stops along route', primary: ['car'] },
  // A planned walk is a thing you keep; a planned drive is a thing you do.
  { key: 'saveTrack', label: 'Save track', primary: ON_FOOT },
  // The reason a bike or hiking route is planned on a desktop at all: it has
  // to reach the device that will be carried.
  { key: 'exportGpx', label: 'Export GPX', primary: ['bike', ...ON_FOOT] },
  // "Now get me home" — the commonest edit to a drive, and to a ride out.
  { key: 'reverse', label: 'Reverse', primary: ['car', 'bike'] },
  // Only ever offered on a four-stop tour, which is rare in every mode.
  { key: 'optimize', label: 'Optimize', primary: [] },
  { key: 'clear', label: 'Clear', primary: EVERY_PROFILE },
  { key: 'share', label: 'Share', primary: EVERY_PROFILE },
];

/** The toolbar for one profile: what it shows, and what folds under "More". */
export interface RouteToolbar {
  primary: readonly RouteActionInfo[];
  more: readonly RouteActionInfo[];
}

/** Split the actions into the visible row and the fold, in display order. */
export function routeActionsFor(profile: RoutingProfile): RouteToolbar {
  return {
    primary: ROUTE_ACTIONS.filter((action) => action.primary.includes(profile)),
    more: ROUTE_ACTIONS.filter((action) => !action.primary.includes(profile)),
  };
}

/**
 * The vehicle chip's text: what is being routed for, short enough for a chip.
 *
 * Null outside driving and while no vehicle is described, because the chip is
 * then not worth a slot — an ordinary car is what the engine already assumes.
 * Formatted here rather than in either client so the two cannot round the same
 * height differently.
 */
export function vehicleChipLabel(
  profile: RoutingProfile,
  vehicle: VehicleProfile | null | undefined,
): string | null {
  if (profile !== 'car') return null;
  const clean = normalizeVehicle(vehicle);
  if (!clean) return null;
  // Metric and hand-formatted, like every other measurement Atlas prints.
  const height = clean.heightM.toFixed(2).replace(/\.?0+$/, '');
  return `${height} m · ${Math.round(clean.topSpeedKph)} km/h`;
}
