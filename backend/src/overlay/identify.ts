import { haversineM, type LatLng } from '@atlas/core';
import type { OverlayContext } from './context.js';
import { optionGetMapParams, optionKeeps, optionQueryLayers, resolveOptions } from './options.js';
import { tileCoords, wmsBaseParams } from './wms.js';

/**
 * Tap-to-identify: a GetFeatureInfo proxy with a multi-format fallback
 * (geojson → GML → ESRI text/xml → text/plain; a ServiceException body means
 * "this server doesn't speak that format, try the next").
 *
 * The parsers below are the part with real edge cases, so they are plain
 * functions over a response body — testable without booting Fastify.
 */

/**
 * A feature one dialect answered with: its cleaned attributes, and where it is
 * *when the dialect says* — which most of them don't (see {@link parseGmlInfo}).
 */
export interface IdentifyFeature {
  props: Record<string, string>;
  /** Degrees, in the upstream's own extent — a point has min === max. */
  bounds?: FeatureBounds;
}

/** A feature's extent in degrees. */
export interface FeatureBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Upstream attribute keys that are noise, not information.
 *
 * `ltema` is deliberately *not* here, though it is pure bookkeeping to a reader:
 * on NVE's river network it is the only field that separates a real channel from
 * the lake centreline drawn through the same water, so `identifyKeep` has to be
 * able to see it. Hiding a code from the *card* is `identifyFields`' job — this
 * list runs first and would delete the evidence before anything can filter on
 * it. Every layer that identifies and could return `ltema` carries an
 * `identifyFields` allow-list, so nothing shows it.
 *
 * A layer that *names* a field in `identifyFields` overrides this list (see the
 * `keep` argument below). Without that escape the two mechanisms disagree
 * silently: Kartverket's wrecks carry their whole classification in `objtype`
 * ("Vrak" / "HefteUrenBunn"), so a tap on a nameless wreck was answering with a
 * bare depth in metres and nothing to say what lay there.
 */
const NOISE_KEYS =
  /^(objectid|objtype|fid|gml_id|globalid|boundedby|bbox|styleurl|se_anno_cad_data|shape([._].*)?|geometri.*|symbol.*|opphav|kopidato|oppdateringsdato|datauttaksdato|malemetode|noyaktighet)$/i;

/**
 * `-1` is the "not measured" sentinel across NVE's depth attributes (a lake with
 * a surveyed max depth still reports `middeldyp=-1` and `volum_Mm3=-1` when only
 * the maximum was read off the paper chart). Passing it through would render as
 * "middeldyp: -1" — a depth of minus one metre, which is worse than saying
 * nothing. No layer we identify has a genuine -1, so drop it outright.
 */
const UNKNOWN_SENTINEL = /^-1(\.0+)?$/;

/**
 * XML entities back to text, for the two dialects that carry them.
 *
 * A URL is where this bites: NGU's geosite fact sheet arrives as
 * `…?lang=nor&amp;p_objid=14129`, and a link with a literal `&amp;` in it opens
 * the wrong page (or none). Numeric references are decoded too, since ESRI
 * escapes apostrophes that way.
 */
export function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-f]+));/gi,
    (whole, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
      if (name) {
        const named: Record<string, string> = {
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
        };
        return named[name.toLowerCase()] ?? whole;
      }
      const code = dec ? Number(dec) : Number.parseInt(hex ?? '', 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    },
  );
}

/** Lowercased `identifyFields`, the set NOISE_KEYS may not delete. */
export function keepSet(fields: string[] | undefined): ReadonlySet<string> {
  return new Set((fields ?? []).map((field) => field.toLowerCase()));
}

export function cleanProps(
  props: Record<string, unknown>,
  keep: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (NOISE_KEYS.test(key) && !keep.has(key.toLowerCase())) continue;
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!text || text.toLowerCase() === 'null') continue;
    if (UNKNOWN_SENTINEL.test(text)) continue;
    out[key] = text.slice(0, 200);
  }
  return out;
}

/**
 * Narrow identify attributes to `identifyFields`, in that order. Anything not
 * listed is dropped; a feature left with nothing is dropped by the caller.
 */
export function selectFields(
  props: Record<string, string>,
  fields: string[] | undefined,
): Record<string, string> {
  if (!fields || fields.length === 0) return props;
  const byLower = new Map(
    Object.entries(props).map(([k, v]) => [k.toLowerCase(), [k, v] as const]),
  );
  const out: Record<string, string> = {};
  for (const want of fields) {
    const hit = byLower.get(want.toLowerCase());
    if (hit) out[hit[0]] = hit[1];
  }
  return out;
}

/**
 * Turn the upstream's database spelling into something readable: decode coded
 * values first, then rename the keys (see `identifyLabels`/`identifyValues`).
 *
 * Runs after `selectFields`, so it only ever sees the handful of attributes a
 * layer chose to show. A field with no mapping passes through untouched — the
 * catalog names what it knows how to translate and stays silent about the rest,
 * which is what keeps an unannotated layer working exactly as before.
 *
 * Decoding a value to the **empty string drops the row**. Government layers
 * carry per-field "not relevant" sentinels for the attributes that don't apply
 * to a polygon's class (AR5 answers `98` on tree species and site quality for
 * every lake, bog and field), and a card whose visible content is three rows of
 * "not relevant" is worse than one that just says what it knows.
 */
export function presentFields(
  props: Record<string, string>,
  labels: Record<string, string> | undefined,
  values: Record<string, Record<string, string>> | undefined,
  formats?: Record<string, IdentifyFormat>,
  tokens?: Record<string, Record<string, string>>,
): Record<string, string> {
  if (!labels && !values && !formats && !tokens) return props;
  const lower = <T>(map: Record<string, T> | undefined) =>
    new Map(Object.entries(map ?? {}).map(([k, v]) => [k.toLowerCase(), v] as const));
  const labelBy = lower(labels);
  const valueBy = lower(values);
  const formatBy = lower(formats);
  const tokenBy = lower(tokens);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    const k = key.toLowerCase();
    // Numbers arrive as "1" or "1.0" depending on the identify dialect, so a
    // code lookup that missed by a trailing ".0" would silently show the raw
    // number — the exact failure this exists to prevent.
    const codes = valueBy.get(k);
    const dictionary = tokenBy.get(k);
    const decoded = dictionary
      ? translateTokens(value, dictionary)
      : (codes?.[value] ?? codes?.[value.replace(/\.0+$/, '')] ?? value);
    // After the format, not before: a formatter may itself decide a value says
    // nothing (an area of 0 km², a number that is not one), and a labelled row
    // with an empty value is worse than no row.
    const shown = applyFormat(decoded, formatBy.get(k));
    if (shown === '') continue;
    out[labelBy.get(k) ?? key] = shown;
  }
  return out;
}

/** Presentation formats for upstream encodings that are not readable text. */
export type IdentifyFormat = 'nve-date' | 'esri-datetime' | 'number';

function applyFormat(value: string, format: IdentifyFormat | undefined): string {
  if (format === 'nve-date') return formatNveDate(value);
  if (format === 'esri-datetime') return formatEsriDateTime(value);
  if (format === 'number') return formatNumber(value);
  return value;
}

/**
 * A measurement, cut to two decimals.
 *
 * These registers store a computed number and publish all of it: NVE's glacier
 * outlines answer `543.192344` km², which is six decimals of a figure whose
 * *first* one is an argument about where the ice ends. Anything that is not a
 * number is left alone — the same field can hold "Null" or a range.
 */
export function formatNumber(value: string): string {
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed) || value.trim() === '') return value;
  return String(Math.round(parsed * 100) / 100);
}

/**
 * Translate a *list* held in one attribute, token by token (see
 * `identifyTokens`). Unknown tokens survive in title case rather than being
 * dropped: the dictionary is the upstream's vocabulary as measured, and a
 * species it has since added must still reach the reader.
 *
 * A token that maps to the empty string is dropped, which is what the junk in a
 * hand-typed list needs — Fiskeridirektoratet's species strings contain the
 * Norwegian word "OG" ("and") and a literal "0".
 */
export function translateTokens(value: string, dictionary: Record<string, string>): string {
  const lower = new Map(Object.entries(dictionary).map(([k, v]) => [k.toLowerCase(), v] as const));
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of value.split(/[\s,]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const mapped = lower.get(token.toLowerCase());
    if (mapped === '') continue;
    const word = mapped ?? token.charAt(0) + token.slice(1).toLowerCase();
    if (seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    words.push(word);
  }
  if (words.length === 0) return '';
  const joined = words.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * ESRI's WMS identify writes datetimes in US order with a 12-hour clock
 * (`3/10/2015 7:57:00 AM`), which is both ambiguous to a Norwegian reader and
 * the opposite of every other date this app prints. Reformat to
 * `YYYY-MM-DD HH:MM`, and keep anything unrecognised verbatim rather than
 * inventing a reading of it.
 */
export function formatEsriDateTime(value: string): string {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?)?$/i.exec(
      value.trim(),
    );
  if (!match) return value;
  const [, month, day, year, hour, minute, meridiem] = match;
  const pad = (n: string) => n.padStart(2, '0');
  const date = `${year}-${pad(month!)}-${pad(day!)}`;
  if (!hour) return date;
  let h = Number(hour);
  if (meridiem?.toUpperCase() === 'PM' && h < 12) h += 12;
  if (meridiem?.toUpperCase() === 'AM' && h === 12) h = 0;
  return `${date} ${String(h).padStart(2, '0')}:${minute}`;
}

/**
 * NVE's SvekketIs service exposes historic `dato_dig` values in two orderings:
 * conventional YYYYMMDD (`20060217`) and Norwegian YYYYDDMM (`20211811`).
 * Prefer YYYYMMDD when both are plausible, fall back to YYYYDDMM when only that
 * forms a real date, and keep malformed values verbatim rather than inventing.
 */
export function formatNveDate(value: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return value;
  const year = Number(match[1]);
  const a = Number(match[2]);
  const b = Number(match[3]);
  const valid = (month: number, day: number) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  };
  if (valid(a, b)) return `${match[1]}-${match[2]}-${match[3]}`;
  if (valid(b, a)) return `${match[1]}-${match[3]}-${match[2]}`;
  return value;
}

/**
 * Whether an identify result is one of the features the layer actually draws
 * (see `identifyKeep`). Matched case-insensitively on the field name — the same
 * attribute is `ltema` over the REST service and `LTEMA` in ESRI's identify —
 * and exactly on the value, since these are codes.
 */
export function keepsIdentify(
  keep: { field: string; values: string[] } | undefined,
  props: Record<string, string>,
): boolean {
  if (!keep || keep.values.length === 0) return true;
  const hit = Object.entries(props).find(([key]) => key.toLowerCase() === keep.field.toLowerCase());
  return hit ? keep.values.includes(hit[1]) : true;
}

/**
 * Bounds around every coordinate pair in a GeoJSON geometry, whatever its type
 * — the nesting differs per type and only the leaves matter here.
 *
 * ArcGIS is the reason this tolerates a missing geometry rather than assuming
 * one: its `application/geo+json` identify answers `"geometry": null` on every
 * feature (measured against NVE's slide register), so a layer served by ArcGIS
 * has no position to offer no matter which dialect it is asked in.
 */
export function geojsonBounds(geometry: unknown): FeatureBounds | undefined {
  if (!geometry || typeof geometry !== 'object') return undefined;
  const coords = (geometry as { coordinates?: unknown }).coordinates;
  const points: [number, number][] = [];
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      points.push([node[0], node[1]]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(coords);
  return boundsOf(points.map(([lng, lat]) => ({ lat, lng })));
}

/** Bounds around a set of points, or `undefined` for none. */
export function boundsOf(points: readonly LatLng[]): FeatureBounds | undefined {
  if (points.length === 0) return undefined;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  return {
    west: Math.min(...lngs),
    south: Math.min(...lats),
    east: Math.max(...lngs),
    north: Math.max(...lats),
  };
}

/** Web-mercator metres back to degrees (the CRS every request here asks for). */
export function mercatorToLatLng(x: number, y: number): LatLng {
  return {
    lng: (x / 20037508.342789244) * 180,
    lat:
      (180 / Math.PI) *
      (2 * Math.atan(Math.exp(((y / 20037508.342789244) * 180 * Math.PI) / 180)) - Math.PI / 2),
  };
}

export function parseGeojsonInfo(
  body: string,
  keep: ReadonlySet<string> = new Set(),
): IdentifyFeature[] | null {
  try {
    const json = JSON.parse(body) as {
      features?: { properties?: Record<string, unknown>; geometry?: unknown }[];
    };
    if (!Array.isArray(json.features)) return null;
    return json.features.map((f) => ({
      props: cleanProps(f.properties ?? {}, keep),
      bounds: geojsonBounds(f.geometry),
    }));
  } catch {
    return null;
  }
}

/**
 * Crude but serviceable GML reader: leaf elements become key/value pairs,
 * grouped per feature on featureMember/*_feature boundaries (covers both
 * MapServer msGMLOutput and ArcGIS WMS GML dialects).
 *
 * Element names are matched on Unicode letters for the same reason the ESRI
 * reader is: a Norwegian field name is a legal XML element name, and an ASCII
 * `\w` pattern would quietly capture the tail of one as if it were the key.
 */
export function parseGmlInfo(
  body: string,
  keep: ReadonlySet<string> = new Set(),
): IdentifyFeature[] {
  const chunks = body.split(/<(?:\w+:)?(?:featureMember|\w+_feature)\b[^>]*>/).slice(1);
  const sources = chunks.length > 0 ? chunks : [body];
  return sources
    .map((chunk) => {
      const props: Record<string, unknown> = {};
      for (const m of chunk.matchAll(/<(?:(\w+):)?([\p{L}\p{N}_.-]+)>([^<>]+)<\/(?:\w+:)?\2>/gu)) {
        if (m[1] === 'gml') continue; // gml:name/gml:description are structural
        props[m[2]!] = decodeXmlText(m[3]!);
      }
      return { props: cleanProps(props, keep), bounds: gmlBounds(chunk) };
    })
    .filter((f) => Object.keys(f.props).length > 0);
}

/**
 * Where a GML feature is — the one dialect in the chain that will say.
 *
 * MapServer writes a `gml:boundedBy/gml:Box` per feature when the mapfile
 * publishes geometry, and that is the whole basis for answering "which of these
 * did you tap?" with a distance instead of a guess: Riksantikvaren's SEFRAK
 * buildings carry it, and NGU's GRANADA wells do not — same dialect, same
 * request, different mapfile. So this returns `undefined` for most layers and
 * everything downstream has to keep working without it.
 *
 * Only EPSG:3857 is read, because that is the CRS every request here asks for.
 * A server answering in some other frame is not translated on a guess: WMS
 * 1.3.0 flipped the axis order of geographic CRSs, so reading an unknown
 * `srsName` as x,y is how a building in Horten ends up in the Indian Ocean.
 */
export function gmlBounds(chunk: string): FeatureBounds | undefined {
  const box = /<gml:(Box|Point|Envelope)\b([^>]*)>([\s\S]*?)<\/gml:\1>/.exec(chunk);
  if (!box) return undefined;
  // The CRS is usually on the geometry, but GML lets it sit on an ancestor
  // (`gml:boundedBy`), so fall back to the feature's own declaration.
  const srs = /srsName="([^"]*)"/.exec(box[2] ?? '')?.[1] ?? /srsName="([^"]*)"/.exec(chunk)?.[1];
  if (!srs || !/(3857|900913|102100)/.test(srs)) return undefined;
  // Every coordinate-bearing child at once: `gml:coordinates` (GML 2),
  // `gml:pos` (GML 3) and an Envelope's two corners all reduce to numbers.
  // Matched rather than split: splitting leaves an empty token at each end,
  // and `Number('')` is 0 — a coordinate pair that reads as the Atlantic.
  const numbers = (box[3]?.replace(/<[^>]*>/g, ' ').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points: LatLng[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push(mercatorToLatLng(numbers[i]!, numbers[i + 1]!));
  }
  return boundsOf(points);
}

/**
 * ESRI WMS text/xml FeatureInfoResponse (ArcGIS servers, e.g. NVE): one
 * `<FIELDS attr="value" …/>` element per feature.
 *
 * Two things ArcGIS servers disagree about, both of which fail *silently* —
 * this parser owns the format, so returning `[]` stops the format chain and the
 * tap answers "nothing here" rather than falling through to another reader:
 *
 * - **The element is not always self-closed.** NVE writes `<FIELDS …/>`,
 *   Miljødirektoratet writes `<FIELDS …></FIELDS>` for the same WMS version.
 * - **Attribute names are not ASCII.** Naturbase answers with the field
 *   *aliases*, so a wildlife area arrives as `Områdenavn`, `Årstid`,
 *   `Rødlistestatus` — and a `\w`-based name pattern silently starts matching
 *   *after* the Norwegian letter, turning `Årstid` into a key called `rstid`
 *   that no `identifyFields` list will ever match.
 */
export function parseEsriXmlInfo(
  body: string,
  keep: ReadonlySet<string> = new Set(),
): IdentifyFeature[] | null {
  if (!body.includes('FeatureInfoResponse')) return null;
  const results: IdentifyFeature[] = [];
  for (const m of body.matchAll(/<(?:\w+:)?FIELDS\b([^>]*?)\s*\/?>/g)) {
    const props: Record<string, unknown> = {};
    for (const attr of m[1]!.matchAll(/([\p{L}\p{N}_.()]+)="([^"]*)"/gu)) {
      props[attr[1]!] = decodeXmlText(attr[2]!);
    }
    const cleaned = cleanProps(props, keep);
    if (Object.keys(cleaned).length > 0) results.push({ props: cleaned });
  }
  return results;
}

/**
 * MapServer-style text/plain: indented `key = 'value'` lines, grouped under
 * `Feature <n>:` headings.
 *
 * The split on those headings is load-bearing. Artsdatabanken's alien-species
 * service answers *only* in this dialect (its GML comes back empty), and a tap
 * in a town returns up to ten observations — read as one flat key/value list
 * they collapse into a single record whose every field is from a different
 * find, i.e. a card that confidently describes a plant that was never there.
 */
export function parseTextInfo(
  body: string,
  keep: ReadonlySet<string> = new Set(),
): IdentifyFeature[] {
  const chunks = body.split(/^\s*Feature\s+\d+:\s*$/m).slice(1);
  return (chunks.length > 0 ? chunks : [body])
    .map((chunk) => {
      const props: Record<string, unknown> = {};
      for (const m of chunk.matchAll(/^\s+([\p{L}\p{N}_.-]+)\s*=\s*'?([^'\n]*)'?\s*$/gmu)) {
        props[m[1]!] = m[2]!;
      }
      return { props: cleanProps(props, keep) };
    })
    .filter((f) => Object.keys(f.props).length > 0);
}

/**
 * The INFO_FORMATs to try, in order. A parser returns `null` for "this body is
 * not my format" (move on) and `[]` for "my format, nothing here" (stop).
 */
export const IDENTIFY_FORMATS: {
  format: string;
  parse: (body: string, keep: ReadonlySet<string>) => IdentifyFeature[] | null;
}[] = [
  { format: 'application/json', parse: parseGeojsonInfo },
  { format: 'application/vnd.ogc.gml', parse: parseGmlInfo },
  { format: 'text/xml', parse: parseEsriXmlInfo },
  { format: 'text/plain', parse: parseTextInfo },
];

/**
 * The zoom a GetFeatureInfo is asked at — which is really the question "how many
 * metres wide is the tap?".
 *
 * A WMS server answers for the features within a few *pixels* of the query
 * point (three, on both MapServer and ArcGIS). Asked at the zoom the user is
 * looking at, that is sub-metre precision from z16 in: measured against
 * Askeladden and GRANADA, a tap had to land within ~25 m of a heritage icon and
 * ~50 m of a spring before either service would answer at all, so tapping the
 * middle of a drawn star reliably returned nothing. `cap` lowers the zoom for
 * the *query only* — the tile the user sees is unaffected — trading a metre of
 * precision for a tap that lands.
 *
 * It can never go below the layer's own `minzoom`: several of these upstreams
 * refuse to draw (and to answer) outside their scale band, so a blanket coarse
 * query would turn "no feature here" into "this layer never answers".
 */
export function identifyZoom(
  meta: { minzoom?: number; maxzoom: number },
  cap: number | undefined,
  requested: number,
): number {
  const asked = Number.isFinite(requested) ? Math.round(requested) : meta.maxzoom;
  const capped = Math.min(meta.maxzoom, cap ?? meta.maxzoom, Math.max(0, asked));
  return Math.max(meta.minzoom ?? 0, capped);
}

/**
 * How many pixels around the query point a WMS answers for. A GetFeatureInfo
 * has no radius parameter, so the only knob is the zoom it is asked at (see
 * {@link identifyZoom}) — and this is what converts that zoom into metres.
 *
 * Four is a *middle*, not a specification: measured 2026-08-04 against the
 * services this catalog actually asks, Riksantikvaren's SEFRAK answers out to
 * ~6 px (13.5 m and 13.8 m at z15, where a pixel is 2.33 m) while NGU's GRANADA
 * stops at ~2 px. Each mapfile sets its own tolerance and none of them
 * publishes it. The number is therefore only ever used for a rounded "about",
 * and never for a decision — the narrowing measures the real answer instead of
 * predicting it.
 */
export const IDENTIFY_TOLERANCE_PX = 4;

/** Roughly the ground radius a tap covers at this zoom, in metres. */
export function identifyRadiusM(zoom: number, lat: number): number {
  const metresPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  return IDENTIFY_TOLERANCE_PX * metresPerPixel;
}

/**
 * How far a tap is from a feature, in metres — 0 anywhere inside its extent.
 *
 * A polygon is not a point and must not be reduced to one: the centre of
 * Askeladden's largest heritage locality is kilometres from its edge, so a tap
 * *inside* it would sort behind a point 40 m away if this measured to centroids.
 */
export function boundsDistanceM(bounds: FeatureBounds, at: LatLng): number {
  const lat = Math.min(bounds.north, Math.max(bounds.south, at.lat));
  const lng = Math.min(bounds.east, Math.max(bounds.west, at.lng));
  return haversineM(at, { lat, lng });
}

/**
 * The zooms a crowded tap is retried at, narrowest last.
 *
 * The answer a user wants is the *nearest* feature, and no WMS will sort by
 * distance (most don't even say where their features are). What they will do is
 * answer a smaller question: halve the radius and the neighbours drop out.
 * So a tap that comes back with several features is asked again, closer in, and
 * the narrowest radius that still answers is the one that answers.
 *
 * Four levels is a factor of 16 in radius, which takes GRANADA's ~57 m tap down
 * to ~3.5 m — past the point where a symbol on screen is even that big. The
 * 18 ceiling is where a query stops being a tap and becomes a pinprick (~1 m).
 */
/**
 * How many features one layer may answer with. The card has room for three
 * groups in total (`IDENTIFY_CARD_GROUPS`), so a layer that sent eight — the
 * old cap — could only ever push another layer's answer off the card. What is
 * left out is counted in `more` instead.
 */
export const IDENTIFY_MAX_RESULTS = 3;

export function narrowZooms(wide: number, steps = 4, ceiling = 18): number[] {
  const zooms: number[] = [];
  for (let z = wide + 1; z <= Math.min(wide + steps, ceiling); z++) zooms.push(z);
  return zooms;
}

/** Drop results that repeat one already in the list (see `identifyLayers`). */
export function dedupeResults(results: IdentifyFeature[]): IdentifyFeature[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = JSON.stringify(Object.entries(result.props).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Nearest first, for the dialects that said where their features are. Features
 * with no position keep their upstream order behind the ones that have it —
 * an unknown distance is not a large one, but it cannot be ranked either.
 */
export function sortByDistance(features: IdentifyFeature[], at: LatLng): IdentifyFeature[] {
  return features
    .map((feature, index) => ({
      feature,
      index,
      distance: feature.bounds ? boundsDistanceM(feature.bounds, at) : null,
    }))
    .sort((a, b) => {
      if (a.distance === null || b.distance === null) {
        if (a.distance !== b.distance) return a.distance === null ? 1 : -1;
        return a.index - b.index;
      }
      return a.distance - b.distance || a.index - b.index;
    })
    .map((entry) => entry.feature);
}

export function registerIdentifyRoute(ctx: OverlayContext): void {
  const { app, byId, fetchImpl } = ctx;

  app.get<{
    Params: { id: string };
    Querystring: Record<string, string | undefined> & {
      lat?: string;
      lng?: string;
      zoom?: string;
    };
  }>('/api/overlay/:id/identify', async (request, reply) => {
    const layer = byId.get(request.params.id);
    // Narrow onto a local: the per-format callbacks below re-read the
    // upstream, and narrowing on `layer.upstream` does not survive into them.
    const wms = layer?.upstream.kind === 'wms' ? layer.upstream : undefined;
    if (!layer || !wms?.identifyLayers) {
      return reply.code(404).send({ error: 'layer not identifiable' });
    }
    const lat = Number(request.query.lat);
    const lng = Number(request.query.lng);
    const zoom = Number(request.query.zoom);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85) {
      return reply.code(400).send({ error: 'invalid coordinates' });
    }
    const at = { lat, lng };
    const wide = identifyZoom(layer.meta, wms.identifyZoom, zoom);

    const chosen = resolveOptions(layer, request.query);
    const queryLayers = optionQueryLayers(layer, chosen) ?? wms.identifyLayers;
    const keep = keepSet(wms.identifyFields);
    // A layer may pin the dialect it is actually answerable in. Artsdatabanken
    // is the case that forced it: its GML reply is a well-formed *empty*
    // document, which the chain reads as "my format, nothing here" and stops on
    // — so the text/plain answer three formats down was never reached and the
    // layer looked as if it had no identify at all.
    const attempts = wms.identifyInfoFormats
      ? IDENTIFY_FORMATS.filter((entry) => wms.identifyInfoFormats!.includes(entry.format)).sort(
          (a, b) =>
            wms.identifyInfoFormats!.indexOf(a.format) - wms.identifyInfoFormats!.indexOf(b.format),
        )
      : IDENTIFY_FORMATS;

    let upstreamDown = false;
    // The dialect that answered, remembered across the narrowing retries below:
    // the format chain is a negotiation with the server, not with the point, so
    // re-running it per zoom would triple every crowded tap's upstream cost.
    let dialect: (typeof attempts)[number] | undefined;

    /** One GetFeatureInfo at one zoom, through this layer's whole pipeline. */
    const ask = async (z: number): Promise<IdentifyFeature[] | null> => {
      const frac = tileCoords(lat, lng, z);
      const tx = Math.floor(frac.x);
      const ty = Math.floor(frac.y);
      const px = Math.min(255, Math.floor((frac.x - tx) * 256));
      const py = Math.min(255, Math.floor((frac.y - ty) * 256));
      for (const attempt of dialect ? [dialect] : attempts) {
        const url = wmsBaseParams(wms, z, tx, ty);
        const p = url.searchParams;
        // Before the identify parameters, never after: a chip that swaps the
        // drawn dataset contributes its own LAYERS, and the queried set has to
        // win over it (that is what `optionIdentifyLayers` is for).
        if (wms.optionParamsOnIdentify) {
          for (const [key, value] of Object.entries(optionGetMapParams(layer, chosen))) {
            p.set(key, value);
          }
        }
        p.set('REQUEST', 'GetFeatureInfo');
        // LAYERS is narrowed to the queried set, not left as the drawn set. WMS
        // requires QUERY_LAYERS ⊆ LAYERS, and a layer whose *drawn* set varies per
        // option (spawning grounds pick a dataset) would otherwise ask about a
        // layer it did not name. Every catalog entry queries a subset of what it
        // draws, so this is the same question asked more cheaply.
        p.set('LAYERS', queryLayers);
        p.set('QUERY_LAYERS', queryLayers);
        p.set('INFO_FORMAT', attempt.format);
        p.set('FEATURE_COUNT', '10');
        // 1.3.0 renamed the identify pixel params X/Y → I/J.
        p.set(wms.version === '1.3.0' ? 'I' : 'X', String(px));
        p.set(wms.version === '1.3.0' ? 'J' : 'Y', String(py));
        try {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) continue;
          const body = await res.text();
          if (/ServiceException|ExceptionReport/i.test(body)) continue; // format unsupported
          const parsed = attempt.parse(body, keep);
          if (parsed === null) continue; // unparseable in this format
          dialect = attempt;
          ctx.record(layer.meta.id, true);
          // Both filters run on the *raw* attributes, before the allow-list
          // narrows them: the field they match on (the species name, the river
          // network's class code) may be one a reader wants shown, but it must
          // not have to be — `ltema` is filtered on and never displayed.
          return dedupeResults(
            parsed
              .filter((f) => keepsIdentify(wms.identifyKeep, f.props))
              .filter((f) => optionKeeps(layer, chosen, f.props))
              .map((f) => ({ ...f, props: selectFields(f.props, wms.identifyFields) }))
              .filter((f) => Object.keys(f.props).length > 0),
          );
        } catch (err) {
          request.log.warn(
            { err, layer: layer.meta.id, format: attempt.format },
            'identify upstream failed',
          );
          upstreamDown = true;
        }
      }
      return null;
    };

    const widest = await ask(wide);
    if (widest === null) {
      if (upstreamDown) {
        ctx.record(layer.meta.id, false, 'identify unreachable');
        return reply.code(502).send({ error: 'identify unavailable' });
      }
      ctx.record(layer.meta.id, true);
      return { results: [] };
    }

    // A tap that caught the neighbours as well is asked again, closer in: the
    // narrowest radius that still answers is the answer (see `narrowZooms`).
    // Bisection rather than a walk, because each step is an upstream round trip
    // — five candidate radii cost at most three of them.
    let nearest = widest;
    if (nearest.length > 1) {
      const ladder = narrowZooms(wide);
      let lo = 0;
      let hi = ladder.length - 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const narrower = await ask(ladder[mid]!);
        if (narrower && narrower.length > 0) {
          nearest = narrower;
          if (narrower.length === 1) break; // nothing to gain from a smaller radius
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }

    /**
     * How far out the answers this card is *not* showing were found, rounded to
     * ten metres — the estimate from the query's zoom, or the farthest feature
     * actually measured under it, whichever is larger.
     *
     * Never the estimate alone, because it is a middle of services that
     * disagree by a factor of three (see `IDENTIFY_TOLERANCE_PX`), and a card
     * that says "3 more within 10 m" above a row reading "16 m away" is exactly
     * the kind of small contradiction that makes a reader stop trusting it.
     */
    const omittedRadiusM = (found: IdentifyFeature[]): number => {
      const measured = found.map((f) => (f.bounds ? boundsDistanceM(f.bounds, at) : 0));
      const metres = Math.max(identifyRadiusM(wide, lat), ...measured);
      return Math.max(10, Math.round(metres / 10) * 10);
    };

    const sorted = sortByDistance(nearest, at).slice(0, IDENTIFY_MAX_RESULTS);
    const results = sorted.map((f) =>
      presentFields(
        f.props,
        wms.identifyLabels,
        wms.identifyValues,
        wms.identifyFormats,
        wms.identifyTokens,
      ),
    );
    const distances = sorted.map((f) =>
      f.bounds ? Math.round(boundsDistanceM(f.bounds, at)) : null,
    );
    // What the wider tap saw and this answer leaves out. Reported as a count and
    // a radius rather than dropped in silence: the reader is looking at a map
    // with more symbols on it than the card has rows, and "3 more within 60 m"
    // is the difference between a card that is wrong and one that is brief.
    const omitted = Math.max(0, widest.length - sorted.length);
    return {
      results,
      ...(distances.some((d) => d !== null) ? { distancesM: distances } : {}),
      ...(omitted > 0 ? { more: { count: omitted, withinM: omittedRadiusM(widest) } } : {}),
    };
  });
}
