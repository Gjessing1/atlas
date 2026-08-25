import {
  useCommuteDashboard,
  useCommuteEditor,
  type CommuteController,
  type CommuteDashboard,
  type CommuteDashboardBoard,
  type StopGeocodeFn,
  type StopLinesFn,
} from '@atlas/app-hooks';
import {
  commuteEstimateLabel,
  liveTimetableLabel,
  type CommuteBoardRow,
  type CommuteDisruption,
  type CommuteJourney,
  type CommuteServiceState,
  type TransitMode,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { Fragment, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  addCommuteWidget,
  commuteWidgetSupport,
  type CommuteWidgetSupport,
} from '../commuteWidget';
import { BottomSheet } from './BottomSheet';
import { CommuteEditorForm } from './CommuteEditor';
import { theme } from './theme';

/**
 * The commute dashboard on Android — ROADMAP §6.4, the same model the web panel
 * renders.
 *
 * What it replaced was a configuration form with a result list stapled under
 * it: three stop pickers, two time fields, seven day chips and a wall of line
 * chips before the first departure time. The sheet now opens on the answer —
 * what leaving now gets you, the complete journey options as one scannable line
 * each, and the per-leg boards for someone already on the bus — with the form
 * behind "Edit commute".
 *
 * Nothing here formats a time or decides a status; `@atlas/transit` does both,
 * so this sheet and the browser panel and the home-screen widget cannot
 * disagree about when the 08:41 leaves.
 */

/** One glyph per mode. The word is in `modeLabel`; this is what you see first. */
const MODE_GLYPH: Partial<Record<TransitMode, string>> = {
  bus: '🚌',
  coach: '🚌',
  rail: '🚆',
  metro: '🚇',
  tram: '🚊',
  water: '⛴️',
  air: '✈️',
  cableway: '🚡',
  funicular: '🚞',
  foot: '🚶',
};

const glyph = (mode: TransitMode) => MODE_GLYPH[mode] ?? '•';

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
 * The vehicles of a journey with their own times, and the changes between them.
 *
 * The collapsed row's second line, and the gap this closed: it used to read
 * "🚌 270 🚆 L1", which tells a reader that a train is involved and nothing
 * about when it leaves Asker or when it reaches town. On a two-leg commute that
 * is the whole question, and answering it meant expanding a row (§1, §2).
 */
function LegStrip({ journey }: { journey: CommuteJourney }) {
  return (
    <View style={styles.journeyLines}>
      {journey.rides.map((ride, index) => {
        const change = journey.connections[index - 1];
        return (
          <Fragment key={ride.key}>
            {change ? (
              <Text style={[styles.change, change.tight && styles.changeTight]}>
                ⇄ {change.chip}
              </Text>
            ) : null}
            <View style={[styles.lineChip, { borderColor: STATE_COLOUR[ride.state] }]}>
              <Text
                style={[
                  styles.lineChipText,
                  ride.state === 'cancelled' && styles.lineChipCancelled,
                ]}
              >
                {glyph(ride.mode)} {ride.line}
              </Text>
              <Text
                style={[
                  styles.lineChipWindow,
                  ride.state === 'cancelled' && styles.lineChipCancelled,
                ]}
              >
                {ride.window}
              </Text>
            </View>
          </Fragment>
        );
      })}
    </View>
  );
}

/**
 * One journey, collapsed to its scan line and expandable to its legs.
 *
 * The times are the *scheduled* ones — the numbers printed at the stop — with
 * the live estimate beside them as a labelled secondary. Replacing 08:41 with
 * 08:43 destroys the reference point the traveller is comparing against.
 */
function JourneyRow({
  journey,
  open,
  onToggle,
}: {
  journey: CommuteJourney;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={[styles.journey, { borderLeftColor: STATE_COLOUR[journey.state] }]}>
      <Pressable onPress={onToggle} testID={`commute-journey-${journey.key}`}>
        <View style={styles.journeyHead}>
          {/* §3's shape, the same one the per-leg boards use: the scheduled time
              is the number, and what the live feed says about it sits *under*
              it rather than at the far end of the card. It used to share a line
              with the leg strip, where a long strip squeezed it to nothing and
              a short one left it stranded a card's width from the time it was
              about. */}
          <View style={styles.journeyEnd}>
            <Text style={styles.journeyTime}>{journey.departure.aimed}</Text>
            <Text style={styles.journeyEndNote}>
              {commuteEstimateLabel(journey.departure, false)}
            </Text>
          </View>
          <View style={styles.journeyRule} />
          <View style={styles.journeyEndRight}>
            <Text style={styles.journeyTime}>{journey.arrival.aimed}</Text>
            {journey.dayNote ? <Text style={styles.journeyEndNote}>{journey.dayNote}</Text> : null}
          </View>
          <View style={styles.journeyEndRight}>
            <Text style={styles.journeyDuration}>{journey.duration}</Text>
            {/* The strip below names every change; "1 change" beside it is the
                same fact, worse said. "direct" is not — nothing else says it. */}
            {journey.connections.length === 0 ? (
              <Text style={styles.journeyEndNote}>{journey.transfers}</Text>
            ) : null}
          </View>
          {/* The row *is* expandable, so it has to look it: without a caret the
              legs below were a feature nobody found. */}
          <Text style={styles.journeyCaret}>{open ? '▴' : '▾'}</Text>
        </View>
        {/* The strip gets the card's full width now that nothing shares its
            line: two vehicles and a change is more than fits beside a status. */}
        <View style={styles.journeyMeta}>
          <LegStrip journey={journey} />
        </View>
      </Pressable>
      {/* Collapsed: the headline only. The full notice waits inside, under the
          leg it belongs to. */}
      {!open ? <Disruptions items={journey.disruptions} brief /> : null}
      {open ? (
        <View style={styles.legs}>
          {journey.rides.map((ride, index) => {
            const connection = journey.connections[index - 1];
            return (
              <View key={ride.key}>
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
                    <Text style={styles.legLine}>
                      {glyph(ride.mode)} {ride.line}
                      {ride.towards ? ` → ${ride.towards}` : ''}
                    </Text>
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
      ) : null}
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
function LeaveNow({ dashboard }: { dashboard: CommuteDashboard }) {
  const { next } = dashboard.leaveNow;
  if (!next) return null;
  return (
    <View style={styles.leaveNow} testID="commute-leave-now">
      <Text style={styles.leaveNowHead}>IF I LEAVE NOW</Text>
      <View style={styles.leaveNowMain}>
        <Text style={styles.leaveNowTime}>{next.departure.aimed}</Text>
        <Text style={styles.leaveNowArrive}>→ {next.arrival.aimed}</Text>
        <Text style={styles.leaveNowDuration}>{next.duration}</Text>
      </View>
      <Text style={styles.leaveNowStatus}>
        {[commuteEstimateLabel(next.departure, false), next.dayNote].filter(Boolean).join(' · ')}
      </Text>
      {/* The same strip the journey rows carry: the top of the dashboard is the
          one place that must not answer "a bus and a train, at some point". */}
      <LegStrip journey={next} />
      {/* In full, not clamped: this is the journey the reader is being told to
          leave for, and "Buss for tog Asker–…" is the half of the sentence that
          decides whether they should. */}
      <Disruptions items={next.disruptions} />
    </View>
  );
}

/** One row of a per-leg board: scheduled time first, estimate labelled beneath. */
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
          <Text style={styles.boardLineText} numberOfLines={1}>
            {glyph(row.mode)} {row.line}
          </Text>
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

function Board({ board }: { board: CommuteDashboardBoard }) {
  return (
    <View style={styles.board}>
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
 * The way onto the home screen, from inside the app.
 *
 * "Add it from your launcher's widget picker" was the whole of this before,
 * which is an instruction to go and do something somewhere else. Android takes
 * a pin request directly (8.0+), so ask — but only when the launcher actually
 * accepts one: a button that silently does nothing is worse than a sentence.
 */
function WidgetOffer() {
  const [support, setSupport] = useState<CommuteWidgetSupport | null>(null);
  useEffect(() => {
    let alive = true;
    void commuteWidgetSupport().then((next) => {
      if (alive) setSupport(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!support) return null;
  return (
    <View style={styles.widget}>
      <Text style={styles.widgetNote}>
        {support.count > 0
          ? 'This saved board also fills your home screen. Tap a widget’s tuning icon to choose which direction it shows.'
          : 'This saved board can sit on your home screen, with live delays and platforms.'}
      </Text>
      {support.pinnable ? (
        <Pressable
          style={styles.widgetAdd}
          onPress={() => void addCommuteWidget()}
          testID="commute-add-widget"
        >
          <Text style={styles.widgetAddText}>
            {support.count > 0 ? 'Add another widget' : 'Add to home screen'}
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
        <View style={styles.toolbar}>
          <View style={styles.direction}>
            {(['outbound', 'inbound'] as const).map((item) => {
              const selected = item === dashboard.direction;
              return (
                <Pressable
                  key={item}
                  style={[styles.directionButton, selected && styles.directionButtonOn]}
                  onPress={() => dashboard.setDirection(item)}
                  testID={`commute-direction-${item}`}
                >
                  <Text style={[styles.directionText, selected && styles.directionTextOn]}>
                    {item === 'outbound' ? 'Outbound' : 'Return'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            style={[styles.editButton, editing && styles.editButtonOn]}
            onPress={() => setEditing((open) => !open)}
            testID="commute-edit"
          >
            <Text style={[styles.editText, editing && styles.editTextOn]}>
              {editing ? 'Done' : 'Edit commute'}
            </Text>
          </Pressable>
        </View>
        {editing ? <CommuteEditorForm editor={editor} places={places} /> : null}
        {dashboard.offDayNote ? <Text style={styles.state}>{dashboard.offDayNote}</Text> : null}
        {/* §9's mode switch. It filters rather than scrolls: five journeys plus
            four five-row boards is more than one glance holds, and the whole
            dashboard exists to be glanced at. Journeys stay the landing view. */}
        {dashboard.hasBoards ? (
          <View style={styles.views}>
            {(['overview', 'departures'] as const).map((item) => {
              const selected = item === dashboard.view;
              return (
                <Pressable
                  key={item}
                  style={[styles.viewButton, selected && styles.viewButtonOn]}
                  onPress={() => dashboard.setView(item)}
                  testID={`commute-view-${item}`}
                >
                  <Text style={[styles.viewText, selected && styles.viewTextOn]}>
                    {item === 'overview' ? 'Journeys' : 'Departures'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {commute.loading ? <Text style={styles.state}>Checking upcoming journeys…</Text> : null}
        {commute.error ? <Text style={[styles.state, styles.error]}>{commute.error}</Text> : null}
        {dashboard.view === 'overview' ? (
          <>
            <LeaveNow dashboard={dashboard} />
            {dashboard.emptyNote ? (
              <View>
                <Text style={styles.state}>{dashboard.emptyNote}</Text>
                {dashboard.emptyFromFilter ? (
                  <Pressable style={styles.escape} onPress={editor.clearLines}>
                    <Text style={styles.escapeText}>Allow any line</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {/* Not `journeys`: the one above is already answered in full, and a
                list that repeats it as its own first row costs the reader the
                departure they were actually looking for. */}
            {dashboard.laterJourneys.length > 0 ? (
              <>
                <Text style={styles.sectionHead}>NEXT JOURNEYS</Text>
                {dashboard.laterJourneys.map((journey) => (
                  <JourneyRow
                    journey={journey}
                    key={journey.key}
                    open={dashboard.expanded === journey.key}
                    onToggle={() => dashboard.toggle(journey.key)}
                  />
                ))}
              </>
            ) : null}
          </>
        ) : (
          dashboard.boards.map((board) => <Board board={board} key={board.segment.id} />)
        )}
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
  direction: { flex: 1, flexDirection: 'row', gap: 6 },
  directionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 9,
    backgroundColor: theme.surfaceMuted,
  },
  directionButtonOn: { backgroundColor: theme.accentFaint },
  directionText: { color: theme.textMuted, fontSize: 13, fontWeight: '700' },
  directionTextOn: { color: theme.accent },
  editButton: {
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 9,
    backgroundColor: theme.surfaceMuted,
  },
  editButtonOn: { backgroundColor: theme.accentFaint },
  editText: { color: theme.textMuted, fontSize: 12, fontWeight: '700' },
  editTextOn: { color: theme.accent },

  views: {
    flexDirection: 'row',
    gap: 3,
    padding: 3,
    marginBottom: 10,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  viewButton: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8 },
  viewButtonOn: { backgroundColor: theme.surface },
  viewText: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  viewTextOn: { color: theme.text, fontWeight: '800' },

  sectionHead: {
    color: theme.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 14,
    marginBottom: 6,
  },

  leaveNow: {
    padding: 11,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: theme.accent,
    backgroundColor: theme.accentFaint,
  },
  leaveNowHead: { color: theme.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  leaveNowMain: { flexDirection: 'row', alignItems: 'baseline', gap: 7, marginTop: 4 },
  leaveNowTime: { color: theme.text, fontSize: 26, fontWeight: '800' },
  leaveNowArrive: { color: theme.text, fontSize: 15, fontWeight: '600' },
  leaveNowDuration: {
    marginLeft: 'auto',
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  // What the live feed says about the headline departure, under the time it is
  // about — the same place the journey cards and the per-leg boards put it.
  leaveNowStatus: { color: theme.textMuted, fontSize: 11, marginTop: 1 },

  journey: {
    marginBottom: 7,
    padding: 10,
    borderRadius: 10,
    borderLeftWidth: 3,
    backgroundColor: theme.surfaceMuted,
  },
  journeyHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  // Each end of the journey is a stack: the timetable's number, and beneath it
  // what the live feed says about that number (§3).
  journeyEnd: { alignItems: 'flex-start' },
  journeyEndRight: { alignItems: 'flex-end' },
  journeyEndNote: { color: theme.textMuted, fontSize: 10 },
  journeyTime: { color: theme.text, fontSize: 17, fontWeight: '800' },
  journeyRule: { flex: 1, height: 1, minWidth: 12, backgroundColor: theme.border, opacity: 0.3 },
  journeyDuration: { color: theme.text, fontSize: 13, fontWeight: '800' },
  journeyMeta: { marginTop: 6 },
  journeyCaret: { color: theme.textMuted, fontSize: 10 },
  journeyLines: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 4,
    flexShrink: 1,
  },
  lineChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
  },
  lineChipText: { color: theme.text, fontSize: 11, fontWeight: '800' },
  // The window is the point of the chip; the line code is what identifies it.
  // Same size, one weight and one tone down.
  lineChipWindow: { color: theme.textMuted, fontSize: 11 },
  lineChipCancelled: { textDecorationLine: 'line-through' },
  change: { color: theme.textMuted, fontSize: 10 },
  changeTight: { color: theme.warning, fontWeight: '700' },

  legs: { marginTop: 9, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.border },
  leg: { flexDirection: 'row', gap: 9, paddingTop: 6 },
  legTime: { minWidth: 46 },
  legTimeText: { color: theme.text, fontSize: 13, fontWeight: '700' },
  legEstimate: { color: theme.textMuted, fontSize: 10 },
  legBody: { flex: 1 },
  legLine: { color: theme.text, fontSize: 12, fontWeight: '700' },
  legPlace: { color: theme.textMuted, fontSize: 11 },
  legRide: { color: theme.textMuted, fontSize: 10 },
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
  strike: { textDecorationLine: 'line-through' },
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
});
