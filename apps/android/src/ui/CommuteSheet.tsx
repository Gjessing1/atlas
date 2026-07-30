import type { CommuteConfig, CommuteController } from '@atlas/app-hooks';
import { liveTimetableLabel, tripSummary, type TransitTrip } from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

function FavoritePicker({
  label,
  value,
  places,
  allowNone = false,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string | null;
  places: readonly PlaceRecord[];
  allowNone?: boolean;
  disabled?: boolean;
  onChange: (id: string | null) => void;
}) {
  return (
    <View style={styles.picker}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {allowNone ? (
          <Pressable
            style={[styles.chip, value === null && styles.chipOn]}
            disabled={disabled}
            onPress={() => onChange(null)}
          >
            <Text style={[styles.chipText, value === null && styles.chipTextOn]}>None</Text>
          </Pressable>
        ) : null}
        {places.map((place) => {
          const selected = value === place.id;
          return (
            <Pressable
              key={place.id}
              style={[styles.chip, selected && styles.chipOn]}
              disabled={disabled}
              onPress={() => onChange(place.id)}
            >
              <Text style={[styles.chipText, selected && styles.chipTextOn]} numberOfLines={1}>
                {place.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function FilterField({
  label,
  values,
  placeholder,
  disabled = false,
  onCommit,
}: {
  label: string;
  values: string[];
  placeholder: string;
  disabled?: boolean;
  onCommit: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join(', '));
  useEffect(() => setText(values.join(', ')), [values]);
  const commit = () =>
    onCommit(
      text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
  return (
    <View style={styles.filter}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={text}
        placeholder={placeholder}
        editable={!disabled}
        placeholderTextColor={theme.textMuted}
        onChangeText={setText}
        onBlur={commit}
        onSubmitEditing={commit}
        returnKeyType="done"
      />
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
      <View style={styles.lines}>
        {summary.lineCodes.map((line, index) => (
          <View style={styles.line} key={`${line}-${index}`}>
            <Text style={styles.lineText}>{line}</Text>
          </View>
        ))}
      </View>
      {summary.delay ? <Text style={styles.warning}>{summary.delay}</Text> : null}
      {summary.severityLabel ? <Text style={styles.warning}>{summary.severityLabel}</Text> : null}
    </View>
  );
}

export function CommuteSheet({
  visible,
  commute,
  places,
  onClose,
  bottomInset,
}: {
  visible: boolean;
  commute: CommuteController;
  places: readonly PlaceRecord[];
  onClose: () => void;
  bottomInset: number;
}) {
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const patch = (next: Partial<CommuteConfig>) => commute.setConfig({ ...commute.config, ...next });
  const trips = commute.result?.[direction].trips ?? [];
  const fromName = direction === 'outbound' ? commute.query?.from.name : commute.query?.to.name;
  const toName = direction === 'outbound' ? commute.query?.to.name : commute.query?.from.name;

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
          <Text style={styles.subtitle}>Favorite-to-favorite live journeys</Text>
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
        {places.length < 2 ? (
          <Text style={styles.state}>
            Save at least two favorite destinations in Collections to build this board.
          </Text>
        ) : null}
        {!commute.ready ? <Text style={styles.state}>Loading saved commute…</Text> : null}
        <FavoritePicker
          label="From"
          value={commute.config.fromId}
          places={places}
          disabled={!commute.ready}
          onChange={(fromId) => patch({ fromId })}
        />
        <FavoritePicker
          label="Via"
          value={commute.config.viaId}
          places={places}
          allowNone
          disabled={!commute.ready}
          onChange={(viaId) => patch({ viaId })}
        />
        <FavoritePicker
          label="To"
          value={commute.config.toId}
          places={places}
          disabled={!commute.ready}
          onChange={(toId) => patch({ toId })}
        />
        <FilterField
          label="Only bus lines"
          values={commute.config.allowedBusLines}
          placeholder="280, 71"
          disabled={!commute.ready}
          onCommit={(allowedBusLines) => patch({ allowedBusLines })}
        />
        <FilterField
          label="Train must skip"
          values={commute.config.excludedRailStops}
          placeholder="Hvalstad"
          disabled={!commute.ready}
          onCommit={(excludedRailStops) => patch({ excludedRailStops })}
        />
        <Text style={styles.rule}>
          Walking transfers are allowed. Other bus lines and trains calling at an excluded stop are
          hidden.
        </Text>
        <View style={styles.direction}>
          {(['outbound', 'inbound'] as const).map((item) => {
            const selected = item === direction;
            return (
              <Pressable
                key={item}
                style={[styles.directionButton, selected && styles.directionButtonOn]}
                onPress={() => setDirection(item)}
              >
                <Text style={[styles.directionText, selected && styles.directionTextOn]}>
                  {item === 'outbound' ? 'Outbound' : 'Return'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {commute.query ? (
          <View style={styles.route}>
            <Text style={styles.routeTitle}>
              {fromName} → {toName}
            </Text>
            {commute.query.via[0] ? (
              <Text style={styles.routeVia}>via {commute.query.via[0].name}</Text>
            ) : null}
          </View>
        ) : null}
        {commute.loading ? <Text style={styles.state}>Checking upcoming journeys…</Text> : null}
        {commute.error ? <Text style={[styles.state, styles.error]}>{commute.error}</Text> : null}
        {!commute.query && places.length >= 2 ? (
          <Text style={styles.state}>Choose both ends and at least one allowed bus line.</Text>
        ) : null}
        {commute.result && trips.length === 0 ? (
          <Text style={styles.state}>
            No upcoming journey matches these exact line and stop rules.
          </Text>
        ) : null}
        {trips.slice(0, 5).map((trip, index) => (
          <TripRow trip={trip} key={`${trip.startMs}-${index}`} />
        ))}
        <View style={styles.live}>
          <Text style={styles.liveText}>Entur · {liveTimetableLabel(commute.updatedMs)}</Text>
          <Pressable
            style={styles.refresh}
            onPress={commute.refresh}
            disabled={commute.loading || !commute.query}
          >
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </View>
        <Text style={styles.widgetNote}>
          This saved board also powers the “Atlas commute” Android home-screen widget. Add it from
          your launcher’s widget picker.
        </Text>
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
  picker: { marginBottom: 10 },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: '700', marginBottom: 5 },
  chip: {
    maxWidth: 180,
    marginRight: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: theme.surfaceMuted,
  },
  chipOn: { backgroundColor: theme.accent },
  chipText: { color: theme.text, fontSize: 12, fontWeight: '600' },
  chipTextOn: { color: theme.onAccent },
  filter: { marginBottom: 10 },
  input: {
    color: theme.text,
    backgroundColor: theme.surfaceMuted,
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontSize: 13,
  },
  rule: { color: theme.textMuted, fontSize: 11, lineHeight: 16, marginBottom: 12 },
  direction: { flexDirection: 'row', gap: 8 },
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
  error: { color: theme.danger },
  trip: {
    marginTop: 8,
    padding: 11,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  tripHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  tripTime: { color: theme.text, fontSize: 14, fontWeight: '800' },
  tripMeta: { color: theme.textMuted, fontSize: 11 },
  lines: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 7 },
  line: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: theme.accent,
  },
  lineText: { color: theme.onAccent, fontSize: 11, fontWeight: '800' },
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
  widgetNote: { color: theme.textMuted, fontSize: 11, lineHeight: 16, marginTop: 14 },
});
