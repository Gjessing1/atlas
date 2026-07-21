import { fmtClock } from '@atlas/core';
import {
  isRideMode,
  legDelayMs,
  RIDE_MODES,
  transferCount,
  transitProblemMessage,
  tripNeedsBooking,
  tripSeverity,
  type TransitBooking,
  type TransitLeg,
  type TransitLine,
  type TransitMode,
  type TransitSeverity,
  type TransitSituation,
  type TransitTrip,
} from '@atlas/transit';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import type { TransitPlan } from '../routing/useTransit';
import { transitIcon } from './modeIcons';

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

/** Mode glyph at board size — vector, so it takes the row's colour. */
function ModeIcon({
  mode,
  size = 16,
  color,
}: {
  mode: TransitMode;
  size?: number;
  color?: string;
}) {
  const Icon = transitIcon(mode);
  return <Icon size={size} color={color ?? '#5a6478'} />;
}

/**
 * Skin for a severity. A function rather than a lookup table because `styles`
 * is defined at the foot of the file — a module-level table would read it
 * before it exists.
 */
function severityStyle(severity: TransitSeverity) {
  if (severity === 'info') {
    return { box: styles.noticeInfo, text: styles.noticeInfoText, mark: 'i' };
  }
  if (severity === 'severe') {
    return { box: styles.noticeSevere, text: styles.noticeSevereText, mark: '!' };
  }
  return { box: styles.noticeWarn, text: styles.noticeWarnText, mark: '!' };
}

/**
 * A disruption notice. Collapsed to its headline, because a leg can carry four
 * of them and an operator's full text runs to paragraphs — but expandable,
 * since the advice ("use the replacement bus from stand F") is usually the only
 * part that changes what the traveller does.
 */
function SituationNotice({ situation }: { situation: TransitSituation }) {
  const [open, setOpen] = useState(false);
  const skin = severityStyle(situation.severity);
  const detail = situation.advice ?? situation.description;
  return (
    <Pressable
      style={[styles.notice, skin.box]}
      onPress={() => detail && setOpen((v) => !v)}
      testID="transit-situation"
    >
      <Text style={[styles.noticeMark, skin.text]}>{skin.mark}</Text>
      <View style={styles.noticeBody}>
        <Text style={[styles.noticeText, skin.text]} numberOfLines={open ? undefined : 2}>
          {situation.summary}
        </Text>
        {open && detail ? <Text style={styles.noticeDetail}>{detail}</Text> : null}
        {open && situation.url ? (
          <Text style={styles.link} onPress={() => void Linking.openURL(situation.url!)}>
            Operator's notice ↗
          </Text>
        ) : null}
        {!open && detail ? <Text style={styles.noticeMore}>Tap for details</Text> : null}
      </View>
    </Pressable>
  );
}

/** How to book a flexible service, in the order a traveller would try them. */
function bookingHow(booking: TransitBooking): string {
  if (booking.phone) return `Book by phone: ${booking.phone}`;
  if (booking.methods.includes('online') && booking.url) return 'Book online before travelling';
  if (booking.methods.includes('callDriver')) return 'Call the driver to book';
  if (booking.methods.includes('callOffice')) return 'Call the operator to book';
  if (booking.methods.includes('text')) return 'Book by text message';
  return 'This service must be booked in advance';
}

/** By when, phrased the way the operator means it rather than as a raw offset. */
function bookingWhen(booking: TransitBooking): string | null {
  if (!booking.latestTime) return null;
  const days = booking.latestDayOffset ?? 0;
  if (days <= 0) return `by ${booking.latestTime} the same day`;
  if (days === 1) return `by ${booking.latestTime} the day before`;
  return `by ${booking.latestTime}, ${days} days ahead`;
}

/**
 * The booking notice for flexible transport. This is not a nicety: an
 * unbooked `bestillingstransport` bus does not turn up at all, so a leg shown
 * as an ordinary departure would strand someone at a rural stop.
 */
function BookingNotice({ booking }: { booking: TransitBooking }) {
  const when = bookingWhen(booking);
  return (
    <View style={[styles.notice, styles.noticeWarn]} testID="transit-booking">
      <Text style={[styles.noticeMark, styles.noticeWarnText]}>☎</Text>
      <View style={styles.noticeBody}>
        <Text style={[styles.noticeText, styles.noticeWarnText]}>
          Must be booked ahead{when ? ` — ${when}` : ''}
        </Text>
        <Text style={styles.noticeDetail}>{bookingHow(booking)}</Text>
        {booking.note ? <Text style={styles.noticeDetail}>{booking.note}</Text> : null}
        {booking.url ? (
          <Text style={styles.link} onPress={() => void Linking.openURL(booking.url!)}>
            Booking page ↗
          </Text>
        ) : null}
      </View>
    </View>
  );
}

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
      <View style={styles.legIcon}>
        <ModeIcon mode={leg.mode} />
      </View>
      <View style={styles.legBody}>
        {/* Disruptions ride above the times deliberately: a cancelled service
            with a confident departure time is the one thing a journey planner
            must never render calmly. */}
        {leg.situations.map((situation, i) => (
          <SituationNotice key={situation.id ?? i} situation={situation} />
        ))}
        {leg.booking ? <BookingNotice booking={leg.booking} /> : null}
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
            {/* Who runs it decides which ticket app you need, and the query
                already asks for it — it was fetched and then thrown away. */}
            {leg.line.operator ? (
              <Text style={styles.operator} numberOfLines={1}>
                {leg.line.operator}
              </Text>
            ) : null}
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
  onShowMap,
  index,
}: {
  trip: TransitTrip;
  expanded: boolean;
  onToggle: () => void;
  onShowMap: () => void;
  index: number;
}) {
  const transfers = transferCount(trip);
  // The delay that decides whether you make it: the first vehicle you board.
  const firstRide = trip.legs.find((leg) => isRideMode(leg.mode));
  const delay = firstRide ? legDelayMs(firstRide) : 0;
  const late = firstRide?.realtime === true && delay >= DELAY_THRESHOLD_MS;
  // A collapsed card must not look clean when a leg inside it is cancelled —
  // the whole point of the summary row is deciding without expanding.
  const severity = tripSeverity(trip);
  const needsBooking = tripNeedsBooking(trip);

  return (
    <View style={[styles.trip, expanded && styles.tripSelected]}>
      <Pressable onPress={onToggle} testID={`transit-trip-${index}`}>
        <View style={styles.tripHead}>
          <Text style={styles.tripTimes}>
            {fmtClock(trip.startMs)} – {fmtClock(trip.endMs)}
          </Text>
          {late ? <Text style={styles.late}>+{Math.round(delay / 60_000)} min</Text> : null}
          {severity ? (
            <Text
              style={[styles.tripFlag, severityStyle(severity).text]}
              testID="transit-trip-alert"
            >
              {severity === 'severe' ? '! Disruption' : '! Notice'}
            </Text>
          ) : null}
          {needsBooking ? (
            <Text style={[styles.tripFlag, styles.noticeWarnText]}>☎ Book ahead</Text>
          ) : null}
        </View>
        <View style={styles.tripLines}>
          {trip.legs.map((leg, i) =>
            leg.line ? (
              <LineChip key={i} line={leg.line} />
            ) : (
              <View key={i} style={styles.legIcon}>
                <ModeIcon mode={leg.mode} size={15} />
              </View>
            ),
          )}
        </View>
        <View style={styles.tripMetaRow}>
          <Text style={styles.tripMeta}>
            {fmtDuration(trip.durationMs)} ·{' '}
            {transfers === 0 ? 'direct' : `${transfers} ${transfers === 1 ? 'change' : 'changes'}`}{' '}
            ·{' '}
          </Text>
          <ModeIcon mode="foot" size={13} color="#667" />
          <Text style={styles.tripMeta}> {fmtKm(trip.walkDistanceM)}</Text>
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.legs}>
          <Pressable
            style={styles.showMapButton}
            onPress={onShowMap}
            testID={`transit-show-map-${index}`}
          >
            <Text style={styles.showMapText}>Show on map</Text>
          </Pressable>
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
export function TransitResults({
  transit,
  onShowMap,
}: {
  transit: TransitPlan;
  onShowMap: (trip: TransitTrip, index: number) => void;
}) {
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

  // Paging uses Entur's own page cursors, which know exactly where the last
  // page ended — the old arithmetic (re-query at "one minute after the first
  // departure shown") both skipped and repeated departures at the seam when
  // several left in the same minute. Falls back to that arithmetic only if the
  // planner sent no cursor, which it does at the very ends of the timetable.
  const showEarlier =
    transit.pageEarlier ??
    (first
      ? () => {
          transit.setArriveBy(true);
          transit.setTimeMs(first.startMs - 60_000);
        }
      : null);
  const showLater =
    transit.pageLater ??
    (last
      ? () => {
          transit.setArriveBy(false);
          transit.setTimeMs((trips!.length > 1 ? first!.startMs : last.startMs) + 60_000);
        }
      : null);

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
              style={[styles.chip, styles.modeChip, accepts(mode) && styles.chipSelected]}
              onPress={() => transit.toggleMode(mode)}
              accessibilityState={{ selected: accepts(mode) }}
              testID={`transit-mode-${mode}`}
            >
              {/* Labelled here, unlike the travel-mode picker: a filter is a
                  list of promises about what will be excluded, and "no ferries"
                  has to be unambiguous in a way a glyph alone is not. */}
              <ModeIcon mode={mode} size={15} color={accepts(mode) ? '#1a73e8' : '#5a6478'} />
              <Text style={styles.chipText}> {MODE_LABEL[mode]}</Text>
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

      {/* The chip is offered before both ends are known (that is what makes the
          mode discoverable), so the board has to say what it is still missing
          rather than sitting blank. */}
      {!transit.covered ? (
        <Text style={styles.muted}>Add a start and a destination to see journeys.</Text>
      ) : null}
      {transit.loading ? <Text style={styles.muted}>Looking up departures…</Text> : null}
      {transit.error ? <Text style={styles.error}>{transit.error}</Text> : null}
      {!transit.loading && !transit.error && trips?.length === 0 ? (
        // Two very different empty answers: nothing runs, versus nothing runs
        // *that you allowed*. Blaming the timetable for the traveller's own
        // filter would send them hunting for a departure that exists.
        <View>
          {/* The planner usually says *which* nothing this is — no stops in
              range, outside the timetable's date range, nothing in this search
              window. Its reason beats our guess; ours is the fallback. */}
          <Text style={styles.muted}>
            {filtered
              ? 'No journeys with the modes you picked.'
              : (transitProblemMessage(transit.problems) ??
                'No departures found for this time. Try a different time or a nearer stop.')}
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
          {/* Absent, not disabled, when the planner has no earlier page: at the
              first departure of the service day there genuinely is no earlier. */}
          {showEarlier ? (
            <Pressable onPress={showEarlier} testID="transit-earlier">
              <Text style={styles.link}>↑ Earlier</Text>
            </Pressable>
          ) : null}
          {trips.map((trip, i) => (
            <TripCard
              key={`${trip.startMs}-${i}`}
              trip={trip}
              index={i}
              expanded={transit.selected === i}
              onToggle={() => transit.select(transit.selected === i ? null : i)}
              onShowMap={() => onShowMap(trip, i)}
            />
          ))}
          {showLater ? (
            <Pressable onPress={showLater} testID="transit-later">
              <Text style={styles.link}>↓ Later</Text>
            </Pressable>
          ) : null}
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
  modeChip: { flexDirection: 'row', alignItems: 'center' },
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
  showMapButton: {
    alignSelf: 'flex-start',
    borderRadius: 16,
    backgroundColor: '#e7effd',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  showMapText: { fontSize: 13, fontWeight: '700', color: '#1a73e8' },
  tripHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tripTimes: { fontSize: 15, fontWeight: '700', color: '#111' },
  tripLines: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
  tripMeta: { fontSize: 12, color: '#667' },
  tripMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  tripFlag: { fontSize: 11, fontWeight: '700' },
  // Notices sit in a tinted well rather than as coloured text: a cancellation
  // has to survive being skimmed past at the top of a dense leg.
  notice: {
    flexDirection: 'row',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 2,
  },
  noticeBody: { flexShrink: 1, flexGrow: 1, gap: 2 },
  noticeMark: { fontSize: 13, fontWeight: '800', width: 12, textAlign: 'center' },
  noticeText: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
  noticeDetail: { fontSize: 12, color: '#445' },
  noticeMore: { fontSize: 11, color: '#889' },
  noticeInfo: { backgroundColor: '#eef3fb', borderColor: '#cfdcf2' },
  noticeInfoText: { color: '#1a4d8f' },
  noticeWarn: { backgroundColor: '#fff5e6', borderColor: '#f2ddb8' },
  noticeWarnText: { color: '#8a5300' },
  noticeSevere: { backgroundColor: '#fdecea', borderColor: '#f3c4bf' },
  noticeSevereText: { color: '#b3261e' },
  legs: { marginTop: 6, gap: 8, borderTopWidth: 1, borderTopColor: '#eef1f6', paddingTop: 8 },
  leg: { flexDirection: 'row', gap: 8 },
  legIcon: { alignItems: 'center', justifyContent: 'center' },
  legBody: { flexShrink: 1, flexGrow: 1, gap: 2 },
  legHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  legDetail: { fontSize: 13, color: '#223', flexShrink: 1 },
  headsign: { fontSize: 12, color: '#667', flexShrink: 1 },
  stopName: { fontSize: 12, color: '#778', paddingLeft: 10 },
  operator: { fontSize: 11, color: '#889' },
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
