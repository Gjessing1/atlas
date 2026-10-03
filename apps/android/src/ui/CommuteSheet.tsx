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
  transitModeGlyph,
  type CommuteBoardRow,
  type CommuteConnection,
  type CommuteDisruption,
  type CommuteHere,
  type CommuteJourney,
  type CommuteLineBadge,
  type CommuteRibbonPart,
  type CommuteRide,
  type CommuteServiceState,
  type TransitMode,
  type TransitTrip,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  addCommuteWidgetV2,
  addStopDepartureWidget,
  commuteWidgetV2Support,
  type CommuteWidgetSupport,
} from '../commuteWidget';
import { BottomSheet } from './BottomSheet';
import { CommuteEditorForm } from './CommuteEditor';
import { CheckIcon } from './icons';
import { MoreIcon } from './modeIcons';
import { theme } from './theme';

/**
 * The commute dashboard on Android — docs/TRANSIT.md, the same model the web panel
 * renders.
 *
 * What it replaced was a configuration form with a result list stapled under
 * it: three stop pickers, two time fields, seven day chips and a wall of line
 * chips before the first departure time. The sheet now opens on the answer —
 * what leaving now gets you, then the complete journey options as one scannable
 * card each — with the form, and everything else that configures rather than
 * reads the board, behind the header's ⋮. The middle mode reads
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
 * Disruptions under the service they affect (§4) — one line each until tapped.
 *
 * Every notice starts as its operator headline on a single line, wherever it
 * appears: on a collapsed card, above the list, on a leg of the itinerary. The
 * full form put two amber blocks and five lines of Norwegian operator prose
 * between the first journey's scan line and the second's, on the one screen
 * §12 says must show three journeys at a glance; the headline says enough to
 * know something is up, and a tap on it opens the whole notice in place.
 *
 * Two weights, from `prominence`: what is happening to *this* departure (it is
 * cancelled, a bus replaces it, an incident on it) is drawn in the state
 * colours; engineering work announced last month and information notices are
 * drawn muted, so they are there to be read without competing with the time.
 */
function Disruptions({ items }: { items: readonly CommuteDisruption[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <View style={styles.disruptions}>
      {items.map((item) => {
        const active = item.prominence === 'active';
        const tone = !active
          ? theme.textMuted
          : item.severity === 'severe' || item.kind === 'cancellation'
            ? theme.danger
            : theme.warning;
        const open = openKey === item.key;
        return (
          <Pressable
            key={item.key}
            style={[styles.disruption, active ? { borderLeftColor: tone } : styles.disruptionQuiet]}
            onPress={() => setOpenKey((current) => (current === item.key ? null : item.key))}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${item.kindLabel}: ${item.summary}`}
            testID={`commute-disruption-${item.key}`}
          >
            {open ? (
              <Text style={[styles.disruptionKind, { color: tone }]}>
                {item.kindLabel.toUpperCase()}
              </Text>
            ) : null}
            <Text
              style={[styles.disruptionText, !active && styles.disruptionTextQuiet]}
              numberOfLines={open ? undefined : 1}
            >
              <Text style={{ color: tone }}>{active ? '⚠' : 'ⓘ'} </Text>
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

/**
 * The change on a collapsed card: where, and how long — the two things the
 * ribbon's gap cannot spell out — plus the warning when there is one (§2).
 *
 * Not the arrival and departure times: those belong to the legs, and the
 * itinerary states them against their platforms. A collapsed card that also
 * printed them was the near-copy of the itinerary a reader scrolled past twice.
 * The live wait sits after the planned one it corrects (§3), so a nine-minute
 * change a late bus has cut to two reads `9 min · ⚠ 2 min est.`.
 */
function Overview({ row }: { row: CommuteDashboardRow }) {
  return (
    <>
      {row.journey.connections.map((change, index) => {
        const broken = row.broken?.index === index + 1;
        const tone = broken ? styles.changeBroken : change.warn ? styles.changeTight : null;
        return (
          <View key={change.key} style={styles.changeRow} testID={`commute-change-brief-${index}`}>
            <Text style={[styles.changeText, tone]} numberOfLines={1}>
              ⇄ {change.at}
            </Text>
            <Text style={[styles.changeTimes, tone]} numberOfLines={1}>
              {broken
                ? `⚠ ${row.broken?.detail}`
                : [
                    `${change.warn && !change.liveLabel ? '⚠ ' : ''}${change.label}`,
                    change.liveLabel ? `${change.warn ? '⚠ ' : ''}${change.liveLabel}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </Text>
          </View>
        );
      })}
    </>
  );
}

/**
 * What the itinerary's rail is drawn as between two of its nodes: a ride in its
 * line's colour, solid, or a dotted stretch on foot — the change between two
 * vehicles (warning-toned when §17 flags it), or a walk at either end.
 *
 * Solid from a leg's departure to its arrival is the whole point of the rail:
 * `08:22 ● Engelsrud` and `08:33 ● Asker stasjon` read as one leg because one
 * line in the 280's colour joins them, and the dotted stretch after it reads
 * as the gap to the next.
 */
type Rail =
  { kind: 'ride'; fill: string; now: boolean } | { kind: 'foot'; tone: 'tight' | 'broken' | null };

/** Row padding above the first text line; a node sits half a line below it. */
const RAIL_PAD = 4;
/** The line height of a row's first line — the time and the place beside it. */
const RAIL_LINE = 18;
/**
 * More dashes than any stretch of rail is tall, clipped to the stretch. Android
 * draws a dashed border only on a view bordered on all four sides, and a
 * one-sided rule is what this needs, so the dashes are drawn as views.
 */
const RAIL_DOTS = Array.from({ length: 60 }, (_, index) => index);

/** One piece of rail, `top` to `bottom` of its row (either may be omitted for a node's half). */
function RailPiece({ rail, top, height }: { rail: Rail; top: number; height?: number }) {
  const box = { top, ...(height === undefined ? { bottom: 0 } : { height }) };
  if (rail.kind === 'ride') {
    return (
      <View
        style={[
          styles.railRide,
          rail.now && styles.railRideNow,
          box,
          { backgroundColor: rail.fill },
        ]}
      />
    );
  }
  const color =
    rail.tone === 'broken' ? theme.danger : rail.tone === 'tight' ? theme.warning : theme.textMuted;
  return (
    <View style={[styles.railFoot, box]}>
      {RAIL_DOTS.map((dot) => (
        <View key={dot} style={[styles.railDot, { backgroundColor: color }]} />
      ))}
    </View>
  );
}

/**
 * One row of the itinerary: the time, the rail, what happens there.
 *
 * A row with a `node` is a place in time — a departure, an arrival, a walk's
 * start — and draws the rail arriving at its node from `above` and leaving it
 * `below`, each in its own style, so the node is where a solid leg turns into
 * a dotted change. A row without one is the stretch between two nodes (the
 * vehicle, the change) and carries its rail the whole height.
 *
 * The node follows the system font scale: the first line it sits on is
 * `RAIL_LINE` tall only at 100 %, and a phone set larger would otherwise put
 * every node above its own time.
 */
function RailRow({
  node,
  above = null,
  below = null,
  time,
  dim = false,
  children,
}: {
  node?: 'stop' | 'walk';
  above?: Rail | null;
  below?: Rail | null;
  time?: ReactNode;
  dim?: boolean;
  children: ReactNode;
}) {
  const { fontScale } = useWindowDimensions();
  const nodeY = RAIL_PAD + (RAIL_LINE * fontScale) / 2;
  // A stop is ringed in its ride's colour — an arrival's ride is the rail
  // above it, a departure's the one below; the change beside either has none.
  const nodeRail = [below, above].find((rail) => rail?.kind === 'ride') ?? null;
  const size = node === 'walk' ? 7 : 10;
  return (
    <View style={[styles.railRow, dim && styles.legPast]}>
      {/* One width for every row, or the rail would kink where a row's time is wider. */}
      <View style={[styles.legTime, { width: Math.ceil(50 * fontScale) }]}>{time}</View>
      <View style={styles.rail}>
        {node ? (
          <>
            {above ? <RailPiece rail={above} top={0} height={nodeY} /> : null}
            {below ? <RailPiece rail={below} top={nodeY} /> : null}
            <View
              style={[
                styles.railNode,
                node === 'walk' && styles.railNodeWalk,
                {
                  top: nodeY - size / 2,
                  width: size,
                  height: size,
                  marginLeft: -size / 2,
                  borderRadius: size / 2,
                },
                node === 'stop' && nodeRail?.kind === 'ride' && { borderColor: nodeRail.fill },
              ]}
            />
          </>
        ) : above ? (
          <RailPiece rail={above} top={0} />
        ) : null}
      </View>
      <View style={styles.legBody}>{children}</View>
    </View>
  );
}

/**
 * The interchange as the dotted stretch between the node where one vehicle
 * arrives and the node where the next leaves: `6 min connection · 150 m walk`.
 * Where is not repeated — the two nodes either side of it name the stop and
 * the platforms. Tapping it opens the transfer itself — both times with their
 * platforms, the walk, the live wait and why it is flagged — for the traveller
 * about to make it.
 */
function Interchange({
  change,
  broken,
  rail,
}: {
  change: CommuteConnection;
  /** `commuteConnectionBreak`'s sentence, when the numbers say it no longer holds. */
  broken: string | null;
  rail: Rail;
}) {
  const [open, setOpen] = useState(false);
  const tone = broken ? styles.changeBroken : change.warn ? styles.changeTight : null;
  return (
    <RailRow above={rail}>
      <Pressable
        style={styles.interchange}
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        testID="commute-interchange"
      >
        <Text style={[styles.interchangeText, tone]}>
          {change.warn || broken ? '⚠ ' : ''}
          {change.summary}
          {/* Beside the planned wait it corrects (§3), not across the card. */}
          {change.liveLabel && !broken ? (
            <Text style={styles.interchangeLive}> · {change.liveLabel}</Text>
          ) : null}
        </Text>
        {broken ? <Text style={[styles.interchangeDetail, tone]}>{broken}</Text> : null}
        {open
          ? change.details.map((line) => (
              <Text key={line} style={styles.interchangeDetail}>
                {line}
              </Text>
            ))
          : null}
      </Pressable>
    </RailRow>
  );
}

/** A clock face in the itinerary's time column, with its live estimate under it. */
function RailTime({ parts }: { parts: CommuteRide['departure'] }) {
  return (
    <>
      <Text style={styles.legTimeText}>{parts.aimed}</Text>
      {parts.delay ? (
        <Text style={styles.legEstimate} numberOfLines={1}>
          {parts.expected} est.
        </Text>
      ) : null}
    </>
  );
}

/**
 * The journey as a chronological itinerary on one rail: the walk to the stop,
 * each leg as a departure node and an arrival node joined by a solid line in
 * the vehicle's colour, the change as a dotted stretch between legs, the notices
 * on the leg they concern, the walk at the end.
 *
 * Only what the collapsed card cannot say. There is no closing "Total 48 min"
 * line — the card's head states the whole journey, and the itinerary is read
 * from it — and nothing about a disruption is repeated from the card: the card
 * says *that* the journey is affected, the itinerary says *which leg*.
 *
 * Shared by the expanded journey and the tracked card, which is the point: the
 * tracked card used to be the one place on this sheet that could *not* say
 * which platform to stand on.
 */
function Itinerary({
  journey,
  notices,
  broken = null,
  /**
   * The ride the traveller is on or about to board, from the phase ladder.
   * Legs before it are dimmed rather than dropped: a journey is read as a
   * shape, and removing its first half moves everything that is left. The
   * current one's rail is drawn heavier — position and weight mark it, never
   * colour, which is spent on the line and on service state.
   */
  activeIndex = null,
}: {
  journey: CommuteJourney;
  /** Per-ride notices; the rides' own by default. */
  notices?: readonly (readonly CommuteDisruption[])[];
  broken?: CommuteDashboardRow['broken'];
  activeIndex?: number | null;
}) {
  const walk: Rail = { kind: 'foot', tone: null };
  const changeRail = (index: number): Rail | null => {
    const change = journey.connections[index - 1];
    if (!change) return null;
    const tone = broken?.index === index ? 'broken' : change.warn ? 'tight' : null;
    return { kind: 'foot', tone };
  };
  const last = journey.rides.length - 1;
  return (
    <View style={styles.legs}>
      {journey.walkIn ? (
        <RailRow
          node="walk"
          below={walk}
          time={<Text style={styles.legWalkTime}>{journey.walkIn.aimed}</Text>}
        >
          <Text style={styles.legPlace}>🚶 {journey.walkIn.label}</Text>
        </RailRow>
      ) : null}
      {journey.rides.map((ride, index) => {
        const connection = journey.connections[index - 1];
        const into = index === 0 ? (journey.walkIn ? walk : null) : changeRail(index);
        const onward = index === last ? (journey.walkOut ? walk : null) : changeRail(index + 1);
        const rail: Rail = { kind: 'ride', fill: ride.badge.fill, now: index === activeIndex };
        const past = activeIndex !== null && index < activeIndex;
        return (
          <View key={ride.key}>
            {connection ? (
              <Interchange
                change={connection}
                broken={broken?.index === index ? broken.detail : null}
                rail={into!}
              />
            ) : null}
            <RailRow
              node="stop"
              above={into}
              below={rail}
              time={<RailTime parts={ride.departure} />}
              dim={past}
            >
              <Text style={styles.legPlaceStrong}>
                {[ride.from, ride.fromQuay].filter(Boolean).join(' · ')}
              </Text>
            </RailRow>
            <RailRow above={rail} dim={past}>
              <View style={styles.legSpan}>
                {/* One line beside the stretch it describes: the vehicle, where
                    it is headed, and what riding it costs at the far edge. */}
                <View style={styles.legSpanHead}>
                  <Badge badge={ride.badge} mode={ride.mode} line={ride.line} />
                  {ride.towards ? (
                    <Text style={styles.legTowards} numberOfLines={1}>
                      → {ride.towards}
                    </Text>
                  ) : null}
                  <Text style={styles.legRide} numberOfLines={1}>
                    {ride.ride}
                  </Text>
                </View>
                <Disruptions items={notices?.[index] ?? ride.disruptions} />
              </View>
            </RailRow>
            <RailRow
              node="stop"
              above={rail}
              below={onward}
              time={<RailTime parts={ride.arrival} />}
              dim={past}
            >
              <Text style={styles.legPlaceStrong}>
                {[ride.to, ride.toQuay].filter(Boolean).join(' · ')}
              </Text>
            </RailRow>
          </View>
        );
      })}
      {journey.walkOut ? (
        <RailRow
          node="walk"
          above={walk}
          time={<Text style={styles.legWalkTime}>{journey.walkOut.aimed}</Text>}
        >
          <Text style={styles.legPlace}>🚶 {journey.walkOut.label}</Text>
        </RailRow>
      ) : null}
    </View>
  );
}

/**
 * One journey, collapsed to what a quick check needs, expandable to its
 * itinerary.
 *
 * Collapsed, it answers the commute at a glance: when it leaves and arrives on
 * the timetable, the live times beside them when they moved, the vehicles in
 * proportion, where the change is and how long it is (flagged when short or put
 * in doubt), and one line per disruption. Expanded, the overview's interchange
 * line and notices give way to the itinerary that says the same things in their
 * place — never both at once.
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
  onOpenJourney,
}: {
  row: CommuteDashboardRow;
  open: boolean;
  onToggle: () => void;
  onTrack: () => void;
  onOpenJourney: (trip: TransitTrip) => void;
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
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        testID={`commute-journey-${row.key}`}
      >
        <ScanLine journey={journey} />
        <Live journey={journey} />
        {/* Expanded, the itinerary draws the same legs and change on its rail,
            better; the strip above it would say it twice. */}
        {open ? null : <Ribbon parts={row.parts} />}
      </Pressable>
      {open ? (
        <>
          <Itinerary journey={journey} notices={row.rideDisruptions} broken={row.broken} />
          <View style={styles.actions}>
            <Pressable
              style={[styles.track, !row.tracked && styles.trackFilled]}
              onPress={onTrack}
              testID="commute-track-row"
            >
              <Text style={[styles.trackText, !row.tracked && styles.trackFilledText]}>
                {row.tracked ? 'Stop tracking' : 'Track this journey'}
              </Text>
            </Pressable>
            <View style={styles.actionsMore}>
              <Pressable
                style={styles.trackQuiet}
                onPress={() => onOpenJourney(journey.trip)}
                testID="commute-open-journey-row"
              >
                <Text style={styles.trackQuietText}>Open in planner</Text>
              </Pressable>
            </View>
          </View>
        </>
      ) : (
        <>
          <Overview row={row} />
          <Disruptions items={row.disruptions} />
        </>
      )}
    </View>
  );
}

/**
 * TRANSIT.md §7 — where you are in the journey you are tracking.
 *
 * Every part of this already existed and none of it reached this screen: the
 * phase ladder, the connection break and the commitment all shipped for the
 * home-screen widget, so the widget knew which leg you were on and the board —
 * the surface you actually open once you are moving — did not.
 *
 * Drawn from the journey kept on the device the moment the sheet opens, and
 * refreshed behind it: `freshness` says how old its live times are, so a card
 * that could not be updated on a train's Wi-Fi never passes for one that was.
 */
function HereCard({
  here,
  journey,
  freshness,
  onStop,
  onOpenJourney,
}: {
  here: CommuteHere;
  /** The tracked journey whole, for the itinerary below the connection block. */
  journey: CommuteJourney | null;
  freshness: string | null;
  onStop: () => void;
  onOpenJourney: (trip: TransitTrip) => void;
}) {
  return (
    <View style={[styles.card, styles.cardAccent]} testID="commute-here">
      <View style={styles.eyebrowRow}>
        <Text style={styles.eyebrow}>{here.heading.toUpperCase()}</Text>
        <Text style={styles.phaseChip}>{here.phaseLabel.toUpperCase()}</Text>
      </View>
      {freshness ? (
        <Text style={styles.freshness} testID="commute-here-freshness">
          {freshness}
        </Text>
      ) : null}
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
      {journey ? <Itinerary journey={journey} activeIndex={here.rideIndex} /> : null}
      <View style={styles.actions}>
        <Pressable style={styles.track} onPress={onStop} testID="commute-stop-tracking">
          <Text style={styles.trackText}>Stop tracking</Text>
        </Pressable>
        {journey ? (
          <View style={styles.actionsMore}>
            <Pressable
              style={styles.trackQuiet}
              onPress={() => onOpenJourney(journey.trip)}
              testID="commute-open-journey-here"
            >
              <Text style={styles.trackQuietText}>Open in planner</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
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
 *
 * The same two states as a journey row — the overview, or the itinerary in its
 * place — behind a Details control, because this card is the one most often
 * read whole and its itinerary is what used to be missing from it.
 */
function LeaveNow({
  row,
  label,
  nowMs,
  primary,
  showTrack,
  open,
  onToggle,
  onTrack,
  onOpenJourney,
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
  open: boolean;
  onToggle: () => void;
  onTrack: () => void;
  onOpenJourney: (trip: TransitTrip) => void;
}) {
  return (
    <View style={[styles.card, primary && styles.cardAccent]} testID="commute-leave-now">
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
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
        {open ? null : <Ribbon parts={row.parts} tall />}
      </Pressable>
      {open ? (
        <Itinerary journey={row.journey} notices={row.rideDisruptions} broken={row.broken} />
      ) : (
        <>
          <Overview row={row} />
          <Disruptions items={row.disruptions} />
        </>
      )}
      <View style={styles.actions}>
        {showTrack ? (
          <Pressable
            style={[styles.track, !row.tracked && styles.trackFilled]}
            onPress={onTrack}
            testID="commute-track"
          >
            <Text style={[styles.trackText, !row.tracked && styles.trackFilledText]}>
              {row.tracked ? 'Stop tracking' : 'Track this journey'}
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.actionsMore}>
          <Pressable
            style={styles.trackQuiet}
            onPress={onToggle}
            accessibilityState={{ expanded: open }}
            testID="commute-details"
          >
            <Text style={styles.trackQuietText}>{open ? 'Hide details' : 'Details'}</Text>
          </Pressable>
          {open ? (
            <Pressable
              style={styles.trackQuiet}
              onPress={() => onOpenJourney(row.journey.trip)}
              testID="commute-open-journey"
            >
              <Text style={styles.trackQuietText}>Open in planner</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
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
          <Text style={styles.boardArrival}>
            arrives {row.arrival} · <Text style={styles.boardDuration}>{row.duration}</Text>
          </Text>
        </View>
        <View style={styles.boardWhen}>
          <Text style={styles.boardWhenText}>{row.countdown}</Text>
          {row.quay ? <Text style={styles.boardWhenSub}>plat. {row.quay}</Text> : null}
          {row.dayNote ? <Text style={styles.boardWhenSub}>{row.dayNote}</Text> : null}
        </View>
      </View>
      {/* A board row has nothing to expand into, so it carries the headline —
          enough to know something is up, not enough to bury the next row. */}
      <Disruptions items={row.disruptions} />
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
 * The journey list, whole: its shared notices, its headline, its rows and the
 * reason there is none — TRANSIT.md §13.
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
  onOpenJourney,
}: {
  section: CommuteDashboardSection;
  nowMs: number;
  /** Something is being tracked, so this list is not the sheet's only answer. */
  tracking: boolean;
  expanded: string | null;
  onToggle: (key: string) => void;
  onClearLines: () => void;
  onOpenJourney: (trip: TransitTrip) => void;
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
          open={expanded === lead.key}
          onToggle={() => onToggle(lead.key)}
          onTrack={() => section.track(lead.tracked ? null : lead.journey)}
          onOpenJourney={onOpenJourney}
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
              onOpenJourney={onOpenJourney}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

/**
 * The way onto the home screen, from inside the app.
 *
 * Android takes a pin request directly (8.0+), so ask — but only when the
 * launcher actually accepts one: a button that silently does nothing is worse
 * than a sentence. The widget holds the whole commute and follows the leg you
 * are on (docs/TRANSIT.md §W1–§W7).
 *
 * In the menu rather than at the foot of the board: placing a widget is done
 * once, and two paragraphs of it under every morning's departures was
 * configuration in the space the answer should have had.
 */
function useWidgetSupport() {
  const [support, setSupport] = useState<CommuteWidgetSupport | null>(null);
  useEffect(() => {
    let alive = true;
    void commuteWidgetV2Support().then((next) => {
      if (alive) setSupport(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  return support ?? { pinnable: false, count: 0 };
}

/** One row of the board's menu. */
function MenuItem({
  label,
  onPress,
  disabled = false,
  danger = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  testID: string;
}) {
  return (
    <Pressable
      style={[styles.menuItem, disabled && styles.disabled]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="menuitem"
      testID={testID}
    >
      <Text style={[styles.menuItemText, danger && styles.menuItemDanger]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Everything that configures the board rather than reads it: edit, rename,
 * which commute the widget shows, add, delete, and placing the widgets.
 *
 * These were a row of five bordered buttons above the mode tabs, so every
 * morning's glance began by reading past "☆ Widget · Rename · ＋ Add · Delete"
 * to reach a departure time. They are each used once in a while, and the board
 * is read every weekday; behind ⋮ the journey starts a whole row higher.
 */
function CommuteMenu({
  commute,
  editing,
  onEdit,
  onRename,
  onClose,
}: {
  commute: CommuteController;
  editing: boolean;
  onEdit: () => void;
  onRename: () => void;
  onClose: () => void;
}) {
  const active = commute.commutes.find((item) => item.id === commute.activeId)!;
  const widgets = useWidgetSupport();
  const onWidget = active.id === commute.widgetCommuteId;
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <View style={styles.menu} testID="commute-menu-list">
      {!editing ? (
        <MenuItem label="Edit commute" onPress={run(onEdit)} testID="commute-menu-edit" />
      ) : null}
      <MenuItem label="Rename" onPress={run(onRename)} testID="commute-rename" />
      <MenuItem
        label={onWidget ? '★ Shown on the home-screen widget' : '☆ Show on the home-screen widget'}
        disabled={onWidget}
        onPress={run(() => commute.setWidgetCommute(active.id))}
        testID="commute-use-widget"
      />
      <MenuItem
        label="New commute"
        disabled={!commute.canAddCommute}
        onPress={run(commute.addCommute)}
        testID="commute-add"
      />
      <MenuItem
        label="Delete commute"
        danger
        disabled={commute.commutes.length <= 1}
        onPress={run(() =>
          Alert.alert(`Delete “${active.name}”?`, 'The saved commute will be removed.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => commute.deleteCommute(active.id),
            },
          ]),
        )}
        testID="commute-delete"
      />
      {widgets.pinnable ? <View style={styles.menuRule} /> : null}
      {widgets.pinnable ? (
        <MenuItem
          label={
            widgets.count > 0 ? 'Add another commute widget' : 'Add commute widget to home screen'
          }
          onPress={run(() => void addCommuteWidgetV2())}
          testID="commute-add-widget"
        />
      ) : null}
      {widgets.pinnable ? (
        <MenuItem
          label="Add stop departures widget"
          onPress={run(() => void addStopDepartureWidget())}
          testID="commute-add-stop-widget"
        />
      ) : null}
    </View>
  );
}

/**
 * Which saved commute the board reads — shown only when there is a choice to
 * make. One commute has nothing to pick between, and a single chip saying its
 * name above the board is a row spent on the header's own title.
 */
function CommuteChoices({ commute }: { commute: CommuteController }) {
  if (commute.commutes.length <= 1) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.commutePicker}
      contentContainerStyle={styles.commuteChoices}
    >
      {commute.commutes.map((item) => {
        const selected = item.id === commute.activeId;
        return (
          <Pressable
            key={item.id}
            style={[styles.commuteChoice, selected && styles.commuteChoiceOn]}
            onPress={() => commute.selectCommute(item.id)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            testID={`commute-pick-${item.id}`}
          >
            <Text style={[styles.commuteChoiceText, selected && styles.commuteChoiceTextOn]}>
              {item.id === commute.widgetCommuteId ? '★ ' : ''}
              {item.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** The name field the menu's Rename opens, at the top of the board. */
function RenameCommute({ commute, onDone }: { commute: CommuteController; onDone: () => void }) {
  const active = commute.commutes.find((item) => item.id === commute.activeId)!;
  const [name, setName] = useState(active.name);
  const save = () => {
    commute.renameCommute(active.id, name);
    onDone();
  };
  return (
    <View style={styles.commuteRename}>
      <TextInput
        autoFocus
        value={name}
        maxLength={80}
        style={styles.commuteNameInput}
        placeholder="Commute name"
        placeholderTextColor={theme.textMuted}
        onChangeText={setName}
        onSubmitEditing={save}
        testID="commute-name"
      />
      <Pressable style={styles.commuteAction} onPress={save} testID="commute-name-save">
        <Text style={styles.commuteActionText}>Save</Text>
      </Pressable>
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
  onOpenJourney,
  bottomInset,
}: {
  visible: boolean;
  commute: CommuteController;
  places: readonly PlaceRecord[];
  geocode: StopGeocodeFn;
  fetchStopLines: StopLinesFn;
  onClose: () => void;
  onOpenJourney: (trip: TransitTrip) => void;
  bottomInset: number;
}) {
  const editor = useCommuteEditor({ commute, places, geocode, fetchStopLines });
  const dashboard = useCommuteDashboard(commute);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // The name field and the editor both open at the top of the board, which the
  // reader may have scrolled well past to reach the menu's row.
  const toTop = () => scrollRef.current?.scrollTo({ y: 0, animated: true });
  // The editor opens by itself only when the board *cannot* ask a
  // question — not on every launch, which is a moment every launch spends
  // looking unconfigured while storage answers.
  useEffect(() => {
    if (commute.ready && !commute.query) setEditing(true);
  }, [commute.ready, commute.query]);
  useEffect(() => {
    setEditing(!commute.query);
    setRenaming(false);
  }, [commute.activeId]);
  const stale = commute.staleEnds.filter((item) => item.commuteId === commute.activeId);

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
        {/* Editing has one way out, and it is where the eye already is. */}
        {editing ? (
          <Pressable
            style={styles.done}
            onPress={() => setEditing(false)}
            testID="commute-edit"
            accessibilityRole="button"
            accessibilityLabel="Done editing commute"
          >
            <CheckIcon color={theme.accent} />
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        ) : null}
        {commute.ready ? (
          <Pressable
            style={[styles.iconButton, menuOpen && styles.iconButtonOn]}
            onPress={() => setMenuOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel="Commute settings"
            accessibilityState={{ expanded: menuOpen }}
            testID="commute-menu"
          >
            <MoreIcon color={menuOpen ? theme.accent : theme.icon} size={20} />
          </Pressable>
        ) : null}
        <Pressable style={styles.close} onPress={onClose} testID="commute-close">
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
      {menuOpen && commute.ready ? (
        <CommuteMenu
          commute={commute}
          editing={editing}
          onEdit={() => {
            setEditing(true);
            toTop();
          }}
          onRename={() => {
            setRenaming(true);
            toTop();
          }}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
      >
        {!commute.ready ? <Text style={styles.state}>Loading saved commute…</Text> : null}
        {commute.ready && renaming ? (
          <RenameCommute commute={commute} onDone={() => setRenaming(false)} />
        ) : null}
        {commute.ready ? <CommuteChoices commute={commute} /> : null}
        {stale.map((item) => (
          <Text style={[styles.state, styles.warning]} key={`${item.commuteId}:${item.end}`}>
            {item.end === 'from' ? 'From' : item.end === 'to' ? 'To' : 'Via'} uses the last copy of
            a deleted saved place. Choose it again to reconnect it.
          </Text>
        ))}
        {/* TRANSIT.md §13's three modes, and the only control over what is shown.
            Out, back, and the middle ground — the third is not a direction at
            all but the change, drawn as the departures leaving it in both
            directions. Nothing configures the board from this row any more:
            it is the everyday control, and configuration is behind ⋮. */}
        <View style={styles.modes}>
          {dashboard.modes.map((item) => {
            const selected = item === dashboard.mode;
            return (
              <Pressable
                key={item}
                style={[styles.modeButton, selected && styles.modeButtonOn]}
                onPress={() => dashboard.setMode(item)}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                testID={`commute-mode-${item}`}
              >
                <Text style={[styles.modeText, selected && styles.modeTextOn]} numberOfLines={1}>
                  {commuteModeChip(item)}
                </Text>
              </Pressable>
            );
          })}
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
        {/* Only while there is nothing to show: a refresh behind a board that
            already has an answer is said on the footer, not by pushing the
            answer down the sheet. */}
        {commute.loading && !commute.result ? (
          <Text style={styles.state}>Checking upcoming journeys…</Text>
        ) : null}
        {commute.error && !commute.result ? (
          <Text style={[styles.state, styles.error]}>{commute.error}</Text>
        ) : null}
        {/* Above the list rather than inside it: a commitment outlives the list
            its journey came from — a mode switch included — and the card is
            what the traveller stops it on. */}
        {dashboard.here ? (
          <HereCard
            here={dashboard.here}
            journey={dashboard.hereJourney}
            freshness={dashboard.hereFreshness}
            onStop={dashboard.stopTracking}
            onOpenJourney={onOpenJourney}
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
            onOpenJourney={onOpenJourney}
          />
        ) : null}
        {dashboard.boards.map((board, index) => (
          <Board board={board} divided={index > 0} key={board.segment.id} />
        ))}
        <View style={styles.live}>
          <Text
            style={[styles.liveText, commute.error && commute.result ? styles.warning : null]}
            testID="commute-freshness"
          >
            Entur · {dashboard.freshness}
          </Text>
          <Pressable
            style={styles.refresh}
            onPress={commute.refresh}
            disabled={commute.loading || !editor.askable}
          >
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </View>
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
  iconButton: { padding: 8, borderRadius: 999 },
  iconButtonOn: { backgroundColor: theme.accentFaint },
  done: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: 2,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: theme.accentFaint,
  },
  doneText: { color: theme.accent, fontSize: 13, fontWeight: '800' },

  // The board's configuration, folded under the header like the route panel's
  // own overflow: rows, not a floating popover, so nothing covers the board.
  menu: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 4,
    borderRadius: 11,
    backgroundColor: theme.surfaceMuted,
  },
  menuItem: { paddingVertical: 10, paddingHorizontal: 13 },
  menuItemText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  menuItemDanger: { color: theme.danger },
  menuRule: {
    height: 1,
    marginVertical: 3,
    marginHorizontal: 13,
    backgroundColor: 'rgba(128,138,148,0.35)',
  },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 16, paddingBottom: 24 },

  commutePicker: { flexGrow: 0, marginBottom: 10 },
  commuteChoices: { gap: 6, paddingRight: 8 },
  commuteChoice: {
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: 999,
    backgroundColor: theme.surfaceMuted,
  },
  commuteChoiceOn: { backgroundColor: theme.accentFaint },
  commuteChoiceText: { color: theme.textMuted, fontSize: 12, fontWeight: '700' },
  commuteChoiceTextOn: { color: theme.accent },
  commuteRename: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  commuteNameInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
    color: theme.text,
    fontSize: 13,
  },
  commuteAction: {
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  commuteActionText: { color: theme.textMuted, fontSize: 11, fontWeight: '700' },
  disabled: { opacity: 0.45 },

  modes: { flexDirection: 'row', gap: 6, marginBottom: 10 },
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

  // A card's actions on one row: the everyday one outlined, the others as
  // quiet text beside it, so a card never ends in a stack of full-width boxes.
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 9 },
  track: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.accent,
  },
  trackText: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  // Tracking is the primary action: filled to start, outlined to stop, one
  // size either way. The secondary actions share one treatment and the same
  // height (a transparent border), grouped at the far edge by `actionsMore`.
  trackFilled: { backgroundColor: theme.accent },
  trackFilledText: { color: theme.onAccent },
  trackQuiet: {
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  trackQuietText: { color: theme.accent, fontSize: 12, fontWeight: '600' },
  // The secondary actions wrap as one group, still at the far edge, rather
  // than one of them dropping under the primary on its own.
  actionsMore: { flexDirection: 'row', gap: 2, marginLeft: 'auto' },
  // How old the tracked card's live times are — small, but always there.
  freshness: { marginTop: 2, color: theme.textMuted, fontSize: 10, opacity: 0.8 },

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

  legs: { marginTop: 9, paddingTop: 4, borderTopWidth: 1, borderTopColor: theme.border },
  // The itinerary's rows: time · rail · text. The rail column stretches each
  // row's full height so consecutive rows join into one line; a node sits on
  // the first text line, RAIL_PAD + half of RAIL_LINE down.
  railRow: { flexDirection: 'row', gap: 8 },
  legTime: { paddingVertical: RAIL_PAD },
  legTimeText: { color: theme.text, fontSize: 13, lineHeight: RAIL_LINE, fontWeight: '700' },
  legEstimate: { color: theme.textMuted, fontSize: 10, lineHeight: 13 },
  legBody: { flex: 1, paddingVertical: RAIL_PAD },
  // The stretch a vehicle is ridden: its line, its stops, its notices.
  legSpan: { paddingVertical: 1 },
  // Stops and minutes after the line and its heading, so the leg reads as one
  // unit; they wrap under it when a large font leaves no room beside it.
  legSpanHead: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 6,
    rowGap: 2,
  },
  legTowards: { flexShrink: 1, color: theme.text, fontSize: 12, fontWeight: '700' },
  legPlace: { color: theme.textMuted, fontSize: 11, lineHeight: RAIL_LINE },
  legPlaceStrong: { color: theme.text, fontSize: 12, lineHeight: RAIL_LINE, fontWeight: '600' },
  legWalkTime: { color: theme.textMuted, fontSize: 12, lineHeight: RAIL_LINE, fontWeight: '600' },
  legRide: { marginLeft: 6, color: theme.textMuted, fontSize: 11 },
  // Legs already ridden, in the tracked card. The current one is marked by its
  // rail's weight — every colour channel on this board is already spent saying
  // what a service *is*, and a leg that is merely current is not a state.
  legPast: { opacity: 0.5 },
  rail: { width: 14, alignSelf: 'stretch' },
  // A ride in its line's colour — the fill channel, the line's identity (the
  // same colour as its badge and its ribbon segment).
  railRide: { position: 'absolute', left: 5.5, width: 3 },
  railRideNow: { left: 4.5, width: 5 },
  // On foot: the change between vehicles and the walks at either end.
  railFoot: { position: 'absolute', left: 6, width: 2, overflow: 'hidden' },
  railDot: { width: 2, height: 3, borderRadius: 1, marginBottom: 2 },
  // A stop: a ring in the line's colour sitting on the line, as a metro map
  // draws one. Size and position come from RailRow.
  railNode: {
    position: 'absolute',
    left: 7,
    borderWidth: 2,
    borderColor: theme.textMuted,
    backgroundColor: theme.surface,
  },
  railNodeWalk: { borderWidth: 1.5 },
  // The change between two legs (§17), on the dotted stretch between them —
  // how long and how far to walk; the nodes either side name the stop.
  interchange: { paddingVertical: 4 },
  interchangeText: { flexShrink: 1, color: theme.textMuted, fontSize: 11, fontWeight: '600' },
  interchangeLive: { fontWeight: '700' },
  interchangeDetail: { color: theme.textMuted, fontSize: 11, lineHeight: 15, marginTop: 2 },

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
  boardArrival: { color: theme.text, fontSize: 11 },
  boardDuration: { color: theme.text, fontWeight: '800' },
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
  // A general notice: a grey edge and muted text — present, not competing.
  disruptionQuiet: { borderLeftColor: 'rgba(128,138,148,0.45)', opacity: 0.85 },
  disruptionKind: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, marginBottom: 1 },
  disruptionText: { color: theme.text, fontSize: 11, lineHeight: 15 },
  disruptionTextQuiet: { color: theme.textMuted },
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
  warning: { color: theme.warning },
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
});
