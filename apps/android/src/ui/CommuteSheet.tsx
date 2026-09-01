import {
  useCommuteDashboard,
  useCommuteEditor,
  type CommuteController,
  type CommuteDashboardBoard,
  type CommuteDashboardRow,
  type CommuteDashboardSection,
  type StopGeocodeFn,
  type StopLinesFn,
} from '@atlas/app-hooks';
import {
  commuteCountdown,
  commuteModeChip,
  liveTimetableLabel,
  transitModeGlyph,
  type CommuteBoardRow,
  type CommuteDisruption,
  type CommuteHere,
  type CommuteJourney,
  type CommuteLineBadge,
  type CommuteRibbonPart,
  type CommuteServiceState,
  type TransitMode,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  addCommuteWidget,
  addCommuteWidgetV2,
  commuteWidgetSupport,
  commuteWidgetV2Support,
  type CommuteWidgetSupport,
} from '../commuteWidget';
import { BottomSheet } from './BottomSheet';
import { CommuteEditorForm } from './CommuteEditor';
import { CheckIcon, PencilIcon } from './icons';
import { theme } from './theme';

/**
 * The commute dashboard on Android — ROADMAP §6.4, the same model the web panel
 * renders.
 *
 * What it replaced was a configuration form with a result list stapled under
 * it: three stop pickers, two time fields, seven day chips and a wall of line
 * chips before the first departure time. The sheet now opens on the answer —
 * what leaving now gets you, then the complete journey options as one scannable
 * line each — with the form behind "Edit commute". The middle mode reads
 * differently on purpose (§13): standing at the change you are not planning a
 * journey, so it draws the departure boards leaving that stop instead.
 *
 * Nothing here formats a time or decides a status; `@atlas/transit` does both,
 * so this sheet and the browser panel and the home-screen widget cannot
 * disagree about when the 08:41 leaves.
 */

/**
 * One glyph per mode — from `@atlas/transit`, so the widget can have them too.
 *
 * See the note in the browser panel: this table and its twin there were the
 * reason the home-screen widget, whose rows the backend renders, had no icons
 * at all.
 */
const glyph = transitModeGlyph;

/**
 * A colour comes from what a service *is* — never from where it sits in a list.
 * Same rule and same vocabulary as the home-screen widget, so a delayed
 * departure looks delayed on both surfaces of one commute.
 */
const STATE_COLOUR: Record<CommuteServiceState, string> = {
  cancelled: theme.danger,
  replacement: theme.info,
  delayed: theme.warning,
  early: theme.warning,
  live: theme.success,
  // Explicitly *not* `theme.border`, which resolves to `colorForeground` — a
  // full-opacity black or white. A 3 px edge in it would make the calmest and
  // commonest state the loudest thing on the sheet. Semi-transparent grey reads
  // as an edge in both themes without claiming attention.
  scheduled: 'rgba(128,138,148,0.45)',
};

/**
 * Disruptions under the service they affect (§4).
 *
 * `brief` is the collapsed form, and it is not a nicety. Driven against the live
 * board, the full form put two amber blocks and five lines of Norwegian
 * operator prose between the first journey's scan line and the second's — on the
 * one screen §12 says must show three journeys at a glance. So a collapsed row
 * gets the headline and the expanded legs get the whole notice, which is where
 * someone who has chosen a journey is actually reading.
 *
 * But a clamped headline is a *cut* sentence, and the cut usually falls exactly
 * where the operator was about to say which stops are affected. So a brief
 * notice opens on its own tap, independently of the journey row it sits in:
 * scannable by default, complete on demand, and never at the price of burying
 * the next departure.
 */
function Disruptions({
  items,
  brief = false,
}: {
  items: readonly CommuteDisruption[];
  brief?: boolean;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <View style={styles.disruptions}>
      {items.map((item) => {
        const tone =
          item.severity === 'severe'
            ? theme.danger
            : item.severity === 'info'
              ? theme.textMuted
              : theme.warning;
        const open = !brief || openKey === item.key;
        return (
          <Pressable
            key={item.key}
            style={[styles.disruption, { borderLeftColor: tone }]}
            disabled={!brief}
            onPress={() => setOpenKey((current) => (current === item.key ? null : item.key))}
            testID={`commute-disruption-${item.key}`}
          >
            <Text style={[styles.disruptionKind, { color: tone }]}>
              {item.severity === 'info' ? 'ⓘ' : '⚠'} {item.kindLabel.toUpperCase()}
            </Text>
            <Text style={styles.disruptionText} numberOfLines={open ? undefined : 1}>
              {item.summary}
            </Text>
            {open && item.detail ? (
              <Text style={styles.disruptionDetail}>{item.detail}</Text>
            ) : null}
            {open && item.url ? (
              <Pressable onPress={() => void Linking.openURL(item.url!)}>
                <Text style={styles.disruptionLink}>Operator’s notice</Text>
              </Pressable>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The journey as one proportional bar — every vehicle as wide as it is long,
 * in the operator's own colours, with the changes as literal gaps between them.
 *
 * What this replaced was a wrapping strip of bordered chips, one per vehicle
 * and one per change. On a phone that became two or three lines of
 * near-identical text per journey, so five journeys was ten boxes and thirty
 * clock times — and the two things a commuter reads first (which vehicles, and
 * how the time splits between them) had to be assembled out of all of it.
 *
 * Two colour channels run through this and they never trade places: the *fill*
 * is the line's identity (the 280 is Ruter red whether or not it is late) and
 * the edge is its state. The proportions come from `commuteRibbon`, so the
 * browser panel draws the identical bar.
 */
function Ribbon({
  parts,
  progress = null,
  tall = false,
}: {
  parts: readonly CommuteRibbonPart[];
  /** Where "now" sits along it, 0–100, when this is the journey being tracked. */
  progress?: number | null;
  tall?: boolean;
}) {
  if (parts.length === 0) return null;
  return (
    <View style={[styles.ribbon, tall && styles.ribbonTall]}>
      {parts.map((part) =>
        part.kind === 'ride' ? (
          <View
            key={part.key}
            style={[
              styles.seg,
              // `flexBasis: 0` is what makes the widths *proportional*: without
              // it every segment starts at its content width and flexGrow only
              // shares out what is left over, so a two-minute leg with a long
              // line code comes out as wide as a twenty-minute one.
              { flexGrow: part.weight, flexBasis: 0, backgroundColor: part.badge.fill },
              part.state === 'cancelled' && styles.segCancelled,
              part.state === 'scheduled' && styles.segScheduled,
              (part.state === 'delayed' || part.state === 'early') && styles.segLate,
              part.state === 'replacement' && styles.segReplacement,
            ]}
          >
            <Text
              style={[
                styles.segText,
                { color: part.state === 'cancelled' ? theme.danger : part.badge.text },
                part.state === 'cancelled' && styles.strike,
              ]}
              numberOfLines={1}
            >
              {glyph(part.mode)} {part.line}
            </Text>
            {/* The correction on the leg carrying it: on a bus→train commute,
                "the bus is nine late" and "the train is nine late" are different
                mornings, and one number on the row cannot tell them apart. */}
            {part.delay ? (
              <Text style={[styles.segDelay, { color: part.badge.text }]}>{part.delay}</Text>
            ) : null}
          </View>
        ) : (
          <View
            key={part.key}
            style={[
              styles.gap,
              { flexGrow: part.weight, flexBasis: 0 },
              part.tight && styles.gapTight,
              part.broken && styles.gapBroken,
            ]}
          >
            <Text
              style={[
                styles.gapText,
                part.tight && styles.gapTextTight,
                part.broken && styles.gapTextBroken,
              ]}
              numberOfLines={1}
            >
              {part.broken ? '×' : part.label}
            </Text>
          </View>
        ),
      )}
      {progress !== null ? (
        <View style={[styles.ribbonNow, { left: `${progress}%` }]} pointerEvents="none" />
      ) : null}
    </View>
  );
}

/** The line badge where it appears outside a ribbon — a leg, a board row. */
function Badge({
  badge,
  mode,
  line,
}: {
  badge: CommuteLineBadge;
  mode: TransitMode;
  line: string;
}) {
  return (
    <View style={[styles.badge, { backgroundColor: badge.fill }]}>
      <Text style={[styles.badgeText, { color: badge.text }]} numberOfLines={1}>
        {glyph(mode)} {line}
      </Text>
    </View>
  );
}

/**
 * The scan line: departure, arrival and total, all on the timetable's own
 * numbers, in one line comparable against the row above it without reading
 * either (§12).
 *
 * The live correction that used to sit under the departure has moved onto the
 * ribbon segment it is about — a journey-level `+3 min` cannot name which of
 * two vehicles is late.
 */
function ScanLine({
  journey,
  big = false,
  countdown = null,
}: {
  journey: CommuteJourney;
  big?: boolean;
  countdown?: string | null;
}) {
  return (
    <View style={styles.scan}>
      <Text style={[styles.scanTime, big && styles.scanTimeBig]}>{journey.departure.aimed}</Text>
      {countdown ? <Text style={styles.scanIn}>{countdown}</Text> : null}
      <View style={styles.scanRule} />
      <Text style={[styles.scanTime, big && styles.scanTimeBig]}>{journey.arrival.aimed}</Text>
      <Text style={styles.scanDuration}>{journey.duration}</Text>
      {journey.dayNote ? <Text style={styles.scanDay}>{journey.dayNote}</Text> : null}
    </View>
  );
}

/**
 * The same journey on live times, under the scheduled one it corrects.
 *
 * Absent whenever nothing has moved, which is most rows: this line exists to
 * answer "is the 48 minutes with the delay in it or not", and printing it on a
 * journey running to time would answer a question nobody asked while pushing
 * the next departure down the sheet.
 */
function Live({ journey }: { journey: CommuteJourney }) {
  if (!journey.live) return null;
  return (
    <View style={styles.journeyLive}>
      <Text style={styles.journeyLiveTag}>LIVE</Text>
      <Text style={styles.journeyLiveText} numberOfLines={1}>
        {journey.live.scan}
      </Text>
    </View>
  );
}

/** The change, in the two numbers the traveller would otherwise subtract (§2). */
function Changes({ row }: { row: CommuteDashboardRow }) {
  return (
    <>
      {row.journey.connections.map((change, index) => {
        const broken = row.broken?.index === index + 1;
        return (
          <View key={change.key} style={styles.changeRow}>
            <Text
              style={[
                styles.changeText,
                change.tight && styles.changeTight,
                broken && styles.changeBroken,
              ]}
              numberOfLines={1}
            >
              ⇄ {change.at}
            </Text>
            <Text
              style={[
                styles.changeTimes,
                change.tight && styles.changeTight,
                broken && styles.changeBroken,
              ]}
              numberOfLines={1}
            >
              {broken ? row.broken?.detail : `${change.arrive} → ${change.depart}`}
            </Text>
          </View>
        );
      })}
    </>
  );
}

/**
 * The vehicles of a journey, stop by stop: each leg's platform, its departure
 * and its arrival, with the live estimate under whichever of the two moved.
 *
 * Shared by the expanded journey row and the tracked card, which is the point.
 * The tracked card used to be the one place on this sheet that could *not* say
 * which platform to stand on — the journey it is about has left the list the
 * legs would otherwise have been read from.
 */
function Legs({
  journey,
  /**
   * The ride the traveller is on or about to board, from the phase ladder.
   * Legs before it are dimmed rather than dropped: a journey is read as a
   * shape, and removing its first half moves everything that is left.
   */
  activeIndex = null,
}: {
  journey: CommuteJourney;
  activeIndex?: number | null;
}) {
  return (
    <View style={styles.legs}>
      {journey.rides.map((ride, index) => {
        const connection = journey.connections[index - 1];
        return (
          <View
            key={ride.key}
            style={[
              activeIndex !== null && index === activeIndex && styles.legNow,
              activeIndex !== null && index < activeIndex && styles.legPast,
            ]}
          >
            {connection ? (
              <Text style={[styles.connection, connection.tight && styles.connectionTight]}>
                {connection.summary}
              </Text>
            ) : null}
            <View style={styles.leg}>
              <View style={styles.legTime}>
                <Text style={styles.legTimeText}>{ride.departure.aimed}</Text>
                {ride.departure.delay ? (
                  <Text style={styles.legEstimate}>{ride.departure.expected} est.</Text>
                ) : null}
              </View>
              <View style={styles.legBody}>
                <View style={styles.legLineRow}>
                  <Badge badge={ride.badge} mode={ride.mode} line={ride.line} />
                  {ride.towards ? (
                    <Text style={styles.legLine} numberOfLines={1}>
                      → {ride.towards}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.legPlace}>
                  {[ride.from, ride.fromQuay].filter(Boolean).join(' · ')}
                </Text>
                <Text style={styles.legRide}>{ride.ride}</Text>
              </View>
            </View>
            <View style={styles.leg}>
              <View style={styles.legTime}>
                <Text style={styles.legTimeText}>{ride.arrival.aimed}</Text>
                {ride.arrival.delay ? (
                  <Text style={styles.legEstimate}>{ride.arrival.expected} est.</Text>
                ) : null}
              </View>
              <View style={styles.legBody}>
                <Text style={styles.legPlace}>
                  {[ride.to, ride.toQuay].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </View>
            <Disruptions items={ride.disruptions} />
          </View>
        );
      })}
      <Text style={styles.legsTotal}>
        Total {journey.duration}
        {journey.walk ? ` · ${journey.walk}` : ''}
      </Text>
    </View>
  );
}

/**
 * One journey, collapsed to its scan line and ribbon, expandable to its legs.
 *
 * Tracking lives inside the expansion rather than on the collapsed row: a
 * button per row was four more bordered boxes on a list whose whole job is to
 * be scanned, and the journey people track is almost always the one stated in
 * full above the list, which has its own control.
 */
function JourneyRow({
  row,
  open,
  onToggle,
  onTrack,
}: {
  row: CommuteDashboardRow;
  open: boolean;
  onToggle: () => void;
  onTrack: () => void;
}) {
  const { journey } = row;
  // No state edge on the card: the ribbon paints state per vehicle, which is
  // strictly more than a row-level tint could say. `cancelled` keeps one,
  // because it is the state that invalidates the whole row.
  return (
    <View
      style={[
        styles.journey,
        journey.state === 'cancelled' && styles.journeyCancelled,
        row.tracked && styles.journeyTracked,
      ]}
    >
      <Pressable onPress={onToggle} testID={`commute-journey-${row.key}`}>
        <ScanLine journey={journey} />
        <Live journey={journey} />
        <Ribbon parts={row.parts} />
      </Pressable>
      <Changes row={row} />
      {!open ? <Disruptions items={row.disruptions} brief /> : null}
      {open ? (
        <>
          <Legs journey={journey} />
          <Pressable style={styles.track} onPress={onTrack} testID="commute-track-row">
            <Text style={styles.trackText}>
              {row.tracked ? 'Stop tracking' : 'Track this journey'}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

/**
 * §6.4 §7 — where you are in the journey you are tracking.
 *
 * Every part of this already existed and none of it reached this screen: the
 * phase ladder, the connection break and the commitment all shipped for the
 * home-screen widget, so the widget knew which leg you were on and the board —
 * the surface you actually open once you are moving — did not.
 */
function HereCard({
  here,
  journey,
  onStop,
}: {
  here: CommuteHere;
  /** The tracked journey whole, for the leg detail below the connection block. */
  journey: CommuteJourney | null;
  onStop: () => void;
}) {
  return (
    <View style={[styles.card, styles.cardAccent]} testID="commute-here">
      <View style={styles.eyebrowRow}>
        <Text style={styles.eyebrow}>{here.heading.toUpperCase()}</Text>
        <Text style={styles.phaseChip}>{here.phaseLabel.toUpperCase()}</Text>
      </View>
      <Ribbon parts={here.parts} progress={here.progress} tall />
      {/* Under the ribbon and directly above the connection block, because the
          two are one instruction: which vehicle to be on, and what it puts you
          on next. Above the ribbon it was separated from the change it leads to
          by the whole width of the journey. */}
      <View style={styles.hereLead}>
        <Badge badge={here.ride.badge} mode={here.ride.mode} line={here.ride.line} />
        <Text style={styles.hereLeadText} numberOfLines={2}>
          {here.lead}
        </Text>
        <Text style={styles.hereLeadEstimate}>{here.leadEstimate}</Text>
      </View>
      {here.connections.length > 0 ? (
        <>
          <Text style={[styles.eyebrow, styles.eyebrowNext]}>NEXT CONNECTION</Text>
          {here.connections.map((connection) => (
            <View key={connection.key} style={styles.conn}>
              <Text style={[styles.connTime, connection.missed && styles.connMissed]}>
                {connection.aimed}
              </Text>
              <Badge badge={connection.badge} mode={connection.mode} line={connection.line} />
              <Text
                style={[styles.connTowards, connection.missed && styles.connMissed]}
                numberOfLines={1}
              >
                {connection.towards ?? ''}
              </Text>
              <Text style={[styles.connNote, connection.missed && styles.connNoteMissed]}>
                {connection.note}
              </Text>
            </View>
          ))}
        </>
      ) : null}
      {/* The detail the ribbon compresses: which platform, and the two clock
          times per leg. Below the connection block on purpose — that block is
          the decision, this is the reference you check once you have made it. */}
      {journey ? <Legs journey={journey} activeIndex={here.rideIndex} /> : null}
      <Pressable style={styles.track} onPress={onStop} testID="commute-stop-tracking">
        <Text style={styles.trackText}>Stop tracking</Text>
      </Pressable>
    </View>
  );
}

/**
 * §11 — the journey you would catch by walking out of the door now.
 *
 * One journey, not two. The "Following 08:48 →" line that used to close this
 * card was the first row of the list directly beneath it, said again in a
 * weaker form; the list starts there now (`laterJourneys`), so the card states
 * one answer completely and the comparison happens where comparisons are
 * scannable.
 */
function LeaveNow({
  row,
  label,
  nowMs,
  primary,
  showTrack,
  onTrack,
}: {
  row: CommuteDashboardRow;
  /**
   * `"If I leave now"` — or `"Next from here"` at the interchange, where you
   * are not leaving the house but already standing on the platform.
   */
  label: string;
  nowMs: number;
  /** Nothing is being tracked, so this card is the board's answer. */
  primary: boolean;
  /**
   * False once the card above is already tracking this same journey — two
   * "Stop tracking" buttons for one commitment is two controls for one state.
   */
  showTrack: boolean;
  onTrack: () => void;
}) {
  return (
    <View style={[styles.card, primary && styles.cardAccent]} testID="commute-leave-now">
      <Text style={styles.eyebrow}>{label.toUpperCase()}</Text>
      {/* Counted to the *expected* departure, not the timetabled one: a bus
          four minutes late is four minutes more to walk to the stop, and that
          is the number a person deciding whether to run is asking for. */}
      <ScanLine
        journey={row.journey}
        big
        countdown={commuteCountdown(row.journey.trip.startMs, nowMs)}
      />
      <Live journey={row.journey} />
      <Ribbon parts={row.parts} tall />
      <Changes row={row} />
      {/* In full, not clamped: this is the journey the reader is being told to
          leave for, and "Buss for tog Asker–…" is the half of the sentence that
          decides whether they should. */}
      <Disruptions items={row.disruptions} />
      {showTrack ? (
        <Pressable
          style={[styles.track, styles.trackWide]}
          onPress={onTrack}
          testID="commute-track"
        >
          <Text style={styles.trackText}>
            {row.tracked ? 'Stop tracking' : 'Track this journey'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One row of a departure board: scheduled time first, estimate labelled beneath. */
function BoardRow({ row }: { row: CommuteBoardRow }) {
  return (
    <View style={[styles.boardRow, { borderLeftColor: STATE_COLOUR[row.state] }]}>
      <View style={styles.boardRowMain}>
        <View style={styles.boardTime}>
          <Text style={[styles.boardTimeText, row.state === 'cancelled' && styles.strike]}>
            {row.aimed}
          </Text>
          <Text style={styles.boardEstimate}>{row.estimate}</Text>
        </View>
        <View style={styles.boardLine}>
          <View style={styles.legLineRow}>
            <Badge badge={row.badge} mode={row.mode} line={row.line} />
          </View>
          <Text style={styles.boardArrival}>arrives {row.arrival}</Text>
        </View>
        <View style={styles.boardWhen}>
          <Text style={styles.boardWhenText}>{row.countdown}</Text>
          {row.quay ? <Text style={styles.boardWhenSub}>plat. {row.quay}</Text> : null}
          {row.dayNote ? <Text style={styles.boardWhenSub}>{row.dayNote}</Text> : null}
        </View>
      </View>
      {/* A board row has nothing to expand into, so it carries the headline —
          enough to know something is up, not enough to bury the next row. */}
      <Disruptions items={row.disruptions} brief />
    </View>
  );
}

function Board({
  board,
  divided = false,
}: {
  board: CommuteDashboardBoard;
  /** A board under another one: the rule that separates them is this one's. */
  divided?: boolean;
}) {
  return (
    <View style={[styles.board, divided && styles.boardDivided]}>
      <Text style={styles.boardHead} numberOfLines={2}>
        {board.segment.from.name.toUpperCase()} ↓ {board.segment.to.name.toUpperCase()}
      </Text>
      {board.rows.length === 0 ? (
        <Text style={styles.state}>{board.note}</Text>
      ) : (
        board.rows.map((row) => <BoardRow row={row} key={row.key} />)
      )}
    </View>
  );
}

/**
 * The way onto the home screen, from inside the app — for **both** widgets.
 *
 * "Add it from your launcher's widget picker" was the whole of this before,
 * which is an instruction to go and do something somewhere else. Android takes a
 * pin request directly (8.0+), so ask — but only when the launcher actually
 * accepts one: a button that silently does nothing is worse than a sentence.
 *
 * Two offers, because two widgets ship (ROADMAP §6.5) and they answer different
 * questions:
 *
 *  - **Atlas commute (v1)** — one board, pinned. The right widget when what you
 *    want on the home screen is a timetable.
 *  - **Atlas commute (live) (v2)** — the whole commute on one instance, both
 *    directions behind a selector, following the leg you are on.
 *
 * v2 leads because it is what the section was written for, and v1 stays offered
 * rather than hidden: it is the fallback and the reference until v2 has survived
 * real commuting (§7), and hiding a fallback is how you find out too late that
 * it was the one people wanted.
 */
/**
 * The journey list, whole: its shared notices, its headline, its rows and the
 * reason there is none — §6.4 §13.
 *
 * A component rather than a run of views on the sheet because it is one
 * question's answer: everything in it describes the same direction, door to
 * door, and the mode that asks about a *stop* draws boards instead of a
 * hollowed-out one of these.
 */
function Journeys({
  section,
  nowMs,
  tracking,
  expanded,
  onToggle,
  onClearLines,
}: {
  section: CommuteDashboardSection;
  nowMs: number;
  /** Something is being tracked, so this list is not the sheet's only answer. */
  tracking: boolean;
  expanded: string | null;
  onToggle: (key: string) => void;
  onClearLines: () => void;
}) {
  const lead = section.leadRow;
  return (
    <View testID={`commute-list-${section.key}`}>
      {/* One notice on every journey in the list is the corridor's, not any
          journey's — said once, above them, rather than five times inside
          them. */}
      <Disruptions items={section.sharedDisruptions} />
      {lead ? (
        <LeaveNow
          row={lead}
          label={section.leadLabel}
          nowMs={nowMs}
          primary={!tracking}
          showTrack={!lead.tracked || !tracking}
          onTrack={() => section.track(lead.tracked ? null : lead.journey)}
        />
      ) : null}
      {section.emptyNote ? (
        <View>
          <Text style={styles.state}>{section.emptyNote}</Text>
          {section.emptyFromFilter ? (
            <Pressable style={styles.escape} onPress={onClearLines}>
              <Text style={styles.escapeText}>Allow any line</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {/* Not `journeys`: the one above is already answered in full, and a list
          that repeats it as its own first row costs the reader the departure
          they were actually looking for. */}
      {section.rows.length > 0 ? (
        <>
          <Text style={styles.sectionHead}>NEXT JOURNEYS</Text>
          {section.rows.map((row) => (
            <JourneyRow
              row={row}
              key={row.key}
              open={expanded === row.key}
              onToggle={() => onToggle(row.key)}
              onTrack={() => section.track(row.tracked ? null : row.journey)}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

function WidgetOffer() {
  const [support, setSupport] = useState<CommuteWidgetSupport | null>(null);
  const [supportV2, setSupportV2] = useState<CommuteWidgetSupport | null>(null);
  useEffect(() => {
    let alive = true;
    void commuteWidgetSupport().then((next) => {
      if (alive) setSupport(next);
    });
    void commuteWidgetV2Support().then((next) => {
      if (alive) setSupportV2(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!support) return null;
  // An APK built before v2 answers `pinnable: false, count: 0` for it — the
  // module simply has no `supportV2` — which is exactly the state that should
  // hide the offer rather than show a button that cannot work.
  const v2 = supportV2 ?? { pinnable: false, count: 0 };
  return (
    <View style={styles.widget}>
      <Text style={styles.widgetNote}>
        {v2.count > 0
          ? 'Your commute is on the home screen. Tap a journey on the widget to say which one you are taking — it then follows you through the change and tells you what to do next.'
          : 'This saved board can sit on your home screen: both directions on one widget, following the leg you are on.'}
      </Text>
      {v2.pinnable ? (
        <Pressable
          style={styles.widgetAdd}
          onPress={() => void addCommuteWidgetV2()}
          testID="commute-add-widget-v2"
        >
          <Text style={styles.widgetAddText}>
            {v2.count > 0 ? 'Add another live widget' : 'Add to home screen'}
          </Text>
        </Pressable>
      ) : null}
      <Text style={styles.widgetNote}>
        {support.count > 0
          ? 'The simpler “Atlas commute” widget is also placed. It shows one board — a direction, or a single leg — chosen from its own tuning icon.'
          : 'Prefer a plain timetable? “Atlas commute” shows one board — a direction, or a single leg — and nothing else.'}
      </Text>
      {support.pinnable ? (
        <Pressable
          style={styles.widgetAddQuiet}
          onPress={() => void addCommuteWidget()}
          testID="commute-add-widget"
        >
          <Text style={styles.widgetAddQuietText}>
            {support.count > 0 ? 'Add another simple widget' : 'Add the simple widget'}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.widgetNote}>
          Add “Atlas commute” from your launcher’s widget picker.
        </Text>
      )}
    </View>
  );
}

export function CommuteSheet({
  visible,
  commute,
  places,
  geocode,
  fetchStopLines,
  onClose,
  bottomInset,
}: {
  visible: boolean;
  commute: CommuteController;
  places: readonly PlaceRecord[];
  geocode: StopGeocodeFn;
  fetchStopLines: StopLinesFn;
  onClose: () => void;
  bottomInset: number;
}) {
  const editor = useCommuteEditor({ commute, places, geocode, fetchStopLines });
  const dashboard = useCommuteDashboard(commute);
  const [editing, setEditing] = useState(false);
  // §6.3: the editor opens by itself only when the board *cannot* ask a
  // question — not on every launch, which is a moment every launch spends
  // looking unconfigured while storage answers.
  useEffect(() => {
    if (commute.ready && !commute.query) setEditing(true);
  }, [commute.ready, commute.query]);

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      initialSnap="full"
      bottomInset={bottomInset}
      testID="commute-sheet"
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {dashboard.routeLabel}
          </Text>
          <Text style={styles.subtitle}>{dashboard.nowLabel}</Text>
        </View>
        <Pressable style={styles.close} onPress={onClose} testID="commute-close">
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
      >
        {!commute.ready ? <Text style={styles.state}>Loading saved commute…</Text> : null}
        {/* §6.4 §13's three modes, and the only control over what is shown.
            Out, back, and the middle ground — the third is not a direction at
            all but the change, drawn as the departures leaving it in both
            directions. A Journeys/Departures switch under this made nine
            states out of three; six of them answered nothing anyone asked. */}
        <View style={styles.toolbar}>
          <View style={styles.modes}>
            {dashboard.modes.map((item) => {
              const selected = item === dashboard.mode;
              return (
                <Pressable
                  key={item}
                  style={[styles.modeButton, selected && styles.modeButtonOn]}
                  onPress={() => dashboard.setMode(item)}
                  testID={`commute-mode-${item}`}
                >
                  <Text style={[styles.modeText, selected && styles.modeTextOn]} numberOfLines={1}>
                    {commuteModeChip(item)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {/* The commute is edited once and read every weekday, so the way in
              is a glyph beside the tabs rather than a labelled button wide
              enough to crowd them. */}
          <Pressable
            style={[styles.editButton, editing && styles.editButtonOn]}
            onPress={() => setEditing((open) => !open)}
            testID="commute-edit"
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Done editing commute' : 'Edit commute'}
          >
            {editing ? <CheckIcon color={theme.accent} /> : <PencilIcon />}
          </Pressable>
        </View>
        {/* …and the offer to have one at all. A commute is saved door to door,
            so a corridor that changes at Asker on every single journey had no
            interchange saved and no middle ground — and no way to find out a
            Via stop was what both were waiting on. */}
        {editor.suggestedVia ? (
          <View style={styles.suggest}>
            <Text style={styles.suggestText}>
              Every journey changes at{' '}
              <Text style={styles.suggestStop}>{editor.suggestedVia.name}</Text>.
            </Text>
            <Pressable
              style={styles.suggestButton}
              onPress={editor.addSuggestedVia}
              disabled={editor.addingVia}
              testID="commute-add-via"
            >
              <Text style={styles.suggestButtonText}>
                {editor.addingVia ? 'Adding…' : 'Add as interchange'}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {editor.suggestedViaError ? (
          <Text style={[styles.state, styles.error]}>{editor.suggestedViaError}</Text>
        ) : null}
        {editing ? <CommuteEditorForm editor={editor} places={places} /> : null}
        {dashboard.offDayNote ? <Text style={styles.state}>{dashboard.offDayNote}</Text> : null}
        {commute.loading ? <Text style={styles.state}>Checking upcoming journeys…</Text> : null}
        {commute.error ? <Text style={[styles.state, styles.error]}>{commute.error}</Text> : null}
        {/* Above the list rather than inside it: a commitment outlives the list
            its journey came from — a mode switch included — and the card is
            what the traveller stops it on. */}
        {dashboard.here ? (
          <HereCard
            here={dashboard.here}
            journey={dashboard.hereJourney}
            onStop={dashboard.stopTracking}
          />
        ) : null}
        {/* One mode, one kind of content: a door mode has the journey list and
            no boards, the interchange has the two boards leaving it and no
            list. Both are drawn rather than switched on here, because which
            mode answers with what is the model's fact, not the sheet's. */}
        {dashboard.section ? (
          <Journeys
            section={dashboard.section}
            nowMs={dashboard.nowMs}
            tracking={Boolean(dashboard.here)}
            expanded={dashboard.expanded}
            onToggle={dashboard.toggle}
            onClearLines={editor.clearLines}
          />
        ) : null}
        {dashboard.boards.map((board, index) => (
          <Board board={board} divided={index > 0} key={board.segment.id} />
        ))}
        <View style={styles.live}>
          <Text style={styles.liveText}>Entur · {liveTimetableLabel(commute.updatedMs)}</Text>
          <Pressable
            style={styles.refresh}
            onPress={commute.refresh}
            disabled={commute.loading || !editor.askable}
          >
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </View>
        <WidgetOffer />
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10 },
  headerText: { flex: 1 },
  title: { color: theme.text, fontSize: 17, fontWeight: '800' },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  close: { padding: 8 },
  closeText: { color: theme.textMuted, fontSize: 18 },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 16, paddingBottom: 24 },

  toolbar: { flexDirection: 'row', alignItems: 'stretch', gap: 6, marginBottom: 10 },
  modes: { flex: 1, flexDirection: 'row', gap: 6 },
  modeButton: {
    // `flexBasis: 0` with `flexGrow`, never bare `flex: 1`: on React Native the
    // longest label would otherwise set its own tab's basis, and "Interchange"
    // would push "Return" off a 360 px sheet.
    flexGrow: 1,
    flexBasis: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    paddingHorizontal: 2,
    borderRadius: 9,
    backgroundColor: theme.surfaceMuted,
  },
  modeButtonOn: { backgroundColor: theme.accentFaint },
  modeText: { color: theme.textMuted, fontSize: 12, fontWeight: '700' },
  modeTextOn: { color: theme.accent },
  editButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 40,
    borderRadius: 9,
    backgroundColor: theme.surfaceMuted,
  },
  editButtonOn: { backgroundColor: theme.accentFaint },

  // The offer to save the interchange the journeys already agree on. Sits where
  // the "from" chips would be, because it is the offer to have them.
  suggest: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    marginBottom: 10,
    borderRadius: 9,
    backgroundColor: theme.surfaceMuted,
  },
  suggestText: { flexGrow: 1, flexBasis: 0, color: theme.textMuted, fontSize: 12, lineHeight: 17 },
  suggestStop: { color: theme.text, fontWeight: '700' },
  suggestButton: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: theme.accentFaint,
  },
  suggestButtonText: { color: theme.accent, fontSize: 12, fontWeight: '800' },

  sectionHead: {
    color: theme.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 14,
    marginBottom: 6,
  },

  // --- The ribbon: one journey drawn as a shape (§1, §2) ---

  ribbon: { position: 'relative', flexDirection: 'row', gap: 3, height: 19, marginTop: 7 },
  ribbonTall: { height: 25 },
  seg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    minWidth: 0,
    paddingHorizontal: 6,
    borderRadius: 5,
    overflow: 'hidden',
  },
  segText: { fontSize: 11, fontWeight: '800', flexShrink: 1 },
  segDelay: { marginLeft: 'auto', fontSize: 10, fontWeight: '700' },
  // State paints the edge, never the fill: the fill is the operator's own
  // colour, and a reader who learned "red means trouble" here would misread
  // every Ruter bus in Oslo.
  segLate: { borderBottomWidth: 3, borderBottomColor: theme.warning },
  segReplacement: { borderBottomWidth: 3, borderBottomColor: theme.info },
  // A service with no live feed at all is a weaker promise and reads as one.
  segScheduled: { opacity: 0.72 },
  // Identity yields for the one state that means "you cannot board this".
  segCancelled: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.danger },
  strike: { textDecorationLine: 'line-through' },
  // A change is drawn as the space it is. Dashed rather than hatched because
  // the browser panel draws the same gap and React Native has no gradients.
  gap: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 17,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(128,138,148,0.55)',
    borderRadius: 4,
  },
  gapTight: { borderStyle: 'solid', borderColor: theme.warning },
  gapBroken: { borderStyle: 'solid', borderColor: theme.danger },
  gapText: { color: theme.textMuted, fontSize: 9, fontWeight: '700', opacity: 0.7 },
  gapTextTight: { color: theme.warning, opacity: 1 },
  gapTextBroken: { color: theme.danger, fontSize: 12, fontWeight: '800', opacity: 1 },
  // Where "now" is on the journey being tracked. One mark, and no dimming of
  // what is behind it: a washed-out segment reads as a cancelled one, which is
  // a word this board already spends on something else.
  ribbonNow: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    width: 3,
    marginLeft: -1.5,
    borderRadius: 2,
    backgroundColor: theme.accent,
  },

  // The line badge where it appears outside a ribbon — a leg, a board row.
  badge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, flexShrink: 1 },
  badgeText: { fontSize: 11, fontWeight: '800' },

  // --- The scan line (§12) ---

  scan: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  scanTime: { color: theme.text, fontSize: 17, fontWeight: '800' },
  scanTimeBig: { fontSize: 24 },
  scanRule: {
    flex: 1,
    minWidth: 14,
    height: 1,
    backgroundColor: theme.border,
    opacity: 0.3,
  },
  scanDuration: { color: theme.textMuted, fontSize: 12, fontWeight: '800', opacity: 0.75 },
  // The same journey on live times, under the scheduled line it corrects: muted
  // and small, because §3's estimate supplements the timetable rather than
  // competing with it.
  journeyLive: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  journeyLiveTag: {
    paddingHorizontal: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.textMuted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
  },
  journeyLiveText: { flexShrink: 1, color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  scanDay: { color: theme.textMuted, fontSize: 10, opacity: 0.75 },
  // Counted to the expected departure — the number someone deciding whether to
  // run is actually asking for.
  scanIn: {
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: theme.accent,
    color: theme.onAccent,
    fontSize: 11,
    fontWeight: '800',
    overflow: 'hidden',
  },

  // The change, in the two numbers the traveller would otherwise subtract (§2).
  changeRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 7 },
  changeText: { flexShrink: 1, color: theme.textMuted, fontSize: 11, opacity: 0.8 },
  changeTimes: { marginLeft: 'auto', color: theme.text, fontSize: 11, fontWeight: '700' },
  changeTight: { color: theme.warning, opacity: 1 },
  changeBroken: { color: theme.danger, fontWeight: '700', opacity: 1 },

  // --- The two cards: "you are here" (§7) and "if I leave now" (§11) ---

  card: {
    padding: 11,
    marginBottom: 10,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(128,138,148,0.4)',
    backgroundColor: theme.surfaceMuted,
  },
  // The accent marks the board's *answer*, so it follows the tracked journey
  // when there is one and falls back to "if I leave now" when there is not.
  // Two accented cards would be two answers.
  cardAccent: { borderColor: theme.accent, backgroundColor: theme.accentFaint },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  eyebrow: {
    color: theme.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    opacity: 0.8,
  },
  eyebrowNext: { marginTop: 11, marginBottom: 4 },
  phaseChip: {
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: theme.accent,
    color: theme.onAccent,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
    overflow: 'hidden',
  },
  hereLead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  hereLeadText: { flexShrink: 1, color: theme.text, fontSize: 13, fontWeight: '600' },
  // The live line for the time the lead quotes — "08:39 est.", or "On time"
  // when a feed says so. Pushed to the far edge so the two read as a pair.
  hereLeadEstimate: {
    marginLeft: 'auto',
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  conn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  connTime: { color: theme.text, fontSize: 12, fontWeight: '800' },
  connTowards: { flexShrink: 1, color: theme.textMuted, fontSize: 12, opacity: 0.8 },
  connNote: { marginLeft: 'auto', color: theme.textMuted, fontSize: 11, opacity: 0.8 },
  // The booked connection stays on the list once the numbers have broken it,
  // struck through rather than dropped: someone standing at the change is
  // looking for the train they planned to take.
  connMissed: { color: theme.danger, textDecorationLine: 'line-through' },
  connNoteMissed: { color: theme.danger, opacity: 1 },

  track: {
    alignSelf: 'flex-start',
    marginTop: 9,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.accent,
  },
  trackWide: { alignSelf: 'stretch', alignItems: 'center' },
  trackText: { color: theme.accent, fontSize: 12, fontWeight: '700' },

  journey: {
    marginBottom: 7,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(128,138,148,0.4)',
    backgroundColor: theme.surfaceMuted,
  },
  journeyTracked: { borderColor: theme.accent },
  journeyCancelled: { borderColor: theme.danger },
  legLineRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },

  legs: { marginTop: 9, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.border },
  leg: { flexDirection: 'row', gap: 9, paddingTop: 6 },
  legTime: { minWidth: 46 },
  legTimeText: { color: theme.text, fontSize: 13, fontWeight: '700' },
  legEstimate: { color: theme.textMuted, fontSize: 10 },
  legBody: { flex: 1 },
  legLine: { color: theme.text, fontSize: 12, fontWeight: '700' },
  legPlace: { color: theme.textMuted, fontSize: 11 },
  legRide: { color: theme.textMuted, fontSize: 10 },
  // The tracked card's two marks. Position and weight only — every colour
  // channel on this board is already spent saying what a service *is*, and a
  // leg that is merely the current one is not a service state.
  legNow: { marginLeft: -11, paddingLeft: 8, borderLeftWidth: 3, borderLeftColor: theme.accent },
  legPast: { opacity: 0.5 },
  connection: {
    marginTop: 8,
    marginLeft: 55,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 5,
    backgroundColor: theme.surface,
    color: theme.textMuted,
    fontSize: 11,
  },
  connectionTight: { color: theme.warning, fontWeight: '700' },
  legsTotal: {
    marginTop: 9,
    paddingTop: 7,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },

  board: { marginBottom: 6 },
  // Two boards on one screen (§13): the train in over the bus home, told apart
  // by their own from ↓ to headings, with a rule doing the separating that a
  // blank line cannot at this density.
  boardDivided: { marginTop: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.border },
  boardHead: {
    color: theme.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginTop: 14,
    marginBottom: 6,
  },
  boardRow: {
    marginBottom: 4,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 8,
    borderLeftWidth: 3,
    backgroundColor: theme.surfaceMuted,
  },
  boardRowMain: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  boardTime: { minWidth: 50 },
  boardTimeText: { color: theme.text, fontSize: 16, fontWeight: '800' },
  boardEstimate: { color: theme.textMuted, fontSize: 10 },
  boardLine: { flex: 1 },
  boardLineText: { color: theme.text, fontSize: 12, fontWeight: '700' },
  boardArrival: { color: theme.textMuted, fontSize: 10 },
  boardWhen: { alignItems: 'flex-end' },
  boardWhenText: { color: theme.textMuted, fontSize: 11 },
  boardWhenSub: { color: theme.textMuted, fontSize: 10 },

  disruptions: { marginTop: 7, gap: 4 },
  disruption: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderLeftWidth: 2,
    borderRadius: 4,
    backgroundColor: theme.surface,
  },
  disruptionKind: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  disruptionText: { color: theme.text, fontSize: 11, lineHeight: 15, marginTop: 1 },
  disruptionDetail: { color: theme.textMuted, fontSize: 11, lineHeight: 15, marginTop: 1 },
  disruptionLink: { color: theme.accent, fontSize: 11, fontWeight: '700', marginTop: 3 },

  state: {
    color: theme.textMuted,
    fontSize: 12,
    lineHeight: 17,
    backgroundColor: theme.surfaceMuted,
    borderRadius: 9,
    padding: 11,
    marginTop: 9,
  },
  error: { color: theme.danger },
  escape: {
    alignSelf: 'flex-start',
    marginTop: 7,
    backgroundColor: theme.accentFaint,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  escapeText: { color: theme.accent, fontSize: 12, fontWeight: '700' },

  live: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 14 },
  liveText: { flex: 1, color: theme.textMuted, fontSize: 10, lineHeight: 14 },
  refresh: {
    backgroundColor: theme.surfaceMuted,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  refreshText: { color: theme.text, fontSize: 11, fontWeight: '700' },
  widget: { marginTop: 16, gap: 9 },
  widgetNote: { color: theme.textMuted, fontSize: 11, lineHeight: 16 },
  widgetAdd: {
    alignSelf: 'flex-start',
    backgroundColor: theme.accentFaint,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  widgetAddText: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  // The v1 offer, deliberately quieter than v2's: both are real choices, and
  // only one of them is the one this screen is recommending.
  widgetAddQuiet: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  widgetAddQuietText: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
});
