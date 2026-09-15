import type { CommuteEditor, CommuteEndKey, CommuteLineOption } from '@atlas/app-hooks';
import { minutesOfDayLabel, type TransitCommuteDirection } from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { theme } from './theme';

/**
 * The commute's configuration on Android — the same form as before, moved out
 * of the sheet when the board was put in front of it.
 *
 * Every decision it makes comes from `useCommuteEditor`, shared with the web
 * panel; only the inputs differ. What changed here is where it sits: behind
 * "Edit commute", opened by itself only when there is not yet enough saved for
 * the board to ask a question.
 */

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
      {editor.search.hits.map((hit, index) => (
        <Pressable
          key={`${hit.name}-${hit.position.lat}-${hit.position.lng}`}
          style={styles.hit}
          onPress={() => editor.pickHit(field, hit)}
          // Named per field, because all three ends can be searched in one
          // session and the regression has to say *which* end it is picking.
          testID={`commute-hit-${field}-${index}`}
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
              testID={`commute-place-${field}-${place.id}`}
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

/** "Leave at 07:10" / "Arrive by 08:30", picked with Android's own clock. */
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
  const pickTime = () => {
    const value = new Date();
    if (time.minutesOfDay !== null) {
      value.setHours(Math.floor(time.minutesOfDay / 60), time.minutesOfDay % 60, 0, 0);
    }
    DateTimePickerAndroid.open({
      value,
      mode: 'time',
      is24Hour: true,
      onChange: (event, picked) => {
        if (event.type !== 'set' || !picked) return;
        editor.setTime(direction, picked.getHours() * 60 + picked.getMinutes());
      },
    });
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
        <Pressable
          style={[styles.smallButton, styles.timeButton]}
          onPress={pickTime}
          accessibilityRole="button"
          accessibilityLabel={`${label} time`}
          testID={`commute-time-${direction}`}
        >
          <Text style={styles.timeValue}>
            {time.minutesOfDay === null ? 'Choose time' : minutesOfDayLabel(time.minutesOfDay)}
          </Text>
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

export function CommuteEditorForm({
  editor,
  places,
}: {
  editor: CommuteEditor;
  places: readonly PlaceRecord[];
}) {
  const hasLineRules = editor.config.select.length > 0 || editor.config.exclude.length > 0;
  return (
    <View style={styles.editor}>
      <EndField field="from" label="From" editor={editor} places={places} />
      <EndField field="via" label="Via" editor={editor} places={places} />
      <EndField field="to" label="To" editor={editor} places={places} />
      <TimeField direction="outbound" label="Outbound" editor={editor} />
      <TimeField direction="inbound" label="Return" editor={editor} />
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Days</Text>
        <View style={[styles.chipWrap, styles.presetRow]}>
          {editor.dayPresets.map((preset) => (
            <Pressable
              key={preset.id}
              style={[styles.preset, preset.on && styles.presetOn]}
              onPress={() => editor.applyDayPreset(preset.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: preset.on }}
              testID={`commute-days-${preset.id}`}
            >
              <Text style={[styles.presetText, preset.on && styles.presetTextOn]}>
                {preset.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.chipWrap}>
          {editor.days.map((day) => (
            <Pressable
              key={day.day}
              style={[styles.chip, day.on && styles.chipOn]}
              onPress={() => editor.toggleDay(day.day)}
              accessibilityRole="button"
              accessibilityState={{ selected: day.on }}
              testID={`commute-day-${day.day}`}
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
            Tick the lines you use, or leave them all untouched for any service. ✓ marks a line that
            runs between your stops; ✕ avoids one.
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
    </View>
  );
}

const styles = StyleSheet.create({
  editor: {
    padding: 10,
    marginBottom: 12,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  field: { marginBottom: 10 },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: '700', marginBottom: 5 },
  endButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: theme.surface,
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  endText: { color: theme.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  endHint: { color: theme.textMuted, fontSize: 10 },
  input: {
    color: theme.text,
    backgroundColor: theme.surface,
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
    backgroundColor: theme.surface,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  smallButtonText: { color: theme.text, fontSize: 11, fontWeight: '700' },
  timeButton: { minWidth: 96, alignItems: 'center' },
  timeValue: { color: theme.text, fontSize: 13, fontWeight: '800' },
  presetRow: { marginBottom: 6 },
  preset: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: theme.surface,
  },
  presetOn: { backgroundColor: theme.accentFaint },
  presetText: { color: theme.textMuted, fontSize: 11, fontWeight: '700' },
  presetTextOn: { color: theme.accent },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: theme.surface,
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
    backgroundColor: theme.surface,
  },
  lineSelect: { backgroundColor: theme.accentFaint },
  lineExclude: { backgroundColor: theme.surface },
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
  state: {
    color: theme.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 9,
  },
});
