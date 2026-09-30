import type { OverlayIdentifyGroup } from './layers.js';

/**
 * Public toilets, merged from the only official registers that exist.
 *
 * Norway has no national toilet register. What it has is two partial ones that
 * answer different questions, and the layer is their union:
 *
 * - **NVDB object type 243, Toalettanlegg** — Statens vegvesen's road-side
 *   toilets: rest areas, ferry quays, National Tourist Route stops. 721
 *   nationally (measured 2026-09-30), with winter closure dates and universal
 *   design recorded per building — and not one inside Oslo, where the roads
 *   authority runs no rest areas.
 * - **Oslo kommune, Bymiljøetaten** — the city's own 83 public toilets: parks,
 *   bathing spots, the fjord islands and the Marka lakes.
 *
 * Both are normalised here to one small property set, so the clients draw and
 * describe a single layer and never learn which register a point came from
 * except as the card's "Source" row.
 */
export const PUBLIC_TOILETS_ID = 'public-toilets';

/** The normalised feature properties both clients read. */
export interface PublicToiletProperties {
  source: 'nvdb' | 'oslo';
  name?: string;
  /** Wheelchair-usable, from the register's own assessment. */
  accessible?: 'yes' | 'partly' | 'no';
  /** Closed-season sentence, or "Open all year" when the register says so. */
  winter?: string;
  kind?: string;
  count?: number;
  /** Road reference, with the road's name when NVDB has one. */
  road?: string;
  address?: string;
  operator?: string;
  notes?: string;
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

const ACCESS_LABEL: Record<string, string> = {
  yes: 'Yes',
  partly: 'Partly — difficult access',
  no: 'No',
};

/** "2 flush toilets", "Dry toilet", "Urinal" — kind and count read as one fact. */
function facilities(kind: string | undefined, n: number | undefined): string | undefined {
  if (!kind) return n ? `${n} toilet${n === 1 ? '' : 's'}` : undefined;
  if (!n || n === 1) return kind;
  return `${n} ${kind.toLowerCase()}s`;
}

/**
 * A tapped toilet as an identify group. Both clients draw the points
 * themselves, so this is a local hit-test answer, one builder for both.
 *
 * Six rows at most, because the place card shows six (`IDENTIFY_CARD_ROWS`),
 * ordered by what decides whether to walk there: can I use it, is it open this
 * season, what is there. Which register it came from is left to the layer's
 * attribution; "Run by" already says Bymiljøetaten or Statens vegvesen.
 */
export function publicToiletIdentify(
  properties: Record<string, unknown> | null | undefined,
): OverlayIdentifyGroup | null {
  if (!properties) return null;
  const source = text(properties['source']);
  if (source !== 'nvdb' && source !== 'oslo') return null;
  const rows: Record<string, string> = {};
  const access = ACCESS_LABEL[text(properties['accessible']) ?? ''];
  if (access) rows['Wheelchair accessible'] = access;
  const winter = text(properties['winter']);
  if (winter) rows['Season'] = winter;
  const what = facilities(text(properties['kind']), count(properties['count']));
  if (what) rows['Facilities'] = what;
  const road = text(properties['road']);
  const address = text(properties['address']);
  if (road) rows['Road'] = road;
  else if (address) rows['Address'] = address;
  const notes = text(properties['notes']);
  if (notes) rows['Notes'] = notes;
  const operator = text(properties['operator']);
  if (operator) rows['Run by'] = operator;
  return {
    title: text(properties['name']) ?? (source === 'nvdb' ? 'Roadside toilet' : 'Public toilet'),
    properties: rows,
  };
}
