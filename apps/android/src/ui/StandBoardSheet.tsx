import type { StandBoardRow, StandBoardState } from '@atlas/app-hooks';
import { standCellSummary, type StandDayCell, type StandSit } from '@atlas/conditions';
import { fmtDayLabel } from '@atlas/core';
import { Pressable, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';

import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

/**
 * "My stands" on Android — the twin of the web's StandBoardPanel, under the same
 * rules.
 *
 * The shortlist beside it answers *where should I sit?*, asked once per area.
 * This answers the one a season repeats every afternoon: **which of the stands I
 * already have is on tonight?** It needs no derive, no router and no new
 * upstream — the rose each stand was saved with, the sun, and a forecast per
 * stand.
 *
 * Scent leads the row because it decides the sit outright; morning and evening
 * are separate tabs because they are separate questions; and days 4–10 are drawn
 * differently because past ~3 days met.no turns 6-hourly and a six-hour average
 * cannot resolve a dawn sit. The *timing* stays exact all ten days — it comes
 * from the sun, which needs no forecast.
 */
export function StandBoardButton({
  top,
  left,
  onPress,
}: {
  top: number;
  left: number;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.button, { top, left }]} onPress={onPress} testID="stand-board-button">
      <Text style={styles.buttonText}>My stands</Text>
    </Pressable>
  );
}

const VERDICT_COLOR: Record<string, ColorValue> = {
  good: '#2f8f4e',
  crosswind: theme.warning,
  blown: theme.danger,
};

function verdictColor(cell: StandDayCell | null): ColorValue {
  return cell?.scent ? (VERDICT_COLOR[cell.scent.verdict] ?? theme.textMuted) : theme.textMuted;
}

/** The ten-day strip for one stand: the week at a glance, and the day picker. */
function StandDays({
  row,
  dayOffset,
  onPickDay,
}: {
  row: StandBoardRow;
  dayOffset: number;
  onPickDay: (offset: number) => void;
}) {
  return (
    <View style={styles.days}>
      {row.days.map((day, index) => {
        const summary = standCellSummary(day);
        return (
          <Pressable
            key={day.dayMs}
            style={[
              styles.day,
              index === dayOffset && styles.daySelected,
              // A coarse cell is visibly not one of the hourly ones: without
              // this the last seven days claim a precision they do not have.
              day.coarse && styles.dayCoarse,
            ]}
            onPress={() => onPickDay(index)}
            testID={`stand-day-${row.placeId}-${index}`}
          >
            <Text style={styles.dayName} numberOfLines={1}>
              {fmtDayLabel(day.dayMs).slice(0, 3)}
            </Text>
            <Text style={[styles.dayWind, { color: verdictColor(day) }]}>
              {summary.windLabel?.split(' ')[0] ?? '·'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const SITS: { key: StandSit; label: string }[] = [
  { key: 'morning', label: 'Morning' },
  { key: 'evening', label: 'Evening' },
];

export function StandBoardSheet({
  visible,
  state,
  onPick,
  onClose,
  bottomInset,
}: {
  visible: boolean;
  state: StandBoardState;
  onPick: (row: StandBoardRow) => void;
  onClose: () => void;
  bottomInset: number;
}) {
  const selectedDay = state.dayStamps[state.dayOffset];
  return (
    <BottomSheet
      visible={visible}
      mode="map"
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="stand-board-sheet"
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.heading}>My stands</Text>
          <Text style={styles.muted}>
            {selectedDay === undefined ? 'saved plans' : fmtDayLabel(selectedDay)}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} testID="stand-board-close">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.sits}>
        {SITS.map((sit) => (
          <Pressable
            key={sit.key}
            style={[styles.sit, state.sit === sit.key && styles.sitOn]}
            onPress={() => state.setSit(sit.key)}
            testID={`stand-sit-${sit.key}`}
          >
            <Text style={[styles.sitText, state.sit === sit.key && styles.sitTextOn]}>
              {sit.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {state.status === 'loading' ? <Text style={styles.note}>Reading the wind…</Text> : null}
      {state.note ? <Text style={styles.note}>{state.note}</Text> : null}

      <ScrollView style={styles.list}>
        {state.rows.map((row) => {
          const cell = row.cell;
          const summary = cell ? standCellSummary(cell) : null;
          return (
            <View
              key={row.placeId}
              style={[styles.row, cell?.scent?.verdict === 'blown' && styles.rowBlown]}
            >
              <Pressable
                onPress={() => onPick(row)}
                style={styles.rowMain}
                testID={`stand-row-${row.placeId}`}
              >
                <Text style={styles.rowHead} numberOfLines={1}>
                  {row.name}
                  {summary ? <Text style={styles.muted}> · {summary.windowLabel}</Text> : null}
                </Text>
                {summary ? (
                  <Text style={[styles.verdict, { color: verdictColor(cell) }]} numberOfLines={1}>
                    {summary.scentLabel}
                    {summary.windLabel ? (
                      <Text style={styles.verdictWind}> {summary.windLabel}</Text>
                    ) : null}
                    {summary.ratingLabel ? (
                      <Text style={styles.muted}> · {summary.ratingLabel}</Text>
                    ) : null}
                  </Text>
                ) : null}
                <Text style={styles.reason} numberOfLines={2}>
                  {summary?.detail}
                </Text>
                {summary?.coarseNote ? (
                  <Text style={[styles.reason, styles.coarseNote]}>{summary.coarseNote}</Text>
                ) : null}
                {summary?.polarNote ? (
                  <Text style={[styles.reason, styles.coarseNote]}>{summary.polarNote}</Text>
                ) : null}
                {row.slopeDeg !== null && row.slopeDeg >= 3 ? (
                  <Text style={styles.reason} numberOfLines={2}>
                    {Math.round(row.slopeDeg)}° slope
                    {row.aspectDeg === null ? '' : ` falling ${row.aspectDeg}°`} — thermals count in
                    a light wind.
                  </Text>
                ) : null}
              </Pressable>
              <StandDays row={row} dayOffset={state.dayOffset} onPickDay={state.setDayOffset} />
            </View>
          );
        })}
      </ScrollView>

      {state.rows.length > 0 ? (
        <Text style={styles.note}>
          Wind and light only — a stand is still yours to check for a safe backstop and the legal
          season.
        </Text>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme.surfaceOverlay,
    elevation: 3,
  },
  buttonText: { color: theme.text, fontSize: 12, fontWeight: '700' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerText: { flex: 1 },
  heading: { color: theme.text, fontSize: 17, fontWeight: '700' },
  muted: { color: theme.textMuted, fontSize: 12 },
  close: { color: theme.textMuted, fontSize: 18, paddingHorizontal: 4 },
  sits: { flexDirection: 'row', gap: 6, marginTop: 10 },
  sit: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
  },
  sitOn: { backgroundColor: theme.accent, borderColor: 'transparent' },
  sitText: { color: theme.textMuted, fontSize: 13 },
  sitTextOn: { color: '#ffffff', fontWeight: '700' },
  note: { color: theme.textMuted, fontSize: 12, marginTop: 10 },
  list: { marginTop: 8 },
  row: { paddingVertical: 8 },
  rowBlown: { opacity: 0.55 },
  rowMain: { gap: 2 },
  rowHead: { color: theme.text, fontSize: 14, fontWeight: '700' },
  verdict: { fontSize: 13, fontWeight: '700' },
  verdictWind: { fontWeight: '400' },
  reason: { color: theme.textMuted, fontSize: 12 },
  coarseNote: { fontStyle: 'italic' },
  days: { flexDirection: 'row', gap: 2, marginTop: 6 },
  day: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: theme.surfaceMuted,
  },
  daySelected: { borderColor: theme.accent },
  // React Native has no repeating gradient, so the six-hourly tail is marked by
  // sinking the cell instead — the point is only that it must not read as one
  // of the hourly ones.
  dayCoarse: { backgroundColor: 'transparent', borderStyle: 'dashed', borderColor: theme.border },
  dayName: { color: theme.textMuted, fontSize: 9 },
  dayWind: { fontSize: 12, lineHeight: 14 },
});
