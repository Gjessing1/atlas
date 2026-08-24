import {
  useCommuteEditor,
  type CommuteController,
  type CommuteEditor,
  type CommuteEndKey,
  type CommuteLineOption,
  type StopGeocodeFn,
  type StopLinesFn,
} from '@atlas/app-hooks';
import {
  defaultCommuteDirection,
  emptyDirectionNote,
  liveTimetableLabel,
  minutesOfDayLabel,
  tripSummary,
  type TransitCommuteDirection,
  type TransitTrip,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  addCommuteWidget,
  commuteWidgetSupport,
  type CommuteWidgetSupport,
} from '../commuteWidget';
import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

/** One end of the commute: what it is now, and a stop search to change it. */
function EndField({
  field,
  label,
  editor,
  places,
}: {
  field: CommuteEndKey;
  label: string;
  editor: CommuteEditor;
  places: readonly PlaceRecord[];
}) {
  const open = editor.editing === field;
  const end = editor.config[field];
  if (!open) {
    return (
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <Pressable
          style={styles.endButton}
          disabled={!editor.ready}
          onPress={() => editor.edit(field)}
          testID={`commute-end-${field}`}
        >
          <Text style={styles.endText} numberOfLines={1}>
            {editor.endLabel(field)}
          </Text>
          {end && !editor.isStop(field) ? <Text style={styles.endHint}>coordinate</Text> : null}
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={editor.search.query}
        placeholder="Search for a stop…"
        placeholderTextColor={theme.textMuted}
        autoFocus
        autoCorrect={false}
        onChangeText={editor.search.setQuery}
        testID={`commute-search-${field}`}
      />
      {editor.search.statusText ? (
        <Text style={styles.searchStatus}>{editor.search.statusText}</Text>
      ) : null}
      {editor.search.hits.map((hit) => (
        <Pressable
          key={`${hit.name}-${hit.position.lat}-${hit.position.lng}`}
          style={styles.hit}
          onPress={() => editor.pickHit(field, hit)}
        >
          <Text style={styles.hitName} numberOfLines={1}>
            {hit.name}
          </Text>
          <Text style={styles.hitLabel} numberOfLines={1}>
            {hit.transitStopId ? 'Stop' : hit.label}
          </Text>
        </Pressable>
      ))}
      {/* Favorites stay a shortcut — they are just no longer the only path.
          Offered only before anything is typed: `useStopSearch` matches saved
          places into its own hits, so showing both would list every favorite
          twice. */}
      {editor.search.query.trim().length === 0
        ? places.slice(0, 4).map((place) => (
            <Pressable
              key={place.id}
              style={styles.hit}
              onPress={() => editor.pickPlace(field, place)}
            >
              <Text style={styles.hitName} numberOfLines={1}>
                {place.name}
              </Text>
              <Text style={styles.hitLabel}>Saved place</Text>
            </Pressable>
          ))
        : null}
      <View style={styles.rowGap}>
        <Pressable style={styles.smallButton} onPress={() => editor.edit(null)}>
          <Text style={styles.smallButtonText}>Cancel</Text>
        </Pressable>
        {end ? (
          <Pressable style={styles.smallButton} onPress={() => editor.clear(field)}>
            <Text style={styles.smallButtonText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A ticked line, never a typed code: tap to require it, ✕ to avoid it. "Not the
 * local train that stops everywhere" is a line choice, which is what replaced
 * substring-matching a station name.
 */
function LineChip({ line, editor }: { line: CommuteLineOption; editor: CommuteEditor }) {
  return (
    <View
      style={[
        styles.line,
        line.state === 'select' && styles.lineSelect,
        line.state === 'exclude' && styles.lineExclude,
      ]}
    >
      <Pressable style={styles.lineMain} onPress={() => editor.toggleSelect(line)}>
        <Text
          style={[
            styles.lineText,
            line.state === 'select' && styles.lineTextSelect,
            line.state === 'exclude' && styles.lineTextExclude,
          ]}
        >
          {line.publicCode}
          {line.seen ? ' ✓' : ''}
        </Text>
      </Pressable>
      <Pressable style={styles.lineNot} onPress={() => editor.toggleExclude(line)}>
        <Text style={[styles.lineNotText, line.state === 'exclude' && styles.lineTextExclude]}>
          ✕
        </Text>
      </Pressable>
    </View>
  );
}

/** "Leave at 07:10" / "Arrive by 08:30", nudged in five-minute steps. */
function TimeField({
  direction,
  label,
  editor,
}: {
  direction: TransitCommuteDirection;
  label: string;
  editor: CommuteEditor;
}) {
  const time = direction === 'outbound' ? editor.config.outboundTime : editor.config.inboundTime;
  const nudge = (deltaMinutes: number) => {
    const base = time.minutesOfDay ?? 7 * 60;
    editor.setTime(direction, (((base + deltaMinutes) % 1440) + 1440) % 1440);
  };
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.rowGap}>
        <Pressable
          style={styles.smallButton}
          onPress={() => editor.setArriveBy(direction, !time.arriveBy)}
        >
          <Text style={styles.smallButtonText}>{time.arriveBy ? 'Arrive by' : 'Leave at'}</Text>
        </Pressable>
        <Pressable style={styles.smallButton} onPress={() => nudge(-5)}>
          <Text style={styles.smallButtonText}>−</Text>
        </Pressable>
        <Text style={styles.timeValue}>
          {time.minutesOfDay === null ? 'now' : minutesOfDayLabel(time.minutesOfDay)}
        </Text>
        <Pressable style={styles.smallButton} onPress={() => nudge(5)}>
          <Text style={styles.smallButtonText}>+</Text>
        </Pressable>
        {time.minutesOfDay !== null ? (
          <Pressable style={styles.smallButton} onPress={() => editor.setTime(direction, null)}>
            <Text style={styles.smallButtonText}>Now</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function TripRow({ trip }: { trip: TransitTrip }) {
  const summary = tripSummary(trip);
  return (
    <View style={styles.trip}>
      <View style={styles.tripHead}>
        <Text style={styles.tripTime}>{summary.times}</Text>
        <Text style={styles.tripMeta}>{summary.meta}</Text>
      </View>
      {summary.departure ? (
        <Text
          style={[
            styles.tripConfidence,
            summary.departure.confidence === 'uncertain' && styles.warning,
          ]}
        >
          {summary.departure.delay
            ? `Departs ${summary.departure.expected}, planned ${summary.departure.aimed} · ${summary.departure.confidenceLabel}`
            : `${summary.departure.confidenceLabel} departure`}
        </Text>
      ) : null}
      <View style={styles.lines}>
        {summary.lineCodes.map((line, index) => (
          <View style={styles.tripLine} key={`${line}-${index}`}>
            <Text style={styles.tripLineText}>{line}</Text>
          </View>
        ))}
      </View>
      {summary.severityLabel ? <Text style={styles.warning}>{summary.severityLabel}</Text> : null}
    </View>
  );
}

/**
 * The way onto the home screen, from inside the app.
 *
 * "Add it from your launcher's widget picker" was the whole of this before, which
 * is an instruction to go and do something somewhere else — and on the launchers
 * that bury the picker two long-presses deep, an instruction most people do not
 * follow. Android takes a pin request directly (8.0+), so ask.
 *
 * The offer only appears when the launcher actually accepts one: a button that
 * silently does nothing is worse than a sentence explaining the picker.
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
  // The way out before the outbound time, the way home after it.
  const initialDirection = useMemo(
    () => (commute.query ? defaultCommuteDirection(commute.query, Date.now()) : 'outbound'),
    [commute.query],
  );
  const [pinned, setPinned] = useState<TransitCommuteDirection | null>(null);
  const direction = pinned ?? initialDirection;
  const trips = commute.result?.[direction].trips ?? [];
  const reason = commute.emptyReason(direction);
  const [from, to] =
    direction === 'outbound'
      ? [editor.endLabel('from'), editor.endLabel('to')]
      : [editor.endLabel('to'), editor.endLabel('from')];
  const hasLineRules = editor.config.select.length > 0 || editor.config.exclude.length > 0;

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
          <Text style={styles.title}>Commute</Text>
          <Text style={styles.subtitle}>Your saved journey, both ways</Text>
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
        <EndField field="from" label="From" editor={editor} places={places} />
        <EndField field="via" label="Via" editor={editor} places={places} />
        <EndField field="to" label="To" editor={editor} places={places} />
        <TimeField direction="outbound" label="Outbound" editor={editor} />
        <TimeField direction="inbound" label="Return" editor={editor} />
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Days</Text>
          <View style={styles.chipWrap}>
            {editor.days.map((day) => (
              <Pressable
                key={day.day}
                style={[styles.chip, day.on && styles.chipOn]}
                onPress={() => editor.toggleDay(day.day)}
              >
                <Text style={[styles.chipText, day.on && styles.chipTextOn]}>{day.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        {editor.missing ? <Text style={styles.state}>{editor.missing}</Text> : null}
        {editor.lineGroups.length > 0 ? (
          <View style={styles.field}>
            <View style={styles.servicesHead}>
              <Text style={styles.fieldLabel}>Lines</Text>
              {hasLineRules ? (
                <Pressable style={styles.smallButton} onPress={editor.clearLines}>
                  <Text style={styles.smallButtonText}>Any line</Text>
                </Pressable>
              ) : null}
            </View>
            {editor.lineGroups.map((group) => (
              <View style={styles.lineGroup} key={group.mode}>
                <Text style={styles.lineGroupLabel}>{group.label}</Text>
                <View style={styles.chipWrap}>
                  {group.lines.map((line) => (
                    <LineChip line={line} editor={editor} key={line.id} />
                  ))}
                </View>
              </View>
            ))}
            <Text style={styles.rule}>
              Tick the lines you use, or leave them all untouched for any service. ✓ marks a line
              that runs between your stops; ✕ avoids one.
            </Text>
          </View>
        ) : null}
        {editor.linesLoading ? (
          <Text style={styles.state}>Reading the lines at your stops…</Text>
        ) : null}
        {editor.linesError ? <Text style={styles.state}>{editor.linesError}</Text> : null}
        <View style={styles.chipWrap}>
          {editor.modes.map((mode) => (
            <Pressable
              key={mode.mode}
              style={[styles.chip, mode.on && styles.chipOn]}
              onPress={() => editor.toggleMode(mode.mode)}
            >
              <Text style={[styles.chipText, mode.on && styles.chipTextOn]}>{mode.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.direction}>
          {(['outbound', 'inbound'] as const).map((item) => {
            const selected = item === direction;
            return (
              <Pressable
                key={item}
                style={[styles.directionButton, selected && styles.directionButtonOn]}
                onPress={() => setPinned(item)}
              >
                <Text style={[styles.directionText, selected && styles.directionTextOn]}>
                  {item === 'outbound' ? 'Outbound' : 'Return'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {editor.askable ? (
          <View style={styles.route}>
            <Text style={styles.routeTitle}>
              {from} → {to}
            </Text>
            <Text style={styles.routeVia}>{editor.timeLabel(direction)}</Text>
          </View>
        ) : null}
        {commute.loading ? <Text style={styles.state}>Checking upcoming journeys…</Text> : null}
        {commute.error ? <Text style={[styles.state, styles.error]}>{commute.error}</Text> : null}
        {commute.result && trips.length === 0 ? (
          <View>
            <Text style={styles.state}>
              {emptyDirectionNote(reason === 'filtered' ? 'filtered' : 'upstream')}.
            </Text>
            {reason === 'filtered' ? (
              <Pressable style={styles.escape} onPress={editor.clearLines}>
                <Text style={styles.escapeText}>Allow any line</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {trips.slice(0, 5).map((trip, index) => (
          <TripRow trip={trip} key={`${trip.startMs}-${index}`} />
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
  title: { color: theme.text, fontSize: 18, fontWeight: '800' },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  close: { padding: 8 },
  closeText: { color: theme.textMuted, fontSize: 18 },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 16, paddingBottom: 24 },
  field: { marginBottom: 10 },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: '700', marginBottom: 5 },
  endButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: theme.surfaceMuted,
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  endText: { color: theme.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  endHint: { color: theme.textMuted, fontSize: 10 },
  input: {
    color: theme.text,
    backgroundColor: theme.surfaceMuted,
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontSize: 13,
  },
  hit: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 4,
  },
  hitName: { color: theme.text, fontSize: 13, flexShrink: 1 },
  hitLabel: { color: theme.textMuted, fontSize: 10 },
  searchStatus: { color: theme.textMuted, fontSize: 11, paddingHorizontal: 4, paddingTop: 6 },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  smallButton: {
    backgroundColor: theme.surfaceMuted,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  smallButtonText: { color: theme.text, fontSize: 11, fontWeight: '700' },
  timeValue: { color: theme.text, fontSize: 14, fontWeight: '800', minWidth: 46 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: theme.surfaceMuted,
  },
  chipOn: { backgroundColor: theme.accent },
  chipText: { color: theme.textMuted, fontSize: 11, fontWeight: '600' },
  chipTextOn: { color: theme.onAccent },
  servicesHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lineGroup: { marginBottom: 7 },
  lineGroupLabel: { color: theme.textMuted, fontSize: 11, fontWeight: '600', marginBottom: 4 },
  line: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: theme.surfaceMuted,
  },
  lineSelect: { backgroundColor: theme.accentFaint },
  lineExclude: { backgroundColor: theme.surfaceMuted },
  lineMain: { paddingHorizontal: 9, paddingVertical: 6 },
  lineText: { color: theme.text, fontSize: 11, fontWeight: '700' },
  lineTextSelect: { color: theme.accent },
  lineTextExclude: { color: theme.danger, textDecorationLine: 'line-through' },
  lineNot: {
    paddingHorizontal: 7,
    paddingVertical: 6,
    borderLeftWidth: 1,
    borderLeftColor: theme.border,
  },
  lineNotText: { color: theme.textMuted, fontSize: 10, fontWeight: '700' },
  rule: { color: theme.textMuted, fontSize: 11, lineHeight: 16, marginTop: 8 },
  direction: { flexDirection: 'row', gap: 8, marginTop: 12 },
  directionButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: 9,
    backgroundColor: theme.surfaceMuted,
  },
  directionButtonOn: { backgroundColor: theme.accentFaint },
  directionText: { color: theme.textMuted, fontSize: 13, fontWeight: '700' },
  directionTextOn: { color: theme.accent },
  route: { marginTop: 14, marginBottom: 4 },
  routeTitle: { color: theme.text, fontSize: 15, fontWeight: '800' },
  routeVia: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  state: {
    color: theme.textMuted,
    fontSize: 12,
    lineHeight: 17,
    backgroundColor: theme.surfaceMuted,
    borderRadius: 9,
    padding: 11,
    marginTop: 9,
  },
  escape: {
    alignSelf: 'flex-start',
    marginTop: 7,
    backgroundColor: theme.accentFaint,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  escapeText: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  error: { color: theme.danger },
  trip: { marginTop: 8, padding: 11, borderRadius: 10, backgroundColor: theme.surfaceMuted },
  tripHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  tripTime: { color: theme.text, fontSize: 14, fontWeight: '800' },
  tripMeta: { color: theme.textMuted, fontSize: 11 },
  lines: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 7 },
  tripLine: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: theme.accent,
  },
  tripLineText: { color: theme.onAccent, fontSize: 11, fontWeight: '800' },
  tripConfidence: { color: theme.textMuted, fontSize: 11, fontWeight: '600', marginTop: 3 },
  warning: { color: theme.warning, fontSize: 11, fontWeight: '700', marginTop: 5 },
  live: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 12 },
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
