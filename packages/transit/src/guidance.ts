import { isRideMode, type TransitLeg, type TransitTrip } from './model.js';

/** How long before a vehicle arrives Atlas warns the passenger to get ready. */
export const TRANSIT_ALIGHT_LEAD_MS = 2 * 60_000;

export type TransitGuidancePhase = 'waiting' | 'walking' | 'riding' | 'transfer' | 'arrived';

/** The one screenful a passenger needs at this instant. */
export interface TransitGuidanceSnapshot {
  phase: TransitGuidancePhase;
  legIndex: number;
  headline: string;
  detail: string;
  /** The next departure or arrival this card counts down to. */
  actionAtMs: number | null;
  countdown: string | null;
  /** True during the final warning window on a ridden leg. */
  alightSoon: boolean;
}

/** A platform alarm that a native or browser adapter can schedule without understanding a trip. */
export interface TransitAlightAlarm {
  id: string;
  triggerAtMs: number;
  arrivalAtMs: number;
  title: string;
  body: string;
}

/** Compact, stable countdown wording for a card that updates once a second. */
export function transitCountdown(targetMs: number, nowMs: number): string {
  const remainingMs = Math.max(0, targetMs - nowMs);
  if (remainingMs < 45_000) return 'now';
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

function rideName(leg: TransitLeg): string {
  return leg.line?.publicCode ? `line ${leg.line.publicCode}` : 'public transport';
}

function boardingDetail(leg: TransitLeg): string {
  const platform = leg.from.quay?.publicCode ? ` · platform ${leg.from.quay.publicCode}` : '';
  const destination = leg.line?.headsign ? ` toward ${leg.line.headsign}` : '';
  return `${leg.from.name}${platform}${destination}`;
}

/**
 * Advance a selected journey by its own clock, with no network or GPS required.
 *
 * The selected `TransitTrip` is an immutable snapshot. That is deliberate: if
 * connectivity disappears after boarding, current-leg and alight guidance keep
 * working from the times already received, while the UI says that live changes
 * cannot refresh. Atlas never pretends the snapshot is a new live answer.
 */
export function transitGuidanceAt(
  trip: TransitTrip,
  nowMs: number,
  alightLeadMs = TRANSIT_ALIGHT_LEAD_MS,
): TransitGuidanceSnapshot {
  const legs = trip.legs;
  if (legs.length === 0 || nowMs >= (legs.at(-1)?.expectedEndMs ?? trip.endMs)) {
    return {
      phase: 'arrived',
      legIndex: Math.max(0, legs.length - 1),
      headline: `Arrived${legs.at(-1)?.to.name ? ` at ${legs.at(-1)!.to.name}` : ''}`,
      detail: 'Journey complete',
      actionAtMs: null,
      countdown: null,
      alightSoon: false,
    };
  }

  const legIndex = Math.max(
    0,
    legs.findIndex((leg) => nowMs < leg.expectedEndMs),
  );
  const leg = legs[legIndex]!;
  const beforeLeg = nowMs < leg.expectedStartMs;

  if (beforeLeg) {
    const ride = isRideMode(leg.mode);
    return {
      phase: legIndex === 0 ? 'waiting' : 'transfer',
      legIndex,
      headline: ride ? `Board ${rideName(leg)}` : `Walk to ${leg.to.name}`,
      detail: ride ? boardingDetail(leg) : `Next: ${leg.to.name}`,
      actionAtMs: leg.expectedStartMs,
      countdown: transitCountdown(leg.expectedStartMs, nowMs),
      alightSoon: false,
    };
  }

  if (!isRideMode(leg.mode)) {
    return {
      phase: 'walking',
      legIndex,
      headline: `Walk to ${leg.to.name}`,
      detail: `Arrive ${transitCountdown(leg.expectedEndMs, nowMs)}`,
      actionAtMs: leg.expectedEndMs,
      countdown: transitCountdown(leg.expectedEndMs, nowMs),
      alightSoon: false,
    };
  }

  const remainingMs = leg.expectedEndMs - nowMs;
  const alightSoon = remainingMs <= alightLeadMs;
  return {
    phase: 'riding',
    legIndex,
    headline: alightSoon
      ? `Get off at ${leg.to.name}`
      : `Ride ${rideName(leg)}${leg.line?.headsign ? ` toward ${leg.line.headsign}` : ''}`,
    detail: alightSoon
      ? `${leg.line?.publicCode ?? 'Your stop'} · ${transitCountdown(leg.expectedEndMs, nowMs)}`
      : `Get off at ${leg.to.name} ${transitCountdown(leg.expectedEndMs, nowMs)}`,
    actionAtMs: leg.expectedEndMs,
    countdown: transitCountdown(leg.expectedEndMs, nowMs),
    alightSoon,
  };
}

/** Every ridden leg gets one timetable-driven alight warning. */
export function transitAlightAlarms(
  trip: TransitTrip,
  nowMs: number,
  leadMs = TRANSIT_ALIGHT_LEAD_MS,
): TransitAlightAlarm[] {
  return trip.legs.flatMap((leg, index) => {
    if (!isRideMode(leg.mode) || leg.expectedEndMs <= nowMs) return [];
    const triggerAtMs = Math.max(nowMs + 1_000, leg.expectedEndMs - leadMs);
    return [
      {
        id: `${index}:${leg.aimedEndMs}`,
        triggerAtMs,
        arrivalAtMs: leg.expectedEndMs,
        title: 'Get off soon',
        body: `${leg.line?.publicCode ? `Line ${leg.line.publicCode}: ` : ''}get ready for ${leg.to.name}.`,
      },
    ];
  });
}
