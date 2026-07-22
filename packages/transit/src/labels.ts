/**
 * Journey-board presentation: the words a trip, a leg and a disruption are
 * described with, and the derived numbers behind them.
 *
 * Web and Android render the transit board with their own markup — `<span>`s
 * and CSS classes on one side, `<Text>` and `StyleSheet` on the other — but
 * they must *say* the same things: "2 changes", "+4 min", "Must be booked
 * ahead — by 14:00 the day before". These lived as byte-identical copies in
 * both boards (mode names, both booking phrasings, the delay threshold, the
 * transfer and stop plurals) until they were pulled here. Copies of a label
 * are copies that eventually disagree, and a journey planner disagreeing with
 * itself about whether a bus must be booked leaves someone at a rural stop.
 *
 * Everything here is a pure function of the trip model: no React, no styling,
 * no platform. The apps keep the glyphs and the colours, which genuinely do
 * differ (emoji vs. vector icons, CSS classes vs. style objects).
 */

import { fmtClock, fmtDuration, fmtKm } from '@atlas/core';

import {
  isRideMode,
  legDelayMs,
  transferCount,
  tripLineCodes,
  tripNeedsBooking,
  tripSeverity,
  type TransitBooking,
  type TransitLeg,
  type TransitMode,
  type TransitPlace,
  type TransitSeverity,
  type TransitTrip,
} from './model.js';

/** Mode names as a traveller would tick them in a filter. */
export const TRANSIT_MODE_LABEL: Record<TransitMode, string> = {
  foot: 'Walk',
  bus: 'Bus',
  coach: 'Coach',
  tram: 'Tram',
  metro: 'Metro',
  rail: 'Train',
  water: 'Ferry',
  air: 'Flight',
  funicular: 'Funicular',
  cableway: 'Cable car',
  unknown: 'Other',
};

/**
 * A delay worth painting: under a minute is timetable noise, not news. Shared
 * because a board that flags a 40-second delay on one platform and not the
 * other is reporting the same vehicle as both late and on time.
 */
export const DELAY_THRESHOLD_MS = 60_000;

/** A delay as the traveller reads it, signed: "+4 min", "-2 min". */
export function delayLabel(deltaMs: number): string {
  const minutes = Math.round(deltaMs / 60_000);
  return `${minutes > 0 ? '+' : ''}${minutes} min`;
}

/** How a time reads against its timetable: as printed, or corrected late/early. */
export type TransitTimeTone = 'ontime' | 'late' | 'early';

/** A departure or arrival time, split into the parts a board paints separately. */
export interface LegTimeParts {
  /** The timetabled time — shown struck through, and only when it is being corrected. */
  aimed: string;
  /** The time to actually turn up for; equals `aimed` when nothing is known to differ. */
  expected: string;
  /** "+4 min" / "-2 min", or null when there is nothing worth correcting. */
  delay: string | null;
  tone: TransitTimeTone;
}

/**
 * Departure/arrival time against its timetable. Both numbers are kept because
 * a traveller standing on a platform needs to know which one the departure
 * board will echo — but only when they differ by enough to matter, and only
 * when a live feed actually said so.
 */
export function legTimeParts(time: {
  aimedMs: number;
  expectedMs: number;
  realtime: boolean;
}): LegTimeParts {
  const delta = time.expectedMs - time.aimedMs;
  const aimed = fmtClock(time.aimedMs);
  const expected = fmtClock(time.expectedMs);
  if (!time.realtime || Math.abs(delta) < DELAY_THRESHOLD_MS) {
    return { aimed, expected, delay: null, tone: 'ontime' };
  }
  return { aimed, expected, delay: delayLabel(delta), tone: delta > 0 ? 'late' : 'early' };
}

/** The platform/track/stand as the sign says it — "plat. 3" — or null when the stop has none. */
export function quayLabel(place: TransitPlace): string | null {
  const code = place.quay?.publicCode;
  return code ? `plat. ${code}` : null;
}

/** The mark that leads a disruption well: a warning is not an aside. */
export function severityMark(severity: TransitSeverity): string {
  return severity === 'info' ? 'i' : '!';
}

/**
 * What a collapsed card calls the disruption inside it. Only two words are
 * needed: whether the journey may not happen, or whether there is something
 * to read once you have decided.
 */
export function severityFlagLabel(severity: TransitSeverity): string {
  return severity === 'severe' ? 'Disruption' : 'Notice';
}

/** How to book a flexible service, in the order a traveller would try them. */
export function bookingHowLabel(booking: TransitBooking): string {
  if (booking.phone) return `Book by phone: ${booking.phone}`;
  if (booking.methods.includes('online') && booking.url) return 'Book online before travelling';
  if (booking.methods.includes('callDriver')) return 'Call the driver to book';
  if (booking.methods.includes('callOffice')) return 'Call the operator to book';
  if (booking.methods.includes('text')) return 'Book by text message';
  return 'This service must be booked in advance';
}

/** By when, phrased the way the operator means it rather than as a raw offset. */
export function bookingDeadlineLabel(booking: TransitBooking): string | null {
  if (!booking.latestTime) return null;
  const days = booking.latestDayOffset ?? 0;
  if (days <= 0) return `by ${booking.latestTime} the same day`;
  if (days === 1) return `by ${booking.latestTime} the day before`;
  return `by ${booking.latestTime}, ${days} days ahead`;
}

/** The booking headline: the requirement, with its deadline when there is one. */
export function bookingSummaryLabel(booking: TransitBooking): string {
  const when = bookingDeadlineLabel(booking);
  return `Must be booked ahead${when ? ` — ${when}` : ''}`;
}

/** How many stops the leg passes through, and how long that takes: "3 stops · 12 min". */
export function legStopsLabel(leg: TransitLeg): string {
  const stops = leg.intermediateStops.length;
  return `${stops} ${stops === 1 ? 'stop' : 'stops'} · ${fmtDuration(leg.durationMs)}`;
}

/**
 * A walk leg in one line. Walk legs carry no line and no live feed: duration
 * and distance are the whole story, and the destination names what you are
 * walking to.
 */
export function walkLegLabel(leg: TransitLeg): string {
  const to = leg.to.name ? ` to ${leg.to.name}` : '';
  return `Walk ${fmtDuration(leg.durationMs)} · ${fmtKm(leg.distanceM)}${to}`;
}

/**
 * The board's standing caveat, stated rather than discovered. Public transport
 * is Atlas's one deliberate exception to offline-first — a timetable cannot be
 * recomputed from local data, so a screen kept open off-grid is showing history
 * with no way to know it. Naming the time it was checked lets the answer age
 * visibly in front of the traveller, which the absence of an error never does.
 */
export function liveTimetableLabel(checkedMs: number | null): string {
  if (checkedMs === null) return 'Live timetable — needs a connection.';
  return `Live timetable, checked ${fmtClock(checkedMs)} — needs a connection to update.`;
}

/**
 * Per-passenger CO₂ as a traveller can hold it: grams below a kilo, one
 * decimal of a kilo above. Null when the planner had no figure — an unknown
 * emission is silence, not a zero, because the number's whole job is to make
 * the comparison with driving honest.
 */
export function co2Label(grams: number | undefined): string | null {
  if (grams === undefined || !Number.isFinite(grams) || grams < 0) return null;
  if (grams < 1000) return `${Math.round(grams)} g CO₂`;
  const kg = grams / 1000;
  return `${kg < 10 ? kg.toFixed(1) : Math.round(kg)} kg CO₂`;
}

/** "direct" / "1 change" / "3 changes" — a change is what makes a journey fail. */
export function transfersLabel(transfers: number): string {
  if (transfers === 0) return 'direct';
  return `${transfers} ${transfers === 1 ? 'change' : 'changes'}`;
}

/** Everything a collapsed journey card states, derived once. */
export interface TripSummary {
  /** "14:03 – 14:52", the ends of the journey. */
  times: string;
  /**
   * Live delay on the first vehicle boarded — the one that decides whether you
   * make it — or null when nothing is running late enough to say so.
   */
  delay: string | null;
  /** The worst disruption anywhere inside, so a collapsed card never looks clean when it is not. */
  severity: TransitSeverity | null;
  /** "Disruption" / "Notice", paired with `severity`. */
  severityLabel: string | null;
  /** Some leg will not turn up unless it is booked ahead. */
  needsBooking: boolean;
  transfers: number;
  /** "48 min · 2 changes" — the walk is quoted separately, next to its own glyph. */
  meta: string;
  /** Total walking distance, e.g. "1.2 km". */
  walk: string;
  /** "740 g CO₂" per passenger, or null when the planner had no figure. */
  co2: string | null;
  /** Line codes in order — the screen-reader rendering of the line chips. */
  lineCodes: string[];
}

/**
 * Everything the summary row of a journey card says. Derived here rather than
 * in each card because deciding *without expanding* is the whole point of the
 * row: if the two apps disagree about which delay to quote or whether a
 * cancellation is visible while collapsed, one of them is quietly lying.
 */
export function tripSummary(trip: TransitTrip): TripSummary {
  const transfers = transferCount(trip);
  const severity = tripSeverity(trip);
  // The delay that decides whether you make it: the first vehicle you board.
  const firstRide = trip.legs.find((leg) => isRideMode(leg.mode));
  const delta = firstRide ? legDelayMs(firstRide) : 0;
  const late = firstRide?.realtime === true && delta >= DELAY_THRESHOLD_MS;
  return {
    times: `${fmtClock(trip.startMs)} – ${fmtClock(trip.endMs)}`,
    delay: late ? delayLabel(delta) : null,
    severity,
    severityLabel: severity ? severityFlagLabel(severity) : null,
    needsBooking: tripNeedsBooking(trip),
    transfers,
    meta: `${fmtDuration(trip.durationMs)} · ${transfersLabel(transfers)}`,
    walk: fmtKm(trip.walkDistanceM),
    co2: co2Label(trip.co2Grams),
    lineCodes: tripLineCodes(trip),
  };
}
