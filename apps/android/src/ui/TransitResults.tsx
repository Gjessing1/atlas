import { useTransitBoard } from '@atlas/app-hooks';
import { fmtWhenClock } from '@atlas/core';
import {
  bookingHowLabel,
  bookingSummaryLabel,
  isRideMode,
  legStopsLabel,
  legTimeParts,
  quayLabel,
  RIDE_MODES,
  severityMark,
  TRANSIT_MODE_LABEL,
  tripSummary,
  walkLegLabel,
  type TransitBooking,
  type TransitLeg,
  type TransitLine,
  type TransitMode,
  type TransitSeverity,
  type TransitSituation,
  type TransitTrip,
} from '@atlas/transit';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import type { TransitPlan } from '../routing/useTransit';
import { transitIcon } from './modeIcons';
import { theme } from './theme';

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
  return <Icon size={size} color={color ?? theme.icon} />;
}

/**
 * Skin for a severity. A function rather than a lookup table because `styles`
 * is defined at the foot of the file — a module-level table would read it
 * before it exists.
 */
function severityStyle(severity: TransitSeverity) {
  if (severity === 'info') {
    return { box: styles.noticeInfo, text: styles.noticeInfoText };
  }
  if (severity === 'severe') {
    return { box: styles.noticeSevere, text: styles.noticeSevereText };
  }
  return { box: styles.noticeWarn, text: styles.noticeWarnText };
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
      <Text style={[styles.noticeMark, skin.text]}>{severityMark(situation.severity)}</Text>
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

/**
 * The booking notice for flexible transport. This is not a nicety: an
 * unbooked `bestillingstransport` bus does not turn up at all, so a leg shown
 * as an ordinary departure would strand someone at a rural stop.
 */
function BookingNotice({ booking }: { booking: TransitBooking }) {
  return (
    <View style={[styles.notice, styles.noticeWarn]} testID="transit-booking">
      <Text style={[styles.noticeMark, styles.noticeWarnText]}>☎</Text>
      <View style={styles.noticeBody}>
        <Text style={[styles.noticeText, styles.noticeWarnText]}>
          {bookingSummaryLabel(booking)}
        </Text>
        <Text style={styles.noticeDetail}>{bookingHowLabel(booking)}</Text>
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

/**
 * Ask for a departure/arrival moment with the platform's own pickers: date
 * first, then clock, which is Android's standing two-step for a datetime.
 * Dismissing either step leaves the chosen time alone — a half-answered
 * question must not move the board.
 *
 * `is24Hour` is forced because Atlas states times in 24-hour form everywhere
 * (see `fmtClock`); a picker that disagreed with the board it feeds would be
 * the one place a traveller reads am/pm.
 */
function pickDateTime(currentMs: number, onPicked: (ms: number) => void): void {
  DateTimePickerAndroid.open({
    value: new Date(currentMs),
    mode: 'date',
    onChange: (dateEvent, date) => {
      if (dateEvent.type !== 'set' || !date) return;
      DateTimePickerAndroid.open({
        value: date,
        mode: 'time',
        is24Hour: true,
        onChange: (timeEvent, time) => {
          if (timeEvent.type !== 'set' || !time) return;
          const picked = new Date(date);
          picked.setHours(time.getHours(), time.getMinutes(), 0, 0);
          onPicked(picked.getTime());
        },
      });
    },
  });
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
  predictionInaccurate,
}: {
  aimedMs: number;
  expectedMs: number;
  realtime: boolean;
  predictionInaccurate?: boolean;
}) {
  const time = legTimeParts({ aimedMs, expectedMs, realtime, predictionInaccurate });
  if (!time.delay) {
    return (
      <Text style={styles.time}>
        {time.expected} <Text style={styles.confidence}>{time.confidenceLabel}</Text>
      </Text>
    );
  }
  return (
    <Text style={styles.time}>
      <Text style={styles.timeAimed}>{time.aimed}</Text>{' '}
      <Text style={time.tone === 'late' ? styles.late : styles.early}>
        {time.expected} ({time.delay})
      </Text>{' '}
      <Text style={styles.confidence}>{time.confidenceLabel}</Text>
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

/** A quay reference as a suffix, e.g. " · plat. 3" — empty when the stop has none. */
function quaySuffix(leg: TransitLeg, which: 'from' | 'to'): string {
  const label = quayLabel(leg[which]);
  return label ? ` · ${label}` : '';
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
                predictionInaccurate={leg.startPredictionInaccurate}
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
              {quaySuffix(leg, 'from')}
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
                  {showStops ? '▾' : '▸'} {legStopsLabel(leg)}
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
                predictionInaccurate={leg.endPredictionInaccurate}
              />
              <Text style={styles.legDetail}>
                {leg.to.name}
                {quaySuffix(leg, 'to')}
              </Text>
            </View>
          </>
        ) : (
          <Text style={styles.legDetail}>
            {walkLegLabel(leg)}
            {quaySuffix(leg, 'to')}
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
  onStartGuidance,
  index,
}: {
  trip: TransitTrip;
  expanded: boolean;
  onToggle: () => void;
  onShowMap: () => void;
  onStartGuidance: () => void;
  index: number;
}) {
  // A collapsed card must not look clean when a leg inside it is cancelled —
  // the whole point of the summary row is deciding without expanding.
  const summary = tripSummary(trip);

  return (
    <View style={[styles.trip, expanded && styles.tripSelected]}>
      <Pressable onPress={onToggle} testID={`transit-trip-${index}`}>
        <View style={styles.tripHead}>
          <Text style={styles.tripTimes}>{summary.times}</Text>
          {summary.departure ? (
            <Text
              style={[
                styles.tripDeparture,
                summary.departure.confidence === 'uncertain' && styles.confidenceWarning,
              ]}
            >
              {summary.departure.delay
                ? `Departs ${summary.departure.expected}, planned ${summary.departure.aimed} · ${summary.departure.confidenceLabel}`
                : `${summary.departure.confidenceLabel} departure`}
            </Text>
          ) : null}
          {summary.severity ? (
            <Text
              style={[styles.tripFlag, severityStyle(summary.severity).text]}
              testID="transit-trip-alert"
            >
              ! {summary.severityLabel}
            </Text>
          ) : null}
          {summary.needsBooking ? (
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
          <Text style={styles.tripMeta}>{summary.meta} · </Text>
          <ModeIcon mode="foot" size={13} color={theme.icon} />
          <Text style={styles.tripMeta}>
            {' '}
            {summary.walk}
            {summary.co2 ? ` · ${summary.co2}` : ''}
          </Text>
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.legs}>
          <View style={styles.tripActions}>
            <Pressable
              style={styles.showMapButton}
              onPress={onShowMap}
              testID={`transit-show-map-${index}`}
            >
              <Text style={styles.showMapText}>Show on map</Text>
            </Pressable>
            <Pressable
              style={[styles.showMapButton, styles.startButton]}
              onPress={onStartGuidance}
              testID={`transit-start-${index}`}
            >
              <Text style={styles.startButtonText}>Start journey</Text>
            </Pressable>
          </View>
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
 * The decisions behind the controls live in `useTransitBoard`, shared with the
 * web board; what is left here is markup. A chosen departure/arrival opens the
 * platform's own date and clock pickers, matching the web's single
 * datetime field; the Earlier/Later paging below walks real departures.
 */
export function TransitResults({
  transit,
  onShowMap,
  onStartGuidance,
}: {
  transit: TransitPlan;
  onShowMap: (trip: TransitTrip, index: number) => void;
  onStartGuidance: (trip: TransitTrip) => void;
}) {
  const [showFilters, setShowFilters] = useState(false);
  const board = useTransitBoard(transit);
  const trips = transit.trips;

  return (
    <View style={styles.board}>
      <View style={styles.chipRow}>
        {(['now', 'depart', 'arrive'] as const).map((choice) => (
          <Pressable
            key={choice}
            style={[styles.chip, board.timing === choice && styles.chipSelected]}
            onPress={() => board.chooseTiming(choice)}
            testID={`transit-when-${choice}`}
          >
            <Text style={styles.chipText}>
              {choice === 'now' ? 'Leave now' : choice === 'depart' ? 'Depart at' : 'Arrive by'}
            </Text>
          </Pressable>
        ))}
        <Pressable
          style={[styles.chip, board.filtered && styles.chipSelected]}
          onPress={() => setShowFilters((v) => !v)}
          testID="transit-modes-toggle"
        >
          <Text style={styles.chipText}>
            Modes{board.filtered ? ` (${transit.modes.length})` : ''}
          </Text>
        </Pressable>
      </View>

      {board.timing === 'now' ? (
        <Pressable onPress={transit.refresh} testID="transit-refresh">
          <Text style={styles.link}>↻ Refresh departures</Text>
        </Pressable>
      ) : (
        <Pressable
          style={styles.timeRow}
          onPress={() => pickDateTime(transit.timeMs ?? Date.now(), transit.setTimeMs)}
          testID="transit-time-pick"
        >
          {/* Day + clock, so a time picked past midnight doesn't read as today. */}
          <Text style={styles.timeValue}>{fmtWhenClock(transit.timeMs ?? Date.now())}</Text>
          <Text style={styles.timeHint}>Change</Text>
        </Pressable>
      )}

      {showFilters ? (
        <View style={styles.chipRow}>
          {RIDE_MODES.map((mode) => (
            <Pressable
              key={mode}
              style={[styles.chip, styles.modeChip, board.accepts(mode) && styles.chipSelected]}
              onPress={() => transit.toggleMode(mode)}
              accessibilityState={{ selected: board.accepts(mode) }}
              testID={`transit-mode-${mode}`}
            >
              {/* Labelled here, unlike the travel-mode picker: a filter is a
                  list of promises about what will be excluded, and "no ferries"
                  has to be unambiguous in a way a glyph alone is not. */}
              <ModeIcon
                mode={mode}
                size={15}
                color={board.accepts(mode) ? theme.accent : theme.icon}
              />
              <Text style={styles.chipText}> {TRANSIT_MODE_LABEL[mode]}</Text>
            </Pressable>
          ))}
          <Text style={styles.muted}>Walking to and between stops is always included.</Text>
          {board.filtered ? (
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
      {board.emptyMessage ? (
        <View>
          <Text style={styles.muted}>{board.emptyMessage}</Text>
          {board.emptyFromFilter ? (
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
          {board.showEarlier ? (
            <Pressable onPress={board.showEarlier} testID="transit-earlier">
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
              onStartGuidance={() => onStartGuidance(trip)}
            />
          ))}
          {board.showLater ? (
            <Pressable onPress={board.showLater} testID="transit-later">
              <Text style={styles.link}>↓ Later</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {/* Last line of the board, always: the one part of Atlas that stops
          working off-grid should say so before it is relied on. */}
      <Text style={styles.liveNotice}>{board.liveNotice}</Text>
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
    backgroundColor: theme.surfaceMuted,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  chipSelected: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  chipText: { fontSize: 13, color: theme.text, fontWeight: '600' },
  modeChip: { flexDirection: 'row', alignItems: 'center' },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  timeHint: { fontSize: 13, color: theme.accent, fontWeight: '600' },
  timeValue: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.text,
    flexGrow: 1,
    textAlign: 'center',
  },
  muted: { fontSize: 13, color: theme.textMuted },
  liveNotice: { fontSize: 11, color: theme.textMuted },
  link: { fontSize: 13, color: theme.accent, fontWeight: '600', paddingVertical: 4 },
  error: { fontSize: 13, color: theme.danger },
  trip: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  tripSelected: { borderColor: theme.accent, backgroundColor: theme.surfaceMuted },
  showMapButton: {
    alignSelf: 'flex-start',
    borderRadius: 16,
    backgroundColor: theme.surfaceActive,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  showMapText: { fontSize: 13, fontWeight: '700', color: theme.accent },
  tripActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  startButton: { backgroundColor: theme.accent },
  startButtonText: { fontSize: 13, fontWeight: '800', color: theme.onAccent },
  tripHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tripTimes: { fontSize: 15, fontWeight: '700', color: theme.text },
  tripDeparture: { fontSize: 11, fontWeight: '600', color: theme.textMuted },
  tripLines: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
  tripMeta: { fontSize: 12, color: theme.textMuted },
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
  noticeDetail: { fontSize: 12, color: theme.text },
  noticeMore: { fontSize: 11, color: theme.textMuted },
  noticeInfo: { backgroundColor: theme.surfaceActive, borderColor: theme.border },
  noticeInfoText: { color: '#1a4d8f' },
  noticeWarn: { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
  noticeWarnText: { color: theme.warning },
  noticeSevere: { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
  noticeSevereText: { color: theme.danger },
  legs: { marginTop: 6, gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 8 },
  leg: { flexDirection: 'row', gap: 8 },
  legIcon: { alignItems: 'center', justifyContent: 'center' },
  legBody: { flexShrink: 1, flexGrow: 1, gap: 2 },
  legHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  legDetail: { fontSize: 13, color: theme.text, flexShrink: 1 },
  headsign: { fontSize: 12, color: theme.textMuted, flexShrink: 1 },
  stopName: { fontSize: 12, color: theme.textMuted, paddingLeft: 10 },
  operator: { fontSize: 11, color: theme.textMuted },
  time: { fontSize: 13, fontWeight: '700', color: theme.text },
  timeAimed: { textDecorationLine: 'line-through', color: theme.textMuted, fontWeight: '400' },
  confidence: { color: theme.textMuted, fontSize: 10, fontWeight: '500' },
  confidenceWarning: { color: theme.warning },
  late: { color: theme.danger, fontWeight: '700', fontSize: 13 },
  early: { color: '#1e7d32', fontWeight: '700', fontSize: 13 },
  lineChip: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
  },
  lineChipPlain: { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
  lineChipText: { fontSize: 12, fontWeight: '700' },
  lineChipPlainText: { color: theme.text },
});
