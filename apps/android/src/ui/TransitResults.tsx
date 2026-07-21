import { fmtClock } from '@atlas/core';
import {
  isRideMode,
  legDelayMs,
  RIDE_MODES,
  transferCount,
  type TransitLeg,
  type TransitLine,
  type TransitMode,
  type TransitTrip,
} from '@atlas/transit';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { TransitPlan } from '../routing/useTransit';

/** One glyph per mode — the fastest way to read a board is by shape, not words. */
const MODE_ICON: Record<TransitMode, string> = {
  foot: '🚶',
  bus: '🚌',
  coach: '🚌',
  tram: '🚊',
  metro: '🚇',
  rail: '🚆',
  water: '⛴️',
  air: '✈️',
  funicular: '🚟',
  cableway: '🚡',
  unknown: '•',
};

/** Mode names as a traveller would tick them in a filter. */
const MODE_LABEL: Record<TransitMode, string> = {
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

/** A delay worth painting: under a minute is timetable noise, not news. */
const DELAY_THRESHOLD_MS = 60_000;

/** How far one tap moves the chosen departure/arrival, lacking a native picker. */
const TIME_STEP_MS = 30 * 60_000;

function fmtKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} h ${min} min` : `${min} min`;
}

/** Day + clock, so a departure stepped past midnight doesn't read as today. */
function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? fmtClock(ms)
    : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${fmtClock(ms)}`;
}

/**
 * Departure/arrival time, struck through and corrected when a live feed says
 * the vehicle is off schedule. Both numbers are shown because a traveller
 * standing on a platform needs to know which one the departure board will echo.
 */
function LegTime({
  aimedMs,
  expectedMs,
  realtime,
}: {
  aimedMs: number;
  expectedMs: number;
  realtime: boolean;
}) {
  const delta = expectedMs - aimedMs;
  if (!realtime || Math.abs(delta) < DELAY_THRESHOLD_MS) {
    return <Text style={styles.time}>{fmtClock(expectedMs)}</Text>;
  }
  const minutes = Math.round(delta / 60_000);
  return (
    <Text style={styles.time}>
      <Text style={styles.timeAimed}>{fmtClock(aimedMs)}</Text>{' '}
      <Text style={delta > 0 ? styles.late : styles.early}>
        {fmtClock(expectedMs)} ({minutes > 0 ? `+${minutes}` : minutes} min)
      </Text>
    </Text>
  );
}

/** The line badge as it looks on the vehicle: operator colours when Entur sends them. */
function LineChip({ line }: { line: TransitLine }) {
  // Bare `colour` means "no official colour" — fall back to the panel's own
  // styling rather than inventing one, so a real brand colour still stands out.
  const tint = line.colour
    ? { backgroundColor: line.colour, borderColor: line.colour }
    : styles.lineChipPlain;
  const text = line.colour ? { color: line.textColour ?? '#fff' } : styles.lineChipPlainText;
  return (
    <View style={[styles.lineChip, tint]}>
      <Text style={[styles.lineChipText, text]}>{line.publicCode}</Text>
    </View>
  );
}

/** A quay reference, e.g. "plat. 3" — only rendered when the stop has one. */
function quayNote(leg: TransitLeg, which: 'from' | 'to'): string {
  const code = leg[which].quay?.publicCode;
  return code ? ` · plat. ${code}` : '';
}

/** One row of the expanded journey: a walk, or a ride on one vehicle. */
function LegRow({ leg }: { leg: TransitLeg }) {
  const [showStops, setShowStops] = useState(false);
  const ride = isRideMode(leg.mode);
  const stops = leg.intermediateStops.length;

  return (
    <View style={styles.leg}>
      <Text style={styles.legIcon}>{MODE_ICON[leg.mode]}</Text>
      <View style={styles.legBody}>
        {ride && leg.line ? (
          <>
            <View style={styles.legHead}>
              <LegTime
                aimedMs={leg.aimedStartMs}
                expectedMs={leg.expectedStartMs}
                realtime={leg.realtime}
              />
              <LineChip line={leg.line} />
              {leg.line.headsign ? (
                <Text style={styles.headsign} numberOfLines={1}>
                  → {leg.line.headsign}
                </Text>
              ) : null}
            </View>
            <Text style={styles.legDetail}>
              {leg.from.name}
              {quayNote(leg, 'from')}
            </Text>
            {stops > 0 ? (
              <Pressable onPress={() => setShowStops((v) => !v)} testID="transit-stops-toggle">
                <Text style={styles.link}>
                  {showStops ? '▾' : '▸'} {stops} {stops === 1 ? 'stop' : 'stops'} ·{' '}
                  {fmtDuration(leg.durationMs)}
                </Text>
              </Pressable>
            ) : null}
            {showStops
              ? leg.intermediateStops.map((stop, i) => (
                  <Text key={`${stop.name}-${i}`} style={styles.stopName}>
                    {stop.name}
                  </Text>
                ))
              : null}
            <View style={styles.legHead}>
              <LegTime
                aimedMs={leg.aimedEndMs}
                expectedMs={leg.expectedEndMs}
                realtime={leg.realtime}
              />
              <Text style={styles.legDetail}>
                {leg.to.name}
                {quayNote(leg, 'to')}
              </Text>
            </View>
          </>
        ) : (
          // Walk legs carry no line and no live feed: distance and duration are
          // the whole story, and the destination names what you are walking to.
          <Text style={styles.legDetail}>
            Walk {fmtDuration(leg.durationMs)} · {fmtKm(leg.distanceM)}
            {leg.to.name ? ` to ${leg.to.name}` : ''}
            {quayNote(leg, 'to')}
          </Text>
        )}
      </View>
    </View>
  );
}

/** A journey option: summary row always, full legs when expanded. */
function TripCard({
  trip,
  expanded,
  onToggle,
  index,
}: {
  trip: TransitTrip;
  expanded: boolean;
  onToggle: () => void;
  index: number;
}) {
  const transfers = transferCount(trip);
  // The delay that decides whether you make it: the first vehicle you board.
  const firstRide = trip.legs.find((leg) => isRideMode(leg.mode));
  const delay = firstRide ? legDelayMs(firstRide) : 0;
  const late = firstRide?.realtime === true && delay >= DELAY_THRESHOLD_MS;

  return (
    <View style={[styles.trip, expanded && styles.tripSelected]}>
      <Pressable onPress={onToggle} testID={`transit-trip-${index}`}>
        <View style={styles.tripHead}>
          <Text style={styles.tripTimes}>
            {fmtClock(trip.startMs)} – {fmtClock(trip.endMs)}
          </Text>
          {late ? <Text style={styles.late}>+{Math.round(delay / 60_000)} min</Text> : null}
        </View>
        <View style={styles.tripLines}>
          {trip.legs.map((leg, i) =>
            leg.line ? (
              <LineChip key={i} line={leg.line} />
            ) : (
              <Text key={i} style={styles.legIcon}>
                {MODE_ICON[leg.mode]}
              </Text>
            ),
          )}
        </View>
        <Text style={styles.tripMeta}>
          {fmtDuration(trip.durationMs)} ·{' '}
          {transfers === 0 ? 'direct' : `${transfers} ${transfers === 1 ? 'change' : 'changes'}`} ·
          🚶 {fmtKm(trip.walkDistanceM)}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.legs}>
          {trip.legs.map((leg, i) => (
            <LegRow key={i} leg={leg} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The public transport result board: when to leave, which options exist, and
 * what each journey is made of. Everything here is timetable-bound and
 * online-only — an empty answer means "nothing runs then", which is worded
 * differently from the planner being unreachable.
 *
 * There is no native date picker in this build (adding one would mean a new
 * APK rather than an OTA update), so an exact time is reached by stepping in
 * half hours, and the Earlier/Later paging below walks real departures.
 */
export function TransitResults({ transit }: { transit: TransitPlan }) {
  const [showFilters, setShowFilters] = useState(false);
  const trips = transit.trips;
  const first = trips?.[0];
  const last = trips && trips.length > 0 ? trips[trips.length - 1] : undefined;
  const timing = transit.timeMs === null ? 'now' : transit.arriveBy ? 'arrive' : 'depart';
  // An empty mode list means "all of them", so it is not a filter.
  const filtered = transit.modes.length > 0;
  const accepts = (mode: TransitMode) => !filtered || transit.modes.includes(mode);

  const pick = (choice: 'now' | 'depart' | 'arrive') => {
    if (choice === 'now') {
      transit.setTimeMs(null);
      transit.setArriveBy(false);
      return;
    }
    transit.setArriveBy(choice === 'arrive');
    if (transit.timeMs === null) transit.setTimeMs(Date.now());
  };

  // Paging a timetable is done in *departures*, not in fixed time steps: the
  // next page starts just after the earliest option already shown, so nothing
  // is skipped however sparse or dense the service is.
  const showEarlier = () => {
    if (!first) return;
    transit.setArriveBy(true);
    transit.setTimeMs(first.startMs - 60_000);
  };
  const showLater = () => {
    if (!last) return;
    transit.setArriveBy(false);
    transit.setTimeMs((trips!.length > 1 ? first!.startMs : last.startMs) + 60_000);
  };

  return (
    <View style={styles.board}>
      <View style={styles.chipRow}>
        {(['now', 'depart', 'arrive'] as const).map((choice) => (
          <Pressable
            key={choice}
            style={[styles.chip, timing === choice && styles.chipSelected]}
            onPress={() => pick(choice)}
            testID={`transit-when-${choice}`}
          >
            <Text style={styles.chipText}>
              {choice === 'now' ? 'Leave now' : choice === 'depart' ? 'Depart at' : 'Arrive by'}
            </Text>
          </Pressable>
        ))}
        <Pressable
          style={[styles.chip, filtered && styles.chipSelected]}
          onPress={() => setShowFilters((v) => !v)}
          testID="transit-modes-toggle"
        >
          <Text style={styles.chipText}>Modes{filtered ? ` (${transit.modes.length})` : ''}</Text>
        </Pressable>
      </View>

      {timing === 'now' ? (
        <Pressable onPress={transit.refresh} testID="transit-refresh">
          <Text style={styles.link}>↻ Refresh departures</Text>
        </Pressable>
      ) : (
        <View style={styles.timeRow}>
          <Pressable
            style={[styles.chip, styles.stepChip]}
            onPress={() => transit.setTimeMs((transit.timeMs ?? Date.now()) - TIME_STEP_MS)}
            testID="transit-time-earlier"
          >
            <Text style={styles.chipText}>−30 min</Text>
          </Pressable>
          <Text style={styles.timeValue}>{fmtWhen(transit.timeMs ?? Date.now())}</Text>
          <Pressable
            style={[styles.chip, styles.stepChip]}
            onPress={() => transit.setTimeMs((transit.timeMs ?? Date.now()) + TIME_STEP_MS)}
            testID="transit-time-later"
          >
            <Text style={styles.chipText}>+30 min</Text>
          </Pressable>
        </View>
      )}

      {showFilters ? (
        <View style={styles.chipRow}>
          {RIDE_MODES.map((mode) => (
            <Pressable
              key={mode}
              style={[styles.chip, accepts(mode) && styles.chipSelected]}
              onPress={() => transit.toggleMode(mode)}
              testID={`transit-mode-${mode}`}
            >
              <Text style={styles.chipText}>
                {MODE_ICON[mode]} {MODE_LABEL[mode]}
              </Text>
            </Pressable>
          ))}
          <Text style={styles.muted}>Walking to and between stops is always included.</Text>
          {filtered ? (
            <Pressable onPress={transit.clearModes} testID="transit-all-modes">
              <Text style={styles.link}>Use all modes</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {transit.loading ? <Text style={styles.muted}>Looking up departures…</Text> : null}
      {transit.error ? <Text style={styles.error}>{transit.error}</Text> : null}
      {!transit.loading && !transit.error && trips?.length === 0 ? (
        // Two very different empty answers: nothing runs, versus nothing runs
        // *that you allowed*. Blaming the timetable for the traveller's own
        // filter would send them hunting for a departure that exists.
        <View>
          <Text style={styles.muted}>
            {filtered
              ? 'No journeys with the modes you picked.'
              : 'No departures found for this time. Try a different time or a nearer stop.'}
          </Text>
          {filtered ? (
            <Pressable onPress={transit.clearModes} testID="transit-all-modes-empty">
              <Text style={styles.link}>Use all modes</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {trips && trips.length > 0 ? (
        <>
          <Pressable onPress={showEarlier} testID="transit-earlier">
            <Text style={styles.link}>↑ Earlier</Text>
          </Pressable>
          {trips.map((trip, i) => (
            <TripCard
              key={`${trip.startMs}-${i}`}
              trip={trip}
              index={i}
              expanded={transit.selected === i}
              onToggle={() => transit.select(transit.selected === i ? null : i)}
            />
          ))}
          <Pressable onPress={showLater} testID="transit-later">
            <Text style={styles.link}>↓ Later</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  board: { gap: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#f1f3f7',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  chipSelected: { borderColor: '#1a73e8', backgroundColor: '#e7effd' },
  chipText: { fontSize: 13, color: '#334', fontWeight: '600' },
  stepChip: { paddingHorizontal: 10 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  timeValue: { fontSize: 15, fontWeight: '700', color: '#111', flexGrow: 1, textAlign: 'center' },
  muted: { fontSize: 13, color: '#778' },
  link: { fontSize: 13, color: '#1a73e8', fontWeight: '600', paddingVertical: 4 },
  error: { fontSize: 13, color: '#b3261e' },
  trip: {
    borderWidth: 1,
    borderColor: '#e2e6ee',
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  tripSelected: { borderColor: '#1a73e8', backgroundColor: '#f7faff' },
  tripHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tripTimes: { fontSize: 15, fontWeight: '700', color: '#111' },
  tripLines: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
  tripMeta: { fontSize: 12, color: '#667' },
  legs: { marginTop: 6, gap: 8, borderTopWidth: 1, borderTopColor: '#eef1f6', paddingTop: 8 },
  leg: { flexDirection: 'row', gap: 8 },
  legIcon: { fontSize: 14 },
  legBody: { flexShrink: 1, flexGrow: 1, gap: 2 },
  legHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  legDetail: { fontSize: 13, color: '#223', flexShrink: 1 },
  headsign: { fontSize: 12, color: '#667', flexShrink: 1 },
  stopName: { fontSize: 12, color: '#778', paddingLeft: 10 },
  time: { fontSize: 13, fontWeight: '700', color: '#111' },
  timeAimed: { textDecorationLine: 'line-through', color: '#889', fontWeight: '400' },
  late: { color: '#b3261e', fontWeight: '700', fontSize: 13 },
  early: { color: '#1e7d32', fontWeight: '700', fontSize: 13 },
  lineChip: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
  },
  lineChipPlain: { backgroundColor: '#eef1f6', borderColor: '#cdd3dd' },
  lineChipText: { fontSize: 12, fontWeight: '700' },
  lineChipPlainText: { color: '#334' },
});
