import { useTransitDepartures, type TransitDeparturesFn } from '@atlas/app-hooks';
import { fmtDistanceM } from '@atlas/core';
import {
  departureBoardLiveLabel,
  fetchTransitDepartures,
  legTimeParts,
  TRANSIT_MODE_LABEL,
  type TransitLocation,
} from '@atlas/transit';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useServerOrigin } from '../serverOrigin';
import { theme } from './theme';

/** Destination-free next-hour board for the nearest (or exactly selected) stop. */
export function StopDepartures({
  location,
  onClose,
}: {
  location: TransitLocation;
  onClose: () => void;
}) {
  const baseUrl = useServerOrigin();
  const fetcher = useMemo<TransitDeparturesFn>(
    () => (query, signal) => fetchTransitDepartures(query, { baseUrl, signal }),
    [baseUrl],
  );
  const state = useTransitDepartures(fetcher, location, true);
  const result = state.result;
  const stop = result?.stop;

  return (
    <View style={styles.board} testID="stop-departures">
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{stop?.name ?? 'Departures nearby'}</Text>
          <Text style={styles.subtitle}>
            {stop?.distanceM !== undefined
              ? `${fmtDistanceM(stop.distanceM)} from this point · next hour`
              : 'Next hour'}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
          onPress={state.refresh}
          disabled={state.loading}
          testID="stop-departures-refresh"
        >
          <Text style={styles.smallButtonText}>Refresh</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
          onPress={onClose}
          testID="stop-departures-close"
        >
          <Text style={styles.smallButtonText}>Close</Text>
        </Pressable>
      </View>

      {state.loading ? <Text style={styles.state}>Looking up departures…</Text> : null}
      {state.error ? <Text style={[styles.state, styles.error]}>{state.error}</Text> : null}
      {result && !stop ? (
        <Text style={styles.state}>No public transport stop within 1.5 km.</Text>
      ) : null}
      {stop && result.departures.length === 0 ? (
        <Text style={styles.state}>Nothing leaves this stop in the next hour.</Text>
      ) : null}
      {stop && result.departures.length > 0 ? (
        <ScrollView style={styles.list} nestedScrollEnabled>
          {result.departures.map((departure) => {
            const time = legTimeParts({
              aimedMs: departure.aimedDepartureMs,
              expectedMs: departure.expectedDepartureMs,
              realtime: departure.realtime,
              predictionInaccurate: departure.predictionInaccurate,
            });
            return (
              <View
                key={departure.id}
                style={[styles.row, departure.cancelled && styles.cancelled]}
              >
                <View style={styles.time}>
                  {time.delay ? <Text style={styles.aimed}>{time.aimed}</Text> : null}
                  <Text
                    style={[
                      styles.expected,
                      time.tone === 'late' && styles.late,
                      time.tone === 'early' && styles.early,
                    ]}
                  >
                    {time.expected}
                  </Text>
                  {time.delay ? (
                    <Text style={time.tone === 'late' ? styles.late : styles.early}>
                      {time.delay}
                    </Text>
                  ) : null}
                </View>
                <View
                  style={[
                    styles.line,
                    departure.line.colour ? { backgroundColor: departure.line.colour } : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.lineText,
                      departure.line.textColour ? { color: departure.line.textColour } : null,
                    ]}
                    numberOfLines={1}
                  >
                    {departure.line.publicCode}
                  </Text>
                </View>
                <View style={styles.service}>
                  <Text
                    style={[styles.destination, departure.cancelled && styles.cancelledText]}
                    numberOfLines={1}
                  >
                    {departure.cancelled ? 'Cancelled' : departure.destination}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {TRANSIT_MODE_LABEL[departure.mode]}
                    {departure.quay.publicCode ? ` · plat. ${departure.quay.publicCode}` : ''}
                    {departure.line.operator ? ` · ${departure.line.operator}` : ''}
                    {` · ${time.confidenceLabel}`}
                  </Text>
                  {departure.situations[0] ? (
                    <Text style={styles.notice} numberOfLines={2}>
                      {departure.situations[0].summary}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
      <Text style={styles.live}>
        Entur · {departureBoardLiveLabel(state.updatedMs, state.loading, state.error !== null)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  board: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: theme.text, fontSize: 14, fontWeight: '800' },
  subtitle: { color: theme.textMuted, fontSize: 11, marginTop: 1 },
  smallButton: {
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: theme.surfaceMuted,
  },
  smallButtonText: { color: theme.text, fontSize: 11, fontWeight: '700' },
  list: {
    maxHeight: 300,
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    gap: 7,
    alignItems: 'flex-start',
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  cancelled: { backgroundColor: 'rgba(216,79,85,0.12)' },
  time: { width: 50 },
  aimed: { color: theme.textMuted, fontSize: 10, textDecorationLine: 'line-through' },
  expected: { color: theme.text, fontSize: 16, fontWeight: '800' },
  late: { color: theme.warning, fontSize: 10 },
  early: { color: theme.accent, fontSize: 10 },
  line: {
    minWidth: 34,
    maxWidth: 42,
    borderRadius: 5,
    paddingHorizontal: 4,
    paddingVertical: 3,
    backgroundColor: theme.surfaceMuted,
    alignItems: 'center',
  },
  lineText: { color: theme.text, fontSize: 11, fontWeight: '900' },
  service: { flex: 1, minWidth: 0 },
  destination: { color: theme.text, fontSize: 13, fontWeight: '800' },
  cancelledText: { color: theme.danger },
  meta: { color: theme.textMuted, fontSize: 10, marginTop: 1 },
  notice: { color: theme.warning, fontSize: 10, marginTop: 2 },
  state: { color: theme.textMuted, fontSize: 12, marginVertical: 12 },
  error: { color: theme.danger },
  live: { color: theme.textMuted, fontSize: 10, marginTop: 6 },
  pressed: { opacity: 0.65 },
});
