import { IDENTIFY_CARD_ROWS, type OverlayIdentifyGroup } from './layers.js';

/**
 * Public toilets, merged from the only official registers that exist.
 *
 * Norway has no national toilet register. What it has is partial ones that
 * answer different questions, and the layer is their union:
 *
 * - **NVDB object type 243, Toalettanlegg** — Statens vegvesen's road-side
 *   toilets: rest areas, ferry quays, National Tourist Route stops. 721
 *   nationally (measured 2026-09-30), with winter closure dates and universal
 *   design recorded per building — and not one inside Oslo, where the roads
 *   authority runs no rest areas.
 * - **Oslo kommune, Bymiljøetaten** — the city's own 83 public toilets: parks,
 *   bathing spots, the fjord islands and the Marka lakes.
 * - **Bergen kommune** — the Google My Maps toilet map the city links as its
 *   official overview (58 placemarks, 45 placed, 2026-09-30): the centre's
 *   municipal toilets, shopping centres and terminals, plus Bergen og Omland
 *   friluftsråd's bathing spots. Hand-kept, so every field is best-effort.
 * - **Stavanger kommune** — the city's open-data list on opencom.no (37,
 *   published 2024-07-09): centre, shopping centres, beaches and the islands'
 *   outhouses.
 *
 * The two city lists are the only ones with opening hours and prices, and
 * the only ones that can go stale silently — a city map nobody edits looks
 * exactly like a current one. So each of their features carries `asOf`, the
 * date its list last changed, and the card always shows it.
 *
 * All are normalised here to one small property set, so the clients draw and
 * describe a single layer and never learn which register a point came from.
 */
export const PUBLIC_TOILETS_ID = 'public-toilets';

/** The normalised feature properties both clients read. */
export interface PublicToiletProperties {
  source: 'nvdb' | 'oslo' | 'bergen' | 'stavanger';
  name?: string;
  /** Wheelchair-usable, from the register's own assessment. */
  accessible?: 'yes' | 'partly' | 'no';
  /** Opening hours as one line: "Mon–Fri 09:00–21:00 · Sat 09:00–18:00 · Sun closed". */
  hours?: string;
  /** Closed-season sentence, or "Open all year" when the register says so. */
  winter?: string;
  /** "Free", or "10 kr". */
  price?: string;
  kind?: string;
  count?: number;
  babyChange?: boolean;
  /** Road reference, with the road's name when NVDB has one. */
  road?: string;
  address?: string;
  operator?: string;
  notes?: string;
  /**
   * `YYYY-MM-DD` the source list last changed — the publisher's own date when
   * it states one, otherwise the day the backend first saw the current
   * content. Set by the backend, never by a `toiletFrom…` translation.
   */
  asOf?: string;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function count(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** NVDB's `Kortdato` is `MM-DD` with no year: "10-15" → "15 Oct". */
function shortDate(v: unknown): string | undefined {
  const m = /^(\d{2})-(\d{2})$/.exec(text(v) ?? '');
  if (!m) return undefined;
  const month = MONTHS[Number(m[1]) - 1];
  const day = Number(m[2]);
  return month && day >= 1 && day <= 31 ? `${day} ${month}` : undefined;
}

const NVDB_KIND: Record<string, string> = {
  Vannklosett: 'Flush toilet',
  Tørrklosett: 'Dry toilet',
};

const NVDB_OPERATOR: Record<string, string> = {
  'Statens vegvesen': 'Statens vegvesen',
  'Stat, Statens vegvesen': 'Statens vegvesen',
  'Nye Veier': 'Nye Veier',
  'Stat, Nye Veier': 'Nye Veier',
  Fylkeskommune: 'County council',
  Kommune: 'Municipality',
  Privat: 'Private',
  // A public–private partnership road: the concession company runs it.
  OPS: 'Road concession company',
};

/**
 * One NVDB Toalettanlegg, handed over as its `egenskaper` flattened to
 * `navn → verdi` plus `vegsystem` / `adresse` from its location (the backend
 * does the flattening, so this stays free of NVDB's JSON shape).
 */
export function toiletFromNvdb(record: Record<string, unknown>): PublicToiletProperties {
  const out: PublicToiletProperties = { source: 'nvdb' };
  const uu = text(record['Universelt utformet']);
  if (uu === 'Ja') out.accessible = 'yes';
  else if (uu === 'Nei') out.accessible = 'no';

  const winter = text(record['Vinterstengt']);
  if (winter === 'Ja') {
    const from = shortDate(record['Vinterstengt, fra dato']);
    const to = shortDate(record['Vinterstengt, til dato']);
    out.winter = from && to ? `Closed ${from} – ${to}` : 'Closed in winter';
  } else if (winter === 'Nei') {
    out.winter = 'Open all year';
  }

  const kind = NVDB_KIND[text(record['Type']) ?? ''];
  if (kind) out.kind = kind;
  const n = count(record['Antall klosett']);
  if (n) out.count = n;

  const road = text(record['vegsystem']);
  const street = text(record['adresse']);
  if (road) out.road = street ? `${road} (${street})` : road;
  else if (street) out.road = street;

  // Who keeps it open is what a traveller can act on; the owner is usually the
  // same body, and is the fallback when the maintainer is not recorded.
  const operator =
    NVDB_OPERATOR[text(record['Vedlikeholdsansvarlig']) ?? ''] ??
    NVDB_OPERATOR[text(record['Eier']) ?? ''];
  if (operator) out.operator = operator;

  const notes = text(record['Tilleggsinformasjon']);
  if (notes) out.notes = notes;
  return out;
}

/** Oslo's accessibility codes (SOSI `tilgjengelighetsvurdering`); 4 is "not assessed". */
const OSLO_ACCESS: Record<number, PublicToiletProperties['accessible']> = {
  1: 'yes',
  2: 'partly',
  3: 'no',
};

/**
 * One Oslo kommune toilet from Bymiljøetaten's `Offentlige toaletter` layer.
 * Returns null for a toilet whose `startdato`/`sluttdato` puts it outside
 * service at `now` — the register keeps closed toilets rather than deleting
 * them (Ulsrudvann, closed 2024).
 */
export function toiletFromOslo(
  attrs: Record<string, unknown>,
  now: number = Date.now(),
): PublicToiletProperties | null {
  const start = typeof attrs['startdato'] === 'number' ? attrs['startdato'] : undefined;
  const end = typeof attrs['sluttdato'] === 'number' ? attrs['sluttdato'] : undefined;
  if ((start !== undefined && start > now) || (end !== undefined && end < now)) return null;

  const out: PublicToiletProperties = { source: 'oslo' };
  const name = text(attrs['navn']);
  if (name) out.name = name;
  // `toalettype` 1 is the city's own "UU Toalett" class — a universally
  // designed building — and outranks the separate assessment field, which is
  // "not assessed" on a third of the register.
  const access =
    attrs['toalettype'] === 1 ? 'yes' : OSLO_ACCESS[Number(attrs['tilgjengelighetsvurdering'])];
  if (access) out.accessible = access;
  if (text(attrs['objekttype']) === 'Pissoar') out.kind = 'Urinal';
  const address = text(attrs['adresse']);
  if (address) out.address = address;
  const operator = text(attrs['forvalter']);
  if (operator && operator !== 'Annet') out.operator = operator;
  const notes = text(attrs['kommentar']);
  if (notes) out.notes = notes;
  return out;
}

/** A number the city lists write as `"1.0"`, `"2"` or `1`. */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v.trim() || NaN) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** "Free", "10 kr" — from `0`, `"Free"`, `"10,-"`, `"5 kr"`. */
function price(v: unknown): string | undefined {
  const s = typeof v === 'number' ? String(v) : text(v);
  if (!s) return undefined;
  if (/^(free|gratis)$/i.test(s)) return 'Free';
  const m = /^(\d+)(?:[.,]-?)?\s*(?:kr\.?|nok)?$/i.exec(s);
  if (!m) return undefined;
  const kr = Number(m[1]);
  return kr === 0 ? 'Free' : `${kr} kr`;
}

const OPEN_24H = 'Open 24 hours';
const CLOSED = 'closed';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "07.30-21-30", "8-14", "05:00-24:00" — every hand-typed range, as `HH:MM–HH:MM`. */
const TIME_RANGE = /(\d{1,2})(?:[.:](\d{2}))?\s*-\s*(\d{1,2})(?:[.:-](\d{2}))?/g;
const clock = (h: string, m: string | undefined) => `${h.padStart(2, '0')}:${m ?? '00'}`;

/**
 * One day's hours as a city list writes them, tidied. `NULL` and blank are
 * "not recorded" (undefined), never "closed": the 2017 Bergen columns leave
 * Sunday `NULL` for places that simply were not asked.
 */
function dayHours(v: unknown): string | undefined {
  const s = text(v)?.replace(/\s+/g, ' ');
  if (!s || /^null$/i.test(s)) return undefined;
  if (/^(all|døgnåpen[t]?)$/i.test(s)) return OPEN_24H;
  if (/^(closed|stengt)$/i.test(s)) return CLOSED;
  if (/^dagtid$/i.test(s)) return 'daytime';
  return s
    .replace(TIME_RANGE, (_m, h1: string, m1?: string, h2?: string, m2?: string) =>
      h2 ? `${clock(h1, m1)}–${clock(h2, m2)}` : _m,
    )
    .replace(/\bvinter\b/gi, 'winter')
    .replace(/\bsommer\b/gi, 'summer')
    .replace(/\bog\b/gi, 'and');
}

/**
 * Seven days (Mon…Sun, undefined = not recorded) as one line, runs of equal
 * days folded: "Daily 07:00–23:00", "Mon–Fri 08:00–15:00", "Mon–Fri
 * 09:00–21:00 · Sat 09:00–18:00 · Sun closed".
 */
function weekHours(days: (string | undefined)[]): string | undefined {
  if (days.every((d) => d === undefined)) return undefined;
  const first = days[0];
  if (first !== undefined && days.every((d) => d === first)) {
    if (first === OPEN_24H) return first;
    if (first === CLOSED) return 'Closed';
    return /^\d/.test(first) ? `Daily ${first}` : first[0]!.toUpperCase() + first.slice(1);
  }
  const parts: string[] = [];
  for (let i = 0; i < days.length;) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[i]) j++;
    const d = days[i];
    if (d !== undefined) {
      const label = i === j ? WEEKDAYS[i] : `${WEEKDAYS[i]}–${WEEKDAYS[j]}`;
      parts.push(`${label} ${d === OPEN_24H ? '24 hours' : d}`);
    }
    i = j + 1;
  }
  return parts.join(' · ');
}

/** Weekday / Saturday / Sunday columns, the shape both city lists share. */
const threeColumnWeek = (weekday: unknown, saturday: unknown, sunday: unknown) => {
  const w = dayHours(weekday);
  return weekHours([w, w, w, w, w, dayHours(saturday), dayHours(sunday)]);
};

const NO_MONTHS = [
  'januar',
  'februar',
  'mars',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'desember',
];
const NO_MONTH = `(${NO_MONTHS.join('|')})`;
const monthName = (no: string) => MONTHS[NO_MONTHS.indexOf(no.toLowerCase())]!;
/** "1.mai-30.september", "1.mai-30september". */
const DATED_SEASON = new RegExp(
  `(\\d{1,2})\\.?\\s*${NO_MONTH}\\s*-\\s*(\\d{1,2})\\.?\\s*${NO_MONTH}`,
  'i',
);
/** "Fra april - oktober", "April- oktober". */
const MONTH_SEASON = new RegExp(`(?:fra\\s+)?${NO_MONTH}\\s*-\\s*${NO_MONTH}`, 'i');

/**
 * One toilet from Stavanger kommune's open-data list (opencom.no GeoJSON).
 *
 * The list has no season or type column, so both are written into the place
 * name — "Vassøy - Peisaren badeplass. April- oktober. Utedo." — and are
 * read back out of it here, leaving the name itself.
 */
export function toiletFromStavanger(props: Record<string, unknown>): PublicToiletProperties {
  const out: PublicToiletProperties = { source: 'stavanger', operator: 'Stavanger kommune' };
  let place = text(props['plassering']) ?? '';
  const dated = DATED_SEASON.exec(place);
  const months = dated ? null : MONTH_SEASON.exec(place);
  if (dated) {
    out.winter = `Open ${Number(dated[1])} ${monthName(dated[2]!)} – ${Number(dated[3])} ${monthName(dated[4]!)}`;
    place = place.replace(dated[0], '');
  } else if (months) {
    out.winter = `Open ${monthName(months[1]!)} – ${monthName(months[2]!)}`;
    place = place.replace(months[0], '');
  }
  if (/\butedo\b/i.test(place)) {
    out.kind = 'Outhouse';
    place = place.replace(/\butedo\b/gi, '');
  }
  const name = place
    .split(/\.(?=\s|$)/)
    .map((s) => s.trim())
    .find(Boolean);
  if (name) out.name = name;

  const wheelchair = text(props['rullestol'])?.toLowerCase();
  if (wheelchair === 'ja') out.accessible = 'yes';
  else if (wheelchair === 'nei') out.accessible = 'no';
  const hours = threeColumnWeek(
    props['aapningstider_hverdag'],
    props['aapningstider_loerdag'],
    props['aapningstider_soendag'],
  );
  if (hours) out.hours = hours;
  const cost = price(props['pris']);
  if (cost) out.price = cost;
  if (text(props['stellerom'])?.toLowerCase() === 'ja') out.babyChange = true;
  return out;
}

const BERGEN_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * One placemark from Bergen kommune's toilet map (Google My Maps, KML), as
 * the backend hands it over: the placemark's `ExtendedData` fields plus
 * `placemark` (its title) and `folder` (its My Maps layer).
 *
 * The map is a 2017 spreadsheet import edited by hand since, so it carries
 * two generations of columns: `tid_hverdag/lordag/sondag` from 2017 and
 * per-day `Monday`…`Sunday` added later. Where a placemark has any per-day
 * value those win — on Bergen Storsenter they disagree, and the per-day ones
 * match the centre's current hours.
 */
export function toiletFromBergen(record: Record<string, unknown>): PublicToiletProperties {
  const out: PublicToiletProperties = { source: 'bergen' };
  // My Maps titles an unnamed pin "Punkt 28"; the list's own place name is better.
  const title = text(record['placemark']);
  const name = title && !/^(punkt|point) \d+$/i.test(title) ? title : text(record['plassering']);
  if (name) out.name = name;

  const described = `${text(record['Facilities']) ?? ''} ${text(record['beskrivelse']) ?? ''}`;
  const hc = num(record['HC']);
  if (/disabled/i.test(described) || (hc !== undefined && hc > 0)) out.accessible = 'yes';
  else if (hc === 0) out.accessible = 'no';

  const urinalOnly =
    /pissoir/i.test(described) ||
    ((num(record['pissoir']) ?? 0) > 0 && !num(record['dame']) && !num(record['herre']));
  if (urinalOnly) out.kind = 'Urinal';
  else if (/ikke vannklosett/i.test(described)) out.kind = 'Dry toilet';
  if ((num(record['stellerom']) ?? 0) > 0 || /baby/i.test(described)) out.babyChange = true;

  const hours = BERGEN_DAYS.some((d) => text(record[d]))
    ? weekHours(BERGEN_DAYS.map((d) => dayHours(record[d])))
    : threeColumnWeek(record['tid_hverdag'], record['tid_lordag'], record['tid_sondag']);
  if (hours) out.hours = hours;
  const cost = price(record['Price (NOK)']);
  if (cost) out.price = cost;
  const address = text(record['Address']);
  if (address) out.address = address;
  const notes = text(record['Comment']);
  if (notes) out.notes = notes;
  // The map's second layer is Bergen og Omland friluftsråd's bathing spots.
  if (text(record['folder']) === 'BOF toilets') out.operator = 'Bergen og Omland friluftsråd';
  return out;
}

const ACCESS_LABEL: Record<string, string> = {
  yes: 'Yes',
  partly: 'Partly — difficult access',
  no: 'No',
};

/**
 * "2 flush toilets", "Dry toilet", "Urinal, baby changing" — kind, count and
 * the changing table read as one fact.
 */
function facilities(
  kind: string | undefined,
  n: number | undefined,
  babyChange: boolean,
): string | undefined {
  const what = !kind
    ? n
      ? `${n} toilet${n === 1 ? '' : 's'}`
      : undefined
    : !n || n === 1
      ? kind
      : `${n} ${kind.toLowerCase()}s`;
  if (!babyChange) return what;
  return what ? `${what}, baby changing` : 'Baby changing';
}

/** `2024-07-09` → "9 Jul 2024". */
function isoDay(v: unknown): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(v) ?? '');
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : undefined;
}

const SOURCES = new Set(['nvdb', 'oslo', 'bergen', 'stavanger']);

/**
 * A tapped toilet as an identify group. Both clients draw the points
 * themselves, so this is a local hit-test answer, one builder for both.
 *
 * Six rows at most, because the place card shows six (`IDENTIFY_CARD_ROWS`),
 * ordered by what decides whether to walk there: can I use it, is it open
 * now and this season, what does it cost, what is there. Which register it
 * came from is left to the layer's attribution; "Run by" already says
 * Bymiljøetaten or Statens vegvesen.
 *
 * "Data as of" is the exception to the order: when a feature has it, it takes
 * the last row whatever else is cut, because a city list's hours are only as
 * good as its date, and a reader a year from now has no other way to tell.
 */
export function publicToiletIdentify(
  properties: Record<string, unknown> | null | undefined,
): OverlayIdentifyGroup | null {
  if (!properties) return null;
  const source = text(properties['source']);
  if (!source || !SOURCES.has(source)) return null;
  const rows: [string, string | undefined][] = [
    ['Wheelchair accessible', ACCESS_LABEL[text(properties['accessible']) ?? '']],
    ['Hours', text(properties['hours'])],
    ['Season', text(properties['winter'])],
    ['Price', text(properties['price'])],
    [
      'Facilities',
      facilities(
        text(properties['kind']),
        count(properties['count']),
        // The native bridge stringifies booleans.
        properties['babyChange'] === true || properties['babyChange'] === 'true',
      ),
    ],
  ];
  const road = text(properties['road']);
  rows.push(road ? ['Road', road] : ['Address', text(properties['address'])]);
  rows.push(['Notes', text(properties['notes'])], ['Run by', text(properties['operator'])]);

  const asOf = isoDay(properties['asOf']);
  const kept = rows
    .filter((r): r is [string, string] => r[1] !== undefined)
    .slice(0, asOf ? IDENTIFY_CARD_ROWS - 1 : IDENTIFY_CARD_ROWS);
  if (asOf) kept.push(['Data as of', asOf]);
  return {
    title: text(properties['name']) ?? (source === 'nvdb' ? 'Roadside toilet' : 'Public toilet'),
    properties: Object.fromEntries(kept),
  };
}
