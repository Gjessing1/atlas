/**
 * Transparent "conditions" model — turns a forecast step (+ the sun / time of
 * day) into a single 0..100 quality score AND the per-factor breakdown that
 * produced it. The breakdown is the point: the UI never shows a bare number,
 * it shows WHY (light, cloud, temperature, wind, rain, pressure), each with a
 * plain-language reason, so the user can agree or override with their own
 * judgement. The same shapes drive the fishing planner and the hunting card.
 *
 * Pure data + arithmetic (no network, no DOM): the caller supplies the weather
 * point and the sun altitude (from sun.ts), so this is isomorphic and
 * trivially testable. The heuristics are deliberately simple, defensible
 * angling/hunting rules of thumb — not a black box — which is exactly what
 * "transparent" means here. Species profiles are pure data (tempBand); the
 * engine never branches on a specific species.
 */
import { compass16 } from './sun.js';
import { roePhenologyAt } from './phenology.js';
import type { WeatherPoint } from './weather.js';

/** How a single factor reads right now. */
export type FactorRating = 'good' | 'fair' | 'poor';

/** One named driver of the overall score, with the reasoning shown to the user. */
export interface ConditionFactor {
  /** Stable key (`light`, `cloud`, `temp`, `wind`, `precip`, `pressure`, `thermal`, `sky`). */
  key: string;
  /** Short UI label. */
  label: string;
  /** This factor's own quality, 0..1. */
  score: number;
  /** Relative weight in the blend (renormalised over the factors actually present). */
  weight: number;
  /** Bucketed rating for colour-coding. */
  rating: FactorRating;
  /** Plain-language explanation of how this condition plays in (the transparency payload). */
  detail: string;
}

/** Overall headline rating band. */
export type ActivityRating = 'prime' | 'good' | 'fair' | 'slow';

/** The full assessment: a headline score/band plus the factor breakdown and a one-line summary. */
export interface ConditionAssessment {
  /** Weighted 0..100. */
  score: number;
  rating: ActivityRating;
  factors: ConditionFactor[];
  /** One-line takeaway naming the main driver and the main limiter. */
  summary: string;
}

function ratingFor(score: number): FactorRating {
  return score >= 0.7 ? 'good' : score >= 0.45 ? 'fair' : 'poor';
}

/** Trapezoid membership (0..1): full across [peakMin,peakMax], tapering to 0 at min/max. */
function trapezoid(x: number, min: number, peakMin: number, peakMax: number, max: number): number {
  if (x <= min || x >= max) return 0;
  if (x < peakMin) return (x - min) / (peakMin - min);
  if (x > peakMax) return (max - x) / (max - peakMax);
  return 1;
}

/** Blend present factors into 0..100 (renormalising weights), assign a band, and write a summary. */
function combine(factors: ConditionFactor[], summary: string): ConditionAssessment {
  const wsum = factors.reduce((a, f) => a + f.weight, 0) || 1;
  const score = Math.round((factors.reduce((a, f) => a + f.weight * f.score, 0) / wsum) * 100);
  const rating: ActivityRating =
    score >= 72 ? 'prime' : score >= 55 ? 'good' : score >= 40 ? 'fair' : 'slow';
  return { score, rating, factors, summary };
}

/** Auto-summary: lead with the best factor, then call out the worst if it actually drags. */
function summarise(factors: ConditionFactor[]): string {
  if (!factors.length) return '';
  const sorted = [...factors].sort((a, b) => b.score - a.score);
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;
  const lead = `${best.label.toLowerCase()} is working for you`;
  return worst.score < 0.45 && worst.key !== best.key
    ? `${cap(lead)}; ${worst.label.toLowerCase()} is the main limiter.`
    : `${cap(lead)}.`;
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Species surface-temperature comfort band (°C) for the feeding-activity factor. Trout is the default. */
function tempBand(species?: string | null): [number, number, number, number] {
  switch (species) {
    case 'perch':
      return [4, 14, 22, 30];
    case 'pike':
      return [2, 10, 20, 28];
    case 'char':
      return [0, 7, 14, 20];
    case 'trout':
    default:
      return [1, 9, 16, 22];
  }
}

/** Inputs for a fishing-bite assessment at one forecast step. */
export interface FishingConditionsInput {
  point: WeatherPoint;
  /** Sun altitude (degrees) at this step, from sun.ts — drives the light/time-of-day factor. */
  sunAltitudeDeg: number;
  /** Pressure change over the preceding few hours (hPa); negative = falling. Omit if unknown. */
  pressureTrendHpa?: number | null;
  /** Species tag (perch/pike/trout/char) for the temperature comfort band. */
  species?: string | null;
  /** Hunting-only tactic profile; ignored by the fishing model. */
  huntProfile?: HuntConditionsProfile;
  /** Hunting-only point latitude for phenology. */
  latitude?: number;
  /** Hunting-only terrain elevation for phenology. */
  elevationM?: number | null;
  /** Hunting-only ground steepness at the stand; enables the thermal factor. */
  slopeDeg?: number | null;
  /** Hunting-only downhill azimuth at the stand — the way cold air drains. */
  aspectDeg?: number | null;
}

/**
 * Assess fishing-bite quality for one forecast step, returning the score AND the factor breakdown.
 *
 * Factors (each a defensible rule of thumb):
 *  - Light (time of day) and cloud, read together as ONE condition: low sun / twilight is prime;
 *    heavy overcast tempers a high sun, a clear sky leaves even a low sun harsh.
 *  - Temperature: AIR temp read as a damped proxy for water temp (the bite driver) — cold air means
 *    cold, slow water; warm air only warms the surface, so fish drop deeper and keep feeding.
 *  - Wind: a light ripple oxygenates and drifts food to the DOWNWIND shore (where to fish); flat
 *    calm makes fish wary, strong wind makes it tough (shelter on the upwind bank). Names the bearings.
 *  - Rain: a little drizzle is a feeding trigger; a downpour colours the water and kills it.
 *  - Pressure: a falling trend (pre-front) fires the bite; a sharp rise after a front shuts it down.
 */
export function assessFishingBite(input: FishingConditionsInput): ConditionAssessment {
  const { point: p, sunAltitudeDeg: alt, pressureTrendHpa, species } = input;
  const factors: ConditionFactor[] = [];
  const add = (key: string, label: string, score: number, weight: number, detail: string): void => {
    factors.push({ key, label, score, weight, rating: ratingFor(score), detail });
  };

  // Light on the water — time of day AND cloud cover read together. They are ONE condition, not two:
  // coupling them gives a single coherent recommendation instead of a "high sun → hold deep" line
  // contradicting an "overcast → bold in the shallows" line. Cloud is the decider at high sun.
  {
    const c = p.cloud; // % cover
    const overcast = c >= 70;
    const broken = c >= 40;
    let s: number;
    let detail: string;
    if (alt <= -6) {
      s = 0.55;
      detail = 'Darkness — quiet for daytime feeders, but night specialists can still move.';
    } else if (alt <= 0) {
      // Twilight: a strong window, but not the full golden hour — very low light limits
      // sight-feeders (a midsummer 03:00 under heavy cloud reads "good", not "prime").
      s = overcast ? 0.78 : 0.82;
      detail = overcast
        ? 'Twilight under heavy cloud — low, dim light; a solid window but past the golden-hour peak.'
        : 'Twilight (sun below the horizon) — a solid low-light window approaching/leaving the peak.';
    } else if (alt <= 10) {
      // Sun on/just above the horizon — the genuine dawn/dusk golden hour.
      s = overcast ? 1 : 0.95;
      detail = overcast
        ? 'Low sun under cloud — soft, even golden-hour light; the prime feeding window.'
        : 'Low sun (dawn/dusk golden hour) — the prime feeding window.';
    } else if (alt <= 25) {
      s = overcast ? 0.85 : broken ? 0.7 : 0.58;
      detail = overcast
        ? 'Sun up but heavy overcast keeps the light soft — fish stay active and bold.'
        : broken
          ? 'Sun up with broken cloud — fair; fish the shaded, deeper edges between breaks.'
          : 'Sun getting up under a clear sky — fish the shaded and deeper edges.';
    } else {
      // High sun: cloud decides — thick overcast rescues it, a clear sky shuts the shallows down.
      s = overcast ? 0.7 : broken ? 0.5 : 0.35;
      detail = overcast
        ? 'High sun but thick overcast tempers the glare — even light keeps fish active in the shallows.'
        : broken
          ? 'High sun through broken cloud — patchy; fish hold to shade and cover between bright spells.'
          : 'High sun, clear sky — bright and harsh; fish hold deep or under cover until the light drops.';
    }
    add('light', 'Light & cloud', s, 0.42, `${Math.round(c)}% cloud. ${detail}`);
  }

  // Air temperature as a PROXY for water temperature. The two ends are NOT symmetric: cold air →
  // cold water → genuinely slow metabolism (taper to near zero); warm air → only the SURFACE warms,
  // fish drop deeper and keep feeding — a "fish deep", not a dead lake, so the warm end floors at 0.5.
  {
    const [min, pkMin, pkMax, max] = tempBand(species);
    const t = p.temp;
    let s: number;
    let detail: string;
    if (t >= pkMax) {
      s = trapezoid(t, min, pkMin, pkMax, Math.max(max, pkMax + 1)) * 0.5 + 0.5;
      detail = `${Math.round(t)}° air — surface warms but fish hold in the cooler depths; fish deep and shaded, early and late.`;
    } else {
      s = trapezoid(t, min, pkMin, pkMax, max);
      detail =
        s >= 0.7
          ? `${Math.round(t)}° air — water likely in the active feeding range.`
          : s > 0
            ? `${Math.round(t)}° air — water cool and at the edge of the range; expect a slow, deep bite.`
            : `${Math.round(t)}° air — water cold; metabolism low.`;
    }
    add('temp', 'Air temp (water proxy)', s, 0.18, detail);
  }

  // Wind. Also tells you WHERE to stand: surface drift carries food to the DOWNWIND shore (the bank
  // the wind blows TOWARD) and predators follow it in. `windFromDir` is the bearing the wind blows
  // FROM, so the productive downwind shore is the opposite bearing.
  {
    const w = p.windSpeed;
    const from = compass16(p.windFromDir);
    const downwind = compass16((p.windFromDir + 180) % 360);
    let s: number;
    let detail: string;
    if (w < 1.5) {
      s = 0.55;
      detail = `Flat calm (wind from ${from}) — no drift to concentrate food; fish wary. A surface/finesse approach at dusk works best.`;
    } else if (w <= 5) {
      s = 0.95;
      detail = `Light breeze from the ${from} — a fish-friendly ripple pushing food onto the downwind (${downwind}) shore; fish the ${downwind} bank with the wind at your back.`;
    } else if (w <= 8) {
      s = 0.6;
      detail = `Fresh wind from the ${from} — fishable but choppy; food still stacks on the downwind (${downwind}) shore, or tuck into the sheltered ${from} bank.`;
    } else {
      s = 0.3;
      detail = `Strong wind from the ${from} — tough going; shelter in the calmer ${from}-side bays.`;
    }
    add('wind', 'Wind', s, 0.18, `${Math.round(w)} m/s. ${detail}`);
  }

  // Rain.
  {
    const r = p.precip;
    let s: number;
    let detail: string;
    if (r == null || r === 0) {
      s = 0.7;
      detail = 'Dry.';
    } else if (r <= 1) {
      s = 0.9;
      detail = 'Light rain/drizzle — often a feeding trigger and welcome low light.';
    } else if (r <= 4) {
      s = 0.55;
      detail = 'Moderate rain — workable, watch for rising/colouring water.';
    } else {
      s = 0.3;
      detail = 'Heavy rain — runoff colours the water and pushes the bite off.';
    }
    add('precip', 'Rain', s, 0.1, detail);
  }

  // Pressure trend (only when we can measure it).
  if (pressureTrendHpa != null && Number.isFinite(pressureTrendHpa)) {
    const dp = pressureTrendHpa;
    let s: number;
    let detail: string;
    if (dp <= -1) {
      s = 0.95;
      detail = `Falling ${Math.abs(dp).toFixed(0)} hPa — classic pre-front feeding window.`;
    } else if (dp < 1) {
      s = 0.65;
      detail = 'Steady pressure — neutral.';
    } else {
      s = 0.5;
      detail = `Rising ${dp.toFixed(0)} hPa — the bite often slows behind a front.`;
    }
    add('pressure', 'Pressure', s, 0.12, detail);
  }

  return combine(factors, summarise(factors));
}

/** Inputs for a hunting-stand assessment at one forecast step (the active dawn/dusk window). */
export interface HuntConditionsInput {
  point: WeatherPoint;
  /** Sun altitude (degrees) at this step — drives the activity/light factor. */
  sunAltitudeDeg: number;
  /** Ground steepness (degrees) at the stand. Enables the terrain-thermal factor. */
  slopeDeg?: number | null;
  /** Downhill azimuth (0–360° clockwise from N) at the stand — the way cold air drains. */
  aspectDeg?: number | null;
  /** Tactic-specific activity model; ordinary hunting keeps the established defaults. */
  profile?: HuntConditionsProfile;
  /** Point latitude for the rut's broad north/south phenology adjustment. */
  latitude?: number;
  /** Optional terrain elevation for the rut's small altitude adjustment. */
  elevationM?: number | null;
}

export type HuntConditionsProfile = 'general' | 'roe-rut';

/**
 * Assess roe-deer stand conditions for one forecast step — the same transparency as the fishing
 * model, because wind/scent and light decide a sit far more than the map.
 *
 * Factors:
 *  - Scent (wind): the headline. A steady light wind you can keep in your face is ideal; dead calm
 *    lets your scent pool and swirl; strong wind makes deer edgy and scent unreliable.
 *  - Activity (light/time of day): roe deer move most at first and last light; bedded under high sun.
 *  - Thermal (terrain): on a slope, cold air drains DOWNHILL at first/last light (katabatic) and
 *    warm air rises UPHILL under a midday sun (anabatic); in light winds this terrain flow decides
 *    your scent. Only added when a slope is known — flat ground has no organised thermal.
 *  - Sky (rain): heavy rain pins deer in cover; dry or light cloud is fine and softens the light.
 */
export function assessHuntStand(input: HuntConditionsInput): ConditionAssessment {
  const { point: p, sunAltitudeDeg: alt, slopeDeg, aspectDeg } = input;
  const rut =
    input.profile === 'roe-rut'
      ? roePhenologyAt(new Date(p.time), input.latitude ?? 60, input.elevationM)
      : null;
  const factors: ConditionFactor[] = [];
  const add = (key: string, label: string, score: number, weight: number, detail: string): void => {
    factors.push({ key, label, score, weight, rating: ratingFor(score), detail });
  };

  // Scent / wind.
  {
    const w = p.windSpeed;
    let s: number;
    let detail: string;
    if (w < 1) {
      s = 0.4;
      detail = 'Dead calm — your scent pools and swirls; deer can wind you from any side.';
    } else if (w <= 5) {
      s = 0.95;
      detail = 'Steady light wind — keep it in your face and sit downwind of the trail.';
    } else if (w <= 9) {
      s = 0.6;
      detail = 'Fresh wind — scent carries far but swirls; deer are jumpy.';
    } else {
      s = 0.35;
      detail = 'Strong wind — deer hold bedded and scent is unreliable.';
    }
    add('wind', 'Scent (wind)', s, 0.45, `${Math.round(w)} m/s. ${detail}`);
  }

  // Activity / light.
  {
    let s: number;
    let detail: string;
    if (alt <= -8) {
      s = 0.55;
      detail = 'Dark — movement not yet started or winding down.';
    } else if (alt <= 6) {
      s = 0.95;
      detail = 'First/last light — peak roe-deer feeding movement.';
    } else if (alt <= 25) {
      s = 0.6;
      detail = 'Sun up — movement easing; watch shaded feeding edges.';
    } else if (rut) {
      s = rut.middayActivity;
      detail =
        rut.middayActivity >= 0.7
          ? `High sun, but ${rut.label.toLowerCase()} keeps bucks searching through midday.`
          : `High sun — ${rut.label.toLowerCase()} does not remove the usual bedding lull.`;
    } else {
      s = 0.4;
      detail = 'High sun — deer bedded in cover.';
    }
    add('light', 'Activity (light)', s, 0.3, detail);
  }

  if (rut) {
    const temp = p.temp;
    const temperatureScore = temp <= 12 ? 0.95 : temp <= 18 ? 0.78 : temp <= 23 ? 0.5 : 0.25;
    add(
      'temp',
      'Heat',
      temperatureScore,
      0.15,
      `${Math.round(temp)}°C — ${
        temperatureScore >= 0.75
          ? 'cool enough for sustained movement.'
          : temperatureScore >= 0.45
            ? 'warm; shaded edges and the cooler hours improve the sit.'
            : 'hot enough to suppress daytime movement; favour the coolest hours and cover.'
      }`,
    );
    add('rut', 'Calling phase', rut.calling, 0.15, `${rut.label}. ${rut.detail}`);
  }

  // Thermal (terrain-driven slope flow) — only on a defined slope. In light winds the slope's own
  // katabatic/anabatic flow rules the scent and is predictable; in strong winds the synoptic wind
  // overrides it; at the dawn/dusk changeover the flow reverses and swirls.
  if (slopeDeg != null && slopeDeg >= 3) {
    const w = p.windSpeed;
    const downhill = aspectDeg != null ? compass16(aspectDeg) : null;
    const uphill = aspectDeg != null ? compass16((aspectDeg + 180) % 360) : null;
    const draining = alt <= 6;
    const rising = alt >= 22;
    let s: number;
    let detail: string;
    if (w >= 6) {
      s = 0.6;
      detail = `${Math.round(slopeDeg)}° slope, but the fresh forecast wind (${Math.round(w)} m/s) overrides the thermals — go by the wind.`;
    } else if (draining) {
      s = w <= 3 ? 0.9 : 0.7;
      detail = downhill
        ? `Cold air drains downhill to the ${downhill} at first/last light — your scent flows that way, so sit above the deer or on the uphill flank.`
        : 'Cold air drains downhill at first/last light — keep above the deer so your scent flows away below them.';
    } else if (rising) {
      s = w <= 3 ? 0.85 : 0.7;
      detail = uphill
        ? `Midday sun lifts air uphill to the ${uphill} — your scent rises, so deer above you will wind you; work from above or across the slope.`
        : 'Midday sun lifts air uphill — your scent rises, so deer above you will wind you.';
    } else {
      s = 0.45;
      detail = `${Math.round(slopeDeg)}° slope at the thermal changeover (dawn/dusk switch) — the drift reverses and swirls; trust the forecast wind and watch for eddies.`;
    }
    add('thermal', 'Thermal (slope)', s, 0.15, detail);
  }

  // Sky / rain.
  {
    const r = p.precip;
    let s: number;
    let detail: string;
    if (r != null && r > 4) {
      s = 0.4;
      detail = 'Heavy rain — deer hold tight in cover.';
    } else if (r != null && r > 0) {
      s = 0.75;
      detail = 'Light rain — deer move and stay calm in the soft light.';
    } else {
      s = 0.8;
      detail = `${Math.round(p.cloud)}% cloud, dry — fine; cloud softens the light.`;
    }
    add('sky', 'Sky', s, 0.15, detail);
  }

  return combine(factors, summarise(factors));
}

/** Which transparent condition model a planner runs: bite quality vs scent/stand quality. */
export type ConditionsKind = 'fishing' | 'hunting';

/**
 * Dispatch one forecast step to the right assessment for a planner kind. The engine never branches
 * on a specific species: the CALLER classifies an activity into one of these two condition models.
 * `pressureTrendHpa` and `species` only feed the fishing model; the hunt model ignores them.
 *
 * `slopeDeg`/`aspectDeg` are forwarded rather than dropped, which is what makes the terrain-thermal
 * factor reachable at all: every production caller reaches the hunt model through here, and until
 * this passed them on, `assessHuntStand`'s katabatic/anabatic reasoning was tested code that no
 * user ever saw — precisely at first and last light, where under ~3 m/s the slope flow *is* the
 * wind and the light factor is calling the hour prime.
 */
export function assessConditions(
  kind: ConditionsKind,
  input: FishingConditionsInput,
): ConditionAssessment {
  return kind === 'hunting'
    ? assessHuntStand({
        point: input.point,
        sunAltitudeDeg: input.sunAltitudeDeg,
        profile: input.huntProfile,
        latitude: input.latitude,
        elevationM: input.elevationM,
        slopeDeg: input.slopeDeg,
        aspectDeg: input.aspectDeg,
      })
    : assessFishingBite(input);
}

/**
 * Pressure change (hPa) at `series[idx]` versus ~`hours` earlier — the trend the bite model wants.
 * Returns null when there isn't enough history or pressure is absent.
 */
export function pressureTrend(series: WeatherPoint[], idx: number, hours = 3): number | null {
  const cur = series[idx]?.pressure;
  if (cur == null || idx <= 0) return null;
  const t = new Date(series[idx]!.time).getTime() - hours * 3600_000;
  // Walk back to the step nearest `hours` ago that carries a pressure reading.
  let prev: number | null = null;
  for (let i = idx - 1; i >= 0; i--) {
    const step = series[i]!;
    if (step.pressure == null) continue;
    prev = step.pressure;
    if (new Date(step.time).getTime() <= t) break;
  }
  return prev == null ? null : Math.round((cur - prev) * 10) / 10;
}
